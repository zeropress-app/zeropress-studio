import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedMediaUploadRequestSchema } from '../../../contracts/media-upload';
import {
  cancelManagedMediaUploadIntent,
  createManagedMediaUploadIntent,
  garbageCollectExpiredMediaUploadIntents,
} from './media-upload-repository';
import { storeManagedMediaUpload } from './media-upload-service';
import { deleteMedia } from './media-repository';
import { deleteQueuedMediaObject } from './media-object-cleanup';

type SqliteRunResult = { changes: number | bigint };

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, params);
  }
  async run(): Promise<D1Result<unknown>> {
    const result = (
      this.database.prepare(this.sql).run as (...params: unknown[]) => SqliteRunResult
    )(...this.params);
    return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result<unknown>;
  }
  async all<T>(): Promise<D1Result<T>> {
    const results = (
      this.database.prepare(this.sql).all as (...params: unknown[]) => T[]
    )(...this.params);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }
  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get as (...params: unknown[]) => T | undefined)(...this.params) ?? null;
  }
  async execute(): Promise<D1Result<unknown>> {
    return /^\s*(?:WITH\b[\s\S]+?\bSELECT\b|SELECT\b)/iu.test(this.sql)
      ? this.all()
      : this.run();
  }
}

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(
    new URL('../../../database/install/001_baseline.sql', import.meta.url),
    'utf8',
  ));
  const d1 = {
    prepare(sql: string) {
      return new SqliteD1Statement(sqlite, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  const now = '2026-08-03T01:00:00.000Z';
  sqlite.prepare(`
    INSERT INTO users (
      id, email, password_hash, name, status, email_verified,
      created_at_iso, updated_at_iso
    ) VALUES (?, 'editor@example.com', 'hash', 'Editor', 'active', 1, ?, ?)
  `).run('1'.repeat(32), now, now);
  return { sqlite, d1 };
}

const NOW = new Date('2026-08-03T01:00:00.000Z');
const USER_ID = '1'.repeat(32);
const UPLOAD_ID = '2'.repeat(32);
const MEDIA_ID = '3'.repeat(32);
const REVISION = '4'.repeat(32);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MALICIOUS_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" onload="alert(1)"><script>alert(1)</script><rect width="640" height="480" fill="red"/></svg>',
);
let fixedLengthBodies = new WeakSet<ReadableStream<Uint8Array>>();
let fixedLengthExpectations: number[] = [];

class TestFixedLengthStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(expectedLength: number | bigint) {
    const expected = Number(expectedLength);
    let observed = 0;
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observed += chunk.byteLength;
        if (observed > expected) throw new TypeError('Fixed length exceeded.');
        controller.enqueue(chunk);
      },
      flush() {
        if (observed !== expected) throw new TypeError('Fixed length not met.');
      },
    });
    this.readable = stream.readable;
    this.writable = stream.writable;
    fixedLengthBodies.add(this.readable);
    fixedLengthExpectations.push(expected);
  }
}

beforeEach(() => {
  fixedLengthBodies = new WeakSet();
  fixedLengthExpectations = [];
  vi.stubGlobal('FixedLengthStream', TestFixedLengthStream);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function authored() {
  return createManagedMediaUploadRequestSchema.parse({
    filename: 'hero.png',
    size_bytes: PNG.byteLength,
    width: 1600,
    height: 900,
    duration_ms: null,
    alt: 'Hero',
  });
}

function idSequence() {
  const values = [UPLOAD_ID, MEDIA_ID];
  return () => values.shift()!;
}

describe('managed Media upload lifecycle', () => {
  it('creates a 15-minute intent and atomically materializes streamed R2 Media', async () => {
    const { sqlite, d1 } = database();
    const prepared = await createManagedMediaUploadIntent({
      db: d1,
      userId: USER_ID,
      authored: authored(),
      now: NOW,
      createId: idSequence(),
    });
    expect(prepared).toMatchObject({
      kind: 'completed',
      intent: {
        id: UPLOAD_ID,
        mediaId: MEDIA_ID,
        storageKey: `uploads/2026/08/${MEDIA_ID}.png`,
        expiresAtIso: '2026-08-03T01:15:00.000Z',
      },
    });
    if (prepared.kind !== 'completed') throw new Error('Expected intent.');

    const put = vi.fn(async (
      _key: string,
      value: ReadableStream<Uint8Array>,
      _options: unknown,
    ) => {
      expect(fixedLengthBodies.has(value)).toBe(true);
      const uploaded = await new Response(value).bytes();
      return { size: uploaded.byteLength } as R2Object;
    });
    const bucket = { put, delete: vi.fn() } as unknown as R2Bucket;
    const result = await storeManagedMediaUpload({
      db: d1,
      bucket,
      uploadId: UPLOAD_ID,
      userId: USER_ID,
      body: new Blob([PNG]).stream(),
      contentLength: PNG.byteLength,
      now: new Date('2026-08-03T01:01:00.000Z'),
      createRevision: () => REVISION,
    });
    expect(result).toMatchObject({
      kind: 'completed',
      media: {
        id: MEDIA_ID,
        location: { type: 'r2', key: `uploads/2026/08/${MEDIA_ID}.png` },
        size_bytes: PNG.byteLength,
        width: 1600,
        height: 900,
      },
    });
    expect(put).toHaveBeenCalledWith(
      `uploads/2026/08/${MEDIA_ID}.png`,
      expect.any(ReadableStream),
      expect.objectContaining({
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: expect.objectContaining({
          contentType: 'image/png',
          cacheControl: 'public, max-age=31536000, immutable',
          contentDisposition: 'inline',
        }),
        customMetadata: { zeropress_media_id: MEDIA_ID },
      }),
    );
    expect(fixedLengthExpectations).toEqual([PNG.byteLength]);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM media_upload_intents').get())
      .toEqual({ n: 0 });

    await expect(deleteMedia({
      db: d1,
      id: MEDIA_ID,
      expectedRevision: REVISION,
    })).resolves.toEqual({
      kind: 'completed',
      cleanupKey: `uploads/2026/08/${MEDIA_ID}.png`,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM media_object_deletions').get())
      .toEqual({ n: 1 });
    await expect(deleteQueuedMediaObject({
      db: d1,
      bucket,
      storageKey: `uploads/2026/08/${MEDIA_ID}.png`,
      now: NOW,
    })).resolves.toBe('completed');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM media_object_deletions').get())
      .toEqual({ n: 0 });
  });

  it('stores only sanitized SVG bytes and records their materialized size', async () => {
    const { sqlite, d1 } = database();
    const prepared = await createManagedMediaUploadIntent({
      db: d1,
      userId: USER_ID,
      authored: createManagedMediaUploadRequestSchema.parse({
        filename: 'illustration.svg',
        size_bytes: MALICIOUS_SVG.byteLength,
        width: 640,
        height: 480,
        duration_ms: null,
        alt: 'Illustration',
      }),
      now: NOW,
      createId: idSequence(),
    });
    if (prepared.kind !== 'completed') throw new Error('Expected SVG intent.');

    let stored: Uint8Array<ArrayBufferLike> = new Uint8Array();
    const put = vi.fn(async (
      _key: string,
      value: Uint8Array,
    ) => {
      expect(value).toBeInstanceOf(Uint8Array);
      stored = value;
      return { size: value.byteLength } as R2Object;
    });
    const result = await storeManagedMediaUpload({
      db: d1,
      bucket: { put, delete: vi.fn() } as unknown as R2Bucket,
      uploadId: UPLOAD_ID,
      userId: USER_ID,
      body: new Blob([MALICIOUS_SVG]).stream(),
      contentLength: MALICIOUS_SVG.byteLength,
      now: new Date('2026-08-03T01:01:00.000Z'),
      createRevision: () => REVISION,
    });

    const sanitized = new TextDecoder().decode(stored);
    expect(sanitized).toContain('<svg');
    expect(sanitized).toContain('<rect');
    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('onload');
    expect(result).toMatchObject({
      kind: 'completed',
      media: {
        mime_type: 'image/svg+xml',
        location: { type: 'r2', key: `uploads/2026/08/${MEDIA_ID}.svg` },
        size_bytes: stored.byteLength,
        width: 640,
        height: 480,
      },
    });
    expect(put).toHaveBeenCalledWith(
      `uploads/2026/08/${MEDIA_ID}.svg`,
      expect.any(Uint8Array),
      expect.objectContaining({
        customMetadata: {
          zeropress_media_id: MEDIA_ID,
          zeropress_svg_policy: 'zeropress-svg-v1',
        },
      }),
    );
    expect(sqlite.prepare('SELECT size_bytes FROM media WHERE id = ?')
      .get(MEDIA_ID)).toEqual({ size_bytes: stored.byteLength });
  });

  it('stores bounded AI provenance in D1 without copying the prompt to R2', async () => {
    const { sqlite, d1 } = database();
    const prepared = await createManagedMediaUploadIntent({
      db: d1,
      userId: USER_ID,
      authored: authored(),
      enforceQueueLimit: false,
      now: NOW,
      createId: idSequence(),
    });
    if (prepared.kind !== 'completed') throw new Error('Expected intent.');
    const put = vi.fn(async (
      _key: string,
      value: ReadableStream<Uint8Array>,
      _options: unknown,
    ) => {
      await new Response(value).arrayBuffer();
      return { size: PNG.byteLength } as R2Object;
    });
    await expect(storeManagedMediaUpload({
      db: d1,
      bucket: { put, delete: vi.fn() } as unknown as R2Bucket,
      uploadId: UPLOAD_ID,
      userId: USER_ID,
      body: new Blob([PNG]).stream(),
      contentLength: PNG.byteLength,
      now: new Date('2026-08-03T01:01:00.000Z'),
      createRevision: () => REVISION,
      generatedBy: {
        version: 1,
        model: '@cf/black-forest-labs/flux-2-klein-4b',
        prompt_version: 'image-v1',
        prompt: 'A quiet library at sunrise',
        aspect_ratio: 'landscape',
        seed: 42,
      },
    })).resolves.toMatchObject({ kind: 'completed' });
    const options = put.mock.calls[0]![2];
    expect(options).toMatchObject({
      customMetadata: {
        zeropress_media_id: MEDIA_ID,
        zeropress_origin: 'ai-generated',
        zeropress_ai_model: '@cf/black-forest-labs/flux-2-klein-4b',
        zeropress_ai_prompt_version: 'image-v1',
        zeropress_ai_aspect_ratio: 'landscape',
        zeropress_ai_seed: '42',
      },
    });
    expect(JSON.stringify(options)).not.toContain('quiet library');
    const stored = sqlite.prepare(`
      SELECT ai_generation_json FROM media WHERE id = ?
    `).get(MEDIA_ID) as { ai_generation_json: string };
    expect(JSON.parse(stored.ai_generation_json)).toEqual({
      version: 1,
      model: '@cf/black-forest-labs/flux-2-klein-4b',
      prompt_version: 'image-v1',
      prompt: 'A quiet library at sunrise',
      aspect_ratio: 'landscape',
      seed: 42,
    });
  });

  it('rejects malformed SVG without writing raw bytes to R2', async () => {
    const { d1 } = database();
    const malformed = new TextEncoder().encode('<svg><g>');
    await createManagedMediaUploadIntent({
      db: d1,
      userId: USER_ID,
      authored: createManagedMediaUploadRequestSchema.parse({
        filename: 'broken.svg',
        size_bytes: malformed.byteLength,
        width: 640,
        height: 480,
        duration_ms: null,
        alt: '',
      }),
      now: NOW,
      createId: idSequence(),
    });
    const put = vi.fn();
    await expect(storeManagedMediaUpload({
      db: d1,
      bucket: { put } as unknown as R2Bucket,
      uploadId: UPLOAD_ID,
      userId: USER_ID,
      body: new Blob([malformed]).stream(),
      contentLength: malformed.byteLength,
      now: new Date('2026-08-03T01:01:00.000Z'),
    })).resolves.toEqual({ kind: 'svg_sanitization_failed' });
    expect(put).not.toHaveBeenCalled();
  });

  it('classifies an R2 unknown-length rejection as a Studio/runtime defect', async () => {
    const { d1 } = database();
    await createManagedMediaUploadIntent({
      db: d1,
      userId: USER_ID,
      authored: authored(),
      now: NOW,
      createId: idSequence(),
    });
    const bucket = {
      put: vi.fn().mockRejectedValue(new TypeError(
        'Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)',
      )),
    } as unknown as R2Bucket;

    await expect(storeManagedMediaUpload({
      db: d1,
      bucket,
      uploadId: UPLOAD_ID,
      userId: USER_ID,
      body: new Blob([PNG]).stream(),
      contentLength: PNG.byteLength,
      now: new Date('2026-08-03T01:01:00.000Z'),
    })).rejects.toMatchObject({
      name: 'StudioOperationalError',
      code: 'MEDIA_UPLOAD_STREAM_LENGTH_METADATA_LOST',
      operationalMetadata: {
        resource: 'MEDIA_BUCKET',
        action: 'put_media_object',
        reason: 'final_stream_length_unknown',
      },
    });
  });

  it('rejects mismatched bytes without writing R2 and expires stale intents', async () => {
    const { sqlite, d1 } = database();
    await createManagedMediaUploadIntent({
      db: d1,
      userId: USER_ID,
      authored: authored(),
      now: NOW,
      createId: idSequence(),
    });
    const put = vi.fn();
    await expect(storeManagedMediaUpload({
      db: d1,
      bucket: { put } as unknown as R2Bucket,
      uploadId: UPLOAD_ID,
      userId: USER_ID,
      body: new Blob(['not png']).stream(),
      contentLength: PNG.byteLength,
      now: new Date('2026-08-03T01:01:00.000Z'),
    })).resolves.toEqual({ kind: 'signature_invalid' });
    expect(put).not.toHaveBeenCalled();
    await expect(garbageCollectExpiredMediaUploadIntents({
      db: d1,
      now: new Date('2026-08-03T01:16:00.000Z'),
    })).resolves.toEqual({ deletedRows: 1, queuedObjectRows: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM media_upload_intents').get())
      .toEqual({ n: 0 });
    expect(sqlite.prepare('SELECT storage_key FROM media_object_deletions').get())
      .toEqual({ storage_key: `uploads/2026/08/${MEDIA_ID}.png` });
  });

  it('cancels only the owning user intent', async () => {
    const { sqlite, d1 } = database();
    await createManagedMediaUploadIntent({
      db: d1,
      userId: USER_ID,
      authored: authored(),
      now: NOW,
      createId: idSequence(),
    });
    await expect(cancelManagedMediaUploadIntent({
      db: d1,
      id: UPLOAD_ID,
      userId: '9'.repeat(32),
    })).resolves.toBe(false);
    await expect(cancelManagedMediaUploadIntent({
      db: d1,
      id: UPLOAD_ID,
      userId: USER_ID,
    })).resolves.toBe(true);
    expect(sqlite.prepare('SELECT storage_key FROM media_object_deletions').get())
      .toEqual({ storage_key: `uploads/2026/08/${MEDIA_ID}.png` });
  });
});

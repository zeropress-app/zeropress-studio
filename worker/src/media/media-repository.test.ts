import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMediaRequestSchema } from '../../../contracts/media';
import {
  bulkMutateMedia,
  createMedia,
  deleteMedia,
  getMediaInformation,
  getR2MediaReferencePreviewDescriptor,
  getR2MediaPreviewDescriptor,
  listMedia,
  listMediaReferences,
  updateMedia,
} from './media-repository';

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
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = (
      this.database.prepare(this.sql).all as (...params: unknown[]) => T[]
    )(...this.params);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    const result = (
      this.database.prepare(this.sql).get as (...params: unknown[]) => T | undefined
    )(...this.params);
    return result ?? null;
  }

  async execute(): Promise<D1Result<unknown>> {
    return /^\s*(?:WITH\b[\s\S]+?\bSELECT\b|SELECT\b)/iu.test(this.sql)
      ? this.all()
      : this.run();
  }
}

function createTestDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync(
    new URL('../../../database/install/001_baseline.sql', import.meta.url),
    'utf8',
  ));
  const d1 = {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.execute());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { database, d1 };
}

const NOW = new Date('2026-08-02T03:00:00.000Z');
const FIRST_ID = '1'.repeat(32);
const SECOND_ID = '2'.repeat(32);
const THIRD_ID = '3'.repeat(32);
const R2_ID = '4'.repeat(32);
const FIRST_REVISION = 'a'.repeat(32);
const SECOND_REVISION = 'b'.repeat(32);

function authored(src: string, alt = '') {
  return createMediaRequestSchema.parse({
    kind: 'image',
    filename: new URL(src).pathname.split('/').at(-1),
    mime_type: 'image/jpeg',
    location: { type: 'external', url: src },
    size_bytes: null,
    width: 1600,
    height: 900,
    duration_ms: null,
    alt,
  });
}

describe('Media D1 repository', () => {
  it('lists every restrictive reference with bounded deterministic pagination', async () => {
    const { database, d1 } = createTestDatabase();
    await createMedia({
      db: d1,
      authored: authored('https://media.example/uploads/hero.jpg', 'Hero'),
      now: NOW,
      createId: () => FIRST_ID,
      createRevision: () => FIRST_REVISION,
    });
    database.prepare(`
      INSERT INTO authors (
        id, user_id, display_name, revision, created_at_iso, updated_at_iso,
        avatar_media_id
      ) VALUES ('site-owner', NULL, 'Site Owner', ?, ?, ?, ?)
    `).run('d'.repeat(32), NOW.toISOString(), NOW.toISOString(), FIRST_ID);
    database.prepare(`
      INSERT INTO posts (
        id, public_id, title, slug, author_id, featured_image_id, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, 100000000001, 'Referenced Post', 'referenced-post',
        'site-owner', ?, ?, ?, ?)
    `).run(
      '4'.repeat(32),
      FIRST_ID,
      '4'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );
    database.prepare(`
      INSERT INTO pages (
        id, public_id, title, slug, featured_image_id, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, 100000000002, 'Referenced Page', 'referenced-page',
        ?, ?, ?, ?)
    `).run(
      '5'.repeat(32),
      FIRST_ID,
      '5'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );
    database.prepare(`
      INSERT INTO site_assets (
        slot, media_id, alt_text, updated_by, updated_at_iso
      ) VALUES ('logo', ?, 'Site logo', NULL, ?)
    `).run(FIRST_ID, NOW.toISOString());

    await expect(listMedia({
      db: d1,
      query: {
        search: '',
        kind: 'all',
        purpose: 'all',
        collection: 'all',
        page: 1,
        per_page: 50,
      },
    })).resolves.toMatchObject({
      items: [{
        id: FIRST_ID,
        usage: { posts: 1, pages: 1, authors: 1, branding: 1 },
      }],
    });
    await expect(listMediaReferences({
      db: d1,
      id: FIRST_ID,
      query: { page: 1, per_page: 2 },
    })).resolves.toEqual({
      kind: 'completed',
      items: [
        {
          type: 'post',
          id: '4'.repeat(32),
          public_id: 100000000001,
          title: 'Referenced Post',
        },
        {
          type: 'page',
          id: '5'.repeat(32),
          public_id: 100000000002,
          title: 'Referenced Page',
        },
      ],
      pagination: { page: 1, per_page: 2, total: 4, total_pages: 2 },
    });
    await expect(listMediaReferences({
      db: d1,
      id: FIRST_ID,
      query: { page: 2, per_page: 2 },
    })).resolves.toEqual({
      kind: 'completed',
      items: [
        { type: 'author', id: 'site-owner', display_name: 'Site Owner' },
        { type: 'branding', slot: 'logo' },
      ],
      pagination: { page: 2, per_page: 2, total: 4, total_pages: 2 },
    });
    await expect(listMediaReferences({
      db: d1,
      id: SECOND_ID,
      query: { page: 1, per_page: 20 },
    })).resolves.toEqual({ kind: 'not_found' });
    await expect(deleteMedia({
      db: d1,
      id: FIRST_ID,
      expectedRevision: FIRST_REVISION,
    })).resolves.toEqual({ kind: 'in_use' });
  });

  it('reads AI provenance and references through one bounded information query', async () => {
    const { database, d1 } = createTestDatabase();
    const generation = {
      version: 1,
      model: '@cf/black-forest-labs/flux-2-klein-4b',
      prompt_version: 'image-v1',
      prompt: 'A quiet library at sunrise',
      aspect_ratio: 'landscape',
      seed: 42,
    } as const;
    database.prepare(`
      INSERT INTO media (
        id, kind, filename, mime_type, storage_type, storage_key,
        external_url, size_bytes, width, height, duration_ms, alt,
        revision, created_at_iso, updated_at_iso, ai_generation_json
      ) VALUES (?, 'image', 'generated.png', 'image/png', 'r2', ?, NULL,
        1234, 1024, 576, NULL, 'Quiet library', ?, ?, ?, ?)
    `).run(
      R2_ID,
      `uploads/2026/08/${R2_ID}.png`,
      FIRST_REVISION,
      NOW.toISOString(),
      NOW.toISOString(),
      JSON.stringify(generation),
    );

    await expect(getMediaInformation({
      db: d1,
      id: R2_ID,
      query: { page: 1, per_page: 20 },
    })).resolves.toEqual({
      kind: 'completed',
      generation,
      items: [],
      pagination: { page: 1, per_page: 20, total: 0, total_pages: 0 },
    });
    await expect(getMediaInformation({
      db: d1,
      id: SECOND_ID,
      query: { page: 1, per_page: 20 },
    })).resolves.toEqual({ kind: 'not_found' });
  });

  it('registers canonical metadata, reports usage, and protects references', async () => {
    const { database, d1 } = createTestDatabase();
    const created = await createMedia({
      db: d1,
      authored: authored('https://media.example/uploads/hero.jpg', 'Hero'),
      now: NOW,
      createId: () => FIRST_ID,
      createRevision: () => FIRST_REVISION,
    });
    expect(created).toMatchObject({
      kind: 'completed',
      media: {
        id: FIRST_ID,
        location: {
          type: 'external',
          url: 'https://media.example/uploads/hero.jpg',
        },
        usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
        revision: FIRST_REVISION,
      },
    });

    database.prepare(`
      INSERT INTO pages (
        id, public_id, parent_id, title, slug, content, document_type,
        excerpt, status, discoverability, allow_comments, featured_image_id,
        revision, created_at_iso, updated_at_iso
      ) VALUES (?, 100000000001, NULL, 'About', 'about', '', 'html', '',
        'draft', 'default', 0, ?, ?, ?, ?)
    `).run('3'.repeat(32), FIRST_ID, 'c'.repeat(32), NOW.toISOString(), NOW.toISOString());

    await expect(listMedia({
      db: d1,
      query: {
        search: 'hero',
        kind: 'all',
        purpose: 'all',
        collection: 'all',
        page: 1,
        per_page: 50,
      },
    })).resolves.toMatchObject({
      items: [{
        id: FIRST_ID,
        usage: { posts: 0, pages: 1, authors: 0, branding: 0 },
      }],
      pagination: { total: 1, total_pages: 1 },
    });
    await expect(deleteMedia({
      db: d1,
      id: FIRST_ID,
      expectedRevision: FIRST_REVISION,
    })).resolves.toEqual({ kind: 'in_use' });
    await expect(updateMedia({
      db: d1,
      id: FIRST_ID,
      authored: {
        kind: 'document',
        filename: 'hero.pdf',
        mime_type: 'application/pdf',
        location: {
          type: 'external',
          url: 'https://media.example/uploads/hero.pdf',
        },
        size_bytes: null,
        width: null,
        height: null,
        duration_ms: null,
        alt: '',
        expected_revision: FIRST_REVISION,
      },
    })).resolves.toEqual({ kind: 'in_use' });

    database.prepare('UPDATE pages SET featured_image_id = NULL').run();
    database.prepare(`
      INSERT INTO authors (
        id, user_id, display_name, revision, created_at_iso, updated_at_iso,
        avatar_media_id
      ) VALUES ('owner', NULL, 'Owner', ?, ?, ?, ?)
    `).run(
      'd'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
      FIRST_ID,
    );
    await expect(listMedia({
      db: d1,
      query: {
        search: 'hero',
        kind: 'all',
        purpose: 'author_avatar',
        collection: 'all',
        page: 1,
        per_page: 50,
      },
    })).resolves.toMatchObject({
      items: [{
        id: FIRST_ID,
        usage: { posts: 0, pages: 0, authors: 1, branding: 0 },
      }],
    });
    await expect(deleteMedia({
      db: d1,
      id: FIRST_ID,
      expectedRevision: FIRST_REVISION,
    })).resolves.toEqual({ kind: 'in_use' });
    await expect(updateMedia({
      db: d1,
      id: FIRST_ID,
      authored: {
        kind: 'document',
        filename: 'hero.pdf',
        mime_type: 'application/pdf',
        location: {
          type: 'external',
          url: 'https://media.example/uploads/hero.pdf',
        },
        size_bytes: null,
        width: null,
        height: null,
        duration_ms: null,
        alt: '',
        expected_revision: FIRST_REVISION,
      },
    })).resolves.toEqual({ kind: 'in_use' });
    database.prepare('UPDATE authors SET avatar_media_id = NULL').run();
    await expect(deleteMedia({
      db: d1,
      id: FIRST_ID,
      expectedRevision: FIRST_REVISION,
    })).resolves.toEqual({ kind: 'completed', cleanupKey: null });
  });

  it('queues imported R2 objects for deletion and preserves them if R2 is unavailable', async () => {
    const { database, d1 } = createTestDatabase();
    const storageKey = 'imported/2026/08/manual.pdf';
    database.prepare(`
      INSERT INTO media (
        id, kind, filename, mime_type, storage_type, storage_key,
        external_url, size_bytes, width, height, duration_ms, alt, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, 'document', 'manual.pdf', 'application/pdf', 'r2', ?,
        NULL, 4096, NULL, NULL, NULL, '', ?, ?, ?)
    `).run(
      FIRST_ID,
      storageKey,
      FIRST_REVISION,
      NOW.toISOString(),
      NOW.toISOString(),
    );

    await expect(deleteMedia({
      db: d1,
      id: FIRST_ID,
      expectedRevision: FIRST_REVISION,
      allowR2ObjectDeletion: false,
    })).resolves.toEqual({ kind: 'managed_object_unavailable' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM media').get())
      .toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM media_object_deletions
    `).get()).toEqual({ count: 0 });

    await expect(deleteMedia({
      db: d1,
      id: FIRST_ID,
      expectedRevision: FIRST_REVISION,
      allowR2ObjectDeletion: true,
    })).resolves.toEqual({ kind: 'completed', cleanupKey: storageKey });
    expect(database.prepare(`
      SELECT storage_key FROM media_object_deletions
    `).get()).toEqual({ storage_key: storageKey });
  });

  it('bulk edits filename and image alt with ordered optimistic outcomes', async () => {
    const { database, d1 } = createTestDatabase();
    for (const [id, revision, name] of [
      [FIRST_ID, FIRST_REVISION, 'first'],
      [SECOND_ID, SECOND_REVISION, 'second'],
      [THIRD_ID, 'c'.repeat(32), 'third'],
    ] as const) {
      await createMedia({
        db: d1,
        authored: authored(`https://media.example/uploads/${name}.jpg`, name),
        now: NOW,
        createId: () => id,
        createRevision: () => revision,
      });
    }
    const result = await bulkMutateMedia({
      db: d1,
      request: {
        operation: 'update_metadata',
        items: [
          {
            id: FIRST_ID,
            expected_revision: FIRST_REVISION,
            filename: 'renamed.jpg',
            alt: 'Renamed',
          },
          {
            id: SECOND_ID,
            expected_revision: 'f'.repeat(32),
            filename: 'second.jpg',
            alt: 'second',
          },
          {
            id: THIRD_ID,
            expected_revision: 'f'.repeat(32),
            filename: 'renamed-third.jpg',
            alt: 'third',
          },
          {
            id: R2_ID,
            expected_revision: '4'.repeat(32),
            filename: 'missing.jpg',
            alt: '',
          },
        ],
      },
      allowR2ObjectDeletion: true,
      now: NOW,
      createRevision: () => 'd'.repeat(32),
    });
    expect(result).toEqual({
      operation: 'update_metadata',
      results: [
        { id: FIRST_ID, outcome: 'updated', revision: 'd'.repeat(32) },
        { id: SECOND_ID, outcome: 'unchanged', revision: SECOND_REVISION },
        { id: THIRD_ID, outcome: 'conflict' },
        { id: R2_ID, outcome: 'skipped', reason: 'not_found' },
      ],
      summary: {
        requested: 4,
        updated: 1,
        unchanged: 1,
        conflict: 1,
        skipped: 1,
        queued_objects: 0,
      },
      cleanupKeys: [],
    });
    expect(database.prepare(`
      SELECT filename, alt, revision FROM media WHERE id = ?
    `).get(FIRST_ID)).toEqual({
      filename: 'renamed.jpg',
      alt: 'Renamed',
      revision: 'd'.repeat(32),
    });
  });

  it('bulk deletes eligible rows, protects references, and durably queues R2 cleanup', async () => {
    const { database, d1 } = createTestDatabase();
    await createMedia({
      db: d1,
      authored: authored('https://media.example/uploads/first.jpg'),
      now: NOW,
      createId: () => FIRST_ID,
      createRevision: () => FIRST_REVISION,
    });
    await createMedia({
      db: d1,
      authored: authored('https://media.example/uploads/second.jpg'),
      now: NOW,
      createId: () => SECOND_ID,
      createRevision: () => SECOND_REVISION,
    });
    database.prepare(`
      INSERT INTO site_assets (
        slot, media_id, alt_text, updated_by, updated_at_iso
      ) VALUES ('logo', ?, 'Logo', NULL, ?)
    `).run(SECOND_ID, NOW.toISOString());
    const storageKey = 'imported/2026/manual.pdf';
    database.prepare(`
      INSERT INTO media (
        id, kind, filename, mime_type, storage_type, storage_key,
        external_url, size_bytes, width, height, duration_ms, alt, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, 'document', 'manual.pdf', 'application/pdf', 'r2', ?,
        NULL, 4096, NULL, NULL, NULL, '', ?, ?, ?)
    `).run(
      THIRD_ID,
      storageKey,
      'c'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );

    const unavailable = await bulkMutateMedia({
      db: d1,
      request: {
        operation: 'delete',
        items: [
          { id: FIRST_ID, expected_revision: FIRST_REVISION },
          { id: SECOND_ID, expected_revision: SECOND_REVISION },
          { id: THIRD_ID, expected_revision: 'c'.repeat(32) },
        ],
      },
      allowR2ObjectDeletion: false,
      now: NOW,
    });
    expect(unavailable.results).toEqual([
      { id: FIRST_ID, outcome: 'updated', object_cleanup: 'not_applicable' },
      { id: SECOND_ID, outcome: 'skipped', reason: 'in_use' },
      {
        id: THIRD_ID,
        outcome: 'skipped',
        reason: 'managed_storage_unavailable',
      },
    ]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM media').get())
      .toEqual({ count: 2 });

    const completed = await bulkMutateMedia({
      db: d1,
      request: {
        operation: 'delete',
        items: [{ id: THIRD_ID, expected_revision: 'c'.repeat(32) }],
      },
      allowR2ObjectDeletion: true,
      now: NOW,
    });
    expect(completed).toMatchObject({
      results: [{ id: THIRD_ID, outcome: 'updated', object_cleanup: 'pending' }],
      summary: { updated: 1, queued_objects: 1 },
      cleanupKeys: [storageKey],
    });
    expect(database.prepare(`
      SELECT storage_key FROM media_object_deletions
    `).get()).toEqual({ storage_key: storageKey });
  });

  it('uses source identity and optimistic revisions without partial updates', async () => {
    const { d1 } = createTestDatabase();
    await createMedia({
      db: d1,
      authored: authored('https://media.example/uploads/first.jpg'),
      now: NOW,
      createId: () => FIRST_ID,
      createRevision: () => FIRST_REVISION,
    });
    await expect(createMedia({
      db: d1,
      authored: authored('https://media.example/uploads/first.jpg'),
      now: NOW,
      createId: () => SECOND_ID,
      createRevision: () => SECOND_REVISION,
    })).resolves.toEqual({ kind: 'source_conflict' });
    await expect(updateMedia({
      db: d1,
      id: FIRST_ID,
      authored: {
        ...authored('https://media.example/uploads/changed.jpg'),
        expected_revision: 'f'.repeat(32),
      },
      createRevision: () => SECOND_REVISION,
    })).resolves.toEqual({ kind: 'revision_conflict' });

    const updated = await updateMedia({
      db: d1,
      id: FIRST_ID,
      authored: {
        ...authored('https://media.example/uploads/changed.jpg', 'Changed'),
        expected_revision: FIRST_REVISION,
      },
      now: new Date('2026-08-02T04:00:00.000Z'),
      createRevision: () => SECOND_REVISION,
    });
    await createMedia({
      db: d1,
      authored: createMediaRequestSchema.parse({
        kind: 'document',
        filename: 'manual.pdf',
        mime_type: 'application/pdf',
        location: {
          type: 'external',
          url: 'https://media.example/uploads/manual.pdf',
        },
        size_bytes: 2048,
        width: null,
        height: null,
        duration_ms: null,
        alt: '',
      }),
      now: NOW,
      createId: () => THIRD_ID,
      createRevision: () => 'c'.repeat(32),
    });
    await expect(listMedia({
      db: d1,
      query: {
        search: '',
        kind: 'document',
        purpose: 'all',
        collection: 'all',
        page: 1,
        per_page: 50,
      },
    })).resolves.toMatchObject({
      items: [{ id: THIRD_ID, kind: 'document' }],
      pagination: { total: 1, total_pages: 1 },
    });
    await expect(listMedia({
      db: d1,
      query: {
        search: 'manual',
        kind: 'image',
        purpose: 'all',
        collection: 'all',
        page: 1,
        per_page: 50,
      },
    })).resolves.toMatchObject({
      items: [],
      pagination: { total: 0, total_pages: 0 },
    });
    expect(updated).toMatchObject({
      kind: 'completed',
      media: {
        location: {
          type: 'external',
          url: 'https://media.example/uploads/changed.jpg',
        },
        alt: 'Changed',
        revision: SECOND_REVISION,
      },
    });
  });

  it('combines flat collection filters with search and deterministic row ordering', async () => {
    const { database, d1 } = createTestDatabase();
    const photographyId = '4'.repeat(32);
    const eventsId = '5'.repeat(32);
    database.prepare(`
      INSERT INTO media_collections (
        id, name, revision, created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?)
    `).run(photographyId, 'Photography', 'd'.repeat(32), NOW.toISOString(), NOW.toISOString());
    database.prepare(`
      INSERT INTO media_collections (
        id, name, revision, created_at_iso, updated_at_iso
      ) VALUES (?, ?, ?, ?, ?)
    `).run(eventsId, 'Events', 'e'.repeat(32), NOW.toISOString(), NOW.toISOString());

    for (const [id, url, revision] of [
      [FIRST_ID, 'https://media.example/uploads/first.jpg', FIRST_REVISION],
      [SECOND_ID, 'https://media.example/uploads/second.jpg', SECOND_REVISION],
      [THIRD_ID, 'https://media.example/uploads/events.jpg', 'c'.repeat(32)],
    ] as const) {
      await createMedia({
        db: d1,
        authored: { ...authored(url), filename: 'shared.jpg' },
        now: NOW,
        createId: () => id,
        createRevision: () => revision,
      });
    }
    database.prepare(`
      UPDATE media SET collection_id = ? WHERE id IN (?, ?)
    `).run(photographyId, FIRST_ID, SECOND_ID);
    database.prepare(`
      UPDATE media SET collection_id = ? WHERE id = ?
    `).run(eventsId, THIRD_ID);

    await expect(listMedia({
      db: d1,
      query: {
        search: 'shared',
        kind: 'all',
        purpose: 'all',
        collection: photographyId,
        page: 1,
        per_page: 50,
      },
    })).resolves.toMatchObject({
      items: [
        { id: FIRST_ID, collection: { id: photographyId, name: 'Photography' } },
        { id: SECOND_ID, collection: { id: photographyId, name: 'Photography' } },
      ],
      pagination: { total: 2 },
    });
    await expect(listMedia({
      db: d1,
      query: {
        search: 'Photography',
        kind: 'all',
        purpose: 'all',
        collection: 'all',
        page: 1,
        per_page: 50,
      },
    })).resolves.toMatchObject({ items: [], pagination: { total: 0 } });
    await expect(listMedia({
      db: d1,
      query: {
        search: '',
        kind: 'all',
        purpose: 'all',
        collection: 'unfiled',
        page: 1,
        per_page: 50,
      },
    })).resolves.toMatchObject({ items: [], pagination: { total: 0 } });
  });

  it('provides paginated picker filtering', async () => {
    const { d1 } = createTestDatabase();
    await createMedia({
      db: d1,
      authored: authored('https://media.example/uploads/zeta.jpg', 'Zeta'),
      now: NOW,
      createId: () => FIRST_ID,
      createRevision: () => FIRST_REVISION,
    });
    await createMedia({
      db: d1,
      authored: authored('https://media.example/uploads/alpha.jpg', 'Alpha'),
      now: NOW,
      createId: () => SECOND_ID,
      createRevision: () => SECOND_REVISION,
    });
    await expect(listMedia({
      db: d1,
      query: {
        search: 'alpha',
        kind: 'all',
        purpose: 'featured_image',
        collection: 'all',
        page: 1,
        per_page: 50,
      },
    })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: SECOND_ID })],
      pagination: { total: 1 },
    });
  });

  it('resolves passive raster and icon R2 images for private Studio previews', async () => {
    const { database, d1 } = createTestDatabase();
    const insert = database.prepare(`
      INSERT INTO media (
        id, kind, filename, mime_type, storage_type, storage_key, external_url,
        size_bytes, width, height, duration_ms, alt, revision,
        created_at_iso, updated_at_iso
      ) VALUES (?, 'image', ?, ?, 'r2', ?, NULL, ?, 1600, 900, NULL, '', ?, ?, ?)
    `);
    insert.run(
      FIRST_ID,
      'hero.png',
      'image/png',
      `uploads/2026/08/${FIRST_ID}.png`,
      2048,
      FIRST_REVISION,
      NOW.toISOString(),
      NOW.toISOString(),
    );
    insert.run(
      SECOND_ID,
      'logo.svg',
      'image/svg+xml',
      `imported/2026/logo.svg`,
      1024,
      SECOND_REVISION,
      NOW.toISOString(),
      NOW.toISOString(),
    );
    insert.run(
      THIRD_ID,
      'favicon.ico',
      'image/vnd.microsoft.icon',
      `imported/2026/favicon.ico`,
      4096,
      '3'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );
    insert.run(
      R2_ID,
      'managed.svg',
      'image/svg+xml',
      `uploads/2026/08/${R2_ID}.svg`,
      768,
      '4'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );

    await expect(getR2MediaPreviewDescriptor({ db: d1, id: FIRST_ID }))
      .resolves.toEqual({
        mediaId: FIRST_ID,
        mimeType: 'image/png',
        storageKey: `uploads/2026/08/${FIRST_ID}.png`,
      });
    await expect(getR2MediaPreviewDescriptor({ db: d1, id: SECOND_ID }))
      .resolves.toBeNull();
    await expect(getR2MediaPreviewDescriptor({ db: d1, id: THIRD_ID }))
      .resolves.toEqual({
        mediaId: THIRD_ID,
        mimeType: 'image/vnd.microsoft.icon',
        storageKey: `imported/2026/favicon.ico`,
      });
    await expect(getR2MediaPreviewDescriptor({ db: d1, id: R2_ID }))
      .resolves.toEqual({
        mediaId: R2_ID,
        mimeType: 'image/svg+xml',
        storageKey: `uploads/2026/08/${R2_ID}.svg`,
      });
    await expect(getR2MediaPreviewDescriptor({ db: d1, id: '5'.repeat(32) }))
      .resolves.toBeNull();

    await expect(getR2MediaReferencePreviewDescriptor({
      db: d1,
      storageKey: `uploads/2026/08/${FIRST_ID}.png`,
    })).resolves.toEqual({
      mediaId: FIRST_ID,
      mimeType: 'image/png',
      storageKey: `uploads/2026/08/${FIRST_ID}.png`,
    });
    await expect(getR2MediaReferencePreviewDescriptor({
      db: d1,
      storageKey: 'imported/2026/logo.svg',
    })).resolves.toEqual({
      mediaId: SECOND_ID,
      mimeType: 'image/svg+xml',
      storageKey: 'imported/2026/logo.svg',
    });
    await expect(getR2MediaReferencePreviewDescriptor({
      db: d1,
      storageKey: 'uploads/2026/08/missing.png',
    })).resolves.toBeNull();
  });
});

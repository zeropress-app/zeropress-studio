import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMediaRequestSchema } from '../../../contracts/media';
import { createMedia } from './media-repository';
import {
  bulkMoveMedia,
  createMediaCollection,
  deleteMediaCollection,
  listMediaCollections,
  updateMediaCollection,
} from './media-collection-repository';

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
      const results = [];
      for (const statement of statements) results.push(await statement.all());
      return results;
    },
  } as unknown as D1Database;
  return { database, d1 };
}

const NOW = new Date('2026-08-09T01:00:00.000Z');
const PHOTOGRAPHY_ID = '1'.repeat(32);
const EVENTS_ID = '2'.repeat(32);
const MEDIA_ONE_ID = '3'.repeat(32);
const MEDIA_TWO_ID = '4'.repeat(32);
const PHOTOGRAPHY_REVISION = 'a'.repeat(32);
const EVENTS_REVISION = 'b'.repeat(32);
const MEDIA_ONE_REVISION = 'c'.repeat(32);
const MEDIA_TWO_REVISION = 'd'.repeat(32);

function media(url: string) {
  return createMediaRequestSchema.parse({
    kind: 'image',
    filename: new URL(url).pathname.split('/').at(-1),
    mime_type: 'image/jpeg',
    location: { type: 'external', url },
    size_bytes: null,
    width: 1200,
    height: 800,
    duration_ms: null,
    alt: '',
  });
}

describe('Media collection D1 repository', () => {
  it('keeps a flat deterministic catalog with globally unique names and empty-only deletion', async () => {
    const { database, d1 } = createTestDatabase();
    const collectionColumns = database.prepare(
      'PRAGMA table_info(media_collections)',
    ).all() as Array<{ name: string }>;
    expect(collectionColumns.map((column) => column.name)).not.toContain('parent_id');

    await expect(createMediaCollection({
      db: d1,
      authored: { name: 'Photography' },
      now: NOW,
      createId: () => PHOTOGRAPHY_ID,
      createRevision: () => PHOTOGRAPHY_REVISION,
    })).resolves.toMatchObject({
      kind: 'completed',
      collection: { id: PHOTOGRAPHY_ID, media_count: 0 },
    });
    await expect(createMediaCollection({
      db: d1,
      authored: { name: 'Events' },
      now: NOW,
      createId: () => EVENTS_ID,
      createRevision: () => EVENTS_REVISION,
    })).resolves.toMatchObject({
      kind: 'completed',
      collection: { id: EVENTS_ID, media_count: 0 },
    });
    await expect(listMediaCollections({ db: d1 })).resolves.toMatchObject({
      items: [
        { id: EVENTS_ID, name: 'Events' },
        { id: PHOTOGRAPHY_ID, name: 'Photography' },
      ],
    });
    await expect(createMediaCollection({
      db: d1,
      authored: { name: 'photography' },
      now: NOW,
      createId: () => '5'.repeat(32),
      createRevision: () => 'e'.repeat(32),
    })).resolves.toEqual({ kind: 'name_conflict' });
    await expect(updateMediaCollection({
      db: d1,
      id: EVENTS_ID,
      authored: {
        name: 'Photography',
        expected_revision: EVENTS_REVISION,
      },
      now: NOW,
      createRevision: () => 'f'.repeat(32),
    })).resolves.toEqual({ kind: 'name_conflict' });
    await expect(updateMediaCollection({
      db: d1,
      id: EVENTS_ID,
      authored: {
        name: 'Editorial',
        expected_revision: EVENTS_REVISION,
      },
      now: NOW,
      createRevision: () => 'f'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      collection: { name: 'Editorial', revision: 'f'.repeat(32) },
    });
    await expect(updateMediaCollection({
      db: d1,
      id: EVENTS_ID,
      authored: {
        name: 'Editorial',
        expected_revision: 'f'.repeat(32),
      },
      now: NOW,
      createRevision: () => '0'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      collection: { revision: 'f'.repeat(32) },
    });
    await createMedia({
      db: d1,
      authored: media('https://media.example/one.jpg'),
      now: NOW,
      createId: () => MEDIA_ONE_ID,
      createRevision: () => MEDIA_ONE_REVISION,
    });
    await bulkMoveMedia({
      db: d1,
      authored: {
        target_collection_id: PHOTOGRAPHY_ID,
        items: [{ id: MEDIA_ONE_ID, expected_revision: MEDIA_ONE_REVISION }],
      },
      now: NOW,
    });
    await expect(deleteMediaCollection({
      db: d1,
      id: PHOTOGRAPHY_ID,
      expectedRevision: PHOTOGRAPHY_REVISION,
    })).resolves.toEqual({ kind: 'not_empty' });
    await expect(deleteMediaCollection({
      db: d1,
      id: EVENTS_ID,
      expectedRevision: 'f'.repeat(32),
    })).resolves.toEqual({ kind: 'completed' });

    const movedRevision = database.prepare(
      'SELECT revision FROM media WHERE id = ?',
    ).get(MEDIA_ONE_ID) as { revision: string };
    await bulkMoveMedia({
      db: d1,
      authored: {
        target_collection_id: null,
        items: [{ id: MEDIA_ONE_ID, expected_revision: movedRevision.revision }],
      },
      now: NOW,
    });
    await expect(deleteMediaCollection({
      db: d1,
      id: PHOTOGRAPHY_ID,
      expectedRevision: PHOTOGRAPHY_REVISION,
    })).resolves.toEqual({ kind: 'completed' });
  });

  it('moves a bounded revision set atomically and leaves no-op revisions unchanged', async () => {
    const { database, d1 } = createTestDatabase();
    await createMediaCollection({
      db: d1,
      authored: { name: 'Library' },
      now: NOW,
      createId: () => PHOTOGRAPHY_ID,
      createRevision: () => PHOTOGRAPHY_REVISION,
    });
    await createMedia({
      db: d1,
      authored: media('https://media.example/one.jpg'),
      now: NOW,
      createId: () => MEDIA_ONE_ID,
      createRevision: () => MEDIA_ONE_REVISION,
    });
    await createMedia({
      db: d1,
      authored: media('https://media.example/two.jpg'),
      now: NOW,
      createId: () => MEDIA_TWO_ID,
      createRevision: () => MEDIA_TWO_REVISION,
    });

    await expect(bulkMoveMedia({
      db: d1,
      authored: {
        target_collection_id: PHOTOGRAPHY_ID,
        items: [
          { id: MEDIA_ONE_ID, expected_revision: MEDIA_ONE_REVISION },
          { id: MEDIA_TWO_ID, expected_revision: MEDIA_TWO_REVISION },
        ],
      },
      now: new Date('2026-08-09T01:01:00.000Z'),
    })).resolves.toEqual({ kind: 'completed', movedCount: 2, unchangedCount: 0 });

    const movedRows = database.prepare(`
      SELECT id, collection_id, revision FROM media ORDER BY id
    `).all() as Array<{ id: string; collection_id: string | null; revision: string }>;
    expect(movedRows.map((row) => row.collection_id)).toEqual([
      PHOTOGRAPHY_ID,
      PHOTOGRAPHY_ID,
    ]);
    expect(movedRows[0]?.revision).not.toBe(MEDIA_ONE_REVISION);
    expect(movedRows[1]?.revision).not.toBe(MEDIA_TWO_REVISION);
    const catalog = await listMediaCollections({ db: d1 });
    expect(catalog).toMatchObject({
      total_media_count: 2,
      unfiled_media_count: 0,
      items: [{ id: PHOTOGRAPHY_ID, media_count: 2 }],
    });

    await expect(bulkMoveMedia({
      db: d1,
      authored: {
        target_collection_id: PHOTOGRAPHY_ID,
        items: movedRows.map((row) => ({
          id: row.id,
          expected_revision: row.revision,
        })),
      },
      now: new Date('2026-08-09T01:02:00.000Z'),
    })).resolves.toEqual({ kind: 'completed', movedCount: 0, unchangedCount: 2 });
    const noOpRows = database.prepare(`
      SELECT id, revision FROM media ORDER BY id
    `).all() as Array<{ id: string; revision: string }>;
    expect(noOpRows).toEqual(movedRows.map(({ id, revision }) => ({ id, revision })));

    await expect(bulkMoveMedia({
      db: d1,
      authored: {
        target_collection_id: null,
        items: [
          { id: movedRows[0]!.id, expected_revision: movedRows[0]!.revision },
          { id: movedRows[1]!.id, expected_revision: MEDIA_TWO_REVISION },
        ],
      },
      now: new Date('2026-08-09T01:03:00.000Z'),
    })).resolves.toEqual({ kind: 'conflict' });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM media WHERE collection_id = ?
    `).get(PHOTOGRAPHY_ID)).toEqual({ count: 2 });
  });
});

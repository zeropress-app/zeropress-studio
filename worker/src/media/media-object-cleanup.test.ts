import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteQueuedMediaObject, drainMediaObjectDeletionQueue } from './media-object-cleanup';
import { sqliteD1, type SqliteD1Hooks } from '../test-helpers/sqlite-d1';

const open: DatabaseSync[] = [];
afterEach(() => {
  for (const database of open.splice(0)) database.close();
  vi.restoreAllMocks();
});

function durableQueue(hooks: SqliteD1Hooks = {}) {
  const sqlite = new DatabaseSync(':memory:');
  open.push(sqlite);
  sqlite.exec(`CREATE TABLE media_object_deletions (
    storage_key TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL DEFAULT 0,
    created_at_iso TEXT NOT NULL, last_attempt_at_iso TEXT
  )`);
  const keys = ['uploads/2026/09/first.png', 'imported/2026/09/second.png'];
  for (const key of keys) sqlite.prepare(`INSERT INTO media_object_deletions
    (storage_key, created_at_iso) VALUES (?, '2026-09-04T00:00:00.000Z')`).run(key);
  const objects = new Set([...keys, 'uploads/2026/09/still-referenced.png']);
  const remove = (value: string | string[]) => {
    for (const key of Array.isArray(value) ? value : [value]) objects.delete(key);
  };
  return { sqlite, db: sqliteD1(sqlite, hooks), keys, objects, remove };
}

type CapturedStatement = {
  sql: string;
  params: unknown[];
  bind(...params: unknown[]): CapturedStatement;
  all<T>(): Promise<D1Result<T>>;
};

function database(storageKeys: string[]) {
  const batches: CapturedStatement[][] = [];
  const db = {
    prepare(sql: string): CapturedStatement {
      return {
        sql,
        params: [],
        bind(...params: unknown[]) {
          return { ...this, params };
        },
        async all<T>() {
          return {
            success: true,
            results: storageKeys.map((storage_key) => ({ storage_key })) as T[],
            meta: {},
          } as D1Result<T>;
        },
      };
    },
    async batch(statements: CapturedStatement[]) {
      batches.push(statements);
      return statements.map((statement) => ({
        success: true,
        results: [],
        meta: { changes: statement.params.length },
      })) as unknown as D1Result<unknown>[];
    },
  } as unknown as D1Database;
  return { db, batches };
}

describe('managed Media object cleanup batching', () => {
  it('deletes one thousand R2 keys with bounded D1 statement count', async () => {
    const storageKeys = Array.from(
      { length: 1_000 },
      (_, index) => (
        index % 2 === 0 ? 'uploads/' : 'imported/'
      ) + `2026/08/${String(index).padStart(32, '0')}.png`,
    );
    const { db, batches } = database(storageKeys);
    const deleteObjects = vi.fn().mockResolvedValue(undefined);

    await expect(drainMediaObjectDeletionQueue({
      db,
      bucket: { delete: deleteObjects } as unknown as R2Bucket,
    })).resolves.toEqual({ pendingRows: 1_000, deletedRows: 1_000 });

    expect(deleteObjects).toHaveBeenCalledWith(storageKeys);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(12);
    expect(Math.max(...batches[0]!.map((statement) => statement.params.length)))
      .toBe(90);
  });

  it('rejects cleanup keys outside the reviewed R2 namespaces', async () => {
    const { db } = database(['other/2026/08/unknown.png']);
    const deleteObjects = vi.fn();

    await expect(drainMediaObjectDeletionQueue({
      db,
      bucket: { delete: deleteObjects } as unknown as R2Bucket,
    })).rejects.toMatchObject({
      name: 'StudioOperationalError',
      code: 'MEDIA_OBJECT_CLEANUP_DATABASE_QUERY_FAILED',
    });
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it.each(['r2-rejection', 'partial-r2-response-loss', 'db-rollback', 'db-commit-response-loss', 'attempt-record-failure'] as const)(
    'converges from %s without losing the durable retry or deleting unrelated objects', async (failure) => {
      const hooks: SqliteD1Hooks = {};
      const { sqlite, db, keys, objects, remove } = durableQueue(hooks);
      const deleteObjects = vi.fn().mockImplementation(async (values: string[]) => remove(values));
      if (failure.startsWith('r2-') || failure === 'partial-r2-response-loss' || failure === 'attempt-record-failure') {
        deleteObjects.mockImplementationOnce(async () => {
          if (failure === 'partial-r2-response-loss') remove(keys[0]!);
          throw new Error('Injected R2 failure');
        });
      }
      if (failure === 'db-rollback') hooks.failSqlOnce = 'DELETE FROM media_object_deletions';
      if (failure === 'db-commit-response-loss') hooks.throwAfterCommitOnce = true;
      if (failure === 'attempt-record-failure') hooks.failSqlOnce = 'UPDATE media_object_deletions';
      const input = { db, bucket: { delete: deleteObjects } as unknown as R2Bucket };

      await expect(drainMediaObjectDeletionQueue(input)).rejects.toMatchObject({
        code: failure.startsWith('db-')
          ? 'MEDIA_OBJECT_CLEANUP_DATABASE_QUERY_FAILED' : 'MEDIA_OBJECT_CLEANUP_FAILED',
      });
      const pending = failure === 'db-commit-response-loss' ? 0 : 2;
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM media_object_deletions').get()).toEqual({ count: pending });
      await expect(drainMediaObjectDeletionQueue(input)).resolves.toEqual({ pendingRows: pending, deletedRows: pending });
      expect(sqlite.prepare('SELECT * FROM media_object_deletions').all()).toEqual([]);
      expect([...objects]).toEqual(['uploads/2026/09/still-referenced.png']);
      const calls = deleteObjects.mock.calls.length;
      await expect(drainMediaObjectDeletionQueue(input)).resolves.toEqual({ pendingRows: 0, deletedRows: 0 });
      expect(deleteObjects).toHaveBeenCalledTimes(calls);
    },
  );

  it('reports immediate cleanup as pending until the scheduled retry succeeds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { sqlite, db, keys, remove } = durableQueue();
    const deleteObjects = vi.fn().mockRejectedValueOnce(new Error('R2 unavailable'))
      .mockImplementation(async (values: string | string[]) => remove(values));
    const bucket = { delete: deleteObjects } as unknown as R2Bucket;
    await expect(deleteQueuedMediaObject({ db, bucket, storageKey: keys[0]! })).resolves.toBe('pending');
    expect(sqlite.prepare('SELECT attempt_count FROM media_object_deletions WHERE storage_key = ?').get(keys[0]!))
      .toEqual({ attempt_count: 1 });
    await expect(drainMediaObjectDeletionQueue({ db, bucket })).resolves.toEqual({ pendingRows: 2, deletedRows: 2 });
    expect(sqlite.prepare('SELECT * FROM media_object_deletions').all()).toEqual([]);
  });
});

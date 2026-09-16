import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { StudioOperationalError } from '../lib/operational-error';
import { readPreviewDataSummary } from './summary';

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
  ) {}

  async first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get() as T | undefined;
    return row ?? null;
  }
}

function createSummaryDatabase(): {
  database: DatabaseSync;
  db: D1Database;
} {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE posts (author_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE pages (status TEXT NOT NULL);
    CREATE TABLE categories (id TEXT PRIMARY KEY);
    CREATE TABLE tags (id TEXT PRIMARY KEY);
    CREATE TABLE menus (menu_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL);

    INSERT INTO posts (author_id, status) VALUES
      ('author-a', 'published'),
      ('author-a', 'published'),
      ('author-b', 'draft');
    INSERT INTO pages (status) VALUES ('published'), ('draft');
    INSERT INTO categories (id) VALUES ('category-a'), ('category-b');
    INSERT INTO tags (id) VALUES ('tag-a');
    INSERT INTO menus (menu_id, enabled) VALUES
      ('primary', 1),
      ('footer', 0);
  `);
  return {
    database,
    db: {
      prepare(sql: string) {
        return new SqliteD1Statement(database, sql);
      },
    } as unknown as D1Database,
  };
}

describe('Preview Data summary repository', () => {
  it('counts only content that is eligible for the export', async () => {
    const { database, db } = createSummaryDatabase();
    await expect(readPreviewDataSummary({ db })).resolves.toEqual({
      authors: 1,
      posts: 2,
      pages: 1,
      categories: 2,
      tags: 1,
      menus: 1,
    });
    database.close();
  });

  it('fails with a cataloged data error for malformed aggregate values', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue({
          authors: 0,
          posts: '2',
          pages: 0,
          categories: 0,
          tags: 0,
          menus: 0,
        }),
      }),
    } as unknown as D1Database;

    await expect(readPreviewDataSummary({ db })).rejects.toMatchObject({
      code: 'PREVIEW_DATA_SUMMARY_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
  });

  it('wraps D1 failures without exposing query details to the client', async () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error('database unavailable');
      }),
    } as unknown as D1Database;

    await expect(readPreviewDataSummary({ db })).rejects.toMatchObject({
      code: 'PREVIEW_DATA_SUMMARY_DATABASE_QUERY_FAILED',
    } satisfies Partial<StudioOperationalError>);
  });
});

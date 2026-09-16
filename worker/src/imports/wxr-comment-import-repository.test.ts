import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { WxrImportCommentRow } from '../../../contracts/wxr-import';
import { importWxrCommentChunk } from './wxr-comment-import-repository';

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

  async execute(): Promise<D1Result<unknown>> {
    return /^\s*SELECT\b/iu.test(this.sql) ? this.all() : this.run();
  }
}

function createEdgeDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`
    CREATE TABLE edge_comment_targets (
      id INTEGER PRIMARY KEY,
      target_type TEXT NOT NULL,
      public_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      allow_comments INTEGER NOT NULL,
      request_token_nonce TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      comments_cache_revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      UNIQUE (target_type, public_id)
    );
    CREATE TABLE comments (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      public_id INTEGER NOT NULL UNIQUE,
      target_id INTEGER NOT NULL REFERENCES edge_comment_targets(id) ON DELETE CASCADE,
      parent_public_id INTEGER,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      imported INTEGER NOT NULL DEFAULT 0,
      ip_address TEXT,
      ip_address_recorded_at TEXT,
      ip_hash TEXT,
      user_agent TEXT,
      asn INTEGER,
      as_organization TEXT,
      country_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      author_user_id TEXT,
      author_kind TEXT NOT NULL DEFAULT 'guest',
      author_identity_issuer TEXT
    );
    INSERT INTO edge_comment_targets (
      id, target_type, public_id, status, allow_comments,
      comments_cache_revision
    ) VALUES
      (1, 'post', 11, 'published', 1, 'post-before'),
      (2, 'page', 11, 'published', 1, 'page-before');
  `);
  const edgeDb = {
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
  return { database, edgeDb };
}

const CREATED = '2026-07-03T01:02:03Z';

function comment(input: Partial<WxrImportCommentRow> & {
  public_id: number;
}): WxrImportCommentRow {
  return {
    public_id: input.public_id,
    target_type: input.target_type ?? 'post',
    target_public_id: input.target_public_id ?? 11,
    parent_public_id: input.parent_public_id ?? null,
    author_name: input.author_name ?? 'Reader',
    author_email: input.author_email ?? '',
    content_text: input.content_text ?? `Comment ${input.public_id}`,
    status: input.status ?? 'approved',
    created_at_iso: input.created_at_iso ?? CREATED,
  };
}

describe('WXR comment EDGE_DB importer', () => {
  it('imports target-isolated Post/Page trees and rotates each touched cache once', async () => {
    const { database, edgeDb } = createEdgeDatabase();
    const rows = [
      comment({ public_id: 501 }),
      comment({ public_id: 502, parent_public_id: 501, status: 'pending' }),
      comment({
        public_id: 503,
        target_type: 'page',
        target_public_id: 11,
        author_email: 'reader@example.com',
      }),
    ];
    const first = await importWxrCommentChunk({
      edgeDb,
      request: { phase: 'comments', rows },
    });
    expect(first.summary).toMatchObject({
      processed: 3, created: 3, updated: 0, unchanged: 0, failed: 0,
    });
    expect(database.prepare(`
      SELECT c.public_id, t.target_type, c.parent_public_id, c.status,
        c.imported, c.author_kind, c.author_email, c.ip_address,
        c.created_at, c.updated_at
      FROM comments c
      INNER JOIN edge_comment_targets t ON t.id = c.target_id
      ORDER BY c.public_id
    `).all()).toEqual([
      {
        public_id: 501, target_type: 'post', parent_public_id: null,
        status: 'approved', imported: 1, author_kind: 'guest',
        author_email: '', ip_address: null, created_at: CREATED,
        updated_at: CREATED,
      },
      {
        public_id: 502, target_type: 'post', parent_public_id: 501,
        status: 'pending', imported: 1, author_kind: 'guest',
        author_email: '', ip_address: null, created_at: CREATED,
        updated_at: CREATED,
      },
      {
        public_id: 503, target_type: 'page', parent_public_id: null,
        status: 'approved', imported: 1, author_kind: 'guest',
        author_email: 'reader@example.com', ip_address: null,
        created_at: CREATED, updated_at: CREATED,
      },
    ]);
    const firstRevisions = database.prepare(`
      SELECT id, comments_cache_revision FROM edge_comment_targets ORDER BY id
    `).all();
    expect(firstRevisions).not.toEqual([
      { id: 1, comments_cache_revision: 'post-before' },
      { id: 2, comments_cache_revision: 'page-before' },
    ]);

    const repeated = await importWxrCommentChunk({
      edgeDb,
      request: { phase: 'comments', rows },
    });
    expect(repeated.summary).toMatchObject({
      created: 0, updated: 0, unchanged: 3, failed: 0,
    });
    expect(database.prepare(`
      SELECT id, comments_cache_revision FROM edge_comment_targets ORDER BY id
    `).all()).toEqual(firstRevisions);

    const changed = rows.map((row) => row.public_id === 501
      ? { ...row, content_text: 'Changed by repeated WXR import' }
      : row);
    const updated = await importWxrCommentChunk({
      edgeDb,
      request: { phase: 'comments', rows: changed },
    });
    expect(updated.summary).toMatchObject({ updated: 1, unchanged: 2 });
    const finalRevisions = database.prepare(`
      SELECT id, comments_cache_revision FROM edge_comment_targets ORDER BY id
    `).all() as Array<{ id: number; comments_cache_revision: string }>;
    expect(finalRevisions[0]?.comments_cache_revision)
      .not.toBe((firstRevisions[0] as { comments_cache_revision: string }).comments_cache_revision);
    expect(finalRevisions[1]).toEqual(firstRevisions[1]);
  });

  it('reports native IDs, missing targets, and unavailable parents per row', async () => {
    const { database, edgeDb } = createEdgeDatabase();
    database.exec(`
      INSERT INTO comments (
        id, public_id, target_id, parent_public_id, author_name, author_email,
        content, status, imported, created_at, updated_at, author_kind
      ) VALUES (
        'native', 600, 1, NULL, 'Native', 'native@example.com', 'Native',
        'approved', 0, '${CREATED}', '${CREATED}', 'guest'
      );
    `);
    const result = await importWxrCommentChunk({
      edgeDb,
      request: {
        phase: 'comments',
        rows: [
          comment({ public_id: 600 }),
          comment({ public_id: 601, target_public_id: 999 }),
          comment({ public_id: 602, parent_public_id: 999 }),
          comment({ public_id: 603 }),
        ],
      },
    });
    expect(result.summary).toMatchObject({
      processed: 4,
      created: 1,
      failed: 3,
      failures: [
        { row_index: 0, key: '600', code: 'COMMENT_PUBLIC_ID_CONFLICT' },
        { row_index: 1, key: '601', code: 'COMMENT_TARGET_NOT_FOUND' },
        { row_index: 2, key: '602', code: 'COMMENT_PARENT_NOT_FOUND' },
      ],
    });
    expect(database.prepare('SELECT public_id FROM comments ORDER BY public_id').all())
      .toEqual([{ public_id: 600 }, { public_id: 603 }]);
  });
});

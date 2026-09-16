import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { COMMENT_SETTINGS_DEFAULTS } from '../../../contracts/comment-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  clearEdgeCommentContent,
  EDGE_COMMENT_EFFECT_KEYS,
  resetEdgeCommentRuntime,
} from './edge-comment-lifecycle';

type SqliteRunResult = { changes: number | bigint };

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): SqliteD1Statement {
    return new SqliteD1Statement(this.database, this.sql, params);
  }

  async run(): Promise<D1Result<unknown>> {
    const result = (
      this.database.prepare(this.sql).run as (
        ...params: unknown[]
      ) => SqliteRunResult
    )(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = (
      this.database.prepare(this.sql).all as (
        ...params: unknown[]
      ) => T[]
    )(...this.params);
    return {
      success: true,
      results,
      meta: { changes: 0 },
    } as unknown as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    const row = (
      this.database.prepare(this.sql).get as (
        ...params: unknown[]
      ) => T | undefined
    )(...this.params);
    return row ?? null;
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results: D1Result<unknown>[] = [];
        for (const statement of statements) {
          results.push(
            /^\s*(?:SELECT|WITH)\b/iu.test(statement.sql)
              ? await statement.all()
              : await statement.run(),
          );
        }
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function createEdgeDatabase(options: { foreignKeys?: boolean } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ${options.foreignKeys === false ? 'OFF' : 'ON'};
    CREATE TABLE edge_comment_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      api_base_url TEXT,
      comments_enabled INTEGER NOT NULL DEFAULT 1,
      require_approval INTEGER NOT NULL DEFAULT 1,
      per_page INTEGER NOT NULL DEFAULT 50,
      sort_order TEXT NOT NULL DEFAULT 'desc',
      thread_comments INTEGER NOT NULL DEFAULT 1,
      thread_comments_depth INTEGER NOT NULL DEFAULT 2,
      request_secrets_json TEXT,
      auth_enabled INTEGER NOT NULL DEFAULT 0,
      supabase_project_url TEXT,
      supabase_publishable_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE edge_comment_targets (
      id INTEGER PRIMARY KEY,
      target_type TEXT NOT NULL,
      public_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      allow_comments INTEGER NOT NULL,
      request_token_nonce TEXT NOT NULL,
      comments_cache_revision TEXT NOT NULL,
      UNIQUE (target_type, public_id)
    );
    CREATE TABLE comments (
      id TEXT PRIMARY KEY,
      public_id INTEGER NOT NULL UNIQUE,
      target_id INTEGER NOT NULL
        REFERENCES edge_comment_targets(id) ON DELETE CASCADE,
      content TEXT NOT NULL
    );
    CREATE TABLE newsletter_lists (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE forms (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    INSERT INTO edge_comment_settings (
      id, api_base_url, comments_enabled, require_approval, per_page,
      sort_order, thread_comments, thread_comments_depth,
      request_secrets_json, auth_enabled, supabase_project_url,
      supabase_publishable_key, created_at, updated_at
    ) VALUES (
      1, 'https://edge.example.com/api', 0, 0, 25,
      'asc', 0, 4,
      '{"version":1,"active":{"kid":"secret-kid"}}', 1,
      'https://project.supabase.co',
      'sb_publishable_example-key-with-enough-length',
      '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z'
    );
    INSERT INTO edge_comment_targets (
      id, target_type, public_id, status, allow_comments,
      request_token_nonce, comments_cache_revision
    ) VALUES
      (1, 'post', 100, 'published', 1, 'post-nonce', 'post-revision'),
      (2, 'page', 100, 'published', 1, 'page-nonce', 'page-revision');
    INSERT INTO comments (id, public_id, target_id, content) VALUES
      ('comment-1', 1, 1, 'first'),
      ('comment-2', 2, 1, 'second'),
      ('comment-3', 3, 2, 'third');
    INSERT INTO newsletter_lists (id, name) VALUES (1, 'Newsletter');
    INSERT INTO forms (id, name) VALUES (1, 'Contact');
  `);
  return { database, edgeDb: d1(database) };
}

function row(
  database: DatabaseSync,
  sql: string,
): Record<string, unknown> {
  return database.prepare(sql).get() as Record<string, unknown>;
}

const NOW = new Date('2026-08-02T10:20:30.000Z');

describe('Maintenance Edge comment lifecycle', () => {
  it('clears every target and comment while preserving all runtime settings and unrelated Edge products', async () => {
    const { database, edgeDb } = createEdgeDatabase();
    const settingsBefore = row(
      database,
      'SELECT * FROM edge_comment_settings WHERE id = 1',
    );

    await expect(clearEdgeCommentContent({ edgeDb })).resolves.toEqual({
      deletedRows: {
        [EDGE_COMMENT_EFFECT_KEYS.comments]: 3,
        [EDGE_COMMENT_EFFECT_KEYS.targets]: 2,
      },
      insertedRows: {},
      updatedRows: {},
    });
    expect(row(database, `
      SELECT
        (SELECT COUNT(*) FROM comments) AS comments,
        (SELECT COUNT(*) FROM edge_comment_targets) AS targets,
        (SELECT COUNT(*) FROM newsletter_lists) AS newsletters,
        (SELECT COUNT(*) FROM forms) AS forms
    `)).toEqual({ comments: 0, targets: 0, newsletters: 1, forms: 1 });
    expect(row(
      database,
      'SELECT * FROM edge_comment_settings WHERE id = 1',
    )).toEqual(settingsBefore);

    await expect(clearEdgeCommentContent({ edgeDb })).resolves.toEqual({
      deletedRows: {
        [EDGE_COMMENT_EFFECT_KEYS.comments]: 0,
        [EDGE_COMMENT_EFFECT_KEYS.targets]: 0,
      },
      insertedRows: {},
      updatedRows: {},
    });
  });

  it('resets only presentation settings and preserves request secrets and optional authentication configuration', async () => {
    const { database, edgeDb } = createEdgeDatabase();

    await expect(resetEdgeCommentRuntime({ edgeDb, now: NOW }))
      .resolves.toEqual({
        deletedRows: {
          [EDGE_COMMENT_EFFECT_KEYS.comments]: 3,
          [EDGE_COMMENT_EFFECT_KEYS.targets]: 2,
        },
        insertedRows: {},
        updatedRows: { [EDGE_COMMENT_EFFECT_KEYS.settings]: 1 },
      });

    expect(row(database, `
      SELECT
        api_base_url, comments_enabled, require_approval, per_page,
        sort_order, thread_comments, thread_comments_depth,
        request_secrets_json, auth_enabled, supabase_project_url,
        supabase_publishable_key, created_at, updated_at
      FROM edge_comment_settings WHERE id = 1
    `)).toEqual({
      api_base_url: null,
      comments_enabled: COMMENT_SETTINGS_DEFAULTS.enabled ? 1 : 0,
      require_approval:
        COMMENT_SETTINGS_DEFAULTS.moderation.require_approval ? 1 : 0,
      per_page: COMMENT_SETTINGS_DEFAULTS.per_page,
      sort_order: COMMENT_SETTINGS_DEFAULTS.order,
      thread_comments: COMMENT_SETTINGS_DEFAULTS.threading.enabled ? 1 : 0,
      thread_comments_depth: COMMENT_SETTINGS_DEFAULTS.threading.max_depth,
      request_secrets_json:
        '{"version":1,"active":{"kid":"secret-kid"}}',
      auth_enabled: 1,
      supabase_project_url: 'https://project.supabase.co',
      supabase_publishable_key:
        'sb_publishable_example-key-with-enough-length',
      created_at: '2026-07-01T00:00:00Z',
      updated_at: '2026-08-02T10:20:30Z',
    });
    expect(row(database, `
      SELECT
        (SELECT COUNT(*) FROM newsletter_lists) AS newsletters,
        (SELECT COUNT(*) FROM forms) AS forms
    `)).toEqual({ newsletters: 1, forms: 1 });

    await expect(resetEdgeCommentRuntime({ edgeDb, now: NOW }))
      .resolves.toEqual({
        deletedRows: {
          [EDGE_COMMENT_EFFECT_KEYS.comments]: 0,
          [EDGE_COMMENT_EFFECT_KEYS.targets]: 0,
        },
        insertedRows: {},
        updatedRows: {},
      });
  });

  it('classifies a schema that fails to cascade comments as a verified Edge lifecycle failure', async () => {
    const { edgeDb } = createEdgeDatabase({ foreignKeys: false });

    const operation = clearEdgeCommentContent({ edgeDb });
    await expect(operation).rejects.toBeInstanceOf(StudioOperationalError);
    await expect(operation).rejects.toMatchObject({
      code: 'MAINTENANCE_EDGE_COMMENT_LIFECYCLE_FAILED',
      operationalMetadata: {
        resource: 'EDGE_DB',
        action: 'clear_edge_comment_content',
        phase: 'verification',
      },
    });
  });
});

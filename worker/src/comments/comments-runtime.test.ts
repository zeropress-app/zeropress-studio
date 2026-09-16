import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { COMMENT_SETTINGS_DEFAULTS } from '../../../contracts/comment-settings';
import {
  readCommentSettingsState,
  updateCommentSettings,
} from '../settings/comment-settings-repository';
import {
  readCommentRequestSecurity,
  resetStoredCommentRequestSecurity,
  rotateStoredCommentRequestSecurity,
} from './request-security-repository';
import { createCommentRequestTokens } from './request-token';
import { parseCommentRequestSecrets } from './request-secrets';
import {
  deleteCommentTarget,
  syncCommentTargets,
} from './target-projection';

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
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
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
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function createEdgeDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE edge_comment_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      api_base_url TEXT,
      comments_enabled INTEGER NOT NULL DEFAULT 1 CHECK (comments_enabled IN (0, 1)),
      require_approval INTEGER NOT NULL DEFAULT 1 CHECK (require_approval IN (0, 1)),
      per_page INTEGER NOT NULL DEFAULT 50 CHECK (per_page BETWEEN 1 AND 100),
      sort_order TEXT NOT NULL DEFAULT 'desc' CHECK (sort_order IN ('asc', 'desc')),
      thread_comments INTEGER NOT NULL DEFAULT 1 CHECK (thread_comments IN (0, 1)),
      thread_comments_depth INTEGER NOT NULL DEFAULT 2 CHECK (thread_comments_depth BETWEEN 2 AND 10),
      request_secrets_json TEXT,
      auth_enabled INTEGER NOT NULL DEFAULT 0 CHECK (auth_enabled IN (0, 1)),
      supabase_project_url TEXT,
      supabase_publishable_key TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE TABLE edge_comment_targets (
      id INTEGER PRIMARY KEY,
      target_type TEXT NOT NULL CHECK (target_type IN ('post', 'page')),
      public_id INTEGER NOT NULL CHECK (public_id > 0),
      status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'scheduled', 'archived', 'trash')),
      allow_comments INTEGER NOT NULL DEFAULT 0 CHECK (allow_comments IN (0, 1)),
      request_token_nonce TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      comments_cache_revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      UNIQUE (target_type, public_id)
    );
  `);
  return { database, edgeDb: d1(database) };
}

function createStudioDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE posts (
      public_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      allow_comments INTEGER NOT NULL
    );
    CREATE TABLE pages (
      public_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      allow_comments INTEGER NOT NULL
    );
  `);
  return { database, studioDb: d1(database) };
}

const NOW = new Date('2026-08-02T00:00:00.000Z');

describe('ZeroPress comment runtime storage', () => {
  it('materializes moderation, initializes request secrets, and updates public Edge authentication settings', async () => {
    const { database, edgeDb } = createEdgeDatabase();
    database.prepare(`
      INSERT INTO edge_comment_settings (
        id, require_approval, auth_enabled,
        supabase_project_url, supabase_publishable_key
      ) VALUES (1, 0, 1, ?, ?)
    `).run(
      'https://project.supabase.co',
      'sb_publishable_example-key-with-enough-length',
    );

    const initial = await readCommentSettingsState({ edgeDb });
    expect(initial.document.settings).toEqual({
      ...COMMENT_SETTINGS_DEFAULTS,
      moderation: { require_approval: false },
      auth: {
        enabled: true,
        provider: 'supabase',
        project_url: 'https://project.supabase.co',
        publishable_key:
          'sb_publishable_example-key-with-enough-length',
      },
    });
    expect(initial.requestSecretsJson).toBeNull();

    const settings = {
      ...initial.document.settings,
      api_base_url: 'https://edge.example.com/api',
      per_page: 25,
      threading: { enabled: true, max_depth: 4 },
      moderation: { require_approval: true },
      auth: { ...initial.document.settings.auth, enabled: false },
    };
    const result = await updateCommentSettings({
      edgeDb,
      settings,
      expectedRevision: initial.document.revision,
      now: NOW,
    });
    expect(result.kind).toBe('completed');

    const stored = database.prepare(`
      SELECT require_approval, auth_enabled, supabase_project_url,
             supabase_publishable_key, request_secrets_json
      FROM edge_comment_settings WHERE id = 1
    `).get() as Record<string, unknown>;
    expect(stored).toMatchObject({
      require_approval: 1,
      auth_enabled: 0,
      supabase_project_url: 'https://project.supabase.co',
      supabase_publishable_key:
        'sb_publishable_example-key-with-enough-length',
    });
    expect(parseCommentRequestSecrets(String(stored.request_secrets_json)))
      .toMatchObject({ version: 1, previous: [] });

    await expect(updateCommentSettings({
      edgeDb,
      settings: { ...settings, enabled: false },
      expectedRevision: initial.document.revision,
      now: NOW,
    })).resolves.toEqual({ kind: 'revision_conflict' });
  });

  it('initializes, rotates with a 14-day recovery window, and rejects stale lifecycle revisions', async () => {
    const { database, edgeDb } = createEdgeDatabase();
    const missing = await readCommentRequestSecurity({ edgeDb, now: NOW });
    expect(missing).toMatchObject({
      status: 'missing',
      current_key: null,
      previous_keys: { total_count: 0, active_count: 0 },
    });

    const initialized = await resetStoredCommentRequestSecurity({
      edgeDb,
      expectedRevision: missing.revision,
      now: NOW,
    });
    expect(initialized.kind).toBe('completed');
    if (initialized.kind !== 'completed') throw new Error('Expected reset');
    const initialKid = initialized.resource.current_key?.kid;
    expect(initialKid).toMatch(/^k_[A-Za-z0-9_-]{22}$/u);
    expect(JSON.stringify(initialized.resource)).not.toContain('secret');

    const rotated = await rotateStoredCommentRequestSecurity({
      edgeDb,
      expectedRevision: initialized.resource.revision,
      now: NOW,
    });
    expect(rotated.kind).toBe('completed');
    if (rotated.kind !== 'completed') throw new Error('Expected rotation');
    expect(rotated.resource).toMatchObject({
      status: 'valid',
      previous_keys: { total_count: 1, active_count: 1 },
    });
    expect(rotated.resource.current_key?.kid).not.toBe(initialKid);
    const stored = parseCommentRequestSecrets(String(database.prepare(`
      SELECT request_secrets_json
      FROM edge_comment_settings
      WHERE id = 1
    `).get()?.request_secrets_json));
    expect(stored.previous[0]).toMatchObject({
      kid: initialKid,
      expires_at: '2026-08-16T00:00:00Z',
    });

    const rotatedAfterWindow = await rotateStoredCommentRequestSecurity({
      edgeDb,
      expectedRevision: rotated.resource.revision,
      now: new Date('2026-08-17T00:00:00Z'),
    });
    expect(rotatedAfterWindow.kind).toBe('completed');
    if (rotatedAfterWindow.kind !== 'completed') {
      throw new Error('Expected rotation after the overlap window');
    }
    expect(rotatedAfterWindow.resource.previous_keys).toEqual({
      total_count: 1,
      active_count: 1,
    });
    const pruned = parseCommentRequestSecrets(String(database.prepare(`
      SELECT request_secrets_json
      FROM edge_comment_settings
      WHERE id = 1
    `).get()?.request_secrets_json));
    expect(pruned.previous.map((entry) => entry.kid)).not.toContain(initialKid);

    await expect(resetStoredCommentRequestSecurity({
      edgeDb,
      expectedRevision: missing.revision,
      now: NOW,
    })).resolves.toEqual({ kind: 'revision_conflict' });
  });

  it('reports malformed keysets without blocking settings and recovers them only through reset', async () => {
    const { database, edgeDb } = createEdgeDatabase();
    database.prepare(`
      INSERT INTO edge_comment_settings (id, request_secrets_json)
      VALUES (1, ?)
    `).run('{malformed');

    const settings = await readCommentSettingsState({ edgeDb });
    expect(settings.requestSecretsJson).toBe('{malformed');
    const invalid = await readCommentRequestSecurity({ edgeDb, now: NOW });
    expect(invalid).toMatchObject({
      status: 'invalid',
      current_key: null,
      previous_keys: { total_count: 0, active_count: 0 },
    });
    await expect(rotateStoredCommentRequestSecurity({
      edgeDb,
      expectedRevision: invalid.revision,
      now: NOW,
    })).resolves.toEqual({ kind: 'not_rotatable' });

    const recovered = await resetStoredCommentRequestSecurity({
      edgeDb,
      expectedRevision: invalid.revision,
      now: NOW,
    });
    expect(recovered.kind).toBe('completed');
    if (recovered.kind !== 'completed') throw new Error('Expected recovery');
    expect(recovered.resource.status).toBe('valid');
    expect(recovered.resource.previous_keys.total_count).toBe(0);
  });

  it('keeps Post and Page targets isolated and preserves their token nonces across sync', async () => {
    const { database: edgeSql, edgeDb } = createEdgeDatabase();
    const { database: studioSql } = createStudioDatabase();
    const publicId = 100_000_000_001;
    studioSql.prepare(
      'INSERT INTO posts (public_id, status, allow_comments) VALUES (?, ?, ?)',
    ).run(publicId, 'published', 1);
    studioSql.prepare(
      'INSERT INTO pages (public_id, status, allow_comments) VALUES (?, ?, ?)',
    ).run(publicId, 'draft', 1);

    await expect(syncCommentTargets({
      edgeDb,
      targets: [
        {
          targetType: 'post', publicId, status: 'published',
          allowComments: true,
        },
        {
          targetType: 'page', publicId, status: 'draft',
          allowComments: true,
        },
      ],
    })).resolves.toBe(2);
    const before = edgeSql.prepare(`
      SELECT target_type, request_token_nonce
      FROM edge_comment_targets ORDER BY target_type
    `).all() as Array<{ target_type: string; request_token_nonce: string }>;
    expect(before).toHaveLength(2);
    expect(before[0]?.request_token_nonce)
      .not.toBe(before[1]?.request_token_nonce);

    studioSql.prepare(
      "UPDATE posts SET status = 'draft', allow_comments = 0",
    ).run();
    await syncCommentTargets({
      edgeDb,
      targets: [{
        targetType: 'post', publicId, status: 'draft', allowComments: false,
      }],
    });
    const after = edgeSql.prepare(`
      SELECT target_type, status, allow_comments, request_token_nonce
      FROM edge_comment_targets ORDER BY target_type
    `).all() as Array<Record<string, unknown>>;
    expect(after.map((row) => row.request_token_nonce))
      .toEqual(before.map((row) => row.request_token_nonce));
    expect(after.find((row) => row.target_type === 'post')).toMatchObject({
      status: 'draft',
      allow_comments: 0,
    });

    await expect(createCommentRequestTokens({
      edgeDb,
      targets: [{ targetType: 'page', publicId }],
    })).rejects.toMatchObject({
      code: 'COMMENT_REQUEST_SECRETS_NOT_CONFIGURED',
    });
    const state = await readCommentSettingsState({ edgeDb });
    await updateCommentSettings({
      edgeDb,
      settings: {
        ...state.document.settings,
        api_base_url: 'https://edge.example.com/api',
      },
      expectedRevision: state.document.revision,
      now: NOW,
    });
    const tokens = await createCommentRequestTokens({
      edgeDb,
      targets: [
        { targetType: 'post', publicId },
        { targetType: 'page', publicId },
      ],
    });
    expect(tokens.get(`post:${publicId}`)).toMatch(/^k_[\w-]{22}\.[\w-]+$/u);
    expect(tokens.get(`page:${publicId}`)).toMatch(/^k_[\w-]{22}\.[\w-]+$/u);
    expect(tokens.get(`post:${publicId}`)).not.toBe(tokens.get(`page:${publicId}`));
    const settingsRow = edgeSql.prepare(`
      SELECT request_secrets_json FROM edge_comment_settings WHERE id = 1
    `).get() as { request_secrets_json: string };
    const keyset = parseCommentRequestSecrets(
      settingsRow.request_secrets_json,
    );
    const signingKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(keyset.current.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const postNonce = before.find(
      (row) => row.target_type === 'post',
    )?.request_token_nonce;
    const expectedSignature = await crypto.subtle.sign(
      'HMAC',
      signingKey,
      new TextEncoder().encode(
        `v2:comments:post:${publicId}:${postNonce}`,
      ),
    );
    expect(tokens.get(`post:${publicId}`)).toBe(
      `${keyset.current.kid}.${Buffer.from(expectedSignature).toString('base64url')}`,
    );

    await deleteCommentTarget({ edgeDb, targetType: 'post', publicId });
    expect(edgeSql.prepare(`
      SELECT target_type FROM edge_comment_targets ORDER BY target_type
    `).all()).toEqual([{ target_type: 'page' }]);
    await expect(createCommentRequestTokens({
      edgeDb,
      targets: [{ targetType: 'post', publicId }],
    })).rejects.toMatchObject({
      code: 'COMMENT_TARGET_NOT_PROJECTED',
    });
  });
});

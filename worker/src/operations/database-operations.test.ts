import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLEAR_SITE_CONTENT_TABLES,
  clearSiteContent,
  getUninstallStatements,
  getUninstallTableNames,
  inspectUninstallStudio,
  RESET_STUDIO_ADDITIONAL_TABLES,
  resetStudio,
  uninstallStudioDatabase,
} from './database-operations';
import { sqliteD1 } from '../test-helpers/sqlite-d1';

type CapturedStatement = {
  sql: string;
  params: unknown[];
};

function normalizedSql(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function resetCapturingDatabase() {
  const batches: CapturedStatement[][] = [];
  const prepared: CapturedStatement[] = [];
  const db = {
    prepare(sql: string) {
      const statement: CapturedStatement & {
        bind(...params: unknown[]): CapturedStatement & {
          first?<T>(): Promise<T>;
        };
        all?<T>(): Promise<D1Result<T>>;
        first?<T>(): Promise<T>;
      } = {
        sql: normalizedSql(sql),
        params: [],
        bind(...params: unknown[]) {
          return {
            sql: statement.sql,
            params,
            async first<T>() {
              return {
                user_count: 1,
                preserved_user_count: 1,
                administrator_role_count: 1,
                system_role_count: 3,
                default_setting_count: 1,
              } as T;
            },
          };
        },
        async all<T>() {
          return {
            success: true,
            results: [
              { name: 'menus' },
              { name: 'authors' },
              { name: 'categories' },
              { name: 'tags' },
              { name: 'content_public_id_counters' },
              { name: 'posts' },
              { name: 'pages' },
              { name: 'post_categories' },
              { name: 'post_tags' },
              { name: 'sessions' },
              { name: 'user_setup_tokens' },
              { name: 'webauthn_discovery_challenges' },
              { name: 'webauthn_challenges' },
              { name: 'site_settings' },
              { name: 'roles' },
              { name: 'user_roles' },
              { name: 'users' },
              { name: 'widget_areas' },
              { name: 'site_custom_code' },
              { name: 'edge_comment_target_projection_outbox' },
              { name: 'zeropress_schema_state' },
            ],
            meta: {},
          } as unknown as D1Result<T>;
        },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements: CapturedStatement[]) {
      batches.push(statements);
      if (
        statements.every((statement) => (
          statement.sql.startsWith('SELECT COUNT(*) AS row_count')
        ))
      ) {
        return statements.map(() => ({
          success: true,
          results: [{ row_count: 0 }],
          meta: { changes: 0 },
        }));
      }
      return statements.map((statement) => (
        statement.sql === 'SELECT changes() AS direct_changes'
          ? {
              success: true,
              results: [{ direct_changes: 1 }],
              meta: { changes: 0 },
            }
          : {
              success: true,
              results: [],
              // Model the real D1 behavior where trigger and FTS shadow-table
              // writes make meta.changes unsuitable for direct row reporting.
              meta: { changes: 9_999 },
            }
      ));
    },
  } as unknown as D1Database;

  return { db, batches, prepared };
}

function uninstallCapturingDatabase(extraTable?: string) {
  let tables = [
    ...getUninstallTableNames(),
    ...(extraTable ? [extraTable] : []),
  ];
  const batches: CapturedStatement[][] = [];
  const db = {
    prepare(sql: string) {
      const statement: CapturedStatement & {
        all?<T>(): Promise<D1Result<T>>;
      } = {
        sql: normalizedSql(sql),
        params: [],
      };
      if (statement.sql.includes('FROM sqlite_schema')) {
        statement.all = async <T>() => ({
          success: true,
          results: tables.map((name) => ({ name })),
          meta: {},
        }) as unknown as D1Result<T>;
      }
      return statement;
    },
    async batch(statements: CapturedStatement[]) {
      batches.push(statements);
      if (statements.every((statement) => statement.sql.startsWith('DROP TABLE'))) {
        tables = [];
        return statements.map(() => ({
          success: true,
          results: [],
          meta: { changes: 0 },
        }));
      }
      return statements.map(() => ({
        success: true,
        results: [{ row_count: 1 }],
        meta: { changes: 0 },
      }));
    },
  } as unknown as D1Database;
  return { db, batches };
}

function hierarchicalContentDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(
    new URL('../../../database/install/001_baseline.sql', import.meta.url),
    'utf8',
  ));
  sqlite.exec(`INSERT INTO audit_logs (id, occurred_at, action, category, outcome, actor_kind, actor_id, actor_name, actor_email, target_type, metadata_json)
    VALUES ('audit-snapshot', '2026-07-29T12:00:00.000Z', 'account_delete', 'account', 'success', 'user', 'deleted-user', 'Former owner', 'former@example.test', 'user', '{}')`);
  sqlite.prepare('INSERT INTO auth_rate_limits VALUES (?, ?, ?, ?)')
    .run('login_account', 'a'.repeat(64), 3, 2_000_000_000);
  const administratorId = '0123456789abcdef0123456789abcdef';
  sqlite.prepare(`
    INSERT INTO users (
      id, email, password_hash, name, status, email_verified,
      created_at_iso, updated_at_iso
    ) VALUES (?, 'owner@example.com', 'password-hash', 'Owner', 'active', 1,
      '2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z')
  `).run(administratorId);
  sqlite.exec(`
    INSERT INTO pages (
      id, public_id, parent_id, title, slug, content, document_type,
      excerpt, status, discoverability, allow_comments,
      created_at_iso, updated_at_iso
    ) VALUES
      (
        '11111111111111111111111111111111', 1, NULL,
        'Root', 'root', '', 'html', '', 'published', 'default', 0,
        '2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z'
      ),
      (
        '22222222222222222222222222222222', 2,
        '11111111111111111111111111111111',
        'Child', 'child', '', 'html', '', 'published', 'default', 0,
        '2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z'
      );
    INSERT INTO media_collections (
      id, name, created_at_iso, updated_at_iso
    ) VALUES
      (
        '33333333333333333333333333333333', 'First collection',
        '2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z'
      ),
      (
        '44444444444444444444444444444444', 'Second collection',
        '2026-07-30T12:00:00.000Z', '2026-07-30T12:00:00.000Z'
      );
    INSERT INTO page_search_fts (
      rowid, revision, title, slug, excerpt, body
    ) VALUES
      (1, '${'a'.repeat(32)}', 'Root', 'root', '', 'Root body'),
      (2, '${'b'.repeat(32)}', 'Child', 'child', '', 'Child body');
    INSERT INTO content_search_index_state (
      id, state, reason, phase, operation_id,
      post_public_id_cursor, page_public_id_cursor,
      processed_posts, processed_pages, total_posts, total_pages,
      started_at_iso, initiated_by_user_id, initiated_by_user_email,
      updated_at_iso
    ) VALUES (
      1, 'rebuild_required', 'schema_upgrade', NULL, NULL,
      0, 0, 0, 0, 0, 2, NULL, NULL, NULL,
      '2026-07-30T12:00:00.000Z'
    );
  `);
  return { administratorId, db: sqliteD1(sqlite), sqlite };
}

describe('Maintenance database operations', () => {
  it('keeps the clear-content catalog explicit and excludes widget state', () => {
    expect(CLEAR_SITE_CONTENT_TABLES).toEqual(expect.arrayContaining([
      'menus',
      'media',
      'media_collections',
      'media_upload_intents',
      'posts',
      'pages',
      'authors',
      'tags',
      'categories',
    ]));
    expect(CLEAR_SITE_CONTENT_TABLES).not.toContain('comments');
    expect(CLEAR_SITE_CONTENT_TABLES).not.toContain('widget_areas');
    expect(CLEAR_SITE_CONTENT_TABLES).not.toContain('site_settings');
    expect(CLEAR_SITE_CONTENT_TABLES).not.toContain('studio_settings');
    expect(CLEAR_SITE_CONTENT_TABLES).not.toContain('site_custom_code');
    expect(CLEAR_SITE_CONTENT_TABLES).not.toContain('users');
    expect(CLEAR_SITE_CONTENT_TABLES).not.toContain('content_public_id_counters');
    expect(CLEAR_SITE_CONTENT_TABLES).not.toContain('media_object_deletions');
    expect(CLEAR_SITE_CONTENT_TABLES)
      .toContain('edge_comment_target_projection_outbox');
    expect(RESET_STUDIO_ADDITIONAL_TABLES).toContain('widget_areas');
    expect(RESET_STUDIO_ADDITIONAL_TABLES).toContain('site_custom_code');
  });

  it('reports direct Clear Content changes and hides the internal projection outbox', async () => {
    const capture = resetCapturingDatabase();
    const administratorId = '0123456789abcdef0123456789abcdef';

    const result = await clearSiteContent({
      db: capture.db,
      administratorId,
      now: new Date('2026-07-30T12:00:00.000Z'),
    });

    expect(result.deletedRows).toMatchObject({
      posts: 1,
      pages: 1,
      authors: 1,
      menus: 1,
    });
    expect(result.deletedRows)
      .not.toHaveProperty('edge_comment_target_projection_outbox');
    expect(capture.batches[0].map((statement) => statement.sql))
      .toContain('DELETE FROM "edge_comment_target_projection_outbox"');
    expect(capture.batches[0].filter((statement) => (
      statement.sql === 'SELECT changes() AS direct_changes'
    ))).not.toHaveLength(0);
  });

  it('keeps the reviewed uninstall artifact synchronized with the baseline', () => {
    const baseline = readFileSync(
      new URL('../../../database/install/001_baseline.sql', import.meta.url),
      'utf8',
    );
    const baselineTables = [
      ...baseline.matchAll(
        /^CREATE (?:VIRTUAL )?TABLE "?([a-z][a-z0-9_]*)"?/gmu,
      ),
    ].map((match) => match[1]).sort();
    const uninstallTables = getUninstallTableNames();

    expect([...uninstallTables].sort()).toEqual(baselineTables);
    expect(uninstallTables.at(-1)).toBe('zeropress_schema_state');
    expect(getUninstallStatements()).toHaveLength(baselineTables.length);
  });

  it('keeps WebAuthn credentials and one-time challenges in the baseline lifecycle', () => {
    const baseline = readFileSync(
      new URL('../../../database/install/001_baseline.sql', import.meta.url),
      'utf8',
    );
    const uninstall = getUninstallStatements();

    expect(baseline).toContain(
      'CREATE TABLE user_webauthn_credentials',
    );
    expect(baseline).toContain('CREATE TABLE authors');
    expect(baseline).toContain('CREATE TABLE categories');
    expect(baseline).toContain('CREATE TABLE tags');
    expect(baseline).toContain('CREATE TABLE content_public_id_counters');
    expect(baseline).toContain('CREATE TABLE media');
    expect(baseline).toContain('CREATE TABLE posts');
    expect(baseline).toContain('CREATE TABLE pages');
    expect(baseline).toContain('CREATE TABLE widget_areas');
    expect(baseline).toContain('CREATE TABLE site_custom_code');
    expect(baseline).toContain('CREATE TABLE post_categories');
    expect(baseline).toContain('CREATE TABLE post_tags');
    expect(baseline).toContain('public_id INTEGER NOT NULL UNIQUE');
    expect(baseline).toContain('REFERENCES authors(id) ON DELETE RESTRICT');
    expect(baseline).toContain('REFERENCES categories(id) ON DELETE RESTRICT');
    expect(baseline).toContain('REFERENCES tags(id) ON DELETE RESTRICT');
    expect(baseline).toContain('sort_order INTEGER NOT NULL');
    expect(baseline).toContain("id NOT GLOB '*[^A-Za-z0-9_-]*'");
    expect(baseline).toContain('REFERENCES users(id) ON DELETE SET NULL');
    expect(baseline).toContain('attestation_format TEXT NOT NULL');
    expect(baseline).toContain('AND length(aaguid) = 32');
    expect(baseline).toContain("aaguid NOT GLOB '*[^0-9a-f]*'");
    expect(baseline).not.toContain("replace(aaguid, '-', '')");
    expect(baseline).toContain(
      "aaguid != '00000000000000000000000000000000'",
    );
    expect(baseline).toContain('CREATE TABLE webauthn_challenges');
    expect(baseline).toContain(
      'CREATE TABLE webauthn_discovery_challenges',
    );
    expect(baseline).toContain(
      "purpose IN (\n        'login',\n        'management_step_up',\n        'registration'",
    );
    expect(baseline).toContain(
      'CREATE INDEX idx_webauthn_challenges_expires',
    );
    expect(baseline).toContain(
      'CREATE INDEX idx_webauthn_discovery_challenges_expires',
    );
    expect(uninstall.indexOf('DROP TABLE webauthn_discovery_challenges'))
      .toBeLessThan(uninstall.indexOf('DROP TABLE webauthn_challenges'));
    expect(uninstall.indexOf('DROP TABLE webauthn_challenges'))
      .toBeLessThan(uninstall.indexOf('DROP TABLE sessions'));
    expect(uninstall.indexOf('DROP TABLE user_webauthn_credentials'))
      .toBeLessThan(uninstall.indexOf('DROP TABLE users'));
    expect(uninstall.indexOf('DROP TABLE authors'))
      .toBeLessThan(uninstall.indexOf('DROP TABLE users'));
    expect(uninstall).toContain('DROP TABLE categories');
    expect(uninstall).toContain('DROP TABLE tags');
    expect(uninstall.indexOf('DROP TABLE post_tags'))
      .toBeLessThan(uninstall.indexOf('DROP TABLE posts'));
    expect(uninstall.indexOf('DROP TABLE post_categories'))
      .toBeLessThan(uninstall.indexOf('DROP TABLE posts'));
    expect(uninstall.indexOf('DROP TABLE posts'))
      .toBeLessThan(uninstall.indexOf('DROP TABLE authors'));
    expect(uninstall).toContain('DROP TABLE pages');
    expect(uninstall.indexOf('DROP TABLE posts'))
      .toBeLessThan(uninstall.indexOf('DROP TABLE media'));
    expect(uninstall.indexOf('DROP TABLE pages'))
      .toBeLessThan(uninstall.indexOf('DROP TABLE media'));
    expect(uninstall.indexOf('DROP TABLE authors'))
      .toBeLessThan(uninstall.indexOf('DROP TABLE media'));
    expect(uninstall.indexOf('DROP TABLE media'))
      .toBeLessThan(uninstall.indexOf('DROP TABLE media_collections'));
  });

  it('resets content and identity state while preserving the selected administrator', async () => {
    const capture = resetCapturingDatabase();
    const administratorId = '0123456789abcdef0123456789abcdef';

    await expect(resetStudio({
      db: capture.db,
      administratorId,
      now: new Date('2026-07-30T12:00:00.000Z'),
    })).resolves.toEqual({
      deletedRows: {
        menus: 1,
        authors: 1,
        categories: 1,
        tags: 1,
        post_tags: 1,
        post_categories: 1,
        posts: 1,
        pages: 1,
        widget_areas: 1,
        site_custom_code: 1,
        webauthn_discovery_challenges: 1,
        webauthn_challenges: 1,
        sessions: 1,
        user_setup_tokens: 1,
        site_settings: 1,
        user_roles: 1,
        roles: 1,
        users: 1,
      },
      insertedRows: {
        roles: 1,
        user_roles: 1,
      },
      updatedRows: {
        users: 1,
      },
    });

    const resetBatch = capture.batches[0].map((statement) => statement.sql);
    expect(resetBatch[0]).toBe('PRAGMA defer_foreign_keys = TRUE');
    expect(resetBatch).toContain('DELETE FROM "menus"');
    expect(resetBatch).toContain('DELETE FROM "authors"');
    expect(resetBatch).toContain('DELETE FROM "categories"');
    expect(resetBatch).toContain('DELETE FROM "tags"');
    expect(resetBatch).toContain('DELETE FROM "post_tags"');
    expect(resetBatch).toContain('DELETE FROM "post_categories"');
    expect(resetBatch).toContain('DELETE FROM "posts"');
    expect(resetBatch).toContain('DELETE FROM "pages"');
    expect(resetBatch).not.toContain('DELETE FROM "content_public_id_counters"');
    expect(resetBatch).toContain('DELETE FROM "widget_areas"');
    expect(resetBatch).toContain('DELETE FROM "site_custom_code"');
    expect(resetBatch)
      .toContain('DELETE FROM "edge_comment_target_projection_outbox"');
    expect(resetBatch).toContain('DELETE FROM sessions');
    expect(resetBatch).toContain('DELETE FROM webauthn_discovery_challenges');
    expect(resetBatch).toContain('DELETE FROM webauthn_challenges');
    expect(resetBatch).toContain('DELETE FROM user_setup_tokens');
    expect(resetBatch).toContain('DELETE FROM site_settings');
    expect(resetBatch).not.toContain('DELETE FROM studio_settings');
    expect(resetBatch).toContain('DELETE FROM user_roles');
    expect(resetBatch).toContain('DELETE FROM roles');
    expect(resetBatch).toContain('DELETE FROM users WHERE id != ?');
    expect(capture.batches[0].find((statement) => (
      statement.sql === 'DELETE FROM users WHERE id != ?'
    ))?.params).toEqual([administratorId]);
    expect(resetBatch.some((sql) => sql.includes('INSERT INTO roles'))).toBe(true);
    expect(resetBatch.some((sql) => sql.includes('INSERT INTO user_roles'))).toBe(true);
    expect(resetBatch.some((sql) => sql.includes('INSERT INTO site_settings'))).toBe(false);
    expect(capture.batches[0].filter((statement) => (
      statement.sql === 'SELECT changes() AS direct_changes'
    ))).not.toHaveLength(0);
  });

  it('clears and resets self-referencing Page and Media Collection trees', async () => {
    const clearFixture = hierarchicalContentDatabase();
    await expect(clearSiteContent({
      db: clearFixture.db,
      administratorId: clearFixture.administratorId,
      now: new Date('2026-07-30T12:00:00.000Z'),
    })).resolves.toEqual(expect.objectContaining({
      deletedRows: expect.objectContaining({
        pages: 2,
        media_collections: 2,
      }),
    }));
    expect(clearFixture.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM pages',
    ).get()).toEqual({ count: 0 });
    expect(clearFixture.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM media_collections',
    ).get()).toEqual({ count: 0 });
    expect(clearFixture.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM page_search_fts',
    ).get()).toEqual({ count: 0 });
    expect(clearFixture.sqlite.prepare(`
      SELECT state, reason, total_posts, total_pages
      FROM content_search_index_state WHERE id = 1
    `).get()).toEqual({
      state: 'ready', reason: null, total_posts: 0, total_pages: 0,
    });
    expect(clearFixture.sqlite.prepare('PRAGMA foreign_key_check').all())
      .toEqual([]);
    expect(clearFixture.sqlite.prepare('SELECT count(*) AS n FROM auth_rate_limits').get()?.n).toBe(1);
    expect(clearFixture.sqlite.prepare('SELECT actor_name FROM audit_logs').get()).toEqual({ actor_name: 'Former owner' });
    clearFixture.sqlite.close();

    const resetFixture = hierarchicalContentDatabase();
    await expect(resetStudio({
      db: resetFixture.db,
      administratorId: resetFixture.administratorId,
      now: new Date('2026-07-30T12:00:00.000Z'),
    })).resolves.toEqual(expect.objectContaining({
      deletedRows: expect.objectContaining({
        pages: 2,
        media_collections: 2,
      }),
    }));
    expect(resetFixture.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM pages',
    ).get()).toEqual({ count: 0 });
    expect(resetFixture.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM media_collections',
    ).get()).toEqual({ count: 0 });
    expect(resetFixture.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM page_search_fts',
    ).get()).toEqual({ count: 0 });
    expect(resetFixture.sqlite.prepare(`
      SELECT state, reason, total_posts, total_pages
      FROM content_search_index_state WHERE id = 1
    `).get()).toEqual({
      state: 'ready', reason: null, total_posts: 0, total_pages: 0,
    });
    expect(resetFixture.sqlite.prepare('PRAGMA foreign_key_check').all())
      .toEqual([]);
    expect(resetFixture.sqlite.prepare('SELECT count(*) AS n FROM auth_rate_limits').get()?.n).toBe(0);
    expect(resetFixture.sqlite.prepare('SELECT actor_name FROM audit_logs').get()).toEqual({ actor_name: 'Former owner' });
    resetFixture.sqlite.close();
  });

  it.each(['ordinary_shadow', 'unknown_suffix'] as const)(
    'refuses an unreviewed FTS-like table: %s', async (kind) => {
      const fixture = hierarchicalContentDatabase();
      try {
        if (kind === 'ordinary_shadow') {
          fixture.sqlite.exec(`
            DROP TABLE post_search_fts;
            CREATE TABLE post_search_fts (id INTEGER PRIMARY KEY);
            CREATE TABLE post_search_fts_data (id INTEGER PRIMARY KEY);
          `);
        } else {
          fixture.sqlite.exec('CREATE TABLE post_search_fts_extra (id INTEGER PRIMARY KEY)');
        }
        await expect(inspectUninstallStudio(fixture.db))
          .rejects.toThrow('table set does not match');
      } finally {
        fixture.sqlite.close();
      }
    },
  );

  it('uninstalls only an exact reviewed table set and verifies the empty schema', async () => {
    const capture = uninstallCapturingDatabase();

    await expect(uninstallStudioDatabase(capture.db)).resolves.toEqual({
      deletedRows: Object.fromEntries(
        getUninstallTableNames()
          .filter((table) => (
            table !== 'edge_comment_target_projection_outbox'
            && table !== 'auth_rate_limits'
          ))
          .map((table) => [table, 1]),
      ),
      insertedRows: {},
      updatedRows: {},
    });
    expect(capture.batches).toHaveLength(2);
    expect(capture.batches[1].map((statement) => statement.sql)).toEqual(
      getUninstallStatements(),
    );
  });

  it('inspects the exact uninstall table set without dropping it', async () => {
    const capture = uninstallCapturingDatabase();

    await expect(inspectUninstallStudio(capture.db)).resolves.toEqual({
      deletedRows: Object.fromEntries(
        getUninstallTableNames()
          .filter((table) => (
            table !== 'edge_comment_target_projection_outbox'
            && table !== 'auth_rate_limits'
          ))
          .map((table) => [table, 1]),
      ),
    });
    expect(capture.batches).toHaveLength(1);
    expect(capture.batches[0].every((statement) =>
      statement.sql.startsWith('SELECT COUNT(*) AS row_count')
    )).toBe(true);
  });

  it('refuses to uninstall an unreviewed application table', async () => {
    const capture = uninstallCapturingDatabase('unexpected_table');

    await expect(uninstallStudioDatabase(capture.db)).rejects.toThrow(
      'does not match the reviewed uninstall artifact',
    );
    expect(capture.batches).toHaveLength(0);
  });
});

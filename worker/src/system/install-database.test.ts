import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  getInstallBaselineStatements,
  installStudioDatabase,
} from './install-database';
import { STUDIO_SCHEMA_VERSION } from './schema-version';
import { sqliteD1 } from '../test-helpers/sqlite-d1';
import { uninstallStudioDatabase } from '../operations/database-operations';
import { consumeLoginRateLimits } from '../auth/login-rate-limit';

type CapturedStatement = {
  sql: string;
  params: unknown[];
};

function createCapturingDatabase() {
  const batchCalls: CapturedStatement[][] = [];
  const database = {
    prepare(sql: string) {
      const statement: CapturedStatement & {
        bind(...params: unknown[]): CapturedStatement;
      } = {
        sql,
        params: [],
        bind(...params: unknown[]) {
          return { sql, params };
        },
      };
      return statement;
    },
    async batch(statements: CapturedStatement[]) {
      batchCalls.push(statements);
      return [];
    },
  } as unknown as D1Database;

  return { database, batchCalls };
}

describe('Studio database installer', () => {
  it('loads the reviewed current-feature baseline as individual statements', () => {
    const statements = getInstallBaselineStatements();
    const sql = statements.join('\n');

    expect(statements.length).toBeGreaterThan(5);
    expect(sql).toContain('CREATE TABLE zeropress_schema_state');
    expect(sql).toContain('CREATE TABLE auth_rate_limits');
    expect(sql).toContain('idx_auth_rate_limits_reset_at');
    expect(sql).toContain('CREATE TABLE users');
    expect(sql).toContain('CREATE TABLE authors');
    expect(sql).toContain('CREATE TABLE categories');
    expect(sql).toContain('CREATE TABLE tags');
    expect(sql).toContain('CREATE TABLE content_public_id_counters');
    expect(sql).toContain('CREATE TABLE media');
    expect(sql).toContain('CREATE TABLE site_assets');
    expect(sql).toContain('CREATE TABLE posts');
    expect(sql).toContain('CREATE TABLE pages');
    expect(sql).toContain('CREATE TRIGGER trg_posts_featured_image_insert');
    const trigger = statements.find((statement) => (
      statement.startsWith('CREATE TRIGGER trg_posts_featured_image_insert')
    ));
    expect(trigger).toContain("RAISE(ABORT, 'featured image must reference dimensioned image media') END;");
    expect(trigger).toMatch(/END$/u);
    expect(sql).toContain('CREATE TABLE post_categories');
    expect(sql).toContain('CREATE TABLE post_tags');
    expect(sql).toContain('CREATE TABLE user_mfa_factors');
    expect(sql).toContain('CREATE TABLE roles');
    expect(sql).toContain('CREATE TABLE user_roles');
    expect(sql).toContain('CREATE TABLE user_setup_tokens');
    expect(sql).toContain("'credential_recovery'");
    expect(sql).toContain('CREATE TABLE sessions');
    expect(sql).toContain('asn INTEGER');
    expect(sql).toContain('as_organization TEXT');
    expect(sql).toContain('country_code TEXT');
    expect(sql).toContain('idx_sessions_idle_expires');
    expect(sql).toContain('idx_sessions_absolute_expires');
    expect(sql).toContain('CREATE TABLE site_settings');
    expect(sql).toContain('CREATE TABLE studio_settings');
    expect(sql).toContain('CREATE TABLE site_custom_code');
    expect(sql).not.toContain('IF NOT EXISTS');
  });

  it('executes every tokenized baseline statement with complete triggers', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');

    for (const statement of getInstallBaselineStatements()) {
      database.exec(`${statement};`);
    }

    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_schema
      WHERE type = 'trigger'
    `).get()).toEqual({ count: 21 });
  });

  it('fresh-installs, uninstalls, and reinstalls the current schema with working counter storage', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    const db = sqliteD1(sqlite);
    const now = new Date('2026-09-16T12:00:00Z');
    const install = () => installStudioDatabase({
      db,
      edgeIntegrationMode: 'disabled',
      administrator: { admin_name: 'Studio Owner', admin_email: 'owner@example.com' },
      interfaceLocale: 'en',
      passwordHash: '$argon2id$test-hash',
      mfa: {
        encryptedTotpSecret: { ciphertext: 'encrypted-totp-secret', iv: '0123456789abcdef' },
        lastUsedStep: 1234,
      },
      now,
    });
    try {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        await install();
        expect(sqlite.prepare('SELECT schema_version FROM zeropress_schema_state').get())
          .toEqual({ schema_version: STUDIO_SCHEMA_VERSION });
        expect(sqlite.prepare('SELECT count(*) AS n FROM auth_rate_limits').get()?.n).toBe(0);
        expect(await consumeLoginRateLimits({
          db, authSecret: 'test-auth-secret-value-with-at-least-32-characters',
          email: 'owner@example.com', ip: '192.0.2.1', now,
        })).toMatchObject({ allowed: true, remaining: 4 });
        expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        await uninstallStudioDatabase(db);
        expect(sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = 'auth_rate_limits'").get())
          .toBeUndefined();
      }
    } finally {
      sqlite.close();
    }
  });

  it('atomically appends administrator, role, settings, and ready-state inserts', async () => {
    const capture = createCapturingDatabase();
    await installStudioDatabase({
      db: capture.database,
      edgeIntegrationMode: 'enabled',
      administrator: {
        admin_name: 'Studio Owner',
        admin_email: 'owner@example.com',
      },
      interfaceLocale: 'ko',
      passwordHash: '$argon2id$test-hash',
      mfa: {
        encryptedTotpSecret: {
          ciphertext: 'encrypted-totp-secret',
          iv: '0123456789abcdef',
        },
        lastUsedStep: 1234,
      },
      now: new Date('2026-07-29T12:34:56.000Z'),
      createId: () => '0123456789abcdef0123456789abcdef',
    });

    expect(capture.batchCalls).toHaveLength(1);
    const batch = capture.batchCalls[0];
    const userInsert = batch.find((statement) => (
      statement.sql.includes('INSERT INTO users')
    ));
    const roleInsert = batch.find((statement) => (
      statement.sql.includes('INSERT INTO user_roles')
    ));
    const systemRoleInsert = batch.find((statement) => (
      statement.sql.includes('INSERT INTO roles')
    ));
    const factorInsert = batch.find((statement) => (
      statement.sql.includes('INSERT INTO user_mfa_factors')
    ));
    const schemaStateInsert = batch.find((statement) => (
      statement.sql.includes('INSERT INTO zeropress_schema_state')
    ));
    const contentSearchStateInsert = batch.find((statement) => (
      statement.sql.includes('INSERT INTO content_search_index_state')
    ));
    const interfaceSettingsInsert = batch.find((statement) => (
      statement.sql.includes('INSERT INTO studio_settings')
    ));

    expect(userInsert?.params).toEqual([
      '0123456789abcdef0123456789abcdef',
      'owner@example.com',
      '$argon2id$test-hash',
      'Studio Owner',
      '2026-07-29T12:34:56.000Z',
      '2026-07-29T12:34:56.000Z',
    ]);
    expect(userInsert?.sql).toContain("'active', 1, 0, NULL");
    expect(factorInsert?.params).toEqual([
      '0123456789abcdef0123456789abcdef',
      '0123456789abcdef0123456789abcdef',
      'encrypted-totp-secret',
      '0123456789abcdef',
      1234,
      '2026-07-29T12:34:56.000Z',
      '2026-07-29T12:34:56.000Z',
    ]);
    expect(roleInsert?.params).toEqual([
      '0123456789abcdef0123456789abcdef',
      '2026-07-29T12:34:56.000Z',
    ]);
    expect(systemRoleInsert?.sql).toContain("'admin'");
    expect(systemRoleInsert?.sql).toContain("'editor'");
    expect(systemRoleInsert?.sql).toContain("'author'");
    expect(systemRoleInsert?.params).toHaveLength(6);
    expect(interfaceSettingsInsert?.params).toEqual([
      'ko',
      '0123456789abcdef0123456789abcdef',
      '2026-07-29T12:34:56.000Z',
      '["ko"]',
      '0123456789abcdef0123456789abcdef',
      '2026-07-29T12:34:56.000Z',
      '0123456789abcdef0123456789abcdef',
      '0123456789abcdef0123456789abcdef',
      '2026-07-29T12:34:56.000Z',
      'enabled',
      '0123456789abcdef0123456789abcdef',
      '2026-07-29T12:34:56.000Z',
      '0123456789abcdef0123456789abcdef',
      '0123456789abcdef0123456789abcdef',
      '2026-07-29T12:34:56.000Z',
      '{"mode":"disabled","issuer":null,"audience":null,"bound_origin":null,"verified_at_iso":null}',
      '0123456789abcdef0123456789abcdef',
      '2026-07-29T12:34:56.000Z',
      '0123456789abcdef0123456789abcdef',
      '0123456789abcdef0123456789abcdef',
      '2026-07-29T12:34:56.000Z',
    ]);
    expect(schemaStateInsert).toMatchObject({
      sql: expect.stringContaining('INSERT INTO zeropress_schema_state'),
      params: [STUDIO_SCHEMA_VERSION, '2026-07-29T12:34:56.000Z'],
    });
    expect(contentSearchStateInsert).toMatchObject({
      sql: expect.stringContaining("1, 'ready', NULL"),
      params: ['2026-07-29T12:34:56.000Z'],
    });
    expect(JSON.stringify(batch)).not.toContain(
      'harbor lantern canyon marble circuit',
    );
  });
});

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readStudioInterfaceSettings,
  updateStudioInterfaceSettings,
} from './studio-interface-settings-repository';

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
      this.database.prepare(this.sql).run as (...params: unknown[]) =>
        SqliteRunResult
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
        for (const statement of statements) results.push(await statement.run());
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

const USER_ID = '1'.repeat(32);
const NOW = new Date('2026-08-10T00:00:00.000Z');

function seedUser(database: DatabaseSync) {
  database.prepare(`
    INSERT INTO users (
      id, email, password_hash, auth_revision, name, status,
      email_verified, created_at_iso, updated_at_iso
    ) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)
  `).run(
    USER_ID,
    'owner@example.com',
    'password-hash',
    '2'.repeat(32),
    'Studio Owner',
    NOW.toISOString(),
    NOW.toISOString(),
  );
}

describe('Studio interface settings D1 repository', () => {
  it('writes and reads one canonical Studio-only document', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    const completed = await updateStudioInterfaceSettings({
      db: d1,
      settings: {
        default_locale: 'ko',
        enabled_locales: ['en', 'ko'],
      },
      expectedRevision: '0'.repeat(32),
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '3'.repeat(32),
    });
    expect(completed).toEqual({
      kind: 'completed',
      document: {
        settings: {
          default_locale: 'ko',
          enabled_locales: ['en', 'ko'],
        },
        revision: '3'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    });
    await expect(readStudioInterfaceSettings({ db: d1 })).resolves.toEqual(
      completed.kind === 'completed' ? completed.document : null,
    );
    expect(database.prepare(
      'SELECT COUNT(*) AS count FROM studio_settings',
    ).get()).toEqual({ count: 3 });
    expect(database.prepare(
      'SELECT COUNT(*) AS count FROM site_settings',
    ).get()).toEqual({ count: 0 });
  });

  it('fails closed for missing, partial, and unsupported stored policy', async () => {
    const { database, d1 } = createTestDatabase();
    await expect(readStudioInterfaceSettings({ db: d1 }))
      .rejects.toMatchObject({
        code: 'STUDIO_SETTINGS_DATA_INVALID',
      } satisfies Partial<StudioOperationalError>);

    database.prepare(`
      INSERT INTO studio_settings (key, value, type, updated_at_iso)
      VALUES
        ('default_interface_locale', 'fr', 'string', ?),
        ('enabled_interface_locales', '["fr"]', 'json', ?),
        ('interface_settings_revision', ?, 'string', ?)
    `).run(
      NOW.toISOString(),
      NOW.toISOString(),
      '4'.repeat(32),
      NOW.toISOString(),
    );
    await expect(readStudioInterfaceSettings({ db: d1 }))
      .rejects.toMatchObject({
        code: 'STUDIO_SETTINGS_DATA_INVALID',
      } satisfies Partial<StudioOperationalError>);

    database.prepare(`
      UPDATE studio_settings
      SET value = CASE key
        WHEN 'default_interface_locale' THEN 'en'
        WHEN 'enabled_interface_locales' THEN '["ko","en"]'
        ELSE value
      END
    `).run();
    await expect(readStudioInterfaceSettings({ db: d1 }))
      .rejects.toMatchObject({
        code: 'STUDIO_SETTINGS_DATA_INVALID',
      } satisfies Partial<StudioOperationalError>);
  });

  it('rejects a stale revision without partially changing the policy', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    await updateStudioInterfaceSettings({
      db: d1,
      settings: { default_locale: 'en', enabled_locales: ['en'] },
      expectedRevision: '0'.repeat(32),
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '5'.repeat(32),
    });
    await expect(updateStudioInterfaceSettings({
      db: d1,
      settings: { default_locale: 'ko', enabled_locales: ['ko'] },
      expectedRevision: '4'.repeat(32),
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '6'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
    await expect(readStudioInterfaceSettings({ db: d1 })).resolves
      .toMatchObject({
        settings: { default_locale: 'en', enabled_locales: ['en'] },
        revision: '5'.repeat(32),
      });
  });
});

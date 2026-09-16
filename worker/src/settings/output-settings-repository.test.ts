import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  materializeOutputSettingsDefaults,
  OUTPUT_SETTINGS_INITIAL_REVISION,
} from '../../../contracts/output-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readOutputSettings,
  updateOutputSettings,
} from './output-settings-repository';

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
        for (const statement of statements) {
          results.push(await statement.run());
        }
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
const NOW = new Date('2026-08-01T05:00:00.000Z');

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

describe('output settings D1 repository', () => {
  it('materializes defaults without writing rows', async () => {
    const { database, d1 } = createTestDatabase();

    await expect(readOutputSettings({ db: d1 })).resolves.toEqual({
      settings: materializeOutputSettingsDefaults(),
      revision: OUTPUT_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM site_settings')
      .get()).toEqual({ count: 0 });
  });

  it('writes canonical typed rows, advances revisions, and rejects stale writes', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    const settings = {
      expose_generator: false,
      search: { enabled: false },
      feed: { enabled: false },
      archive: { enabled: true },
      posts_per_page: 25,
      date_style: 'full' as const,
      time_style: 'short' as const,
      footer: {
        copyright_text: '© 2026 Example',
        attribution: false,
      },
      robots: { allow_indexing: true },
    };
    await expect(updateOutputSettings({
      db: d1,
      settings,
      expectedRevision: OUTPUT_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '3'.repeat(32),
    })).resolves.toEqual({
      kind: 'completed',
      document: {
        settings,
        revision: '3'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM site_settings')
      .get()).toEqual({ count: 10 });
    expect(database.prepare(`
      SELECT value, type FROM site_settings WHERE key = 'site_search'
    `).get()).toEqual({ value: '{"enabled":false}', type: 'json' });
    expect(database.prepare(`
      SELECT value, type FROM site_settings WHERE key = 'posts_per_page'
    `).get()).toEqual({ value: '25', type: 'number' });
    expect(database.prepare(`
      SELECT value, type FROM site_settings WHERE key = 'site_footer'
    `).get()).toEqual({
      value: '{"copyright_text":"© 2026 Example","attribution":false}',
      type: 'json',
    });
    await expect(readOutputSettings({ db: d1 })).resolves.toEqual({
      settings,
      revision: '3'.repeat(32),
      updated_at_iso: NOW.toISOString(),
    });

    const revised = { ...settings, posts_per_page: 50 };
    await expect(updateOutputSettings({
      db: d1,
      settings: revised,
      expectedRevision: '3'.repeat(32),
      updatedBy: USER_ID,
      now: new Date('2026-08-01T05:01:00.000Z'),
      createRevision: () => '4'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      document: {
        settings: revised,
        revision: '4'.repeat(32),
      },
    });
    await expect(updateOutputSettings({
      db: d1,
      settings: { ...revised, posts_per_page: 100 },
      expectedRevision: '3'.repeat(32),
      updatedBy: USER_ID,
      now: new Date('2026-08-01T05:02:00.000Z'),
      createRevision: () => '5'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
    expect(database.prepare(`
      SELECT value FROM site_settings WHERE key = 'posts_per_page'
    `).get()).toEqual({ value: '50' });
  });

  it('fails closed for partial or non-canonical stored documents', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    database.prepare(`
      INSERT INTO site_settings (
        key, value, type, updated_at_iso
      ) VALUES ('site_feed', '{"enabled":true}', 'json', ?)
    `).run(NOW.toISOString());

    await expect(readOutputSettings({ db: d1 })).rejects.toMatchObject({
      code: 'SITE_OUTPUT_SETTINGS_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
    await expect(updateOutputSettings({
      db: d1,
      settings: materializeOutputSettingsDefaults(),
      expectedRevision: OUTPUT_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '6'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM site_settings')
      .get()).toEqual({ count: 1 });

    database.prepare('DELETE FROM site_settings').run();
    await updateOutputSettings({
      db: d1,
      settings: materializeOutputSettingsDefaults(),
      expectedRevision: OUTPUT_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '7'.repeat(32),
    });
    database.prepare(`
      UPDATE site_settings
      SET value = ' {"enabled":true}'
      WHERE key = 'site_search'
    `).run();
    await expect(readOutputSettings({ db: d1 })).rejects.toMatchObject({
      code: 'SITE_OUTPUT_SETTINGS_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
  });

  it('reserves the zero revision for an unmaterialized document', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    await updateOutputSettings({
      db: d1,
      settings: materializeOutputSettingsDefaults(),
      expectedRevision: OUTPUT_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '8'.repeat(32),
    });
    database.prepare(`
      UPDATE site_settings
      SET value = ?
      WHERE key = 'site_output_revision'
    `).run(OUTPUT_SETTINGS_INITIAL_REVISION);

    await expect(readOutputSettings({ db: d1 })).rejects.toMatchObject({
      code: 'SITE_OUTPUT_SETTINGS_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
  });
});

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GENERAL_SETTINGS_INITIAL_REVISION } from '../../../contracts/general-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  GeneralSettingsIncompleteError,
  readGeneralSettings,
  repairGeneralSettings,
  updateGeneralSettings,
} from './general-settings-repository';

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
const NOW = new Date('2026-08-01T03:00:00.000Z');

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

describe('general settings D1 repository', () => {
  it('materializes valid defaults without writing rows', async () => {
    const { database, d1 } = createTestDatabase();

    await expect(readGeneralSettings({ db: d1 })).resolves.toEqual({
      settings: {
        title: 'ZeroPress',
        description: '',
        url: '',
        locale: 'en-US',
        timezone: 'UTC',
      },
      revision: GENERAL_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM site_settings')
      .get()).toEqual({ count: 0 });
  });

  it('writes one canonical document and rejects a stale revision', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    const settings = {
      title: 'Example Site',
      description: 'A publication.',
      url: 'https://example.com',
      locale: 'ko-KR',
      timezone: 'Asia/Seoul',
    };
    const first = await updateGeneralSettings({
      db: d1,
      settings,
      expectedRevision: GENERAL_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '3'.repeat(32),
    });
    expect(first).toEqual({
      kind: 'completed',
      document: {
        settings,
        revision: '3'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM site_settings')
      .get()).toEqual({ count: 6 });
    await expect(readGeneralSettings({ db: d1 })).resolves.toEqual(
      first.kind === 'completed' ? first.document : null,
    );

    const secondSettings = { ...settings, title: 'Revised Site' };
    await expect(updateGeneralSettings({
      db: d1,
      settings: secondSettings,
      expectedRevision: '3'.repeat(32),
      updatedBy: USER_ID,
      now: new Date('2026-08-01T03:01:00.000Z'),
      createRevision: () => '4'.repeat(32),
    })).resolves.toEqual({
      kind: 'completed',
      document: {
        settings: secondSettings,
        revision: '4'.repeat(32),
        updated_at_iso: '2026-08-01T03:01:00.000Z',
      },
    });

    await expect(updateGeneralSettings({
      db: d1,
      settings: { ...settings, title: 'Stale overwrite' },
      expectedRevision: '3'.repeat(32),
      updatedBy: USER_ID,
      now: new Date('2026-08-01T03:02:00.000Z'),
      createRevision: () => '5'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
    expect(database.prepare(`
      SELECT value FROM site_settings WHERE key = 'site_title'
    `).get()).toEqual({ value: 'Revised Site' });

    database.prepare(`
      UPDATE site_settings
      SET updated_at_iso = 'not-a-date'
    `).run();
    await expect(readGeneralSettings({ db: d1 })).rejects.toMatchObject({
      code: 'SITE_SETTINGS_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
  });

  it('fails closed when stored general settings are partial or malformed', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    database.prepare(`
      INSERT INTO site_settings (
        key, value, type, updated_at_iso
      ) VALUES ('site_title', 'Partial', 'string', ?)
    `).run(NOW.toISOString());

    await expect(readGeneralSettings({ db: d1 })).rejects.toMatchObject({
      code: 'SITE_SETTINGS_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
    await expect(updateGeneralSettings({
      db: d1,
      settings: {
        title: 'Attempted repair',
        description: '',
        url: '',
        locale: 'en-US',
        timezone: 'UTC',
      },
      expectedRevision: GENERAL_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '5'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
    expect(database.prepare(`
      SELECT key, value FROM site_settings ORDER BY key
    `).all()).toEqual([{ key: 'site_title', value: 'Partial' }]);
  });

  it('repairs a missing field with its default while preserving valid values', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    const settings = {
      title: 'Existing title',
      description: 'Existing description',
      url: 'https://example.com',
      locale: 'ko-KR',
      timezone: 'Asia/Seoul',
    };
    await updateGeneralSettings({
      db: d1,
      settings,
      expectedRevision: GENERAL_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '7'.repeat(32),
    });
    database.prepare(`
      DELETE FROM site_settings WHERE key = 'site_description'
    `).run();

    let recovery: GeneralSettingsIncompleteError['recovery'];
    try {
      await readGeneralSettings({ db: d1 });
      throw new Error('Expected incomplete General Settings.');
    } catch (error) {
      expect(error).toBeInstanceOf(GeneralSettingsIncompleteError);
      recovery = (error as GeneralSettingsIncompleteError).recovery;
    }
    expect(recovery).toEqual({
      expected_revision: '7'.repeat(32),
      missing_fields: ['description'],
      proposed_settings: { ...settings, description: '' },
    });

    const repairedAt = new Date('2026-08-01T03:05:00.000Z');
    await expect(repairGeneralSettings({
      db: d1,
      expectedRevision: recovery.expected_revision,
      missingFields: recovery.missing_fields,
      updatedBy: USER_ID,
      now: repairedAt,
      createRevision: () => '8'.repeat(32),
    })).resolves.toEqual({
      kind: 'completed',
      document: {
        settings: { ...settings, description: '' },
        revision: '8'.repeat(32),
        updated_at_iso: repairedAt.toISOString(),
      },
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count, COUNT(DISTINCT updated_at_iso) AS timestamps
      FROM site_settings
      WHERE key IN (
        'site_title', 'site_description', 'site_url', 'site_locale',
        'site_timezone', 'site_general_revision'
      )
    `).get()).toEqual({ count: 6, timestamps: 1 });
    await expect(readGeneralSettings({ db: d1 })).resolves.toMatchObject({
      settings: { ...settings, description: '' },
      revision: '8'.repeat(32),
    });
  });

  it('reserves the zero revision for an unmaterialized document', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    await updateGeneralSettings({
      db: d1,
      settings: {
        title: 'Example Site',
        description: '',
        url: '',
        locale: 'en-US',
        timezone: 'UTC',
      },
      expectedRevision: GENERAL_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '6'.repeat(32),
    });
    database.prepare(`
      UPDATE site_settings
      SET value = ?
      WHERE key = 'site_general_revision'
    `).run(GENERAL_SETTINGS_INITIAL_REVISION);

    await expect(readGeneralSettings({ db: d1 })).rejects.toMatchObject({
      code: 'SITE_SETTINGS_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
  });
});

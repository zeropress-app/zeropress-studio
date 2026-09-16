import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  materializeMediaSettingsDefaults,
  MEDIA_SETTINGS_INITIAL_REVISION,
} from '../../../contracts/media-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readMediaSettings,
  updateMediaSettings,
} from './media-settings-repository';

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
const NOW = new Date('2026-08-02T05:00:00.000Z');

function seedUser(database: DatabaseSync) {
  database.prepare(`
    INSERT INTO users (
      id, email, password_hash, auth_revision, name, status,
      email_verified, created_at_iso, updated_at_iso
    ) VALUES (?, 'owner@example.com', 'password-hash', ?, 'Owner',
      'active', 1, ?, ?)
  `).run(USER_ID, '2'.repeat(32), NOW.toISOString(), NOW.toISOString());
}

describe('Media settings D1 repository', () => {
  it('materializes defaults without writing product-owned rows', async () => {
    const { database, d1 } = createTestDatabase();
    await expect(readMediaSettings({ db: d1 })).resolves.toEqual({
      settings: materializeMediaSettingsDefaults(),
      revision: MEDIA_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM site_settings').get())
      .toEqual({ count: 0 });
  });

  it('writes one revision-bound document and rejects stale updates', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    const settings = {
      media_origin: 'https://media.example',
      media_delivery_mode: 'media_domain' as const,
    };
    await expect(updateMediaSettings({
      db: d1,
      settings,
      expectedRevision: MEDIA_SETTINGS_INITIAL_REVISION,
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
    expect(database.prepare('SELECT COUNT(*) AS count FROM site_settings').get())
      .toEqual({ count: 3 });
    await expect(readMediaSettings({ db: d1 })).resolves.toEqual({
      settings,
      revision: '3'.repeat(32),
      updated_at_iso: NOW.toISOString(),
    });
    await expect(updateMediaSettings({
      db: d1,
      settings: materializeMediaSettingsDefaults(),
      expectedRevision: MEDIA_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '4'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
  });

  it('fails closed for partial or malformed stored documents', async () => {
    const { database, d1 } = createTestDatabase();
    database.prepare(`
      INSERT INTO site_settings (key, value, type, updated_at_iso)
      VALUES ('site_media_origin', 'https://media.example', 'string', ?)
    `).run(NOW.toISOString());
    await expect(readMediaSettings({ db: d1 })).rejects.toMatchObject({
      code: 'SITE_MEDIA_SETTINGS_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
  });
});

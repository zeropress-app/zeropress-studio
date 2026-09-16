import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { GENERAL_SETTINGS_INITIAL_REVISION } from '../../../contracts/general-settings';
import {
  materializeRoutingSettingsDefaults,
  ROUTING_SETTINGS_INITIAL_REVISION,
} from '../../../contracts/routing-settings';
import { readGeneralSettings } from '../settings/general-settings-repository';
import { readRoutingSettings } from '../settings/routing-settings-repository';
import { finalizeWxrSettings } from './wxr-settings-finalize-repository';

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
  let batchCount = 0;
  const d1 = {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      batchCount += 1;
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
  return { database, d1, batchCount: () => batchCount };
}

const USER_ID = '1'.repeat(32);
const NOW = new Date('2026-08-13T02:00:00.000Z');
const generalDefaults = {
  title: 'ZeroPress',
  description: '',
  url: '',
  locale: 'en-US',
  timezone: 'UTC',
};

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

describe('WXR settings finalization', () => {
  it('returns unchanged without rotating revisions or issuing a write batch', async () => {
    const { database, d1, batchCount } = createTestDatabase();
    seedUser(database);

    await expect(finalizeWxrSettings({
      db: d1,
      request: {
        general_settings: {
          settings: generalDefaults,
          expected_revision: GENERAL_SETTINGS_INITIAL_REVISION,
        },
        routing_settings: {
          settings: materializeRoutingSettingsDefaults(),
          expected_revision: ROUTING_SETTINGS_INITIAL_REVISION,
        },
      },
      updatedBy: USER_ID,
      now: NOW,
    })).resolves.toMatchObject({
      kind: 'completed',
      generalSettings: { result: 'unchanged' },
      routingSettings: { result: 'unchanged' },
    });
    expect(batchCount()).toBe(0);
    expect(database.prepare('SELECT COUNT(*) AS count FROM site_settings').get())
      .toEqual({ count: 0 });
  });

  it('commits General and Routing settings in one batch and preserves taxonomy patterns', async () => {
    const { database, d1, batchCount } = createTestDatabase();
    seedUser(database);
    const general = {
      title: 'Imported site',
      description: 'From WordPress',
      url: 'https://example.com',
      locale: 'ko-KR',
      timezone: '+09:00',
    };
    const routing = {
      ...materializeRoutingSettingsDefaults(),
      permalinks: {
        ...materializeRoutingSettingsDefaults().permalinks,
        output_style: 'html-extension' as const,
        posts: '/post/:public_id/',
        pages: '/:slug/',
      },
    };
    const createRevision = vi.fn()
      .mockReturnValueOnce('3'.repeat(32))
      .mockReturnValueOnce('4'.repeat(32));

    await expect(finalizeWxrSettings({
      db: d1,
      request: {
        general_settings: {
          settings: general,
          expected_revision: GENERAL_SETTINGS_INITIAL_REVISION,
        },
        routing_settings: {
          settings: routing,
          expected_revision: ROUTING_SETTINGS_INITIAL_REVISION,
        },
      },
      updatedBy: USER_ID,
      now: NOW,
      createRevision,
    })).resolves.toMatchObject({
      kind: 'completed',
      generalSettings: {
        result: 'updated',
        document: { settings: general, revision: '3'.repeat(32) },
      },
      routingSettings: {
        result: 'updated',
        document: { settings: routing, revision: '4'.repeat(32) },
      },
    });
    expect(batchCount()).toBe(1);
    await expect(readGeneralSettings({ db: d1 })).resolves.toMatchObject({
      settings: general,
      revision: '3'.repeat(32),
    });
    await expect(readRoutingSettings({ db: d1 })).resolves.toMatchObject({
      settings: routing,
      revision: '4'.repeat(32),
    });
    expect(routing.permalinks.categories).toBe('/categories/:slug/');
    expect(routing.permalinks.tags).toBe('/tags/:slug/');
  });

  it('rejects stale revisions without changing either document', async () => {
    const { database, d1, batchCount } = createTestDatabase();
    seedUser(database);
    await finalizeWxrSettings({
      db: d1,
      request: {
        general_settings: {
          settings: { ...generalDefaults, title: 'Already changed' },
          expected_revision: GENERAL_SETTINGS_INITIAL_REVISION,
        },
        routing_settings: {
          settings: materializeRoutingSettingsDefaults(),
          expected_revision: ROUTING_SETTINGS_INITIAL_REVISION,
        },
      },
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '9'.repeat(32),
    });
    const batchesBeforeStaleRequest = batchCount();

    await expect(finalizeWxrSettings({
      db: d1,
      request: {
        general_settings: {
          settings: generalDefaults,
          expected_revision: GENERAL_SETTINGS_INITIAL_REVISION,
        },
        routing_settings: {
          settings: materializeRoutingSettingsDefaults(),
          expected_revision: ROUTING_SETTINGS_INITIAL_REVISION,
        },
      },
      updatedBy: USER_ID,
      now: NOW,
    })).resolves.toEqual({ kind: 'revision_conflict' });
    expect(batchCount()).toBe(batchesBeforeStaleRequest);
    await expect(readGeneralSettings({ db: d1 })).resolves.toMatchObject({
      settings: { title: 'Already changed' },
      revision: '9'.repeat(32),
    });
  });
});

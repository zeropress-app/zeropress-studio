import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
  materializeCustomCodeSettingsDefaults,
} from '../../../contracts/custom-code-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readCustomCodeSettings,
  updateCustomCodeSettings,
} from './custom-code-settings-repository';

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

  async first<T>(): Promise<T | null> {
    return ((
      this.database.prepare(this.sql).get as (...params: unknown[]) => T | undefined
    )(...this.params)) ?? null;
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
  } as unknown as D1Database;
  return { database, d1 };
}

const USER_ID = '1'.repeat(32);
const NOW = new Date('2026-08-04T01:00:00.000Z');

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

describe('Custom Code settings D1 repository', () => {
  it('materializes disabled defaults without inserting a singleton', async () => {
    const { database, d1 } = createTestDatabase();
    await expect(readCustomCodeSettings({ db: d1 })).resolves.toEqual({
      settings: materializeCustomCodeSettingsDefaults(),
      revision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM site_custom_code')
      .get()).toEqual({ count: 0 });
  });

  it('preserves exact drafts, advances revisions, and rejects stale writes', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    const settings = {
      custom_css: {
        enabled: true,
        content: '  :root { --accent: red; }\n',
      },
      custom_html: {
        head_end: { enabled: false, content: '  <!-- draft -->\n' },
        body_end: { enabled: true, content: '<script>ready()</script>\n' },
      },
    };
    const first = await updateCustomCodeSettings({
      db: d1,
      settings,
      expectedRevision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
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
    await expect(readCustomCodeSettings({ db: d1 })).resolves.toEqual(
      first.kind === 'completed' ? first.document : null,
    );

    const changed = structuredClone(settings);
    changed.custom_html.head_end.enabled = true;
    await expect(updateCustomCodeSettings({
      db: d1,
      settings: changed,
      expectedRevision: '3'.repeat(32),
      updatedBy: USER_ID,
      now: new Date('2026-08-04T01:01:00.000Z'),
      createRevision: () => '4'.repeat(32),
    })).resolves.toMatchObject({ kind: 'completed' });
    await expect(updateCustomCodeSettings({
      db: d1,
      settings,
      expectedRevision: '3'.repeat(32),
      updatedBy: USER_ID,
      now: new Date('2026-08-04T01:02:00.000Z'),
      createRevision: () => '5'.repeat(32),
    })).resolves.toEqual({ kind: 'revision_conflict' });
    expect(database.prepare(`
      SELECT head_end_enabled FROM site_custom_code WHERE id = 1
    `).get()).toEqual({ head_end_enabled: 1 });
  });

  it('fails closed for a materialized row using the reserved revision', async () => {
    const { database, d1 } = createTestDatabase();
    database.prepare(`
      INSERT INTO site_custom_code (
        id, custom_css_enabled, custom_css_content,
        head_end_enabled, head_end_content,
        body_end_enabled, body_end_content,
        revision, updated_at_iso
      ) VALUES (1, 0, '', 0, '', 0, '', ?, ?)
    `).run(CUSTOM_CODE_SETTINGS_INITIAL_REVISION, NOW.toISOString());

    await expect(readCustomCodeSettings({ db: d1 })).rejects.toMatchObject({
      code: 'CUSTOM_CODE_SETTINGS_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
  });
});

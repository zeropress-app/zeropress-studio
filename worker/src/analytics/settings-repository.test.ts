import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ANALYTICS_DEFAULTS,
  ANALYTICS_INITIAL_REVISION,
} from '../../../contracts/analytics';
import {
  readAnalyticsSettings,
  readAnalyticsRuntimeSettings,
  updateAnalyticsSettings,
} from './settings-repository';
import {
  readPreviewDataSettings,
  buildPreviewDataV07,
} from '../preview-data/projection';
import { decryptMailCredential } from '../mail/credential-crypto';
import {
  decryptAnalyticsCredential,
  encryptAnalyticsCredential,
} from './credential-crypto';
import {
  DOCUMENT,
  forbidAnalyticsNetwork,
  SYNTHETIC_TOKEN,
} from './test-support';

forbidAnalyticsNetwork();
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));
class Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Statement(this.database, this.sql, params);
  }
  async run() {
    const result = (
      this.database.prepare(this.sql).run as (...values: unknown[]) => {
        changes: number | bigint;
      }
    )(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }
  async all<T>() {
    const results = (
      this.database.prepare(this.sql).all as (...values: unknown[]) => T[]
    )(...this.params);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }
}

function testDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec(
    readFileSync(
      new URL('../../../database/install/001_baseline.sql', import.meta.url),
      'utf8',
    ),
  );
  const db = {
    prepare(sql: string) {
      return new Statement(sqlite, sql);
    },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  sqlite
    .prepare(
      `INSERT INTO users (id,email,password_hash,auth_revision,name,status,email_verified,created_at_iso,updated_at_iso) VALUES (?,?,?,?,?,'active',1,?,?)`,
    )
    .run(
      '1'.repeat(32),
      'owner@example.com',
      'hash',
      '2'.repeat(32),
      'Owner',
      '2026-08-04T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    );
  return { sqlite, db };
}

const AUTH_SECRET = 'synthetic-auth-secret-with-at-least-32-characters';
const base = {
  authSecret: AUTH_SECRET,
  updatedBy: '1'.repeat(32),
  expected_revision: ANALYTICS_INITIAL_REVISION,
  settings: DOCUMENT.settings,
  credential: { action: 'replace' as const, value: SYNTHETIC_TOKEN },
};

describe('analytics settings repository', () => {
  it('exports public site data without Analytics credentials or account settings', async () => {
    const { db } = testDatabase();
    await updateAnalyticsSettings({ ...base, db });
    const preview = buildPreviewDataV07({
      settings: await readPreviewDataSettings({ db }),
      generatedAt: new Date('2026-09-21T12:00:00Z'),
    });
    const serialized = JSON.stringify(preview);
    expect(preview.site.title).toBeTruthy();
    for (const privateValue of [
      SYNTHETIC_TOKEN,
      DOCUMENT.settings.account_id,
      'analytics_api_token_encrypted',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });
  it('defaults existing installations to disabled and stores credentials encrypted', async () => {
    const { db, sqlite } = testDatabase();
    expect(await readAnalyticsSettings({ db })).toEqual({
      settings: ANALYTICS_DEFAULTS,
      token_configured: false,
      configured: false,
      revision: ANALYTICS_INITIAL_REVISION,
      updated_at_iso: null,
    });
    const saved = await updateAnalyticsSettings({ ...base, db });
    expect(saved.kind).toBe('completed');
    expect(JSON.stringify(saved)).not.toContain(SYNTHETIC_TOKEN);
    const rows = sqlite.prepare('SELECT value FROM site_settings').all();
    expect(JSON.stringify(rows)).not.toContain(SYNTHETIC_TOKEN);
    expect(
      await readAnalyticsRuntimeSettings({ db, authSecret: AUTH_SECRET }),
    ).toMatchObject({ document: { configured: true }, token: SYNTHETIC_TOKEN });
  });
  it('preserves, replaces, and removes a token through revision-checked saves', async () => {
    const { db } = testDatabase();
    const saved = await updateAnalyticsSettings({ ...base, db });
    if (saved.kind !== 'completed') throw new Error('Save failed');
    const kept = await updateAnalyticsSettings({
      ...base,
      db,
      expected_revision: saved.document.revision,
      credential: { action: 'preserve' },
    });
    if (kept.kind !== 'completed') throw new Error('Preserve failed');
    expect(
      await readAnalyticsRuntimeSettings({ db, authSecret: AUTH_SECRET }),
    ).toMatchObject({ token: SYNTHETIC_TOKEN });
    const replacement = await updateAnalyticsSettings({
      ...base,
      db,
      expected_revision: kept.document.revision,
      credential: { action: 'replace', value: 'synthetic-replacement' },
    });
    if (replacement.kind !== 'completed') throw new Error('Replace failed');
    expect(
      await readAnalyticsRuntimeSettings({ db, authSecret: AUTH_SECRET }),
    ).toMatchObject({ token: 'synthetic-replacement' });
    const removed = await updateAnalyticsSettings({
      ...base,
      db,
      expected_revision: replacement.document.revision,
      settings: { ...DOCUMENT.settings, enabled: false },
      credential: { action: 'remove' },
    });
    expect(removed).toMatchObject({
      kind: 'completed',
      document: { configured: false, token_configured: false },
    });
    expect(
      await readAnalyticsRuntimeSettings({ db, authSecret: AUTH_SECRET }),
    ).toMatchObject({ token: null });
  });
  it('rejects missing credentials and conflicting saves without losing the saved connection', async () => {
    const { db } = testDatabase();
    expect(
      await updateAnalyticsSettings({
        ...base,
        db,
        credential: { action: 'preserve' },
      }),
    ).toEqual({ kind: 'credential_missing' });
    await updateAnalyticsSettings({ ...base, db });
    expect(
      await updateAnalyticsSettings({
        ...base,
        db,
        credential: { action: 'remove' },
      }),
    ).toEqual({ kind: 'revision_conflict' });
    expect(
      await readAnalyticsRuntimeSettings({ db, authSecret: AUTH_SECRET }),
    ).toMatchObject({ token: SYNTHETIC_TOKEN });
  });
  it('requires the original auth secret and keeps the analytics encryption domain separate from mail', async () => {
    const encrypted = await encryptAnalyticsCredential({
      authSecret: AUTH_SECRET,
      kind: 'cloudflare_api_token',
      value: SYNTHETIC_TOKEN,
    });
    await expect(
      decryptAnalyticsCredential({
        authSecret: 'different-synthetic-auth-secret-value',
        kind: 'cloudflare_api_token',
        encrypted,
      }),
    ).rejects.toThrow();
    await expect(
      decryptMailCredential({
        authSecret: AUTH_SECRET,
        kind: 'cloudflare_api_token',
        encrypted,
      }),
    ).rejects.toThrow();
    expect(
      await decryptAnalyticsCredential({
        authSecret: AUTH_SECRET,
        kind: 'cloudflare_api_token',
        encrypted,
      }),
    ).toBe(SYNTHETIC_TOKEN);
  });
  it('reports damaged configuration rather than silently disabling it', async () => {
    const { db, sqlite } = testDatabase();
    await updateAnalyticsSettings({ ...base, db });
    sqlite
      .prepare(
        "DELETE FROM site_settings WHERE key = 'analytics_api_token_encrypted'",
      )
      .run();
    await expect(readAnalyticsSettings({ db })).rejects.toMatchObject({
      code: 'ANALYTICS_SETTINGS_DATA_INVALID',
    });
  });
});

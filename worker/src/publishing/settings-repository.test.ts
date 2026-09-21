import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLISHING_DEFAULTS,
  PUBLISHING_INITIAL_REVISION,
} from '../../../contracts/publishing';
import {
  readPublishingSettings,
  readPublishingRuntimeSettings,
  updatePublishingSettings,
} from './settings-repository';
import {
  readPreviewDataSettings,
  buildPreviewDataV07,
} from '../preview-data/projection';
import { decryptMailCredential } from '../mail/credential-crypto';
import {
  decryptPublishingCredential,
  encryptPublishingCredential,
} from './credential-crypto';
import { DOCUMENT, forbidPublishingNetwork, TOKEN } from './test-support';

forbidPublishingNetwork();
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
  expected_revision: PUBLISHING_INITIAL_REVISION,
  settings: DOCUMENT.settings,
  credential: { action: 'replace' as const, value: TOKEN },
};

describe('publishing settings repository', () => {
  it('exports public site data without Publishing credentials or account settings', async () => {
    const { db } = testDatabase();
    await updatePublishingSettings({ ...base, db });
    const preview = buildPreviewDataV07({
      settings: await readPreviewDataSettings({ db }),
      generatedAt: new Date('2026-09-21T12:00:00Z'),
    });
    const serialized = JSON.stringify(preview);
    expect(preview.site.title).toBeTruthy();
    for (const privateValue of [
      TOKEN,
      DOCUMENT.settings.owner,
      'publishing_api_token_encrypted',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });
  it('defaults existing installations to disabled and stores credentials encrypted', async () => {
    const { db, sqlite } = testDatabase();
    expect(await readPublishingSettings({ db })).toEqual({
      settings: PUBLISHING_DEFAULTS,
      token_configured: false,
      configured: false,
      revision: PUBLISHING_INITIAL_REVISION,
      updated_at_iso: null,
    });
    const saved = await updatePublishingSettings({ ...base, db });
    expect(saved.kind).toBe('completed');
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    const rows = sqlite.prepare('SELECT value FROM site_settings').all();
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(
      await readPublishingRuntimeSettings({ db, authSecret: AUTH_SECRET }),
    ).toMatchObject({ document: { configured: true }, token: TOKEN });
  });
  it('normalizes a URL-resolved target before storing it', async () => {
    const { db } = testDatabase();
    const { enabled, ...target } = DOCUMENT.settings;
    const saved = await updatePublishingSettings({
      ...base,
      db,
      settings: { ...target, owner: 'EXAMPLE', enabled },
    });
    expect(saved.kind).toBe('completed');
    expect(await readPublishingSettings({ db })).toMatchObject({
      settings: DOCUMENT.settings,
      configured: true,
    });
  });
  it('keeps a complete connection configured when publishing is turned off', async () => {
    const { db } = testDatabase();
    let revision = PUBLISHING_INITIAL_REVISION;
    for (const enabled of [false, true, false]) {
      const saved = await updatePublishingSettings({
        ...base,
        db,
        expected_revision: revision,
        settings: { ...DOCUMENT.settings, enabled },
        credential:
          revision === PUBLISHING_INITIAL_REVISION
            ? base.credential
            : { action: 'preserve' },
      });
      if (saved.kind !== 'completed') throw new Error('Save failed');
      expect(saved.document).toMatchObject({
        configured: true,
        token_configured: true,
        settings: { enabled },
      });
      expect(await readPublishingSettings({ db })).toEqual(saved.document);
      revision = saved.document.revision;
    }
  });
  it('requires both the target and token for a configured connection', async () => {
    const { db } = testDatabase();
    const saved = await updatePublishingSettings({
      ...base,
      db,
      settings: { ...PUBLISHING_DEFAULTS },
    });
    if (saved.kind !== 'completed') throw new Error('Save failed');
    expect(saved.document).toMatchObject({
      configured: false,
      token_configured: true,
      settings: { enabled: false },
    });
    expect(await readPublishingSettings({ db })).toEqual(saved.document);
  });
  it('preserves, replaces, and removes a token through revision-checked saves', async () => {
    const { db } = testDatabase();
    const saved = await updatePublishingSettings({ ...base, db });
    if (saved.kind !== 'completed') throw new Error('Save failed');
    const kept = await updatePublishingSettings({
      ...base,
      db,
      expected_revision: saved.document.revision,
      credential: { action: 'preserve' },
    });
    if (kept.kind !== 'completed') throw new Error('Preserve failed');
    expect(
      await readPublishingRuntimeSettings({ db, authSecret: AUTH_SECRET }),
    ).toMatchObject({ token: TOKEN });
    const replacement = await updatePublishingSettings({
      ...base,
      db,
      expected_revision: kept.document.revision,
      credential: { action: 'replace', value: 'synthetic-replacement' },
    });
    if (replacement.kind !== 'completed') throw new Error('Replace failed');
    expect(
      await readPublishingRuntimeSettings({ db, authSecret: AUTH_SECRET }),
    ).toMatchObject({ token: 'synthetic-replacement' });
    const removed = await updatePublishingSettings({
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
      await readPublishingRuntimeSettings({ db, authSecret: AUTH_SECRET }),
    ).toMatchObject({ token: null });
  });
  it('rejects missing credentials and conflicting saves without losing the saved connection', async () => {
    const { db } = testDatabase();
    expect(
      await updatePublishingSettings({
        ...base,
        db,
        credential: { action: 'preserve' },
      }),
    ).toEqual({ kind: 'credential_missing' });
    await updatePublishingSettings({ ...base, db });
    expect(
      await updatePublishingSettings({
        ...base,
        db,
        credential: { action: 'remove' },
      }),
    ).toEqual({ kind: 'revision_conflict' });
    expect(
      await readPublishingRuntimeSettings({ db, authSecret: AUTH_SECRET }),
    ).toMatchObject({ token: TOKEN });
  });
  it('requires the original auth secret and keeps the publishing encryption domain separate from mail', async () => {
    const encrypted = await encryptPublishingCredential({
      authSecret: AUTH_SECRET,
      kind: 'github_token',
      value: TOKEN,
    });
    await expect(
      decryptPublishingCredential({
        authSecret: 'different-synthetic-auth-secret-value',
        kind: 'github_token',
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
      await decryptPublishingCredential({
        authSecret: AUTH_SECRET,
        kind: 'github_token',
        encrypted,
      }),
    ).toBe(TOKEN);
  });
  it('reports damaged configuration rather than silently disabling it', async () => {
    const { db, sqlite } = testDatabase();
    await updatePublishingSettings({ ...base, db });
    sqlite
      .prepare(
        "DELETE FROM site_settings WHERE key = 'publishing_api_token_encrypted'",
      )
      .run();
    await expect(readPublishingSettings({ db })).rejects.toMatchObject({
      code: 'PUBLISHING_SETTINGS_DATA_INVALID',
    });
  });
});

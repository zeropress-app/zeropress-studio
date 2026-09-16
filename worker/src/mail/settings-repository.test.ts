import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MAIL_SETTINGS_INITIAL_REVISION,
  materializeMailSettingsDefaults,
} from '../../../contracts/mail-settings';
import {
  readMailRuntimeConfiguration,
  readMailSettings,
  updateMailSettings,
} from './settings-repository';

class Statement {
  constructor(readonly database: DatabaseSync, readonly sql: string, readonly params: unknown[] = []) {}
  bind(...params: unknown[]) { return new Statement(this.database, this.sql, params); }
  async run() {
    const result = (this.database.prepare(this.sql).run as (...values: unknown[]) => { changes: number | bigint })(...this.params);
    return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result<unknown>;
  }
  async all<T>() {
    const results = (this.database.prepare(this.sql).all as (...values: unknown[]) => T[])(...this.params);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }
}

function testDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../../../database/install/001_baseline.sql', import.meta.url), 'utf8'));
  const db = {
    prepare(sql: string) { return new Statement(sqlite, sql); },
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
  sqlite.prepare(`INSERT INTO users (id,email,password_hash,auth_revision,name,status,email_verified,created_at_iso,updated_at_iso) VALUES (?,?,?,?,?,'active',1,?,?)`).run('1'.repeat(32), 'owner@example.com', 'hash', '2'.repeat(32), 'Owner', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z');
  return { sqlite, db };
}

const AUTH_SECRET = 'test-auth-secret-value-with-at-least-32-characters';

describe('mail settings repository', () => {
  it('stores encrypted credentials and exposes status only', async () => {
    const { sqlite, db } = testDatabase();
    await expect(readMailSettings({ db })).resolves.toEqual({
      settings: materializeMailSettingsDefaults(),
      credentials: {
        resend_api_key_configured: false,
        cloudflare_api_token_configured: false,
      },
      configured: false,
      revision: MAIL_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    });
    const settings = {
      provider: 'resend' as const,
      from_email: 'mail@example.com',
      from_name: 'ZeroPress',
      cloudflare_account_id: '',
    };
    const result = await updateMailSettings({
      db,
      settings,
      credentialActions: {
        resend_api_key: { action: 'replace', value: 're_secret-value' },
        cloudflare_api_token: { action: 'preserve' },
      },
      expectedRevision: MAIL_SETTINGS_INITIAL_REVISION,
      updatedBy: '1'.repeat(32),
      authSecret: AUTH_SECRET,
      now: new Date('2026-08-04T01:00:00.000Z'),
      createRevision: () => '3'.repeat(32),
    });
    expect(result).toMatchObject({
      kind: 'completed',
      document: {
        settings,
        credentials: { resend_api_key_configured: true },
        configured: true,
      },
    });
    const stored = sqlite.prepare(`SELECT value FROM site_settings WHERE key='mail_resend_api_key_encrypted'`).get() as { value: string };
    expect(stored.value).not.toContain('secret-value');
    await expect(readMailRuntimeConfiguration({ db, authSecret: AUTH_SECRET })).resolves.toEqual({
      kind: 'configured',
      settings,
      credential: 're_secret-value',
    });
  });

  it('does not activate a provider without its resulting credential', async () => {
    const { db } = testDatabase();
    await expect(updateMailSettings({
      db,
      settings: { provider: 'resend', from_email: 'mail@example.com', from_name: '', cloudflare_account_id: '' },
      credentialActions: { resend_api_key: { action: 'preserve' }, cloudflare_api_token: { action: 'preserve' } },
      expectedRevision: MAIL_SETTINGS_INITIAL_REVISION,
      updatedBy: '1'.repeat(32),
      authSecret: AUTH_SECRET,
    })).resolves.toEqual({ kind: 'credential_missing' });
  });
});

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  materializeNewsletterSettingsDefaults,
  NEWSLETTER_SETTINGS_INITIAL_REVISION,
} from '../../../contracts/newsletter-settings';
import {
  readNewsletterSettings,
  updateNewsletterSettings,
} from './newsletter-settings-repository';

class Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}
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

function database() {
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

describe('Newsletter settings repository', () => {
  it('materializes defaults without writes and stores one canonical aggregate', async () => {
    const { sqlite, db } = database();
    await expect(readNewsletterSettings({ db })).resolves.toEqual({
      settings: materializeNewsletterSettingsDefaults(),
      revision: NEWSLETTER_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    });
    const settings = {
      enabled: true,
      title: 'Product notes',
      description: 'Monthly notes.',
      button_label: 'Subscribe',
      signup_url: 'https://example.com/signup',
      embed_url: '',
    };
    await expect(updateNewsletterSettings({
      db,
      settings,
      expectedRevision: NEWSLETTER_SETTINGS_INITIAL_REVISION,
      updatedBy: '1'.repeat(32),
      now: new Date('2026-08-04T01:00:00.000Z'),
      createRevision: () => '3'.repeat(32),
    })).resolves.toMatchObject({ kind: 'completed', document: { settings } });
    expect(sqlite.prepare(`SELECT value,type FROM site_settings WHERE key='site_newsletter'`).get()).toEqual({
      value: JSON.stringify(settings),
      type: 'json',
    });
    await expect(readNewsletterSettings({ db })).resolves.toMatchObject({
      settings,
      revision: '3'.repeat(32),
    });
  });

  it('fails closed for a partial document', async () => {
    const { sqlite, db } = database();
    sqlite.prepare(`INSERT INTO site_settings (key,value,type,updated_by,updated_at_iso) VALUES ('site_newsletter','{}','json',?,?)`).run('1'.repeat(32), '2026-08-04T01:00:00.000Z');
    await expect(readNewsletterSettings({ db })).rejects.toMatchObject({
      code: 'SITE_NEWSLETTER_SETTINGS_DATA_INVALID',
    });
  });
});

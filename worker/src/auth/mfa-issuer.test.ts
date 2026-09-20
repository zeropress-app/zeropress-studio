import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { sqliteD1 } from '../test-helpers/sqlite-d1';
import { readMfaIssuer, resolveMfaIssuer } from './mfa-issuer';

const requestUrl = 'https://studio.example.com:8443/api/auth/mfa/enrollment/setup';

describe('MFA issuer', () => {
  it.each([
    ['Margin', 'Margin · Studio'],
    ['ZeroPress', 'ZeroPress · Studio'],
    ['  Margin: Notes\n & Ideas  ', 'Margin： Notes & Ideas · Studio'],
    ['매거진', '매거진 · Studio'],
    ['', 'studio.example.com · Studio'],
    ['\n\t', 'studio.example.com · Studio'],
    ['\u0000', 'studio.example.com · Studio'],
    ['x'.repeat(201), 'studio.example.com · Studio'],
    [undefined, 'studio.example.com · Studio'],
  ])('formats the saved title %j with a hostname fallback', (siteTitle, expected) => {
    expect(resolveMfaIssuer({ requestUrl, siteTitle })).toBe(expected);
  });

  it.each([
    ['http://localhost:5173/', 'localhost · Studio'],
    ['http://127.0.0.1:5173/', '127.0.0.1 · Studio'],
    ['http://[::1]:5173/', '[：：1] · Studio'],
  ])('uses a label-safe local hostname for %s', (url, expected) => {
    expect(resolveMfaIssuer({ requestUrl: url })).toBe(expected);
  });
});

describe('Stored MFA issuer', () => {
  let database: DatabaseSync;
  afterEach(() => database?.close());

  function createDatabase() {
    database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT, type TEXT)
    `);
    return sqliteD1(database);
  }

  it('uses the hostname until a title is saved, including a deliberately saved default title', async () => {
    const db = createDatabase();
    await expect(readMfaIssuer({ db, requestUrl }))
      .resolves.toBe('studio.example.com · Studio');

    const writeTitle = database.prepare(`
      INSERT OR REPLACE INTO site_settings (key, value, type)
      VALUES ('site_title', ?, 'string')
    `);
    for (const title of ['Margin', 'ZeroPress']) {
      writeTitle.run(title);
      await expect(readMfaIssuer({ db, requestUrl }))
        .resolves.toBe(`${title} · Studio`);
    }
  });

  it('falls back to the Studio hostname when the saved value has the wrong type', async () => {
    const db = createDatabase();
    database.exec(`
      INSERT INTO site_settings VALUES ('site_title', 'true', 'boolean');
      INSERT INTO site_settings VALUES ('site_url', 'https://public.example.com', 'string')
    `);
    await expect(readMfaIssuer({ db, requestUrl }))
      .resolves.toBe('studio.example.com · Studio');
  });

  it('keeps account recovery available when title lookup fails', async () => {
    const db = createDatabase();
    const failingDb = sqliteD1(database, { failSqlOnce: 'FROM site_settings' });
    await expect(readMfaIssuer({ db: failingDb, requestUrl }))
      .resolves.toBe('studio.example.com · Studio');
    await expect(readMfaIssuer({ db, requestUrl }))
      .resolves.toBe('studio.example.com · Studio');
  });
});

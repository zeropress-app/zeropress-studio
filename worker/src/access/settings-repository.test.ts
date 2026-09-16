import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SETTINGS_INITIAL_REVISION } from '../../../contracts/settings-revision';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readCloudflareAccessSettings,
  recoverCloudflareAccessDisabled,
  updateCloudflareAccessSettings,
} from './settings-repository';

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
      this.database.prepare(this.sql).run as (...params: unknown[]) =>
        SqliteRunResult
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
const NOW = new Date('2026-08-28T00:00:00.000Z');

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

describe('Cloudflare Access settings repository', () => {
  it('treats two missing rows as the backward-compatible disabled state', async () => {
    const { d1 } = createTestDatabase();
    await expect(readCloudflareAccessSettings({ db: d1 })).resolves.toEqual({
      settings: {
        mode: 'disabled',
        issuer: null,
        audience: null,
        bound_origin: null,
        verified_at_iso: null,
      },
      revision: SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    });
  });

  it('round-trips one required document through an atomic revision write', async () => {
    const { database, d1 } = createTestDatabase();
    seedUser(database);
    const settings = {
      mode: 'required' as const,
      issuer: 'https://zeropress.cloudflareaccess.com',
      audience: 'a'.repeat(64),
      bound_origin: 'https://studio.example.com',
      verified_at_iso: NOW.toISOString(),
    };
    const result = await updateCloudflareAccessSettings({
      db: d1,
      settings,
      expectedRevision: SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '3'.repeat(32),
    });
    expect(result).toEqual({
      kind: 'completed',
      document: {
        settings,
        revision: '3'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    });
    await expect(readCloudflareAccessSettings({ db: d1 })).resolves.toEqual(
      result.kind === 'completed' ? result.document : null,
    );
  });

  it('fails closed for partial or malformed persisted documents', async () => {
    const { database, d1 } = createTestDatabase();
    database.prepare(`
      INSERT INTO studio_settings (key, value, type, updated_at_iso)
      VALUES ('cloudflare_access_requirement', '{', 'json', ?)
    `).run(NOW.toISOString());
    await expect(readCloudflareAccessSettings({ db: d1 }))
      .rejects.toMatchObject({
        code: 'CLOUDFLARE_ACCESS_SETTINGS_DATA_INVALID',
      } satisfies Partial<StudioOperationalError>);
  });

  it('replaces a corrupt document with one canonical disabled document', async () => {
    const { database, d1 } = createTestDatabase();
    database.prepare(`
      INSERT INTO studio_settings (key, value, type, updated_at_iso)
      VALUES
        ('cloudflare_access_requirement', '{', 'json', ?),
        ('cloudflare_access_revision', 'broken', 'string', ?)
    `).run(NOW.toISOString(), NOW.toISOString());

    await expect(recoverCloudflareAccessDisabled({
      db: d1,
      now: NOW,
      createRevision: () => '4'.repeat(32),
    })).resolves.toMatchObject({
      settings: { mode: 'disabled' },
      revision: '4'.repeat(32),
    });
    await expect(readCloudflareAccessSettings({ db: d1 })).resolves
      .toMatchObject({
        settings: { mode: 'disabled' },
        revision: '4'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      });
  });
});

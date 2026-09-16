import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readEdgeSecuritySettings,
  updateEdgeSecuritySettings,
} from './edge-security-settings-repository';

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

  async first<T>(): Promise<T | null> {
    const value = (
      this.database.prepare(this.sql).get as (...params: unknown[]) => T
    )(...this.params);
    return value ?? null;
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
}

function createTestDatabase(input: { seed?: boolean } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE edge_runtime_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      comment_write_verification_mode TEXT NOT NULL DEFAULT 'pow'
        CHECK (comment_write_verification_mode IN ('pow', 'turnstile')),
      newsletter_subscribe_verification_mode TEXT NOT NULL DEFAULT 'pow'
        CHECK (newsletter_subscribe_verification_mode IN ('pow', 'turnstile')),
      form_submit_verification_mode TEXT NOT NULL DEFAULT 'pow'
        CHECK (form_submit_verification_mode IN ('pow', 'turnstile')),
      turnstile_sitekey TEXT,
      ip_address_retention_days INTEGER NOT NULL DEFAULT 30,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (
          comment_write_verification_mode = 'pow' AND
          newsletter_subscribe_verification_mode = 'pow' AND
          form_submit_verification_mode = 'pow'
        ) OR turnstile_sitekey IS NOT NULL
      )
    )
  `);
  if (input.seed !== false) {
    database.prepare(`
      INSERT INTO edge_runtime_settings (
        id, created_at, updated_at
      ) VALUES (1, ?, ?)
    `).run('2026-08-05T01:00:00Z', '2026-08-05T01:00:00Z');
  }
  const d1 = {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql);
    },
  } as unknown as D1Database;
  return { database, d1 };
}

describe('Edge public request security D1 repository', () => {
  it('reads the canonical Edge singleton without exposing a secret', async () => {
    const { d1 } = createTestDatabase();
    const document = await readEdgeSecuritySettings({ edgeDb: d1 });
    expect(document).toEqual({
      settings: {
        comment_write_verification_mode: 'pow',
        newsletter_subscribe_verification_mode: 'pow',
        form_submit_verification_mode: 'pow',
        turnstile_sitekey: null,
        ip_address_retention_days: 30,
      },
      revision: expect.stringMatching(/^[0-9a-f]{32}$/u),
      updated_at_iso: '2026-08-05T01:00:00Z',
    });
    expect(JSON.stringify(document)).not.toContain('TURNSTILE_SECRET_KEY');
  });

  it('updates one revision-bound document and rejects a stale write', async () => {
    const { database, d1 } = createTestDatabase();
    const before = await readEdgeSecuritySettings({ edgeDb: d1 });
    const settings = {
      comment_write_verification_mode: 'turnstile' as const,
      newsletter_subscribe_verification_mode: 'pow' as const,
      form_submit_verification_mode: 'turnstile' as const,
      turnstile_sitekey: '0x4AAAAA-test',
      ip_address_retention_days: 45,
    };
    const result = await updateEdgeSecuritySettings({
      edgeDb: d1,
      settings,
      expectedRevision: before.revision,
      now: new Date('2026-08-05T02:00:00.000Z'),
    });
    expect(result).toMatchObject({
      kind: 'completed',
      document: {
        settings,
        updated_at_iso: '2026-08-05T02:00:00Z',
      },
    });
    expect(database.prepare(`
      SELECT turnstile_sitekey, ip_address_retention_days
      FROM edge_runtime_settings WHERE id = 1
    `).get()).toEqual({
      turnstile_sitekey: '0x4AAAAA-test',
      ip_address_retention_days: 45,
    });
    await expect(updateEdgeSecuritySettings({
      edgeDb: d1,
      settings: { ...settings, ip_address_retention_days: 60 },
      expectedRevision: before.revision,
    })).resolves.toEqual({ kind: 'revision_conflict' });
  });

  it('fails closed when the Edge singleton or schema is unavailable', async () => {
    const missing = createTestDatabase({ seed: false });
    await expect(readEdgeSecuritySettings({ edgeDb: missing.d1 }))
      .rejects.toMatchObject({
        code: 'EDGE_SECURITY_SETTINGS_DATA_INVALID',
      } satisfies Partial<StudioOperationalError>);

    const database = new DatabaseSync(':memory:');
    const unavailable = {
      prepare(sql: string) {
        return new SqliteD1Statement(database, sql);
      },
    } as unknown as D1Database;
    await expect(readEdgeSecuritySettings({ edgeDb: unavailable }))
      .rejects.toMatchObject({
        code: 'EDGE_SECURITY_SETTINGS_DATABASE_QUERY_FAILED',
      } satisfies Partial<StudioOperationalError>);
  });
});

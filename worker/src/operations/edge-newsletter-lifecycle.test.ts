import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  clearEdgeNewsletterContent,
  resetEdgeNewsletterRuntime,
} from './edge-newsletter-lifecycle';

type SqliteRunResult = { changes: number | bigint };

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly parameters: unknown[] = [],
  ) {}

  bind(...parameters: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, parameters);
  }

  async run(): Promise<D1Result<unknown>> {
    if (/^\s*SELECT\b/iu.test(this.sql)) {
      return this.all();
    }
    const result = (
      this.database.prepare(this.sql).run as (...values: unknown[]) =>
        SqliteRunResult
    )(...this.parameters);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = (
      this.database.prepare(this.sql).all as (...values: unknown[]) => T[]
    )(...this.parameters);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    const row = (
      this.database.prepare(this.sql).get as (...values: unknown[]) =>
        T | undefined
    )(...this.parameters);
    return row ?? null;
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results: D1Result<unknown>[] = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function seededDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE edge_mail_settings (
      id INTEGER PRIMARY KEY,
      newsletter_confirmation_enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE newsletter_lists (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE newsletter_fields (
      id TEXT PRIMARY KEY,
      newsletter_id TEXT NOT NULL REFERENCES newsletter_lists(id)
        ON DELETE CASCADE,
      field_key TEXT NOT NULL,
      label TEXT NOT NULL,
      type TEXT NOT NULL,
      required INTEGER NOT NULL,
      options_json TEXT,
      sort_order INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE newsletter_subscribers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE newsletter_subscriptions (
      id TEXT PRIMARY KEY,
      newsletter_id TEXT NOT NULL REFERENCES newsletter_lists(id)
        ON DELETE CASCADE,
      subscriber_id TEXT NOT NULL REFERENCES newsletter_subscribers(id)
        ON DELETE CASCADE,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE newsletter_field_values (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES newsletter_subscriptions(id)
        ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES newsletter_fields(id)
        ON DELETE CASCADE,
      field_value TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE newsletter_deliveries (
      id TEXT PRIMARY KEY,
      newsletter_id TEXT NOT NULL REFERENCES newsletter_lists(id)
        ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES newsletter_subscriptions(id)
        ON DELETE CASCADE
    );
    CREATE TABLE newsletter_suppressions (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO edge_mail_settings VALUES (
      1, 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
    );
    INSERT INTO newsletter_lists VALUES (
      '11111111111111111111111111111111', 'default', 'Custom title',
      'Description', 'active', '2026-08-01T00:00:00Z',
      '2026-08-01T00:00:00Z'
    );
    INSERT INTO newsletter_lists VALUES (
      '22222222222222222222222222222222', 'second', 'Second', NULL,
      'archived', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
    );
    INSERT INTO newsletter_fields VALUES (
      '33333333333333333333333333333333',
      '11111111111111111111111111111111', 'name', 'Name', 'text', 0,
      NULL, 0, 'active', '2026-08-01T00:00:00Z',
      '2026-08-01T00:00:00Z'
    );
    INSERT INTO newsletter_subscribers VALUES (
      '44444444444444444444444444444444', 'reader@example.com',
      '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
    );
    INSERT INTO newsletter_subscriptions VALUES (
      '55555555555555555555555555555555',
      '11111111111111111111111111111111',
      '44444444444444444444444444444444', 'subscribed',
      '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
    );
    INSERT INTO newsletter_field_values VALUES (
      '66666666666666666666666666666666',
      '55555555555555555555555555555555',
      '33333333333333333333333333333333', 'Reader',
      '2026-08-01T00:00:00Z'
    );
    INSERT INTO newsletter_deliveries VALUES (
      '88888888888888888888888888888888',
      '11111111111111111111111111111111',
      '55555555555555555555555555555555'
    );
    INSERT INTO newsletter_suppressions VALUES (
      '77777777777777777777777777777777', 'blocked@example.com',
      'manual', 'studio', NULL, '2026-08-01T00:00:00Z'
    );
  `);
  return database;
}

describe('Edge Newsletter maintenance lifecycle', () => {
  it('clears subscriber data while preserving delivery safety and list configuration', async () => {
    const database = seededDatabase();
    const result = await clearEdgeNewsletterContent({ edgeDb: d1(database) });

    expect(result.deletedRows).toEqual({
      'EDGE_DB.newsletter_deliveries': 1,
      'EDGE_DB.newsletter_field_values': 1,
      'EDGE_DB.newsletter_subscriptions': 1,
      'EDGE_DB.newsletter_subscribers': 1,
    });
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM newsletter_lists) AS lists,
        (SELECT COUNT(*) FROM newsletter_fields) AS fields,
        (SELECT COUNT(*) FROM newsletter_suppressions) AS suppressions,
        (SELECT newsletter_confirmation_enabled FROM edge_mail_settings
          WHERE id = 1) AS confirmation
    `).get()).toEqual({ lists: 2, fields: 1, suppressions: 1, confirmation: 1 });
    database.close();
  });

  it('resets to one default list and disables Newsletter confirmation', async () => {
    const database = seededDatabase();
    const result = await resetEdgeNewsletterRuntime({
      edgeDb: d1(database),
      now: new Date('2026-08-04T02:03:04.000Z'),
    });

    expect(result.deletedRows).toEqual({
      'EDGE_DB.newsletter_deliveries': 1,
      'EDGE_DB.newsletter_field_values': 1,
      'EDGE_DB.newsletter_subscriptions': 1,
      'EDGE_DB.newsletter_subscribers': 1,
      'EDGE_DB.newsletter_fields': 1,
      'EDGE_DB.newsletter_lists': 2,
      'EDGE_DB.newsletter_suppressions': 1,
    });
    expect(result.insertedRows).toEqual({ 'EDGE_DB.newsletter_lists': 1 });
    expect(result.updatedRows).toEqual({ 'EDGE_DB.edge_mail_settings': 1 });
    expect(database.prepare(`
      SELECT slug, title, description, status, created_at, updated_at
      FROM newsletter_lists
    `).get()).toEqual({
      slug: 'default',
      title: 'Newsletter',
      description: null,
      status: 'active',
      created_at: '2026-08-04T02:03:04Z',
      updated_at: '2026-08-04T02:03:04Z',
    });
    expect(database.prepare(`
      SELECT newsletter_confirmation_enabled
      FROM edge_mail_settings WHERE id = 1
    `).get()).toEqual({
      newsletter_confirmation_enabled: 0,
    });
    database.close();
  });

  it('wraps a missing Edge Newsletter schema as an operational failure', async () => {
    const database = new DatabaseSync(':memory:');
    await expect(clearEdgeNewsletterContent({ edgeDb: d1(database) }))
      .rejects.toMatchObject({
        code: 'MAINTENANCE_EDGE_NEWSLETTER_LIFECYCLE_FAILED',
        operationalMetadata: {
          resource: 'EDGE_DB',
          action: 'clear_edge_newsletter_content',
          phase: 'mutation',
        },
      });
    database.close();
  });
});

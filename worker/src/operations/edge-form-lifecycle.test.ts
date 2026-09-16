import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  clearEdgeFormContent,
  resetEdgeFormRuntime,
} from './edge-form-lifecycle';

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
    if (/^\s*SELECT\b/iu.test(this.sql)) return this.all();
    const result = (
      this.database.prepare(this.sql).run as (...values: unknown[]) => SqliteRunResult
    )(...this.parameters);
    return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result<unknown>;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = (
      this.database.prepare(this.sql).all as (...values: unknown[]) => T[]
    )(...this.parameters);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    const result = (
      this.database.prepare(this.sql).get as (...values: unknown[]) => T | undefined
    )(...this.parameters);
    return result ?? null;
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) { return new SqliteD1Statement(database, sql); },
    async batch(statements: SqliteD1Statement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const output: D1Result<unknown>[] = [];
        for (const statement of statements) output.push(await statement.run());
        database.exec('COMMIT');
        return output;
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
    CREATE TABLE forms (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
      description TEXT, status TEXT NOT NULL, submit_label TEXT NOT NULL,
      success_message TEXT, notification_recipient_user_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE form_fields (
      id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
      field_key TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL,
      required INTEGER NOT NULL, placeholder TEXT, help_text TEXT,
      options_json TEXT, sort_order INTEGER NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE form_submissions (
      id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
      status TEXT NOT NULL, submitted_at TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE form_submission_values (
      id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
      field_id TEXT REFERENCES form_fields(id) ON DELETE SET NULL,
      field_key TEXT NOT NULL, field_label TEXT NOT NULL, field_type TEXT NOT NULL,
      field_value TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO edge_mail_settings VALUES (1, 1, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO forms VALUES ('11111111111111111111111111111111', 'contact', 'Contact', NULL, 'active', 'Send', NULL, 'owner@example.com', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO form_fields VALUES ('22222222222222222222222222222222', '11111111111111111111111111111111', 'message', 'Message', 'textarea', 1, NULL, NULL, '[]', 0, 'active', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO form_submissions VALUES ('33333333333333333333333333333333', '11111111111111111111111111111111', 'unread', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO form_submission_values VALUES ('44444444444444444444444444444444', '33333333333333333333333333333333', '22222222222222222222222222222222', 'message', 'Message', 'textarea', 'Hello', '2026-08-01T00:00:00Z');
  `);
  return database;
}

describe('Edge Form maintenance lifecycle', () => {
  it('clears submissions while preserving definitions and their recipient', async () => {
    const database = seededDatabase();
    const result = await clearEdgeFormContent({ edgeDb: d1(database) });
    expect(result.deletedRows).toEqual({
      'EDGE_DB.form_submission_values': 1,
      'EDGE_DB.form_submissions': 1,
    });
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM forms) AS forms,
        (SELECT COUNT(*) FROM form_fields) AS fields,
        (SELECT notification_recipient_user_id FROM forms LIMIT 1) AS recipient
    `).get()).toEqual({
      forms: 1,
      fields: 1,
      recipient: 'owner@example.com',
    });
    database.close();
  });

  it('removes every definition without creating a default', async () => {
    const database = seededDatabase();
    const result = await resetEdgeFormRuntime({
      edgeDb: d1(database),
    });
    expect(result.deletedRows).toEqual({
      'EDGE_DB.form_submission_values': 1,
      'EDGE_DB.form_submissions': 1,
      'EDGE_DB.form_fields': 1,
      'EDGE_DB.forms': 1,
    });
    expect(result.insertedRows).toEqual({});
    expect(result.updatedRows).toEqual({});
    expect(database.prepare(`
      SELECT newsletter_confirmation_enabled
      FROM edge_mail_settings WHERE id = 1
    `).get()).toEqual({
      newsletter_confirmation_enabled: 1,
    });
    database.close();
  });

  it('wraps a missing Edge Form schema as an operational failure', async () => {
    const database = new DatabaseSync(':memory:');
    await expect(clearEdgeFormContent({ edgeDb: d1(database) })).rejects.toMatchObject({
      code: 'MAINTENANCE_EDGE_FORM_LIFECYCLE_FAILED',
      operationalMetadata: {
        resource: 'EDGE_DB',
        action: 'clear_edge_form_content',
        phase: 'mutation',
      },
    });
    database.close();
  });
});

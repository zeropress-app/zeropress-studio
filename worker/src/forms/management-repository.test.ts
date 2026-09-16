import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  deleteForm,
  getFormSubmission,
  listFormNotificationRecipientCandidates,
  listFormFields,
  listFormSubmissions,
  listForms,
  readFormNotificationSettings,
  replaceFormFields,
  updateFormSubmission,
  updateFormNotificationSettings,
} from './management-repository';

type SqliteRunResult = { changes: number | bigint };
class SqliteD1Statement {
  constructor(readonly database: DatabaseSync, readonly sql: string, readonly parameters: unknown[] = []) {}
  bind(...parameters: unknown[]) { return new SqliteD1Statement(this.database, this.sql, parameters); }
  async run(): Promise<D1Result<unknown>> {
    if (/^\s*SELECT\b/iu.test(this.sql)) return this.all();
    const result = (this.database.prepare(this.sql).run as (...values: unknown[]) => SqliteRunResult)(...this.parameters);
    return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result<unknown>;
  }
  async all<T>(): Promise<D1Result<T>> {
    const results = (this.database.prepare(this.sql).all as (...values: unknown[]) => T[])(...this.parameters);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }
  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get as (...values: unknown[]) => T | undefined)(...this.parameters) ?? null;
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
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  } as unknown as D1Database;
}

const FORM_ID = '1'.repeat(32);
const FIELD_ID = '2'.repeat(32);
const UNUSED_FIELD_ID = '3'.repeat(32);
const SUBMISSION_ID = '4'.repeat(32);
const VALUE_ID = '5'.repeat(32);
const RECIPIENT_ID = 'a'.repeat(32);
const AUTHOR_ID = 'b'.repeat(32);
const NOW = '2026-08-01T00:00:00Z';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
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
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(form_id, field_key)
    );
    CREATE TABLE form_submissions (
      id TEXT PRIMARY KEY, form_id TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
      status TEXT NOT NULL, summary TEXT, submitter_email TEXT,
      submitter_name TEXT, source_url TEXT, ip_address TEXT,
      ip_address_recorded_at TEXT, ip_hash TEXT, asn INTEGER,
      as_organization TEXT, country_code TEXT, user_agent TEXT,
      submitted_at TEXT NOT NULL, read_at TEXT, archived_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE form_submission_values (
      id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES form_submissions(id) ON DELETE CASCADE,
      field_id TEXT REFERENCES form_fields(id) ON DELETE SET NULL,
      field_key TEXT NOT NULL, field_label TEXT NOT NULL, field_type TEXT NOT NULL,
      field_value TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO forms VALUES ('${FORM_ID}', 'contact', 'Contact', 'Description', 'active', 'Send', 'Thanks', '${RECIPIENT_ID}', '${NOW}', '${NOW}');
    INSERT INTO form_fields VALUES ('${FIELD_ID}', '${FORM_ID}', 'message', 'Message', 'textarea', 1, NULL, NULL, '[]', 0, 'active', '${NOW}', '${NOW}');
    INSERT INTO form_fields VALUES ('${UNUSED_FIELD_ID}', '${FORM_ID}', 'topic', 'Topic', 'text', 0, NULL, NULL, '[]', 1, 'active', '${NOW}', '${NOW}');
    INSERT INTO form_submissions VALUES ('${SUBMISSION_ID}', '${FORM_ID}', 'unread', 'Hello', 'reader@example.com', 'Reader', 'https://example.com/contact?secret=yes#fragment', '203.0.113.7', '${NOW}', 'hash', 64500, 'Example ASN', 'KR', 'private-agent', '${NOW}', NULL, NULL, '${NOW}', '${NOW}');
    INSERT INTO form_submission_values VALUES ('${VALUE_ID}', '${SUBMISSION_ID}', '${FIELD_ID}', 'message', 'Message', 'textarea', 'Hello world', '${NOW}');
  `);
  return sqlite;
}

function studioDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      email_verified INTEGER NOT NULL
    );
    CREATE TABLE user_roles (
      user_id TEXT NOT NULL,
      role_key TEXT NOT NULL
    );
    INSERT INTO users VALUES (
      '${RECIPIENT_ID}', 'editor@example.com', 'Editor', 'active', 1
    );
    INSERT INTO user_roles VALUES ('${RECIPIENT_ID}', 'editor');
    INSERT INTO users VALUES (
      '${AUTHOR_ID}', 'author@example.com', 'Author', 'active', 1
    );
    INSERT INTO user_roles VALUES ('${AUTHOR_ID}', 'author');
  `);
  return sqlite;
}

describe('Form management repository', () => {
  it('returns bounded summaries and strips sensitive source URL components', async () => {
    const sqlite = database();
    const forms = await listForms({ edgeDb: d1(sqlite), query: { status: 'all', search: '', page: 1, per_page: 20 } });
    expect(forms.items[0]).toMatchObject({
      id: FORM_ID,
      fields_count: 2,
      submissions_count: 1,
      unread_count: 1,
    });
    const detail = await getFormSubmission({ edgeDb: d1(sqlite), formId: FORM_ID, submissionId: SUBMISSION_ID });
    expect(detail).toMatchObject({
      source_url: 'https://example.com/contact',
      country_code: 'KR',
      values: [{ field_id: FIELD_ID, label: 'Message', value: 'Hello world' }],
    });
    expect(detail).not.toHaveProperty('ip_address');
    expect(detail).not.toHaveProperty('user_agent');
    expect(detail).not.toHaveProperty('asn');
    sqlite.close();
  });

  it('preserves used field identity and rejects destructive history changes', async () => {
    const sqlite = database();
    const edgeDb = d1(sqlite);
    const fields = await listFormFields({ edgeDb, formId: FORM_ID });
    expect(fields?.items.map((field) => field.id)).toEqual([FIELD_ID, UNUSED_FIELD_ID]);
    const invalidRename = await replaceFormFields({
      edgeDb,
      formId: FORM_ID,
      request: {
        expected_updated_at_iso: '2026-08-01T00:00:00.000Z',
        fields: [{
          id: FIELD_ID, field_key: 'body', label: 'Message', type: 'textarea',
          required: true, placeholder: null, help_text: null, options: [],
          sort_order: 0, status: 'active',
        }],
      },
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(invalidRename).toEqual({ kind: 'invalid' });
    const valid = await replaceFormFields({
      edgeDb,
      formId: FORM_ID,
      request: {
        expected_updated_at_iso: '2026-08-01T00:00:00.000Z',
        fields: [{
          id: FIELD_ID, field_key: 'message', label: 'Your message', type: 'textarea',
          required: true, placeholder: null, help_text: 'Be concise', options: [],
          sort_order: 0, status: 'active',
        }],
      },
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(valid.kind).toBe('completed');
    expect(sqlite.prepare('SELECT id, label FROM form_fields ORDER BY id').all()).toEqual([
      { id: FIELD_ID, label: 'Your message' },
    ]);
    expect(sqlite.prepare('SELECT field_id FROM form_submission_values').get()).toEqual({ field_id: FIELD_ID });
    sqlite.close();
  });

  it('keeps status counts independent from the active submission filter', async () => {
    const sqlite = database();
    sqlite.prepare(`INSERT INTO form_submissions (
      id, form_id, status, submitted_at, created_at, updated_at
    ) VALUES (?, ?, 'archived', ?, ?, ?)`)
      .run('6'.repeat(32), FORM_ID, NOW, NOW, NOW);
    const result = await listFormSubmissions({
      edgeDb: d1(sqlite), formId: FORM_ID,
      query: { status: 'unread', page: 1, per_page: 20 },
    });
    expect(result).toMatchObject({
      pagination: { total: 1 },
      status_counts: { all: 2, unread: 1, read: 0, archived: 1, spam: 0 },
    });
    sqlite.close();
  });

  it('uses optimistic revisions for moderation and prevents deleting a non-empty Form', async () => {
    const sqlite = database();
    const edgeDb = d1(sqlite);
    const stale = await updateFormSubmission({
      edgeDb, formId: FORM_ID, submissionId: SUBMISSION_ID, status: 'read',
      expectedUpdatedAtIso: '2026-07-01T00:00:00.000Z',
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(stale).toEqual({ kind: 'revision_conflict' });
    const updated = await updateFormSubmission({
      edgeDb, formId: FORM_ID, submissionId: SUBMISSION_ID, status: 'read',
      expectedUpdatedAtIso: '2026-08-01T00:00:00.000Z',
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(updated).toMatchObject({ kind: 'completed', value: { status: 'read', read_at_iso: '2026-08-02T00:00:00.000Z' } });
    await expect(deleteForm({ edgeDb, id: FORM_ID, expectedUpdatedAtIso: '2026-08-01T00:00:00.000Z' }))
      .resolves.toEqual({ kind: 'has_submissions' });
    sqlite.close();
  });

  it('lists eligible Studio Users and saves a recipient without Mail configured', async () => {
    const edgeSqlite = database();
    const studioSqlite = studioDatabase();
    const edgeDb = d1(edgeSqlite);
    const db = d1(studioSqlite);
    await expect(listFormNotificationRecipientCandidates({
      db,
      query: { search: '', page: 1, per_page: 20 },
    })).resolves.toMatchObject({
      items: [{ id: RECIPIENT_ID, email: 'editor@example.com' }],
      pagination: { total: 1 },
    });
    await expect(readFormNotificationSettings({
      db, edgeDb, formId: FORM_ID, mailConfigured: false,
    })).resolves.toMatchObject({
      mail_configured: false,
      recipient: { state: 'available', id: RECIPIENT_ID },
    });
    await expect(updateFormNotificationSettings({
      db,
      edgeDb,
      formId: FORM_ID,
      request: {
        recipient_user_id: null,
        expected_updated_at_iso: '2026-08-01T00:00:00.000Z',
      },
      mailConfigured: false,
      now: new Date('2026-08-02T00:00:00.000Z'),
    })).resolves.toMatchObject({
      kind: 'completed',
      value: { recipient: null, mail_configured: false },
    });
    await expect(updateFormNotificationSettings({
      db,
      edgeDb,
      formId: FORM_ID,
      request: {
        recipient_user_id: AUTHOR_ID,
        expected_updated_at_iso: '2026-08-02T00:00:00.000Z',
      },
      mailConfigured: true,
      now: new Date('2026-08-03T00:00:00.000Z'),
    })).resolves.toEqual({ kind: 'recipient_unavailable' });
    edgeSqlite.close();
    studioSqlite.close();
  });

  it('fails closed when stored Form field flags are malformed', async () => {
    const sqlite = database();
    const edgeDb = d1(sqlite);
    sqlite.prepare('UPDATE form_fields SET required = 2 WHERE id = ?')
      .run(FIELD_ID);
    await expect(listFormFields({ edgeDb, formId: FORM_ID })).rejects.toMatchObject({
      code: 'FORM_MANAGEMENT_DATA_INVALID',
    });
    sqlite.close();
  });
});

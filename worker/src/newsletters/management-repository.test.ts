import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  createNewsletterSuppression,
  exportNewsletterSubscriptions,
  listNewsletterDeliveries,
  listNewsletterFields,
  listNewsletterSubscriptions,
  listNewsletters,
  readNewsletterRuntime,
  replaceNewsletterFields,
  disableNewsletterRuntime,
  updateNewsletterRuntime,
} from './management-repository';

type SqliteRunResult = { changes: number | bigint };

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly parameters: unknown[] = [],
  ) {}

  bind(...parameters: unknown[]) {
    if (parameters.length > 100) {
      throw new RangeError('Simulated D1 bound-parameter limit exceeded.');
    }
    return new SqliteD1Statement(this.database, this.sql, parameters);
  }

  async run(): Promise<D1Result<unknown>> {
    if (/^\s*SELECT\b/iu.test(this.sql)) return this.all();
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
    const result = (
      this.database.prepare(this.sql).get as (...values: unknown[]) =>
        T | undefined
    )(...this.parameters);
    return result ?? null;
  }
}

function d1(
  database: DatabaseSync,
  beforeBatch?: () => void,
  onPrepare?: (sql: string) => void,
): D1Database {
  return {
    prepare(sql: string) {
      onPrepare?.(sql);
      return new SqliteD1Statement(database, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      beforeBatch?.();
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

const LIST_ID = '1'.repeat(32);
const FIELD_ID = '2'.repeat(32);
const SUBSCRIBER_ID = '3'.repeat(32);
const SUBSCRIPTION_ID = '4'.repeat(32);
const DELIVERY_ID = '6'.repeat(32);
const POST_ID = '7'.repeat(32);
const NOW = '2026-08-01T00:00:00Z';

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE edge_mail_settings (
      id INTEGER PRIMARY KEY,
      newsletter_confirmation_enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE newsletter_lists (
      id TEXT PRIMARY KEY,
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
      updated_at TEXT NOT NULL,
      UNIQUE(newsletter_id, field_key)
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
      confirm_token_hash TEXT,
      confirm_expires_at TEXT,
      confirm_sent_at TEXT,
      confirm_email_status TEXT NOT NULL,
      confirm_email_error TEXT,
      confirmed_at TEXT,
      subscribed_at TEXT,
      unsubscribed_at TEXT,
      source_url TEXT,
      ip_address TEXT,
      ip_address_recorded_at TEXT,
      ip_hash TEXT,
      user_agent TEXT,
      asn INTEGER,
      as_organization TEXT,
      country_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(newsletter_id, subscriber_id)
    );
    CREATE TABLE newsletter_field_values (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL REFERENCES newsletter_subscriptions(id)
        ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES newsletter_fields(id)
        ON DELETE CASCADE,
      field_value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(subscription_id, field_id)
    );
    CREATE TABLE newsletter_deliveries (
      id TEXT PRIMARY KEY,
      newsletter_id TEXT NOT NULL REFERENCES newsletter_lists(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES newsletter_subscriptions(id) ON DELETE CASCADE,
      delivery_type TEXT NOT NULL,
      content_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      subject TEXT,
      provider TEXT,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      failure_code TEXT,
      queued_at TEXT NOT NULL,
      last_attempt_at TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE newsletter_suppressions (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      source TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );
  `);
  sqlite.prepare('INSERT INTO edge_mail_settings VALUES (1, 0, ?, ?)')
    .run(NOW, NOW);
  sqlite.prepare(`
    INSERT INTO newsletter_lists
    VALUES (?, 'default', 'Newsletter', 'Updates', 'active', ?, ?)
  `).run(LIST_ID, NOW, NOW);
  sqlite.prepare(`
    INSERT INTO newsletter_fields
    VALUES (?, ?, 'name', 'Name', 'text', 0, NULL, 0, 'active', ?, ?)
  `).run(FIELD_ID, LIST_ID, NOW, NOW);
  sqlite.prepare(`
    INSERT INTO newsletter_subscribers VALUES (?, ?, ?, ?)
  `).run(SUBSCRIBER_ID, 'reader@example.com', NOW, NOW);
  sqlite.prepare(`
    INSERT INTO newsletter_subscriptions VALUES (
      ?, ?, ?, 'pending', 'token-hash', '2026-08-10T00:00:00Z', NULL,
      'not_sent', NULL, NULL, NULL, NULL,
      'https://example.com/post?private=query', '203.0.113.1', ?, 'hash',
      'Agent', 13335, 'Cloudflare', 'KR', ?, ?
    )
  `).run(SUBSCRIPTION_ID, LIST_ID, SUBSCRIBER_ID, NOW, NOW, NOW);
  sqlite.prepare(`
    INSERT INTO newsletter_field_values VALUES (?, ?, ?, ?, ?)
  `).run('5'.repeat(32), SUBSCRIPTION_ID, FIELD_ID, '=FORMULA()', NOW);
  sqlite.prepare(`
    INSERT INTO newsletter_deliveries VALUES (
      ?, ?, ?, 'confirmation', NULL, ?, 'Confirm your subscription',
      'resend', 'sent', 1, NULL, ?, ?, ?, ?, ?
    )
  `).run(
    DELIVERY_ID,
    LIST_ID,
    SUBSCRIPTION_ID,
    `newsletter-delivery-${DELIVERY_ID}`,
    NOW,
    NOW,
    NOW,
    NOW,
    NOW,
  );
  return sqlite;
}

describe('Newsletter management repository', () => {
  it('lists canonical list and subscription documents without URL query data', async () => {
    const sqlite = database();
    const preparedSql: string[] = [];
    const edgeDb = d1(sqlite, undefined, (sql) => preparedSql.push(sql));
    const lists = await listNewsletters({
      edgeDb,
      query: { status: 'all', search: '', page: 1, per_page: 20 },
    });
    expect(lists.items[0]).toMatchObject({
      id: LIST_ID,
      fields_count: 1,
      pending_count: 1,
    });
    const subscriptions = await listNewsletterSubscriptions({
      edgeDb,
      newsletterId: LIST_ID,
      query: { status: 'all', search: 'reader@', page: 1, per_page: 20 },
    });
    expect(subscriptions?.items[0]).toMatchObject({
      email: 'reader@example.com',
      source_url: 'https://example.com/post',
      country_code: 'KR',
    });
    expect(preparedSql.filter((sql) => (
      sql.includes('subscriber.email >= ?')
    ))).toHaveLength(2);
    expect(preparedSql.filter((sql) => (
      sql.includes('subscriber.email >= ?')
    )).every((sql) => sql.includes('CROSS JOIN newsletter_subscriptions')))
      .toBe(true);
    sqlite.close();
  });

  it('lists recipient-level delivery history with strict filters', async () => {
    const sqlite = database();
    const result = await listNewsletterDeliveries({
      edgeDb: d1(sqlite),
      newsletterId: LIST_ID,
      query: {
        status: 'sent',
        type: 'confirmation',
        search: 'reader@',
        page: 1,
        per_page: 20,
      },
    });
    expect(result).toEqual({
      items: [expect.objectContaining({
        id: DELIVERY_ID,
        email: 'reader@example.com',
        delivery_type: 'confirmation',
        status: 'sent',
        provider: 'resend',
        attempt_count: 1,
        failure_code: null,
      })],
      pagination: { page: 1, per_page: 20, total: 1, total_pages: 1 },
    });
    sqlite.close();
  });

  it('combines an exact Post filter with the existing delivery filters', async () => {
    const sqlite = database();
    sqlite.prepare(`
      UPDATE newsletter_deliveries
      SET delivery_type = 'post_notification',
          content_id = ?,
          subject = 'New post: Release notes'
      WHERE id = ?
    `).run(POST_ID, DELIVERY_ID);
    const matching = await listNewsletterDeliveries({
      edgeDb: d1(sqlite),
      newsletterId: LIST_ID,
      query: {
        status: 'sent',
        type: 'post_notification',
        content_id: POST_ID,
        search: 'reader@',
        page: 1,
        per_page: 20,
      },
    });
    expect(matching).toEqual({
      items: [expect.objectContaining({
        id: DELIVERY_ID,
        delivery_type: 'post_notification',
        content_id: POST_ID,
      })],
      pagination: { page: 1, per_page: 20, total: 1, total_pages: 1 },
    });

    const unrelated = await listNewsletterDeliveries({
      edgeDb: d1(sqlite),
      newsletterId: LIST_ID,
      query: {
        status: 'sent',
        type: 'post_notification',
        content_id: '8'.repeat(32),
        search: 'reader@',
        page: 1,
        per_page: 20,
      },
    });
    expect(unrelated).toEqual({
      items: [],
      pagination: { page: 1, per_page: 20, total: 0, total_pages: 0 },
    });
    sqlite.close();
  });

  it('preserves field identity and rejects semantic changes after use', async () => {
    const sqlite = database();
    const edgeDb = d1(sqlite);
    const before = await listNewsletterFields({ edgeDb, newsletterId: LIST_ID });
    const changed = await replaceNewsletterFields({
      edgeDb,
      newsletterId: LIST_ID,
      request: {
        expected_updated_at_iso: before!.newsletterUpdatedAtIso,
        fields: [{
          id: FIELD_ID,
          field_key: 'display_name',
          label: 'Name',
          type: 'text',
          required: false,
          options: [],
          sort_order: 0,
          status: 'active',
        }],
      },
      now: new Date('2026-08-04T00:00:00Z'),
    });
    expect(changed).toEqual({ kind: 'invalid' });
    expect((await listNewsletterFields({ edgeDb, newsletterId: LIST_ID }))
      ?.items[0]?.field_key).toBe('name');
    sqlite.close();
  });

  it('does not partially apply a stale aggregate field replacement', async () => {
    const sqlite = database();
    let simulatedConcurrentWrite = false;
    const edgeDb = d1(sqlite, () => {
      if (simulatedConcurrentWrite) return;
      simulatedConcurrentWrite = true;
      sqlite.prepare(`
        UPDATE newsletter_lists
        SET updated_at = '2026-08-03T00:00:00Z'
        WHERE id = ?
      `).run(LIST_ID);
    });
    const before = await listNewsletterFields({ edgeDb, newsletterId: LIST_ID });
    const result = await replaceNewsletterFields({
      edgeDb,
      newsletterId: LIST_ID,
      request: {
        expected_updated_at_iso: before!.newsletterUpdatedAtIso,
        fields: [{
          id: FIELD_ID,
          field_key: 'name',
          label: 'Changed by stale request',
          type: 'text',
          required: true,
          options: [],
          sort_order: 0,
          status: 'disabled',
        }],
      },
      now: new Date('2026-08-04T00:00:00Z'),
    });
    expect(result).toEqual({ kind: 'revision_conflict' });
    expect(sqlite.prepare(`
      SELECT label, required, status, updated_at
      FROM newsletter_fields WHERE id = ?
    `).get(FIELD_ID)).toEqual({
      label: 'Name',
      required: 0,
      status: 'active',
      updated_at: NOW,
    });
    sqlite.close();
  });

  it('chunks field upserts below the D1 100-parameter hard limit', async () => {
    const sqlite = database();
    const before = await listNewsletterFields({
      edgeDb: d1(sqlite),
      newsletterId: LIST_ID,
    });
    const fields = Array.from({ length: 9 }, (_, index) => ({
      field_key: `extra_${index}`,
      label: `Extra ${index}`,
      type: 'text' as const,
      required: false,
      options: [],
      sort_order: index,
      status: 'active' as const,
    }));
    const result = await replaceNewsletterFields({
      edgeDb: d1(sqlite),
      newsletterId: LIST_ID,
      request: {
        expected_updated_at_iso: before!.newsletterUpdatedAtIso,
        fields,
      },
      now: new Date('2026-08-04T00:00:00Z'),
    });
    expect(result.kind).toBe('completed');
    expect((await listNewsletterFields({
      edgeDb: d1(sqlite),
      newsletterId: LIST_ID,
    }))?.items).toHaveLength(10);
    sqlite.close();
  });

  it('adds a global suppression, invalidates current tokens, and unsubscribes', async () => {
    const sqlite = database();
    const result = await createNewsletterSuppression({
      edgeDb: d1(sqlite),
      request: { email: 'reader@example.com', note: 'Requested by owner' },
      now: new Date('2026-08-04T00:00:00Z'),
    });
    expect(result).toMatchObject({ created: true, unsubscribedCount: 1 });
    expect(sqlite.prepare(`
      SELECT status, confirm_token_hash, confirm_expires_at
      FROM newsletter_subscriptions WHERE id = ?
    `).get(SUBSCRIPTION_ID)).toEqual({
      status: 'unsubscribed',
      confirm_token_hash: null,
      confirm_expires_at: null,
    });
    sqlite.close();
  });

  it('gates confirmation runtime on a complete Studio mail configuration', async () => {
    const sqlite = database();
    const edgeDb = d1(sqlite);
    const runtime = await readNewsletterRuntime({
      edgeDb,
      mailConfigured: false,
    });
    expect(runtime).toMatchObject({
      confirmation_enabled: false,
      mail_configured: false,
      ready: false,
    });
    expect(await updateNewsletterRuntime({
      edgeDb,
      confirmationEnabled: true,
      expectedUpdatedAtIso: runtime.updated_at_iso,
      mailConfigured: false,
    })).toEqual({ kind: 'mail_not_configured' });
    const updated = await updateNewsletterRuntime({
      edgeDb,
      confirmationEnabled: true,
      expectedUpdatedAtIso: runtime.updated_at_iso,
      mailConfigured: true,
      now: new Date('2026-08-04T00:00:00Z'),
    });
    expect(updated).toMatchObject({
      kind: 'completed',
      value: { confirmation_enabled: true, ready: true },
    });
    sqlite.close();
  });

  it('retries a concurrent revision change while disabling runtime', async () => {
    const sqlite = database();
    sqlite.prepare(`
      UPDATE edge_mail_settings
      SET newsletter_confirmation_enabled = 1
      WHERE id = 1
    `).run();
    let firstUpdate = true;
    const edgeDb = {
      prepare(sql: string) {
        const statement = new SqliteD1Statement(sqlite, sql);
        if (!/UPDATE edge_mail_settings/u.test(sql)) return statement;
        return {
          bind(...parameters: unknown[]) {
            const bound = statement.bind(...parameters);
            return {
              async run() {
                if (firstUpdate) {
                  firstUpdate = false;
                  sqlite.prepare(`
                    UPDATE edge_mail_settings
                    SET updated_at = '2026-08-03T00:00:00Z'
                    WHERE id = 1
                  `).run();
                }
                return bound.run();
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await disableNewsletterRuntime({
      edgeDb,
      now: new Date('2026-08-04T00:00:00Z'),
    });
    expect(sqlite.prepare(`
      SELECT newsletter_confirmation_enabled FROM edge_mail_settings
      WHERE id = 1
    `).get()).toEqual({ newsletter_confirmation_enabled: 0 });
    sqlite.close();
  });

  it('exports bounded UTF-8 CSV and neutralizes spreadsheet formulas', async () => {
    const sqlite = database();
    sqlite.prepare(`
      UPDATE newsletter_field_values SET field_value = '  =FORMULA()'
    `).run();
    const result = await exportNewsletterSubscriptions({
      edgeDb: d1(sqlite),
      newsletterId: LIST_ID,
      query: { status: 'all' },
    });
    expect(result).not.toBeNull();
    const bytes = new Uint8Array(result!.byteCount);
    let offset = 0;
    for (const chunk of result!.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const csv = new TextDecoder().decode(bytes);
    expect(csv).toContain('"field:name"');
    expect(csv).toContain('"\'  =FORMULA()"');
    expect(result).toMatchObject({ rowCount: 1, truncated: false });
    sqlite.close();
  });
});

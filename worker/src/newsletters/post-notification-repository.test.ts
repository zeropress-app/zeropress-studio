import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { preparePostNotification } from './post-notification-repository';

class Statement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly parameters: SQLInputValue[] = [],
  ) {}

  bind(...parameters: SQLInputValue[]) {
    return new Statement(this.database, this.sql, parameters);
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.database.prepare(this.sql).run(...this.parameters);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.sql).get(...this.parameters) as T)
      ?? null;
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new Statement(database, sql);
    },
  } as unknown as D1Database;
}

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE newsletter_lists (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL
    );
    CREATE TABLE newsletter_subscribers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE
    );
    CREATE TABLE newsletter_subscriptions (
      id TEXT PRIMARY KEY,
      newsletter_id TEXT NOT NULL,
      subscriber_id TEXT NOT NULL,
      status TEXT NOT NULL,
      source_url TEXT
    );
    CREATE TABLE newsletter_suppressions (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE
    );
    CREATE TABLE newsletter_deliveries (
      id TEXT PRIMARY KEY,
      newsletter_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
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
  `);
  const listId = '1'.repeat(32);
  sqlite.prepare(`INSERT INTO newsletter_lists VALUES (?, 'default', 'active')`)
    .run(listId);
  for (const [index, status, email, source] of [
    ['2', 'subscribed', 'one@example.com', 'https://example.com/newsletter'],
    ['3', 'subscribed', 'blocked@example.com', 'https://example.com/newsletter'],
    ['4', 'pending', 'pending@example.com', 'https://example.com/newsletter'],
  ] as const) {
    sqlite.prepare('INSERT INTO newsletter_subscribers VALUES (?, ?)')
      .run(index.repeat(32), email);
    sqlite.prepare('INSERT INTO newsletter_subscriptions VALUES (?, ?, ?, ?, ?)')
      .run(index.repeat(32), listId, index.repeat(32), status, source);
  }
  sqlite.prepare('INSERT INTO newsletter_suppressions VALUES (?, ?)')
    .run('5'.repeat(32), 'blocked@example.com');
  return sqlite;
}

describe('Post newsletter notification materialization', () => {
  it('freezes only deliverable default subscribers and is idempotent per revision', async () => {
    const sqlite = database();
    const input = {
      edgeDb: d1(sqlite),
      postId: 'a'.repeat(32),
      postRevision: 'b'.repeat(32),
      subject: 'New post: Release notes',
      now: new Date('2026-09-03T00:00:00.000Z'),
    };

    await expect(preparePostNotification(input)).resolves.toMatchObject({
      kind: 'prepared',
      recipientCount: 1,
      newlyQueuedCount: 1,
      pendingCount: 1,
    });
    await expect(preparePostNotification(input)).resolves.toMatchObject({
      kind: 'prepared',
      recipientCount: 1,
      newlyQueuedCount: 0,
      pendingCount: 1,
    });
    expect(sqlite.prepare(`
      SELECT subscription_id, delivery_type, content_id, subject, status,
             attempt_count
      FROM newsletter_deliveries
    `).all()).toEqual([{
      subscription_id: '2'.repeat(32),
      delivery_type: 'post_notification',
      content_id: 'a'.repeat(32),
      subject: 'New post: Release notes',
      status: 'queued',
      attempt_count: 0,
    }]);
    sqlite.close();
  });

  it('does not materialize deliveries when the default list is archived', async () => {
    const sqlite = database();
    sqlite.prepare(`UPDATE newsletter_lists SET status = 'archived'`).run();
    await expect(preparePostNotification({
      edgeDb: d1(sqlite),
      postId: 'a'.repeat(32),
      postRevision: 'b'.repeat(32),
      subject: 'New post: Release notes',
      now: new Date('2026-09-03T00:00:00.000Z'),
    })).resolves.toEqual({ kind: 'unavailable' });
    sqlite.close();
  });
});

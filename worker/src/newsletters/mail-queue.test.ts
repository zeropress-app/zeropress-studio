import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import {
  EdgeMailQueueService,
  handleEdgeMailQueue,
} from './mail-queue';

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
    return ((
      this.database.prepare(this.sql).get as (...values: unknown[]) =>
        T | undefined
    )(...this.parameters)) ?? null;
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql);
    },
    async batch(statements: D1PreparedStatement[]) {
      const results = [];
      for (const statement of statements) {
        results.push(await (statement as unknown as SqliteD1Statement).run());
      }
      return results;
    },
  } as unknown as D1Database;
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Buffer.from(digest).toString('base64url');
}

async function database(
  token: string,
  listStatus: 'active' | 'archived' = 'active',
) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE newsletter_lists (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE newsletter_subscribers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL
    );
    CREATE TABLE newsletter_subscriptions (
      id TEXT PRIMARY KEY,
      newsletter_id TEXT NOT NULL,
      subscriber_id TEXT NOT NULL,
      status TEXT NOT NULL,
      confirm_token_hash TEXT,
      confirm_expires_at TEXT,
      confirm_sent_at TEXT,
      confirm_email_status TEXT NOT NULL,
      confirm_email_error TEXT,
      source_url TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE newsletter_deliveries (
      id TEXT PRIMARY KEY,
      newsletter_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      delivery_type TEXT NOT NULL,
      content_id TEXT,
      idempotency_key TEXT NOT NULL,
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
  sqlite.prepare(`
    INSERT INTO newsletter_lists
    VALUES (?, 'default', 'Product updates', 'Confirm to subscribe', ?)
  `).run('1'.repeat(32), listStatus);
  sqlite.prepare(`
    INSERT INTO newsletter_subscribers VALUES (?, 'reader@example.com')
  `).run('2'.repeat(32));
  sqlite.prepare(`
    INSERT INTO newsletter_subscriptions VALUES (
      ?, ?, ?, 'pending', ?, '2026-08-10T00:00:00Z', NULL,
      'not_sent', NULL, 'https://example.com/newsletter',
      '2026-08-01T00:00:00Z'
    )
  `).run(
    '3'.repeat(32),
    '1'.repeat(32),
    '2'.repeat(32),
    await tokenHash(token),
  );
  sqlite.prepare(`
    INSERT INTO newsletter_deliveries VALUES (
      ?, ?, ?, 'confirmation', NULL, ?, NULL, NULL, 'queued', 0,
      NULL, '2026-08-01T00:00:00Z', NULL, NULL,
      '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
    )
  `).run(
    '4'.repeat(32),
    '1'.repeat(32),
    '3'.repeat(32),
    `newsletter-delivery-${'4'.repeat(32)}`,
  );
  return sqlite;
}

function confirmationMessage(token: string) {
  return {
    contract_version: 1 as const,
    type: 'newsletter.confirmation' as const,
    delivery_id: '4'.repeat(32),
    subscription_id: '3'.repeat(32),
    token,
    unsubscribe_token: `nu1.${'3'.repeat(32)}`,
  };
}

function env(edgeDb: D1Database, studioDb = {} as D1Database): Env {
  return {
    DB: studioDb,
    EDGE_DB: edgeDb,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: { limit: vi.fn() },
    STUDIO_AUTH_SECRET:
      'test-auth-secret-value-with-at-least-32-characters',
  };
}

function formDatabases() {
  const edge = new DatabaseSync(':memory:');
  edge.exec(`
    CREATE TABLE forms (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    CREATE TABLE form_submissions (
      id TEXT PRIMARY KEY,
      form_id TEXT NOT NULL,
      source_url TEXT,
      submitted_at TEXT NOT NULL
    );
    CREATE TABLE form_submission_values (
      submission_id TEXT NOT NULL,
      field_key TEXT NOT NULL,
      field_label TEXT NOT NULL,
      field_type TEXT NOT NULL,
      field_value TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  edge.prepare('INSERT INTO forms VALUES (?, ?)')
    .run('4'.repeat(32), 'Contact us');
  edge.prepare(`
    INSERT INTO form_submissions VALUES (?, ?, ?, ?)
  `).run(
    '5'.repeat(32),
    '4'.repeat(32),
    'https://example.com/contact',
    '2026-08-04T00:00:00Z',
  );
  edge.prepare(`
    INSERT INTO form_submission_values VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    '5'.repeat(32),
    'message',
    'Message',
    'textarea',
    'Please call me.',
    '2026-08-04T00:00:00Z',
  );

  const studio = new DatabaseSync(':memory:');
  studio.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      status TEXT NOT NULL,
      email_verified INTEGER NOT NULL
    );
    CREATE TABLE user_roles (
      user_id TEXT NOT NULL,
      role_key TEXT NOT NULL
    );
  `);
  studio.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(
    '6'.repeat(32),
    'editor@example.com',
    'active',
    1,
  );
  studio.prepare('INSERT INTO user_roles VALUES (?, ?)')
    .run('6'.repeat(32), 'editor');
  return { edge, studio };
}

function configuredMail() {
  return {
    kind: 'configured' as const,
    settings: {
      provider: 'resend' as const,
      from_email: 'news@example.com',
      from_name: 'ZeroPress',
      cloudflare_account_id: '',
    },
    credential: 're_secret',
  };
}

function postNotificationDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE newsletter_lists (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
    CREATE TABLE newsletter_subscribers (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL
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
      email TEXT NOT NULL
    );
    CREATE TABLE newsletter_deliveries (
      id TEXT PRIMARY KEY,
      newsletter_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      delivery_type TEXT NOT NULL,
      content_id TEXT,
      idempotency_key TEXT NOT NULL,
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
  const newsletterId = '1'.repeat(32);
  const subscriberId = '2'.repeat(32);
  const subscriptionId = '3'.repeat(32);
  const deliveryId = '4'.repeat(32);
  const postId = '5'.repeat(32);
  const postRevision = '6'.repeat(32);
  const prefix = `post-notification:${postId}:${postRevision}:`;
  sqlite.prepare('INSERT INTO newsletter_lists VALUES (?, ?)')
    .run(newsletterId, 'active');
  sqlite.prepare('INSERT INTO newsletter_subscribers VALUES (?, ?)')
    .run(subscriberId, 'reader@example.com');
  sqlite.prepare('INSERT INTO newsletter_subscriptions VALUES (?, ?, ?, ?, ?)')
    .run(
      subscriptionId,
      newsletterId,
      subscriberId,
      'subscribed',
      'https://example.com/newsletter',
    );
  sqlite.prepare(`
    INSERT INTO newsletter_deliveries VALUES (
      ?, ?, ?, 'post_notification', ?, ?, ?, NULL, 'queued', 0, NULL,
      '2026-09-03T00:00:00Z', NULL, NULL,
      '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z'
    )
  `).run(
    deliveryId,
    newsletterId,
    subscriptionId,
    postId,
    `${prefix}${subscriptionId}`,
    'New post: Release notes',
  );
  return {
    sqlite,
    newsletterId,
    subscriberId,
    subscriptionId,
    deliveryId,
    postId,
    postRevision,
  };
}

function postSnapshot(input: ReturnType<typeof postNotificationDatabase>) {
  return {
    newsletter_id: input.newsletterId,
    post_id: input.postId,
    post_revision: input.postRevision,
    title: 'Release notes',
    excerpt: 'What changed in this release.',
    public_path: '/updates/release-notes/',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Edge mail queue Newsletter delivery', () => {
  it('delivers and marks only the currently bound confirmation token', async () => {
    const token = 'current-confirmation-token';
    const sqlite = await database(token);
    const send = vi.fn().mockResolvedValue(undefined);
    const service = new EdgeMailQueueService(env(d1(sqlite)), {
      readMailConfiguration: vi.fn().mockResolvedValue(configuredMail()),
      send,
      now: () => new Date('2026-08-04T00:00:00.000Z'),
    });
    await service.process(confirmationMessage(token));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'resend',
      to: 'reader@example.com',
      subject: 'Confirm your subscription to Product updates',
      idempotencyKey: `newsletter-delivery-${'4'.repeat(32)}`,
      html: expect.stringContaining(
        `#unsubscribe_token=nu1.${'3'.repeat(32)}`,
      ),
      text: expect.stringContaining(
        `#unsubscribe_token=nu1.${'3'.repeat(32)}`,
      ),
    }));
    expect(sqlite.prepare(`
      SELECT confirm_email_status, confirm_sent_at, confirm_email_error
      FROM newsletter_subscriptions
    `).get()).toEqual({
      confirm_email_status: 'sent',
      confirm_sent_at: '2026-08-04T00:00:00Z',
      confirm_email_error: null,
    });
    expect(sqlite.prepare(`
      SELECT provider, status, attempt_count, failure_code,
             last_attempt_at, sent_at
      FROM newsletter_deliveries
    `).get()).toEqual({
      provider: 'resend',
      status: 'sent',
      attempt_count: 1,
      failure_code: null,
      last_attempt_at: '2026-08-04T00:00:00Z',
      sent_at: '2026-08-04T00:00:00Z',
    });
    sqlite.close();
  });

  it('silently discards a stale queue token without sending or changing state', async () => {
    const sqlite = await database('current-token');
    const send = vi.fn();
    const service = new EdgeMailQueueService(env(d1(sqlite)), {
      readMailConfiguration: vi.fn().mockResolvedValue(configuredMail()),
      send,
      now: () => new Date('2026-08-04T00:00:00.000Z'),
    });
    await service.process(confirmationMessage('stale-token'));
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`
      SELECT confirm_email_status, confirm_email_error
      FROM newsletter_subscriptions
    `).get()).toEqual({
      confirm_email_status: 'not_sent',
      confirm_email_error: null,
    });
    expect(sqlite.prepare(`
      SELECT status, attempt_count, failure_code FROM newsletter_deliveries
    `).get()).toEqual({
      status: 'skipped',
      attempt_count: 0,
      failure_code: 'not_deliverable',
    });
    sqlite.close();
  });

  it('silently discards confirmation delivery after the channel is paused', async () => {
    const token = 'paused-channel-token';
    const sqlite = await database(token, 'archived');
    const send = vi.fn();
    const service = new EdgeMailQueueService(env(d1(sqlite)), {
      readMailConfiguration: vi.fn().mockResolvedValue(configuredMail()),
      send,
      now: () => new Date('2026-08-04T00:00:00.000Z'),
    });
    await service.process(confirmationMessage(token));
    expect(send).not.toHaveBeenCalled();
    expect(sqlite.prepare(`
      SELECT confirm_email_status, confirm_email_error
      FROM newsletter_subscriptions
    `).get()).toEqual({
      confirm_email_status: 'not_sent',
      confirm_email_error: null,
    });
    expect(sqlite.prepare(`
      SELECT status, attempt_count, failure_code FROM newsletter_deliveries
    `).get()).toEqual({
      status: 'skipped',
      attempt_count: 0,
      failure_code: 'not_deliverable',
    });
    sqlite.close();
  });

  it('keeps the token retryable and records only a bounded provider failure kind', async () => {
    const token = 'retryable-token';
    const sqlite = await database(token);
    const service = new EdgeMailQueueService(env(d1(sqlite)), {
      readMailConfiguration: vi.fn().mockResolvedValue(configuredMail()),
      send: vi.fn().mockRejectedValue(new Error('private provider response')),
      now: () => new Date('2026-08-04T00:00:00.000Z'),
    });
    await expect(service.process(confirmationMessage(token)))
      .rejects.toThrow('private provider response');
    expect(sqlite.prepare(`
      SELECT confirm_token_hash, confirm_email_status, confirm_email_error
      FROM newsletter_subscriptions
    `).get()).toEqual({
      confirm_token_hash: await tokenHash(token),
      confirm_email_status: 'failed',
      confirm_email_error: 'unexpected_failure',
    });
    expect(sqlite.prepare(`
      SELECT provider, status, attempt_count, failure_code, sent_at
      FROM newsletter_deliveries
    `).get()).toEqual({
      provider: 'resend',
      status: 'failed',
      attempt_count: 1,
      failure_code: 'unexpected_failure',
      sent_at: null,
    });
    sqlite.close();
  });

  it('discards unsupported contract versions without processing or logging the body', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const body = confirmationMessage('private-queue-token');
    const message = {
      body: { ...body, contract_version: body.contract_version + 1 },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const process = vi.fn();
    await handleEdgeMailQueue({ messages: [message] } as unknown as MessageBatch<unknown>,
      env({} as D1Database), () => ({ process }) as unknown as EdgeMailQueueService,
      vi.fn().mockResolvedValue({ state: 'ready', reason: 'ready', currentSchemaVersion: 1 }));
    expect(process).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(JSON.stringify(warning.mock.calls)).toContain('EDGE_MAIL_QUEUE_MESSAGE_INVALID');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private-queue-token');
  });

  it('discards invalid jobs and leaves valid service-failure limits to the queue configuration', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invalid = {
      body: {
        contract_version: 1,
        type: 'newsletter.confirmation',
        subscription_id: 'not-an-id',
        token: 'private-token',
      },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const retryable = {
      body: {
        contract_version: 1,
        type: 'newsletter.confirmation',
        delivery_id: '4'.repeat(32),
        subscription_id: '3'.repeat(32),
        token: 'another-private-token',
        unsubscribe_token: `nu1.${'3'.repeat(32)}`,
      },
      attempts: 5,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const process = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    await handleEdgeMailQueue({
      messages: [invalid, retryable],
    } as unknown as MessageBatch<unknown>, env({} as D1Database), () => ({
      process,
    }) as unknown as EdgeMailQueueService, vi.fn().mockResolvedValue({
      state: 'ready', reason: 'ready', currentSchemaVersion: 3,
    }));
    expect(invalid.ack).toHaveBeenCalledOnce();
    expect(invalid.retry).not.toHaveBeenCalled();
    expect(retryable.ack).not.toHaveBeenCalled();
    expect(retryable.retry.mock.calls).toEqual([[]]);
    const logs = JSON.stringify([...warning.mock.calls, ...error.mock.calls]);
    expect(logs).not.toContain('private-token');
    expect(logs).not.toContain('another-private-token');
  });
});

describe('Edge mail queue Post notification delivery', () => {
  it('keeps each fan-out batch at 100 jobs including its continuation', async () => {
    const fixture = postNotificationDatabase();
    const prefix = `post-notification:${fixture.postId}:${fixture.postRevision}:`;
    const insert = fixture.sqlite.prepare(`
      INSERT INTO newsletter_deliveries VALUES (
        ?, ?, ?, 'post_notification', ?, ?, ?, NULL, 'queued', 0, NULL,
        '2026-09-03T00:00:00Z', NULL, NULL,
        '2026-09-03T00:00:00Z', '2026-09-03T00:00:00Z'
      )
    `);
    for (let index = 0; index < 99; index += 1) {
      const subscriptionId = (index + 16).toString(16).padStart(32, '0');
      const deliveryId = (index + 256).toString(16).padStart(32, '0');
      insert.run(
        deliveryId,
        fixture.newsletterId,
        subscriptionId,
        fixture.postId,
        `${prefix}${subscriptionId}`,
        'New post: Release notes',
      );
    }
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const service = new EdgeMailQueueService({
      ...env(d1(fixture.sqlite)),
      MAIL_QUEUE: { sendBatch } as unknown as Queue,
    });
    await service.process({
      contract_version: 1,
      type: 'newsletter.post_notification.dispatch',
      snapshot: postSnapshot(fixture),
      after_idempotency_key: null,
    });

    const batch = sendBatch.mock.calls[0][0];
    expect(batch).toHaveLength(100);
    expect(batch.slice(0, 99).every((entry: { body: { type: string } }) => (
      entry.body.type === 'newsletter.post_notification'
    ))).toBe(true);
    expect(batch[99].body).toMatchObject({
      type: 'newsletter.post_notification.dispatch',
      after_idempotency_key: expect.stringContaining(prefix),
    });
    fixture.sqlite.close();
  });

  it('fans out a frozen delivery and records the recipient send', async () => {
    const fixture = postNotificationDatabase();
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockResolvedValue(undefined);
    const bindings = {
      ...env(d1(fixture.sqlite)),
      MAIL_QUEUE: { sendBatch } as unknown as Queue,
    };
    const service = new EdgeMailQueueService(bindings, {
      readMailConfiguration: vi.fn().mockResolvedValue(configuredMail()),
      send,
      now: () => new Date('2026-09-03T00:01:00.000Z'),
    });
    await service.process({
      contract_version: 1,
      type: 'newsletter.post_notification.dispatch',
      snapshot: postSnapshot(fixture),
      after_idempotency_key: null,
    });
    expect(sendBatch).toHaveBeenCalledOnce();
    const recipient = sendBatch.mock.calls[0][0][0].body;
    expect(recipient).toMatchObject({
      type: 'newsletter.post_notification',
      delivery_id: fixture.deliveryId,
    });

    await service.process(recipient, 1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'reader@example.com',
      subject: 'New post: Release notes',
      idempotencyKey: `newsletter-delivery-${fixture.deliveryId}`,
      html: expect.stringContaining(
        'https://example.com/updates/release-notes/',
      ),
      text: expect.stringContaining(
        `#unsubscribe_token=nu1.${fixture.subscriptionId}`,
      ),
    }));
    expect(fixture.sqlite.prepare(`
      SELECT provider, status, attempt_count, failure_code, sent_at
      FROM newsletter_deliveries
    `).get()).toEqual({
      provider: 'resend',
      status: 'sent',
      attempt_count: 1,
      failure_code: null,
      sent_at: '2026-09-03T00:01:00Z',
    });
    fixture.sqlite.close();
  });

  it('skips a recipient suppressed after materialization', async () => {
    const fixture = postNotificationDatabase();
    fixture.sqlite.prepare('INSERT INTO newsletter_suppressions VALUES (?, ?)')
      .run('7'.repeat(32), 'reader@example.com');
    const send = vi.fn();
    const service = new EdgeMailQueueService(env(d1(fixture.sqlite)), {
      readMailConfiguration: vi.fn().mockResolvedValue(configuredMail()),
      send,
      now: () => new Date('2026-09-03T00:01:00.000Z'),
    });
    await service.process({
      contract_version: 1,
      type: 'newsletter.post_notification',
      delivery_id: fixture.deliveryId,
      snapshot: postSnapshot(fixture),
    }, 1);
    expect(send).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare(`
      SELECT status, attempt_count, failure_code
      FROM newsletter_deliveries
    `).get()).toEqual({
      status: 'skipped',
      attempt_count: 0,
      failure_code: 'not_deliverable',
    });
    fixture.sqlite.close();
  });

  it('claims a queue attempt once when the same recipient job is duplicated', async () => {
    const fixture = postNotificationDatabase();
    const send = vi.fn().mockResolvedValue(undefined);
    const service = new EdgeMailQueueService(env(d1(fixture.sqlite)), {
      readMailConfiguration: vi.fn().mockResolvedValue(configuredMail()),
      send,
      now: () => new Date('2026-09-03T00:01:00.000Z'),
    });
    const message = {
      contract_version: 1 as const,
      type: 'newsletter.post_notification' as const,
      delivery_id: fixture.deliveryId,
      snapshot: postSnapshot(fixture),
    };
    await service.process(message, 1);
    await service.process(message, 1);
    expect(send).toHaveBeenCalledOnce();
    fixture.sqlite.close();
  });
});

describe('Edge mail queue Form notification delivery', () => {
  it('resolves the snapshotted eligible Studio user and sends the submission', async () => {
    const { edge, studio } = formDatabases();
    const send = vi.fn().mockResolvedValue(undefined);
    const service = new EdgeMailQueueService(env(d1(edge), d1(studio)), {
      readMailConfiguration: vi.fn().mockResolvedValue(configuredMail()),
      send,
    });

    await service.process({
      contract_version: 1,
      type: 'form.notification',
      submission_id: '5'.repeat(32),
      recipient_user_id: '6'.repeat(32),
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'editor@example.com',
      subject: '[ZeroPress] New form submission: Contact us',
      idempotencyKey: `form-notification-${'5'.repeat(32)}-${'6'.repeat(32)}`,
    }));
    edge.close();
    studio.close();
  });

  it('acknowledges without sending when the mail provider is not configured', async () => {
    const { edge, studio } = formDatabases();
    const send = vi.fn();
    const service = new EdgeMailQueueService(env(d1(edge), d1(studio)), {
      readMailConfiguration: vi.fn().mockResolvedValue({
        kind: 'not_configured',
        settings: null,
      }),
      send,
    });

    await service.process({
      contract_version: 1,
      type: 'form.notification',
      submission_id: '5'.repeat(32),
      recipient_user_id: '6'.repeat(32),
    });

    expect(send).not.toHaveBeenCalled();
    edge.close();
    studio.close();
  });

  it('acknowledges without reading mail settings when the User is no longer eligible', async () => {
    const { edge, studio } = formDatabases();
    studio.prepare('UPDATE users SET status = ? WHERE id = ?')
      .run('inactive', '6'.repeat(32));
    const readMailConfiguration = vi.fn().mockResolvedValue(configuredMail());
    const send = vi.fn();
    const service = new EdgeMailQueueService(env(d1(edge), d1(studio)), {
      readMailConfiguration,
      send,
    });

    await service.process({
      contract_version: 1,
      type: 'form.notification',
      submission_id: '5'.repeat(32),
      recipient_user_id: '6'.repeat(32),
    });

    expect(readMailConfiguration).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    edge.close();
    studio.close();
  });

  it('retries the whole batch before parsing while the Edge schema is outdated', async () => {
    const warning = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invalidLegacyMessage = {
      body: { type: 'form.notification', submission_id: '5'.repeat(32) },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    const createService = vi.fn();

    await handleEdgeMailQueue(
      { messages: [invalidLegacyMessage] } as unknown as MessageBatch<unknown>,
      env({} as D1Database),
      createService,
      vi.fn().mockResolvedValue({
        state: 'upgrade_required',
        reason: 'schema_outdated',
        currentSchemaVersion: 1,
      }),
    );

    expect(createService).not.toHaveBeenCalled();
    expect(invalidLegacyMessage.retry).toHaveBeenCalledOnce();
    expect(invalidLegacyMessage.ack).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledOnce();
  });
});

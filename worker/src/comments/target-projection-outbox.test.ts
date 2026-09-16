import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import {
  COMMENT_TARGET_OUTBOX_LEASE_MS,
  countPendingCommentTargetEvents,
  drainCommentTargetProjectionOutbox,
} from './target-projection-outbox';

type SqliteRunResult = { changes: number | bigint };
type D1Hooks = { acknowledgeZeroOnce?: boolean };

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly hooks: D1Hooks,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, this.hooks, params);
  }

  async run(): Promise<D1Result<unknown>> {
    if (
      this.hooks.acknowledgeZeroOnce
      && this.sql.includes('DELETE FROM edge_comment_target_projection_outbox')
    ) {
      this.hooks.acknowledgeZeroOnce = false;
      return {
        success: true, results: [], meta: { changes: 0 },
      } as unknown as D1Result<unknown>;
    }
    const result = (
      this.database.prepare(this.sql).run as (...params: unknown[]) => SqliteRunResult
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

  async first<T>(): Promise<T | null> {
    const row = (
      this.database.prepare(this.sql).get as (...params: unknown[]) => T | undefined
    )(...this.params);
    return row ?? null;
  }

  async execute(): Promise<D1Result<unknown>> {
    return /^\s*(?:SELECT|WITH)\b/iu.test(this.sql)
      ? this.all()
      : this.run();
  }
}

function d1(database: DatabaseSync, hooks: D1Hooks = {}): D1Database {
  return {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql, hooks);
    },
    async batch(statements: SqliteD1Statement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.execute());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

function createStudioDatabase(options: { baseline?: boolean } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  if (options.baseline) {
    database.exec(readFileSync(
      new URL('../../../database/install/001_baseline.sql', import.meta.url),
      'utf8',
    ));
  } else {
    database.exec(`
      CREATE TABLE studio_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        type TEXT NOT NULL,
        updated_at_iso TEXT NOT NULL
      );
      CREATE TABLE edge_comment_target_projection_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        target_type TEXT NOT NULL,
        target_public_id INTEGER NOT NULL,
        operation TEXT NOT NULL,
        status TEXT,
        allow_comments INTEGER,
        created_at_iso TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at_iso TEXT,
        lease_id TEXT,
        lease_expires_at_iso TEXT
      );
    `);
  }
  return database;
}

function seedMode(database: DatabaseSync, mode: 'enabled' | 'disabled') {
  database.prepare(`
    INSERT INTO studio_settings (key, value, type, updated_at_iso)
    VALUES ('edge_integration_mode', ?, 'string', ?)
  `).run(mode, '2026-08-11T00:00:00.000Z');
}

function createEdgeDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE zeropress_edge_schema_state (
      id INTEGER PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      lifecycle_state TEXT NOT NULL,
      target_schema_version INTEGER,
      active_operation_id TEXT
    );
    INSERT INTO zeropress_edge_schema_state
    VALUES (1, 1, 'ready', NULL, NULL);
    CREATE TABLE edge_comment_targets (
      id INTEGER PRIMARY KEY,
      target_type TEXT NOT NULL,
      public_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      allow_comments INTEGER NOT NULL,
      UNIQUE(target_type, public_id)
    );
  `);
  return database;
}

function insertEvent(database: DatabaseSync, input: {
  eventId: string;
  targetType: 'post' | 'page';
  publicId: number;
  operation?: 'upsert' | 'delete';
  status?: 'draft' | 'published' | 'trash';
  allowComments?: 0 | 1;
}) {
  const operation = input.operation ?? 'upsert';
  database.prepare(`
    INSERT INTO edge_comment_target_projection_outbox (
      event_id, target_type, target_public_id, operation,
      status, allow_comments, created_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.eventId,
    input.targetType,
    input.publicId,
    operation,
    operation === 'upsert' ? input.status ?? 'draft' : null,
    operation === 'upsert' ? input.allowComments ?? 0 : null,
    '2026-08-11T00:00:00.000Z',
  );
}

function environment(studio: D1Database, edge?: D1Database): Env {
  return {
    DB: studio,
    EDGE_DB: edge,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: { limit: vi.fn() },
  };
}

describe('comment-target projection outbox', () => {
  it('atomically emits canonical changes only while integration is enabled', () => {
    const database = createStudioDatabase({ baseline: true });
    seedMode(database, 'enabled');
    database.prepare(`
      INSERT INTO authors (id, display_name, created_at_iso, updated_at_iso)
      VALUES ('owner', 'Owner', ?, ?)
    `).run('2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z');
    database.prepare(`
      INSERT INTO posts (
        id, public_id, title, slug, author_id, created_at_iso, updated_at_iso
      ) VALUES (?, 101, 'Post', 'post', 'owner', ?, ?)
    `).run(
      '1'.repeat(32),
      '2026-08-11T00:00:00.000Z',
      '2026-08-11T00:00:00.000Z',
    );
    expect(database.prepare(`
      SELECT operation, status, allow_comments
      FROM edge_comment_target_projection_outbox ORDER BY id
    `).all()).toEqual([{
      operation: 'upsert', status: 'draft', allow_comments: 1,
    }]);

    database.prepare(`UPDATE posts SET title = 'Renamed' WHERE public_id = 101`)
      .run();
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM edge_comment_target_projection_outbox
    `).get()).toEqual({ count: 1 });

    database.prepare(`
      UPDATE posts SET status = 'published', published_at_iso = ?,
        revision = ?, updated_at_iso = ? WHERE public_id = 101
    `).run(
      '2026-08-11T01:00:00.000Z',
      'a'.repeat(32),
      '2026-08-11T01:00:00.000Z',
    );
    database.prepare('DELETE FROM posts WHERE public_id = 101').run();
    expect(database.prepare(`
      SELECT operation, status, allow_comments
      FROM edge_comment_target_projection_outbox ORDER BY id
    `).all()).toEqual([
      { operation: 'upsert', status: 'draft', allow_comments: 1 },
      { operation: 'upsert', status: 'published', allow_comments: 1 },
      { operation: 'delete', status: null, allow_comments: null },
    ]);

    database.prepare(`
      UPDATE studio_settings SET value = 'disabled'
      WHERE key = 'edge_integration_mode'
    `).run();
    database.prepare(`
      INSERT INTO pages (
        id, public_id, title, slug, created_at_iso, updated_at_iso
      ) VALUES (?, 7, 'Page', 'page', ?, ?)
    `).run(
      '2'.repeat(32),
      '2026-08-11T00:00:00.000Z',
      '2026-08-11T00:00:00.000Z',
    );
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM edge_comment_target_projection_outbox
    `).get()).toEqual({ count: 3 });
  });

  it('preserves per-target order while processing different targets together', async () => {
    const studio = createStudioDatabase();
    seedMode(studio, 'enabled');
    insertEvent(studio, {
      eventId: '1'.repeat(32), targetType: 'post', publicId: 101,
      status: 'draft', allowComments: 0,
    });
    insertEvent(studio, {
      eventId: '2'.repeat(32), targetType: 'post', publicId: 101,
      status: 'published', allowComments: 1,
    });
    insertEvent(studio, {
      eventId: '3'.repeat(32), targetType: 'page', publicId: 7,
      status: 'published', allowComments: 0,
    });
    const edge = createEdgeDatabase();
    const env = environment(d1(studio), d1(edge));

    await expect(drainCommentTargetProjectionOutbox({
      env, limit: 25, now: new Date('2026-08-11T00:00:00.000Z'),
      createLeaseId: () => 'a'.repeat(32),
    })).resolves.toEqual({ processedEvents: 2, remainingEvents: 1 });
    expect(edge.prepare(`
      SELECT target_type, public_id, status, allow_comments
      FROM edge_comment_targets ORDER BY target_type, public_id
    `).all()).toEqual([
      { target_type: 'page', public_id: 7, status: 'published', allow_comments: 0 },
      { target_type: 'post', public_id: 101, status: 'draft', allow_comments: 0 },
    ]);

    await expect(drainCommentTargetProjectionOutbox({
      env, limit: 25, now: new Date('2026-08-11T00:01:00.000Z'),
      createLeaseId: () => 'b'.repeat(32),
    })).resolves.toEqual({ processedEvents: 1, remainingEvents: 0 });
    expect(edge.prepare(`
      SELECT status, allow_comments FROM edge_comment_targets
      WHERE target_type = 'post' AND public_id = 101
    `).get()).toEqual({ status: 'published', allow_comments: 1 });
  });

  it('preserves failed events and safely retries an uncertain acknowledgement', async () => {
    const studio = createStudioDatabase();
    seedMode(studio, 'enabled');
    insertEvent(studio, {
      eventId: '4'.repeat(32), targetType: 'post', publicId: 101,
      status: 'published', allowComments: 1,
    });
    const edge = createEdgeDatabase();
    const hooks = { acknowledgeZeroOnce: true };
    const initialEnv = environment(d1(studio, hooks), d1(edge));
    await expect(drainCommentTargetProjectionOutbox({
      env: initialEnv,
      limit: 25,
      now: new Date('2026-08-11T00:00:00.000Z'),
      createLeaseId: () => 'c'.repeat(32),
    })).rejects.toMatchObject({
      code: 'COMMENT_TARGET_OUTBOX_DATABASE_WRITE_FAILED',
    });
    expect(studio.prepare(`
      SELECT COUNT(*) AS count FROM edge_comment_target_projection_outbox
    `).get()).toEqual({ count: 1 });
    expect(edge.prepare(`
      SELECT status FROM edge_comment_targets
      WHERE target_type = 'post' AND public_id = 101
    `).get()).toEqual({ status: 'published' });

    await expect(drainCommentTargetProjectionOutbox({
      env: environment(d1(studio), d1(edge)),
      limit: 25,
      now: new Date(
        Date.parse('2026-08-11T00:00:00.000Z')
          + COMMENT_TARGET_OUTBOX_LEASE_MS,
      ),
      createLeaseId: () => 'd'.repeat(32),
    })).resolves.toEqual({ processedEvents: 1, remainingEvents: 0 });
  });

  it('claims distinct target heads across concurrent leases', async () => {
    const studio = createStudioDatabase();
    seedMode(studio, 'enabled');
    insertEvent(studio, {
      eventId: '6'.repeat(32), targetType: 'post', publicId: 101,
      status: 'published', allowComments: 1,
    });
    insertEvent(studio, {
      eventId: '7'.repeat(32), targetType: 'page', publicId: 7,
      status: 'published', allowComments: 0,
    });
    const appliedBatches: unknown[][] = [];
    const edge = {
      prepare: vi.fn((sql: string) => sql.includes('zeropress_edge_schema_state')
        ? { first: vi.fn().mockResolvedValue({
            schema_version: 1,
            lifecycle_state: 'ready',
            target_schema_version: null,
            active_operation_id: null,
          }) }
        : { bind: vi.fn(() => ({})) }),
      batch: vi.fn(async (statements: unknown[]) => {
        appliedBatches.push(statements);
        return statements.map(() => ({ success: true, meta: { changes: 1 } }));
      }),
    } as unknown as D1Database;
    const env = environment(d1(studio), edge);
    const now = new Date('2026-08-11T00:00:00.000Z');

    const results = await Promise.all([
      drainCommentTargetProjectionOutbox({
        env, limit: 1, now, createLeaseId: () => '8'.repeat(32),
      }),
      drainCommentTargetProjectionOutbox({
        env, limit: 1, now, createLeaseId: () => '9'.repeat(32),
      }),
    ]);

    expect(results.map((result) => result.processedEvents).sort())
      .toEqual([1, 1]);
    expect(appliedBatches).toHaveLength(2);
    expect(studio.prepare(`
      SELECT COUNT(*) AS count FROM edge_comment_target_projection_outbox
    `).get()).toEqual({ count: 0 });
  });

  it('releases leases after Edge failure and does nothing while disabled', async () => {
    const studio = createStudioDatabase();
    seedMode(studio, 'enabled');
    insertEvent(studio, {
      eventId: '5'.repeat(32), targetType: 'page', publicId: 7,
      operation: 'delete',
    });
    const edge = {
      prepare: vi.fn((sql: string) => sql.includes('zeropress_edge_schema_state')
        ? { first: vi.fn().mockResolvedValue({
            schema_version: 1,
            lifecycle_state: 'ready',
            target_schema_version: null,
            active_operation_id: null,
          }) }
        : { bind: vi.fn(() => ({})) }),
      batch: vi.fn().mockRejectedValue(new Error('Edge D1 unavailable')),
    } as unknown as D1Database;
    const studioD1 = d1(studio);
    await expect(drainCommentTargetProjectionOutbox({
      env: environment(studioD1, edge),
      limit: 25,
      now: new Date('2026-08-11T00:00:00.000Z'),
      createLeaseId: () => 'e'.repeat(32),
    })).rejects.toMatchObject({
      code: 'COMMENT_TARGET_OUTBOX_DRAIN_FAILED',
    });
    expect(studio.prepare(`
      SELECT attempt_count, lease_id, lease_expires_at_iso
      FROM edge_comment_target_projection_outbox
    `).get()).toEqual({
      attempt_count: 1, lease_id: null, lease_expires_at_iso: null,
    });

    studio.prepare(`
      UPDATE studio_settings SET value = 'disabled'
      WHERE key = 'edge_integration_mode'
    `).run();
    await expect(drainCommentTargetProjectionOutbox({
      env: environment(studioD1),
      limit: 25,
    })).resolves.toEqual({ processedEvents: 0, remainingEvents: 1 });
    await expect(countPendingCommentTargetEvents({ db: studioD1 }))
      .resolves.toBe(1);
  });

  it('does not claim or project events while the Edge schema requires upgrade', async () => {
    const studio = createStudioDatabase();
    seedMode(studio, 'enabled');
    insertEvent(studio, {
      eventId: 'f'.repeat(32), targetType: 'post', publicId: 101,
      status: 'published', allowComments: 1,
    });
    const edge = createEdgeDatabase();
    edge.prepare(`
      UPDATE zeropress_edge_schema_state
      SET lifecycle_state = 'installing',
          target_schema_version = 1,
          active_operation_id = ?
    `).run('a'.repeat(32));

    await expect(drainCommentTargetProjectionOutbox({
      env: environment(d1(studio), d1(edge)),
      limit: 25,
    })).rejects.toMatchObject({
      code: 'COMMENT_TARGET_OUTBOX_DRAIN_FAILED',
      operationalMetadata: {
        action: 'verify_edge_database_lifecycle_for_outbox',
      },
    });
    expect(studio.prepare(`
      SELECT attempt_count, lease_id
      FROM edge_comment_target_projection_outbox
    `).get()).toEqual({ attempt_count: 0, lease_id: null });
  });
});

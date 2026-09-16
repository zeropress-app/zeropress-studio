import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../types';
import { sqliteD1 } from '../test-helpers/sqlite-d1';
import {
  applyEdgeTargetReconciliationStep,
  cancelEdgeTargetReconciliation,
  edgeTargetParityMatches,
  finalizeEdgeTargetReconciliation,
  inspectEdgeTargetReconciliation,
  listEdgeTargetOrphans,
  purgeEdgeTargetOrphans,
  readEdgeTargetReconciliationInitiator,
  startEdgeTargetReconciliation,
} from './target-reconciliation';

const TEST_INITIATOR = {
  userId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  userEmail: 'owner@example.com',
} as const;

const open: DatabaseSync[] = [];

function createDatabases() {
  const studio = new DatabaseSync(':memory:');
  const edge = new DatabaseSync(':memory:');
  studio.exec('PRAGMA foreign_keys = ON');
  edge.exec('PRAGMA foreign_keys = ON');
  studio.exec(`
    CREATE TABLE studio_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      type TEXT NOT NULL
    );
    INSERT INTO studio_settings (key, value, type)
    VALUES ('edge_integration_mode', 'enabled', 'string');

    CREATE TABLE posts (
      public_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      allow_comments INTEGER NOT NULL
    );
    CREATE TABLE pages (
      public_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      allow_comments INTEGER NOT NULL
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
    CREATE TABLE edge_comment_target_reconciliation_state (
      id INTEGER PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL,
      cursor_public_id INTEGER NOT NULL DEFAULT 0,
      edge_cursor_id INTEGER NOT NULL DEFAULT 0,
      synced_posts INTEGER NOT NULL DEFAULT 0,
      synced_pages INTEGER NOT NULL DEFAULT 0,
      scanned_targets INTEGER NOT NULL DEFAULT 0,
      started_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      initiated_by_user_id TEXT NOT NULL,
      initiated_by_user_email TEXT NOT NULL
    );
    CREATE TABLE edge_comment_target_reconciliation_orphans (
      operation_id TEXT NOT NULL
        REFERENCES edge_comment_target_reconciliation_state(operation_id)
        ON DELETE CASCADE,
      target_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      public_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      allow_comments INTEGER NOT NULL,
      comments_cache_revision TEXT NOT NULL,
      comment_count INTEGER NOT NULL,
      discovered_at_iso TEXT NOT NULL,
      PRIMARY KEY (operation_id, target_id),
      UNIQUE (operation_id, target_type, public_id)
    );
  `);
  edge.exec(`
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
      request_token_nonce TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      comments_cache_revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      UNIQUE (target_type, public_id)
    );
    CREATE TABLE comments (
      id TEXT PRIMARY KEY,
      target_id INTEGER NOT NULL
        REFERENCES edge_comment_targets(id) ON DELETE CASCADE
    );
  `);
  open.push(studio, edge);
  const env = {
    DB: sqliteD1(studio),
    EDGE_DB: sqliteD1(edge),
  } as Env;
  return { studio, edge, env };
}

function insertStudioTarget(
  database: DatabaseSync,
  type: 'post' | 'page',
  publicId: number,
  status = 'published',
  allowComments = 1,
) {
  database.prepare(`
    INSERT INTO ${type === 'post' ? 'posts' : 'pages'} (
      public_id, status, allow_comments
    ) VALUES (?, ?, ?)
  `).run(publicId, status, allowComments);
}

function insertEdgeTarget(
  database: DatabaseSync,
  type: 'post' | 'page',
  publicId: number,
  status = 'published',
  allowComments = 1,
): number {
  return Number(database.prepare(`
    INSERT INTO edge_comment_targets (
      target_type, public_id, status, allow_comments
    ) VALUES (?, ?, ?, ?)
  `).run(type, publicId, status, allowComments).lastInsertRowid);
}

async function advanceToOrphanReview(env: Env, operationId: string) {
  for (let index = 0; index < 20; index += 1) {
    const status = await applyEdgeTargetReconciliationStep({
      env,
      operationId,
      now: new Date(`2026-08-11T00:00:${String(index).padStart(2, '0')}Z`),
    });
    if (status.state === 'orphan_review') return status;
  }
  throw new Error('Reconciliation did not reach orphan review.');
}

afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

describe('Edge target reconciliation', () => {
  it('drains outbox first and resumes 250-row Post/Page keyset repair', async () => {
    const { studio, edge, env } = createDatabases();
    for (let publicId = 1; publicId <= 251; publicId += 1) {
      insertStudioTarget(studio, 'post', publicId);
    }
    insertStudioTarget(studio, 'page', 1, 'draft', 0);
    insertEdgeTarget(edge, 'post', 1, 'draft', 0);
    studio.prepare(`
      INSERT INTO edge_comment_target_projection_outbox (
        event_id, target_type, target_public_id, operation, status,
        allow_comments, created_at_iso
      ) VALUES (?, 'post', 1, 'upsert', 'published', 1, ?)
    `).run('d'.repeat(32), '2026-08-11T00:00:00.000Z');

    const operationId = 'a'.repeat(32);
    await startEdgeTargetReconciliation({
      db: env.DB,
      initiator: TEST_INITIATOR,
      operationId,
      now: new Date('2026-08-11T00:00:00Z'),
    });
    await expect(readEdgeTargetReconciliationInitiator({
      db: env.DB,
      operationId,
    })).resolves.toEqual(TEST_INITIATOR);
    const afterDrain = await applyEdgeTargetReconciliationStep({
      env,
      operationId,
      now: new Date('2026-08-11T00:00:01Z'),
    });
    expect(afterDrain.phase).toBe('sync_posts');
    expect(studio.prepare(`
      SELECT COUNT(*) AS count FROM edge_comment_target_projection_outbox
    `).get()).toEqual({ count: 0 });

    const firstPostPage = await applyEdgeTargetReconciliationStep({
      env,
      operationId,
      now: new Date('2026-08-11T00:00:02Z'),
    });
    expect(firstPostPage).toMatchObject({
      phase: 'sync_posts',
      processed_posts: 250,
    });
    const secondPostPage = await applyEdgeTargetReconciliationStep({
      env,
      operationId,
      now: new Date('2026-08-11T00:00:03Z'),
    });
    expect(secondPostPage).toMatchObject({
      phase: 'sync_pages',
      processed_posts: 251,
    });
    const pagePage = await applyEdgeTargetReconciliationStep({
      env,
      operationId,
      now: new Date('2026-08-11T00:00:04Z'),
    });
    expect(pagePage).toMatchObject({
      phase: 'scan_orphans',
      processed_pages: 1,
    });
    expect(edge.prepare(`
      SELECT target_type, status, allow_comments
      FROM edge_comment_targets WHERE public_id = 1
      ORDER BY target_type
    `).all()).toEqual([
      { target_type: 'page', status: 'draft', allow_comments: 0 },
      { target_type: 'post', status: 'published', allow_comments: 1 },
    ]);
  });

  it('paginates orphan snapshots and safely classifies changed targets', async () => {
    const { studio, edge, env } = createDatabases();
    insertStudioTarget(studio, 'post', 1);
    insertEdgeTarget(edge, 'post', 1);
    const deletedId = insertEdgeTarget(edge, 'post', 101);
    const changedId = insertEdgeTarget(edge, 'post', 102);
    const revivedId = insertEdgeTarget(edge, 'page', 103);
    const missingId = insertEdgeTarget(edge, 'page', 104);
    edge.prepare('INSERT INTO comments (id, target_id) VALUES (?, ?)')
      .run('comment-a', deletedId);
    edge.prepare('INSERT INTO comments (id, target_id) VALUES (?, ?)')
      .run('comment-b', deletedId);

    const operationId = 'b'.repeat(32);
    await startEdgeTargetReconciliation({ db: env.DB, initiator: TEST_INITIATOR, operationId });
    await advanceToOrphanReview(env, operationId);
    const firstPage = await listEdgeTargetOrphans({
      db: env.DB,
      operationId,
      limit: 2,
    });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await listEdgeTargetOrphans({
      db: env.DB,
      operationId,
      cursor: firstPage.nextCursor!,
      limit: 2,
    });
    expect(secondPage.items).toHaveLength(2);

    edge.prepare(`
      UPDATE edge_comment_targets
      SET comments_cache_revision = lower(hex(randomblob(16)))
      WHERE id = ?
    `).run(changedId);
    insertStudioTarget(studio, 'page', 103);
    edge.prepare('DELETE FROM edge_comment_targets WHERE id = ?').run(missingId);
    const results = await purgeEdgeTargetOrphans({
      db: env.DB,
      edgeDb: env.EDGE_DB!,
      operationId,
      targetIds: [deletedId, changedId, revivedId, missingId],
    });
    expect(results).toEqual([
      { target_id: deletedId, result: 'deleted', deleted_comments: 2 },
      { target_id: changedId, result: 'changed', deleted_comments: 0 },
      { target_id: revivedId, result: 'no_longer_orphan', deleted_comments: 0 },
      { target_id: missingId, result: 'not_found', deleted_comments: 0 },
    ]);
    expect(edge.prepare('SELECT COUNT(*) AS count FROM comments').get())
      .toEqual({ count: 0 });
    expect((await listEdgeTargetOrphans({ db: env.DB, operationId })).items)
      .toMatchObject([{ target_id: changedId }]);
  });

  it('purges reviewed orphans, verifies exact bounded parity, and finalizes without enabling mode', async () => {
    const { studio, edge, env } = createDatabases();
    for (let publicId = 1; publicId <= 251; publicId += 1) {
      insertStudioTarget(studio, 'post', publicId);
      insertEdgeTarget(edge, 'post', publicId);
    }
    insertStudioTarget(studio, 'page', 1);
    insertEdgeTarget(edge, 'page', 1);
    const orphanId = insertEdgeTarget(edge, 'page', 999);
    expect(await edgeTargetParityMatches({ db: env.DB, edgeDb: env.EDGE_DB! }))
      .toBe(false);

    const operationId = 'c'.repeat(32);
    await startEdgeTargetReconciliation({ db: env.DB, initiator: TEST_INITIATOR, operationId });
    await advanceToOrphanReview(env, operationId);
    await purgeEdgeTargetOrphans({
      db: env.DB,
      edgeDb: env.EDGE_DB!,
      operationId,
      targetIds: [orphanId],
    });
    await finalizeEdgeTargetReconciliation({
      db: env.DB,
      edgeDb: env.EDGE_DB!,
      operationId,
    });

    expect(await edgeTargetParityMatches({ db: env.DB, edgeDb: env.EDGE_DB! }))
      .toBe(true);
    await expect(inspectEdgeTargetReconciliation({
      db: env.DB,
      edgeDb: env.EDGE_DB,
      available: true,
    })).resolves.toMatchObject({ state: 'not_required' });
    expect(studio.prepare(`
      SELECT value FROM studio_settings WHERE key = 'edge_integration_mode'
    `).get()).toEqual({ value: 'enabled' });
  });

  it('cancels an operation and starts a new one from the beginning', async () => {
    const { env } = createDatabases();
    const firstOperation = 'e'.repeat(32);
    await startEdgeTargetReconciliation({
      db: env.DB,
      initiator: TEST_INITIATOR,
      operationId: firstOperation,
    });
    await cancelEdgeTargetReconciliation({
      db: env.DB,
      operationId: firstOperation,
    });
    const restarted = await startEdgeTargetReconciliation({
      db: env.DB,
      initiator: TEST_INITIATOR,
      operationId: 'f'.repeat(32),
    });
    expect(restarted).toMatchObject({
      state: 'in_progress',
      operation_id: 'f'.repeat(32),
      phase: 'drain_outbox',
    });
  });

  it('reports parity independently from maintenance action availability', async () => {
    const { studio, env } = createDatabases();
    insertStudioTarget(studio, 'post', 42);

    await expect(inspectEdgeTargetReconciliation({
      db: env.DB,
      edgeDb: env.EDGE_DB,
      available: false,
    })).resolves.toMatchObject({
      state: 'required',
      available: false,
    });
  });

  it('reports unavailable when bounded Edge parity cannot be inspected', async () => {
    const { env } = createDatabases();
    const unavailableEdge = {
      prepare() {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;

    await expect(inspectEdgeTargetReconciliation({
      db: env.DB,
      edgeDb: unavailableEdge,
      available: true,
    })).resolves.toMatchObject({
      state: 'unavailable',
      available: false,
    });
  });
});

import type {
  EdgeTargetOrphan,
  EdgeTargetReconciliationStatus,
} from '../../../contracts/edge-target-reconciliation';
import type { Env } from '../types';
import {
  COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT,
  countPendingCommentTargetEvents,
  drainCommentTargetProjectionOutbox,
} from './target-projection-outbox';
import {
  syncCommentTargets,
  type CommentTargetProjection,
} from './target-projection';
import {
  parseStoredOperationsInitiator,
  type OperationsInitiator,
} from '../operations/initiator';

export const EDGE_TARGET_RECONCILIATION_BATCH_SIZE = 250;
export const EDGE_TARGET_ORPHAN_PAGE_SIZE = 50;
export const EDGE_TARGET_ORPHAN_PURGE_LIMIT = 100;
const LOOKUP_CHUNK_SIZE = 90;
const PARITY_BATCH_SIZE = 250;

type ReconciliationPhase =
  | 'drain_outbox'
  | 'sync_posts'
  | 'sync_pages'
  | 'scan_orphans'
  | 'orphan_review';

type ReconciliationRow = {
  operation_id: unknown;
  phase: unknown;
  cursor_public_id: unknown;
  edge_cursor_id: unknown;
  synced_posts: unknown;
  synced_pages: unknown;
  scanned_targets: unknown;
  initiated_by_user_id: unknown;
  initiated_by_user_email: unknown;
};

type ReconciliationState = {
  operationId: string;
  phase: ReconciliationPhase;
  cursorPublicId: number;
  edgeCursorId: number;
  syncedPosts: number;
  syncedPages: number;
  scannedTargets: number;
  initiator: OperationsInitiator;
};

type EdgeTargetRow = {
  id: unknown;
  target_type: unknown;
  public_id: unknown;
  status: unknown;
  allow_comments: unknown;
  comments_cache_revision: unknown;
};

type EdgeTarget = {
  id: number;
  targetType: 'post' | 'page';
  publicId: number;
  status: 'draft' | 'published' | 'scheduled' | 'trash' | 'archived';
  allowComments: boolean;
  commentsCacheRevision: string;
};

export class EdgeTargetReconciliationError extends Error {
  constructor(
    public readonly issue:
      | 'not_available'
      | 'state_conflict'
      | 'orphans_remaining'
      | 'parity_failed',
    message: string,
  ) {
    super(message);
    this.name = 'EdgeTargetReconciliationError';
  }
}

function hexId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function validCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError('D1 returned an invalid reconciliation count.');
  }
  return parsed;
}

function changes(result: D1Result<unknown>): number {
  return typeof result.meta?.changes === 'number'
    ? Math.max(0, Math.trunc(result.meta.changes))
    : 0;
}

function parseState(row: ReconciliationRow | null): ReconciliationState | null {
  if (row === null) return null;
  if (
    typeof row.operation_id !== 'string'
    || !/^[0-9a-f]{32}$/u.test(row.operation_id)
    || !['drain_outbox', 'sync_posts', 'sync_pages', 'scan_orphans', 'orphan_review']
      .includes(String(row.phase))
  ) throw new TypeError('D1 returned invalid reconciliation state.');
  return {
    operationId: row.operation_id,
    phase: row.phase as ReconciliationPhase,
    cursorPublicId: validCount(row.cursor_public_id),
    edgeCursorId: validCount(row.edge_cursor_id),
    syncedPosts: validCount(row.synced_posts),
    syncedPages: validCount(row.synced_pages),
    scannedTargets: validCount(row.scanned_targets),
    initiator: (() => {
      const initiator = parseStoredOperationsInitiator({
        userId: row.initiated_by_user_id,
        userEmail: row.initiated_by_user_email,
      });
      if (!initiator) {
        throw new TypeError('D1 returned reconciliation state without an initiator.');
      }
      return initiator;
    })(),
  };
}

async function readState(db: D1Database): Promise<ReconciliationState | null> {
  try {
    return parseState(await db.prepare(`
      SELECT operation_id, phase, cursor_public_id, edge_cursor_id,
             synced_posts, synced_pages, scanned_targets,
             initiated_by_user_id, initiated_by_user_email
      FROM edge_comment_target_reconciliation_state
      WHERE id = 1
      LIMIT 1
    `).first<ReconciliationRow>());
  } catch (error) {
    if (String(error).includes('no such table')) return null;
    throw error;
  }
}

export async function isEdgeTargetReconciliationInProgress(
  db: D1Database,
): Promise<boolean> {
  try {
    const row = await db.prepare(`
      SELECT 1 AS present
      FROM edge_comment_target_reconciliation_state
      WHERE id = 1
      LIMIT 1
    `).first<{ present?: unknown }>();
    return row?.present === 1;
  } catch (error) {
    if (String(error).includes('no such table')) return false;
    throw error;
  }
}

export async function readEdgeTargetReconciliationInitiator(input: {
  db: D1Database;
  operationId: string;
}): Promise<OperationsInitiator> {
  const state = await readState(input.db);
  if (!state || state.operationId !== input.operationId) {
    throw new EdgeTargetReconciliationError(
      'state_conflict',
      'The reconciliation initiator is unavailable.',
    );
  }
  return state.initiator;
}

function parseEdgeTarget(row: EdgeTargetRow): EdgeTarget {
  const id = Number(row.id);
  const publicId = Number(row.public_id);
  if (
    !Number.isSafeInteger(id) || id <= 0
    || (row.target_type !== 'post' && row.target_type !== 'page')
    || !Number.isSafeInteger(publicId) || publicId <= 0
    || !['draft', 'published', 'scheduled', 'trash', 'archived']
      .includes(String(row.status))
    || (row.allow_comments !== 0 && row.allow_comments !== 1)
    || typeof row.comments_cache_revision !== 'string'
    || !/^[0-9a-f]{32}$/u.test(row.comments_cache_revision)
  ) throw new TypeError('EDGE_DB returned an invalid comment target.');
  return {
    id,
    targetType: row.target_type,
    publicId,
    status: row.status as EdgeTarget['status'],
    allowComments: row.allow_comments === 1,
    commentsCacheRevision: row.comments_cache_revision,
  };
}

async function orphanSummary(db: D1Database, operationId: string) {
  const row = await db.prepare(`
    SELECT COUNT(*) AS targets, COALESCE(SUM(comment_count), 0) AS comments
    FROM edge_comment_target_reconciliation_orphans
    WHERE operation_id = ?
  `).bind(operationId).first<{ targets?: unknown; comments?: unknown }>();
  return {
    targets: validCount(row?.targets),
    comments: validCount(row?.comments),
  };
}

async function materializeStatus(
  db: D1Database,
  state: ReconciliationState | null,
  available: boolean,
  fallback: 'not_required' | 'required' | 'unavailable' = 'not_required',
): Promise<EdgeTargetReconciliationStatus> {
  const summary = state
    ? await orphanSummary(db, state.operationId)
    : { targets: 0, comments: 0 };
  return {
    state: state
      ? state.phase === 'orphan_review' ? 'orphan_review' : 'in_progress'
      : fallback,
    operation_id: state?.operationId ?? null,
    phase: state?.phase ?? null,
    processed_posts: state?.syncedPosts ?? 0,
    processed_pages: state?.syncedPages ?? 0,
    scanned_edge_targets: state?.scannedTargets ?? 0,
    orphan_targets: summary.targets,
    orphan_comments: summary.comments,
    available,
  };
}

type ComparableTargetRow = {
  public_id?: unknown;
  status?: unknown;
  allow_comments?: unknown;
};

function comparableTarget(row: ComparableTargetRow): string | null {
  const publicId = Number(row.public_id);
  if (
    !Number.isSafeInteger(publicId)
    || publicId <= 0
    || !['draft', 'published', 'trash'].includes(String(row.status))
    || (row.allow_comments !== 0 && row.allow_comments !== 1)
  ) return null;
  return `${publicId}:${row.status}:${row.allow_comments}`;
}

async function readCanonicalTargetPage(input: {
  db: D1Database;
  targetType: 'post' | 'page';
  cursor: number;
}) {
  const table = input.targetType === 'post' ? 'posts' : 'pages';
  const result = await input.db.prepare(`
    SELECT public_id, status, allow_comments
    FROM ${table}
    WHERE public_id > ?
    ORDER BY public_id
    LIMIT ?
  `).bind(input.cursor, PARITY_BATCH_SIZE).all<ComparableTargetRow>();
  return result.results ?? [];
}

async function readProjectedTargetPage(input: {
  edgeDb: D1Database;
  targetType: 'post' | 'page';
  cursor: number;
}) {
  const result = await input.edgeDb.prepare(`
    SELECT public_id, status, allow_comments
    FROM edge_comment_targets
    WHERE target_type = ? AND public_id > ?
    ORDER BY public_id
    LIMIT ?
  `).bind(
    input.targetType,
    input.cursor,
    PARITY_BATCH_SIZE,
  ).all<ComparableTargetRow>();
  return result.results ?? [];
}

export async function edgeTargetParityMatches(input: {
  db: D1Database;
  edgeDb: D1Database;
}): Promise<boolean> {
  for (const targetType of ['post', 'page'] as const) {
    let cursor = 0;
    for (;;) {
      const [studioRows, edgeRows] = await Promise.all([
        readCanonicalTargetPage({ db: input.db, targetType, cursor }),
        readProjectedTargetPage({
          edgeDb: input.edgeDb,
          targetType,
          cursor,
        }),
      ]);
      if (studioRows.length !== edgeRows.length) return false;
      for (let index = 0; index < studioRows.length; index += 1) {
        const studio = comparableTarget(studioRows[index]!);
        const edge = comparableTarget(edgeRows[index]!);
        if (studio === null || edge === null || studio !== edge) return false;
      }
      if (studioRows.length < PARITY_BATCH_SIZE) break;
      const nextCursor = Number(studioRows.at(-1)?.public_id);
      if (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor) return false;
      cursor = nextCursor;
    }
  }
  return true;
}

export async function inspectEdgeTargetReconciliation(input: {
  db: D1Database;
  edgeDb?: D1Database;
  available: boolean;
}): Promise<EdgeTargetReconciliationStatus> {
  const state = await readState(input.db);
  if (state) return materializeStatus(input.db, state, input.available);
  if (!input.edgeDb) {
    return materializeStatus(input.db, null, false, 'unavailable');
  }
  try {
    return materializeStatus(
      input.db,
      null,
      input.available,
      await edgeTargetParityMatches({ db: input.db, edgeDb: input.edgeDb })
        ? 'not_required'
        : 'required',
    );
  } catch {
    return materializeStatus(input.db, null, false, 'unavailable');
  }
}

export async function startEdgeTargetReconciliation(input: {
  db: D1Database;
  initiator: OperationsInitiator;
  operationId?: string;
  now?: Date;
}): Promise<EdgeTargetReconciliationStatus> {
  if (await readState(input.db)) {
    throw new EdgeTargetReconciliationError('state_conflict', 'A reconciliation is already active.');
  }
  const operationId = input.operationId ?? hexId();
  const nowIso = (input.now ?? new Date()).toISOString();
  await input.db.prepare(`
    INSERT INTO edge_comment_target_reconciliation_state (
      id, operation_id, phase, started_at_iso, updated_at_iso,
      initiated_by_user_id, initiated_by_user_email
    ) VALUES (1, ?, 'drain_outbox', ?, ?, ?, ?)
  `).bind(
    operationId,
    nowIso,
    nowIso,
    input.initiator.userId,
    input.initiator.userEmail,
  ).run();
  return materializeStatus(input.db, (await readState(input.db))!, true);
}

async function updatePhase(input: {
  db: D1Database;
  state: ReconciliationState;
  phase: ReconciliationPhase;
  cursorPublicId?: number;
  edgeCursorId?: number;
  syncedPosts?: number;
  syncedPages?: number;
  scannedTargets?: number;
  now?: Date;
}) {
  const result = await input.db.prepare(`
    UPDATE edge_comment_target_reconciliation_state
    SET phase = ?, cursor_public_id = ?, edge_cursor_id = ?,
        synced_posts = ?, synced_pages = ?, scanned_targets = ?,
        updated_at_iso = ?
    WHERE id = 1 AND operation_id = ? AND phase = ?
      AND cursor_public_id = ? AND edge_cursor_id = ?
  `).bind(
    input.phase,
    input.cursorPublicId ?? input.state.cursorPublicId,
    input.edgeCursorId ?? input.state.edgeCursorId,
    input.syncedPosts ?? input.state.syncedPosts,
    input.syncedPages ?? input.state.syncedPages,
    input.scannedTargets ?? input.state.scannedTargets,
    (input.now ?? new Date()).toISOString(),
    input.state.operationId,
    input.state.phase,
    input.state.cursorPublicId,
    input.state.edgeCursorId,
  ).run();
  if (changes(result) !== 1) {
    throw new EdgeTargetReconciliationError('state_conflict', 'Reconciliation cursor changed.');
  }
}

async function syncSourcePage(input: {
  db: D1Database;
  edgeDb: D1Database;
  state: ReconciliationState;
  type: 'post' | 'page';
  now?: Date;
}) {
  const table = input.type === 'post' ? 'posts' : 'pages';
  const result = await input.db.prepare(`
    SELECT public_id, status, allow_comments
    FROM ${table}
    WHERE public_id > ?
    ORDER BY public_id
    LIMIT ?
  `).bind(
    input.state.cursorPublicId,
    EDGE_TARGET_RECONCILIATION_BATCH_SIZE,
  ).all<Record<string, unknown>>();
  const targets = (result.results ?? []).map((row): CommentTargetProjection => ({
    targetType: input.type,
    publicId: validCount(row.public_id),
    status: row.status as CommentTargetProjection['status'],
    allowComments: row.allow_comments === 1,
  }));
  await syncCommentTargets({ edgeDb: input.edgeDb, targets });
  const nextPhase = targets.length < EDGE_TARGET_RECONCILIATION_BATCH_SIZE
    ? input.type === 'post' ? 'sync_pages' : 'scan_orphans'
    : input.state.phase;
  const lastPublicId = targets.at(-1)?.publicId ?? input.state.cursorPublicId;
  await updatePhase({
    db: input.db,
    state: input.state,
    phase: nextPhase,
    cursorPublicId: nextPhase === input.state.phase ? lastPublicId : 0,
    syncedPosts: input.type === 'post'
      ? input.state.syncedPosts + targets.length
      : input.state.syncedPosts,
    syncedPages: input.type === 'page'
      ? input.state.syncedPages + targets.length
      : input.state.syncedPages,
    now: input.now,
  });
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function existingStudioTargetKeys(
  db: D1Database,
  targets: readonly EdgeTarget[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const type of ['post', 'page'] as const) {
    const ids = targets.filter((target) => target.targetType === type)
      .map((target) => target.publicId);
    const table = type === 'post' ? 'posts' : 'pages';
    for (const part of chunks(ids, LOOKUP_CHUNK_SIZE)) {
      if (part.length === 0) continue;
      const rows = await db.prepare(`
        SELECT public_id FROM ${table}
        WHERE public_id IN (${part.map(() => '?').join(', ')})
      `).bind(...part).all<{ public_id?: unknown }>();
      for (const row of rows.results ?? []) {
        found.add(`${type}:${validCount(row.public_id)}`);
      }
    }
  }
  return found;
}

async function commentCounts(
  edgeDb: D1Database,
  targetIds: readonly number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (const part of chunks(targetIds, LOOKUP_CHUNK_SIZE)) {
    if (part.length === 0) continue;
    const result = await edgeDb.prepare(`
      SELECT target_id, COUNT(*) AS comment_count
      FROM comments
      WHERE target_id IN (${part.map(() => '?').join(', ')})
      GROUP BY target_id
    `).bind(...part).all<{ target_id?: unknown; comment_count?: unknown }>();
    for (const row of result.results ?? []) {
      counts.set(validCount(row.target_id), validCount(row.comment_count));
    }
  }
  return counts;
}

async function scanEdgePage(input: {
  db: D1Database;
  edgeDb: D1Database;
  state: ReconciliationState;
  now?: Date;
}) {
  const result = await input.edgeDb.prepare(`
    SELECT id, target_type, public_id, status, allow_comments,
           comments_cache_revision
    FROM edge_comment_targets
    WHERE id > ?
    ORDER BY id
    LIMIT ?
  `).bind(
    input.state.edgeCursorId,
    EDGE_TARGET_RECONCILIATION_BATCH_SIZE,
  ).all<EdgeTargetRow>();
  const targets = (result.results ?? []).map(parseEdgeTarget);
  const existing = await existingStudioTargetKeys(input.db, targets);
  const orphans = targets.filter((target) =>
    !existing.has(`${target.targetType}:${target.publicId}`));
  const counts = await commentCounts(
    input.edgeDb,
    orphans.map(({ id }) => id),
  );
  const nowIso = (input.now ?? new Date()).toISOString();
  if (orphans.length > 0) {
    await input.db.batch(orphans.map((target) => input.db.prepare(`
      INSERT INTO edge_comment_target_reconciliation_orphans (
        operation_id, target_id, target_type, public_id, status,
        allow_comments, comments_cache_revision, comment_count,
        discovered_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id, target_id) DO UPDATE SET
        target_type = excluded.target_type,
        public_id = excluded.public_id,
        status = excluded.status,
        allow_comments = excluded.allow_comments,
        comments_cache_revision = excluded.comments_cache_revision,
        comment_count = excluded.comment_count,
        discovered_at_iso = excluded.discovered_at_iso
    `).bind(
      input.state.operationId,
      target.id,
      target.targetType,
      target.publicId,
      target.status,
      target.allowComments ? 1 : 0,
      target.commentsCacheRevision,
      counts.get(target.id) ?? 0,
      nowIso,
    )));
  }
  const nextPhase = targets.length < EDGE_TARGET_RECONCILIATION_BATCH_SIZE
    ? 'orphan_review'
    : 'scan_orphans';
  await updatePhase({
    db: input.db,
    state: input.state,
    phase: nextPhase,
    edgeCursorId: targets.at(-1)?.id ?? input.state.edgeCursorId,
    scannedTargets: input.state.scannedTargets + targets.length,
    now: input.now,
  });
}

export async function applyEdgeTargetReconciliationStep(input: {
  env: Env;
  operationId: string;
  now?: Date;
}): Promise<EdgeTargetReconciliationStatus> {
  if (!input.env.EDGE_DB) {
    throw new EdgeTargetReconciliationError('not_available', 'EDGE_DB is unavailable.');
  }
  const state = await readState(input.env.DB);
  if (!state || state.operationId !== input.operationId) {
    throw new EdgeTargetReconciliationError('state_conflict', 'Reconciliation operation changed.');
  }
  switch (state.phase) {
    case 'drain_outbox': {
      const result = await drainCommentTargetProjectionOutbox({
        env: input.env,
        limit: COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT,
        force: true,
        now: input.now,
      });
      if (result.remainingEvents === 0) {
        await updatePhase({
          db: input.env.DB,
          state,
          phase: 'sync_posts',
          now: input.now,
        });
      }
      break;
    }
    case 'sync_posts':
      await syncSourcePage({
        db: input.env.DB, edgeDb: input.env.EDGE_DB,
        state, type: 'post', now: input.now,
      });
      break;
    case 'sync_pages':
      await syncSourcePage({
        db: input.env.DB, edgeDb: input.env.EDGE_DB,
        state, type: 'page', now: input.now,
      });
      break;
    case 'scan_orphans':
      await scanEdgePage({
        db: input.env.DB, edgeDb: input.env.EDGE_DB,
        state, now: input.now,
      });
      break;
    case 'orphan_review':
      break;
  }
  return materializeStatus(input.env.DB, await readState(input.env.DB), true);
}

export async function listEdgeTargetOrphans(input: {
  db: D1Database;
  operationId: string;
  cursor?: number;
  limit?: number;
}): Promise<{ items: EdgeTargetOrphan[]; nextCursor: number | null }> {
  const state = await readState(input.db);
  if (!state || state.operationId !== input.operationId || state.phase !== 'orphan_review') {
    throw new EdgeTargetReconciliationError('state_conflict', 'Orphan review is unavailable.');
  }
  const limit = Math.min(input.limit ?? EDGE_TARGET_ORPHAN_PAGE_SIZE, EDGE_TARGET_ORPHAN_PAGE_SIZE);
  const result = await input.db.prepare(`
    SELECT target_id, target_type, public_id, status, allow_comments,
           comment_count
    FROM edge_comment_target_reconciliation_orphans
    WHERE operation_id = ? AND target_id > ?
    ORDER BY target_id
    LIMIT ?
  `).bind(input.operationId, input.cursor ?? 0, limit + 1)
    .all<Record<string, unknown>>();
  const rows = result.results ?? [];
  const hasNext = rows.length > limit;
  const items = rows.slice(0, limit).map((row): EdgeTargetOrphan => ({
    target_id: validCount(row.target_id),
    target_type: row.target_type as 'post' | 'page',
    target_public_id: validCount(row.public_id),
    status: row.status as EdgeTargetOrphan['status'],
    allow_comments: row.allow_comments === 1,
    comment_count: validCount(row.comment_count),
  }));
  return {
    items,
    nextCursor: hasNext ? items.at(-1)!.target_id : null,
  };
}

type OrphanSnapshot = EdgeTarget & { commentCount: number };

async function readOrphanSnapshot(
  db: D1Database,
  operationId: string,
  targetId: number,
): Promise<OrphanSnapshot | null> {
  const row = await db.prepare(`
    SELECT target_id AS id, target_type, public_id, status, allow_comments,
           comments_cache_revision, comment_count
    FROM edge_comment_target_reconciliation_orphans
    WHERE operation_id = ? AND target_id = ?
    LIMIT 1
  `).bind(operationId, targetId).first<EdgeTargetRow & { comment_count?: unknown }>();
  return row ? { ...parseEdgeTarget(row), commentCount: validCount(row.comment_count) } : null;
}

async function studioTargetExists(
  db: D1Database,
  type: 'post' | 'page',
  publicId: number,
): Promise<boolean> {
  const table = type === 'post' ? 'posts' : 'pages';
  return (await db.prepare(`SELECT 1 AS present FROM ${table} WHERE public_id = ? LIMIT 1`)
    .bind(publicId).first<{ present?: unknown }>())?.present === 1;
}

export async function purgeEdgeTargetOrphans(input: {
  db: D1Database;
  edgeDb: D1Database;
  operationId: string;
  targetIds: readonly number[];
}) {
  if (input.targetIds.length > EDGE_TARGET_ORPHAN_PURGE_LIMIT) {
    throw new EdgeTargetReconciliationError('not_available', 'Too many orphan targets.');
  }
  const state = await readState(input.db);
  if (!state || state.operationId !== input.operationId || state.phase !== 'orphan_review') {
    throw new EdgeTargetReconciliationError('state_conflict', 'Orphan review changed.');
  }
  const results: Array<{
    target_id: number;
    result: 'deleted' | 'not_found' | 'no_longer_orphan' | 'changed';
    deleted_comments: number;
  }> = [];
  for (const targetId of input.targetIds) {
    const snapshot = await readOrphanSnapshot(input.db, input.operationId, targetId);
    if (!snapshot) {
      results.push({ target_id: targetId, result: 'not_found', deleted_comments: 0 });
      continue;
    }
    if (await studioTargetExists(input.db, snapshot.targetType, snapshot.publicId)) {
      await input.db.prepare(`
        DELETE FROM edge_comment_target_reconciliation_orphans
        WHERE operation_id = ? AND target_id = ?
      `).bind(input.operationId, targetId).run();
      results.push({ target_id: targetId, result: 'no_longer_orphan', deleted_comments: 0 });
      continue;
    }
    const currentRow = await input.edgeDb.prepare(`
      SELECT id, target_type, public_id, status, allow_comments,
             comments_cache_revision
      FROM edge_comment_targets WHERE id = ? LIMIT 1
    `).bind(targetId).first<EdgeTargetRow>();
    if (!currentRow) {
      await input.db.prepare(`
        DELETE FROM edge_comment_target_reconciliation_orphans
        WHERE operation_id = ? AND target_id = ?
      `).bind(input.operationId, targetId).run();
      results.push({ target_id: targetId, result: 'not_found', deleted_comments: 0 });
      continue;
    }
    const current = parseEdgeTarget(currentRow);
    const counts = await commentCounts(input.edgeDb, [targetId]);
    const currentCount = counts.get(targetId) ?? 0;
    if (
      current.targetType !== snapshot.targetType
      || current.publicId !== snapshot.publicId
      || current.status !== snapshot.status
      || current.allowComments !== snapshot.allowComments
      || current.commentsCacheRevision !== snapshot.commentsCacheRevision
      || currentCount !== snapshot.commentCount
    ) {
      results.push({ target_id: targetId, result: 'changed', deleted_comments: 0 });
      continue;
    }
    const deleted = await input.edgeDb.prepare(`
      DELETE FROM edge_comment_targets
      WHERE id = ? AND target_type = ? AND public_id = ? AND status = ?
        AND allow_comments = ? AND comments_cache_revision = ?
        AND (SELECT COUNT(*) FROM comments WHERE target_id = ?) = ?
    `).bind(
      targetId, snapshot.targetType, snapshot.publicId, snapshot.status,
      snapshot.allowComments ? 1 : 0, snapshot.commentsCacheRevision,
      targetId, snapshot.commentCount,
    ).run();
    if (changes(deleted) !== 1) {
      results.push({ target_id: targetId, result: 'changed', deleted_comments: 0 });
      continue;
    }
    await input.db.prepare(`
      DELETE FROM edge_comment_target_reconciliation_orphans
      WHERE operation_id = ? AND target_id = ?
    `).bind(input.operationId, targetId).run();
    results.push({
      target_id: targetId,
      result: 'deleted',
      deleted_comments: snapshot.commentCount,
    });
  }
  return results;
}

export async function finalizeEdgeTargetReconciliation(input: {
  db: D1Database;
  edgeDb: D1Database;
  operationId: string;
}): Promise<void> {
  const state = await readState(input.db);
  if (!state || state.operationId !== input.operationId || state.phase !== 'orphan_review') {
    throw new EdgeTargetReconciliationError('state_conflict', 'Reconciliation state changed.');
  }
  const [summary, pending, parity] = await Promise.all([
    orphanSummary(input.db, input.operationId),
    countPendingCommentTargetEvents({ db: input.db }),
    edgeTargetParityMatches({ db: input.db, edgeDb: input.edgeDb }),
  ]);
  if (summary.targets > 0) {
    throw new EdgeTargetReconciliationError('orphans_remaining', 'Review every orphan target first.');
  }
  if (pending > 0 || !parity) {
    throw new EdgeTargetReconciliationError('parity_failed', 'Edge target parity was not reached.');
  }
  const result = await input.db.prepare(`
    DELETE FROM edge_comment_target_reconciliation_state
    WHERE id = 1 AND operation_id = ? AND phase = 'orphan_review'
  `).bind(input.operationId).run();
  if (changes(result) !== 1) {
    throw new EdgeTargetReconciliationError('state_conflict', 'Reconciliation state changed.');
  }
}

export async function cancelEdgeTargetReconciliation(input: {
  db: D1Database;
  operationId: string;
}): Promise<void> {
  const result = await input.db.prepare(`
    DELETE FROM edge_comment_target_reconciliation_state
    WHERE id = 1 AND operation_id = ?
  `).bind(input.operationId).run();
  if (changes(result) !== 1) {
    throw new EdgeTargetReconciliationError('state_conflict', 'Reconciliation state changed.');
  }
}

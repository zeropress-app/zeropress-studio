import { edgeIntegrationModeSchema } from '../../../contracts/session';
import { inspectEdgeDatabaseRuntimeState } from '../edge-database/runtime-state';
import { StudioOperationalError } from '../lib/operational-error';
import type { Env } from '../types';

export const COMMENT_TARGET_OUTBOX_LEASE_MS = 5 * 60 * 1000;
export const COMMENT_TARGET_OUTBOX_IMMEDIATE_LIMIT = 25;
export const COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT = 250;

type OutboxRow = {
  id: unknown;
  event_id: unknown;
  target_type: unknown;
  target_public_id: unknown;
  operation: unknown;
  status: unknown;
  allow_comments: unknown;
};

type ClaimedEvent = {
  id: number;
  eventId: string;
  targetType: 'post' | 'page';
  publicId: number;
  operation: 'upsert' | 'delete';
  status: 'draft' | 'published' | 'trash' | null;
  allowComments: boolean | null;
};

function createHexId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function changes(result: D1Result<unknown> | undefined): number {
  const value = result?.meta?.changes;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function queryFailure(error: unknown, action: string) {
  return new StudioOperationalError(
    'COMMENT_TARGET_OUTBOX_DATABASE_QUERY_FAILED',
    {
      cause: error,
      metadata: { resource: 'DB', action },
    },
  );
}

function writeFailure(error: unknown, action: string) {
  return new StudioOperationalError(
    'COMMENT_TARGET_OUTBOX_DATABASE_WRITE_FAILED',
    {
      cause: error,
      metadata: { resource: 'DB', action },
    },
  );
}

function drainFailure(error: unknown, action: string) {
  return new StudioOperationalError('COMMENT_TARGET_OUTBOX_DRAIN_FAILED', {
    cause: error,
    metadata: {
      resource: 'EDGE_DB',
      related_resource: 'DB',
      action,
    },
  });
}

function parseEvent(row: OutboxRow): ClaimedEvent {
  const id = Number(row.id);
  const publicId = Number(row.target_public_id);
  const validId = Number.isSafeInteger(id) && id > 0;
  const validEventId = typeof row.event_id === 'string'
    && /^[0-9a-f]{32}$/u.test(row.event_id);
  const validType = row.target_type === 'post' || row.target_type === 'page';
  const validPublicId = Number.isSafeInteger(publicId) && publicId > 0;
  const validOperation = row.operation === 'upsert' || row.operation === 'delete';
  const validUpsert = row.operation === 'upsert'
    && ['draft', 'published', 'trash'].includes(String(row.status))
    && (row.allow_comments === 0 || row.allow_comments === 1);
  const validDelete = row.operation === 'delete'
    && row.status === null
    && row.allow_comments === null;
  if (
    !validId
    || !validEventId
    || !validType
    || !validPublicId
    || !validOperation
    || (!validUpsert && !validDelete)
  ) {
    throw drainFailure(
      new TypeError('D1 returned an invalid comment-target outbox row.'),
      'validate_comment_target_outbox_event',
    );
  }
  return {
    id,
    eventId: row.event_id as string,
    targetType: row.target_type as 'post' | 'page',
    publicId,
    operation: row.operation as 'upsert' | 'delete',
    status: row.operation === 'upsert'
      ? row.status as ClaimedEvent['status']
      : null,
    allowComments: row.operation === 'upsert'
      ? row.allow_comments === 1
      : null,
  };
}

export async function countPendingCommentTargetEvents(input: {
  db: D1Database;
}): Promise<number> {
  try {
    const row = await input.db.prepare(`
      SELECT COUNT(*) AS count
      FROM edge_comment_target_projection_outbox
    `).first<{ count?: unknown }>();
    const count = Number(row?.count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new TypeError('D1 returned an invalid outbox count.');
    }
    return count;
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'count_comment_target_outbox_events');
  }
}

async function readMode(db: D1Database): Promise<'enabled' | 'disabled'> {
  const row = await db.prepare(`
    SELECT value, type
    FROM studio_settings
    WHERE key = 'edge_integration_mode'
    LIMIT 1
  `).first<{ value?: unknown; type?: unknown }>();
  const parsed = edgeIntegrationModeSchema.safeParse(row?.value);
  return row?.type === 'string' && parsed.success
    ? parsed.data
    : 'disabled';
}

async function claimEvents(input: {
  db: D1Database;
  limit: number;
  now: Date;
  leaseId: string;
}): Promise<ClaimedEvent[]> {
  const nowIso = input.now.toISOString();
  const leaseExpiresAtIso = new Date(
    input.now.getTime() + COMMENT_TARGET_OUTBOX_LEASE_MS,
  ).toISOString();
  try {
    await input.db.prepare(`
      UPDATE edge_comment_target_projection_outbox
      SET lease_id = ?,
          lease_expires_at_iso = ?,
          attempt_count = attempt_count + 1,
          last_attempt_at_iso = ?
      WHERE id IN (
        SELECT candidate.id
        FROM edge_comment_target_projection_outbox AS candidate
        WHERE (
          candidate.lease_id IS NULL
          OR candidate.lease_expires_at_iso <= ?
        )
          AND NOT EXISTS (
            SELECT 1
            FROM edge_comment_target_projection_outbox AS earlier
            WHERE earlier.target_type = candidate.target_type
              AND earlier.target_public_id = candidate.target_public_id
              AND earlier.id < candidate.id
          )
        ORDER BY candidate.id
        LIMIT ?
      )
        AND (lease_id IS NULL OR lease_expires_at_iso <= ?)
    `).bind(
      input.leaseId,
      leaseExpiresAtIso,
      nowIso,
      nowIso,
      input.limit,
      nowIso,
    ).run();
    const result = await input.db.prepare(`
      SELECT id, event_id, target_type, target_public_id, operation,
             status, allow_comments
      FROM edge_comment_target_projection_outbox
      WHERE lease_id = ?
      ORDER BY id
    `).bind(input.leaseId).all<OutboxRow>();
    return (result.results ?? []).map(parseEvent);
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'claim_comment_target_outbox_events');
  }
}

async function releaseLease(input: {
  db: D1Database;
  leaseId: string;
}): Promise<void> {
  try {
    await input.db.prepare(`
      UPDATE edge_comment_target_projection_outbox
      SET lease_id = NULL, lease_expires_at_iso = NULL
      WHERE lease_id = ?
    `).bind(input.leaseId).run();
  } catch (error) {
    throw writeFailure(error, 'release_comment_target_outbox_lease');
  }
}

export type DrainCommentTargetProjectionOutbox =
  typeof drainCommentTargetProjectionOutbox;

export async function drainCommentTargetProjectionOutbox(input: {
  env: Env;
  limit: number;
  force?: boolean;
  now?: Date;
  createLeaseId?: () => string;
}): Promise<{ processedEvents: number; remainingEvents: number }> {
  let mode: 'enabled' | 'disabled';
  try {
    mode = await readMode(input.env.DB);
  } catch (error) {
    throw queryFailure(error, 'read_edge_integration_mode_for_outbox');
  }
  if (mode === 'disabled' && input.force !== true) {
    return {
      processedEvents: 0,
      remainingEvents: await countPendingCommentTargetEvents({
        db: input.env.DB,
      }),
    };
  }
  if (!input.env.EDGE_DB) {
    throw drainFailure(
      new TypeError('EDGE_DB binding is unavailable.'),
      'resolve_edge_database_for_outbox',
    );
  }
  const runtime = await inspectEdgeDatabaseRuntimeState({
    edgeDb: input.env.EDGE_DB,
  });
  if (runtime.state !== 'ready') {
    throw drainFailure(
      new TypeError(`Edge database lifecycle is ${runtime.state}.`),
      'verify_edge_database_lifecycle_for_outbox',
    );
  }

  const leaseId = (input.createLeaseId ?? createHexId)();
  const events = await claimEvents({
    db: input.env.DB,
    limit: input.limit,
    now: input.now ?? new Date(),
    leaseId,
  });
  if (events.length === 0) {
    return {
      processedEvents: 0,
      remainingEvents: await countPendingCommentTargetEvents({
        db: input.env.DB,
      }),
    };
  }

  try {
    await input.env.EDGE_DB.batch(events.map((event) => (
      event.operation === 'upsert'
        ? input.env.EDGE_DB!.prepare(`
            INSERT INTO edge_comment_targets (
              target_type, public_id, status, allow_comments
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(target_type, public_id) DO UPDATE SET
              status = excluded.status,
              allow_comments = excluded.allow_comments
          `).bind(
            event.targetType,
            event.publicId,
            event.status,
            event.allowComments ? 1 : 0,
          )
        : input.env.EDGE_DB!.prepare(`
            DELETE FROM edge_comment_targets
            WHERE target_type = ? AND public_id = ?
          `).bind(event.targetType, event.publicId)
    )));
  } catch (error) {
    try {
      await releaseLease({ db: input.env.DB, leaseId });
    } catch {
      // Preserve the Edge failure as the primary cause. The five-minute lease
      // is bounded and makes this safe to retry without manual cleanup.
    }
    throw drainFailure(error, 'apply_comment_target_outbox_events');
  }

  try {
    const result = await input.env.DB.prepare(`
      DELETE FROM edge_comment_target_projection_outbox
      WHERE lease_id = ?
    `).bind(leaseId).run();
    if (changes(result) !== events.length) {
      throw new TypeError('D1 did not acknowledge every claimed outbox event.');
    }
  } catch (error) {
    throw writeFailure(error, 'acknowledge_comment_target_outbox_events');
  }

  return {
    processedEvents: events.length,
    remainingEvents: await countPendingCommentTargetEvents({
      db: input.env.DB,
    }),
  };
}

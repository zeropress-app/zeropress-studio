import { StudioOperationalError } from '../lib/operational-error';
import type { CommentTargetType } from './request-secrets';

export type CommentTargetProjection = {
  targetType: CommentTargetType;
  publicId: number;
  status: 'draft' | 'published' | 'trash';
  allowComments: boolean;
};

type SourceTargetRow = {
  public_id?: unknown;
  status?: unknown;
  allow_comments?: unknown;
};

// Keep each statement below D1's 100 bound-parameter ceiling while reducing
// a full repair from one query per target to one query per 24 targets.
const TARGETS_PER_UPSERT = 24;
const UPSERT_QUERIES_PER_BATCH = 100;

function normalizeSourceTarget(
  targetType: CommentTargetType,
  row: SourceTargetRow,
): CommentTargetProjection {
  const publicId = Number(row.public_id);
  const status = row.status;
  const allowComments = row.allow_comments === true || row.allow_comments === 1;
  const hasValidAllowComments = row.allow_comments === true
    || row.allow_comments === false
    || row.allow_comments === 0
    || row.allow_comments === 1;
  if (
    !Number.isInteger(publicId)
    || publicId <= 0
    || !['draft', 'published', 'trash'].includes(String(status))
    || !hasValidAllowComments
  ) {
    throw new StudioOperationalError('COMMENT_TARGET_SOURCE_DATA_INVALID', {
      metadata: {
        resource: 'DB',
        action: 'validate_comment_target_projection',
        targetType,
      },
    });
  }
  return {
    targetType,
    publicId,
    status: status as CommentTargetProjection['status'],
    allowComments,
  };
}

function projectionWriteFailure(
  error: unknown,
  action: string,
  target?: Pick<CommentTargetProjection, 'targetType' | 'publicId'>,
): StudioOperationalError {
  if (error instanceof StudioOperationalError) return error;
  return new StudioOperationalError('COMMENT_TARGET_PROJECTION_WRITE_FAILED', {
    cause: error,
    metadata: {
      resource: 'EDGE_DB',
      action,
      ...(target ?? {}),
    },
  });
}

export async function syncCommentTarget(input: {
  edgeDb: D1Database;
  target: CommentTargetProjection;
}): Promise<void> {
  try {
    await input.edgeDb.prepare(`
      INSERT INTO edge_comment_targets (
        target_type, public_id, status, allow_comments
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(target_type, public_id) DO UPDATE SET
        status = excluded.status,
        allow_comments = excluded.allow_comments
    `).bind(
      input.target.targetType,
      input.target.publicId,
      input.target.status,
      input.target.allowComments ? 1 : 0,
    ).run();
  } catch (error) {
    throw projectionWriteFailure(
      error,
      'sync_comment_target',
      input.target,
    );
  }
}

export async function deleteCommentTarget(input: {
  edgeDb: D1Database;
  targetType: CommentTargetType;
  publicId: number;
}): Promise<void> {
  try {
    await input.edgeDb.prepare(`
      DELETE FROM edge_comment_targets
      WHERE target_type = ? AND public_id = ?
    `).bind(input.targetType, input.publicId).run();
  } catch (error) {
    throw projectionWriteFailure(error, 'delete_comment_target', {
      targetType: input.targetType,
      publicId: input.publicId,
    });
  }
}

async function upsertTargets(input: {
  edgeDb: D1Database;
  targets: CommentTargetProjection[];
}): Promise<number> {
  try {
    for (
      let index = 0;
      index < input.targets.length;
      index += TARGETS_PER_UPSERT * UPSERT_QUERIES_PER_BATCH
    ) {
      const batchTargets = input.targets.slice(
        index,
        index + TARGETS_PER_UPSERT * UPSERT_QUERIES_PER_BATCH,
      );
      const statements = [];
      for (
        let queryIndex = 0;
        queryIndex < batchTargets.length;
        queryIndex += TARGETS_PER_UPSERT
      ) {
        const targets = batchTargets.slice(
          queryIndex,
          queryIndex + TARGETS_PER_UPSERT,
        );
        const values = targets.map(() => '(?, ?, ?, ?)').join(', ');
        const bindings = targets.flatMap((target) => [
          target.targetType,
          target.publicId,
          target.status,
          target.allowComments ? 1 : 0,
        ]);
        statements.push(input.edgeDb.prepare(`
          INSERT INTO edge_comment_targets (
            target_type, public_id, status, allow_comments
          ) VALUES ${values}
          ON CONFLICT(target_type, public_id) DO UPDATE SET
            status = excluded.status,
            allow_comments = excluded.allow_comments
        `).bind(...bindings));
      }
      await input.edgeDb.batch(statements);
    }
  } catch (error) {
    throw projectionWriteFailure(error, 'sync_comment_targets');
  }
  return input.targets.length;
}

export async function syncCommentTargets(input: {
  edgeDb: D1Database;
  targets: CommentTargetProjection[];
}): Promise<number> {
  if (input.targets.length === 0) return 0;
  return upsertTargets({
    edgeDb: input.edgeDb,
    targets: input.targets.map((target) => normalizeSourceTarget(
      target.targetType,
      {
        public_id: target.publicId,
        status: target.status,
        allow_comments: target.allowComments,
      },
    )),
  });
}

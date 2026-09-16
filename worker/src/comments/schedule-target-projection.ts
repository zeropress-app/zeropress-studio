import type { Context } from 'hono';
import {
  COMMENT_TARGET_OUTBOX_IMMEDIATE_LIMIT,
  COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT,
  drainCommentTargetProjectionOutbox,
} from './target-projection-outbox';
import {
  logOperationalFailure,
  logStudioOperationalError,
  StudioOperationalError,
} from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';

export function scheduleCommentTargetProjectionDrain(
  c: Context<StudioHonoEnvironment>,
): void {
  const task = drainCommentTargetProjectionOutbox({
    env: c.env,
    limit: COMMENT_TARGET_OUTBOX_IMMEDIATE_LIMIT,
  }).catch((error) => {
    if (error instanceof StudioOperationalError) {
      logStudioOperationalError(error, {
        trigger: 'waitUntil',
        method: c.req.method,
        pathname: new URL(c.req.url).pathname,
      });
      return;
    }
    logOperationalFailure('COMMENT_TARGET_OUTBOX_DRAIN_FAILED', {
      cause: error,
      metadata: {
        trigger: 'waitUntil',
        action: 'drain_comment_target_projection_after_write',
      },
    });
  });
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // Hono unit requests do not provide an ExecutionContext. The task already
    // owns its rejection and can safely finish without delaying the response.
    void task;
  }
}

export async function flushCommentTargetProjectionAfterWxrChunk(
  c: Context<StudioHonoEnvironment>,
): Promise<void> {
  try {
    await drainCommentTargetProjectionOutbox({
      env: c.env,
      limit: COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT,
    });
  } catch (error) {
    if (error instanceof StudioOperationalError) {
      logStudioOperationalError(error, {
        trigger: 'request',
        method: c.req.method,
        pathname: new URL(c.req.url).pathname,
      });
      return;
    }
    logOperationalFailure('COMMENT_TARGET_OUTBOX_DRAIN_FAILED', {
      cause: error,
      metadata: {
        trigger: 'request',
        action: 'drain_comment_target_projection_after_wxr_chunk',
      },
    });
  }
}

import type { Context } from 'hono';
import type { StudioHonoEnvironment } from '../types';
import { inspectEdgeDatabaseRuntimeState } from '../edge-database/runtime-state';
import { generatePreviewDataExport } from './projection';
import { readEdgeIntegrationModeFailClosed } from '../settings/edge-services-repository';
import {
  COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT,
  drainCommentTargetProjectionOutbox,
} from '../comments/target-projection-outbox';
import { errorResponse } from '../lib/http';
import {
  logStudioOperationalError,
  StudioOperationalError,
} from '../lib/operational-error';
import {
  edgeHealthFailure,
  inspectEdgeIntegration,
} from '../settings/edge-integration-health';
import { requireEdgeIntegrationReady } from '../settings/edge-integration-gate';

export type PreviewDataPreparationDependencies = {
  generateExport?: typeof generatePreviewDataExport;
  readEdgeIntegrationMode?: typeof readEdgeIntegrationModeFailClosed;
  drainProjections?: typeof drainCommentTargetProjectionOutbox;
  inspectEdge?: typeof inspectEdgeIntegration;
  inspectEdgeDatabaseRuntime?: typeof inspectEdgeDatabaseRuntimeState;
  now?: () => Date;
};

export async function preparePreviewDataExport(
  c: Context<StudioHonoEnvironment>,
  dependencies: PreviewDataPreparationDependencies = {},
) {
  const generateExport =
    dependencies.generateExport ?? generatePreviewDataExport;
  const currentTime = dependencies.now ?? (() => new Date());
  const readEdgeIntegrationMode =
    dependencies.readEdgeIntegrationMode ?? readEdgeIntegrationModeFailClosed;
  const drainProjections =
    dependencies.drainProjections ?? drainCommentTargetProjectionOutbox;
  const inspectEdge = dependencies.inspectEdge ?? inspectEdgeIntegration;
  const mode = await readEdgeIntegrationMode({ db: c.env.DB });
  if (mode === 'enabled') {
    const edgeGate = await requireEdgeIntegrationReady(
      c,
      async () => mode,
      dependencies.inspectEdgeDatabaseRuntime,
    );
    if (edgeGate) return edgeGate;
    let drained: Awaited<ReturnType<typeof drainProjections>>;
    try {
      drained = await drainProjections({
        env: c.env,
        limit: COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT,
        now: currentTime(),
      });
    } catch (error) {
      const failure =
        error instanceof StudioOperationalError
          ? error
          : new StudioOperationalError('COMMENT_TARGET_OUTBOX_DRAIN_FAILED', {
              cause: error,
              metadata: {
                resource: 'EDGE_DB',
                related_resource: 'DB',
                action: 'drain_comment_target_projection_before_preview',
              },
            });
      logStudioOperationalError(failure, {
        method: c.req.method,
        pathname: new URL(c.req.url).pathname,
      });
      return errorResponse(c, 503, 'EDGE_INTEGRATION_UNAVAILABLE');
    }
    if (drained.remainingEvents > 0) {
      return errorResponse(c, 409, 'EDGE_TARGET_PROJECTION_PENDING');
    }
    const health = await inspectEdge({ env: c.env });
    if (health.state === 'reconciliation_required') {
      return errorResponse(c, 409, 'EDGE_RECONCILIATION_REQUIRED');
    }
    if (health.state === 'unavailable') {
      logStudioOperationalError(edgeHealthFailure(health), {
        method: c.req.method,
        pathname: new URL(c.req.url).pathname,
      });
      return errorResponse(c, 503, 'EDGE_INTEGRATION_UNAVAILABLE');
    }
  }
  return generateExport({
    db: c.env.DB,
    ...(mode === 'enabled' ? { edgeDb: c.env.EDGE_DB! } : {}),
    generatedAt: currentTime(),
  });
}

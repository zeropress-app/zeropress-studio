import { Hono, type Context } from 'hono';
import {
  previewDataSuccessSchema,
  previewDataSummarySuccessSchema,
} from '../../../contracts/preview-data';
import { requireStudioCapability } from '../auth/authorization';
import type { ResolveUserSession } from '../auth/session-repository';
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
import { readPreviewDataSummary } from './summary';

type PreviewDataRouteDependencies = {
  resolveSession?: ResolveUserSession;
  generateExport?: typeof generatePreviewDataExport;
  readSummary?: typeof readPreviewDataSummary;
  readEdgeIntegrationMode?: typeof readEdgeIntegrationModeFailClosed;
  drainProjections?: typeof drainCommentTargetProjectionOutbox;
  inspectEdge?: typeof inspectEdgeIntegration;
  inspectEdgeDatabaseRuntime?: typeof inspectEdgeDatabaseRuntimeState;
  now?: () => Date;
};

export function createPreviewDataRoutes(
  dependencies: PreviewDataRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const generateExport = dependencies.generateExport
    ?? generatePreviewDataExport;
  const readSummary = dependencies.readSummary ?? readPreviewDataSummary;
  const currentTime = dependencies.now ?? (() => new Date());
  const readEdgeIntegrationMode = dependencies.readEdgeIntegrationMode
    ?? readEdgeIntegrationModeFailClosed;
  const drainProjections = dependencies.drainProjections
    ?? drainCommentTargetProjectionOutbox;
  const inspectEdge = dependencies.inspectEdge ?? inspectEdgeIntegration;

  async function requirePublisher(
    c: Context<StudioHonoEnvironment>,
  ) {
    return requireStudioCapability({
      context: c,
      capability: 'publish.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  routes.get('/summary', async (c) => {
    const session = await requirePublisher(c);
    if (session instanceof Response) return session;
    const summary = await readSummary({ db: c.env.DB });
    c.header('Cache-Control', 'no-store');
    return c.json(previewDataSummarySuccessSchema.parse({
      success: true,
      data: summary,
    }));
  });

  routes.get('/', async (c) => {
    const session = await requirePublisher(c);
    if (session instanceof Response) return session;
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
        const failure = error instanceof StudioOperationalError
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
    const document = await generateExport({
      db: c.env.DB,
      ...(mode === 'enabled' ? { edgeDb: c.env.EDGE_DB! } : {}),
      generatedAt: currentTime(),
    });
    c.header('Cache-Control', 'no-store');
    return c.json(previewDataSuccessSchema.parse({
      success: true,
      data: document,
    }));
  });

  return routes;
}

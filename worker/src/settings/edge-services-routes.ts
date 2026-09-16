import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  drainEdgeProjectionsRequestSchema,
  drainEdgeProjectionsSuccessSchema,
  edgeServicesSuccessSchema,
  updateEdgeServicesRequestSchema,
} from '../../../contracts/edge-services';
import { requireStudioCapability } from '../auth/authorization';
import { readJsonBody } from '../auth/auth-route-utils';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import {
  COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT,
  countPendingCommentTargetEvents,
  drainCommentTargetProjectionOutbox,
  type DrainCommentTargetProjectionOutbox,
} from '../comments/target-projection-outbox';
import { errorResponse } from '../lib/http';
import {
  logStudioOperationalError,
  StudioOperationalError,
} from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import { inspectEdgeDatabaseRuntimeState } from '../edge-database/runtime-state';
import {
  edgeHealthFailure,
  inspectEdgeIntegration,
} from './edge-integration-health';
import {
  edgeIntegrationActivationError,
  materializeEdgeServicesDocument,
} from './edge-services-service';
import {
  readEdgeIntegrationSettings,
  updateEdgeIntegrationSettings,
} from './edge-services-repository';
import { requireEdgeIntegrationReady } from './edge-integration-gate';

const EDGE_SERVICES_BODY_LIMIT = 8 * 1024;

export type EdgeServicesRouteDependencies = {
  resolveSession?: ResolveUserSession;
  readSettings?: typeof readEdgeIntegrationSettings;
  updateSettings?: typeof updateEdgeIntegrationSettings;
  countPending?: typeof countPendingCommentTargetEvents;
  inspect?: typeof inspectEdgeIntegration;
  drain?: DrainCommentTargetProjectionOutbox;
  inspectEdgeDatabaseRuntime?: typeof inspectEdgeDatabaseRuntimeState;
  now?: () => Date;
  createRevision?: () => string;
};

export function createEdgeServicesRoutes(
  dependencies: EdgeServicesRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const readSettings = dependencies.readSettings ?? readEdgeIntegrationSettings;
  const updateSettings = dependencies.updateSettings
    ?? updateEdgeIntegrationSettings;
  const countPending = dependencies.countPending
    ?? countPendingCommentTargetEvents;
  const inspect = dependencies.inspect ?? inspectEdgeIntegration;
  const drain = dependencies.drain ?? drainCommentTargetProjectionOutbox;
  const currentTime = dependencies.now ?? (() => new Date());

  async function requireManager(c: Context<StudioHonoEnvironment>) {
    return requireStudioCapability({
      context: c,
      capability: 'settings.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  async function authorizeMutation(c: Context<StudioHonoEnvironment>) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return session;
  }

  const materializeDocument = (c: Context<StudioHonoEnvironment>) =>
    materializeEdgeServicesDocument({
      env: c.env,
      dependencies: { readSettings, countPending, inspect },
      requestContext: {
        method: c.req.method,
        pathname: new URL(c.req.url).pathname,
      },
    });

  routes.get('/', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    return c.json(edgeServicesSuccessSchema.parse({
      success: true,
      data: await materializeDocument(c),
    }));
  });

  routes.put('/', bodyLimit({
    maxSize: EDGE_SERVICES_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateEdgeServicesRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');

    if (parsed.data.settings.mode === 'enabled') {
      const health = await inspect({
        env: c.env,
        countPending,
      });
      const activationError = edgeIntegrationActivationError(health);
      if (activationError) {
        if (
          health.state === 'unavailable'
          && activationError === 'EDGE_INTEGRATION_UNAVAILABLE'
        ) {
          logStudioOperationalError(edgeHealthFailure(health), {
            method: c.req.method,
            pathname: new URL(c.req.url).pathname,
          });
        }
        return errorResponse(
          c,
          activationError === 'EDGE_INTEGRATION_UNAVAILABLE' ? 503 : 409,
          activationError,
        );
      }
    }

    const result = await updateSettings({
      db: c.env.DB,
      mode: parsed.data.settings.mode,
      expectedRevision: parsed.data.expected_revision,
      updatedBy: session.user.id,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    }
    return c.json(edgeServicesSuccessSchema.parse({
      success: true,
      data: await materializeDocument(c),
    }));
  });

  routes.post('/projections/drain', bodyLimit({
    maxSize: 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    if (!drainEdgeProjectionsRequestSchema.safeParse(body.value).success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const stored = await readSettings({ db: c.env.DB });
    if (stored.settings.mode !== 'enabled') {
      return errorResponse(c, 409, 'EDGE_INTEGRATION_DISABLED');
    }
    const edgeGate = await requireEdgeIntegrationReady(
      c,
      async () => stored.settings.mode,
      dependencies.inspectEdgeDatabaseRuntime,
    );
    if (edgeGate) return edgeGate;
    try {
      const result = await drain({
        env: c.env,
        limit: COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT,
        now: currentTime(),
      });
      return c.json(drainEdgeProjectionsSuccessSchema.parse({
        success: true,
        data: {
          processed_events: result.processedEvents,
          remaining_events: result.remainingEvents,
        },
      }));
    } catch (error) {
      const failure = error instanceof StudioOperationalError
        ? error
        : new StudioOperationalError('COMMENT_TARGET_OUTBOX_DRAIN_FAILED', {
            cause: error,
            metadata: { action: 'manual_comment_target_outbox_drain' },
          });
      logStudioOperationalError(failure, {
        method: c.req.method,
        pathname: new URL(c.req.url).pathname,
      });
      return errorResponse(c, 503, 'EDGE_INTEGRATION_UNAVAILABLE');
    }
  });

  return routes;
}

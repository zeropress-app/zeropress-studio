import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  contentSearchIndexDashboardStartRequestSchema,
  contentSearchIndexRebuildMutationSuccessSchema,
  contentSearchIndexRebuildStepRequestSchema,
  contentSearchIndexStatusSchema,
  type ContentSearchIndexStatus,
} from '../../../contracts/content-search-index';
import { beginAudit, recordAudit } from '../audit/service';
import { logAuditedOperation } from '../audit/operations';
import { requireStudioCapability } from '../auth/authorization';
import { readJsonBody } from '../auth/auth-route-utils';
import { hasValidCsrfHeader, isSameOriginMutation } from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { isEdgeTargetReconciliationInProgress } from '../comments/target-reconciliation';
import { errorResponse } from '../lib/http';
import { logStudioOperationalError, StudioOperationalError } from '../lib/operational-error';
import { isDatabaseRestoreInProgress } from '../operations/database-backup';
import { operationsInitiatorMetadata, type OperationsInitiator } from '../operations/initiator';
import type { StudioHonoEnvironment } from '../types';
import {
  applyContentSearchIndexRebuildStep,
  ContentSearchRebuildError,
  inspectContentSearchIndex,
  readContentSearchRebuildInitiator,
  startContentSearchIndexRebuild,
} from './rebuild';

export type ContentSearchIndexRouteDependencies = {
  resolveSession?: ResolveUserSession;
  inspect?: typeof inspectContentSearchIndex;
  start?: typeof startContentSearchIndexRebuild;
  step?: typeof applyContentSearchIndexRebuildStep;
  readInitiator?: typeof readContentSearchRebuildInitiator;
  restoreInProgress?: typeof isDatabaseRestoreInProgress;
  reconciliationInProgress?: typeof isEdgeTargetReconciliationInProgress;
};

// The application system gate requires operational mode and a current schema.
// These endpoints use the administrator session, independently of Operations access.
export function createContentSearchIndexRoutes(
  dependencies: ContentSearchIndexRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const inspect = dependencies.inspect ?? inspectContentSearchIndex;
  const start = dependencies.start ?? startContentSearchIndexRebuild;
  const step = dependencies.step ?? applyContentSearchIndexRebuildStep;
  const readInitiator = dependencies.readInitiator ?? readContentSearchRebuildInitiator;
  const restoreInProgress = dependencies.restoreInProgress ?? isDatabaseRestoreInProgress;
  const reconciliationInProgress = dependencies.reconciliationInProgress
    ?? isEdgeTargetReconciliationInProgress;

  const requireManager = (c: Context<StudioHonoEnvironment>) => requireStudioCapability({
    context: c,
    capability: 'settings.manage',
    resolveSession: dependencies.resolveSession,
  });

  async function authorizeMutation(c: Context<StudioHonoEnvironment>) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return session;
  }

  async function hasConflictingOperation(db: D1Database) {
    return await restoreInProgress(db) || await reconciliationInProgress(db);
  }

  function mutationResult(
    c: Context<StudioHonoEnvironment>,
    status: ContentSearchIndexStatus,
    started = false,
  ) {
    return c.json(contentSearchIndexRebuildMutationSuccessSchema.parse({
      success: true,
      data: {
        operation: 'rebuild_content_search_index',
        status: started ? 'started' : status.state === 'ready' ? 'completed' : 'in_progress',
        content_search_index: status,
      },
    }));
  }

  function rebuildFailure(
    c: Context<StudioHonoEnvironment>,
    error: unknown,
    metadata: Record<string, unknown>,
  ) {
    const failure = new StudioOperationalError('CONTENT_SEARCH_INDEX_REBUILD_FAILED', {
      cause: error, metadata,
    });
    if (error instanceof ContentSearchRebuildError) {
      if (error.issue === 'integrity_failed') {
        logStudioOperationalError(failure, {
          method: c.req.method, pathname: new URL(c.req.url).pathname,
        });
        const attempt = c.get('audit')?.attempt;
        if (attempt) recordAudit(c, {
          ...attempt, outcome: 'failed',
          metadata: { ...attempt.metadata, error_code: 'CONTENT_SEARCH_INDEX_REBUILD_NOT_AVAILABLE' },
        });
      }
      return errorResponse(c, 409, error.issue === 'state_conflict'
        ? 'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT'
        : 'CONTENT_SEARCH_INDEX_REBUILD_NOT_AVAILABLE');
    }
    throw failure;
  }

  routes.get('/', async (c) => {
    const session = await requireManager(c);
    if (session instanceof Response) return session;
    const status = await inspect({ db: c.env.DB, available: true });
    return c.json({
      success: true,
      data: contentSearchIndexStatusSchema.parse({
        ...status,
        available: (status.state === 'rebuild_required' || status.state === 'in_progress')
          && !await hasConflictingOperation(c.env.DB),
      }),
    });
  });

  const limit = bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  });

  routes.post('/rebuild/start', limit, async (c) => {
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    if (!contentSearchIndexDashboardStartRequestSchema.safeParse(body.value).success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    if (await hasConflictingOperation(c.env.DB)) {
      return errorResponse(c, 409, 'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT');
    }
    const initiator: OperationsInitiator = {
      userId: session.user.id, userEmail: session.user.email,
    };
    beginAudit(c, {
      action: 'operations_search', target: { type: 'DB' },
      metadata: { operation: 'rebuild_content_search_index', stage: 'started' },
    });
    try {
      const status = await start({
        db: c.env.DB, initiator, expectedState: 'rebuild_required',
      });
      logAuditedOperation(c, 'MAINTENANCE_OPERATION_STARTED', {
        metadata: {
          resource: 'DB', action: 'rebuild_content_search_index',
          operation_id: status.operation_id, phase: status.phase,
          ...operationsInitiatorMetadata(initiator),
        },
      });
      return mutationResult(c, status, true);
    } catch (error) {
      return rebuildFailure(c, error, {
        resource: 'DB', action: 'start_content_search_index_rebuild',
        ...operationsInitiatorMetadata(initiator),
      });
    }
  });

  routes.post('/rebuild/step', limit, async (c) => {
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = contentSearchIndexRebuildStepRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    if (await hasConflictingOperation(c.env.DB)) {
      return errorResponse(c, 409, 'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT');
    }
    let initiator: OperationsInitiator | null = null;
    try {
      initiator = await readInitiator({
        db: c.env.DB, operationId: parsed.data.operation_id,
      });
      beginAudit(c, {
        action: 'operations_search', target: { type: 'DB' },
        metadata: {
          operation: 'apply_content_search_index_rebuild_step', stage: 'step',
          operation_id: parsed.data.operation_id,
          initiator: {
            kind: 'user', id: initiator.userId, email: initiator.userEmail, name: null,
          },
        },
      });
      const status = await step({ db: c.env.DB, request: parsed.data });
      logAuditedOperation(c, status.state === 'ready'
        ? 'CONTENT_SEARCH_INDEX_REBUILD_COMPLETED' : 'MAINTENANCE_OPERATION_STARTED', {
        metadata: {
          resource: 'DB',
          action: status.state === 'ready'
            ? 'complete_content_search_index_rebuild' : 'advance_content_search_index_rebuild',
          operation_id: parsed.data.operation_id, phase: status.phase,
          processed_posts: status.processed_posts, processed_pages: status.processed_pages,
          ...operationsInitiatorMetadata(initiator),
        },
      });
      return mutationResult(c, status);
    } catch (error) {
      return rebuildFailure(c, error, {
        resource: 'DB', action: 'apply_content_search_index_rebuild_step',
        operation_id: parsed.data.operation_id,
        ...operationsInitiatorMetadata(initiator),
      });
    }
  });
  return routes;
}

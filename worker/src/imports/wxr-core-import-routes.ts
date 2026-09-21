import { recordAudit, beginAudit } from '../audit/service';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  WXR_IMPORT_REQUEST_BODY_LIMIT,
  wxrCoreImportChunkRequestSchema,
  wxrCoreImportChunkSuccessSchema,
  wxrImportSettingsFinalizeRequestSchema,
  wxrImportSettingsFinalizeSuccessSchema,
} from '../../../contracts/wxr-import';
import { readJsonBody } from '../auth/auth-route-utils';
import { requireStudioCapability } from '../auth/authorization';
import type { ResolveUserSession } from '../auth/session-repository';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import { requireEdgeDatabase } from '../comments/edge-db';
import {
  flushCommentTargetProjectionAfterWxrChunk,
} from '../comments/schedule-target-projection';
import {
  COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT,
  drainCommentTargetProjectionOutbox,
} from '../comments/target-projection-outbox';
import { errorResponse } from '../lib/http';
import {
  logStudioOperationalError,
  StudioOperationalError,
} from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import { inspectEdgeDatabaseRuntimeState } from '../edge-database/runtime-state';
import { importWxrCommentChunk } from './wxr-comment-import-repository';
import { importWxrCoreChunk } from './wxr-core-import-repository';
import { requireEdgeIntegrationReady } from '../settings/edge-integration-gate';
import { readEdgeIntegrationModeFailClosed } from '../settings/edge-services-repository';
import { finalizeWxrSettings } from './wxr-settings-finalize-repository';

export type WxrCoreImportRouteDependencies = {
  resolveSession?: ResolveUserSession;
  importChunk?: typeof importWxrCoreChunk;
  importCommentChunk?: typeof importWxrCommentChunk;
  flushProjectionAfterChunk?: typeof flushCommentTargetProjectionAfterWxrChunk;
  drainProjections?: typeof drainCommentTargetProjectionOutbox;
  readEdgeIntegrationMode?: typeof readEdgeIntegrationModeFailClosed;
  inspectEdgeDatabaseRuntime?: typeof inspectEdgeDatabaseRuntimeState;
  finalizeSettings?: typeof finalizeWxrSettings;
  now?: () => Date;
  createId?: () => string;
  createRevision?: () => string;
};

function importBodyLimit() {
  return bodyLimit({
    maxSize: WXR_IMPORT_REQUEST_BODY_LIMIT,
    onError: (c: Context<StudioHonoEnvironment>) => (
      errorResponse(c, 413, 'PAYLOAD_TOO_LARGE')
    ),
  });
}

export function createWxrCoreImportRoutes(
  dependencies: WxrCoreImportRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const importChunk = dependencies.importChunk ?? importWxrCoreChunk;
  const importCommentChunk = dependencies.importCommentChunk
    ?? importWxrCommentChunk;
  const flushProjectionAfterChunk = dependencies.flushProjectionAfterChunk
    ?? flushCommentTargetProjectionAfterWxrChunk;
  const drainProjections = dependencies.drainProjections
    ?? drainCommentTargetProjectionOutbox;
  const finalizeSettings = dependencies.finalizeSettings ?? finalizeWxrSettings;
  const currentTime = dependencies.now ?? (() => new Date());

  routes.post('/core/chunk', importBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = wxrCoreImportChunkRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');

    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const session = await requireStudioCapability({
      context: c,
      capability: 'imports.manage',
      resolveSession: dependencies.resolveSession,
    });
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }

    if (parsed.data.phase === 'comments') {
      const edgeGate = await requireEdgeIntegrationReady(
        c,
        dependencies.readEdgeIntegrationMode,
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
                action: 'drain_comment_target_projection_before_wxr_comments',
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
    }
    beginAudit(c, { action: 'import_chunk', target: { type: 'wxr' }, metadata: { phase: parsed.data.phase } });
    const result = parsed.data.phase === 'comments'
      ? await importCommentChunk({
          edgeDb: requireEdgeDatabase(c.env),
          request: parsed.data,
        })
      : await importChunk({
          db: c.env.DB,
          request: parsed.data,
          now: currentTime(),
          createId: dependencies.createId,
          createRevision: dependencies.createRevision,
        });
    recordAudit(c, { action: 'import_chunk', target: { type: 'wxr' },
      outcome: result.summary.failed ? (result.summary.failed === result.summary.processed ? 'failed' : 'partial')
        : result.summary.created + result.summary.updated > 0 ? 'success' : 'unchanged',
      metadata: { phase: result.summary.phase, requested: result.summary.processed,
        created: result.summary.created, updated: result.summary.updated, skipped: result.summary.unchanged, failed: result.summary.failed } });
    if (parsed.data.phase === 'posts' || parsed.data.phase === 'pages') {
      await flushProjectionAfterChunk(c);
    }
    return c.json(wxrCoreImportChunkSuccessSchema.parse({
      success: true,
      data: result.summary,
    }));
  });

  routes.post('/settings/finalize', importBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = wxrImportSettingsFinalizeRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');

    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const session = await requireStudioCapability({
      context: c,
      capability: 'imports.manage',
      resolveSession: dependencies.resolveSession,
    });
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }

    beginAudit(c, { action: 'import_settings', target: { type: 'wxr' } });
    const result = await finalizeSettings({
      db: c.env.DB,
      request: parsed.data,
      updatedBy: session.user.id,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    }
    if (result.kind === 'front_page_not_found') {
      return errorResponse(c, 409, 'ROUTING_FRONT_PAGE_NOT_FOUND');
    }
    recordAudit(c, { action: 'import_settings', target: { type: 'wxr' },
      outcome: result.generalSettings.result === 'unchanged' && result.routingSettings.result === 'unchanged' ? 'unchanged' : 'success',
      metadata: { fields: ['general', 'routing'] } });
    return c.json(wxrImportSettingsFinalizeSuccessSchema.parse({
      success: true,
      data: {
        general_settings: result.generalSettings,
        routing_settings: result.routingSettings,
      },
    }));
  });

  return routes;
}

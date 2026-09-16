import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  commentRequestSecurityMutationRequestSchema,
  commentRequestSecuritySuccessSchema,
  commentSettingsSuccessSchema,
  updateCommentSettingsRequestSchema,
} from '../../../contracts/comment-settings';
import { readJsonBody } from '../auth/auth-route-utils';
import {
  requireStudioCapability,
  requireStudioSession,
} from '../auth/authorization';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { requireEdgeDatabase } from '../comments/edge-db';
import {
  readCommentRequestSecurity,
  resetStoredCommentRequestSecurity,
  rotateStoredCommentRequestSecurity,
} from '../comments/request-security-repository';
import { errorResponse } from '../lib/http';
import type { StudioHonoEnvironment } from '../types';
import { inspectEdgeDatabaseRuntimeState } from '../edge-database/runtime-state';
import {
  readCommentSettings,
  updateCommentSettings,
} from './comment-settings-repository';
import { requireEdgeIntegrationReady } from './edge-integration-gate';
import { readEdgeIntegrationModeFailClosed } from './edge-services-repository';

const COMMENT_SETTINGS_BODY_LIMIT = 32 * 1024;

export type CommentSettingsRouteDependencies = {
  resolveSession?: ResolveUserSession;
  readSettings?: typeof readCommentSettings;
  updateSettings?: typeof updateCommentSettings;
  readRequestSecurity?: typeof readCommentRequestSecurity;
  rotateRequestSecurity?: typeof rotateStoredCommentRequestSecurity;
  resetRequestSecurity?: typeof resetStoredCommentRequestSecurity;
  readEdgeIntegrationMode?: typeof readEdgeIntegrationModeFailClosed;
  inspectEdgeDatabaseRuntime?: typeof inspectEdgeDatabaseRuntimeState;
  now?: () => Date;
};

export function createCommentSettingsRoutes(
  dependencies: CommentSettingsRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const readSettings = dependencies.readSettings ?? readCommentSettings;
  const updateSettings = dependencies.updateSettings ?? updateCommentSettings;
  const readRequestSecurity = dependencies.readRequestSecurity
    ?? readCommentRequestSecurity;
  const rotateRequestSecurity = dependencies.rotateRequestSecurity
    ?? rotateStoredCommentRequestSecurity;
  const resetRequestSecurity = dependencies.resetRequestSecurity
    ?? resetStoredCommentRequestSecurity;
  const currentTime = dependencies.now ?? (() => new Date());

  async function requireSettingsManager(
    c: Context<StudioHonoEnvironment>,
  ) {
    const session = await requireStudioCapability({
      context: c,
      capability: 'settings.manage',
      resolveSession: dependencies.resolveSession,
    });
    if (session instanceof Response) return session;
    return await requireEdgeIntegrationReady(
      c,
      dependencies.readEdgeIntegrationMode,
      dependencies.inspectEdgeDatabaseRuntime,
    ) ?? session;
  }

  async function authorizeMutation(c: Context<StudioHonoEnvironment>) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return session;
  }

  routes.get('/', async (c) => {
    // The runtime state is safe for authenticated editors to read so the
    // Post/Page editors can explain the effective global comment state.
    const session = await requireStudioSession({
      context: c,
      resolveSession: dependencies.resolveSession,
    });
    if (session instanceof Response) return session;
    const edgeGate = await requireEdgeIntegrationReady(
      c,
      dependencies.readEdgeIntegrationMode,
      dependencies.inspectEdgeDatabaseRuntime,
    );
    if (edgeGate) return edgeGate;
    const document = await readSettings({
      edgeDb: requireEdgeDatabase(c.env),
    });
    return c.json(commentSettingsSuccessSchema.parse({
      success: true,
      data: document,
    }));
  });

  routes.put('/', bodyLimit({
    maxSize: COMMENT_SETTINGS_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateCommentSettingsRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await updateSettings({
      edgeDb: requireEdgeDatabase(c.env),
      settings: parsed.data.settings,
      expectedRevision: parsed.data.expected_revision,
      now: currentTime(),
    });
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    }
    return c.json(commentSettingsSuccessSchema.parse({
      success: true,
      data: result.document,
    }));
  });

  routes.get('/request-security', async (c) => {
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    const resource = await readRequestSecurity({
      edgeDb: requireEdgeDatabase(c.env),
      now: currentTime(),
    });
    return c.json(commentRequestSecuritySuccessSchema.parse({
      success: true,
      data: resource,
    }));
  });

  async function mutateRequestSecurity(
    c: Context<StudioHonoEnvironment>,
    action: 'rotate' | 'reset',
  ) {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = commentRequestSecurityMutationRequestSchema.safeParse(
      body.value,
    );
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const mutate = action === 'rotate'
      ? rotateRequestSecurity
      : resetRequestSecurity;
    const result = await mutate({
      edgeDb: requireEdgeDatabase(c.env),
      expectedRevision: parsed.data.expected_revision,
      now: currentTime(),
    });
    if (result.kind === 'revision_conflict') {
      return errorResponse(
        c,
        409,
        'COMMENT_REQUEST_SECURITY_REVISION_CONFLICT',
      );
    }
    if (result.kind === 'not_rotatable') {
      return errorResponse(
        c,
        409,
        'COMMENT_REQUEST_SECURITY_NOT_ROTATABLE',
      );
    }
    return c.json(commentRequestSecuritySuccessSchema.parse({
      success: true,
      data: result.resource,
    }));
  }

  routes.post('/request-security/rotate', bodyLimit({
    maxSize: COMMENT_SETTINGS_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => mutateRequestSecurity(c, 'rotate'));

  routes.post('/request-security/reset', bodyLimit({
    maxSize: COMMENT_SETTINGS_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => mutateRequestSecurity(c, 'reset'));

  return routes;
}

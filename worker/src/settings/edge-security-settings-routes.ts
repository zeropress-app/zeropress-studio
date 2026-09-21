import { auditSettings, beginAudit } from '../audit/service';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  edgeSecuritySettingsSuccessSchema,
  updateEdgeSecuritySettingsRequestSchema,
} from '../../../contracts/edge-security-settings';
import { readJsonBody } from '../auth/auth-route-utils';
import { requireStudioCapability } from '../auth/authorization';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import { StudioOperationalError } from '../lib/operational-error';
import type { Env, StudioHonoEnvironment } from '../types';
import { inspectEdgeDatabaseRuntimeState } from '../edge-database/runtime-state';
import {
  readEdgeSecuritySettings,
  updateEdgeSecuritySettings,
} from './edge-security-settings-repository';
import { requireEdgeIntegrationReady } from './edge-integration-gate';
import { readEdgeIntegrationModeFailClosed } from './edge-services-repository';

const EDGE_SECURITY_SETTINGS_BODY_LIMIT = 16 * 1024;

export type EdgeSecuritySettingsRouteDependencies = {
  resolveSession?: ResolveUserSession;
  readSettings?: typeof readEdgeSecuritySettings;
  updateSettings?: typeof updateEdgeSecuritySettings;
  readEdgeIntegrationMode?: typeof readEdgeIntegrationModeFailClosed;
  inspectEdgeDatabaseRuntime?: typeof inspectEdgeDatabaseRuntimeState;
  now?: () => Date;
};

function requireEdgeSecurityDatabase(env: Env): D1Database {
  if (!env.EDGE_DB) {
    throw new StudioOperationalError(
      'EDGE_SECURITY_DATABASE_NOT_CONFIGURED',
      {
        metadata: {
          component: 'worker_binding',
          resource: 'EDGE_DB',
          action: 'resolve_edge_security_database',
        },
      },
    );
  }
  return env.EDGE_DB;
}

export function createEdgeSecuritySettingsRoutes(
  dependencies: EdgeSecuritySettingsRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const readSettings = dependencies.readSettings ?? readEdgeSecuritySettings;
  const updateSettings = dependencies.updateSettings
    ?? updateEdgeSecuritySettings;
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

  routes.get('/', async (c) => {
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    const document = await readSettings({
      edgeDb: requireEdgeSecurityDatabase(c.env),
    });
    return c.json(edgeSecuritySettingsSuccessSchema.parse({
      success: true,
      data: document,
    }));
  });

  routes.put('/', bodyLimit({
    maxSize: EDGE_SECURITY_SETTINGS_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateEdgeSecuritySettingsRequestSchema.safeParse(
      body.value,
    );
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }

    beginAudit(c, { action: 'settings_update', target: { type: 'settings', id: 'edge-security' } });
    const result = await updateSettings({
      edgeDb: requireEdgeSecurityDatabase(c.env),
      settings: parsed.data.settings,
      expectedRevision: parsed.data.expected_revision,
      now: currentTime(),
    });
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    }
    auditSettings(c, 'edge-security', Object.keys(parsed.data.settings));
    return c.json(edgeSecuritySettingsSuccessSchema.parse({
      success: true,
      data: result.document,
    }));
  });

  return routes;
}

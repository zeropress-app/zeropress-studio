import { auditSettings, beginAudit } from '../audit/service';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  ROUTING_SETTINGS_BODY_LIMIT_BYTES,
  repairRoutingSettingsRequestSchema,
  routingPageOptionsQuerySchema,
  routingPageOptionsSuccessSchema,
  routingSettingsIncompleteResponseSchema,
  routingSettingsSuccessSchema,
  updateRoutingSettingsRequestSchema,
} from '../../../contracts/routing-settings';
import { requireStudioCapability } from '../auth/authorization';
import { readJsonBody } from '../auth/auth-route-utils';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import type { StudioHonoEnvironment } from '../types';
import {
  listRoutingPageOptions,
  readRoutingSettings,
  repairRoutingSettings,
  RoutingSettingsIncompleteError,
  updateRoutingSettings,
} from './routing-settings-repository';

export type RoutingSettingsRouteDependencies = {
  resolveSession?: ResolveUserSession;
  readSettings?: typeof readRoutingSettings;
  repairSettings?: typeof repairRoutingSettings;
  updateSettings?: typeof updateRoutingSettings;
  listPageOptions?: typeof listRoutingPageOptions;
  now?: () => Date;
  createRevision?: () => string;
};

export function createRoutingSettingsRoutes(
  dependencies: RoutingSettingsRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const readSettings = dependencies.readSettings ?? readRoutingSettings;
  const updateSettings = dependencies.updateSettings ?? updateRoutingSettings;
  const repairSettings = dependencies.repairSettings ?? repairRoutingSettings;
  const listPageOptions = dependencies.listPageOptions
    ?? listRoutingPageOptions;
  const currentTime = dependencies.now ?? (() => new Date());

  function requireSettingsManager(c: Context<StudioHonoEnvironment>) {
    return requireStudioCapability({
      context: c,
      capability: 'settings.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  routes.get('/', async (c) => {
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    let document;
    try {
      document = await readSettings({ db: c.env.DB });
    } catch (error) {
      if (error instanceof RoutingSettingsIncompleteError) {
        return c.json(routingSettingsIncompleteResponseSchema.parse({
          success: false,
          error: {
            code: 'SITE_ROUTING_SETTINGS_INCOMPLETE',
            recovery: error.recovery,
          },
        }), 409);
      }
      throw error;
    }
    return c.json(routingSettingsSuccessSchema.parse({
      success: true,
      data: document,
    }));
  });

  routes.get('/page-options', async (c) => {
    const query = routingPageOptionsQuerySchema.safeParse(c.req.query());
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    const items = await listPageOptions({
      db: c.env.DB,
      search: query.data.search,
      selectedPageId: query.data.selected_page_id,
    });
    return c.json(routingPageOptionsSuccessSchema.parse({
      success: true,
      data: { items },
    }));
  });

  routes.put('/', bodyLimit({
    maxSize: ROUTING_SETTINGS_BODY_LIMIT_BYTES,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateRoutingSettingsRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    beginAudit(c, { action: 'settings_update', target: { type: 'settings', id: 'routing' } });
    const result = await updateSettings({
      db: c.env.DB,
      settings: parsed.data.settings,
      expectedRevision: parsed.data.expected_revision,
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
    auditSettings(c, 'routing', Object.keys(parsed.data.settings));
    return c.json(routingSettingsSuccessSchema.parse({
      success: true,
      data: result.document,
    }));
  });

  routes.post('/repair', bodyLimit({
    maxSize: ROUTING_SETTINGS_BODY_LIMIT_BYTES,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = repairRoutingSettingsRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    beginAudit(c, { action: 'settings_update', target: { type: 'settings', id: 'routing' } });
    const result = await repairSettings({
      db: c.env.DB,
      expectedRevision: parsed.data.expected_revision,
      missingFields: parsed.data.missing_fields,
      updatedBy: session.user.id,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'recovery_conflict') {
      return errorResponse(c, 409, 'SETTINGS_RECOVERY_CONFLICT');
    }
    if (result.kind === 'front_page_not_found') {
      return errorResponse(c, 409, 'ROUTING_FRONT_PAGE_NOT_FOUND');
    }
    auditSettings(c, 'routing', parsed.data.missing_fields);
    return c.json(routingSettingsSuccessSchema.parse({
      success: true,
      data: result.document,
    }));
  });

  return routes;
}

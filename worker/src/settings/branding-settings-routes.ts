import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  siteBrandingSuccessSchema,
  updateSiteBrandingRequestSchema,
} from '../../../contracts/branding-settings';
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
  readSiteBranding,
  updateSiteBranding,
} from './branding-settings-repository';

const SITE_BRANDING_BODY_LIMIT = 16 * 1024;

export type SiteBrandingRouteDependencies = {
  resolveSession?: ResolveUserSession;
  readSettings?: typeof readSiteBranding;
  updateSettings?: typeof updateSiteBranding;
  now?: () => Date;
  createRevision?: () => string;
};

export function createSiteBrandingRoutes(
  dependencies: SiteBrandingRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const readSettings = dependencies.readSettings ?? readSiteBranding;
  const updateSettings = dependencies.updateSettings ?? updateSiteBranding;

  async function requireSettingsManager(
    c: Context<StudioHonoEnvironment>,
  ) {
    return requireStudioCapability({
      context: c,
      capability: 'settings.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  routes.get('/', async (c) => {
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    const document = await readSettings({ db: c.env.DB });
    return c.json(siteBrandingSuccessSchema.parse({
      success: true,
      data: document,
    }));
  });

  routes.put('/', bodyLimit({
    maxSize: SITE_BRANDING_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateSiteBrandingRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const result = await updateSettings({
      db: c.env.DB,
      settings: parsed.data.settings,
      expectedRevision: parsed.data.expected_revision,
      updatedBy: session.user.id,
      now: (dependencies.now ?? (() => new Date()))(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    }
    if (result.kind === 'media_not_found') {
      return errorResponse(c, 400, 'SITE_BRANDING_MEDIA_NOT_FOUND');
    }
    if (result.kind === 'media_type_not_allowed') {
      return errorResponse(c, 400, 'SITE_BRANDING_MEDIA_TYPE_NOT_ALLOWED');
    }
    return c.json(siteBrandingSuccessSchema.parse({
      success: true,
      data: result.document,
    }));
  });

  return routes;
}

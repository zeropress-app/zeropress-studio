import { auditSettings, beginAudit } from '../audit/service';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  generalSettingsIncompleteResponseSchema,
  generalSettingsSuccessSchema,
  repairGeneralSettingsRequestSchema,
  updateGeneralSettingsRequestSchema,
} from '../../../contracts/general-settings';
import {
  requireStudioCapability,
} from '../auth/authorization';
import { readJsonBody } from '../auth/auth-route-utils';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import type { StudioHonoEnvironment } from '../types';
import {
  GeneralSettingsIncompleteError,
  readGeneralSettings,
  repairGeneralSettings,
  updateGeneralSettings,
} from './general-settings-repository';

const GENERAL_SETTINGS_BODY_LIMIT = 32 * 1024;

type GeneralSettingsRouteDependencies = {
  resolveSession?: ResolveUserSession;
  readSettings?: typeof readGeneralSettings;
  repairSettings?: typeof repairGeneralSettings;
  updateSettings?: typeof updateGeneralSettings;
  now?: () => Date;
  createRevision?: () => string;
};

export function createGeneralSettingsRoutes(
  dependencies: GeneralSettingsRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const readSettings = dependencies.readSettings ?? readGeneralSettings;
  const updateSettings = dependencies.updateSettings ?? updateGeneralSettings;
  const repairSettings = dependencies.repairSettings ?? repairGeneralSettings;
  const currentTime = dependencies.now ?? (() => new Date());

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
    let document;
    try {
      document = await readSettings({ db: c.env.DB });
    } catch (error) {
      if (error instanceof GeneralSettingsIncompleteError) {
        return c.json(generalSettingsIncompleteResponseSchema.parse({
          success: false,
          error: {
            code: 'SITE_SETTINGS_INCOMPLETE',
            recovery: error.recovery,
          },
        }), 409);
      }
      throw error;
    }
    return c.json(generalSettingsSuccessSchema.parse({
      success: true,
      data: document,
    }));
  });

  routes.put('/', bodyLimit({
    maxSize: GENERAL_SETTINGS_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateGeneralSettingsRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    beginAudit(c, { action: 'settings_update', target: { type: 'settings', id: 'general' } });
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
    auditSettings(c, 'general', Object.keys(parsed.data.settings));
    return c.json(generalSettingsSuccessSchema.parse({
      success: true,
      data: result.document,
    }));
  });

  routes.post('/repair', bodyLimit({
    maxSize: GENERAL_SETTINGS_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = repairGeneralSettingsRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    beginAudit(c, { action: 'settings_update', target: { type: 'settings', id: 'general' } });
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
    auditSettings(c, 'general', parsed.data.missing_fields);
    return c.json(generalSettingsSuccessSchema.parse({
      success: true,
      data: result.document,
    }));
  });

  return routes;
}

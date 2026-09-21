import { auditSettings, beginAudit } from '../audit/service';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  outputSettingsSuccessSchema,
  updateOutputSettingsRequestSchema,
} from '../../../contracts/output-settings';
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
  readOutputSettings,
  updateOutputSettings,
} from './output-settings-repository';

const OUTPUT_SETTINGS_BODY_LIMIT = 32 * 1024;

type OutputSettingsRouteDependencies = {
  resolveSession?: ResolveUserSession;
  readSettings?: typeof readOutputSettings;
  updateSettings?: typeof updateOutputSettings;
  now?: () => Date;
  createRevision?: () => string;
};

export function createOutputSettingsRoutes(
  dependencies: OutputSettingsRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const readSettings = dependencies.readSettings ?? readOutputSettings;
  const updateSettings = dependencies.updateSettings ?? updateOutputSettings;
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
    const document = await readSettings({ db: c.env.DB });
    return c.json(outputSettingsSuccessSchema.parse({
      success: true,
      data: document,
    }));
  });

  routes.put('/', bodyLimit({
    maxSize: OUTPUT_SETTINGS_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateOutputSettingsRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    beginAudit(c, { action: 'settings_update', target: { type: 'settings', id: 'output' } });
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
    auditSettings(c, 'output', Object.keys(parsed.data.settings));
    return c.json(outputSettingsSuccessSchema.parse({
      success: true,
      data: result.document,
    }));
  });

  return routes;
}

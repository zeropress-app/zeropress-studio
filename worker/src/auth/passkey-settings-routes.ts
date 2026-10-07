import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { passkeySettingsSuccessSchema, updatePasskeySettingsRequestSchema } from '../../../contracts/passkey-settings';
import type { StudioHonoEnvironment } from '../types';
import { auditSettings } from '../audit/service';
import { errorResponse } from '../lib/http';
import { requireStudioCapability } from './authorization';
import { isConfiguredAuthSecret, openMfaManagementGrant } from './mfa-crypto';
import { hasValidCsrfHeader, isSameOriginMutation } from './session-http';
import type { ResolveUserSession } from './session-repository';
import { PASSKEY_SNAPSHOT } from './passkey-metadata';
import { readPasskeySettings, updatePasskeySettings } from './passkey-settings-repository';

export type PasskeySettingsDependencies = {
  resolveSession?: ResolveUserSession; readSettings?: typeof readPasskeySettings;
  updateSettings?: typeof updatePasskeySettings; now?: () => Date;
};
export function createPasskeySettingsRoutes(dependencies: PasskeySettingsDependencies = {}) {
  const routes = new Hono<StudioHonoEnvironment>();
  const now = dependencies.now ?? (() => new Date());
  routes.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  routes.get('/', async (c) => {
    const session = await requireStudioCapability({ context: c, capability: 'settings.manage', resolveSession: dependencies.resolveSession });
    if (session instanceof Response) return session;
    const document = await (dependencies.readSettings ?? readPasskeySettings)({ db: c.env.DB });
    return c.json(passkeySettingsSuccessSchema.parse({ success: true, data: { ...document, snapshot: PASSKEY_SNAPSHOT } }));
  });
  routes.put('/', bodyLimit({ maxSize: 16_384, onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE') }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    const session = await requireStudioCapability({ context: c, capability: 'settings.manage', resolveSession: dependencies.resolveSession });
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    const parsed = updatePasskeySettingsRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authSecret = c.env.STUDIO_AUTH_SECRET;
    if (!isConfiguredAuthSecret(authSecret)) return errorResponse(c, 503, 'SYSTEM_NOT_AVAILABLE');
    const grant = await openMfaManagementGrant({ authSecret, token: parsed.data.management_token, expectedOperation: 'change_passkey_policy', now: now() });
    if (!grant || grant.userId !== session.user.id || grant.sessionId !== session.session.id || grant.authRevision !== session.authRevision) {
      return errorResponse(c, 401, 'MFA_MANAGEMENT_CHALLENGE_INVALID');
    }
    const result = await (dependencies.updateSettings ?? updatePasskeySettings)({ db: c.env.DB, settings: parsed.data.settings,
      expectedRevision: parsed.data.expected_revision, updatedBy: session.user.id, now: now() });
    if (result.kind === 'revision_conflict') return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    auditSettings(c, 'passkeys', ['require_fido_certified_authenticator']);
    return c.json(passkeySettingsSuccessSchema.parse({ success: true, data: { ...result.document, snapshot: PASSKEY_SNAPSHOT } }));
  });
  return routes;
}

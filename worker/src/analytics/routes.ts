import { auditSettings, beginAudit } from '../audit/service';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  ANALYTICS_DEFAULT_PERIOD,
  analyticsSettingsResponseSchema,
  analyticsSummaryResponseSchema,
  analyticsConnectionResponseSchema,
  updateAnalyticsSettingsSchema,
  testAnalyticsConnectionSchema,
  analyticsPeriodSchema,
} from '../../../contracts/analytics';
import { requireStudioCapability } from '../auth/authorization';
import { readAuthSecret, readJsonBody } from '../auth/auth-route-utils';
import { hasValidCsrfHeader, isSameOriginMutation } from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import { logOperationalFailure } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import { readGeneralSettings } from '../settings/general-settings-repository';
import {
  readAnalyticsSettings,
  updateAnalyticsSettings,
  readAnalyticsCredential,
  readAnalyticsRuntimeSettings,
} from './settings-repository';
import { AnalyticsFailure, createAnalyticsProvider } from './provider';
import { queryAnalyticsSummary } from './service';

export type AnalyticsRouteDependencies = {
  resolveSession?: ResolveUserSession;
  readSettings?: typeof readAnalyticsSettings;
  updateSettings?: typeof updateAnalyticsSettings;
  readCredential?: typeof readAnalyticsCredential;
  readRuntimeSettings?: typeof readAnalyticsRuntimeSettings;
  readGeneralSettings?: typeof readGeneralSettings;
  fetch?: typeof fetch;
  now?: () => Date;
};

function authorize(
  c: Context<StudioHonoEnvironment>,
  dependencies: AnalyticsRouteDependencies,
) {
  return requireStudioCapability({
    context: c,
    capability: 'settings.manage',
    resolveSession: dependencies.resolveSession,
  });
}

function protectProviderErrors(routes: Hono<StudioHonoEnvironment>) {
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.onError((error, c) => {
    if (!(error instanceof AnalyticsFailure)) throw error;
    logOperationalFailure('ANALYTICS_PROVIDER_FAILED', {
      metadata: {
        resource: 'cloudflare_analytics',
        action: 'query_analytics',
        reason: error.code,
        method: c.req.method,
        pathname: new URL(c.req.url).pathname,
      },
    });
    return errorResponse(
      c,
      error.code === 'ANALYTICS_AUTHENTICATION_FAILED'
        ? 422
        : error.code === 'ANALYTICS_QUERY_LIMITED'
          ? 429
          : error.code === 'ANALYTICS_RESPONSE_INVALID'
            ? 502
            : 503,
      error.code,
    );
  });
}

export function createAnalyticsSettingsRoutes(
  dependencies: AnalyticsRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  protectProviderErrors(routes);
  routes.use(
    '*',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
    }),
  );
  routes.get('/', async (c) => {
    const session = await authorize(c, dependencies);
    if (session instanceof Response) return session;
    const document = await (dependencies.readSettings ?? readAnalyticsSettings)(
      { db: c.env.DB },
    );
    return c.json(
      analyticsSettingsResponseSchema.parse({ success: true, data: document }),
    );
  });
  routes.use('*', async (c, next) => {
    if (c.req.method === 'GET') return next();
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c))
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    return next();
  });
  routes.put('/', async (c) => {
    const session = await authorize(c, dependencies);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken))
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    const secret = readAuthSecret(c);
    if (secret instanceof Response) return secret;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateAnalyticsSettingsSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    beginAudit(c, { action: 'settings_update', target: { type: 'settings', id: 'analytics' } });
    const result = await (
      dependencies.updateSettings ?? updateAnalyticsSettings
    )({
      ...parsed.data,
      db: c.env.DB,
      authSecret: secret,
      updatedBy: session.user.id,
      now: (dependencies.now ?? (() => new Date()))(),
    });
    if (result.kind === 'revision_conflict')
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    if (result.kind === 'credential_missing')
      return errorResponse(c, 422, 'ANALYTICS_CREDENTIAL_NOT_CONFIGURED');
    auditSettings(c, 'analytics', Object.keys(parsed.data.settings), parsed.data.credential.action === 'replace' ? 'replaced' : parsed.data.credential.action === 'remove' ? 'removed' : 'retained');
    return c.json(
      analyticsSettingsResponseSchema.parse({
        success: true,
        data: result.document,
      }),
    );
  });
  routes.post('/test-connection', async (c) => {
    const session = await authorize(c, dependencies);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken))
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    const secret = readAuthSecret(c);
    if (secret instanceof Response) return secret;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = testAnalyticsConnectionSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const general = await (
      dependencies.readGeneralSettings ?? readGeneralSettings
    )({ db: c.env.DB });
    if (!general.settings.url)
      return errorResponse(c, 409, 'ANALYTICS_SITE_NOT_CONFIGURED');
    const token =
      parsed.data.credential ??
      (await (dependencies.readCredential ?? readAnalyticsCredential)({
        db: c.env.DB,
        authSecret: secret,
      }));
    if (!token)
      return errorResponse(c, 422, 'ANALYTICS_CREDENTIAL_NOT_CONFIGURED');
    const provider = createAnalyticsProvider(
      {
        accountId: parsed.data.account_id,
        siteTag: parsed.data.site_tag,
        hostname: new URL(general.settings.url).hostname,
        token,
      },
      {
        fetch: dependencies.fetch,
        now: (dependencies.now ?? (() => new Date()))(),
        signal: c.req.raw.signal,
      },
    );
    return c.json(
      analyticsConnectionResponseSchema.parse({
        success: true,
        data: await provider.testConnection(),
      }),
    );
  });
  return routes;
}

export function createAnalyticsRoutes(
  dependencies: AnalyticsRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  protectProviderErrors(routes);
  routes.get('/summary', async (c) => {
    const session = await authorize(c, dependencies);
    if (session instanceof Response) return session;
    const parsed = analyticsPeriodSchema.safeParse(
      c.req.query('period') ?? ANALYTICS_DEFAULT_PERIOD,
    );
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const secret = readAuthSecret(c);
    if (secret instanceof Response) return secret;
    const configuration = await (
      dependencies.readRuntimeSettings ?? readAnalyticsRuntimeSettings
    )({ db: c.env.DB, authSecret: secret });
    if (!configuration.document.configured || !configuration.token)
      return errorResponse(c, 409, 'ANALYTICS_NOT_CONFIGURED');
    const general = await (
      dependencies.readGeneralSettings ?? readGeneralSettings
    )({ db: c.env.DB });
    if (!general.settings.url)
      return errorResponse(c, 409, 'ANALYTICS_SITE_NOT_CONFIGURED');
    const summary = await queryAnalyticsSummary({
      document: configuration.document,
      siteRevision: general.revision,
      token: configuration.token,
      hostname: new URL(general.settings.url).hostname,
      timezone: general.settings.timezone,
      period: parsed.data,
      kv: c.env.KV,
      now: (dependencies.now ?? (() => new Date()))(),
      fetch: dependencies.fetch,
      signal: c.req.raw.signal,
    });
    return c.json(
      analyticsSummaryResponseSchema.parse({ success: true, data: summary }),
    );
  });
  return routes;
}

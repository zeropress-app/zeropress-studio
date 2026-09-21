import { auditSettings, beginAudit, recordAudit } from '../audit/service';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  publishingSettingsResponseSchema,
  publishingConnectionResponseSchema,
  publishingStatusResponseSchema,
  publishingResultResponseSchema,
  updatePublishingSettingsSchema,
  testPublishingConnectionSchema,
  publishRequestSchema,
  targetFromSettings,
} from '../../../contracts/publishing';
import type { StudioCapability } from '../../../contracts/authorization';
import { requireStudioCapability } from '../auth/authorization';
import { readAuthSecret, readJsonBody } from '../auth/auth-route-utils';
import { hasValidCsrfHeader, isSameOriginMutation } from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import { logOperationalFailure } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import { preparePreviewDataExport } from '../preview-data/prepare';
import {
  readPublishingSettings,
  readPublishingRuntimeSettings,
  updatePublishingSettings,
} from './settings-repository';
import { createGithubPublisher, PublishingFailure } from './provider';
import { publishSite } from './service';

export type PublishingRouteDependencies = {
  resolveSession?: ResolveUserSession;
  readSettings?: typeof readPublishingSettings;
  readRuntimeSettings?: typeof readPublishingRuntimeSettings;
  updateSettings?: typeof updatePublishingSettings;
  prepareExport?: typeof preparePreviewDataExport;
  fetch?: typeof fetch;
  now?: () => Date;
};
function authorize(
  c: Context<StudioHonoEnvironment>,
  dependencies: PublishingRouteDependencies,
  capability: StudioCapability,
) {
  return requireStudioCapability({
    context: c,
    capability,
    resolveSession: dependencies.resolveSession,
  });
}
function routesBase() {
  const routes = new Hono<StudioHonoEnvironment>();
  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.use(
    '*',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
    }),
  );
  routes.use('*', async (c, next) => {
    if (c.req.method !== 'GET') {
      c.header('Vary', 'Origin, Sec-Fetch-Site');
      if (!isSameOriginMutation(c))
        return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return next();
  });
  routes.onError((error, c) => {
    if (!(error instanceof PublishingFailure)) throw error;
    const code = error.code;
    const status =
      code === 'PUBLISHING_RATE_LIMITED'
        ? 429
        : code === 'PUBLISHING_PERMISSION_DENIED' ||
            code === 'PUBLISHING_BRANCH_RESTRICTED'
          ? 403
          : code === 'PUBLISHING_TARGET_NOT_FOUND'
            ? 404
            : code === 'PUBLISHING_CONFLICT' ||
                code === 'PUBLISHING_NOT_CONFIGURED'
              ? 409
              : code === 'PUBLISHING_RESPONSE_INVALID'
                ? 502
                : code === 'PUBLISHING_UNAVAILABLE' ||
                    code === 'PUBLISHING_RESULT_UNKNOWN'
                  ? 503
                  : 422;
    if (status >= 500)
      logOperationalFailure('PUBLISHING_PROVIDER_FAILED', {
        metadata: {
          resource: 'github',
          action:
            c.req.method === 'POST' && c.req.path === '/api/publishing'
              ? 'publish_site'
              : 'inspect_publish_target',
          reason: code,
          method: c.req.method,
          pathname: new URL(c.req.url).pathname,
        },
      });
    return errorResponse(c, status, code);
  });
  return routes;
}
export function createPublishingSettingsRoutes(
  dependencies: PublishingRouteDependencies = {},
) {
  const routes = routesBase();
  const readSettings = dependencies.readSettings ?? readPublishingSettings;
  const readRuntime =
    dependencies.readRuntimeSettings ?? readPublishingRuntimeSettings;
  routes.get('/', async (c) => {
    const session = await authorize(c, dependencies, 'settings.manage');
    if (session instanceof Response) return session;
    return c.json(
      publishingSettingsResponseSchema.parse({
        success: true,
        data: await readSettings({ db: c.env.DB }),
      }),
    );
  });
  routes.put('/', async (c) => {
    const session = await authorize(c, dependencies, 'settings.manage');
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken))
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    const secret = readAuthSecret(c);
    if (secret instanceof Response) return secret;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updatePublishingSettingsSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    let settings = parsed.data.settings;
    if (parsed.data.file_url) {
      const snapshot =
        parsed.data.credential.action === 'preserve'
          ? await readRuntime({ db: c.env.DB, authSecret: secret })
          : {
              document: await readSettings({ db: c.env.DB }),
              token:
                parsed.data.credential.action === 'replace'
                  ? parsed.data.credential.value
                  : null,
            };
      if (snapshot.document.revision !== parsed.data.expected_revision)
        return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
      if (!snapshot.token)
        throw new PublishingFailure('PUBLISHING_CREDENTIAL_NOT_CONFIGURED');
      const resolved = await createGithubPublisher(snapshot.token, {
        fetch: dependencies.fetch,
        signal: c.req.raw.signal,
      }).resolveUrl(parsed.data.file_url);
      settings = { enabled: settings.enabled, ...resolved.file.target };
    }
    beginAudit(c, { action: 'settings_update', target: { type: 'settings', id: 'publishing' } });
    const result = await (
      dependencies.updateSettings ?? updatePublishingSettings
    )({
      ...parsed.data,
      settings,
      db: c.env.DB,
      authSecret: secret,
      updatedBy: session.user.id,
      now: (dependencies.now ?? (() => new Date()))(),
    });
    if (result.kind === 'revision_conflict')
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    if (result.kind === 'credential_missing')
      throw new PublishingFailure('PUBLISHING_CREDENTIAL_NOT_CONFIGURED');
    auditSettings(c, 'publishing', Object.keys(parsed.data.settings), parsed.data.credential.action === 'replace' ? 'replaced' : parsed.data.credential.action === 'remove' ? 'removed' : 'retained');
    return c.json(
      publishingSettingsResponseSchema.parse({
        success: true,
        data: result.document,
      }),
    );
  });
  routes.post('/test-connection', async (c) => {
    const session = await authorize(c, dependencies, 'settings.manage');
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken))
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    const secret = readAuthSecret(c);
    if (secret instanceof Response) return secret;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = testPublishingConnectionSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const snapshot = parsed.data.credential
      ? {
          document: await readSettings({ db: c.env.DB }),
          token: parsed.data.credential,
        }
      : await readRuntime({ db: c.env.DB, authSecret: secret });
    if (snapshot.document.revision !== parsed.data.expected_revision)
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    if (!snapshot.token)
      throw new PublishingFailure('PUBLISHING_CREDENTIAL_NOT_CONFIGURED');
    const provider = createGithubPublisher(snapshot.token, {
      fetch: dependencies.fetch,
      signal: c.req.raw.signal,
    });
    const resolved = parsed.data.file_url
      ? await provider.resolveUrl(parsed.data.file_url)
      : await provider.inspect(
          parsed.data.target ?? targetFromSettings(snapshot.document.settings),
        );
    return c.json(
      publishingConnectionResponseSchema.parse({
        success: true,
        data: resolved.file,
      }),
    );
  });
  return routes;
}
export function createPublishingRoutes(
  dependencies: PublishingRouteDependencies = {},
) {
  const routes = routesBase();
  const readRuntime =
    dependencies.readRuntimeSettings ?? readPublishingRuntimeSettings;
  routes.get('/status', async (c) => {
    const session = await authorize(c, dependencies, 'publish.manage');
    if (session instanceof Response) return session;
    const secret = readAuthSecret(c);
    if (secret instanceof Response) return secret;
    const snapshot = await readRuntime({ db: c.env.DB, authSecret: secret });
    const file =
      snapshot.document.settings.enabled &&
      snapshot.document.configured &&
      snapshot.token
        ? (
            await createGithubPublisher(snapshot.token, {
              fetch: dependencies.fetch,
              signal: c.req.raw.signal,
            }).inspect(targetFromSettings(snapshot.document.settings))
          ).file
        : null;
    return c.json(
      publishingStatusResponseSchema.parse({
        success: true,
        data: {
          enabled: snapshot.document.settings.enabled,
          configured: snapshot.document.configured,
          revision: snapshot.document.revision,
          file,
        },
      }),
    );
  });
  routes.post('/', async (c) => {
    const session = await authorize(c, dependencies, 'publish.manage');
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken))
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    const secret = readAuthSecret(c);
    if (secret instanceof Response) return secret;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = publishRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const snapshot = await readRuntime({ db: c.env.DB, authSecret: secret });
    if (snapshot.document.revision !== parsed.data.expected_revision)
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    if (
      !snapshot.document.settings.enabled ||
      !snapshot.document.configured ||
      !snapshot.token
    )
      throw new PublishingFailure('PUBLISHING_NOT_CONFIGURED');
    beginAudit(c, { action: 'publishing_publish', target: { type: 'github_file', id: snapshot.document.settings.path,
      label: `${snapshot.document.settings.owner}/${snapshot.document.settings.repo}` } });
    const result = await publishSite({
      target: targetFromSettings(snapshot.document.settings),
      token: snapshot.token,
      fetch: dependencies.fetch,
      signal: c.req.raw.signal,
      generate: () =>
        (dependencies.prepareExport ?? preparePreviewDataExport)(c),
    });
    if (result instanceof Response) return result;
    recordAudit(c, { action: 'publishing_publish', outcome: result.outcome === 'unchanged' ? 'unchanged' : 'success',
      metadata: { commit_sha: result.file.commit.sha },
      target: { type: 'github_file', id: snapshot.document.settings.path, label: `${snapshot.document.settings.owner}/${snapshot.document.settings.repo}` } });
    return c.json(
      publishingResultResponseSchema.parse({ success: true, data: result }),
    );
  });
  return routes;
}

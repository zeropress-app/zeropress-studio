import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ApiErrorCode } from '../../../contracts/api';
import {
  mailSettingsSuccessSchema,
  sendTestMailRequestSchema,
  sendTestMailSuccessSchema,
  testMailConnectionRequestSchema,
  testMailConnectionSuccessSchema,
  updateMailSettingsRequestSchema,
} from '../../../contracts/mail-settings';
import { requireStudioCapability } from '../auth/authorization';
import { readAuthSecret, readJsonBody } from '../auth/auth-route-utils';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import { logStudioOperationalError } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import { requireNewsletterEdgeDatabase } from '../newsletters/edge-resources';
import { disableNewsletterRuntime } from '../newsletters/management-repository';
import {
  MailProviderFailure,
  sendMail,
  verifyMailProviderCredential,
} from './provider';
import {
  readMailRuntimeConfiguration,
  readMailSettings,
  readStoredMailCredential,
  updateMailSettings,
} from './settings-repository';

const MAIL_SETTINGS_BODY_LIMIT = 32 * 1024;

export type MailRouteDependencies = {
  resolveSession?: ResolveUserSession;
  readSettings?: typeof readMailSettings;
  updateSettings?: typeof updateMailSettings;
  readRuntimeConfiguration?: typeof readMailRuntimeConfiguration;
  readStoredCredential?: typeof readStoredMailCredential;
  verifyCredential?: typeof verifyMailProviderCredential;
  send?: typeof sendMail;
  disableNewsletterRuntime?: typeof disableNewsletterRuntime;
  now?: () => Date;
  createRevision?: () => string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function providerErrorCode(kind: MailProviderFailure['kind']): ApiErrorCode {
  if (kind === 'authentication_failed') {
    return 'MAIL_PROVIDER_AUTHENTICATION_FAILED';
  }
  if (kind === 'request_rejected') return 'MAIL_PROVIDER_REQUEST_REJECTED';
  if (kind === 'invalid_response') return 'MAIL_PROVIDER_RESPONSE_INVALID';
  return 'MAIL_PROVIDER_UNAVAILABLE';
}

function providerErrorStatus(
  kind: MailProviderFailure['kind'],
): 422 | 502 | 503 {
  if (kind === 'authentication_failed') return 422;
  if (kind === 'unavailable') return 503;
  return 502;
}

function handleProviderFailure(
  c: Context<StudioHonoEnvironment>,
  error: MailProviderFailure,
): Response {
  if (error.operationalError) {
    logStudioOperationalError(error.operationalError, {
      method: c.req.method,
      pathname: new URL(c.req.url).pathname,
    });
  }
  return errorResponse(c, providerErrorStatus(error.kind), providerErrorCode(error.kind));
}

export function createMailRoutes(dependencies: MailRouteDependencies = {}) {
  const routes = new Hono<StudioHonoEnvironment>();
  const readSettings = dependencies.readSettings ?? readMailSettings;
  const updateSettings = dependencies.updateSettings ?? updateMailSettings;
  const readRuntimeConfiguration = dependencies.readRuntimeConfiguration
    ?? readMailRuntimeConfiguration;
  const readStoredCredential = dependencies.readStoredCredential
    ?? readStoredMailCredential;
  const verifyCredential = dependencies.verifyCredential
    ?? verifyMailProviderCredential;
  const send = dependencies.send ?? sendMail;
  const disableNewsletter = dependencies.disableNewsletterRuntime
    ?? disableNewsletterRuntime;

  async function requireSettingsManager(c: Context<StudioHonoEnvironment>) {
    return requireStudioCapability({
      context: c,
      capability: 'settings.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  async function readProtectedJson(c: Context<StudioHonoEnvironment>) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return { response: errorResponse(c, 403, 'CSRF_VALIDATION_FAILED') };
    }
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return { response: session };
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return { response: errorResponse(c, 403, 'CSRF_VALIDATION_FAILED') };
    }
    const body = await readJsonBody(c);
    if (!body.valid) return { response: body.response };
    return { body: body.value, session };
  }

  routes.get('/', async (c) => {
    const session = await requireSettingsManager(c);
    if (session instanceof Response) return session;
    return c.json(mailSettingsSuccessSchema.parse({
      success: true,
      data: await readSettings({ db: c.env.DB }),
    }));
  });

  routes.put('/', bodyLimit({
    maxSize: MAIL_SETTINGS_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const request = await readProtectedJson(c);
    if ('response' in request) return request.response;
    const parsed = updateMailSettingsRequestSchema.safeParse(request.body);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    // Fail closed before removing the delivery configuration. EDGE_DB and DB
    // cannot share a transaction, so a later settings conflict may leave
    // confirmations disabled, but never accepted without a working consumer.
    if (parsed.data.settings.provider === 'disabled') {
      await disableNewsletter({
        edgeDb: requireNewsletterEdgeDatabase(c.env),
        now: dependencies.now?.() ?? new Date(),
      });
    }
    const result = await updateSettings({
      db: c.env.DB,
      settings: parsed.data.settings,
      credentialActions: parsed.data.credentials,
      expectedRevision: parsed.data.expected_revision,
      updatedBy: request.session.user.id,
      authSecret,
      now: dependencies.now?.() ?? new Date(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    }
    if (result.kind === 'credential_missing') {
      return errorResponse(c, 409, 'MAIL_CREDENTIAL_NOT_CONFIGURED');
    }
    return c.json(mailSettingsSuccessSchema.parse({
      success: true,
      data: result.document,
    }));
  });

  routes.post('/test-connection', bodyLimit({
    maxSize: MAIL_SETTINGS_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const request = await readProtectedJson(c);
    if ('response' in request) return request.response;
    const parsed = testMailConnectionRequestSchema.safeParse(request.body);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    const kind = parsed.data.provider === 'resend'
      ? 'resend_api_key' as const
      : 'cloudflare_api_token' as const;
    const credential = parsed.data.credential ?? await readStoredCredential({
      db: c.env.DB,
      authSecret,
      kind,
    });
    if (!credential) {
      return errorResponse(c, 409, 'MAIL_CREDENTIAL_NOT_CONFIGURED');
    }
    try {
      await verifyCredential({
        provider: parsed.data.provider,
        credential,
      });
    } catch (error) {
      if (error instanceof MailProviderFailure) {
        return handleProviderFailure(c, error);
      }
      throw error;
    }
    return c.json(testMailConnectionSuccessSchema.parse({
      success: true,
      data: {
        status: 'credential_verified',
        provider: parsed.data.provider,
      },
    }));
  });

  routes.post('/send-test', bodyLimit({
    maxSize: MAIL_SETTINGS_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const request = await readProtectedJson(c);
    if ('response' in request) return request.response;
    const parsed = sendTestMailRequestSchema.safeParse(request.body);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    const configuration = await readRuntimeConfiguration({
      db: c.env.DB,
      authSecret,
    });
    if (configuration.kind === 'not_configured') {
      return errorResponse(c, 409, 'MAIL_CREDENTIAL_NOT_CONFIGURED');
    }
    const now = dependencies.now?.() ?? new Date();
    const nowIso = now.toISOString();
    const subject = 'ZeroPress Studio test email';
    const text = `ZeroPress Studio accepted a test delivery request at ${nowIso}.`;
    const html = [
      '<!doctype html><html><body>',
      '<h1>ZeroPress Studio test email</h1>',
      `<p>${escapeHtml(text)}</p>`,
      '<p>If you received this message, the saved provider, sender, and delivery permission are working together.</p>',
      '</body></html>',
    ].join('');
    try {
      await send({
        provider: configuration.settings.provider,
        credential: configuration.credential,
        cloudflareAccountId:
          configuration.settings.cloudflare_account_id,
        fromEmail: configuration.settings.from_email,
        fromName: configuration.settings.from_name,
        to: parsed.data.recipient,
        subject,
        html,
        text,
        idempotencyKey: `studio-test-${crypto.randomUUID()}`,
      });
    } catch (error) {
      if (error instanceof MailProviderFailure) {
        return handleProviderFailure(c, error);
      }
      throw error;
    }
    return c.json(sendTestMailSuccessSchema.parse({
      success: true,
      data: {
        status: 'accepted',
        provider: configuration.settings.provider,
      },
    }));
  });

  return routes;
}

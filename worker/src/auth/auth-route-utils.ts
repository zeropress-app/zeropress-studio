import type { Context } from 'hono';
import type { ApiErrorCode } from '../../../contracts/api';
import {
  authenticatedSuccessSchema,
  type AuthenticatedSuccess,
} from '../../../contracts/auth';
import { errorResponse, getClientIp } from '../lib/http';
import { StudioOperationalError } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import { isConfiguredAuthSecret } from './mfa-crypto';
import { setSessionCookie } from './session-http';
import type { IssueUserSession } from './session-repository';
import { readSessionNetworkMetadata } from './session-network-metadata';
import type { AuthRateLimitResult } from './login-rate-limit';

export function setAuthRateLimitHeaders(
  c: Context<StudioHonoEnvironment>,
  result: AuthRateLimitResult,
): void {
  c.header('X-RateLimit-Limit', String(result.limit));
  c.header('X-RateLimit-Remaining', String(result.remaining));
  c.header('X-RateLimit-Reset', String(result.resetAt));
  if (!result.allowed) c.header('Retry-After', String(result.retryAfter));
}

export async function finishAuthentication(input: {
  c: Context<StudioHonoEnvironment>;
  issueSession: IssueUserSession;
  userId: string;
  authRevision: string;
  accountChangedErrorCode?: ApiErrorCode;
}): Promise<Response> {
  const issued = await input.issueSession({
    db: input.c.env.DB,
    userId: input.userId,
    authRevision: input.authRevision,
    ipAddress: getClientIp(input.c),
    userAgent: input.c.req.header('User-Agent'),
    networkMetadata: input.c.get('sessionNetworkMetadata')
      ?? readSessionNetworkMetadata(input.c.req.raw),
  });
  if (issued.kind === 'account_changed') {
    return errorResponse(
      input.c,
      401,
      input.accountChangedErrorCode ?? 'MFA_CHALLENGE_INVALID',
    );
  }

  setSessionCookie(input.c, issued.value.cookieValue);
  const response: AuthenticatedSuccess = {
    success: true,
    data: {
      status: 'authenticated',
    },
  };
  return input.c.json(authenticatedSuccessSchema.parse(response));
}

export async function applyNativeAuthRateLimit(
  c: Context<StudioHonoEnvironment>,
  action:
    | 'limit_login_route'
    | 'limit_mfa_route'
    | 'limit_passkey_sign_in_route',
): Promise<Response | null> {
  let rateLimit: { success: boolean };
  try {
    rateLimit = await c.env.AUTH_ROUTE_RATE_LIMITER.limit({
      key: getClientIp(c),
    });
  } catch (error) {
    throw new StudioOperationalError(
      'AUTH_ROUTE_RATE_LIMITER_NOT_AVAILABLE',
      {
        cause: error,
        metadata: {
          resource: 'AUTH_ROUTE_RATE_LIMITER',
          action,
        },
      },
    );
  }
  if (!rateLimit.success) {
    c.header('Retry-After', '60');
    return errorResponse(c, 429, 'RATE_LIMIT_EXCEEDED');
  }
  return null;
}

export async function readJsonBody(
  c: Context<StudioHonoEnvironment>,
): Promise<
  | { valid: true; value: unknown }
  | { valid: false; response: Response }
> {
  const contentType = c.req
    .header('Content-Type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    return {
      valid: false,
      response: errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE'),
    };
  }
  try {
    return { valid: true, value: await c.req.json() };
  } catch {
    return {
      valid: false,
      response: errorResponse(c, 400, 'INVALID_JSON'),
    };
  }
}

export function readAuthSecret(
  c: Context<StudioHonoEnvironment>,
): string | Response {
  if (!isConfiguredAuthSecret(c.env.STUDIO_AUTH_SECRET)) {
    return errorResponse(c, 503, 'SYSTEM_CONFIGURATION_ERROR');
  }
  return c.env.STUDIO_AUTH_SECRET;
}

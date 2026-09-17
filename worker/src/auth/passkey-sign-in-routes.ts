import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  passkeySignInOptionsRequestSchema,
  passkeySignInOptionsSuccessSchema,
  passkeySignInVerifyRequestSchema,
  type WebAuthnAuthenticationResponse,
  WEBAUTHN_CHALLENGE_TTL_SECONDS,
} from '../../../contracts/webauthn';
import { errorResponse, requireClientIp } from '../lib/http';
import { StudioOperationalError } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  applyNativeAuthRateLimit,
  finishAuthentication,
  readJsonBody,
  readAuthSecret,
  setAuthRateLimitHeaders,
} from './auth-route-utils';
import {
  consumePasskeySignInRateLimit,
} from './login-rate-limit';
import { getMfaManagementStatus } from './mfa-management-repository';
import type { IssueUserSession } from './session-repository';
import { resolveWebAuthnRequestContext } from './webauthn-origin';
import {
  completePasswordlessWebAuthnAuthentication,
  createWebAuthnDiscoveryChallenge,
  getStoredPasswordlessWebAuthnCredential,
  getWebAuthnDiscoveryChallenge,
} from './webauthn-repository';
import { matchesWebAuthnUserHandle } from './webauthn-user-handle';

const PASSKEY_BODY_LIMIT = 256 * 1024;
const WEBAUTHN_TIMEOUT_MS = WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000;

type PasskeySignInDependencies = {
  issueSession: IssueUserSession;
  generateOptions?: typeof generateAuthenticationOptions;
  verifyAuthentication?: typeof verifyAuthenticationResponse;
  consumeRateLimit?: typeof consumePasskeySignInRateLimit;
  createChallenge?: typeof createWebAuthnDiscoveryChallenge;
  getChallenge?: typeof getWebAuthnDiscoveryChallenge;
  getCredential?: typeof getStoredPasswordlessWebAuthnCredential;
  completeAuthentication?: typeof completePasswordlessWebAuthnAuthentication;
  getMfaStatus?: typeof getMfaManagementStatus;
  now?: () => Date;
};

function requestContextOrError(
  requestUrl: string,
): NonNullable<ReturnType<typeof resolveWebAuthnRequestContext>> {
  const context = resolveWebAuthnRequestContext(requestUrl);
  if (!context) {
    throw new StudioOperationalError(
      'AUTH_WEBAUTHN_CONFIGURATION_INVALID',
      {
        metadata: {
          component: 'webauthn',
          action: 'resolve_passkey_sign_in_request_context',
        },
      },
    );
  }
  return context;
}

function passkeySignInFailed(c: Context<StudioHonoEnvironment>) {
  return errorResponse(c, 401, 'PASSKEY_SIGN_IN_FAILED');
}

export function createPasskeySignInRoutes(
  dependencies: PasskeySignInDependencies,
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const currentTime = dependencies.now ?? (() => new Date());
  const generateOptions = dependencies.generateOptions
    ?? generateAuthenticationOptions;
  const verifyAuthentication = dependencies.verifyAuthentication
    ?? verifyAuthenticationResponse;
  const consumeRateLimit = dependencies.consumeRateLimit
    ?? consumePasskeySignInRateLimit;
  const createChallenge = dependencies.createChallenge
    ?? createWebAuthnDiscoveryChallenge;
  const readChallenge = dependencies.getChallenge
    ?? getWebAuthnDiscoveryChallenge;
  const getCredential = dependencies.getCredential
    ?? getStoredPasswordlessWebAuthnCredential;
  const completeAuthentication = dependencies.completeAuthentication
    ?? completePasswordlessWebAuthnAuthentication;
  const getMfaStatus = dependencies.getMfaStatus
    ?? getMfaManagementStatus;

  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  routes.post('/options', bodyLimit({
    maxSize: PASSKEY_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const nativeLimit = await applyNativeAuthRateLimit(
      c,
      'limit_passkey_sign_in_route',
    );
    if (nativeLimit) return nativeLimit;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = passkeySignInOptionsRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }

    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    const rateLimit = await consumeRateLimit({
      db: c.env.DB,
      authSecret,
      ip: requireClientIp(c),
      now: currentTime(),
    });
    setAuthRateLimitHeaders(c, rateLimit);
    if (!rateLimit.allowed) {
      return errorResponse(c, 429, 'RATE_LIMIT_EXCEEDED');
    }

    const requestContext = requestContextOrError(c.req.url);
    let options;
    try {
      options = await generateOptions({
        rpID: requestContext.rpId,
        allowCredentials: [],
        timeout: WEBAUTHN_TIMEOUT_MS,
        userVerification: 'required',
      });
    } catch (error) {
      throw new StudioOperationalError('AUTH_MFA_CRYPTO_NOT_AVAILABLE', {
        cause: error,
        metadata: {
          component: 'webauthn',
          action: 'generate_passkey_sign_in_options',
        },
      });
    }
    const challenge = await createChallenge({
      db: c.env.DB,
      challenge: options.challenge,
      origin: requestContext.origin,
      rpId: requestContext.rpId,
      now: currentTime(),
      ttlSeconds: WEBAUTHN_CHALLENGE_TTL_SECONDS,
    });
    return c.json(passkeySignInOptionsSuccessSchema.parse({
      success: true,
      data: {
        options,
        challenge_token: challenge.token,
        expires_at_iso: challenge.expiresAtIso,
      },
    }));
  });

  routes.post('/verify', bodyLimit({
    maxSize: PASSKEY_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const nativeLimit = await applyNativeAuthRateLimit(
      c,
      'limit_passkey_sign_in_route',
    );
    if (nativeLimit) return nativeLimit;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = passkeySignInVerifyRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }

    const now = currentTime();
    const challenge = await readChallenge({
      db: c.env.DB,
      token: parsed.data.challenge_token,
      now,
    });
    if (!challenge) return passkeySignInFailed(c);
    const requestContext = requestContextOrError(c.req.url);
    if (
      challenge.origin !== requestContext.origin
      || challenge.rpId !== requestContext.rpId
    ) {
      return passkeySignInFailed(c);
    }

    const credential = await getCredential({
      db: c.env.DB,
      rpId: requestContext.rpId,
      credentialId: parsed.data.response.id,
    });
    const userHandle = parsed.data.response.response.userHandle;
    if (
      !credential
      || typeof userHandle !== 'string'
      || !matchesWebAuthnUserHandle(credential.userId, userHandle)
    ) {
      return passkeySignInFailed(c);
    }

    let verification;
    try {
      verification = await verifyAuthentication({
        response: parsed.data.response as WebAuthnAuthenticationResponse,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpId,
        credential: credential.credential,
        requireUserVerification: true,
        advancedFIDOConfig: {
          userVerification: 'required',
        },
      });
    } catch {
      // Invalid public assertions are expected. Logging them would allow an
      // unauthenticated caller to amplify operational logs.
      return passkeySignInFailed(c);
    }
    if (
      !verification.verified
      || !verification.authenticationInfo.userVerified
    ) {
      return passkeySignInFailed(c);
    }

    const completed = await completeAuthentication({
      db: c.env.DB,
      challenge,
      credential,
      newCounter: verification.authenticationInfo.newCounter,
      credentialDeviceType:
        verification.authenticationInfo.credentialDeviceType,
      credentialBackedUp:
        verification.authenticationInfo.credentialBackedUp,
      now,
    });
    if (!completed) return passkeySignInFailed(c);

    const status = await getMfaStatus({
      db: c.env.DB,
      userId: credential.userId,
      authRevision: credential.authRevision,
    });
    if (!status) return passkeySignInFailed(c);
    return finishAuthentication({
      c,
      issueSession: dependencies.issueSession,
      userId: credential.userId,
      authRevision: credential.authRevision,
      accountChangedErrorCode: 'PASSKEY_SIGN_IN_FAILED',
    });
  });

  return routes;
}

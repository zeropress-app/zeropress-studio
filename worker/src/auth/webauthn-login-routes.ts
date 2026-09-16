import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  WEBAUTHN_CHALLENGE_TTL_SECONDS,
  webAuthnLoginOptionsRequestSchema,
  webAuthnLoginOptionsSuccessSchema,
  webAuthnLoginVerifyRequestSchema,
  type WebAuthnAuthenticationResponse,
} from '../../../contracts/webauthn';
import { errorResponse } from '../lib/http';
import { StudioOperationalError } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  openMfaContinuation,
} from './mfa-crypto';
import { getMfaManagementStatus } from './mfa-management-repository';
import {
  applyNativeAuthRateLimit,
  finishAuthentication,
  readAuthSecret,
  readJsonBody,
} from './auth-route-utils';
import type { IssueUserSession } from './session-repository';
import { resolveWebAuthnRequestContext } from './webauthn-origin';
import {
  completeWebAuthnAuthentication,
  createWebAuthnChallenge,
  getStoredWebAuthnCredential,
  getWebAuthnChallenge,
  listWebAuthnAuthenticationCredentials,
} from './webauthn-repository';

const WEBAUTHN_BODY_LIMIT = 256 * 1024;
const WEBAUTHN_TIMEOUT_MS = WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000;

type WebAuthnLoginDependencies = {
  issueSession: IssueUserSession;
  generateOptions?: typeof generateAuthenticationOptions;
  verifyAuthentication?: typeof verifyAuthenticationResponse;
  listCredentials?: typeof listWebAuthnAuthenticationCredentials;
  createChallenge?: typeof createWebAuthnChallenge;
  getChallenge?: typeof getWebAuthnChallenge;
  getCredential?: typeof getStoredWebAuthnCredential;
  completeAuthentication?: typeof completeWebAuthnAuthentication;
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
          action: 'resolve_request_context',
        },
      },
    );
  }
  return context;
}

export function createWebAuthnLoginRoutes(
  dependencies: WebAuthnLoginDependencies,
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const currentTime = dependencies.now ?? (() => new Date());
  const generateOptions = dependencies.generateOptions
    ?? generateAuthenticationOptions;
  const verifyAuthentication = dependencies.verifyAuthentication
    ?? verifyAuthenticationResponse;
  const listCredentials = dependencies.listCredentials
    ?? listWebAuthnAuthenticationCredentials;
  const createChallenge = dependencies.createChallenge
    ?? createWebAuthnChallenge;
  const readChallenge = dependencies.getChallenge
    ?? getWebAuthnChallenge;
  const getCredential = dependencies.getCredential
    ?? getStoredWebAuthnCredential;
  const completeAuthentication = dependencies.completeAuthentication
    ?? completeWebAuthnAuthentication;
  const getMfaStatus = dependencies.getMfaStatus
    ?? getMfaManagementStatus;

  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  routes.post('/options', bodyLimit({
    maxSize: WEBAUTHN_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const rateLimitResponse = await applyNativeAuthRateLimit(
      c,
      'limit_mfa_route',
    );
    if (rateLimitResponse) return rateLimitResponse;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = webAuthnLoginOptionsRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    const now = currentTime();
    const continuation = await openMfaContinuation({
      authSecret,
      token: parsed.data.continuation_token,
      expectedPurpose: 'verify',
      now,
    });
    if (!continuation) {
      return errorResponse(c, 401, 'MFA_CHALLENGE_INVALID');
    }

    const requestContext = requestContextOrError(c.req.url);
    const credentials = await listCredentials({
      db: c.env.DB,
      userId: continuation.userId,
      authRevision: continuation.authRevision,
      rpId: requestContext.rpId,
    });
    if (credentials.length === 0) {
      return errorResponse(c, 409, 'WEBAUTHN_NOT_CONFIGURED');
    }

    let options;
    try {
      options = await generateOptions({
        rpID: requestContext.rpId,
        allowCredentials: credentials,
        timeout: WEBAUTHN_TIMEOUT_MS,
        userVerification: 'discouraged',
      });
    } catch (error) {
      throw new StudioOperationalError('AUTH_MFA_CRYPTO_NOT_AVAILABLE', {
        cause: error,
        metadata: {
          component: 'webauthn',
          action: 'generate_login_authentication_options',
        },
      });
    }
    const challenge = await createChallenge({
      db: c.env.DB,
      userId: continuation.userId,
      authRevision: continuation.authRevision,
      purpose: 'login',
      challenge: options.challenge,
      origin: requestContext.origin,
      rpId: requestContext.rpId,
      now,
      ttlSeconds: WEBAUTHN_CHALLENGE_TTL_SECONDS,
    });
    return c.json(webAuthnLoginOptionsSuccessSchema.parse({
      success: true,
      data: {
        options,
        challenge_token: challenge.token,
        expires_at_iso: challenge.expiresAtIso,
      },
    }));
  });

  routes.post('/verify', bodyLimit({
    maxSize: WEBAUTHN_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const rateLimitResponse = await applyNativeAuthRateLimit(
      c,
      'limit_mfa_route',
    );
    if (rateLimitResponse) return rateLimitResponse;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = webAuthnLoginVerifyRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    const now = currentTime();
    const continuation = await openMfaContinuation({
      authSecret,
      token: parsed.data.continuation_token,
      expectedPurpose: 'verify',
      now,
    });
    if (!continuation) {
      return errorResponse(c, 401, 'MFA_CHALLENGE_INVALID');
    }
    const challenge = await readChallenge({
      db: c.env.DB,
      token: parsed.data.challenge_token,
      userId: continuation.userId,
      authRevision: continuation.authRevision,
      purpose: 'login',
      now,
    });
    if (!challenge) {
      return errorResponse(c, 401, 'WEBAUTHN_CHALLENGE_INVALID');
    }
    const requestContext = requestContextOrError(c.req.url);
    if (
      challenge.origin !== requestContext.origin
      || challenge.rpId !== requestContext.rpId
    ) {
      return errorResponse(c, 401, 'WEBAUTHN_CHALLENGE_INVALID');
    }
    const credential = await getCredential({
      db: c.env.DB,
      userId: continuation.userId,
      authRevision: continuation.authRevision,
      rpId: requestContext.rpId,
      credentialId: parsed.data.response.id,
    });
    if (!credential) {
      return errorResponse(c, 401, 'WEBAUTHN_VERIFICATION_FAILED');
    }

    let verification;
    try {
      verification = await verifyAuthentication({
        response: parsed.data.response as WebAuthnAuthenticationResponse,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpId,
        credential: credential.credential,
        // The password-bound continuation is the first factor. Use the
        // WebAuthn-spec verification path so UP remains mandatory while UV is
        // optional; advancedFIDOConfig with `discouraged` would also make UP
        // optional in the currently supported SimpleWebAuthn release.
        requireUserVerification: false,
      });
    } catch {
      // Invalid assertions are expected authentication failures. Logging them
      // would allow untrusted requests to amplify operational logs.
      return errorResponse(c, 401, 'WEBAUTHN_VERIFICATION_FAILED');
    }
    if (!verification.verified) {
      return errorResponse(c, 401, 'WEBAUTHN_VERIFICATION_FAILED');
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
    if (!completed) {
      return errorResponse(c, 401, 'WEBAUTHN_CHALLENGE_INVALID');
    }
    const status = await getMfaStatus({
      db: c.env.DB,
      userId: continuation.userId,
      authRevision: continuation.authRevision,
    });
    if (!status) {
      return errorResponse(c, 401, 'MFA_CHALLENGE_INVALID');
    }
    return finishAuthentication({
      c,
      issueSession: dependencies.issueSession,
      userId: continuation.userId,
      authRevision: continuation.authRevision,
    });
  });

  return routes;
}

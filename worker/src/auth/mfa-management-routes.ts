import { recordAudit, userAuditActor } from '../audit/service';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { MfaEnrollmentSetupSuccess } from '../../../contracts/mfa';
import {
  changePasswordRequestSchema,
  changePasswordSuccessSchema,
} from '../../../contracts/password-management';
import {
  authorizeMfaManagementRequestSchema,
  authorizeMfaManagementSuccessSchema,
  MFA_MANAGEMENT_FRESHNESS_SECONDS,
  mfaManagementStatusSuccessSchema,
  mfaManagementTotpCompleteRequestSchema,
  mfaManagementTotpCompleteSuccessSchema,
  mfaManagementTotpSetupRequestSchema,
  mfaManagementWebAuthnRegistrationCompleteRequestSchema,
  mfaManagementWebAuthnRegistrationCompleteSuccessSchema,
  mfaManagementWebAuthnRegistrationOptionsRequestSchema,
  mfaManagementWebAuthnRegistrationOptionsSuccessSchema,
  mfaManagementWebAuthnRemoveRequestSchema,
  mfaManagementWebAuthnRemoveSuccessSchema,
  mfaManagementWebAuthnRenameRequestSchema,
  mfaManagementWebAuthnRenameSuccessSchema,
  mfaManagementWebAuthnStepUpOptionsRequestSchema,
  mfaManagementWebAuthnStepUpOptionsSuccessSchema,
  mfaManagementWebAuthnStepUpVerifyRequestSchema,
  type MfaManagementOperation,
} from '../../../contracts/mfa-management';
import {
  WEBAUTHN_CHALLENGE_TTL_SECONDS,
  webAuthnTransportSchema,
  type WebAuthnAuthenticationResponse,
  type WebAuthnRegistrationResponse,
} from '../../../contracts/webauthn';
import { errorResponse, requireClientIp } from '../lib/http';
import { StudioOperationalError } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  capabilityForMfaManagementOperation,
  hasStudioCapability,
} from './authorization';
import {
  createMfaEnrollment,
  createMfaManagementGrant,
  encryptTotpSecret,
  isConfiguredAuthSecret,
  openMfaEnrollment,
  openMfaManagementGrant,
  verifyMfaEnrollmentProof,
} from './mfa-crypto';
import { resolveMfaIssuer } from './mfa-issuer';
import {
  getMfaManagementStatus,
  replaceManagedTotp,
  verifyMfaManagementPassword,
} from './mfa-management-repository';
import { verifyUserTotp } from './mfa-repository';
import { setAuthRateLimitHeaders } from './auth-route-utils';
import { hashPassword } from './password';
import { changeUserPassword } from './password-management-repository';
import {
  clearSessionCookie,
  hasValidCsrfHeader,
  isSameOriginMutation,
  readSessionCookie,
} from './session-http';
import type {
  ResolvedSession,
  ResolveUserSession,
} from './session-repository';
import { resolveWebAuthnRequestContext } from './webauthn-origin';
import {
  completeWebAuthnAuthentication,
  createWebAuthnChallenge,
  getStoredWebAuthnCredential,
  getWebAuthnChallenge,
  listUserWebAuthnCredentials,
  listWebAuthnAuthenticationCredentials,
  registerWebAuthnCredential,
  removeWebAuthnCredential,
  renameWebAuthnCredential,
} from './webauthn-repository';
import { createUserSecurityRevision } from '../users/setup-token-crypto';
import { opaqueWebAuthnUserIdBytes } from './webauthn-user-handle';
import { assessPasswordAcceptance } from './password-breach-service';

const MANAGEMENT_BODY_LIMIT = 256 * 1024;
const WEBAUTHN_TIMEOUT_MS = WEBAUTHN_CHALLENGE_TTL_SECONDS * 1000;

type MfaManagementDependencies = {
  resolveSession: ResolveUserSession;
  getStatus?: typeof getMfaManagementStatus;
  verifyPassword?: typeof verifyMfaManagementPassword;
  replaceTotp?: typeof replaceManagedTotp;
  listWebAuthnCredentials?: typeof listUserWebAuthnCredentials;
  listWebAuthnAuthenticationCredentials?:
    typeof listWebAuthnAuthenticationCredentials;
  generateWebAuthnAuthenticationOptions?:
    typeof generateAuthenticationOptions;
  generateWebAuthnRegistrationOptions?: typeof generateRegistrationOptions;
  verifyWebAuthnAuthentication?: typeof verifyAuthenticationResponse;
  verifyWebAuthnRegistration?: typeof verifyRegistrationResponse;
  createWebAuthnChallenge?: typeof createWebAuthnChallenge;
  getWebAuthnChallenge?: typeof getWebAuthnChallenge;
  getStoredWebAuthnCredential?: typeof getStoredWebAuthnCredential;
  completeWebAuthnAuthentication?: typeof completeWebAuthnAuthentication;
  registerWebAuthnCredential?: typeof registerWebAuthnCredential;
  renameWebAuthnCredential?: typeof renameWebAuthnCredential;
  removeWebAuthnCredential?: typeof removeWebAuthnCredential;
  changePassword?: typeof changeUserPassword;
  hashPassword?: typeof hashPassword;
  createSecurityRevision?: () => string;
  now?: () => Date;
};

function readAuthSecret(
  c: Context<StudioHonoEnvironment>,
): string | Response {
  if (!isConfiguredAuthSecret(c.env.STUDIO_AUTH_SECRET)) {
    return errorResponse(c, 503, 'SYSTEM_CONFIGURATION_ERROR');
  }
  return c.env.STUDIO_AUTH_SECRET;
}

async function readJsonBody(
  c: Context<StudioHonoEnvironment>,
): Promise<
  | { valid: true; value: unknown }
  | { valid: false; response: Response }
> {
  const contentType = c.req.header('Content-Type')
    ?.split(';')[0]?.trim().toLowerCase();
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

async function applyNativeMfaRateLimit(
  c: Context<StudioHonoEnvironment>,
): Promise<Response | null> {
  const clientIp = requireClientIp(c);
  let rateLimit: { success: boolean };
  try {
    rateLimit = await c.env.AUTH_ROUTE_RATE_LIMITER.limit({
      key: clientIp,
    });
  } catch (error) {
    throw new StudioOperationalError(
      'AUTH_ROUTE_RATE_LIMITER_NOT_AVAILABLE',
      {
        cause: error,
        metadata: {
          resource: 'AUTH_ROUTE_RATE_LIMITER',
          action: 'limit_mfa_route',
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

async function resolveRequiredSession(
  c: Context<StudioHonoEnvironment>,
  resolveSession: ResolveUserSession,
): Promise<ResolvedSession | Response> {
  const session = await resolveSession({
    db: c.env.DB,
    cookieValue: readSessionCookie(c),
  });
  if (!session) {
    clearSessionCookie(c);
    return errorResponse(c, 401, 'AUTHENTICATION_REQUIRED');
  }
  return session;
}

function isFreshMfaVerification(value: string, now: Date): boolean {
  const verifiedAt = Date.parse(value);
  const age = now.getTime() - verifiedAt;
  return Number.isFinite(verifiedAt)
    && age >= 0
    && age <= MFA_MANAGEMENT_FRESHNESS_SECONDS * 1000;
}

function matchesCurrentSession(
  grant: Awaited<ReturnType<typeof openMfaManagementGrant>>,
  session: ResolvedSession,
): boolean {
  return grant !== null
    && grant.userId === session.user.id
    && grant.sessionId === session.session.id
    && grant.authRevision === session.authRevision;
}

function authorizeManagementOperation(
  c: Context<StudioHonoEnvironment>,
  session: ResolvedSession,
  operation: MfaManagementOperation,
): Response | null {
  const capability = capabilityForMfaManagementOperation(operation);
  return capability && !hasStudioCapability(session.user.roles, capability)
    ? errorResponse(c, 403, 'FORBIDDEN')
    : null;
}

function cryptoFailure(
  error: unknown,
  action: string,
): StudioOperationalError {
  return new StudioOperationalError('AUTH_MFA_CRYPTO_NOT_AVAILABLE', {
    cause: error,
    metadata: {
      component: 'web_crypto',
      action,
    },
  });
}

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
          action: 'resolve_management_request_context',
        },
      },
    );
  }
  return context;
}

export function createMfaManagementRoutes(
  dependencies: MfaManagementDependencies,
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const getStatus = dependencies.getStatus ?? getMfaManagementStatus;
  const verifyPassword = dependencies.verifyPassword
    ?? verifyMfaManagementPassword;
  const replaceTotp = dependencies.replaceTotp ?? replaceManagedTotp;
  const listCredentials = dependencies.listWebAuthnCredentials
    ?? listUserWebAuthnCredentials;
  const listAuthenticationCredentials =
    dependencies.listWebAuthnAuthenticationCredentials
      ?? listWebAuthnAuthenticationCredentials;
  const generateAuthentication =
    dependencies.generateWebAuthnAuthenticationOptions
      ?? generateAuthenticationOptions;
  const generateRegistration =
    dependencies.generateWebAuthnRegistrationOptions
      ?? generateRegistrationOptions;
  const verifyAuthentication =
    dependencies.verifyWebAuthnAuthentication
      ?? verifyAuthenticationResponse;
  const verifyRegistration = dependencies.verifyWebAuthnRegistration
    ?? verifyRegistrationResponse;
  const createChallenge = dependencies.createWebAuthnChallenge
    ?? createWebAuthnChallenge;
  const readChallenge = dependencies.getWebAuthnChallenge
    ?? getWebAuthnChallenge;
  const getStoredCredential = dependencies.getStoredWebAuthnCredential
    ?? getStoredWebAuthnCredential;
  const completeAuthentication =
    dependencies.completeWebAuthnAuthentication
      ?? completeWebAuthnAuthentication;
  const registerCredential = dependencies.registerWebAuthnCredential
    ?? registerWebAuthnCredential;
  const renameCredential = dependencies.renameWebAuthnCredential
    ?? renameWebAuthnCredential;
  const removeCredential = dependencies.removeWebAuthnCredential
    ?? removeWebAuthnCredential;
  const changePassword = dependencies.changePassword ?? changeUserPassword;
  const hashNewPassword = dependencies.hashPassword ?? hashPassword;
  const createSecurityRevision = dependencies.createSecurityRevision
    ?? createUserSecurityRevision;
  const currentTime = dependencies.now ?? (() => new Date());

  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  routes.get('/status', async (c) => {
    const session = await resolveRequiredSession(
      c,
      dependencies.resolveSession,
    );
    if (session instanceof Response) return session;
    const status = await getStatus({
      db: c.env.DB,
      userId: session.user.id,
      authRevision: session.authRevision,
    });
    if (!status) {
      return errorResponse(c, 409, 'MFA_NOT_CONFIGURED');
    }
    const requestContext = requestContextOrError(c.req.url);
    const credentials = await listCredentials({
      db: c.env.DB,
      userId: session.user.id,
      authRevision: session.authRevision,
    });
    return c.json(mfaManagementStatusSuccessSchema.parse({
      success: true,
      data: {
        totp: {
          configured_at_iso: status.configuredAtIso,
        },
        webauthn: {
          current_rp_id: requestContext.rpId,
          max_credentials: 10,
          credentials,
        },
        step_up: {
          mfa_required: !isFreshMfaVerification(
            session.mfaVerifiedAtIso,
            currentTime(),
          ),
          freshness_seconds: MFA_MANAGEMENT_FRESHNESS_SECONDS,
        },
      },
    }));
  });

  routes.post('/authorize', bodyLimit({
    maxSize: MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = authorizeMfaManagementRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await resolveRequiredSession(
      c,
      dependencies.resolveSession,
    );
    if (session instanceof Response) return session;
    const permissionResponse = authorizeManagementOperation(
      c,
      session,
      parsed.data.operation,
    );
    if (permissionResponse) return permissionResponse;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const rateLimitResponse = await applyNativeMfaRateLimit(c);
    if (rateLimitResponse) return rateLimitResponse;

    const passwordMatches = await verifyPassword({
      db: c.env.DB,
      userId: session.user.id,
      authRevision: session.authRevision,
      password: parsed.data.password,
    });
    if (!passwordMatches) {
      return errorResponse(c, 401, 'INVALID_CURRENT_PASSWORD');
    }

    const now = currentTime();
    if (parsed.data.verification) {
      const authSecret = readAuthSecret(c);
      if (authSecret instanceof Response) return authSecret;
      const result = await verifyUserTotp({
        db: c.env.DB,
        authSecret,
        userId: session.user.id,
        authRevision: session.authRevision,
        code: parsed.data.verification.code,
        now,
      });
      if (result.status === 'rate_limited') {
        setAuthRateLimitHeaders(c, result.rateLimit);
        return errorResponse(c, 429, 'RATE_LIMIT_EXCEEDED');
      }
      if (result.status !== 'verified') {
        return errorResponse(c, 401, 'INVALID_MFA_CODE');
      }
    } else if (!isFreshMfaVerification(session.mfaVerifiedAtIso, now)) {
      return errorResponse(c, 409, 'MFA_STEP_UP_REQUIRED');
    }

    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    let management;
    try {
      management = await createMfaManagementGrant({
        authSecret,
        userId: session.user.id,
        sessionId: session.session.id,
        authRevision: session.authRevision,
        operation: parsed.data.operation,
        targetId: parsed.data.target_id,
        now,
      });
    } catch (error) {
      throw cryptoFailure(error, 'create_mfa_management_grant');
    }
    recordAudit(c, { action: 'auth_reauthenticate', actor: userAuditActor(session.user), metadata: { method: parsed.data.verification ? 'totp' : 'password' } });
    return c.json(authorizeMfaManagementSuccessSchema.parse({
      success: true,
      data: {
        status: 'authorized',
        operation: parsed.data.operation,
        ...(parsed.data.target_id
          ? { target_id: parsed.data.target_id }
          : {}),
        management_token: management.token,
        expires_at_iso: management.expiresAtIso,
      },
    }));
  });

  async function authorizeToken(input: {
    c: Context<StudioHonoEnvironment>;
    token: string;
    operation: MfaManagementOperation;
    targetId?: string;
  }): Promise<
    | {
      session: ResolvedSession;
      authSecret: string;
    }
    | Response
  > {
    const session = await resolveRequiredSession(
      input.c,
      dependencies.resolveSession,
    );
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(input.c, session.csrfToken)) {
      return errorResponse(input.c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const authSecret = readAuthSecret(input.c);
    if (authSecret instanceof Response) return authSecret;
    const grant = await openMfaManagementGrant({
      authSecret,
      token: input.token,
      expectedOperation: input.operation,
      expectedTargetId: input.targetId,
      now: currentTime(),
    });
    if (!matchesCurrentSession(grant, session)) {
      return errorResponse(
        input.c,
        401,
        'MFA_MANAGEMENT_CHALLENGE_INVALID',
      );
    }
    return { session, authSecret };
  }

  routes.post('/password/complete', bodyLimit({
    maxSize: MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = changePasswordRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const rateLimitResponse = await applyNativeMfaRateLimit(c);
    if (rateLimitResponse) return rateLimitResponse;
    const authorized = await authorizeToken({
      c,
      token: parsed.data.management_token,
      operation: 'change_password',
    });
    if (authorized instanceof Response) return authorized;

    if (!(await assessPasswordAcceptance({
      password: parsed.data.new_password,
      email: authorized.session.user.email,
      displayName: authorized.session.user.name,
      env: c.env,
    })).allowed) {
      return errorResponse(c, 400, 'WEAK_USER_PASSWORD');
    }
    const passwordUnchanged = await verifyPassword({
      db: c.env.DB,
      userId: authorized.session.user.id,
      authRevision: authorized.session.authRevision,
      password: parsed.data.new_password,
    });
    if (passwordUnchanged) {
      return errorResponse(c, 409, 'NEW_PASSWORD_MUST_DIFFER');
    }

    let passwordHash: string;
    try {
      passwordHash = await hashNewPassword(parsed.data.new_password);
    } catch (error) {
      throw new StudioOperationalError('AUTH_PASSWORD_HASHING_FAILED', {
        cause: error,
        metadata: {
          component: 'argon2id',
          action: 'hash_changed_user_password',
        },
      });
    }
    const result = await changePassword({
      db: c.env.DB,
      userId: authorized.session.user.id,
      authRevision: authorized.session.authRevision,
      passwordHash,
      nextAuthRevision: createSecurityRevision(),
      now: currentTime(),
    });
    if (result.kind === 'challenge_invalid') {
      return errorResponse(c, 401, 'MFA_MANAGEMENT_CHALLENGE_INVALID');
    }
    recordAudit(c, { action: 'account_password', actor: userAuditActor(authorized.session.user), metadata: { deleted: result.revokedSessions } });
    clearSessionCookie(c);
    return c.json(changePasswordSuccessSchema.parse({
      success: true,
      data: {
        status: 'password_changed',
        revoked_sessions: result.revokedSessions,
        current_session_ended: true,
      },
    }));
  });

  routes.post('/totp/setup', bodyLimit({
    maxSize: MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = mfaManagementTotpSetupRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const rateLimitResponse = await applyNativeMfaRateLimit(c);
    if (rateLimitResponse) return rateLimitResponse;
    const authorized = await authorizeToken({
      c,
      token: parsed.data.management_token,
      operation: 'replace_totp',
    });
    if (authorized instanceof Response) return authorized;

    let enrollment;
    try {
      enrollment = await createMfaEnrollment({
        issuer: resolveMfaIssuer({
          requestUrl: c.req.url,
          siteTitle: authorized.session.siteTitle,
        }),
        authSecret: authorized.authSecret,
        subject: { type: 'user', id: authorized.session.user.id },
        accountName: authorized.session.user.email,
        now: currentTime(),
      });
    } catch (error) {
      throw cryptoFailure(error, 'create_managed_totp_enrollment');
    }
    const response: MfaEnrollmentSetupSuccess = {
      success: true,
      data: enrollment,
    };
    return c.json(response);
  });

  routes.post('/totp/complete', bodyLimit({
    maxSize: MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = mfaManagementTotpCompleteRequestSchema.safeParse(
      body.value,
    );
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const rateLimitResponse = await applyNativeMfaRateLimit(c);
    if (rateLimitResponse) return rateLimitResponse;
    const authorized = await authorizeToken({
      c,
      token: parsed.data.management_token,
      operation: 'replace_totp',
    });
    if (authorized instanceof Response) return authorized;
    const enrollment = await openMfaEnrollment({
      authSecret: authorized.authSecret,
      enrollmentToken: parsed.data.mfa.enrollment_token,
      now: currentTime(),
    });
    if (
      !enrollment
      || enrollment.subject_type !== 'user'
      || enrollment.subject_id !== authorized.session.user.id
    ) {
      return errorResponse(c, 401, 'MFA_MANAGEMENT_CHALLENGE_INVALID');
    }

    let proof;
    let encryptedTotpSecret;
    try {
      proof = await verifyMfaEnrollmentProof({
        enrollment,
        totpCode: parsed.data.mfa.totp_code,
        now: currentTime(),
      });
      encryptedTotpSecret = await encryptTotpSecret(
        authorized.authSecret,
        enrollment.totp_secret,
      );
    } catch (error) {
      throw cryptoFailure(error, 'verify_managed_totp_enrollment');
    }
    if (proof.matchedStep === null) {
      return errorResponse(c, 401, 'INVALID_MFA_CODE');
    }

    const completion = await replaceTotp({
      db: c.env.DB,
      userId: authorized.session.user.id,
      currentSessionId: authorized.session.session.id,
      authRevision: authorized.session.authRevision,
      encryptedTotpSecret,
      lastUsedStep: proof.matchedStep,
      now: currentTime(),
    });
    if (completion.kind === 'challenge_invalid') {
      return errorResponse(c, 401, 'MFA_MANAGEMENT_CHALLENGE_INVALID');
    }
    recordAudit(c, { action: 'account_totp', actor: userAuditActor(authorized.session.user), metadata: { deleted: completion.revokedSessions } });
    return c.json(mfaManagementTotpCompleteSuccessSchema.parse({
      success: true,
      data: {
        status: 'totp_replaced',
        revoked_sessions: completion.revokedSessions,
      },
    }));
  });

  routes.post('/webauthn/step-up/options', bodyLimit({
    maxSize: MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed =
      mfaManagementWebAuthnStepUpOptionsRequestSchema.safeParse(
        body.value,
      );
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await resolveRequiredSession(
      c,
      dependencies.resolveSession,
    );
    if (session instanceof Response) return session;
    const permissionResponse = authorizeManagementOperation(
      c,
      session,
      parsed.data.operation,
    );
    if (permissionResponse) return permissionResponse;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const rateLimitResponse = await applyNativeMfaRateLimit(c);
    if (rateLimitResponse) return rateLimitResponse;
    const passwordMatches = await verifyPassword({
      db: c.env.DB,
      userId: session.user.id,
      authRevision: session.authRevision,
      password: parsed.data.password,
    });
    if (!passwordMatches) {
      return errorResponse(c, 401, 'INVALID_CURRENT_PASSWORD');
    }

    const now = currentTime();
    const requestContext = requestContextOrError(c.req.url);
    const credentials = await listAuthenticationCredentials({
      db: c.env.DB,
      userId: session.user.id,
      authRevision: session.authRevision,
      rpId: requestContext.rpId,
    });
    if (credentials.length === 0) {
      return errorResponse(c, 409, 'WEBAUTHN_NOT_CONFIGURED');
    }
    let options;
    try {
      options = await generateAuthentication({
        rpID: requestContext.rpId,
        allowCredentials: credentials,
        timeout: WEBAUTHN_TIMEOUT_MS,
        userVerification: 'discouraged',
      });
    } catch (error) {
      throw cryptoFailure(
        error,
        'generate_management_webauthn_authentication_options',
      );
    }
    const challenge = await createChallenge({
      db: c.env.DB,
      userId: session.user.id,
      sessionId: session.session.id,
      authRevision: session.authRevision,
      purpose: 'management_step_up',
      operation: parsed.data.operation,
      targetId: parsed.data.target_id,
      challenge: options.challenge,
      origin: requestContext.origin,
      rpId: requestContext.rpId,
      now,
      ttlSeconds: WEBAUTHN_CHALLENGE_TTL_SECONDS,
    });
    return c.json(
      mfaManagementWebAuthnStepUpOptionsSuccessSchema.parse({
        success: true,
        data: {
          operation: parsed.data.operation,
          ...(parsed.data.target_id
            ? { target_id: parsed.data.target_id }
            : {}),
          options,
          challenge_token: challenge.token,
          expires_at_iso: challenge.expiresAtIso,
        },
      }),
    );
  });

  routes.post('/webauthn/step-up/verify', bodyLimit({
    maxSize: MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed =
      mfaManagementWebAuthnStepUpVerifyRequestSchema.safeParse(
        body.value,
      );
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await resolveRequiredSession(
      c,
      dependencies.resolveSession,
    );
    if (session instanceof Response) return session;
    const permissionResponse = authorizeManagementOperation(
      c,
      session,
      parsed.data.operation,
    );
    if (permissionResponse) return permissionResponse;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const rateLimitResponse = await applyNativeMfaRateLimit(c);
    if (rateLimitResponse) return rateLimitResponse;

    const now = currentTime();
    const challenge = await readChallenge({
      db: c.env.DB,
      token: parsed.data.challenge_token,
      userId: session.user.id,
      authRevision: session.authRevision,
      purpose: 'management_step_up',
      sessionId: session.session.id,
      operation: parsed.data.operation,
      targetId: parsed.data.target_id,
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
    const credential = await getStoredCredential({
      db: c.env.DB,
      userId: session.user.id,
      authRevision: session.authRevision,
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
        // The current password was verified before this challenge was
        // created. Keep authenticator presence mandatory through the default
        // WebAuthn verification path while allowing the second factor to omit
        // local user verification.
        requireUserVerification: false,
      });
    } catch {
      // Invalid assertions are expected and intentionally do not emit
      // operational logs that untrusted clients could amplify.
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

    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    let management;
    try {
      management = await createMfaManagementGrant({
        authSecret,
        userId: session.user.id,
        sessionId: session.session.id,
        authRevision: session.authRevision,
        operation: parsed.data.operation,
        targetId: parsed.data.target_id,
        now,
      });
    } catch (error) {
      throw cryptoFailure(error, 'create_webauthn_management_grant');
    }
    recordAudit(c, { action: 'auth_reauthenticate', actor: userAuditActor(session.user), metadata: { method: 'passkey' } });
    return c.json(authorizeMfaManagementSuccessSchema.parse({
      success: true,
      data: {
        status: 'authorized',
        operation: parsed.data.operation,
        ...(parsed.data.target_id
          ? { target_id: parsed.data.target_id }
          : {}),
        management_token: management.token,
        expires_at_iso: management.expiresAtIso,
      },
    }));
  });

  routes.post('/webauthn/registration/options', bodyLimit({
    maxSize: MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed =
      mfaManagementWebAuthnRegistrationOptionsRequestSchema.safeParse(
        body.value,
      );
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const rateLimitResponse = await applyNativeMfaRateLimit(c);
    if (rateLimitResponse) return rateLimitResponse;
    const authorized = await authorizeToken({
      c,
      token: parsed.data.management_token,
      operation: 'add_webauthn',
    });
    if (authorized instanceof Response) return authorized;

    const allCredentials = await listCredentials({
      db: c.env.DB,
      userId: authorized.session.user.id,
      authRevision: authorized.session.authRevision,
    });
    if (allCredentials.length >= 10) {
      return errorResponse(
        c,
        409,
        'WEBAUTHN_CREDENTIAL_LIMIT_REACHED',
      );
    }
    const requestContext = requestContextOrError(c.req.url);
    const currentRpCredentials =
      await listAuthenticationCredentials({
        db: c.env.DB,
        userId: authorized.session.user.id,
        authRevision: authorized.session.authRevision,
        rpId: requestContext.rpId,
      });
    let options;
    try {
      options = await generateRegistration({
        rpName: 'ZeroPress Studio',
        rpID: requestContext.rpId,
        userID: opaqueWebAuthnUserIdBytes(authorized.session.user.id),
        userName: authorized.session.user.email,
        userDisplayName: authorized.session.user.name,
        timeout: WEBAUTHN_TIMEOUT_MS,
        attestationType: 'direct',
        excludeCredentials: currentRpCredentials,
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
      });
    } catch (error) {
      throw cryptoFailure(
        error,
        'generate_webauthn_registration_options',
      );
    }
    const now = currentTime();
    const challenge = await createChallenge({
      db: c.env.DB,
      userId: authorized.session.user.id,
      sessionId: authorized.session.session.id,
      authRevision: authorized.session.authRevision,
      purpose: 'registration',
      operation: 'add_webauthn',
      challenge: options.challenge,
      origin: requestContext.origin,
      rpId: requestContext.rpId,
      now,
      ttlSeconds: WEBAUTHN_CHALLENGE_TTL_SECONDS,
    });
    return c.json(
      mfaManagementWebAuthnRegistrationOptionsSuccessSchema.parse({
        success: true,
        data: {
          options,
          challenge_token: challenge.token,
          expires_at_iso: challenge.expiresAtIso,
        },
      }),
    );
  });

  routes.post('/webauthn/registration/complete', bodyLimit({
    maxSize: MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed =
      mfaManagementWebAuthnRegistrationCompleteRequestSchema.safeParse(
        body.value,
      );
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const rateLimitResponse = await applyNativeMfaRateLimit(c);
    if (rateLimitResponse) return rateLimitResponse;
    const authorized = await authorizeToken({
      c,
      token: parsed.data.management_token,
      operation: 'add_webauthn',
    });
    if (authorized instanceof Response) return authorized;
    const now = currentTime();
    const challenge = await readChallenge({
      db: c.env.DB,
      token: parsed.data.challenge_token,
      userId: authorized.session.user.id,
      authRevision: authorized.session.authRevision,
      purpose: 'registration',
      sessionId: authorized.session.session.id,
      operation: 'add_webauthn',
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

    let verification;
    try {
      verification = await verifyRegistration({
        response: parsed.data.response as WebAuthnRegistrationResponse,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
      });
    } catch {
      // Registration failures are expected client input and intentionally do
      // not emit operational logs.
      return errorResponse(c, 401, 'WEBAUTHN_VERIFICATION_FAILED');
    }
    if (
      !verification.verified
      || !verification.registrationInfo.userVerified
    ) {
      return errorResponse(c, 401, 'WEBAUTHN_VERIFICATION_FAILED');
    }
    const registration = verification.registrationInfo;
    const transports = webAuthnTransportSchema.array().safeParse(
      registration.credential.transports ?? [],
    );
    if (!transports.success) {
      return errorResponse(c, 401, 'WEBAUTHN_VERIFICATION_FAILED');
    }
    const result = await registerCredential({
      db: c.env.DB,
      challenge,
      userId: authorized.session.user.id,
      authRevision: authorized.session.authRevision,
      displayName: parsed.data.display_name,
      credentialId: registration.credential.id,
      publicKey: registration.credential.publicKey,
      counter: registration.credential.counter,
      transports: transports.data,
      credentialDeviceType: registration.credentialDeviceType,
      credentialBackedUp: registration.credentialBackedUp,
      attestationFormat: registration.fmt,
      aaguid: registration.aaguid,
      now,
    });
    if (result.kind === 'challenge_invalid') {
      return errorResponse(c, 401, 'WEBAUTHN_CHALLENGE_INVALID');
    }
    if (result.kind === 'limit_reached') {
      return errorResponse(
        c,
        409,
        'WEBAUTHN_CREDENTIAL_LIMIT_REACHED',
      );
    }
    if (result.kind === 'name_conflict') {
      return errorResponse(
        c,
        409,
        'WEBAUTHN_CREDENTIAL_NAME_CONFLICT',
      );
    }
    if (result.kind === 'credential_conflict') {
      return errorResponse(
        c,
        409,
        'WEBAUTHN_CREDENTIAL_ALREADY_REGISTERED',
      );
    }
    recordAudit(c, { action: 'account_passkey_add', actor: userAuditActor(authorized.session.user), target: { type: 'passkey', id: result.credential.id, label: result.credential.display_name } });
    return c.json(
      mfaManagementWebAuthnRegistrationCompleteSuccessSchema.parse({
        success: true,
        data: {
          status: 'webauthn_registered',
          credential: result.credential,
        },
      }),
    );
  });

  routes.post('/webauthn/rename', bodyLimit({
    maxSize: MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = mfaManagementWebAuthnRenameRequestSchema.safeParse(
      body.value,
    );
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const session = await resolveRequiredSession(
      c,
      dependencies.resolveSession,
    );
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const rateLimitResponse = await applyNativeMfaRateLimit(c);
    if (rateLimitResponse) return rateLimitResponse;
    const result = await renameCredential({
      db: c.env.DB,
      userId: session.user.id,
      authRevision: session.authRevision,
      credentialRowId: parsed.data.credential_id,
      displayName: parsed.data.display_name,
      now: currentTime(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'WEBAUTHN_CREDENTIAL_NOT_FOUND');
    }
    if (result.kind === 'name_conflict') {
      return errorResponse(
        c,
        409,
        'WEBAUTHN_CREDENTIAL_NAME_CONFLICT',
      );
    }
    return c.json(mfaManagementWebAuthnRenameSuccessSchema.parse({
      success: true,
      data: {
        status: 'webauthn_renamed',
        credential: result.credential,
      },
    }));
  });

  routes.post('/webauthn/remove', bodyLimit({
    maxSize: MANAGEMENT_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = mfaManagementWebAuthnRemoveRequestSchema.safeParse(
      body.value,
    );
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const rateLimitResponse = await applyNativeMfaRateLimit(c);
    if (rateLimitResponse) return rateLimitResponse;
    const authorized = await authorizeToken({
      c,
      token: parsed.data.management_token,
      operation: 'remove_webauthn',
      targetId: parsed.data.credential_id,
    });
    if (authorized instanceof Response) return authorized;
    const result = await removeCredential({
      db: c.env.DB,
      userId: authorized.session.user.id,
      authRevision: authorized.session.authRevision,
      currentSessionId: authorized.session.session.id,
      credentialRowId: parsed.data.credential_id,
      now: currentTime(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'WEBAUTHN_CREDENTIAL_NOT_FOUND');
    }
    if (result.kind === 'challenge_invalid') {
      return errorResponse(
        c,
        401,
        'MFA_MANAGEMENT_CHALLENGE_INVALID',
      );
    }
    recordAudit(c, { action: 'account_passkey_remove', actor: userAuditActor(authorized.session.user), target: { type: 'passkey', id: parsed.data.credential_id }, metadata: { deleted: result.revokedSessions } });
    return c.json(mfaManagementWebAuthnRemoveSuccessSchema.parse({
      success: true,
      data: {
        status: 'webauthn_removed',
        revoked_sessions: result.revokedSessions,
      },
    }));
  });

  return routes;
}

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  loginRequestSchema,
  mfaEnrollmentCompleteRequestSchema,
  mfaEnrollmentSetupRequestSchema,
  mfaVerifyRequestSchema,
  type LoginMfaMethod,
  type LoginSuccess,
} from '../../../contracts/auth';
import type { MfaEnrollmentSetupSuccess } from '../../../contracts/mfa';
import {
  currentSessionSuccessSchema,
  logoutRequestSchema,
  logoutSuccessSchema,
  revokeOtherSessionsRequestSchema,
  revokeOtherSessionsSuccessSchema,
  revokeSessionRequestSchema,
  revokeSessionSuccessSchema,
  sessionListSuccessSchema,
} from '../../../contracts/session';
import { errorResponse, getClientIp } from '../lib/http';
import { StudioOperationalError } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import { authenticateCredentials } from './authenticate';
import { consumeLoginRateLimits } from './login-rate-limit';
import { createMfaManagementRoutes } from './mfa-management-routes';
import {
  applyNativeAuthRateLimit,
  finishAuthentication,
  readAuthSecret,
  readJsonBody,
  setAuthRateLimitHeaders,
} from './auth-route-utils';
import {
  createMfaContinuation,
  createMfaEnrollment,
  encryptTotpSecret,
  openMfaContinuation,
  openMfaEnrollment,
  verifyMfaEnrollmentProof,
} from './mfa-crypto';
import {
  completeMfaEnrollment,
  getMfaEnrollmentAccount,
  verifyUserTotp,
} from './mfa-repository';
import {
  clearSessionCookie,
  hasValidCsrfHeader,
  isSameOriginMutation,
  readSessionCookie,
} from './session-http';
import {
  issueUserSession,
  listUserSessions,
  MAX_CONCURRENT_SESSIONS,
  resolveUserSession,
  revokeOtherUserSessions,
  revokeUserSession,
  type IssueUserSession,
  type ListUserSessions,
  type ResolveUserSession,
  type RevokeOtherUserSessions,
  type RevokeUserSession,
} from './session-repository';
import { readSessionNetworkMetadata } from './session-network-metadata';
import { createWebAuthnLoginRoutes } from './webauthn-login-routes';
import {
  listWebAuthnAuthenticationCredentials,
} from './webauthn-repository';
import { resolveWebAuthnRequestContext } from './webauthn-origin';
import { createAccountSetupRoutes } from '../users/setup-routes';
import {
  readAccountAvatarPreviewUrl,
  type ReadAccountAvatarPreviewUrl,
} from './account-avatar-repository';
import { readEdgeIntegrationModeFailClosed } from '../settings/edge-services-repository';
import { createPasskeySignInRoutes } from './passkey-sign-in-routes';
import { createPasswordBreachRoutes } from './password-breach-routes';
import { inspectEdgeDatabaseRuntimeState } from '../edge-database/runtime-state';

export type CredentialsAuthenticator = typeof authenticateCredentials;

type AuthDependencies = {
  authenticator?: CredentialsAuthenticator;
  issueSession?: IssueUserSession;
  listSessions?: ListUserSessions;
  resolveSession?: ResolveUserSession;
  revokeOtherSessions?: RevokeOtherUserSessions;
  revokeSession?: RevokeUserSession;
  listWebAuthnCredentials?: typeof listWebAuthnAuthenticationCredentials;
  readAccountAvatar?: ReadAccountAvatarPreviewUrl;
  readEdgeIntegrationMode?: typeof readEdgeIntegrationModeFailClosed;
  inspectEdgeDatabaseRuntime?: typeof inspectEdgeDatabaseRuntimeState;
};

export function createAuthRoutes(
  dependencies: AuthDependencies = {},
) {
  const auth = new Hono<StudioHonoEnvironment>();
  const authenticator = dependencies.authenticator
    ?? authenticateCredentials;
  const issueSession = dependencies.issueSession ?? issueUserSession;
  const listSessions = dependencies.listSessions ?? listUserSessions;
  const resolveSession = dependencies.resolveSession ?? resolveUserSession;
  const revokeOtherSessions = dependencies.revokeOtherSessions
    ?? revokeOtherUserSessions;
  const revokeSession = dependencies.revokeSession ?? revokeUserSession;
  const listWebAuthnCredentials = dependencies.listWebAuthnCredentials
    ?? listWebAuthnAuthenticationCredentials;
  const readAccountAvatar = dependencies.readAccountAvatar
    ?? readAccountAvatarPreviewUrl;
  const readEdgeIntegrationMode = dependencies.readEdgeIntegrationMode
    ?? readEdgeIntegrationModeFailClosed;
  const inspectEdgeDatabaseRuntime = dependencies.inspectEdgeDatabaseRuntime
    ?? inspectEdgeDatabaseRuntimeState;

  auth.use('*', async (c, next) => {
    // Capture request.cf before bodyLimit may reconstruct the raw Request.
    c.set(
      'sessionNetworkMetadata',
      readSessionNetworkMetadata(c.req.raw),
    );
    await next();
  });

  auth.route('/mfa/management', createMfaManagementRoutes({
    resolveSession,
  }));
  auth.route('/mfa/webauthn', createWebAuthnLoginRoutes({
    issueSession,
    listCredentials: listWebAuthnCredentials,
  }));
  auth.route('/passkey', createPasskeySignInRoutes({ issueSession }));
  auth.route('/account-setup', createAccountSetupRoutes());
  auth.route('/password', createPasswordBreachRoutes());

  auth.post('/login', bodyLimit({
    maxSize: 8 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const rateLimitResponse = await applyNativeAuthRateLimit(
      c,
      'limit_login_route',
    );
    if (rateLimitResponse) return rateLimitResponse;

    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = loginRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }

    const ip = getClientIp(c);
    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    const rateLimit = await consumeLoginRateLimits({
      db: c.env.DB,
      authSecret,
      email: parsed.data.email.toLowerCase(),
      ip,
    });
    setAuthRateLimitHeaders(c, rateLimit);
    if (!rateLimit.allowed) {
      return errorResponse(c, 429, 'RATE_LIMIT_EXCEEDED');
    }

    const result = await authenticator({
      db: c.env.DB,
      email: parsed.data.email.toLowerCase(),
      password: parsed.data.password,
    });
    if (result.kind === 'invalid_credentials') {
      return errorResponse(c, 401, 'INVALID_CREDENTIALS');
    }
    if (result.kind === 'account_not_active') {
      return errorResponse(c, 403, 'ACCOUNT_NOT_ACTIVE');
    }
    if (result.kind === 'account_locked') {
      return errorResponse(c, 423, 'ACCOUNT_LOCKED');
    }

    let continuation: Awaited<ReturnType<typeof createMfaContinuation>>;
    try {
      continuation = await createMfaContinuation({
        authSecret,
        userId: result.userId,
        authRevision: result.authRevision,
        purpose: result.status === 'mfa_required' ? 'verify' : 'enroll',
      });
    } catch (error) {
      throw new StudioOperationalError(
        'AUTH_MFA_CRYPTO_NOT_AVAILABLE',
        {
          cause: error,
          metadata: {
            component: 'web_crypto',
            action: 'create_mfa_continuation',
          },
        },
      );
    }

    let response: LoginSuccess;
    if (result.status === 'mfa_required') {
      const requestContext = resolveWebAuthnRequestContext(c.req.url);
      const webAuthnCredentials = requestContext
        ? await listWebAuthnCredentials({
            db: c.env.DB,
            userId: result.userId,
            authRevision: result.authRevision,
            rpId: requestContext.rpId,
          })
        : [];
      const availableMethods: LoginMfaMethod[] = [
        ...(webAuthnCredentials.length > 0
          ? ['webauthn' as const]
          : []),
        'totp',
      ];
      response = {
        success: true,
        data: {
          status: 'mfa_required',
          continuation_token: continuation.token,
          expires_at_iso: continuation.expiresAtIso,
          available_methods: availableMethods,
          preferred_method: webAuthnCredentials.length > 0
            ? 'webauthn'
            : 'totp',
        },
      };
    } else {
      response = {
        success: true,
        data: {
          status: 'mfa_enrollment_required',
          continuation_token: continuation.token,
          expires_at_iso: continuation.expiresAtIso,
        },
      };
    }
    return c.json(response);
  });

  auth.post('/mfa/verify', bodyLimit({
    maxSize: 12 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const rateLimitResponse = await applyNativeAuthRateLimit(
      c,
      'limit_mfa_route',
    );
    if (rateLimitResponse) return rateLimitResponse;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = mfaVerifyRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    const continuation = await openMfaContinuation({
      authSecret,
      token: parsed.data.continuation_token,
      expectedPurpose: 'verify',
    });
    if (!continuation) {
      return errorResponse(c, 401, 'MFA_CHALLENGE_INVALID');
    }

    const verification = await verifyUserTotp({
      db: c.env.DB,
      authSecret,
      userId: continuation.userId,
      authRevision: continuation.authRevision,
      code: parsed.data.code,
    });
    if (verification.status === 'rate_limited') {
      setAuthRateLimitHeaders(c, verification.rateLimit);
      return errorResponse(c, 429, 'RATE_LIMIT_EXCEEDED');
    }
    if (verification.status !== 'verified') {
      return errorResponse(c, 401, 'INVALID_MFA_CODE');
    }

    return finishAuthentication({
      c,
      issueSession,
      userId: continuation.userId,
      authRevision: continuation.authRevision,
    });
  });

  auth.post('/mfa/enrollment/setup', bodyLimit({
    maxSize: 12 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const rateLimitResponse = await applyNativeAuthRateLimit(
      c,
      'limit_mfa_route',
    );
    if (rateLimitResponse) return rateLimitResponse;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = mfaEnrollmentSetupRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    const continuation = await openMfaContinuation({
      authSecret,
      token: parsed.data.continuation_token,
      expectedPurpose: 'enroll',
    });
    if (!continuation) {
      return errorResponse(c, 401, 'MFA_CHALLENGE_INVALID');
    }
    const account = await getMfaEnrollmentAccount({
      db: c.env.DB,
      userId: continuation.userId,
      authRevision: continuation.authRevision,
    });
    if (!account) {
      return errorResponse(c, 401, 'MFA_CHALLENGE_INVALID');
    }
    if (account.configured) {
      return errorResponse(c, 409, 'MFA_ALREADY_CONFIGURED');
    }

    let enrollment: Awaited<ReturnType<typeof createMfaEnrollment>>;
    try {
      enrollment = await createMfaEnrollment({
        authSecret,
        subject: { type: 'user', id: continuation.userId },
        accountName: account.email,
      });
    } catch (error) {
      throw new StudioOperationalError(
        'AUTH_MFA_CRYPTO_NOT_AVAILABLE',
        {
          cause: error,
          metadata: {
            component: 'web_crypto',
            action: 'create_mfa_enrollment',
          },
        },
      );
    }
    const response: MfaEnrollmentSetupSuccess = {
      success: true,
      data: enrollment,
    };
    return c.json(response);
  });

  auth.post('/mfa/enrollment/complete', bodyLimit({
    maxSize: 24 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const rateLimitResponse = await applyNativeAuthRateLimit(
      c,
      'limit_mfa_route',
    );
    if (rateLimitResponse) return rateLimitResponse;
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = mfaEnrollmentCompleteRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    const [continuation, enrollment] = await Promise.all([
      openMfaContinuation({
        authSecret,
        token: parsed.data.continuation_token,
        expectedPurpose: 'enroll',
      }),
      openMfaEnrollment({
        authSecret,
        enrollmentToken: parsed.data.mfa.enrollment_token,
      }),
    ]);
    if (
      !continuation
      || !enrollment
      || enrollment.subject_type !== 'user'
      || enrollment.subject_id !== continuation.userId
    ) {
      return errorResponse(c, 401, 'MFA_ENROLLMENT_INVALID');
    }
    let proof;
    try {
      proof = await verifyMfaEnrollmentProof({
        enrollment,
        totpCode: parsed.data.mfa.totp_code,
      });
    } catch (error) {
      throw new StudioOperationalError(
        'AUTH_MFA_CRYPTO_NOT_AVAILABLE',
        {
          cause: error,
          metadata: {
            component: 'web_crypto',
            action: 'verify_mfa_enrollment_proof',
          },
        },
      );
    }
    if (proof.matchedStep === null) {
      return errorResponse(c, 401, 'INVALID_MFA_CODE');
    }

    let encryptedTotpSecret;
    try {
      encryptedTotpSecret = await encryptTotpSecret(
        authSecret,
        enrollment.totp_secret,
      );
    } catch (error) {
      throw new StudioOperationalError(
        'AUTH_MFA_CRYPTO_NOT_AVAILABLE',
        {
          cause: error,
          metadata: {
            component: 'web_crypto',
            action: 'encrypt_totp_secret',
          },
        },
      );
    }
    const completion = await completeMfaEnrollment({
      db: c.env.DB,
      userId: continuation.userId,
      authRevision: continuation.authRevision,
      encryptedTotpSecret,
      lastUsedStep: proof.matchedStep,
    });
    if (completion.status === 'challenge_invalid') {
      return errorResponse(c, 401, 'MFA_ENROLLMENT_INVALID');
    }
    if (completion.status === 'already_configured') {
      return errorResponse(c, 409, 'MFA_ALREADY_CONFIGURED');
    }

    return finishAuthentication({
      c,
      issueSession,
      userId: continuation.userId,
      authRevision: continuation.authRevision,
    });
  });

  auth.get('/session', async (c) => {
    const session = await resolveSession({
      db: c.env.DB,
      cookieValue: readSessionCookie(c),
    });
    if (!session) {
      clearSessionCookie(c);
      return errorResponse(c, 401, 'AUTHENTICATION_REQUIRED');
    }
    const [avatarPreviewUrl, edgeIntegrationMode] = await Promise.all([
      readAccountAvatar({
        db: c.env.DB,
        userId: session.user.id,
      }),
      readEdgeIntegrationMode({ db: c.env.DB }),
    ]);
    const edgeDatabaseRuntime = edgeIntegrationMode === 'enabled'
      ? await inspectEdgeDatabaseRuntime({ edgeDb: c.env.EDGE_DB })
      : null;

    return c.json(currentSessionSuccessSchema.parse({
      success: true,
      data: {
        user: {
          ...session.user,
          ...(avatarPreviewUrl
            ? { avatar_preview_url: avatarPreviewUrl }
            : {}),
        },
        session: session.session,
        csrf_token: session.csrfToken,
        edge_integration: {
          mode: edgeIntegrationMode,
          database_state: edgeDatabaseRuntime?.state ?? null,
        },
        ...(session.siteTitle ? { site_title: session.siteTitle } : {}),
        ...(session.siteUrl ? { site_url: session.siteUrl } : {}),
      },
    }));
  });

  auth.get('/sessions', async (c) => {
    const session = await resolveSession({
      db: c.env.DB,
      cookieValue: readSessionCookie(c),
    });
    if (!session) {
      clearSessionCookie(c);
      return errorResponse(c, 401, 'AUTHENTICATION_REQUIRED');
    }

    const items = await listSessions({
      db: c.env.DB,
      userId: session.user.id,
      currentSessionId: session.session.id,
    });
    return c.json(sessionListSuccessSchema.parse({
      success: true,
      data: {
        items,
        max_sessions: MAX_CONCURRENT_SESSIONS,
      },
    }));
  });

  auth.post('/sessions/revoke', bodyLimit({
    maxSize: 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }

    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = revokeSessionRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }

    const session = await resolveSession({
      db: c.env.DB,
      cookieValue: readSessionCookie(c),
    });
    if (!session) {
      clearSessionCookie(c);
      return errorResponse(c, 401, 'AUTHENTICATION_REQUIRED');
    }
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }

    const currentSessionEnded =
      parsed.data.session_id === session.session.id;
    const revoked = await revokeSession({
      db: c.env.DB,
      userId: session.user.id,
      sessionId: parsed.data.session_id,
    });
    if (currentSessionEnded) {
      clearSessionCookie(c);
    }
    return c.json(revokeSessionSuccessSchema.parse({
      success: true,
      data: {
        status: 'session_revoked',
        revoked,
        current_session_ended: currentSessionEnded,
      },
    }));
  });

  auth.post('/sessions/revoke-others', bodyLimit({
    maxSize: 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }

    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    if (!revokeOtherSessionsRequestSchema.safeParse(body.value).success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }

    const session = await resolveSession({
      db: c.env.DB,
      cookieValue: readSessionCookie(c),
    });
    if (!session) {
      clearSessionCookie(c);
      return errorResponse(c, 401, 'AUTHENTICATION_REQUIRED');
    }
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }

    const revokedCount = await revokeOtherSessions({
      db: c.env.DB,
      userId: session.user.id,
      currentSessionId: session.session.id,
    });
    return c.json(revokeOtherSessionsSuccessSchema.parse({
      success: true,
      data: {
        status: 'other_sessions_revoked',
        revoked_count: revokedCount,
      },
    }));
  });

  auth.post('/logout', bodyLimit({
    maxSize: 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }

    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    if (!logoutRequestSchema.safeParse(body.value).success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }

    const session = await resolveSession({
      db: c.env.DB,
      cookieValue: readSessionCookie(c),
    });
    if (!session) {
      clearSessionCookie(c);
      return c.json(logoutSuccessSchema.parse({
        success: true,
        data: { status: 'logged_out' },
      }));
    }
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }

    await revokeSession({
      db: c.env.DB,
      userId: session.user.id,
      sessionId: session.session.id,
    });
    clearSessionCookie(c);
    return c.json(logoutSuccessSchema.parse({
      success: true,
      data: { status: 'logged_out' },
    }));
  });

  return auth;
}

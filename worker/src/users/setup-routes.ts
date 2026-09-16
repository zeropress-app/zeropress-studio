import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  completeUserSetupRequestSchema,
  completeUserSetupSuccessSchema,
  inspectUserSetupRequestSchema,
  inspectUserSetupSuccessSchema,
  prepareUserSetupRequestSchema,
} from '../../../contracts/users';
import {
  applyNativeAuthRateLimit,
  readAuthSecret,
  readJsonBody,
} from '../auth/auth-route-utils';
import {
  createMfaEnrollment,
  encryptTotpSecret,
  openMfaEnrollment,
  verifyMfaEnrollmentProof,
} from '../auth/mfa-crypto';
import { hashPassword } from '../auth/password';
import { isSameOriginMutation } from '../auth/session-http';
import { errorResponse } from '../lib/http';
import { StudioOperationalError } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  createUserSecurityRevision,
  parseUserSetupToken,
} from './setup-token-crypto';
import {
  completeUserSetup,
  getEligibleUserSetup,
  prepareUserSetup,
} from './user-repository';
import { assessPasswordAcceptance } from '../auth/password-breach-service';

const SETUP_BODY_LIMIT = 32 * 1024;

type SetupRouteDependencies = {
  hashPassword?: typeof hashPassword;
  getSetup?: typeof getEligibleUserSetup;
  prepareSetup?: typeof prepareUserSetup;
  completeSetup?: typeof completeUserSetup;
  now?: () => Date;
  createSecurityRevision?: () => string;
};

async function resolveSetupToken(
  token: string,
): Promise<{ id: string; secretDigest: string } | null> {
  try {
    return await parseUserSetupToken(token);
  } catch (error) {
    throw new StudioOperationalError(
      'USER_SETUP_CRYPTO_NOT_AVAILABLE',
      {
        cause: error,
        metadata: {
          component: 'web_crypto',
          action: 'digest_user_setup_token',
        },
      },
    );
  }
}

export function createAccountSetupRoutes(
  dependencies: SetupRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const currentTime = dependencies.now ?? (() => new Date());
  const hashSetupPassword = dependencies.hashPassword ?? hashPassword;
  const getSetup = dependencies.getSetup ?? getEligibleUserSetup;
  const prepareSetup = dependencies.prepareSetup ?? prepareUserSetup;
  const completeSetup = dependencies.completeSetup ?? completeUserSetup;
  const createSecurityRevision = dependencies.createSecurityRevision
    ?? createUserSecurityRevision;

  routes.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  routes.use('*', async (c, next) => {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const limited = await applyNativeAuthRateLimit(
      c,
      'limit_mfa_route',
    );
    if (limited) return limited;
    await next();
  });

  routes.post('/inspect', bodyLimit({
    maxSize: SETUP_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = inspectUserSetupRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const token = await resolveSetupToken(
      parsed.data.setup_token,
    );
    if (!token) {
      return errorResponse(c, 401, 'USER_SETUP_TOKEN_INVALID');
    }
    const setup = await getSetup({
      db: c.env.DB,
      setupTokenId: token.id,
      secretDigest: token.secretDigest,
      now: currentTime(),
    });
    if (!setup) {
      return errorResponse(c, 401, 'USER_SETUP_TOKEN_INVALID');
    }
    return c.json(inspectUserSetupSuccessSchema.parse({
      success: true,
      data: {
        purpose: setup.purpose,
        email: setup.email,
        name: setup.name,
        role: setup.role,
        expires_at_iso: setup.expiresAtIso,
      },
    }));
  });

  routes.post('/setup', bodyLimit({
    maxSize: SETUP_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = prepareUserSetupRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const token = await resolveSetupToken(
      parsed.data.setup_token,
    );
    if (!token) {
      return errorResponse(c, 401, 'USER_SETUP_TOKEN_INVALID');
    }
    const now = currentTime();
    const setup = await getSetup({
      db: c.env.DB,
      setupTokenId: token.id,
      secretDigest: token.secretDigest,
      now,
    });
    if (!setup) {
      return errorResponse(c, 401, 'USER_SETUP_TOKEN_INVALID');
    }
    if (!(await assessPasswordAcceptance({
      password: parsed.data.password,
      email: setup.email,
      displayName: setup.name,
      env: c.env,
    })).allowed) {
      return errorResponse(c, 400, 'WEAK_USER_PASSWORD');
    }
    let passwordHash: string;
    try {
      passwordHash = await hashSetupPassword(parsed.data.password);
    } catch (error) {
      throw new StudioOperationalError(
        'AUTH_PASSWORD_HASHING_FAILED',
        {
          cause: error,
          metadata: {
            component: 'argon2id',
            action: 'hash_user_setup_password',
          },
        },
      );
    }
    const setupNonce = createSecurityRevision();
    const prepared = await prepareSetup({
      db: c.env.DB,
      setupTokenId: setup.id,
      secretDigest: token.secretDigest,
      pendingPasswordHash: passwordHash,
      setupNonce,
      now,
    });
    if (!prepared) {
      return errorResponse(c, 401, 'USER_SETUP_TOKEN_INVALID');
    }
    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    let enrollment;
    try {
      enrollment = await createMfaEnrollment({
        authSecret,
        subject: {
          type: 'account_setup',
          id: prepared.userId,
          setupTokenId: prepared.id,
          setupNonce,
          authRevision: prepared.authRevision,
        },
        accountName: prepared.email,
        now,
      });
    } catch (error) {
      throw new StudioOperationalError('AUTH_MFA_CRYPTO_NOT_AVAILABLE', {
        cause: error,
        metadata: {
          component: 'web_crypto',
          action: 'create_user_setup_mfa_enrollment',
        },
      });
    }
    return c.json({ success: true, data: enrollment });
  });

  routes.post('/complete', bodyLimit({
    maxSize: SETUP_BODY_LIMIT,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = completeUserSetupRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const authSecret = readAuthSecret(c);
    if (authSecret instanceof Response) return authSecret;
    const now = currentTime();
    const enrollment = await openMfaEnrollment({
      authSecret,
      enrollmentToken: parsed.data.mfa.enrollment_token,
      now,
    });
    if (!enrollment || enrollment.subject_type !== 'account_setup') {
      return errorResponse(c, 401, 'MFA_ENROLLMENT_INVALID');
    }
    let proof;
    let encryptedTotpSecret;
    try {
      proof = await verifyMfaEnrollmentProof({
        enrollment,
        totpCode: parsed.data.mfa.totp_code,
        now,
      });
      if (proof.matchedStep === null) {
        return errorResponse(c, 401, 'INVALID_MFA_CODE');
      }
      encryptedTotpSecret = await encryptTotpSecret(
        authSecret,
        enrollment.totp_secret,
      );
    } catch (error) {
      throw new StudioOperationalError('AUTH_MFA_CRYPTO_NOT_AVAILABLE', {
        cause: error,
        metadata: {
          component: 'web_crypto',
          action: 'verify_user_setup_mfa_enrollment',
        },
      });
    }
    const completed = await completeSetup({
      db: c.env.DB,
      setupTokenId: enrollment.setup_token_id,
      userId: enrollment.subject_id,
      authRevision: enrollment.auth_revision,
      setupNonce: enrollment.setup_nonce,
      encryptedTotpSecret,
      lastUsedStep: proof.matchedStep,
      now,
      nextAuthRevision: createSecurityRevision(),
    });
    if (completed !== 'completed') {
      return errorResponse(c, 401, 'USER_SETUP_TOKEN_INVALID');
    }
    return c.json(completeUserSetupSuccessSchema.parse({
      success: true,
      data: { status: 'user_activated' },
    }));
  });

  return routes;
}

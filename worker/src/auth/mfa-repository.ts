import {
  decryptTotpSecret,
  type EncryptedTotpSecret,
  verifyTotpCode,
} from './mfa-crypto';
import { StudioOperationalError } from '../lib/operational-error';
import { consumeTotpRateLimit, type AuthRateLimitResult } from './login-rate-limit';

type MfaFactorRow = {
  id: string;
  secret_ciphertext: string;
  secret_iv: string;
  last_used_step: number;
};

type MfaEnrollmentAccountRow = {
  email: string;
  factor_count: number;
};

function createOpaqueId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readChanges(result: D1Result<unknown>): number {
  const changes = result.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

export async function getMfaEnrollmentAccount(input: {
  db: D1Database;
  userId: string;
  authRevision: string;
}): Promise<{ email: string; configured: boolean } | null> {
  try {
    const row = await input.db.prepare(`
      SELECT
        u.email,
        (
          SELECT COUNT(*)
          FROM user_mfa_factors f
          WHERE f.user_id = u.id
        ) AS factor_count
      FROM users u
      WHERE u.id = ?
        AND u.auth_revision = ?
        AND u.status = 'active'
      LIMIT 1
    `).bind(
      input.userId,
      input.authRevision,
    ).first<MfaEnrollmentAccountRow>();
    if (!row) return null;
    return {
      email: row.email,
      configured: row.factor_count > 0,
    };
  } catch (error) {
    throw new StudioOperationalError('AUTH_MFA_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: {
        resource: 'DB',
        action: 'read_mfa_enrollment_account',
      },
    });
  }
}

export async function completeMfaEnrollment(input: {
  db: D1Database;
  userId: string;
  authRevision: string;
  encryptedTotpSecret: EncryptedTotpSecret;
  lastUsedStep: number;
  now?: Date;
  createId?: () => string;
}): Promise<
  | { status: 'completed' }
  | { status: 'already_configured' }
  | { status: 'challenge_invalid' }
> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const factorId = (input.createId ?? createOpaqueId)();
  try {
    const result = await input.db.prepare(`
        INSERT INTO user_mfa_factors (
          id,
          user_id,
          factor_type,
          secret_ciphertext,
          secret_iv,
          last_used_step,
          created_at_iso,
          verified_at_iso
        )
        SELECT
          ?,
          u.id,
          'totp',
          ?,
          ?,
          ?,
          ?,
          ?
        FROM users u
        WHERE u.id = ?
          AND u.auth_revision = ?
          AND u.status = 'active'
          AND NOT EXISTS (
            SELECT 1
            FROM user_mfa_factors existing_factor
            WHERE existing_factor.user_id = u.id
          )
      `).bind(
        factorId,
        input.encryptedTotpSecret.ciphertext,
        input.encryptedTotpSecret.iv,
        input.lastUsedStep,
        nowIso,
        nowIso,
        input.userId,
        input.authRevision,
      ).run();
    if (readChanges(result) === 1) {
      return { status: 'completed' };
    }

    const account = await getMfaEnrollmentAccount({
      db: input.db,
      userId: input.userId,
      authRevision: input.authRevision,
    });
    if (!account) return { status: 'challenge_invalid' };
    if (account.configured) return { status: 'already_configured' };
    throw new TypeError(
      'D1 did not create an MFA factor for an eligible account.',
    );
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError('AUTH_MFA_DATABASE_WRITE_FAILED', {
      cause: error,
      metadata: {
        resource: 'DB',
        action: 'complete_mfa_enrollment',
      },
    });
  }
}

export async function verifyUserTotp(input: {
  db: D1Database;
  authSecret: string;
  userId: string;
  authRevision: string;
  code: string;
  now?: Date;
}): Promise<
  | { status: 'verified' | 'invalid' }
  | { status: 'rate_limited'; rateLimit: AuthRateLimitResult }
> {
  const now = input.now ?? new Date();
  try {
    const factor = await input.db.prepare(`
      SELECT
        f.id AS id,
        f.secret_ciphertext AS secret_ciphertext,
        f.secret_iv AS secret_iv,
        f.last_used_step AS last_used_step
      FROM user_mfa_factors f
      JOIN users u ON u.id = f.user_id
      WHERE f.user_id = ?
        AND f.factor_type = 'totp'
        AND u.auth_revision = ?
        AND u.status = 'active'
      LIMIT 1
    `).bind(
      input.userId,
      input.authRevision,
    ).first<MfaFactorRow>();
    if (!factor) {
      return { status: 'invalid' };
    }

    const rateLimit = await consumeTotpRateLimit({
      db: input.db,
      authSecret: input.authSecret,
      userId: input.userId,
      now,
    });
    if (!rateLimit.allowed) return { status: 'rate_limited', rateLimit };

    let secret: string;
    try {
      secret = await decryptTotpSecret(input.authSecret, {
        ciphertext: factor.secret_ciphertext,
        iv: factor.secret_iv,
      });
    } catch (error) {
      throw new StudioOperationalError('AUTH_MFA_CRYPTO_NOT_AVAILABLE', {
        cause: error,
        metadata: {
          component: 'web_crypto',
          action: 'decrypt_totp_secret',
        },
      });
    }
    let matchedStep: number | null;
    try {
      matchedStep = await verifyTotpCode({
        secret,
        code: input.code,
        now,
      });
    } catch (error) {
      throw new StudioOperationalError('AUTH_MFA_CRYPTO_NOT_AVAILABLE', {
        cause: error,
        metadata: {
          component: 'web_crypto',
          action: 'verify_totp_code',
        },
      });
    }
    if (matchedStep === null || matchedStep <= factor.last_used_step) {
      return { status: 'invalid' };
    }

    let update: D1Result<unknown>;
    try {
      update = await input.db.prepare(`
        UPDATE user_mfa_factors
        SET
          last_used_step = ?,
          verified_at_iso = ?
        WHERE id = ?
          AND last_used_step < ?
          AND EXISTS (
            SELECT 1
            FROM users current_user
            WHERE current_user.id = user_mfa_factors.user_id
              AND current_user.auth_revision = ?
              AND current_user.status = 'active'
          )
      `).bind(
        matchedStep,
        now.toISOString(),
        factor.id,
        matchedStep,
        input.authRevision,
      ).run();
    } catch (error) {
      throw new StudioOperationalError('AUTH_MFA_DATABASE_WRITE_FAILED', {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'consume_totp_step',
        },
      });
    }
    if (readChanges(update) !== 1) {
      return { status: 'invalid' };
    }
    return { status: 'verified' };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError('AUTH_MFA_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: {
        resource: 'DB',
        action: 'verify_totp',
      },
    });
  }
}

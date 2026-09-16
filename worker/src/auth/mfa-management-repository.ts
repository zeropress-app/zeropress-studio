import { StudioOperationalError } from '../lib/operational-error';
import type { EncryptedTotpSecret } from './mfa-crypto';
import { verifyPassword as verifyArgon2idPassword } from './password';

type MfaManagementStatusRow = {
  configured_at_iso: string;
};

type PasswordRow = {
  password_hash: string;
};

type PasswordVerifier = (
  password: string,
  encodedHash: string,
) => Promise<boolean>;

export type MfaManagementStatus = {
  configuredAtIso: string;
};

export type MfaManagementMutationResult =
  | { kind: 'completed'; revokedSessions: number }
  | { kind: 'challenge_invalid' };

function createAuthRevision(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

export async function getMfaManagementStatus(input: {
  db: D1Database;
  userId: string;
  authRevision: string;
}): Promise<MfaManagementStatus | null> {
  try {
    const row = await input.db.prepare(`
      SELECT factor.created_at_iso AS configured_at_iso
      FROM users current_user
      JOIN user_mfa_factors factor
        ON factor.user_id = current_user.id
        AND factor.factor_type = 'totp'
      WHERE current_user.id = ?
        AND current_user.auth_revision = ?
        AND current_user.status = 'active'
      LIMIT 1
    `).bind(
      input.userId,
      input.authRevision,
    ).first<MfaManagementStatusRow>();
    if (!row) return null;
    if (
      typeof row.configured_at_iso !== 'string'
      || !Number.isFinite(Date.parse(row.configured_at_iso))
    ) {
      throw new TypeError('D1 returned invalid MFA management status.');
    }
    return { configuredAtIso: row.configured_at_iso };
  } catch (error) {
    throw new StudioOperationalError('AUTH_MFA_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: {
        resource: 'DB',
        action: 'read_mfa_management_status',
      },
    });
  }
}

export async function verifyMfaManagementPassword(input: {
  db: D1Database;
  userId: string;
  authRevision: string;
  password: string;
  verifyPassword?: PasswordVerifier;
}): Promise<boolean> {
  let row: PasswordRow | null;
  try {
    row = await input.db.prepare(`
      SELECT password_hash
      FROM users
      WHERE id = ?
        AND auth_revision = ?
        AND status = 'active'
      LIMIT 1
    `).bind(
      input.userId,
      input.authRevision,
    ).first<PasswordRow>();
  } catch (error) {
    throw new StudioOperationalError('AUTH_MFA_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: {
        resource: 'DB',
        action: 'verify_mfa_management_password',
      },
    });
  }
  if (!row) return false;
  return (input.verifyPassword ?? verifyArgon2idPassword)(
    input.password,
    row.password_hash,
  );
}

export async function replaceManagedTotp(input: {
  db: D1Database;
  userId: string;
  currentSessionId: string;
  authRevision: string;
  encryptedTotpSecret: EncryptedTotpSecret;
  lastUsedStep: number;
  now?: Date;
  createRevision?: () => string;
}): Promise<MfaManagementMutationResult> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const nextRevision = (input.createRevision ?? createAuthRevision)();

  try {
    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE user_mfa_factors
        SET
          secret_ciphertext = ?,
          secret_iv = ?,
          last_used_step = ?,
          created_at_iso = ?,
          verified_at_iso = ?
        WHERE user_id = ?
          AND factor_type = 'totp'
          AND EXISTS (
            SELECT 1
            FROM users current_user
            JOIN sessions current_session
              ON current_session.user_id = current_user.id
            WHERE current_user.id = user_mfa_factors.user_id
              AND current_user.auth_revision = ?
              AND current_user.status = 'active'
              AND current_session.id = ?
              AND current_session.auth_revision = ?
          )
      `).bind(
        input.encryptedTotpSecret.ciphertext,
        input.encryptedTotpSecret.iv,
        input.lastUsedStep,
        nowIso,
        nowIso,
        input.userId,
        input.authRevision,
        input.currentSessionId,
        input.authRevision,
      ),
      input.db.prepare(`
        UPDATE users
        SET auth_revision = ?, updated_at_iso = ?
        WHERE id = ?
          AND auth_revision = ?
          AND status = 'active'
          AND EXISTS (
            SELECT 1
            FROM user_mfa_factors factor
            WHERE factor.user_id = users.id
              AND factor.factor_type = 'totp'
              AND factor.secret_ciphertext = ?
              AND factor.secret_iv = ?
              AND factor.verified_at_iso = ?
          )
      `).bind(
        nextRevision,
        nowIso,
        input.userId,
        input.authRevision,
        input.encryptedTotpSecret.ciphertext,
        input.encryptedTotpSecret.iv,
        nowIso,
      ),
      input.db.prepare(`
        UPDATE sessions
        SET auth_revision = ?, mfa_verified_at_iso = ?
        WHERE id = ?
          AND user_id = ?
          AND auth_revision = ?
          AND EXISTS (
            SELECT 1
            FROM users current_user
            WHERE current_user.id = sessions.user_id
              AND current_user.auth_revision = ?
              AND current_user.status = 'active'
          )
      `).bind(
        nextRevision,
        nowIso,
        input.currentSessionId,
        input.userId,
        input.authRevision,
        nextRevision,
      ),
      input.db.prepare(`
        DELETE FROM sessions
        WHERE user_id = ?
          AND id != ?
          AND EXISTS (
            SELECT 1
            FROM sessions current_session
            JOIN users current_user
              ON current_user.id = current_session.user_id
            WHERE current_session.id = ?
              AND current_session.user_id = sessions.user_id
              AND current_session.auth_revision = ?
              AND current_user.auth_revision = ?
          )
      `).bind(
        input.userId,
        input.currentSessionId,
        input.currentSessionId,
        nextRevision,
        nextRevision,
      ),
      // Force an atomic rollback if an earlier statement changed state but
      // the revision and current-session rotation did not both complete.
      input.db.prepare(`
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
          factor.id,
          factor.user_id,
          factor.factor_type,
          factor.secret_ciphertext,
          factor.secret_iv,
          factor.last_used_step,
          factor.created_at_iso,
          factor.verified_at_iso
        FROM user_mfa_factors factor
        WHERE factor.user_id = ?
          AND factor.factor_type = 'totp'
          AND factor.secret_ciphertext = ?
          AND factor.secret_iv = ?
          AND factor.verified_at_iso = ?
          AND NOT EXISTS (
            SELECT 1
            FROM users current_user
            JOIN sessions current_session
              ON current_session.user_id = current_user.id
            WHERE current_user.id = factor.user_id
              AND current_user.auth_revision = ?
              AND current_session.id = ?
              AND current_session.auth_revision = ?
          )
      `).bind(
        input.userId,
        input.encryptedTotpSecret.ciphertext,
        input.encryptedTotpSecret.iv,
        nowIso,
        nextRevision,
        input.currentSessionId,
        nextRevision,
      ),
    ]);

    if (readChanges(results[0]) !== 1) {
      return { kind: 'challenge_invalid' };
    }
    if (readChanges(results[1]) !== 1 || readChanges(results[2]) !== 1) {
      throw new TypeError(
        'D1 returned an incomplete managed TOTP replacement result.',
      );
    }
    return {
      kind: 'completed',
      revokedSessions: readChanges(results[3]),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError('AUTH_MFA_DATABASE_WRITE_FAILED', {
      cause: error,
      metadata: {
        resource: 'DB',
        action: 'replace_managed_totp',
      },
    });
  }
}

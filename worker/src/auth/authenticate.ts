import type { LoginStatus } from '../../../contracts/auth';
import { StudioOperationalError } from '../lib/operational-error';
import { verifyPassword as verifyArgon2idPassword } from './password';

// Generated from a non-secret synthetic password. Unknown accounts still run
// one Argon2id verification so account existence is less visible through timing.
export const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

type LoginUserRow = {
  id: string;
  password_hash: string;
  auth_revision: string;
  status: string;
  locked_until: string | null;
  factor_count: number;
};

export type CredentialResult =
  | {
      kind: 'success';
      status: LoginStatus;
      userId: string;
      authRevision: string;
    }
  | { kind: 'invalid_credentials' }
  | { kind: 'account_not_active' }
  | { kind: 'account_locked' };

type PasswordVerifier = (password: string, encodedHash: string) => Promise<boolean>;

export async function authenticateCredentials(input: {
  db: D1Database;
  email: string;
  password: string;
  verifyPassword?: PasswordVerifier;
  now?: Date;
}): Promise<CredentialResult> {
  let user: LoginUserRow | null;
  try {
    user = await input.db
      .prepare(`
        SELECT
          u.id,
          u.password_hash,
          u.auth_revision,
          u.status,
          u.locked_until,
          (
            SELECT COUNT(*)
            FROM user_mfa_factors f
            WHERE f.user_id = u.id
          ) AS factor_count
        FROM users u
        WHERE u.email = ?
        LIMIT 1
      `)
      .bind(input.email)
      .first<LoginUserRow>();
  } catch (error) {
    throw new StudioOperationalError('AUTH_DATABASE_QUERY_FAILED', {
      cause: error,
      metadata: {
        resource: 'DB',
        action: 'authenticate_credentials',
      },
    });
  }

  const verifyPassword = input.verifyPassword ?? verifyArgon2idPassword;
  const passwordMatches = await verifyPassword(
    input.password,
    user?.password_hash ?? DUMMY_PASSWORD_HASH,
  );

  if (!user || !passwordMatches) {
    return { kind: 'invalid_credentials' };
  }

  if (user.status !== 'active') {
    return { kind: 'account_not_active' };
  }

  const lockedUntil = user.locked_until ? Date.parse(user.locked_until) : Number.NaN;
  if (Number.isFinite(lockedUntil) && lockedUntil > (input.now ?? new Date()).getTime()) {
    return { kind: 'account_locked' };
  }

  return {
    kind: 'success',
    status: user.factor_count > 0
      ? 'mfa_required'
      : 'mfa_enrollment_required',
    userId: user.id,
    authRevision: user.auth_revision,
  };
}

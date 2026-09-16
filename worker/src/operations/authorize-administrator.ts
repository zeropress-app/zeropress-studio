import { DUMMY_PASSWORD_HASH } from '../auth/authenticate';
import { verifyPassword as verifyArgon2idPassword } from '../auth/password';
import { StudioOperationalError } from '../lib/operational-error';

type OperationsAdministratorRow = {
  id: string;
  email: string;
  password_hash: string;
  status: string;
  locked_until: string | null;
  is_administrator: number | boolean;
};

type PasswordVerifier = (
  password: string,
  encodedHash: string,
) => Promise<boolean>;

export type OperationsAdministratorAuthorization =
  | {
      authorized: true;
      administratorId: string;
      administratorEmail: string;
    }
  | { authorized: false };

export async function authorizeOperationsAdministrator(input: {
  db: D1Database;
  email: string;
  password: string;
  verifyPassword?: PasswordVerifier;
  now?: Date;
}): Promise<OperationsAdministratorAuthorization> {
  let administrator: OperationsAdministratorRow | null;
  try {
    administrator = await input.db.prepare(`
      SELECT
        u.id,
        u.email,
        u.password_hash,
        u.status,
        u.locked_until,
        EXISTS (
          SELECT 1
          FROM user_roles ur
          WHERE ur.user_id = u.id
            AND ur.role_key = 'admin'
        ) AS is_administrator
      FROM users u
      WHERE u.email = ?
      LIMIT 1
    `).bind(input.email).first<OperationsAdministratorRow>();
  } catch (error) {
    throw new StudioOperationalError(
      'OPERATIONS_ADMIN_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'authorize_operations_administrator',
        },
      },
    );
  }

  const verifyPassword = input.verifyPassword ?? verifyArgon2idPassword;
  const passwordMatches = await verifyPassword(
    input.password,
    administrator?.password_hash ?? DUMMY_PASSWORD_HASH,
  );
  if (!administrator || !passwordMatches) {
    return { authorized: false };
  }

  const lockedUntil = administrator.locked_until
    ? Date.parse(administrator.locked_until)
    : Number.NaN;
  if (
    administrator.status !== 'active'
    || !Boolean(administrator.is_administrator)
    || (
      Number.isFinite(lockedUntil)
      && lockedUntil > (input.now ?? new Date()).getTime()
    )
  ) {
    return { authorized: false };
  }

  // This recovery surface does not create a normal Studio session. The
  // separately provisioned operations token is the out-of-band second
  // credential, including for administrators whose normal login requires MFA.
  return {
    authorized: true,
    administratorId: administrator.id,
    // Use the canonical value read from D1, never the request field, for
    // operational attribution.
    administratorEmail: administrator.email,
  };
}

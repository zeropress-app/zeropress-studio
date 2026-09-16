import type { RecoverableAdministrator } from '../../../contracts/operations';
import type { EncryptedTotpSecret } from '../auth/mfa-crypto';
import { StudioOperationalError } from '../lib/operational-error';

const CANONICAL_ADMINISTRATOR_ROLE = {
  key: 'admin',
  name: 'Administrator',
  description: 'Full Studio administration access.',
  isSystem: 1,
} as const;

type RecoverableAdministratorRow = {
  id: string;
  email: string;
  name: string;
  status: string;
  mfa_configured: number | boolean;
};

type BootstrapAvailabilityRow = {
  canonical_role_count: number;
  administrator_count: number;
  email_count: number;
};

type BootstrapCompletionRow = {
  user_count: number;
  factor_count: number;
  role_count: number;
  administrator_count: number;
};

export type RecoveryAdministratorBootstrapAvailability =
  | 'available'
  | 'administrator_exists'
  | 'email_conflict';

export type BootstrapRecoveryAdministratorResult =
  | { state: 'created'; administratorId: string }
  | { state: 'administrator_exists' }
  | { state: 'email_conflict' };

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function createOpaqueId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function listRecoverableAdministrators(
  db: D1Database,
): Promise<RecoverableAdministrator[]> {
  try {
    const result = await db.prepare(`
      SELECT
        u.id,
        u.email,
        u.name,
        u.status,
        EXISTS (
          SELECT 1
          FROM user_mfa_factors f
          WHERE f.user_id = u.id
        ) AS mfa_configured
      FROM users u
      WHERE EXISTS (
        SELECT 1
        FROM user_roles ur
        WHERE ur.user_id = u.id
          AND ur.role_key = 'admin'
      )
      ORDER BY u.email, u.id
    `).all<RecoverableAdministratorRow>();
    if (!Array.isArray(result.results)) {
      throw new TypeError('D1 returned an invalid administrator list.');
    }
    return result.results.map((row) => {
      if (
        !/^[0-9a-f]{32}$/u.test(row.id)
        || !['active', 'inactive', 'pending'].includes(row.status)
      ) {
        throw new TypeError('D1 returned an invalid administrator row.');
      }
      return {
        id: row.id,
        email: row.email,
        name: row.name,
        status: row.status as RecoverableAdministrator['status'],
        mfa_configured: Boolean(row.mfa_configured),
      };
    });
  } catch (error) {
    throw new StudioOperationalError(
      'ADMINISTRATOR_RECOVERY_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'list_recoverable_administrators',
        },
      },
    );
  }
}

export async function inspectRecoveryAdministratorBootstrapAvailability(
  input: {
    db: D1Database;
    administratorEmail?: string;
  },
): Promise<RecoveryAdministratorBootstrapAvailability> {
  try {
    const row = await input.db.prepare(`
      SELECT
        (
          SELECT COUNT(*)
          FROM roles r
          WHERE r.key = ?
            AND r.name = ?
            AND r.description = ?
            AND r.is_system = ?
        ) AS canonical_role_count,
        (
          SELECT COUNT(*)
          FROM users u
          WHERE EXISTS (
            SELECT 1
            FROM user_roles ur
            WHERE ur.user_id = u.id
              AND ur.role_key = 'admin'
          )
        ) AS administrator_count,
        (
          SELECT COUNT(*)
          FROM users u
          WHERE ? IS NOT NULL
            AND u.email = ?
        ) AS email_count
    `).bind(
      CANONICAL_ADMINISTRATOR_ROLE.key,
      CANONICAL_ADMINISTRATOR_ROLE.name,
      CANONICAL_ADMINISTRATOR_ROLE.description,
      CANONICAL_ADMINISTRATOR_ROLE.isSystem,
      input.administratorEmail ?? null,
      input.administratorEmail ?? null,
    ).first<BootstrapAvailabilityRow>();
    if (
      !row
      || !Number.isInteger(row.canonical_role_count)
      || !Number.isInteger(row.administrator_count)
      || !Number.isInteger(row.email_count)
      || row.canonical_role_count !== 1
      || row.administrator_count < 0
      || row.email_count < 0
    ) {
      throw new TypeError(
        'D1 returned an invalid administrator bootstrap state.',
      );
    }
    if (row.administrator_count !== 0) return 'administrator_exists';
    if (row.email_count !== 0) return 'email_conflict';
    return 'available';
  } catch (error) {
    throw new StudioOperationalError(
      'ADMINISTRATOR_RECOVERY_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'inspect_recovery_administrator_bootstrap',
        },
      },
    );
  }
}

async function inspectCompletedRecoveryAdministratorBootstrap(input: {
  db: D1Database;
  administratorId: string;
  administratorEmail: string;
  administratorName: string;
}): Promise<boolean> {
  const row = await input.db.prepare(`
    SELECT
      (
        SELECT COUNT(*)
        FROM users u
        WHERE u.id = ?
          AND u.email = ?
          AND u.name = ?
          AND u.status = 'active'
          AND u.email_verified = 1
      ) AS user_count,
      (
        SELECT COUNT(*)
        FROM user_mfa_factors f
        WHERE f.user_id = ?
          AND f.factor_type = 'totp'
      ) AS factor_count,
      (
        SELECT COUNT(*)
        FROM user_roles ur
        WHERE ur.user_id = ?
          AND ur.role_key = 'admin'
      ) AS role_count,
      (
        SELECT COUNT(*)
        FROM users u
        WHERE EXISTS (
          SELECT 1
          FROM user_roles ur
          WHERE ur.user_id = u.id
            AND ur.role_key = 'admin'
        )
      ) AS administrator_count
  `).bind(
    input.administratorId,
    input.administratorEmail,
    input.administratorName,
    input.administratorId,
    input.administratorId,
  ).first<BootstrapCompletionRow>();
  return row !== null
    && row.user_count === 1
    && row.factor_count === 1
    && row.role_count === 1
    && row.administrator_count === 1;
}

export async function bootstrapRecoveryAdministrator(input: {
  db: D1Database;
  administratorName: string;
  administratorEmail: string;
  passwordHash: string;
  encryptedTotpSecret: EncryptedTotpSecret;
  lastUsedStep: number;
  now?: Date;
  createId?: () => string;
}): Promise<BootstrapRecoveryAdministratorResult> {
  const availability = await inspectRecoveryAdministratorBootstrapAvailability({
    db: input.db,
    administratorEmail: input.administratorEmail,
  });
  if (availability !== 'available') return { state: availability };
  const createId = input.createId ?? createOpaqueId;
  const administratorId = createId();
  const factorId = createId();
  const nowIso = (input.now ?? new Date()).toISOString();
  const noAdministratorSql = `
    NOT EXISTS (
      SELECT 1
      FROM user_roles ur
      WHERE ur.role_key = 'admin'
    )
  `;
  const statements = [
    input.db.prepare(`
      INSERT INTO users (
        id,
        email,
        password_hash,
        name,
        status,
        email_verified,
        failed_login_attempts,
        locked_until,
        created_at_iso,
        updated_at_iso
      )
      SELECT ?, ?, ?, ?, 'active', 1, 0, NULL, ?, ?
      WHERE ${noAdministratorSql}
        AND NOT EXISTS (
          SELECT 1
          FROM users existing_user
          WHERE existing_user.email = ?
        )
        AND EXISTS (
          SELECT 1
          FROM roles r
          WHERE r.key = ?
            AND r.name = ?
            AND r.description = ?
            AND r.is_system = ?
        )
    `).bind(
      administratorId,
      input.administratorEmail,
      input.passwordHash,
      input.administratorName,
      nowIso,
      nowIso,
      input.administratorEmail,
      CANONICAL_ADMINISTRATOR_ROLE.key,
      CANONICAL_ADMINISTRATOR_ROLE.name,
      CANONICAL_ADMINISTRATOR_ROLE.description,
      CANONICAL_ADMINISTRATOR_ROLE.isSystem,
    ),
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
      SELECT ?, u.id, 'totp', ?, ?, ?, ?, ?
      FROM users u
      WHERE u.id = ?
        AND ${noAdministratorSql}
    `).bind(
      factorId,
      input.encryptedTotpSecret.ciphertext,
      input.encryptedTotpSecret.iv,
      input.lastUsedStep,
      nowIso,
      nowIso,
      administratorId,
    ),
    input.db.prepare(`
      INSERT INTO user_roles (
        user_id,
        role_key,
        created_at_iso
      )
      SELECT u.id, 'admin', ?
      FROM users u
      WHERE u.id = ?
        AND ${noAdministratorSql}
    `).bind(nowIso, administratorId),
  ];

  let writeError: unknown;
  try {
    await input.db.batch(statements);
  } catch (error) {
    writeError = error;
  }

  try {
    if (await inspectCompletedRecoveryAdministratorBootstrap({
      db: input.db,
      administratorId,
      administratorEmail: input.administratorEmail,
      administratorName: input.administratorName,
    })) {
      return { state: 'created', administratorId };
    }
    const currentAvailability =
      await inspectRecoveryAdministratorBootstrapAvailability({
        db: input.db,
        administratorEmail: input.administratorEmail,
      });
    if (currentAvailability !== 'available') {
      return { state: currentAvailability };
    }
  } catch (verificationError) {
    if (!writeError) writeError = verificationError;
  }

  throw new StudioOperationalError(
    'ADMINISTRATOR_RECOVERY_DATABASE_WRITE_FAILED',
    {
      cause: writeError,
      metadata: {
        resource: 'DB',
        action: 'bootstrap_recovery_administrator',
      },
    },
  );
}

export async function recoverAdministratorAccess(input: {
  db: D1Database;
  administratorId: string;
  passwordHash: string;
  resetMfa: boolean;
  now?: Date;
}): Promise<boolean> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const isAdministratorSql = `
    EXISTS (
      SELECT 1
      FROM user_roles ur
      WHERE ur.user_id = users.id
        AND ur.role_key = 'admin'
    )
  `;
  const isSelectedAdministratorSql = `
    EXISTS (
      SELECT 1
      FROM users
      WHERE users.id = ?
        AND ${isAdministratorSql}
    )
  `;
  const statements = [
    input.db.prepare(`
      UPDATE users
      SET
        password_hash = ?,
        auth_revision = lower(hex(randomblob(16))),
        status = 'active',
        failed_login_attempts = 0,
        locked_until = NULL,
        updated_at_iso = ?
      WHERE id = ?
        AND ${isAdministratorSql}
    `).bind(
      input.passwordHash,
      nowIso,
      input.administratorId,
    ),
    input.db.prepare(`
      DELETE FROM sessions
      WHERE user_id = ?
        AND ${isSelectedAdministratorSql}
    `).bind(
      input.administratorId,
      input.administratorId,
    ),
  ];
  if (input.resetMfa) {
    statements.push(
      input.db.prepare(`
        DELETE FROM webauthn_challenges
        WHERE user_id = ?
          AND ${isSelectedAdministratorSql}
      `).bind(
        input.administratorId,
        input.administratorId,
      ),
      input.db.prepare(`
        DELETE FROM user_webauthn_credentials
        WHERE user_id = ?
          AND ${isSelectedAdministratorSql}
      `).bind(
        input.administratorId,
        input.administratorId,
      ),
      input.db.prepare(`
        DELETE FROM user_mfa_factors
        WHERE user_id = ?
          AND ${isSelectedAdministratorSql}
      `).bind(
        input.administratorId,
        input.administratorId,
      ),
    );
  }

  try {
    const results = await input.db.batch(statements);
    return readChanges(results[0]) === 1;
  } catch (error) {
    throw new StudioOperationalError(
      'ADMINISTRATOR_RECOVERY_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'recover_administrator_access',
        },
      },
    );
  }
}

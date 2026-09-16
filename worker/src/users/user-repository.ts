import {
  SYSTEM_ROLE_KEYS,
  type ManagedUser,
  type UserDeletionImpact,
  type UserListData,
  type UserListQuery,
  type UserRole,
  type UserSetupPurpose,
  type UserStatus,
} from '../../../contracts/users';
import { publicAuthorIdentitySchema } from '../../../contracts/author-identity';
import type { EncryptedTotpSecret } from '../auth/mfa-crypto';
import { StudioOperationalError } from '../lib/operational-error';

type ManagedUserRow = {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  auth_revision: string;
  roles: string | null;
  totp_count: number;
  webauthn_count: number;
  session_count: number;
  setup_purpose: UserSetupPurpose | null;
  setup_expires_at_iso: string | null;
  setup_consumed_at_iso: string | null;
  created_at_iso: string;
  updated_at_iso: string;
  author_id: unknown;
  author_display_name: unknown;
};

export type EligibleUserSetup = {
  id: string;
  userId: string;
  authRevision: string;
  purpose: UserSetupPurpose;
  email: string;
  name: string;
  role: UserRole;
  expiresAtIso: string;
};

type SetupTokenRow = {
  setup_token_id: string;
  user_id: string;
  auth_revision: string;
  purpose: UserSetupPurpose;
  email: string;
  name: string;
  roles: string | null;
  expires_at_iso: string;
};

type UserMutationState = {
  id: string;
  status: UserStatus;
  auth_revision: string;
  roles: string | null;
  factor_count: number;
  active_admin_count: number;
  setup_purpose: UserSetupPurpose | null;
};

type UserStatusCountsRow = {
  all_count: unknown;
  pending_count: unknown;
  active_count: unknown;
  inactive_count: unknown;
  summary_total_count: unknown;
  summary_pending_count: unknown;
  summary_active_count: unknown;
  summary_inactive_count: unknown;
  summary_administrator_count: unknown;
};

const MANAGED_USER_SELECT = `
  SELECT
    users.id,
    users.email,
    users.name,
    users.status,
    users.auth_revision,
    (
      SELECT GROUP_CONCAT(ordered_roles.role_key, ',')
      FROM (
        SELECT user_roles.role_key
        FROM user_roles
        WHERE user_roles.user_id = users.id
        ORDER BY user_roles.role_key
      ) AS ordered_roles
    ) AS roles,
    (
      SELECT COUNT(*)
      FROM user_mfa_factors factor
      WHERE factor.user_id = users.id
        AND factor.factor_type = 'totp'
    ) AS totp_count,
    (
      SELECT COUNT(*)
      FROM user_webauthn_credentials credential
      WHERE credential.user_id = users.id
    ) AS webauthn_count,
    (
      SELECT COUNT(*)
      FROM sessions session
      WHERE session.user_id = users.id
        AND session.idle_expires_at_iso > ?
        AND session.absolute_expires_at_iso > ?
    ) AS session_count,
    setup_token.purpose AS setup_purpose,
    setup_token.expires_at_iso AS setup_expires_at_iso,
    setup_token.consumed_at_iso AS setup_consumed_at_iso,
    linked_author.id AS author_id,
    linked_author.display_name AS author_display_name,
    users.created_at_iso,
    users.updated_at_iso
  FROM users
  LEFT JOIN user_setup_tokens setup_token
    ON setup_token.user_id = users.id
  LEFT JOIN authors linked_author
    ON linked_author.user_id = users.id
`;

function createOpaqueId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function readDeletedUserIds(
  result: D1Result<unknown> | undefined,
): string[] | null {
  if (result?.success !== true || !Array.isArray(result.results)) return null;
  const ids: string[] = [];
  for (const row of result.results) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return null;
    }
    const id = (row as Record<string, unknown>).deleted_user_id;
    if (typeof id !== 'string') return null;
    ids.push(id);
  }
  return ids;
}

function parseSingleRole(value: string | null): UserRole {
  const roles = value?.split(',').filter(Boolean) ?? [];
  if (
    roles.length !== 1
    || !SYSTEM_ROLE_KEYS.includes(roles[0] as UserRole)
  ) {
    throw new TypeError('D1 returned an invalid user role assignment.');
  }
  return roles[0] as UserRole;
}

function integerCount(value: unknown, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError('D1 returned an invalid user aggregate count.');
  }
  return Math.min(value as number, maximum);
}

function toManagedUser(row: ManagedUserRow, now: Date): ManagedUser {
  const author = row.author_id === null && row.author_display_name === null
    ? null
    : publicAuthorIdentitySchema.safeParse({
        id: row.author_id,
        display_name: row.author_display_name,
      });
  if (author !== null && !author.success) {
    throw new TypeError('D1 returned an invalid linked Author identity.');
  }
  const expiresAt = row.setup_expires_at_iso;
  const setup = row.status === 'pending'
    && expiresAt
    && row.setup_purpose
    && row.setup_consumed_at_iso === null
    ? {
        purpose: row.setup_purpose,
        status: Date.parse(expiresAt) > now.getTime()
          ? 'pending' as const
          : 'expired' as const,
        expires_at_iso: expiresAt,
      }
    : null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    role: parseSingleRole(row.roles),
    mfa: {
      totp_configured: integerCount(row.totp_count, 1) === 1,
      webauthn_credentials: integerCount(row.webauthn_count, 10),
    },
    active_sessions: integerCount(row.session_count, 5),
    author: author === null ? null : author.data,
    setup,
    created_at_iso: row.created_at_iso,
    updated_at_iso: row.updated_at_iso,
  };
}

function queryFailure(error: unknown, action: string) {
  return new StudioOperationalError('USER_MANAGEMENT_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

function writeFailure(error: unknown, action: string) {
  return new StudioOperationalError('USER_MANAGEMENT_DATABASE_WRITE_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action },
  });
}

export async function listManagedUsers(input: {
  db: D1Database;
  query: UserListQuery;
  now?: Date;
}): Promise<UserListData> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const commonWhere: string[] = [];
  const commonParams: unknown[] = [];
  if (input.query.search) {
    commonWhere.push(`(
      instr(lower(users.name), lower(?)) > 0
      OR instr(lower(users.email), lower(?)) > 0
    )`);
    commonParams.push(input.query.search, input.query.search);
  }
  if (input.query.role !== 'all') {
    commonWhere.push(`EXISTS (
      SELECT 1
      FROM user_roles filtered_role
      WHERE filtered_role.user_id = users.id
        AND filtered_role.role_key = ?
    )`);
    commonParams.push(input.query.role);
  }
  const listWhere = [...commonWhere];
  const listParams = [...commonParams];
  if (input.query.status !== 'all') {
    listWhere.push('users.status = ?');
    listParams.push(input.query.status);
  }
  const commonFilter = commonWhere.length > 0
    ? `WHERE ${commonWhere.join(' AND ')}`
    : '';
  const listFilter = listWhere.length > 0
    ? `WHERE ${listWhere.join(' AND ')}`
    : '';
  const offset = (input.query.page - 1) * input.query.per_page;
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        SELECT
          filtered_users.all_count AS all_count,
          filtered_users.pending_count AS pending_count,
          filtered_users.active_count AS active_count,
          filtered_users.inactive_count AS inactive_count,
          user_summary.total_count AS summary_total_count,
          user_summary.pending_count AS summary_pending_count,
          user_summary.active_count AS summary_active_count,
          user_summary.inactive_count AS summary_inactive_count,
          user_summary.administrator_count AS summary_administrator_count
        FROM (
          SELECT
            COUNT(*) AS all_count,
            COALESCE(SUM(users.status = 'pending'), 0) AS pending_count,
            COALESCE(SUM(users.status = 'active'), 0) AS active_count,
            COALESCE(SUM(users.status = 'inactive'), 0) AS inactive_count
          FROM users
          ${commonFilter}
        ) filtered_users
        CROSS JOIN (
          SELECT
            COUNT(*) AS total_count,
            COALESCE(SUM(summary_users.status = 'pending'), 0)
              AS pending_count,
            COALESCE(SUM(summary_users.status = 'active'), 0)
              AS active_count,
            COALESCE(SUM(summary_users.status = 'inactive'), 0)
              AS inactive_count,
            COALESCE(SUM(EXISTS (
              SELECT 1
              FROM user_roles summary_role
              WHERE summary_role.user_id = summary_users.id
                AND summary_role.role_key = 'admin'
            )), 0) AS administrator_count
          FROM users summary_users
        ) user_summary
      `).bind(...commonParams),
      input.db.prepare(`
        ${MANAGED_USER_SELECT}
        ${listFilter}
        ORDER BY users.created_at_iso DESC, users.id ASC
        LIMIT ? OFFSET ?
      `).bind(
        nowIso,
        nowIso,
        ...listParams,
        input.query.per_page,
        offset,
      ),
    ]);
    const countRow = results[0]?.results?.[0] as UserStatusCountsRow | undefined;
    if (!countRow) {
      throw new TypeError('D1 returned invalid user status counts.');
    }
    const statusCounts = {
      all: integerCount(countRow.all_count, Number.MAX_SAFE_INTEGER),
      pending: integerCount(countRow.pending_count, Number.MAX_SAFE_INTEGER),
      active: integerCount(countRow.active_count, Number.MAX_SAFE_INTEGER),
      inactive: integerCount(countRow.inactive_count, Number.MAX_SAFE_INTEGER),
    };
    const summary = {
      total: integerCount(
        countRow.summary_total_count,
        Number.MAX_SAFE_INTEGER,
      ),
      pending: integerCount(
        countRow.summary_pending_count,
        Number.MAX_SAFE_INTEGER,
      ),
      active: integerCount(
        countRow.summary_active_count,
        Number.MAX_SAFE_INTEGER,
      ),
      inactive: integerCount(
        countRow.summary_inactive_count,
        Number.MAX_SAFE_INTEGER,
      ),
      administrators: integerCount(
        countRow.summary_administrator_count,
        Number.MAX_SAFE_INTEGER,
      ),
    };
    if (summary.total !== summary.pending + summary.active + summary.inactive) {
      throw new TypeError('D1 returned inconsistent user summary counts.');
    }
    const rows = results[1]?.results;
    if (!Array.isArray(rows)) {
      throw new TypeError('D1 returned an invalid user list.');
    }
    const total = input.query.status === 'all'
      ? statusCounts.all
      : statusCounts[input.query.status];
    return {
      items: (rows as ManagedUserRow[]).map((row) => toManagedUser(row, now)),
      pagination: {
        page: input.query.page,
        per_page: input.query.per_page,
        total,
        total_pages: total === 0 ? 0 : Math.ceil(total / input.query.per_page),
      },
      status_counts: statusCounts,
      summary,
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'list_users');
  }
}

export async function getManagedUser(input: {
  db: D1Database;
  userId: string;
  now?: Date;
}): Promise<ManagedUser | null> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  try {
    const row = await input.db.prepare(`
      ${MANAGED_USER_SELECT}
      WHERE users.id = ?
      LIMIT 1
    `).bind(nowIso, nowIso, input.userId).first<ManagedUserRow>();
    return row ? toManagedUser(row, now) : null;
  } catch (error) {
    throw queryFailure(error, 'read_user');
  }
}

type UserDeletionCountsRow = {
  post_autosaves: unknown;
  page_autosaves: unknown;
  media_upload_intents: unknown;
};

export type InspectManagedUserDeletionImpactResult =
  | { kind: 'completed'; impact: UserDeletionImpact }
  | { kind: 'not_found' }
  | { kind: 'account_not_inactive' };

export async function inspectManagedUserDeletionImpact(input: {
  db: D1Database;
  userId: string;
  now?: Date;
}): Promise<InspectManagedUserDeletionImpactResult> {
  const now = input.now ?? new Date();
  try {
    const user = await getManagedUser({
      db: input.db,
      userId: input.userId,
      now,
    });
    if (!user) return { kind: 'not_found' };
    const operation = user.status === 'pending'
      && user.setup?.purpose === 'invitation'
      ? 'cancel_invitation' as const
      : user.status === 'inactive'
        ? 'delete_account' as const
        : null;
    if (!operation) return { kind: 'account_not_inactive' };
    const counts = await input.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM post_autosaves WHERE user_id = ?) AS post_autosaves,
        (SELECT COUNT(*) FROM page_autosaves WHERE user_id = ?) AS page_autosaves,
        (SELECT COUNT(*) FROM media_upload_intents WHERE user_id = ?) AS media_upload_intents
    `).bind(
      input.userId,
      input.userId,
      input.userId,
    ).first<UserDeletionCountsRow>();
    if (!counts) {
      throw new TypeError('D1 did not return user-deletion impact counts.');
    }
    return {
      kind: 'completed',
      impact: {
        operation,
        user,
        effects: {
          post_autosaves: integerCount(
            counts.post_autosaves,
            Number.MAX_SAFE_INTEGER,
          ),
          page_autosaves: integerCount(
            counts.page_autosaves,
            Number.MAX_SAFE_INTEGER,
          ),
          media_upload_intents: integerCount(
            counts.media_upload_intents,
            Number.MAX_SAFE_INTEGER,
          ),
        },
      },
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error, 'inspect_user_deletion_impact');
  }
}

export type DestructiveManagedUserMutationResult =
  | { kind: 'completed' }
  | { kind: 'not_found' }
  | { kind: 'confirmation_mismatch' }
  | { kind: 'invitation_not_cancellable' }
  | { kind: 'account_not_inactive' }
  | { kind: 'current_user' };

function pendingInvitationPredicate(alias: string): string {
  return `${alias}.status = 'pending'
    AND EXISTS (
      SELECT 1 FROM user_setup_tokens setup
      WHERE setup.user_id = ${alias}.id
        AND setup.purpose = 'invitation'
        AND setup.consumed_at_iso IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM user_mfa_factors factor
      WHERE factor.user_id = ${alias}.id
    )`;
}

function inactiveAccountPredicate(alias: string): string {
  return `${alias}.status = 'inactive'`;
}

async function deleteManagedUser(input: {
  db: D1Database;
  administratorId: string;
  userId: string;
  confirmationEmail: string;
  operation: 'cancel_invitation' | 'delete_account';
  now?: Date;
  createRevision?: () => string;
}): Promise<DestructiveManagedUserMutationResult> {
  if (input.userId === input.administratorId) return { kind: 'current_user' };
  const nowIso = (input.now ?? new Date()).toISOString();
  const authorRevision = (input.createRevision ?? createOpaqueId)();
  const predicate = input.operation === 'cancel_invitation'
    ? pendingInvitationPredicate('candidate')
    : inactiveAccountPredicate('candidate');
  try {
    const results = await input.db.batch([
      // Upload completion can terminate after R2 accepted the object but
      // before Media materialization. Queue every pending immutable key before
      // the user cascade removes the only cleanup record.
      input.db.prepare(`
        INSERT OR IGNORE INTO media_object_deletions (
          storage_key, attempt_count, created_at_iso, last_attempt_at_iso
        )
        SELECT intent.storage_key, 0, ?, NULL
        FROM media_upload_intents intent
        JOIN users candidate ON candidate.id = intent.user_id
        WHERE candidate.id = ?
          AND candidate.id != ?
          AND candidate.email = ?
          AND ${predicate}
      `).bind(
        nowIso,
        input.userId,
        input.administratorId,
        input.confirmationEmail,
      ),
      // Author is the durable public content identity. Preserve it while
      // making the unlink visible to optimistic-concurrency consumers.
      input.db.prepare(`
        UPDATE authors
        SET user_id = NULL, revision = ?, updated_at_iso = ?
        WHERE user_id = ?
          AND EXISTS (
            SELECT 1 FROM users candidate
            WHERE candidate.id = ?
              AND candidate.id != ?
              AND candidate.email = ?
              AND ${predicate}
          )
      `).bind(
        authorRevision,
        nowIso,
        input.userId,
        input.userId,
        input.administratorId,
        input.confirmationEmail,
      ),
      input.db.prepare(`
        DELETE FROM users
        WHERE id = ?
          AND id != ?
          AND email = ?
          AND ${input.operation === 'cancel_invitation'
            ? pendingInvitationPredicate('users')
            : inactiveAccountPredicate('users')}
        RETURNING id AS deleted_user_id
      `).bind(
        input.userId,
        input.administratorId,
        input.confirmationEmail,
      ),
    ]);
    const deletedUserIds = readDeletedUserIds(results[2]);
    if (
      results.length !== 3
      || deletedUserIds === null
      || deletedUserIds.length > 1
      || (deletedUserIds.length === 1 && deletedUserIds[0] !== input.userId)
    ) {
      throw new TypeError('D1 returned an invalid user-deletion batch result.');
    }
    if (deletedUserIds.length === 1) return { kind: 'completed' };
    const current = await getManagedUser({
      db: input.db,
      userId: input.userId,
      now: input.now,
    });
    if (!current) return { kind: 'not_found' };
    if (current.email !== input.confirmationEmail) {
      return { kind: 'confirmation_mismatch' };
    }
    return input.operation === 'cancel_invitation'
      ? { kind: 'invitation_not_cancellable' }
      : { kind: 'account_not_inactive' };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(
      error,
      input.operation === 'cancel_invitation'
        ? 'cancel_user_invitation'
        : 'delete_user_account',
    );
  }
}

export function cancelManagedUserInvitation(input: {
  db: D1Database;
  administratorId: string;
  userId: string;
  confirmationEmail: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<DestructiveManagedUserMutationResult> {
  return deleteManagedUser({ ...input, operation: 'cancel_invitation' });
}

export function deleteInactiveManagedUserAccount(input: {
  db: D1Database;
  administratorId: string;
  userId: string;
  confirmationEmail: string;
  now?: Date;
  createRevision?: () => string;
}): Promise<DestructiveManagedUserMutationResult> {
  return deleteManagedUser({ ...input, operation: 'delete_account' });
}

export async function getEligibleUserSetup(input: {
  db: D1Database;
  setupTokenId: string;
  secretDigest: string;
  now?: Date;
}): Promise<EligibleUserSetup | null> {
  const nowIso = (input.now ?? new Date()).toISOString();
  try {
    const row = await input.db.prepare(`
      SELECT
        setup_token.id AS setup_token_id,
        users.id AS user_id,
        users.auth_revision,
        setup_token.purpose,
        users.email,
        users.name,
        (
          SELECT GROUP_CONCAT(user_roles.role_key, ',')
          FROM user_roles
          WHERE user_roles.user_id = users.id
        ) AS roles,
        setup_token.expires_at_iso
      FROM user_setup_tokens setup_token
      JOIN users ON users.id = setup_token.user_id
      WHERE setup_token.id = ?
        AND setup_token.secret_digest = ?
        AND setup_token.consumed_at_iso IS NULL
        AND setup_token.expires_at_iso > ?
        AND users.status = 'pending'
      LIMIT 1
    `).bind(
      input.setupTokenId,
      input.secretDigest,
      nowIso,
    ).first<SetupTokenRow>();
    if (!row) return null;
    return {
      id: row.setup_token_id,
      userId: row.user_id,
      authRevision: row.auth_revision,
      purpose: row.purpose,
      email: row.email,
      name: row.name,
      role: parseSingleRole(row.roles),
      expiresAtIso: row.expires_at_iso,
    };
  } catch (error) {
    throw queryFailure(error, 'read_user_setup_token');
  }
}

export async function createManagedUserInvitation(input: {
  db: D1Database;
  administratorId: string;
  email: string;
  name: string;
  role: UserRole;
  pendingPasswordHash: string;
  setupTokenId: string;
  secretDigest: string;
  now?: Date;
  expiresAt: Date;
  createUserId?: () => string;
}): Promise<
  | { kind: 'completed'; user: ManagedUser }
  | { kind: 'email_conflict' }
> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const userId = (input.createUserId ?? createOpaqueId)();
  try {
    const existing = await input.db.prepare(`
      SELECT id FROM users WHERE email = ? LIMIT 1
    `).bind(input.email).first<{ id: string }>();
    if (existing) return { kind: 'email_conflict' };
    const results = await input.db.batch([
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
        ) VALUES (?, ?, ?, ?, 'pending', 0, 0, NULL, ?, ?)
      `).bind(
        userId,
        input.email,
        input.pendingPasswordHash,
        input.name,
        nowIso,
        nowIso,
      ),
      input.db.prepare(`
        INSERT INTO user_roles (user_id, role_key, created_at_iso)
        VALUES (?, ?, ?)
      `).bind(userId, input.role, nowIso),
      input.db.prepare(`
        INSERT INTO user_setup_tokens (
          id,
          user_id,
          purpose,
          secret_digest,
          created_by,
          created_at_iso,
          expires_at_iso
        ) VALUES (?, ?, 'invitation', ?, ?, ?, ?)
      `).bind(
        input.setupTokenId,
        userId,
        input.secretDigest,
        input.administratorId,
        nowIso,
        input.expiresAt.toISOString(),
      ),
    ]);
    if (results.some((result) => readChanges(result) !== 1)) {
      throw new TypeError('D1 returned an incomplete invitation batch.');
    }
    const user = await getManagedUser({ db: input.db, userId, now });
    if (!user) throw new TypeError('Created invited user is unavailable.');
    return { kind: 'completed', user };
  } catch (error) {
    try {
      const existing = await input.db.prepare(`
        SELECT id FROM users WHERE email = ? LIMIT 1
      `).bind(input.email).first<{ id: string }>();
      if (existing) return { kind: 'email_conflict' };
    } catch {
      // Preserve the original write failure when conflict classification fails.
    }
    throw writeFailure(error, 'create_user_invitation');
  }
}

export async function reissueManagedUserInvitation(input: {
  db: D1Database;
  administratorId: string;
  userId: string;
  setupTokenId: string;
  secretDigest: string;
  expiresAt: Date;
  nextAuthRevision: string;
  now?: Date;
}): Promise<
  | { kind: 'completed'; user: ManagedUser; revokedSessions: number }
  | { kind: 'not_found' }
  | { kind: 'state_conflict' }
> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  try {
    const state = await readUserMutationState(input.db, input.userId);
    if (!state) return { kind: 'not_found' };
    if (
      state.factor_count !== 0
      || !['pending', 'inactive'].includes(state.status)
      || state.setup_purpose === 'credential_recovery'
    ) {
      return { kind: 'state_conflict' };
    }
    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE users
        SET
          status = 'pending',
          auth_revision = ?,
          failed_login_attempts = 0,
          locked_until = NULL,
          updated_at_iso = ?
        WHERE id = ?
          AND auth_revision = ?
          AND status IN ('pending', 'inactive')
          AND NOT EXISTS (
            SELECT 1 FROM user_mfa_factors WHERE user_id = users.id
          )
      `).bind(
        input.nextAuthRevision,
        nowIso,
        input.userId,
        state.auth_revision,
      ),
      input.db.prepare(`
        INSERT INTO user_setup_tokens (
          id,
          user_id,
          purpose,
          secret_digest,
          created_by,
          pending_password_hash,
          setup_nonce,
          setup_at_iso,
          created_at_iso,
          expires_at_iso,
          consumed_at_iso
        )
        SELECT ?, users.id, 'invitation', ?, ?, NULL, NULL, NULL, ?, ?, NULL
        FROM users
        WHERE users.id = ?
          AND users.auth_revision = ?
          AND users.status = 'pending'
        ON CONFLICT(user_id) DO UPDATE SET
          id = excluded.id,
          purpose = excluded.purpose,
          secret_digest = excluded.secret_digest,
          created_by = excluded.created_by,
          pending_password_hash = NULL,
          setup_nonce = NULL,
          setup_at_iso = NULL,
          created_at_iso = excluded.created_at_iso,
          expires_at_iso = excluded.expires_at_iso,
          consumed_at_iso = NULL
      `).bind(
        input.setupTokenId,
        input.secretDigest,
        input.administratorId,
        nowIso,
        input.expiresAt.toISOString(),
        input.userId,
        input.nextAuthRevision,
      ),
      input.db.prepare(`
        DELETE FROM sessions
        WHERE user_id = ?
          AND EXISTS (
            SELECT 1 FROM users
            WHERE users.id = ? AND users.auth_revision = ?
          )
      `).bind(
        input.userId,
        input.userId,
        input.nextAuthRevision,
      ),
    ]);
    if (readChanges(results[0]) !== 1 || readChanges(results[1]) !== 1) {
      return { kind: 'state_conflict' };
    }
    const user = await getManagedUser({
      db: input.db,
      userId: input.userId,
      now,
    });
    if (!user) throw new TypeError('Reinvited user is unavailable.');
    return {
      kind: 'completed',
      user,
      revokedSessions: readChanges(results[2]),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'reissue_user_invitation');
  }
}

export async function prepareUserSetup(input: {
  db: D1Database;
  setupTokenId: string;
  secretDigest: string;
  pendingPasswordHash: string;
  setupNonce: string;
  now?: Date;
}): Promise<EligibleUserSetup | null> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  try {
    const result = await input.db.prepare(`
      UPDATE user_setup_tokens
      SET
        pending_password_hash = ?,
        setup_nonce = ?,
        setup_at_iso = ?
      WHERE id = ?
        AND secret_digest = ?
        AND consumed_at_iso IS NULL
        AND expires_at_iso > ?
        AND EXISTS (
          SELECT 1
          FROM users
          WHERE users.id = user_setup_tokens.user_id
            AND users.status = 'pending'
        )
    `).bind(
      input.pendingPasswordHash,
      input.setupNonce,
      nowIso,
      input.setupTokenId,
      input.secretDigest,
      nowIso,
    ).run();
    if (readChanges(result) !== 1) return null;
    return getEligibleUserSetup({
      db: input.db,
      setupTokenId: input.setupTokenId,
      secretDigest: input.secretDigest,
      now,
    });
  } catch (error) {
    throw writeFailure(error, 'prepare_user_setup');
  }
}

export async function completeUserSetup(input: {
  db: D1Database;
  setupTokenId: string;
  userId: string;
  authRevision: string;
  setupNonce: string;
  encryptedTotpSecret: EncryptedTotpSecret;
  lastUsedStep: number;
  now?: Date;
  nextAuthRevision: string;
  createFactorId?: () => string;
}): Promise<'completed' | 'setup_invalid'> {
  const nowIso = (input.now ?? new Date()).toISOString();
  const factorId = (input.createFactorId ?? createOpaqueId)();
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE users
        SET
          password_hash = (
            SELECT setup_token.pending_password_hash
            FROM user_setup_tokens setup_token
            WHERE setup_token.id = ?
              AND setup_token.user_id = users.id
              AND setup_token.setup_nonce = ?
              AND setup_token.pending_password_hash IS NOT NULL
              AND setup_token.consumed_at_iso IS NULL
              AND setup_token.expires_at_iso > ?
          ),
          status = 'active',
          auth_revision = ?,
          failed_login_attempts = 0,
          locked_until = NULL,
          updated_at_iso = ?
        WHERE id = ?
          AND auth_revision = ?
          AND status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM user_mfa_factors WHERE user_id = users.id
          )
          AND EXISTS (
            SELECT 1
            FROM user_setup_tokens setup_token
            WHERE setup_token.id = ?
              AND setup_token.user_id = users.id
              AND setup_token.setup_nonce = ?
              AND setup_token.pending_password_hash IS NOT NULL
              AND setup_token.consumed_at_iso IS NULL
              AND setup_token.expires_at_iso > ?
          )
      `).bind(
        input.setupTokenId,
        input.setupNonce,
        nowIso,
        input.nextAuthRevision,
        nowIso,
        input.userId,
        input.authRevision,
        input.setupTokenId,
        input.setupNonce,
        nowIso,
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
        SELECT ?, users.id, 'totp', ?, ?, ?, ?, ?
        FROM users
        WHERE users.id = ?
          AND users.auth_revision = ?
          AND users.status = 'active'
      `).bind(
        factorId,
        input.encryptedTotpSecret.ciphertext,
        input.encryptedTotpSecret.iv,
        input.lastUsedStep,
        nowIso,
        nowIso,
        input.userId,
        input.nextAuthRevision,
      ),
      input.db.prepare(`
        UPDATE user_setup_tokens
        SET
          pending_password_hash = NULL,
          setup_nonce = NULL,
          setup_at_iso = NULL,
          consumed_at_iso = ?
        WHERE id = ?
          AND user_id = ?
          AND setup_nonce = ?
          AND consumed_at_iso IS NULL
          AND EXISTS (
            SELECT 1
            FROM user_mfa_factors factor
            WHERE factor.id = ? AND factor.user_id = ?
          )
      `).bind(
        nowIso,
        input.setupTokenId,
        input.userId,
        input.setupNonce,
        factorId,
        input.userId,
      ),
    ]);
    if (readChanges(results[0]) !== 1) return 'setup_invalid';
    const factorResultIndex = 1;
    const finalResultIndex = results.length - 1;
    if (
      readChanges(results[factorResultIndex]) !== 1
      || readChanges(results[finalResultIndex]) !== 1
    ) {
      throw new TypeError('D1 returned an incomplete activation batch.');
    }
    return 'completed';
  } catch (error) {
    throw writeFailure(error, 'complete_user_setup');
  }
}

export async function resetManagedUserAccess(input: {
  db: D1Database;
  administratorId: string;
  userId: string;
  setupTokenId: string;
  secretDigest: string;
  expiresAt: Date;
  nextAuthRevision: string;
  now?: Date;
}): Promise<
  | {
      kind: 'completed';
      user: ManagedUser;
      revokedSessions: number;
      reissued: boolean;
    }
  | { kind: 'not_found' }
  | { kind: 'last_admin' }
  | { kind: 'state_conflict' }
> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  try {
    const state = await readUserMutationState(input.db, input.userId);
    if (!state) return { kind: 'not_found' };
    const role = parseSingleRole(state.roles);
    if (
      state.status === 'active'
      && role === 'admin'
      && state.active_admin_count <= 1
    ) {
      return { kind: 'last_admin' };
    }
    const reissued = state.status === 'pending'
      && state.setup_purpose === 'credential_recovery';
    const canReset = reissued || (
      ['active', 'inactive'].includes(state.status)
      && state.factor_count === 1
    );
    if (!canReset) return { kind: 'state_conflict' };

    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE users
        SET
          status = 'pending',
          auth_revision = ?,
          failed_login_attempts = 0,
          locked_until = NULL,
          updated_at_iso = ?
        WHERE id = ?
          AND auth_revision = ?
          AND (
            (
              status IN ('active', 'inactive')
              AND EXISTS (
                SELECT 1 FROM user_mfa_factors factor
                WHERE factor.user_id = users.id
                  AND factor.factor_type = 'totp'
              )
            )
            OR (
              status = 'pending'
              AND EXISTS (
                SELECT 1 FROM user_setup_tokens current_setup
                WHERE current_setup.user_id = users.id
                  AND current_setup.purpose = 'credential_recovery'
              )
            )
          )
          AND (
            status != 'active'
            OR NOT EXISTS (
              SELECT 1 FROM user_roles current_role
              WHERE current_role.user_id = users.id
                AND current_role.role_key = 'admin'
            )
            OR EXISTS (
              SELECT 1
              FROM users other_admin
              JOIN user_roles other_role
                ON other_role.user_id = other_admin.id
              WHERE other_admin.id != users.id
                AND other_admin.status = 'active'
                AND other_role.role_key = 'admin'
            )
          )
      `).bind(
        input.nextAuthRevision,
        nowIso,
        input.userId,
        state.auth_revision,
      ),
      input.db.prepare(`
        DELETE FROM webauthn_challenges
        WHERE user_id = ?
          AND EXISTS (
            SELECT 1 FROM users
            WHERE users.id = ? AND users.auth_revision = ?
          )
      `).bind(input.userId, input.userId, input.nextAuthRevision),
      input.db.prepare(`
        DELETE FROM sessions
        WHERE user_id = ?
          AND EXISTS (
            SELECT 1 FROM users
            WHERE users.id = ? AND users.auth_revision = ?
          )
      `).bind(input.userId, input.userId, input.nextAuthRevision),
      input.db.prepare(`
        DELETE FROM user_webauthn_credentials
        WHERE user_id = ?
          AND EXISTS (
            SELECT 1 FROM users
            WHERE users.id = ? AND users.auth_revision = ?
          )
      `).bind(input.userId, input.userId, input.nextAuthRevision),
      input.db.prepare(`
        DELETE FROM user_mfa_factors
        WHERE user_id = ?
          AND EXISTS (
            SELECT 1 FROM users
            WHERE users.id = ? AND users.auth_revision = ?
          )
      `).bind(input.userId, input.userId, input.nextAuthRevision),
      input.db.prepare(`
        INSERT INTO user_setup_tokens (
          id,
          user_id,
          purpose,
          secret_digest,
          created_by,
          pending_password_hash,
          setup_nonce,
          setup_at_iso,
          created_at_iso,
          expires_at_iso,
          consumed_at_iso
        )
        SELECT
          ?, users.id, 'credential_recovery', ?, ?,
          NULL, NULL, NULL, ?, ?, NULL
        FROM users
        WHERE users.id = ?
          AND users.auth_revision = ?
          AND users.status = 'pending'
        ON CONFLICT(user_id) DO UPDATE SET
          id = excluded.id,
          purpose = excluded.purpose,
          secret_digest = excluded.secret_digest,
          created_by = excluded.created_by,
          pending_password_hash = NULL,
          setup_nonce = NULL,
          setup_at_iso = NULL,
          created_at_iso = excluded.created_at_iso,
          expires_at_iso = excluded.expires_at_iso,
          consumed_at_iso = NULL
      `).bind(
        input.setupTokenId,
        input.secretDigest,
        input.administratorId,
        nowIso,
        input.expiresAt.toISOString(),
        input.userId,
        input.nextAuthRevision,
      ),
    ]);
    if (readChanges(results[0]) !== 1) {
      const current = await readUserMutationState(input.db, input.userId);
      if (!current) return { kind: 'not_found' };
      if (
        current.status === 'active'
        && parseSingleRole(current.roles) === 'admin'
        && current.active_admin_count <= 1
      ) {
        return { kind: 'last_admin' };
      }
      return { kind: 'state_conflict' };
    }
    if (readChanges(results[5]) !== 1) {
      throw new TypeError('D1 returned an incomplete access-reset batch.');
    }
    const user = await getManagedUser({
      db: input.db,
      userId: input.userId,
      now,
    });
    if (!user) throw new TypeError('Reset user is unavailable.');
    return {
      kind: 'completed',
      user,
      revokedSessions: readChanges(results[2]),
      reissued,
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'reset_user_access');
  }
}

async function readUserMutationState(
  db: D1Database,
  userId: string,
): Promise<UserMutationState | null> {
  return db.prepare(`
    SELECT
      users.id,
      users.status,
      users.auth_revision,
      (
        SELECT GROUP_CONCAT(user_roles.role_key, ',')
        FROM user_roles
        WHERE user_roles.user_id = users.id
      ) AS roles,
      (
        SELECT COUNT(*) FROM user_mfa_factors
        WHERE user_mfa_factors.user_id = users.id
      ) AS factor_count,
      (
        SELECT COUNT(*)
        FROM users active_admin
        JOIN user_roles active_role
          ON active_role.user_id = active_admin.id
        WHERE active_admin.status = 'active'
          AND active_role.role_key = 'admin'
      ) AS active_admin_count,
      (
        SELECT user_setup_tokens.purpose
        FROM user_setup_tokens
        WHERE user_setup_tokens.user_id = users.id
        LIMIT 1
      ) AS setup_purpose
    FROM users
    WHERE users.id = ?
    LIMIT 1
  `).bind(userId).first<UserMutationState>();
}

export async function updateManagedUserName(input: {
  db: D1Database;
  userId: string;
  name: string;
  expectedUpdatedAtIso: string;
  now?: Date;
}): Promise<
  | { kind: 'completed'; user: ManagedUser }
  | { kind: 'not_found' }
  | { kind: 'state_conflict' }
> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  try {
    const current = await input.db.prepare(`
      SELECT name, updated_at_iso
      FROM users
      WHERE id = ?
      LIMIT 1
    `).bind(input.userId).first<{
      name: string;
      updated_at_iso: string;
    }>();
    if (!current) return { kind: 'not_found' };
    if (current.updated_at_iso !== input.expectedUpdatedAtIso) {
      return { kind: 'state_conflict' };
    }
    if (current.name !== input.name) {
      const result = await input.db.prepare(`
        UPDATE users
        SET name = ?, updated_at_iso = ?
        WHERE id = ?
          AND updated_at_iso = ?
          AND name != ?
      `).bind(
        input.name,
        nowIso,
        input.userId,
        input.expectedUpdatedAtIso,
        input.name,
      ).run();
      if (readChanges(result) !== 1) {
        const stillExists = await input.db.prepare(`
          SELECT 1 AS present FROM users WHERE id = ? LIMIT 1
        `).bind(input.userId).first<{ present: number }>();
        return stillExists ? { kind: 'state_conflict' } : { kind: 'not_found' };
      }
    }
    const user = await getManagedUser({
      db: input.db,
      userId: input.userId,
      now,
    });
    if (!user) throw new TypeError('Renamed user is unavailable.');
    return { kind: 'completed', user };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'update_user_name');
  }
}

export async function updateManagedUserRole(input: {
  db: D1Database;
  userId: string;
  role: UserRole;
  nextAuthRevision: string;
  now?: Date;
}): Promise<
  | { kind: 'completed'; user: ManagedUser; revokedSessions: number }
  | { kind: 'not_found' }
  | { kind: 'last_admin' }
  | { kind: 'state_conflict' }
> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  try {
    const state = await readUserMutationState(input.db, input.userId);
    if (!state) return { kind: 'not_found' };
    const currentRole = parseSingleRole(state.roles);
    if (currentRole === input.role) {
      const user = await getManagedUser({
        db: input.db,
        userId: input.userId,
        now,
      });
      if (!user) return { kind: 'not_found' };
      return { kind: 'completed', user, revokedSessions: 0 };
    }
    if (
      state.status === 'active'
      && currentRole === 'admin'
      && input.role !== 'admin'
      && state.active_admin_count <= 1
    ) {
      return { kind: 'last_admin' };
    }
    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE users
        SET auth_revision = ?, updated_at_iso = ?
        WHERE id = ?
          AND auth_revision = ?
          AND (
            ? = 'admin'
            OR status != 'active'
            OR NOT EXISTS (
              SELECT 1 FROM user_roles current_role
              WHERE current_role.user_id = users.id
                AND current_role.role_key = 'admin'
            )
            OR EXISTS (
              SELECT 1
              FROM users other_admin
              JOIN user_roles other_role
                ON other_role.user_id = other_admin.id
              WHERE other_admin.id != users.id
                AND other_admin.status = 'active'
                AND other_role.role_key = 'admin'
            )
          )
          AND EXISTS (
            SELECT 1 FROM roles
            WHERE roles.key = ? AND roles.is_system = 1
          )
      `).bind(
        input.nextAuthRevision,
        nowIso,
        input.userId,
        state.auth_revision,
        input.role,
        input.role,
      ),
      input.db.prepare(`
        DELETE FROM user_roles
        WHERE user_id = ?
          AND EXISTS (
            SELECT 1 FROM users
            WHERE users.id = ? AND users.auth_revision = ?
          )
      `).bind(input.userId, input.userId, input.nextAuthRevision),
      input.db.prepare(`
        INSERT INTO user_roles (user_id, role_key, created_at_iso)
        SELECT users.id, roles.key, ?
        FROM users
        JOIN roles ON roles.key = ? AND roles.is_system = 1
        WHERE users.id = ? AND users.auth_revision = ?
      `).bind(
        nowIso,
        input.role,
        input.userId,
        input.nextAuthRevision,
      ),
      input.db.prepare(`
        DELETE FROM sessions
        WHERE user_id = ?
          AND EXISTS (
            SELECT 1 FROM users
            WHERE users.id = ? AND users.auth_revision = ?
          )
      `).bind(input.userId, input.userId, input.nextAuthRevision),
    ]);
    if (readChanges(results[0]) !== 1) {
      const current = await readUserMutationState(input.db, input.userId);
      if (!current) return { kind: 'not_found' };
      if (
        current.status === 'active'
        && parseSingleRole(current.roles) === 'admin'
        && input.role !== 'admin'
        && current.active_admin_count <= 1
      ) {
        return { kind: 'last_admin' };
      }
      return { kind: 'state_conflict' };
    }
    if (readChanges(results[1]) < 1 || readChanges(results[2]) !== 1) {
      throw new TypeError('D1 returned an incomplete role-change batch.');
    }
    const user = await getManagedUser({
      db: input.db,
      userId: input.userId,
      now,
    });
    if (!user) throw new TypeError('Updated user is unavailable.');
    return {
      kind: 'completed',
      user,
      revokedSessions: readChanges(results[3]),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'update_user_role');
  }
}

export async function updateManagedUserStatus(input: {
  db: D1Database;
  userId: string;
  status: 'active' | 'inactive';
  nextAuthRevision: string;
  now?: Date;
}): Promise<
  | { kind: 'completed'; user: ManagedUser; revokedSessions: number }
  | { kind: 'not_found' }
  | { kind: 'last_admin' }
  | { kind: 'setup_required' }
  | { kind: 'state_conflict' }
> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  try {
    const state = await readUserMutationState(input.db, input.userId);
    if (!state) return { kind: 'not_found' };
    const role = parseSingleRole(state.roles);
    if (state.status === input.status) {
      const user = await getManagedUser({
        db: input.db,
        userId: input.userId,
        now,
      });
      if (!user) return { kind: 'not_found' };
      return { kind: 'completed', user, revokedSessions: 0 };
    }
    if (
      input.status === 'active'
      && (
        state.status === 'pending'
        || state.factor_count !== 1
      )
    ) {
      return { kind: 'setup_required' };
    }
    if (
      input.status === 'inactive'
      && state.status === 'active'
      && role === 'admin'
      && state.active_admin_count <= 1
    ) {
      return { kind: 'last_admin' };
    }
    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE users
        SET status = ?, auth_revision = ?, updated_at_iso = ?
        WHERE id = ?
          AND auth_revision = ?
          AND status != ?
          AND (
            ? != 'active'
            OR (
              status = 'inactive'
              AND EXISTS (
                SELECT 1 FROM user_mfa_factors factor
                WHERE factor.user_id = users.id
                  AND factor.factor_type = 'totp'
              )
            )
          )
          AND (
            ? != 'inactive'
            OR status != 'active'
            OR NOT EXISTS (
              SELECT 1 FROM user_roles current_role
              WHERE current_role.user_id = users.id
                AND current_role.role_key = 'admin'
            )
            OR EXISTS (
              SELECT 1
              FROM users other_admin
              JOIN user_roles other_role
                ON other_role.user_id = other_admin.id
              WHERE other_admin.id != users.id
                AND other_admin.status = 'active'
                AND other_role.role_key = 'admin'
            )
          )
      `).bind(
        input.status,
        input.nextAuthRevision,
        nowIso,
        input.userId,
        state.auth_revision,
        input.status,
        input.status,
        input.status,
      ),
      input.db.prepare(`
        DELETE FROM sessions
        WHERE user_id = ?
          AND EXISTS (
            SELECT 1 FROM users
            WHERE users.id = ? AND users.auth_revision = ?
          )
      `).bind(input.userId, input.userId, input.nextAuthRevision),
      input.db.prepare(`
        DELETE FROM user_setup_tokens
        WHERE user_id = ?
          AND ? = 'inactive'
          AND EXISTS (
            SELECT 1 FROM users
            WHERE users.id = ?
              AND users.auth_revision = ?
              AND users.status = 'inactive'
          )
      `).bind(
        input.userId,
        input.status,
        input.userId,
        input.nextAuthRevision,
      ),
    ]);
    if (readChanges(results[0]) !== 1) {
      const current = await readUserMutationState(input.db, input.userId);
      if (!current) return { kind: 'not_found' };
      if (
        input.status === 'inactive'
        && current.status === 'active'
        && parseSingleRole(current.roles) === 'admin'
        && current.active_admin_count <= 1
      ) {
        return { kind: 'last_admin' };
      }
      return input.status === 'active'
        ? { kind: 'setup_required' }
        : { kind: 'state_conflict' };
    }
    const user = await getManagedUser({
      db: input.db,
      userId: input.userId,
      now,
    });
    if (!user) throw new TypeError('Updated user is unavailable.');
    return {
      kind: 'completed',
      user,
      revokedSessions: readChanges(results[1]),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw writeFailure(error, 'update_user_status');
  }
}

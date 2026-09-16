import type {
  AuthenticatedUser,
  CurrentSession,
  SessionListItem,
} from '../../../contracts/session';
import {
  normalizeSiteOrigin,
  normalizeSiteTitle,
} from '../../../contracts/general-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  createSessionTokenMaterial,
  deriveSessionCsrfToken,
  digestSessionSecret,
  parseSessionToken,
  timingSafeEqual,
  type SessionTokenMaterial,
} from './session-crypto';
import { prepareExpiredSessionDeletes } from './session-garbage-collector';
import type { SessionNetworkMetadata } from './session-network-metadata';

export const SESSION_IDLE_TTL_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_CONCURRENT_SESSIONS = 5;

type SessionRow = {
  id: string;
  user_id: string;
  secret_digest: string;
  session_auth_revision: string;
  ip_address: string;
  user_agent: string | null;
  asn: number | null;
  as_organization: string | null;
  country_code: string | null;
  created_at_iso: string;
  last_seen_at_iso: string;
  idle_expires_at_iso: string;
  absolute_expires_at_iso: string;
  mfa_verified_at_iso: string;
  email: string;
  name: string;
  user_status: string;
  current_auth_revision: string;
  roles: string | null;
  site_title: string | null;
  site_url: string | null;
};

type SessionListRow = {
  id: string;
  ip_address: string;
  user_agent: string | null;
  asn: number | null;
  as_organization: string | null;
  country_code: string | null;
  created_at_iso: string;
  last_seen_at_iso: string;
  idle_expires_at_iso: string;
  absolute_expires_at_iso: string;
};

export type IssuedSession = {
  cookieValue: string;
  csrfToken: string;
  session: CurrentSession;
};

export type IssueSessionResult =
  | { kind: 'issued'; value: IssuedSession }
  | { kind: 'account_changed' };

export type ResolvedSession = {
  user: AuthenticatedUser;
  session: CurrentSession;
  csrfToken: string;
  siteTitle: string;
  siteUrl: string;
  authRevision: string;
  mfaVerifiedAtIso: string;
};

export type IssueUserSession = typeof issueUserSession;
export type ResolveUserSession = typeof resolveUserSession;
export type ListUserSessions = typeof listUserSessions;
export type RevokeUserSession = typeof revokeUserSession;
export type RevokeOtherUserSessions = typeof revokeOtherUserSessions;

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

function normalizedIpAddress(value: string): string {
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 64
    ? normalized
    : 'unavailable';
}

function normalizedUserAgent(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 1024) : null;
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRoles(value: string | null): string[] {
  return value
    ? value.split(',').filter((role) => role.length > 0)
    : [];
}

async function createTokenSafely(
  createToken: () => Promise<SessionTokenMaterial>,
): Promise<SessionTokenMaterial> {
  try {
    return await createToken();
  } catch (error) {
    throw new StudioOperationalError(
      'AUTH_SESSION_CRYPTO_NOT_AVAILABLE',
      {
        cause: error,
        metadata: {
          component: 'web_crypto',
          action: 'create_session_token',
        },
      },
    );
  }
}

export async function issueUserSession(input: {
  db: D1Database;
  userId: string;
  authRevision: string;
  ipAddress: string;
  userAgent?: string;
  networkMetadata: SessionNetworkMetadata;
  now?: Date;
  createToken?: () => Promise<SessionTokenMaterial>;
}): Promise<IssueSessionResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const idleExpiresAt = new Date(now.getTime() + SESSION_IDLE_TTL_MS);
  const absoluteExpiresAt = new Date(
    now.getTime() + SESSION_ABSOLUTE_TTL_MS,
  );
  const token = await createTokenSafely(
    input.createToken ?? (() => createSessionTokenMaterial()),
  );

  let results: D1Result<unknown>[];
  try {
    results = await input.db.batch([
      ...prepareExpiredSessionDeletes(input.db, nowIso),
      input.db.prepare(`
        DELETE FROM sessions
        WHERE user_id = ?
          AND id NOT IN (
            SELECT id
            FROM sessions
            WHERE user_id = ?
            ORDER BY
              last_seen_at_iso DESC,
              created_at_iso DESC,
              id DESC
            LIMIT ?
          )
      `).bind(
        input.userId,
        input.userId,
        MAX_CONCURRENT_SESSIONS - 1,
      ),
      input.db.prepare(`
        INSERT INTO sessions (
          id,
          user_id,
          secret_digest,
          auth_revision,
          ip_address,
          user_agent,
          asn,
          as_organization,
          country_code,
          created_at_iso,
          last_seen_at_iso,
          idle_expires_at_iso,
          absolute_expires_at_iso,
          mfa_verified_at_iso
        )
        SELECT
          ?,
          users.id,
          ?,
          users.auth_revision,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          ?
        FROM users
        WHERE users.id = ?
          AND users.status = 'active'
          AND users.auth_revision = ?
      `).bind(
        token.id,
        token.secretDigest,
        normalizedIpAddress(input.ipAddress),
        normalizedUserAgent(input.userAgent),
        input.networkMetadata.asn,
        input.networkMetadata.asOrganization,
        input.networkMetadata.countryCode,
        nowIso,
        nowIso,
        idleExpiresAt.toISOString(),
        absoluteExpiresAt.toISOString(),
        nowIso,
        input.userId,
        input.authRevision,
      ),
    ]);
  } catch (error) {
    throw new StudioOperationalError(
      'AUTH_SESSION_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'issue_session',
        },
      },
    );
  }

  if (readChanges(results[3]) !== 1) {
    return { kind: 'account_changed' };
  }

  return {
    kind: 'issued',
    value: {
      cookieValue: token.cookieValue,
      csrfToken: token.csrfToken,
      session: {
        id: token.id,
        created_at_iso: nowIso,
        last_seen_at_iso: nowIso,
        idle_expires_at_iso: idleExpiresAt.toISOString(),
        absolute_expires_at_iso: absoluteExpiresAt.toISOString(),
        network: {
          ip_address: normalizedIpAddress(input.ipAddress),
          asn: input.networkMetadata.asn,
          as_organization: input.networkMetadata.asOrganization,
          country_code: input.networkMetadata.countryCode,
        },
      },
    },
  };
}

async function deleteSessionRow(input: {
  db: D1Database;
  sessionId: string;
  userId?: string;
  action: string;
}): Promise<number> {
  try {
    const statement = input.userId
      ? input.db
        .prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?')
        .bind(input.sessionId, input.userId)
      : input.db
        .prepare('DELETE FROM sessions WHERE id = ?')
        .bind(input.sessionId);
    return readChanges(await statement.run());
  } catch (error) {
    throw new StudioOperationalError(
      'AUTH_SESSION_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: input.action,
        },
      },
    );
  }
}

export async function resolveUserSession(input: {
  db: D1Database;
  cookieValue: string | undefined;
  now?: Date;
}): Promise<ResolvedSession | null> {
  const parsedToken = parseSessionToken(input.cookieValue);
  if (!parsedToken) return null;

  let suppliedDigest: string;
  let csrfToken: string;
  try {
    [suppliedDigest, csrfToken] = await Promise.all([
      digestSessionSecret(parsedToken.secret),
      deriveSessionCsrfToken(parsedToken.secret),
    ]);
  } catch (error) {
    throw new StudioOperationalError(
      'AUTH_SESSION_CRYPTO_NOT_AVAILABLE',
      {
        cause: error,
        metadata: {
          component: 'web_crypto',
          action: 'verify_session_token',
        },
      },
    );
  }

  let row: SessionRow | null;
  try {
    row = await input.db.prepare(`
      SELECT
        sessions.id,
        sessions.user_id,
        sessions.secret_digest,
        sessions.auth_revision AS session_auth_revision,
        sessions.ip_address,
        sessions.user_agent,
        sessions.asn,
        sessions.as_organization,
        sessions.country_code,
        sessions.created_at_iso,
        sessions.last_seen_at_iso,
        sessions.idle_expires_at_iso,
        sessions.absolute_expires_at_iso,
        sessions.mfa_verified_at_iso,
        users.email,
        users.name,
        users.status AS user_status,
        users.auth_revision AS current_auth_revision,
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
          SELECT value
          FROM site_settings
          WHERE key = 'site_title'
            AND type = 'string'
          LIMIT 1
        ) AS site_title,
        (
          SELECT value
          FROM site_settings
          WHERE key = 'site_url'
            AND type = 'string'
          LIMIT 1
        ) AS site_url
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ?
      LIMIT 1
    `).bind(parsedToken.id).first<SessionRow>();
  } catch (error) {
    throw new StudioOperationalError(
      'AUTH_SESSION_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'resolve_session',
        },
      },
    );
  }

  if (!row || !timingSafeEqual(row.secret_digest, suppliedDigest)) {
    return null;
  }

  const now = input.now ?? new Date();
  const nowTime = now.getTime();
  const lastSeenTime = timestamp(row.last_seen_at_iso);
  const idleExpiresTime = timestamp(row.idle_expires_at_iso);
  const absoluteExpiresTime = timestamp(row.absolute_expires_at_iso);
  const invalidAccount = row.user_status !== 'active'
    || row.session_auth_revision !== row.current_auth_revision;
  const invalidTime = lastSeenTime === null
    || idleExpiresTime === null
    || absoluteExpiresTime === null;
  const expired = invalidTime
    || nowTime >= (idleExpiresTime ?? 0)
    || nowTime >= (absoluteExpiresTime ?? 0);

  if (invalidAccount || expired) {
    await deleteSessionRow({
      db: input.db,
      sessionId: row.id,
      action: 'delete_invalid_session',
    });
    return null;
  }

  let lastSeenAtIso = row.last_seen_at_iso;
  let idleExpiresAtIso = row.idle_expires_at_iso;
  if (
    lastSeenTime !== null
    && nowTime - lastSeenTime >= SESSION_ACTIVITY_WRITE_INTERVAL_MS
  ) {
    const nextIdleExpires = new Date(Math.min(
      nowTime + SESSION_IDLE_TTL_MS,
      absoluteExpiresTime as number,
    )).toISOString();
    let updated: number;
    try {
      const result = await input.db.prepare(`
        UPDATE sessions
        SET
          last_seen_at_iso = ?,
          idle_expires_at_iso = ?
        WHERE id = ?
          AND secret_digest = ?
          AND idle_expires_at_iso > ?
          AND absolute_expires_at_iso > ?
      `).bind(
        now.toISOString(),
        nextIdleExpires,
        row.id,
        suppliedDigest,
        now.toISOString(),
        now.toISOString(),
      ).run();
      updated = readChanges(result);
    } catch (error) {
      throw new StudioOperationalError(
        'AUTH_SESSION_DATABASE_WRITE_FAILED',
        {
          cause: error,
          metadata: {
            resource: 'DB',
            action: 'update_session_activity',
          },
        },
      );
    }
    if (updated !== 1) return null;
    lastSeenAtIso = now.toISOString();
    idleExpiresAtIso = nextIdleExpires;
  }

  return {
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      roles: parseRoles(row.roles),
    },
    session: {
      id: row.id,
      created_at_iso: row.created_at_iso,
      last_seen_at_iso: lastSeenAtIso,
      idle_expires_at_iso: idleExpiresAtIso,
      absolute_expires_at_iso: row.absolute_expires_at_iso,
      network: {
        ip_address: row.ip_address,
        asn: row.asn,
        as_organization: row.as_organization,
        country_code: row.country_code,
      },
    },
    csrfToken,
    // Site presentation is non-critical to session validity. Malformed stored
    // values therefore hide their shell affordances instead of denying access
    // to the Studio account.
    siteTitle: normalizeSiteTitle(row.site_title) ?? '',
    siteUrl: normalizeSiteOrigin(row.site_url) ?? '',
    authRevision: row.current_auth_revision,
    mfaVerifiedAtIso: row.mfa_verified_at_iso,
  };
}

export async function revokeUserSession(input: {
  db: D1Database;
  userId: string;
  sessionId: string;
}): Promise<boolean> {
  return (await deleteSessionRow({
    db: input.db,
    sessionId: input.sessionId,
    userId: input.userId,
    action: 'revoke_session',
  })) > 0;
}

export async function listUserSessions(input: {
  db: D1Database;
  userId: string;
  currentSessionId: string;
  now?: Date;
}): Promise<SessionListItem[]> {
  const nowIso = (input.now ?? new Date()).toISOString();
  try {
    const result = await input.db.prepare(`
      SELECT
        id,
        ip_address,
        user_agent,
        asn,
        as_organization,
        country_code,
        created_at_iso,
        last_seen_at_iso,
        idle_expires_at_iso,
        absolute_expires_at_iso
      FROM sessions
      WHERE user_id = ?
        AND idle_expires_at_iso > ?
        AND absolute_expires_at_iso > ?
      ORDER BY
        last_seen_at_iso DESC,
        created_at_iso DESC,
        id DESC
      LIMIT ?
    `).bind(
      input.userId,
      nowIso,
      nowIso,
      MAX_CONCURRENT_SESSIONS,
    ).all<SessionListRow>();
    if (!Array.isArray(result.results)) {
      throw new TypeError('D1 returned an invalid session-list result.');
    }
    return result.results.map((row) => ({
      id: row.id,
      is_current: row.id === input.currentSessionId,
      created_at_iso: row.created_at_iso,
      last_seen_at_iso: row.last_seen_at_iso,
      idle_expires_at_iso: row.idle_expires_at_iso,
      absolute_expires_at_iso: row.absolute_expires_at_iso,
      user_agent: row.user_agent,
      network: {
        ip_address: row.ip_address,
        asn: row.asn,
        as_organization: row.as_organization,
        country_code: row.country_code,
      },
    }));
  } catch (error) {
    throw new StudioOperationalError(
      'AUTH_SESSION_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'list_sessions',
        },
      },
    );
  }
}

export async function revokeOtherUserSessions(input: {
  db: D1Database;
  userId: string;
  currentSessionId: string;
}): Promise<number> {
  try {
    return readChanges(await input.db.prepare(`
      DELETE FROM sessions
      WHERE user_id = ?
        AND id != ?
    `).bind(
      input.userId,
      input.currentSessionId,
    ).run());
  } catch (error) {
    throw new StudioOperationalError(
      'AUTH_SESSION_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'revoke_other_sessions',
        },
      },
    );
  }
}

export async function revokeAllUserSessions(input: {
  db: D1Database;
  userId: string;
}): Promise<number> {
  try {
    return readChanges(await input.db
      .prepare('DELETE FROM sessions WHERE user_id = ?')
      .bind(input.userId)
      .run());
  } catch (error) {
    throw new StudioOperationalError(
      'AUTH_SESSION_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'revoke_all_user_sessions',
        },
      },
    );
  }
}

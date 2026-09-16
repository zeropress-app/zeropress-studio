import { StudioOperationalError } from '../lib/operational-error';

const RATE_LIMITS = {
  login_account: { limit: 5, windowSeconds: 2 * 60 },
  login_ip: { limit: 20, windowSeconds: 15 * 60 },
  totp_account: { limit: 10, windowSeconds: 5 * 60 },
} as const;

export type AuthRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
};

type RateLimitInput = {
  db: D1Database;
  authSecret: string;
  now?: Date;
};

type CounterRow = { attempt_count: number; reset_at: number };
type RateLimitScope = keyof typeof RATE_LIMITS;

async function consumeRateLimits(
  input: RateLimitInput,
  subjects: { scope: RateLimitScope; subject: string }[],
  action: string,
): Promise<AuthRateLimitResult[]> {
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(input.authSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const statements = await Promise.all(subjects.map(async ({ scope, subject }) => {
      const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(JSON.stringify(['studio:auth-rate-limit:v1', scope, subject])),
      );
      const subjectHash = [...new Uint8Array(signature)]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const policy = RATE_LIMITS[scope];
      // Read this reservation's count in the write itself, never in a later query.
      return input.db.prepare(`
        INSERT INTO auth_rate_limits (scope, subject_hash, attempt_count, reset_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT (scope, subject_hash) DO UPDATE SET
          attempt_count = CASE
            WHEN reset_at <= ? THEN 1
            ELSE min(attempt_count + 1, ?)
          END,
          reset_at = CASE
            WHEN reset_at <= ? THEN excluded.reset_at
            ELSE reset_at
          END
        RETURNING attempt_count, reset_at
      `).bind(
        scope, subjectHash, nowSeconds + policy.windowSeconds,
        nowSeconds, policy.limit + 1, nowSeconds,
      );
    }));
    const results = await input.db.batch<CounterRow>(statements);
    return subjects.map(({ scope }, index) => {
      const row = results[index]?.results?.[0];
      if (
        !results[index]?.success
        || !row
        || !Number.isSafeInteger(row.attempt_count)
        || row.attempt_count < 1
        || !Number.isSafeInteger(row.reset_at)
        || row.reset_at <= nowSeconds
      ) {
        throw new Error('Authentication rate-limit storage returned an invalid counter.');
      }
      const { limit } = RATE_LIMITS[scope];
      const allowed = row.attempt_count <= limit;
      return {
        allowed,
        limit,
        remaining: Math.max(0, limit - row.attempt_count),
        resetAt: row.reset_at,
        retryAfter: allowed ? undefined : Math.max(1, row.reset_at - nowSeconds),
      };
    });
  } catch (error) {
    throw new StudioOperationalError('AUTH_RATE_LIMIT_STORE_NOT_AVAILABLE', {
      cause: error,
      metadata: { resource: 'DB', action },
    });
  }
}

export async function consumeLoginRateLimits(
  input: RateLimitInput & { email: string; ip: string },
): Promise<AuthRateLimitResult> {
  const results = await consumeRateLimits(input, [
    { scope: 'login_account', subject: input.email.trim().toLowerCase() },
    { scope: 'login_ip', subject: input.ip },
  ], 'consume_login_rate_limit');
  const denied = results.filter((result) => !result.allowed);
  if (denied.length > 0) {
    return denied.reduce((latest, result) => (
      result.resetAt > latest.resetAt ? result : latest
    ));
  }
  return results.reduce((tightest, result) => (
    result.remaining < tightest.remaining ? result : tightest
  ));
}

export async function consumePasskeySignInRateLimit(
  input: RateLimitInput & { ip: string },
): Promise<AuthRateLimitResult> {
  const [result] = await consumeRateLimits(input, [
    { scope: 'login_ip', subject: input.ip },
  ], 'consume_passkey_sign_in_rate_limit');
  return result;
}

export async function consumeTotpRateLimit(
  input: RateLimitInput & { userId: string },
): Promise<AuthRateLimitResult> {
  const [result] = await consumeRateLimits(input, [
    { scope: 'totp_account', subject: input.userId },
  ], 'consume_totp_rate_limit');
  return result;
}

export async function garbageCollectExpiredAuthRateLimits(input: {
  db: D1Database;
  now?: Date;
}): Promise<{ deletedRows: number }> {
  try {
    const result = await input.db.prepare(`
      DELETE FROM auth_rate_limits WHERE reset_at <= ?
    `).bind(Math.floor((input.now ?? new Date()).getTime() / 1000)).run();
    return { deletedRows: result.meta.changes };
  } catch (error) {
    throw new StudioOperationalError('AUTH_RATE_LIMIT_STORE_NOT_AVAILABLE', {
      cause: error,
      metadata: { resource: 'DB', action: 'garbage_collect_auth_rate_limits' },
    });
  }
}

import { describe, expect, it } from 'vitest';
import { createAuthDatabase } from '../test-helpers/auth-database';
import {
  consumeLoginRateLimits,
  consumePasskeySignInRateLimit,
  consumeTotpRateLimit,
  garbageCollectExpiredAuthRateLimits,
} from './login-rate-limit';

const authSecret = 'test-auth-secret-value-with-at-least-32-characters';
const now = new Date('2026-07-23T00:00:00.000Z');
const login = { authSecret, email: 'admin@example.com', ip: '192.0.2.10', now };

describe('atomic authentication rate limits', () => {
  it('allows only five of twenty simultaneous account attempts across IPs', async () => {
    const { db, sqlite } = createAuthDatabase();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      consumeLoginRateLimits({ ...login, db, ip: `192.0.2.${index}` })
    )));
    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    expect(results.filter((result) => !result.allowed)).toHaveLength(15);
    const rows = sqlite.prepare('SELECT * FROM auth_rate_limits').all();
    expect(rows.filter((row) => row.scope === 'login_account')).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(login.email);
    expect(JSON.stringify(rows)).not.toContain('192.0.2.');
    expect(rows.every((row) => /^[a-f0-9]{64}$/u.test(String(row.subject_hash)))).toBe(true);
  });

  it('normalizes email and limits unknown accounts without a users lookup', async () => {
    const { db } = createAuthDatabase();
    for (let index = 0; index < 5; index += 1) {
      expect((await consumeLoginRateLimits({ ...login, db })).allowed).toBe(true);
    }
    expect(await consumeLoginRateLimits({ ...login, db, email: ' ADMIN@EXAMPLE.COM ' }))
      .toMatchObject({ allowed: false, limit: 5, remaining: 0, retryAfter: 120 });
  });

  it('does not extend a denied window and reopens exactly at expiry', async () => {
    const { db } = createAuthDatabase();
    await Promise.all(Array.from({ length: 5 }, () => consumeLoginRateLimits({ ...login, db })));
    const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);
    expect(await consumeLoginRateLimits({ ...login, db, now: later(119) }))
      .toMatchObject({ allowed: false, retryAfter: 1 });
    expect(await consumeLoginRateLimits({ ...login, db, now: later(120) }))
      .toMatchObject({ allowed: true, remaining: 4 });
  });

  it('shares the IP budget between password and passkey sign-in', async () => {
    const { db } = createAuthDatabase();
    const results = await Promise.all(Array.from({ length: 20 }, () => (
      consumePasskeySignInRateLimit({ ...login, db })
    )));
    expect(results.every((result) => result.allowed)).toBe(true);
    expect(await consumeLoginRateLimits({ ...login, db }))
      .toMatchObject({ allowed: false, limit: 20, retryAfter: 900 });
    expect(await consumePasskeySignInRateLimit({ ...login, db, ip: '192.0.2.99' }))
      .toMatchObject({ allowed: true });
  });

  it('reports the latest reset when both budgets are exhausted', async () => {
    const { db } = createAuthDatabase();
    for (let index = 0; index < 20; index += 1) {
      await consumeLoginRateLimits({ ...login, db });
    }
    expect(await consumeLoginRateLimits({ ...login, db }))
      .toMatchObject({ allowed: false, limit: 20, retryAfter: 900 });
  });

  it('rolls back both reservations when one statement fails', async () => {
    const { db, sqlite } = createAuthDatabase();
    sqlite.exec(`CREATE TRIGGER fail_ip BEFORE INSERT ON auth_rate_limits
      WHEN NEW.scope = 'login_ip' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    await expect(consumeLoginRateLimits({ ...login, db })).rejects.toMatchObject({
      code: 'AUTH_RATE_LIMIT_STORE_NOT_AVAILABLE',
    });
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_rate_limits').get()?.n).toBe(0);
  });

  it('fails closed for missing storage or an invalid write response', async () => {
    const { db, sqlite } = createAuthDatabase();
    sqlite.exec('DROP TABLE auth_rate_limits');
    await expect(consumeLoginRateLimits({ ...login, db })).rejects.toMatchObject({
      code: 'AUTH_RATE_LIMIT_STORE_NOT_AVAILABLE',
    });
    await expect(consumeLoginRateLimits({
      ...login, db: { batch: async () => [], prepare: db.prepare } as unknown as D1Database,
    })).rejects.toMatchObject({ code: 'AUTH_RATE_LIMIT_STORE_NOT_AVAILABLE' });
  });

  it('isolates TOTP accounts and retains active counters during cleanup', async () => {
    const { db, sqlite } = createAuthDatabase();
    for (let index = 0; index < 10; index += 1) {
      expect((await consumeTotpRateLimit({ db, authSecret, userId: 'account-1', now })).allowed).toBe(true);
    }
    expect((await consumeTotpRateLimit({ db, authSecret, userId: 'account-1', now })).allowed).toBe(false);
    expect((await consumeTotpRateLimit({ db, authSecret, userId: 'account-2', now })).allowed).toBe(true);
    await consumeLoginRateLimits({ ...login, db });
    expect(await garbageCollectExpiredAuthRateLimits({ db, now: new Date(now.getTime() + 300_000) }))
      .toEqual({ deletedRows: 3 });
    expect(sqlite.prepare('SELECT scope FROM auth_rate_limits').all())
      .toEqual([{ scope: 'login_ip' }]);
    expect((await consumeTotpRateLimit({ db, authSecret, userId: 'account-1', now: new Date(now.getTime() + 300_000) })).allowed).toBe(true);
  });
});

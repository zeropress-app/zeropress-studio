import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthDatabase } from '../test-helpers/auth-database';
import { createAuthRoutes } from './routes';
import { createMfaManagementRoutes } from './mfa-management-routes';
import { verifyUserTotp } from './mfa-repository';
import * as mfaCrypto from './mfa-crypto';
import type { Env } from '../types';
import { createApp } from '../index';

const authSecret = 'test-auth-secret-value-with-at-least-32-characters';
const userId = '1'.repeat(32);
const authRevision = '2'.repeat(32);
const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const now = new Date('2026-09-16T12:00:00Z');
const csrfToken = 'c'.repeat(43);

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function setup() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  const { db, sqlite } = createAuthDatabase();
  sqlite.prepare("INSERT INTO zeropress_schema_state (id, schema_version, lifecycle_state, updated_at_iso) VALUES (1, 1, 'ready', ?)")
    .run(now.toISOString());
  const encrypted = await mfaCrypto.encryptTotpSecret(authSecret, totpSecret);
  sqlite.prepare(`INSERT INTO users
    (id, email, password_hash, auth_revision, name, created_at_iso, updated_at_iso)
    VALUES (?, 'owner@example.com', 'password-hash', ?, 'Owner', ?, ?)`)
    .run(userId, authRevision, now.toISOString(), now.toISOString());
  sqlite.prepare(`INSERT INTO user_mfa_factors
    (id, user_id, factor_type, secret_ciphertext, secret_iv, last_used_step, created_at_iso, verified_at_iso)
    VALUES (?, ?, 'totp', ?, ?, -1, ?, ?)`)
    .run('3'.repeat(32), userId, encrypted.ciphertext, encrypted.iv, now.toISOString(), now.toISOString());
  const environment: Env = {
    DB: db, KV: { get: vi.fn(), put: vi.fn() } as unknown as KVNamespace,
    STUDIO_SITE_MODE: 'operational', STUDIO_AUTH_SECRET: authSecret,
    AUTH_ROUTE_RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
  };
  const continuation = () => mfaCrypto.createMfaContinuation({
    authSecret, userId, authRevision, purpose: 'verify',
  });
  const validCodes = await Promise.all([-30_000, 0, 30_000].map((offset) => (
    mfaCrypto.createTotpCode({ secret: totpSecret, now: new Date(now.getTime() + offset) })
  )));
  const wrongCode = ['000000', '000001', '000002', '000003'].find((code) => !validCodes.includes(code))!;
  return { db, sqlite, environment, continuation, wrongCode };
}

function request(path: string, body: unknown, ip = '192.0.2.1') {
  return new Request(`https://studio.local${path}`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json', 'CF-Connecting-IP': ip,
      Origin: 'https://studio.local', Cookie: '__Host-zp_session=opaque',
      'X-ZeroPress-CSRF': csrfToken,
    }, body: JSON.stringify(body),
  });
}

describe('authentication budgets across real routes and SQLite', () => {
  it('admits only five concurrent password verifications without using KV', async () => {
    const { environment } = await setup();
    const authenticator = vi.fn().mockResolvedValue({ kind: 'invalid_credentials' });
    const routes = createAuthRoutes({ authenticator });
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => routes.fetch(
      request('/login', { email: 'unknown@example.com', password: 'wrong password' }, `192.0.2.${index}`),
      environment,
    )));
    expect(authenticator).toHaveBeenCalledTimes(5);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(15);
    expect(environment.KV.get).not.toHaveBeenCalled();
    expect(environment.KV.put).not.toHaveBeenCalled();
  });

  it('allows ten TOTP evaluations across 120 requests, twelve IPs, and fresh tokens', async () => {
    const { environment, continuation, wrongCode } = await setup();
    const tokens = await Promise.all(Array.from({ length: 12 }, continuation));
    const verifyCode = vi.spyOn(mfaCrypto, 'verifyTotpCode');
    const issueSession = vi.fn();
    const routes = createAuthRoutes({ issueSession });
    const responses = await Promise.all(Array.from({ length: 120 }, (_, index) => routes.fetch(
      request('/mfa/verify', {
        method: 'totp', continuation_token: tokens[index % 12].token, code: wrongCode,
      }, `192.0.2.${index % 12}`), environment,
    )));
    expect(verifyCode).toHaveBeenCalledTimes(10);
    expect(responses.filter((response) => response.status === 401)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(110);
    const retry = await routes.fetch(request('/mfa/verify', {
      method: 'totp', continuation_token: (await continuation()).token,
      code: await mfaCrypto.createTotpCode({ secret: totpSecret, now }),
    }), environment);
    expect(retry.status).toBe(429);
    expect(retry.headers.get('Retry-After')).toBe('300');
    expect(retry.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(verifyCode).toHaveBeenCalledTimes(10);
    expect(issueSession).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(now.getTime() + 300_000));
    const reopened = await routes.fetch(request('/mfa/verify', {
      method: 'totp', continuation_token: (await continuation()).token, code: wrongCode,
    }), environment);
    expect(reopened.status).toBe(401);
    expect(verifyCode).toHaveBeenCalledTimes(11);
  });

  it('shares the TOTP account budget with protected account changes', async () => {
    const { environment, continuation, wrongCode } = await setup();
    const routes = createAuthRoutes();
    const token = (await continuation()).token;
    for (let index = 0; index < 9; index += 1) {
      expect((await routes.fetch(request('/mfa/verify', {
        method: 'totp', continuation_token: token, code: wrongCode,
      }), environment)).status).toBe(401);
    }
    const management = createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        user: { id: userId, email: 'owner@example.com', name: 'Owner', roles: ['admin'] },
        session: { id: '4'.repeat(32) }, authRevision, csrfToken,
        mfaVerifiedAtIso: new Date(now.getTime() - 600_000).toISOString(),
      }),
      verifyPassword: vi.fn().mockResolvedValue(true),
    });
    const body = { operation: 'replace_totp', password: 'current password', verification: { method: 'totp', code: wrongCode } };
    expect((await management.fetch(request('/authorize', body), environment)).status).toBe(401);
    const denied = await management.fetch(request('/authorize', body), environment);
    expect(denied.status).toBe(429);
    expect(denied.headers.get('Retry-After')).toBe('300');
    expect((await routes.fetch(request('/mfa/verify', { method: 'totp', continuation_token: token, code: wrongCode }), environment)).status).toBe(429);
  });

  it('does not spend a budget for invalid requests, tokens, or account revisions', async () => {
    const { environment, sqlite, continuation, wrongCode, db } = await setup();
    const routes = createAuthRoutes();
    expect((await routes.fetch(request('/mfa/verify', { code: wrongCode }), environment)).status).toBe(400);
    const expired = await mfaCrypto.createMfaContinuation({
      authSecret, userId, authRevision, purpose: 'verify', now: new Date(now.getTime() - 300_000),
    });
    for (const token of ['x'.repeat(32), expired.token]) {
      expect((await routes.fetch(request('/mfa/verify', { method: 'totp', continuation_token: token, code: wrongCode }), environment)).status).toBe(401);
    }
    const oldToken = await continuation();
    sqlite.prepare('UPDATE users SET auth_revision = ?').run('9'.repeat(32));
    expect((await routes.fetch(request('/mfa/verify', { method: 'totp', continuation_token: oldToken.token, code: wrongCode }), environment)).status).toBe(401);
    expect(await verifyUserTotp({ db, authSecret, userId: '8'.repeat(32), authRevision, code: wrongCode }))
      .toEqual({ status: 'invalid' });
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_rate_limits').get()?.n).toBe(0);
  });

  it.each(['totp', 'passkey'] as const)('returns 503 before %s verification when counter storage fails', async (method) => {
    const { environment, continuation } = await setup();
    const token = await continuation();
    environment.DB.batch = vi.fn().mockRejectedValue(new Error('D1 unavailable'));
    const verifyCode = vi.spyOn(mfaCrypto, 'verifyTotpCode');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const path = method === 'totp' ? '/api/auth/mfa/verify' : '/api/auth/passkey/options';
    const body = method === 'totp'
      ? { method: 'totp', continuation_token: token.token, code: '000000' }
      : {};
    const response = await createApp().fetch(request(path, body), environment);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ success: false, error: { code: 'SYSTEM_NOT_AVAILABLE' } });
    expect(verifyCode).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      $zeropress: expect.objectContaining({ code: 'AUTH_RATE_LIMIT_STORE_NOT_AVAILABLE', resource: 'DB' }),
    }));
  });

  it('counts success and replay, preserves the budget across revision changes, and accepts one concurrent replay', async () => {
    const { db, sqlite } = await setup();
    const code = await mfaCrypto.createTotpCode({ secret: totpSecret, now });
    const results = await Promise.all(Array.from({ length: 10 }, () => verifyUserTotp({
      db, authSecret, userId, authRevision, code, now,
    })));
    expect(results.filter((result) => result.status === 'verified')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'invalid')).toHaveLength(9);
    sqlite.prepare('UPDATE users SET auth_revision = ?').run('9'.repeat(32));
    expect(await verifyUserTotp({ db, authSecret, userId, authRevision: '9'.repeat(32), code, now }))
      .toMatchObject({ status: 'rate_limited' });
  });
});

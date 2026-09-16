import { withAuthRateLimits } from '../test-helpers/auth-database';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import {
  createMfaContinuation,
  createTotpCode,
  encryptTotpSecret,
} from './mfa-crypto';
import { createAuthRoutes } from './routes';

const authSecret = 'test-auth-secret-value-with-at-least-32-characters';
const userId = '0123456789abcdef0123456789abcdef';
const authRevision = 'fedcba9876543210fedcba9876543210';
const factorId = '00112233445566778899aabbccddeeff';
const sessionId = 'ffeeddccbbaa99887766554433221100';
const otherSessionId = '00112233445566778899aabbccddeeff';

function successfulSessionIssuer() {
  return vi.fn().mockResolvedValue({
    kind: 'issued',
    value: {
      cookieValue: `s1.${sessionId}.${'s'.repeat(43)}`,
      csrfToken: 'c'.repeat(43),
      session: {
        id: sessionId,
        created_at_iso: '2026-07-31T00:00:00.000Z',
        last_seen_at_iso: '2026-07-31T00:00:00.000Z',
        idle_expires_at_iso: '2026-07-31T12:00:00.000Z',
        absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
        network: {
          ip_address: '127.0.0.1',
          asn: null,
          as_organization: null,
          country_code: null,
        },
      },
    },
  });
}

function env(
  database: D1Database,
  kv: KVNamespace = {} as KVNamespace,
): Env {
  return {
    DB: withAuthRateLimits(database),
    KV: kv,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    STUDIO_SITE_MODE: 'operational',
    STUDIO_AUTH_SECRET: authSecret,
  };
}

function jsonRequest(path: string, body: unknown) {
  return new Request(`http://studio.local${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function dynamicStatement(input: {
  first?: (params: unknown[]) => unknown;
  run?: (params: unknown[]) => unknown;
}) {
  let params: unknown[] = [];
  return {
    bind(...nextParams: unknown[]) {
      params = nextParams;
      return this;
    },
    async first() {
      return input.first?.(params) ?? null;
    },
    async run() {
      return input.run?.(params) ?? {
        success: true,
        meta: { changes: 0 },
      };
    },
  };
}

describe('MFA authentication routes', () => {
  it('offers current-host WebAuthn after password verification', async () => {
    const authenticator = vi.fn().mockResolvedValue({
      kind: 'success',
      status: 'mfa_required',
      userId,
      authRevision,
    });
    const listWebAuthnCredentials = vi.fn().mockResolvedValue([
      { id: 'credential', transports: ['internal'] },
    ]);
    const response = await createAuthRoutes({
      authenticator,
      listWebAuthnCredentials,
    }).fetch(
      new Request('https://studio.example.com/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'owner@example.com',
          password: 'current password',
        }),
      }),
      env({} as D1Database),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        status: 'mfa_required',
        available_methods: ['webauthn', 'totp'],
        preferred_method: 'webauthn',
      },
    });
    expect(listWebAuthnCredentials).toHaveBeenCalledWith({
      db: expect.anything(),
      userId,
      authRevision,
      rpId: 'studio.example.com',
    });
  });

  it('verifies a TOTP once through the sealed password continuation', async () => {
    const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const encrypted = await encryptTotpSecret(authSecret, secret);
    const code = await createTotpCode({ secret });
    const continuation = await createMfaContinuation({
      authSecret,
      userId,
      authRevision,
      purpose: 'verify',
    });
    let lastUsedStep = -1;
    const database = {
      prepare(sql: string) {
        if (sql.includes('FROM user_mfa_factors f')) {
          return dynamicStatement({
            first: () => ({
              id: factorId,
              secret_ciphertext: encrypted.ciphertext,
              secret_iv: encrypted.iv,
              last_used_step: lastUsedStep,
            }),
          });
        }
        if (sql.includes('UPDATE user_mfa_factors')) {
          return dynamicStatement({
            run: (params) => {
              const nextStep = Number(params[0]);
              const changed = params[4] === authRevision
                && lastUsedStep < nextStep;
              if (changed) lastUsedStep = nextStep;
              return {
                success: true,
                meta: { changes: changed ? 1 : 0 },
              };
            },
          });
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as D1Database;
    const environment = env(database);
    const issueSession = successfulSessionIssuer();
    const auth = createAuthRoutes({ issueSession });
    const request = () => {
      const value = jsonRequest('/mfa/verify', {
        continuation_token: continuation.token,
        method: 'totp',
        code,
      });
      Object.defineProperty(value, 'cf', {
        value: {
          asn: 13335,
          asOrganization: 'Cloudflare, Inc.',
          country: 'KR',
        },
      });
      return value;
    };

    const firstResponse = await auth.fetch(request(), environment);
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'authenticated',
      },
    });
    expect(firstResponse.headers.get('Set-Cookie')).toContain(
      '__Host-zp_session=',
    );
    expect(firstResponse.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(firstResponse.headers.get('Set-Cookie')).toContain('Secure');
    expect(firstResponse.headers.get('Set-Cookie')).toContain(
      'SameSite=Strict',
    );
    expect(firstResponse.headers.get('Set-Cookie')).toContain('Path=/');
    expect(firstResponse.headers.get('Set-Cookie')).toContain(
      'Max-Age=604800',
    );
    expect(firstResponse.headers.get('Set-Cookie')).not.toContain('Domain=');
    expect(issueSession).toHaveBeenCalledWith(expect.objectContaining({
      db: withAuthRateLimits(database),
      userId,
      authRevision,
      ipAddress: '127.0.0.1',
      networkMetadata: {
        asn: 13335,
        asOrganization: 'Cloudflare, Inc.',
        countryCode: 'KR',
      },
    }));

    const replayResponse = await auth.fetch(request(), environment);
    expect(replayResponse.status).toBe(401);
    await expect(replayResponse.json()).resolves.toEqual({
      success: false,
      error: { code: 'INVALID_MFA_CODE' },
    });
  });

  it('forces and atomically completes enrollment for a factorless account', async () => {
    let configured = false;
    let enrollmentWrites = 0;
    const database = {
      prepare(sql: string) {
        if (sql.includes('factor_count')) {
          return dynamicStatement({
            first: () => ({
              email: 'owner@example.com',
              factor_count: configured ? 1 : 0,
            }),
          });
        }
        if (sql.includes('INSERT INTO user_mfa_factors')) {
          return dynamicStatement({
            run: () => {
              enrollmentWrites += 1;
              const factorChanged = !configured;
              configured = true;
              return {
                success: true,
                meta: { changes: factorChanged ? 1 : 0 },
              };
            },
          });
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as D1Database;
    const environment = env(database);
    const continuation = await createMfaContinuation({
      authSecret,
      userId,
      authRevision,
      purpose: 'enroll',
    });
    const issueSession = successfulSessionIssuer();
    const auth = createAuthRoutes({ issueSession });

    const setupResponse = await auth.fetch(
      jsonRequest('/mfa/enrollment/setup', {
        continuation_token: continuation.token,
      }),
      environment,
    );
    expect(setupResponse.status).toBe(200);
    const setupBody = await setupResponse.json() as {
      success: true;
      data: {
        secret: string;
        enrollment_token: string;
      };
    };
    const totpCode = await createTotpCode({
      secret: setupBody.data.secret,
    });
    const completionRequest = () =>
      jsonRequest('/mfa/enrollment/complete', {
        continuation_token: continuation.token,
        mfa: {
          enrollment_token: setupBody.data.enrollment_token,
          totp_code: totpCode,
        },
      });

    const completionResponse = await auth.fetch(
      completionRequest(),
      environment,
    );
    expect(completionResponse.status).toBe(200);
    await expect(completionResponse.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'authenticated',
      },
    });
    expect(enrollmentWrites).toBe(1);
    expect(issueSession).toHaveBeenCalledOnce();

    const duplicateResponse = await auth.fetch(
      completionRequest(),
      environment,
    );
    expect(duplicateResponse.status).toBe(409);
    await expect(duplicateResponse.json()).resolves.toEqual({
      success: false,
      error: { code: 'MFA_ALREADY_CONFIGURED' },
    });
    expect(enrollmentWrites).toBe(2);
  });

  it('rejects a continuation issued for the wrong MFA purpose', async () => {
    const continuation = await createMfaContinuation({
      authSecret,
      userId,
      authRevision,
      purpose: 'enroll',
    });
    const auth = createAuthRoutes();
    const response = await auth.fetch(
      jsonRequest('/mfa/verify', {
        continuation_token: continuation.token,
        method: 'totp',
        code: '123456',
      }),
      env({} as D1Database),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'MFA_CHALLENGE_INVALID' },
    });
  });
});

describe('authenticated session routes', () => {
  const resolvedSession = {
    user: {
      id: userId,
      email: 'owner@example.com',
      name: 'Studio Owner',
      roles: ['admin'],
    },
    session: {
      id: sessionId,
      created_at_iso: '2026-07-31T00:00:00.000Z',
      last_seen_at_iso: '2026-07-31T00:05:00.000Z',
      idle_expires_at_iso: '2026-07-31T12:05:00.000Z',
      absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
      network: {
        ip_address: '203.0.113.10',
        asn: 13335,
        as_organization: 'Cloudflare, Inc.',
        country_code: 'US',
      },
    },
    csrfToken: 'c'.repeat(43),
    siteTitle: 'Editorial Magazine',
    siteUrl: 'https://example.com',
    authRevision,
    mfaVerifiedAtIso: '2026-07-31T00:00:00.000Z',
  };

  it('returns the current user and session without exposing token material', async () => {
    const resolveSession = vi.fn().mockResolvedValue(resolvedSession);
    const readAccountAvatar = vi.fn().mockResolvedValue(
      'https://media.example.com/authors/owner.png',
    );
    const response = await createAuthRoutes({
      resolveSession,
      readAccountAvatar,
      readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
      inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
        state: 'ready', reason: 'ready', currentSchemaVersion: 3,
      }),
    }).fetch(
      new Request('http://studio.local/session', {
        headers: {
          Cookie: `__Host-zp_session=s1.${sessionId}.${'s'.repeat(43)}`,
        },
      }),
      env({} as D1Database),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        user: {
          ...resolvedSession.user,
          avatar_preview_url: 'https://media.example.com/authors/owner.png',
        },
        session: resolvedSession.session,
        csrf_token: resolvedSession.csrfToken,
        edge_integration: { mode: 'enabled', database_state: 'ready' },
        site_title: resolvedSession.siteTitle,
        site_url: resolvedSession.siteUrl,
      },
    });
    expect(resolveSession).toHaveBeenCalledWith({
      db: expect.anything(),
      cookieValue: `s1.${sessionId}.${'s'.repeat(43)}`,
    });
    expect(readAccountAvatar).toHaveBeenCalledWith({
      db: expect.anything(),
      userId,
    });
  });

  it('clears an invalid session cookie and returns a stable anonymous state', async () => {
    const response = await createAuthRoutes({
      resolveSession: vi.fn().mockResolvedValue(null),
    }).fetch(
      new Request('http://studio.local/session'),
      env({} as D1Database),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(response.headers.get('Set-Cookie')).toContain(
      '__Host-zp_session=;',
    );
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('lists only the authenticated user sessions with a current marker', async () => {
    const resolveSession = vi.fn().mockResolvedValue(resolvedSession);
    const items = [{
      id: sessionId,
      is_current: true,
      created_at_iso: '2026-07-31T00:00:00.000Z',
      last_seen_at_iso: '2026-07-31T00:05:00.000Z',
      idle_expires_at_iso: '2026-07-31T12:05:00.000Z',
      absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
      user_agent: 'Current Browser',
      network: resolvedSession.session.network,
    }];
    const listSessions = vi.fn().mockResolvedValue(items);
    const response = await createAuthRoutes({
      resolveSession,
      listSessions,
    }).fetch(
      new Request('http://studio.local/sessions', {
        headers: {
          Cookie: `__Host-zp_session=s1.${sessionId}.${'s'.repeat(43)}`,
        },
      }),
      env({} as D1Database),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        items,
        max_sessions: 5,
      },
    });
    expect(listSessions).toHaveBeenCalledWith({
      db: expect.anything(),
      userId,
      currentSessionId: sessionId,
    });
  });

  it('revokes a selected session through a static, same-origin CSRF route', async () => {
    const resolveSession = vi.fn().mockResolvedValue(resolvedSession);
    const revokeSession = vi.fn().mockResolvedValue(true);
    const auth = createAuthRoutes({ resolveSession, revokeSession });
    const request = (
      targetSessionId: string,
      csrfToken = resolvedSession.csrfToken,
      origin = 'http://studio.local',
    ) => new Request('http://studio.local/sessions/revoke', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `__Host-zp_session=s1.${sessionId}.${'s'.repeat(43)}`,
        Origin: origin,
        'X-ZeroPress-CSRF': csrfToken,
      },
      body: JSON.stringify({ session_id: targetSessionId }),
    });

    expect((await auth.fetch(
      request(otherSessionId, resolvedSession.csrfToken, 'https://attacker.example'),
      env({} as D1Database),
    )).status).toBe(403);
    expect(resolveSession).not.toHaveBeenCalled();

    const otherResponse = await auth.fetch(
      request(otherSessionId),
      env({} as D1Database),
    );
    expect(otherResponse.status).toBe(200);
    await expect(otherResponse.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'session_revoked',
        revoked: true,
        current_session_ended: false,
      },
    });
    expect(revokeSession).toHaveBeenLastCalledWith({
      db: expect.anything(),
      userId,
      sessionId: otherSessionId,
    });
    expect(otherResponse.headers.get('Set-Cookie')).toBeNull();

    const currentResponse = await auth.fetch(
      request(sessionId),
      env({} as D1Database),
    );
    await expect(currentResponse.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'session_revoked',
        revoked: true,
        current_session_ended: true,
      },
    });
    expect(currentResponse.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('revokes all other sessions without ending the current session', async () => {
    const resolveSession = vi.fn().mockResolvedValue(resolvedSession);
    const revokeOtherSessions = vi.fn().mockResolvedValue(3);
    const auth = createAuthRoutes({
      resolveSession,
      revokeOtherSessions,
    });
    const request = (csrfToken?: string) =>
      new Request('http://studio.local/sessions/revoke-others', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `__Host-zp_session=s1.${sessionId}.${'s'.repeat(43)}`,
          Origin: 'http://studio.local',
          ...(csrfToken ? { 'X-ZeroPress-CSRF': csrfToken } : {}),
        },
        body: '{}',
      });

    expect((await auth.fetch(
      request(),
      env({} as D1Database),
    )).status).toBe(403);
    expect(revokeOtherSessions).not.toHaveBeenCalled();

    const response = await auth.fetch(
      request(resolvedSession.csrfToken),
      env({} as D1Database),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'other_sessions_revoked',
        revoked_count: 3,
      },
    });
    expect(revokeOtherSessions).toHaveBeenCalledWith({
      db: expect.anything(),
      userId,
      currentSessionId: sessionId,
    });
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('requires same-origin CSRF proof before revoking the current session', async () => {
    const resolveSession = vi.fn().mockResolvedValue(resolvedSession);
    const revokeSession = vi.fn().mockResolvedValue(true);
    const auth = createAuthRoutes({ resolveSession, revokeSession });
    const request = (csrfToken?: string, origin = 'http://studio.local') =>
      new Request('http://studio.local/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `__Host-zp_session=s1.${sessionId}.${'s'.repeat(43)}`,
          Origin: origin,
          ...(csrfToken ? { 'X-ZeroPress-CSRF': csrfToken } : {}),
        },
        body: '{}',
      });

    expect((await auth.fetch(
      request(undefined),
      env({} as D1Database),
    )).status).toBe(403);
    expect((await auth.fetch(
      request(resolvedSession.csrfToken, 'https://attacker.example'),
      env({} as D1Database),
    )).status).toBe(403);
    expect(revokeSession).not.toHaveBeenCalled();

    const response = await auth.fetch(
      request(resolvedSession.csrfToken),
      env({} as D1Database),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: 'logged_out' },
    });
    expect(revokeSession).toHaveBeenCalledWith({
      db: expect.anything(),
      userId,
      sessionId,
    });
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('makes logout idempotent after a session has already expired', async () => {
    const revokeSession = vi.fn();
    const response = await createAuthRoutes({
      resolveSession: vi.fn().mockResolvedValue(null),
      revokeSession,
    }).fetch(
      new Request('http://studio.local/logout', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://studio.local',
        },
        body: '{}',
      }),
      env({} as D1Database),
    );

    expect(response.status).toBe(200);
    expect(revokeSession).not.toHaveBeenCalled();
  });
});

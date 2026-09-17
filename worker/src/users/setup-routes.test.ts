import { describe, expect, it, vi } from 'vitest';
import { createTotpCode } from '../auth/mfa-crypto';
import type { Env } from '../types';
import {
  createUserSetupToken,
  parseUserSetupToken,
} from './setup-token-crypto';
import { createAccountSetupRoutes } from './setup-routes';

const now = new Date('2026-07-31T12:00:00.000Z');
const authSecret = 'test-auth-secret-value-with-at-least-32-characters';

function env(): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    STUDIO_AUTH_SECRET: authSecret,
  };
}

function request(path: string, body: unknown) {
  return new Request(`https://studio.local${path}`, {
    method: 'POST',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.10',
    },
    body: JSON.stringify(body),
  });
}

describe('User account setup routes', () => {
  it('keeps invalid or expired setup tokens generic and silent', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const material = await createUserSetupToken();
    const routes = createAccountSetupRoutes({
      getSetup: vi.fn().mockResolvedValue(null),
      now: () => now,
    });

    const response = await routes.fetch(request('/inspect', {
      setup_token: material.token,
    }), env());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'USER_SETUP_TOKEN_INVALID' },
    });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('activates only after password preparation, TOTP, and recovery confirmation', async () => {
    const material = await createUserSetupToken();
    const parsedToken = await parseUserSetupToken(material.token);
    expect(parsedToken).not.toBeNull();
    const setupAccount = {
      id: material.id,
      userId: '1'.repeat(32),
      authRevision: '2'.repeat(32),
      purpose: 'credential_recovery' as const,
      email: 'author@example.com',
      name: 'Site Author',
      role: 'author' as const,
      expiresAtIso: '2026-08-01T12:00:00.000Z',
    };
    const getSetup = vi.fn().mockResolvedValue(setupAccount);
    const prepareSetup = vi.fn().mockResolvedValue(setupAccount);
    const completeSetup = vi.fn().mockResolvedValue('completed');
    const routes = createAccountSetupRoutes({
      hashPassword: vi.fn().mockResolvedValue('$argon2id$activated'),
      getSetup,
      prepareSetup,
      completeSetup,
      createSecurityRevision: () => '3'.repeat(32),
      now: () => now,
    });

    const inspectResponse = await routes.fetch(request('/inspect', {
      setup_token: material.token,
    }), env());
    expect(inspectResponse.status).toBe(200);
    await expect(inspectResponse.json()).resolves.toMatchObject({
      success: true,
      data: { purpose: 'credential_recovery' },
    });

    const setupResponse = await routes.fetch(request('/setup', {
      setup_token: material.token,
      password: 'harbor lantern canyon marble circuit',
    }), env());
    expect(setupResponse.status).toBe(200);
    const setup = await setupResponse.json() as {
      success: true;
      data: {
        secret: string;
        enrollment_token: string;
      };
    };
    expect(prepareSetup).toHaveBeenCalledWith(expect.objectContaining({
      setupTokenId: material.id,
      secretDigest: parsedToken?.secretDigest,
      pendingPasswordHash: '$argon2id$activated',
      setupNonce: '3'.repeat(32),
    }));

    const completeResponse = await routes.fetch(request('/complete', {
      mfa: {
        enrollment_token: setup.data.enrollment_token,
        totp_code: await createTotpCode({ secret: setup.data.secret, now }),
      },
    }), env());

    expect(completeResponse.status).toBe(200);
    await expect(completeResponse.json()).resolves.toEqual({
      success: true,
      data: { status: 'user_activated' },
    });
    expect(completeSetup).toHaveBeenCalledWith(expect.objectContaining({
      setupTokenId: material.id,
      userId: setupAccount.userId,
      authRevision: setupAccount.authRevision,
      setupNonce: '3'.repeat(32),
      nextAuthRevision: '3'.repeat(32),
    }));
  });
});

import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import { createPasskeySignInRoutes } from './passkey-sign-in-routes';
import { opaqueWebAuthnUserIdBytes } from './webauthn-user-handle';

const userId = '0123456789abcdef0123456789abcdef';
const authRevision = 'fedcba9876543210fedcba9876543210';
const challengeToken = 'a'.repeat(32);
const now = new Date('2026-08-11T12:00:00.000Z');

function env(): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    STUDIO_SITE_MODE: 'operational',
    STUDIO_AUTH_SECRET: 'test-auth-secret-value-with-at-least-32-characters',
  };
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://studio.example.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.10',
    },
    body: JSON.stringify(body),
  });
}

function assertion(userHandle = isoBase64URL.fromBuffer(
  opaqueWebAuthnUserIdBytes(userId),
)) {
  return {
    id: 'credential',
    rawId: 'credential',
    response: {
      clientDataJSON: 'client',
      authenticatorData: 'authenticator',
      signature: 'signature',
      userHandle,
    },
    clientExtensionResults: {},
    type: 'public-key',
  };
}

const storedChallenge = {
  id: challengeToken,
  challenge: 'challenge_value_with_at_least_32_chars',
  origin: 'https://studio.example.com',
  rpId: 'studio.example.com',
  createdAtIso: now.toISOString(),
  expiresAtIso: '2026-08-11T12:05:00.000Z',
};

const storedCredential = {
  rowId: 'b'.repeat(32),
  externalId: 'credential',
  userId,
  authRevision,
  rpId: 'studio.example.com',
  oldCounter: 1,
  credential: {
    id: 'credential',
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 1,
    transports: ['internal' as const],
  },
};

function issuedSession() {
  return {
    kind: 'issued' as const,
    value: {
      cookieValue: 'session-cookie-value',
      csrfToken: 'c'.repeat(43),
      session: {
        id: 'c'.repeat(32),
        created_at_iso: now.toISOString(),
        last_seen_at_iso: now.toISOString(),
        idle_expires_at_iso: '2026-08-12T00:00:00.000Z',
        absolute_expires_at_iso: '2026-08-18T12:00:00.000Z',
        network: {
          ip_address: '203.0.113.10',
          asn: null,
          as_organization: null,
          country_code: null,
        },
      },
    },
  };
}

describe('passwordless passkey sign-in routes', () => {
  it('creates account-discovery options without exposing an account identifier', async () => {
    const generateOptions = vi.fn().mockResolvedValue({
      challenge: storedChallenge.challenge,
      rpId: 'studio.example.com',
      timeout: 300_000,
      userVerification: 'required',
      allowCredentials: [],
    });
    const createChallenge = vi.fn().mockResolvedValue({
      token: challengeToken,
      expiresAtIso: storedChallenge.expiresAtIso,
    });
    const consumeRateLimit = vi.fn().mockResolvedValue({
      allowed: true,
      limit: 20,
      remaining: 19,
      resetAt: 1_786_448_100,
    });
    const routes = createPasskeySignInRoutes({
      issueSession: vi.fn(),
      generateOptions,
      createChallenge,
      consumeRateLimit,
      now: () => now,
    });
    const request = jsonRequest('/options', {});
    request.headers.set('CF-Connecting-IP', '2001:0DB8:0:0::1');
    request.headers.set('X-Forwarded-For', '203.0.113.99');
    const environment = env();

    const response = await routes.fetch(request, environment);

    expect(response.status).toBe(200);
    expect(environment.AUTH_ROUTE_RATE_LIMITER.limit).toHaveBeenCalledWith({
      key: '2001:db8::1',
    });
    expect(consumeRateLimit).toHaveBeenCalledWith(expect.objectContaining({
      ip: '2001:db8::1',
    }));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(generateOptions).toHaveBeenCalledWith({
      rpID: 'studio.example.com',
      allowCredentials: [],
      timeout: 300_000,
      userVerification: 'required',
    });
    expect(createChallenge).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'https://studio.example.com',
      rpId: 'studio.example.com',
    }));
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { challenge_token: challengeToken },
    });
  });

  it('accepts a UV assertion and issues the normal bounded Studio session', async () => {
    const verifyAuthentication = vi.fn().mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: 'credential',
        newCounter: 2,
        userVerified: true,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        origin: storedChallenge.origin,
        rpID: storedChallenge.rpId,
      },
    });
    const completeAuthentication = vi.fn().mockResolvedValue(true);
    const issueSession = vi.fn().mockResolvedValue(issuedSession());
    const routes = createPasskeySignInRoutes({
      issueSession,
      verifyAuthentication,
      getChallenge: vi.fn().mockResolvedValue(storedChallenge),
      getCredential: vi.fn().mockResolvedValue(storedCredential),
      completeAuthentication,
      getMfaStatus: vi.fn().mockResolvedValue({
        configuredAtIso: '2026-08-01T00:00:00.000Z',
      }),
      now: () => now,
    });

    const response = await routes.fetch(jsonRequest('/verify', {
      challenge_token: challengeToken,
      response: assertion(),
    }), env());

    expect(response.status).toBe(200);
    expect(verifyAuthentication).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: storedChallenge.challenge,
      expectedOrigin: storedChallenge.origin,
      expectedRPID: storedChallenge.rpId,
      requireUserVerification: true,
      advancedFIDOConfig: { userVerification: 'required' },
    }));
    expect(completeAuthentication).toHaveBeenCalledWith(expect.objectContaining({
      credential: storedCredential,
      newCounter: 2,
      credentialBackedUp: true,
    }));
    expect(issueSession).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      authRevision,
      ipAddress: '203.0.113.10',
    }));
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'authenticated',
      },
    });
  });

  it.each([
    ['unknown challenge', null, storedCredential, true],
    ['unknown credential', storedChallenge, null, true],
    ['wrong user handle', storedChallenge, storedCredential, false],
  ])('returns one generic response for %s', async (
    _case,
    challenge,
    credential,
    validHandle,
  ) => {
    const verifyAuthentication = vi.fn().mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: 'credential',
        newCounter: 2,
        userVerified: true,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    });
    const issueSession = vi.fn();
    const routes = createPasskeySignInRoutes({
      issueSession,
      getChallenge: vi.fn().mockResolvedValue(challenge),
      getCredential: vi.fn().mockResolvedValue(credential),
      verifyAuthentication,
      now: () => now,
    });

    const response = await routes.fetch(jsonRequest('/verify', {
      challenge_token: challengeToken,
      response: assertion(validHandle
        ? undefined
        : isoBase64URL.fromBuffer(opaqueWebAuthnUserIdBytes('f'.repeat(32)))),
    }), env());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'PASSKEY_SIGN_IN_FAILED' },
    });
    expect(issueSession).not.toHaveBeenCalled();
  });

  it('does not issue a session without verified user presence and verification', async () => {
    const issueSession = vi.fn();
    const routes = createPasskeySignInRoutes({
      issueSession,
      getChallenge: vi.fn().mockResolvedValue(storedChallenge),
      getCredential: vi.fn().mockResolvedValue(storedCredential),
      verifyAuthentication: vi.fn().mockResolvedValue({
        verified: true,
        authenticationInfo: {
          credentialID: 'credential',
          newCounter: 2,
          userVerified: false,
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
        },
      }),
      now: () => now,
    });

    const response = await routes.fetch(jsonRequest('/verify', {
      challenge_token: challengeToken,
      response: assertion(),
    }), env());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'PASSKEY_SIGN_IN_FAILED' },
    });
    expect(issueSession).not.toHaveBeenCalled();
  });
});

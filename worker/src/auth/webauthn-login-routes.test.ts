import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import { createMfaContinuation } from './mfa-crypto';
import { createWebAuthnLoginRoutes } from './webauthn-login-routes';

const authSecret = 'test-auth-secret-value-with-at-least-32-characters';
const userId = '0123456789abcdef0123456789abcdef';
const authRevision = 'fedcba9876543210fedcba9876543210';
const challengeToken = 'a'.repeat(32);
const now = new Date('2026-07-31T12:00:00.000Z');

function env(): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    STUDIO_SITE_MODE: 'operational',
    STUDIO_AUTH_SECRET: authSecret,
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

describe('WebAuthn login routes', () => {
  it('generates hostname-bound second-factor options with discouraged user verification', async () => {
    const continuation = await createMfaContinuation({
      authSecret,
      userId,
      authRevision,
      purpose: 'verify',
      now,
    });
    const generateOptions = vi.fn().mockResolvedValue({
      challenge: 'challenge_value_with_at_least_32_chars',
      rpId: 'studio.example.com',
      timeout: 300_000,
      userVerification: 'discouraged',
      allowCredentials: [{ id: 'credential' }],
    });
    const createChallenge = vi.fn().mockResolvedValue({
      token: challengeToken,
      expiresAtIso: '2026-07-31T12:05:00.000Z',
    });
    const routes = createWebAuthnLoginRoutes({
      issueSession: vi.fn(),
      generateOptions,
      listCredentials: vi.fn().mockResolvedValue([
        { id: 'credential', transports: ['internal'] },
      ]),
      createChallenge,
      now: () => now,
    });

    const response = await routes.fetch(
      jsonRequest('/options', {
        continuation_token: continuation.token,
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(generateOptions).toHaveBeenCalledWith({
      rpID: 'studio.example.com',
      allowCredentials: [
        { id: 'credential', transports: ['internal'] },
      ],
      timeout: 300_000,
      userVerification: 'discouraged',
    });
    expect(createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'login',
        origin: 'https://studio.example.com',
        rpId: 'studio.example.com',
      }),
    );
  });

  it('accepts a verified password-backed assertion without requiring UV', async () => {
    const continuation = await createMfaContinuation({
      authSecret,
      userId,
      authRevision,
      purpose: 'verify',
      now,
    });
    const storedChallenge = {
      id: challengeToken,
      userId,
      sessionId: null,
      authRevision,
      purpose: 'login' as const,
      operation: null,
      targetId: null,
      challenge: 'challenge_value_with_at_least_32_chars',
      origin: 'https://studio.example.com',
      rpId: 'studio.example.com',
      createdAtIso: now.toISOString(),
      expiresAtIso: '2026-07-31T12:05:00.000Z',
    };
    const storedCredential = {
      rowId: 'b'.repeat(32),
      externalId: 'credential',
      userId,
      rpId: 'studio.example.com',
      oldCounter: 1,
      credential: {
        id: 'credential',
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 1,
        transports: ['internal' as const],
      },
    };
    const verifyAuthentication = vi.fn().mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: 'credential',
        newCounter: 2,
        userVerified: false,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        origin: 'https://studio.example.com',
        rpID: 'studio.example.com',
      },
    });
    const issueSession = vi.fn().mockResolvedValue({
      kind: 'issued',
      value: {
        cookieValue: 'session-cookie-value',
        csrfToken: 'c'.repeat(43),
        session: {
          id: 'c'.repeat(32),
          created_at_iso: now.toISOString(),
          last_seen_at_iso: now.toISOString(),
          idle_expires_at_iso: '2026-08-01T00:00:00.000Z',
          absolute_expires_at_iso: '2026-08-07T12:00:00.000Z',
          network: {
            ip_address: '203.0.113.10',
            asn: null,
            as_organization: null,
            country_code: null,
          },
        },
      },
    });
    const completeAuthentication = vi.fn().mockResolvedValue(true);
    const routes = createWebAuthnLoginRoutes({
      issueSession,
      verifyAuthentication,
      getChallenge: vi.fn().mockResolvedValue(storedChallenge),
      getCredential: vi.fn().mockResolvedValue(storedCredential),
      completeAuthentication,
      getMfaStatus: vi.fn().mockResolvedValue({
        configuredAtIso: '2026-07-30T12:00:00.000Z',
      }),
      now: () => now,
    });
    const assertion = {
      id: 'credential',
      rawId: 'credential',
      response: {
        clientDataJSON: 'client',
        authenticatorData: 'authenticator',
        signature: 'signature',
      },
      clientExtensionResults: {},
      type: 'public-key',
    };

    const response = await routes.fetch(
      jsonRequest('/verify', {
        continuation_token: continuation.token,
        challenge_token: challengeToken,
        response: assertion,
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(verifyAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOrigin: 'https://studio.example.com',
        expectedRPID: 'studio.example.com',
        requireUserVerification: false,
      }),
    );
    expect(verifyAuthentication.mock.calls[0]?.[0])
      .not.toHaveProperty('advancedFIDOConfig');
    expect(completeAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        newCounter: 2,
        credentialBackedUp: true,
      }),
    );
    expect(issueSession).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'authenticated',
      },
    });
  });

  it('does not issue a session when assertion verification fails', async () => {
    const continuation = await createMfaContinuation({
      authSecret,
      userId,
      authRevision,
      purpose: 'verify',
      now,
    });
    const issueSession = vi.fn();
    const routes = createWebAuthnLoginRoutes({
      issueSession,
      getChallenge: vi.fn().mockResolvedValue({
        id: challengeToken,
        userId,
        sessionId: null,
        authRevision,
        purpose: 'login',
        operation: null,
        targetId: null,
        challenge: 'challenge_value_with_at_least_32_chars',
        origin: 'https://studio.example.com',
        rpId: 'studio.example.com',
        createdAtIso: now.toISOString(),
        expiresAtIso: '2026-07-31T12:05:00.000Z',
      }),
      getCredential: vi.fn().mockResolvedValue({
        rowId: 'b'.repeat(32),
        externalId: 'credential',
        userId,
        rpId: 'studio.example.com',
        oldCounter: 0,
        credential: {
          id: 'credential',
          publicKey: new Uint8Array([1]),
          counter: 0,
        },
      }),
      verifyAuthentication: vi.fn().mockResolvedValue({
        verified: false,
        authenticationInfo: {
          credentialID: 'credential',
          newCounter: 0,
          userVerified: false,
          credentialDeviceType: 'multiDevice',
          credentialBackedUp: true,
          origin: 'https://studio.example.com',
          rpID: 'studio.example.com',
        },
      }),
      now: () => now,
    });

    const response = await routes.fetch(
      jsonRequest('/verify', {
        continuation_token: continuation.token,
        challenge_token: challengeToken,
        response: {
          id: 'credential',
          rawId: 'credential',
          response: {
            clientDataJSON: 'client',
            authenticatorData: 'authenticator',
            signature: 'signature',
          },
          clientExtensionResults: {},
          type: 'public-key',
        },
      }),
      env(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'WEBAUTHN_VERIFICATION_FAILED' },
    });
    expect(issueSession).not.toHaveBeenCalled();
  });
});

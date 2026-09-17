import { withAuthRateLimits } from '../test-helpers/auth-database';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../types';
import {
  createTotpCode,
  createMfaManagementGrant,
} from './mfa-crypto';
import { createMfaManagementRoutes } from './mfa-management-routes';

const authSecret = 'test-auth-secret-value-with-at-least-32-characters';
const userId = '0123456789abcdef0123456789abcdef';
const sessionId = '00112233445566778899aabbccddeeff';
const authRevision = 'fedcba9876543210fedcba9876543210';
const csrfToken = 'c'.repeat(43);
const now = new Date('2026-07-31T12:00:00.000Z');

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
    last_seen_at_iso: '2026-07-31T11:59:00.000Z',
    idle_expires_at_iso: '2026-08-01T00:00:00.000Z',
    absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
    network: {
      ip_address: '203.0.113.10',
      asn: 13335,
      as_organization: 'Cloudflare, Inc.',
      country_code: 'US',
    },
  },
  csrfToken,
  authRevision,
  mfaVerifiedAtIso: '2026-07-31T11:59:00.000Z',
};

function env(database = {} as D1Database): Env {
  return {
    DB: withAuthRateLimits(database),
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    STUDIO_SITE_MODE: 'operational',
    STUDIO_AUTH_SECRET: authSecret,
  };
}

function mutationRequest(path: string, body: unknown, csrf = csrfToken) {
  return new Request(`https://studio.local${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.10',
      Origin: 'https://studio.local',
      Cookie: '__Host-zp_session=opaque',
      'X-ZeroPress-CSRF': csrf,
    },
    body: JSON.stringify(body),
  });
}

describe('MFA management routes', () => {
  it('stops protected verification before checking a password when the client IP is unavailable', async () => {
    const verifyPassword = vi.fn();
    const onError = vi.fn();
    const routes = createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(resolvedSession),
      verifyPassword,
      now: () => now,
    });
    routes.onError((error, c) => {
      onError(error);
      return c.json({}, 503);
    });
    const request = mutationRequest('/authorize', {
      operation: 'replace_totp',
      password: 'current password',
    });
    request.headers.delete('CF-Connecting-IP');
    request.headers.set('X-Forwarded-For', '127.0.0.1');
    const environment = env();

    const response = await routes.fetch(request, environment);

    expect(response.status).toBe(503);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'CLIENT_IP_NOT_AVAILABLE',
    }));
    expect(environment.AUTH_ROUTE_RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('reports one TOTP factor and fresh step-up state', async () => {
    const response = await createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(resolvedSession),
      getStatus: vi.fn().mockResolvedValue({
        configuredAtIso: '2026-07-30T12:00:00.000Z',
      }),
      listWebAuthnCredentials: vi.fn().mockResolvedValue([]),
      now: () => now,
    }).fetch(
      new Request('https://studio.local/status'),
      env(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        totp: {
          configured_at_iso: '2026-07-30T12:00:00.000Z',
        },
        webauthn: {
          current_rp_id: 'studio.local',
          max_credentials: 10,
          credentials: [],
        },
        step_up: { mfa_required: false, freshness_seconds: 300 },
      },
    });
  });

  it('fails closed for a malformed or future session MFA timestamp', async () => {
    const getStatus = vi.fn().mockResolvedValue({
      configuredAtIso: '2026-07-30T12:00:00.000Z',
    });
    for (const mfaVerifiedAtIso of [
      'not-a-timestamp',
      '2026-07-31T12:00:00.001Z',
    ]) {
      const response = await createMfaManagementRoutes({
        resolveSession: vi.fn().mockResolvedValue({
          ...resolvedSession,
          mfaVerifiedAtIso,
        }),
        getStatus,
        listWebAuthnCredentials: vi.fn().mockResolvedValue([]),
        now: () => now,
      }).fetch(
        new Request('https://studio.local/status'),
        env(),
      );
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        data: {
          step_up: { mfa_required: true },
        },
      });
    }
  });

  it('requires same-origin CSRF, the current password, and stale-session MFA proof', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(true);
    const staleSession = {
      ...resolvedSession,
      mfaVerifiedAtIso: '2026-07-31T11:50:00.000Z',
    };
    const routes = createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(staleSession),
      verifyPassword,
      now: () => now,
    });

    expect((await routes.fetch(
      mutationRequest('/authorize', {
        operation: 'replace_totp',
        password: 'current password',
      }, 'invalid'),
      env(),
    )).status).toBe(403);

    const response = await routes.fetch(
      mutationRequest('/authorize', {
        operation: 'replace_totp',
        password: 'current password',
      }),
      env(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'MFA_STEP_UP_REQUIRED' },
    });
    expect(verifyPassword).toHaveBeenCalledTimes(1);
  });

  it('discourages user verification for password-backed WebAuthn management step-up', async () => {
    const generateOptions = vi.fn().mockResolvedValue({
      challenge: 'challenge_value_with_at_least_32_chars',
      rpId: 'studio.local',
      timeout: 300_000,
      userVerification: 'discouraged',
      allowCredentials: [{ id: 'credential' }],
    });
    const createChallenge = vi.fn().mockResolvedValue({
      token: 'a'.repeat(32),
      expiresAtIso: '2026-07-31T12:05:00.000Z',
    });
    const routes = createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(resolvedSession),
      verifyPassword: vi.fn().mockResolvedValue(true),
      listWebAuthnAuthenticationCredentials:
        vi.fn().mockResolvedValue([{ id: 'credential' }]),
      generateWebAuthnAuthenticationOptions: generateOptions,
      createWebAuthnChallenge: createChallenge,
      now: () => now,
    });

    const response = await routes.fetch(
      mutationRequest('/webauthn/step-up/options', {
        operation: 'add_webauthn',
        password: 'current password',
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(generateOptions).toHaveBeenCalledWith({
      rpID: 'studio.local',
      allowCredentials: [{ id: 'credential' }],
      timeout: 300_000,
      userVerification: 'discouraged',
    });
    expect(createChallenge).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'management_step_up',
        operation: 'add_webauthn',
        sessionId,
        origin: 'https://studio.local',
        rpId: 'studio.local',
      }),
    );
  });

  it('accepts a verified password-backed assertion without UV before issuing a management grant', async () => {
    const verifyAuthentication = vi.fn().mockResolvedValue({
      verified: true,
      authenticationInfo: {
        credentialID: 'credential',
        newCounter: 2,
        userVerified: false,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        origin: 'https://studio.local',
        rpID: 'studio.local',
      },
    });
    const completeAuthentication = vi.fn().mockResolvedValue(true);
    const routes = createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(resolvedSession),
      getWebAuthnChallenge: vi.fn().mockResolvedValue({
        id: 'a'.repeat(32),
        userId,
        sessionId,
        authRevision,
        purpose: 'management_step_up',
        operation: 'replace_totp',
        targetId: null,
        challenge: 'challenge_value_with_at_least_32_chars',
        origin: 'https://studio.local',
        rpId: 'studio.local',
        createdAtIso: now.toISOString(),
        expiresAtIso: '2026-07-31T12:05:00.000Z',
      }),
      getStoredWebAuthnCredential: vi.fn().mockResolvedValue({
        rowId: 'b'.repeat(32),
        externalId: 'credential',
        userId,
        rpId: 'studio.local',
        oldCounter: 1,
        credential: {
          id: 'credential',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 1,
          transports: ['internal'],
        },
      }),
      verifyWebAuthnAuthentication: verifyAuthentication,
      completeWebAuthnAuthentication: completeAuthentication,
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
      mutationRequest('/webauthn/step-up/verify', {
        operation: 'replace_totp',
        challenge_token: 'a'.repeat(32),
        response: assertion,
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(verifyAuthentication).toHaveBeenCalledWith(
      expect.objectContaining({
        response: assertion,
        requireUserVerification: false,
      }),
    );
    expect(verifyAuthentication.mock.calls[0]?.[0])
      .not.toHaveProperty('advancedFIDOConfig');
    expect(completeAuthentication).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        status: 'authorized',
        operation: 'replace_totp',
      },
    });
  });

  it('requests direct attestation and requires a discoverable credential with UV', async () => {
    const grant = await createMfaManagementGrant({
      authSecret,
      userId,
      sessionId,
      authRevision,
      operation: 'add_webauthn',
      now,
    });
    const generateOptions = vi.fn().mockResolvedValue({
      challenge: 'challenge_value_with_at_least_32_chars',
      rp: { id: 'studio.local', name: 'ZeroPress Studio' },
      user: {
        id: 'dXNlcg',
        name: 'owner@example.com',
        displayName: 'Studio Owner',
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
    });
    const routes = createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(resolvedSession),
      listWebAuthnCredentials: vi.fn().mockResolvedValue([]),
      listWebAuthnAuthenticationCredentials:
        vi.fn().mockResolvedValue([]),
      generateWebAuthnRegistrationOptions: generateOptions,
      createWebAuthnChallenge: vi.fn().mockResolvedValue({
        token: 'a'.repeat(32),
        expiresAtIso: '2026-07-31T12:05:00.000Z',
      }),
      now: () => now,
    });

    const response = await routes.fetch(
      mutationRequest('/webauthn/registration/options', {
        management_token: grant.token,
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(generateOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'studio.local',
        attestationType: 'direct',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
      }),
    );
  });

  it('requires verified user presence and UV before storing a registration', async () => {
    const transports = ['internal', 'hybrid', 'cable', 'smart-card'];
    const grant = await createMfaManagementGrant({
      authSecret,
      userId,
      sessionId,
      authRevision,
      operation: 'add_webauthn',
      now,
    });
    const challengeToken = 'a'.repeat(32);
    const challenge = {
      id: challengeToken,
      userId,
      sessionId,
      authRevision,
      purpose: 'registration' as const,
      operation: 'add_webauthn',
      targetId: null,
      challenge: 'challenge_value_with_at_least_32_chars',
      origin: 'https://studio.local',
      rpId: 'studio.local',
      createdAtIso: now.toISOString(),
      expiresAtIso: '2026-07-31T12:05:00.000Z',
    };
    const verifyRegistration = vi.fn().mockResolvedValue({
      verified: true,
      registrationInfo: {
        fmt: 'packed',
        credential: {
          id: 'credential',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
          transports,
        },
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        aaguid: '00000000-0000-0000-0000-000000000000',
        userVerified: true,
      },
    });
    const registerCredential = vi.fn().mockResolvedValue({
      kind: 'completed',
      credential: {
        id: 'b'.repeat(32),
        display_name: 'MacBook',
        rp_id: 'studio.local',
        transports,
        credential_device_type: 'multiDevice',
        backed_up: true,
        attestation_format: 'packed',
        aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
        created_at_iso: now.toISOString(),
        last_used_at_iso: null,
      },
    });
    const routes = createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(resolvedSession),
      getWebAuthnChallenge: vi.fn().mockResolvedValue(challenge),
      verifyWebAuthnRegistration: verifyRegistration,
      registerWebAuthnCredential: registerCredential,
      now: () => now,
    });
    const responseBody = {
      id: 'credential',
      rawId: 'credential',
      response: {
        clientDataJSON: 'client',
        attestationObject: 'attestation',
        transports,
      },
      clientExtensionResults: {},
      type: 'public-key',
    };

    const response = await routes.fetch(
      mutationRequest('/webauthn/registration/complete', {
        management_token: grant.token,
        challenge_token: challengeToken,
        display_name: 'MacBook',
        response: responseBody,
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(verifyRegistration).toHaveBeenCalledWith({
      response: responseBody,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
    });
    expect(registerCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialId: 'credential',
        transports,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
        attestationFormat: 'packed',
        aaguid: '00000000-0000-0000-0000-000000000000',
      }),
    );
  });

  it.each([
    { name: 'user verification is missing', userVerified: false, transports: undefined },
    { name: 'transports are unsupported', userVerified: true, transports: ['unsupported'] },
  ])('rejects a registration when $name', async ({ userVerified, transports }) => {
    const grant = await createMfaManagementGrant({
      authSecret,
      userId,
      sessionId,
      authRevision,
      operation: 'add_webauthn',
      now,
    });
    const challengeToken = 'a'.repeat(32);
    const registerCredential = vi.fn();
    const routes = createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(resolvedSession),
      getWebAuthnChallenge: vi.fn().mockResolvedValue({
        id: challengeToken,
        userId,
        sessionId,
        authRevision,
        purpose: 'registration',
        operation: 'add_webauthn',
        targetId: null,
        challenge: 'challenge_value_with_at_least_32_chars',
        origin: 'https://studio.local',
        rpId: 'studio.local',
        createdAtIso: now.toISOString(),
        expiresAtIso: '2026-07-31T12:05:00.000Z',
      }),
      verifyWebAuthnRegistration: vi.fn().mockResolvedValue({
        verified: true,
        registrationInfo: {
          fmt: 'none',
          credential: {
            id: 'credential',
            publicKey: new Uint8Array([1]),
            counter: 0,
            transports,
          },
          credentialDeviceType: 'singleDevice',
          credentialBackedUp: false,
          aaguid: '00000000-0000-0000-0000-000000000000',
          userVerified,
        },
      }),
      registerWebAuthnCredential: registerCredential,
      now: () => now,
    });

    const response = await routes.fetch(
      mutationRequest('/webauthn/registration/complete', {
        management_token: grant.token,
        challenge_token: challengeToken,
        display_name: 'Security key',
        response: {
          id: 'credential',
          rawId: 'credential',
          response: {
            clientDataJSON: 'client',
            attestationObject: 'attestation',
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
    expect(registerCredential).not.toHaveBeenCalled();
  });

  it('renames an owned WebAuthn credential with the active session only', async () => {
    const credentialId = 'b'.repeat(32);
    const renamedCredential = {
      id: credentialId,
      display_name: 'Desk passkey',
      rp_id: 'studio.local',
      transports: ['internal'],
      credential_device_type: 'multiDevice' as const,
      backed_up: true,
      attestation_format: 'packed',
      aaguid: null,
      created_at_iso: now.toISOString(),
      last_used_at_iso: null,
    };
    const renameCredential = vi.fn().mockResolvedValue({
      kind: 'completed',
      credential: renamedCredential,
    });
    const verifyPassword = vi.fn();
    const testEnv = env();
    const response = await createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(resolvedSession),
      renameWebAuthnCredential: renameCredential,
      verifyPassword,
      now: () => now,
    }).fetch(
      mutationRequest('/webauthn/rename', {
        credential_id: credentialId,
        display_name: 'Desk passkey',
      }),
      testEnv,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'webauthn_renamed',
        credential: renamedCredential,
      },
    });
    expect(renameCredential).toHaveBeenCalledWith({
      db: testEnv.DB,
      userId,
      authRevision,
      credentialRowId: credentialId,
      displayName: 'Desk passkey',
      now,
    });
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(testEnv.AUTH_ROUTE_RATE_LIMITER.limit).toHaveBeenCalledOnce();
  });

  it('requires an active session and its CSRF token before credential rename', async () => {
    const credentialId = 'b'.repeat(32);
    const renameCredential = vi.fn();
    const missingSessionResponse = await createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(null),
      renameWebAuthnCredential: renameCredential,
    }).fetch(
      mutationRequest('/webauthn/rename', {
        credential_id: credentialId,
        display_name: 'Desk passkey',
      }),
      env(),
    );
    expect(missingSessionResponse.status).toBe(401);

    const invalidCsrfResponse = await createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(resolvedSession),
      renameWebAuthnCredential: renameCredential,
    }).fetch(
      mutationRequest('/webauthn/rename', {
        credential_id: credentialId,
        display_name: 'Desk passkey',
      }, 'invalid'),
      env(),
    );
    expect(invalidCsrfResponse.status).toBe(403);
    expect(renameCredential).not.toHaveBeenCalled();
  });

  it('replaces the single TOTP factor', async () => {
    const replaceTotp = vi.fn().mockResolvedValue({
      kind: 'completed',
      revokedSessions: 2,
    });
    const routes = createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(resolvedSession),
      verifyPassword: vi.fn().mockResolvedValue(true),
      replaceTotp,
      now: () => now,
    });

    const authorization = await (
      await routes.fetch(
        mutationRequest('/authorize', {
          operation: 'replace_totp',
          password: 'current password',
        }),
        env(),
      )
    ).json() as {
      success: true;
      data: { management_token: string };
    };
    const setup = await (
      await routes.fetch(
        mutationRequest('/totp/setup', {
          management_token: authorization.data.management_token,
        }),
        env(),
      )
    ).json() as {
      success: true;
      data: {
        secret: string;
        enrollment_token: string;
      };
    };

    const response = await routes.fetch(
      mutationRequest('/totp/complete', {
        management_token: authorization.data.management_token,
        mfa: {
          enrollment_token: setup.data.enrollment_token,
          totp_code: await createTotpCode({
            secret: setup.data.secret,
            now,
          }),
        },
      }),
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'totp_replaced',
        revoked_sessions: 2,
      },
    });
    expect(replaceTotp).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      currentSessionId: sessionId,
      authRevision,
      encryptedTotpSecret: expect.objectContaining({
        ciphertext: expect.any(String),
        iv: expect.any(String),
      }),
    }));
  });

  it('changes the password only with an operation-bound grant and ends every session', async () => {
    const grant = await createMfaManagementGrant({
      authSecret,
      userId,
      sessionId,
      authRevision,
      operation: 'change_password',
      now,
    });
    const verifyPassword = vi.fn().mockResolvedValue(false);
    const hashPassword = vi.fn().mockResolvedValue('$argon2id$new-password');
    const changePassword = vi.fn().mockResolvedValue({
      kind: 'completed',
      revokedSessions: 3,
    });
    const routes = createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(resolvedSession),
      verifyPassword,
      hashPassword,
      changePassword,
      createSecurityRevision: () => 'a'.repeat(32),
      now: () => now,
    });

    const response = await routes.fetch(
      mutationRequest('/password/complete', {
        management_token: grant.token,
        new_password: 'Harbor lantern canyon marble circuit 942!',
      }),
      env(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain(
      '__Host-zp_session=;',
    );
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'password_changed',
        revoked_sessions: 3,
        current_session_ended: true,
      },
    });
    expect(verifyPassword).toHaveBeenCalledWith(expect.objectContaining({
      password: 'Harbor lantern canyon marble circuit 942!',
      userId,
      authRevision,
    }));
    expect(hashPassword).toHaveBeenCalledOnce();
    expect(changePassword).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      authRevision,
      passwordHash: '$argon2id$new-password',
      nextAuthRevision: 'a'.repeat(32),
    }));
  });

  it('rejects reusing the current password before hashing or writing', async () => {
    const grant = await createMfaManagementGrant({
      authSecret,
      userId,
      sessionId,
      authRevision,
      operation: 'change_password',
      now,
    });
    const hashPassword = vi.fn();
    const changePassword = vi.fn();
    const routes = createMfaManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(resolvedSession),
      verifyPassword: vi.fn().mockResolvedValue(true),
      hashPassword,
      changePassword,
      now: () => now,
    });

    const response = await routes.fetch(
      mutationRequest('/password/complete', {
        management_token: grant.token,
        new_password: 'Harbor lantern canyon marble circuit 942!',
      }),
      env(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'NEW_PASSWORD_MUST_DIFFER' },
    });
    expect(hashPassword).not.toHaveBeenCalled();
    expect(changePassword).not.toHaveBeenCalled();
  });
});

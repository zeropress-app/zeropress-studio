import { describe, expect, it } from 'vitest';
import { mfaEnrollmentSetupDataSchema } from '../../../contracts/mfa';
import {
  createMfaManagementGrant,
  createMfaContinuation,
  createMfaEnrollment,
  createTotpCode,
  decryptTotpSecret,
  encryptTotpSecret,
  isConfiguredAuthSecret,
  openMfaManagementGrant,
  openMfaContinuation,
  openMfaEnrollment,
  verifyTotpCode,
} from './mfa-crypto';

const authSecret = 'test-auth-secret-value-with-at-least-32-characters';
const otherAuthSecret =
  'different-auth-secret-value-with-at-least-32-characters';
const userId = '0123456789abcdef0123456789abcdef';
const authRevision = 'fedcba9876543210fedcba9876543210';
const sessionId = '00112233445566778899aabbccddeeff';

describe('Studio MFA cryptography', () => {
  it('requires a bounded, exact Worker authentication secret', () => {
    expect(isConfiguredAuthSecret(undefined)).toBe(false);
    expect(isConfiguredAuthSecret('x'.repeat(31))).toBe(false);
    expect(isConfiguredAuthSecret(` ${'x'.repeat(32)}`)).toBe(false);
    expect(isConfiguredAuthSecret(`${'x'.repeat(32)}\n`)).toBe(false);
    expect(isConfiguredAuthSecret(`${'x'.repeat(16)} ${'x'.repeat(16)}`))
      .toBe(false);
    expect(isConfiguredAuthSecret('한'.repeat(32))).toBe(false);
    expect(isConfiguredAuthSecret('x'.repeat(32))).toBe(true);
    expect(isConfiguredAuthSecret('x'.repeat(256))).toBe(true);
    expect(isConfiguredAuthSecret('x'.repeat(257))).toBe(false);
  });

  it('matches the RFC 6238 SHA-1 vector and accepts only the adjacent window', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const code = await createTotpCode({
      secret,
      now: new Date(59_000),
    });

    expect(code).toBe('287082');
    await expect(verifyTotpCode({
      secret,
      code,
      now: new Date(59_000),
    })).resolves.toBe(1);
    await expect(verifyTotpCode({
      secret,
      code,
      now: new Date(89_000),
    })).resolves.toBe(1);
    await expect(verifyTotpCode({
      secret,
      code,
      now: new Date(90_000),
    })).resolves.toBeNull();
    await expect(verifyTotpCode({
      secret,
      code: '000000',
      now: new Date(59_000),
    })).resolves.toBeNull();
  });

  it('seals install enrollment material, binds its subject, and expires it', async () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    const setup = await createMfaEnrollment({
      authSecret,
      subject: { type: 'install', id: 'owner@example.com' },
      accountName: 'owner@example.com',
      issuer: 'studio.example.com · Studio',
      now,
    });

    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(setup.otpauth_uri).toContain(
      'otpauth://totp/studio.example.com%20%C2%B7%20Studio%3Aowner%40example.com',
    );
    expect(setup.enrollment_token).not.toContain(setup.secret);

    const opened = await openMfaEnrollment({
      authSecret,
      enrollmentToken: setup.enrollment_token,
      now: new Date('2026-07-30T12:14:59.999Z'),
    });
    expect(opened).toMatchObject({
      subject_type: 'install',
      subject_id: 'owner@example.com',
      totp_secret: setup.secret,
    });
    await expect(openMfaEnrollment({
      authSecret,
      enrollmentToken: setup.enrollment_token,
      now: new Date('2026-07-30T12:15:00.000Z'),
    })).resolves.toBeNull();
    await expect(openMfaEnrollment({
      authSecret: otherAuthSecret,
      enrollmentToken: setup.enrollment_token,
      now,
    })).resolves.toBeNull();
    await expect(openMfaEnrollment({
      authSecret,
      enrollmentToken: `${setup.enrollment_token}x`,
      now,
    })).resolves.toBeNull();
  });

  it('binds account setup enrollment to the setup token revision', async () => {
    const now = new Date('2026-07-31T12:00:00.000Z');
    const setup = await createMfaEnrollment({
      authSecret,
      subject: {
        type: 'account_setup',
        id: userId,
        setupTokenId: 'a'.repeat(32),
        setupNonce: 'b'.repeat(32),
        authRevision,
      },
      accountName: 'author@example.com',
      issuer: 'Margin · Studio',
      now,
    });

    await expect(openMfaEnrollment({
      authSecret,
      enrollmentToken: setup.enrollment_token,
      now,
    })).resolves.toMatchObject({
      subject_type: 'account_setup',
      subject_id: userId,
      setup_token_id: 'a'.repeat(32),
      setup_nonce: 'b'.repeat(32),
      auth_revision: authRevision,
    });
  });

  it('encodes matching issuer and account metadata for scanning and manual setup', async () => {
    const issuer = 'Margin + Notes & Ideas · Studio';
    const accountName = 'owner+studio@example.com';
    const setup = await createMfaEnrollment({
      authSecret,
      subject: { type: 'user', id: userId },
      issuer,
      accountName,
    });
    expect(mfaEnrollmentSetupDataSchema.parse(setup)).toMatchObject({
      issuer,
      account_name: accountName,
    });
    const uri = new URL(setup.otpauth_uri);
    expect(decodeURIComponent(uri.pathname.slice(1)))
      .toBe(`${issuer}:${accountName}`);
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: setup.secret,
      issuer,
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
    expect(uri.search).toContain(`issuer=${encodeURIComponent(issuer)}`);
    const now = new Date('2026-09-20T12:00:00.000Z');
    await expect(verifyTotpCode({
      secret: setup.secret,
      code: await createTotpCode({ secret: uri.searchParams.get('secret')!, now }),
      now,
    })).resolves.toBe(Math.floor(now.getTime() / 30_000));
  });

  it('binds short-lived continuations to purpose, user, revision, and expiry', async () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    const continuation = await createMfaContinuation({
      authSecret,
      userId,
      authRevision,
      purpose: 'verify',
      now,
    });

    await expect(openMfaContinuation({
      authSecret,
      token: continuation.token,
      expectedPurpose: 'verify',
      now: new Date('2026-07-30T12:04:59.999Z'),
    })).resolves.toEqual({ userId, authRevision });
    await expect(openMfaContinuation({
      authSecret,
      token: continuation.token,
      expectedPurpose: 'enroll',
      now,
    })).resolves.toBeNull();
    await expect(openMfaContinuation({
      authSecret,
      token: continuation.token,
      expectedPurpose: 'verify',
      now: new Date('2026-07-30T12:05:00.000Z'),
    })).resolves.toBeNull();
    await expect(openMfaContinuation({
      authSecret: otherAuthSecret,
      token: continuation.token,
      expectedPurpose: 'verify',
      now,
    })).resolves.toBeNull();
  });

  it('binds MFA management grants to the current session, revision, operation, and expiry', async () => {
    const now = new Date('2026-07-31T12:00:00.000Z');
    const grant = await createMfaManagementGrant({
      authSecret,
      userId,
      sessionId,
      authRevision,
      operation: 'replace_totp',
      now,
    });

    await expect(openMfaManagementGrant({
      authSecret,
      token: grant.token,
      expectedOperation: 'replace_totp',
      now: new Date('2026-07-31T12:04:59.999Z'),
    })).resolves.toEqual({
      userId,
      sessionId,
      authRevision,
      operation: 'replace_totp',
    });
    await expect(openMfaManagementGrant({
      authSecret,
      token: grant.token,
      expectedOperation: 'add_webauthn',
      now,
    })).resolves.toBeNull();
    await expect(openMfaManagementGrant({
      authSecret,
      token: grant.token,
      expectedOperation: 'replace_totp',
      now: new Date('2026-07-31T12:05:00.000Z'),
    })).resolves.toBeNull();
    await expect(openMfaManagementGrant({
      authSecret: otherAuthSecret,
      token: grant.token,
      expectedOperation: 'replace_totp',
      now,
    })).resolves.toBeNull();
  });

  it('binds WebAuthn credential mutations to the selected credential', async () => {
    const now = new Date('2026-07-31T12:00:00.000Z');
    const targetId = 'a'.repeat(32);
    const grant = await createMfaManagementGrant({
      authSecret,
      userId,
      sessionId,
      authRevision,
      operation: 'remove_webauthn',
      targetId,
      now,
    });

    await expect(openMfaManagementGrant({
      authSecret,
      token: grant.token,
      expectedOperation: 'remove_webauthn',
      expectedTargetId: targetId,
      now,
    })).resolves.toMatchObject({
      operation: 'remove_webauthn',
      targetId,
    });
    await expect(openMfaManagementGrant({
      authSecret,
      token: grant.token,
      expectedOperation: 'remove_webauthn',
      expectedTargetId: 'b'.repeat(32),
      now,
    })).resolves.toBeNull();
    await expect(openMfaManagementGrant({
      authSecret,
      token: grant.token,
      expectedOperation: 'remove_webauthn',
      now,
    })).resolves.toBeNull();
  });

  it('encrypts stored TOTP secrets', async () => {
    const totpSecret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
    const encrypted = await encryptTotpSecret(authSecret, totpSecret);

    expect(encrypted.ciphertext).not.toContain(totpSecret);
    await expect(
      decryptTotpSecret(authSecret, encrypted),
    ).resolves.toBe(totpSecret);
    await expect(
      decryptTotpSecret(otherAuthSecret, encrypted),
    ).rejects.toThrow();

  });
});

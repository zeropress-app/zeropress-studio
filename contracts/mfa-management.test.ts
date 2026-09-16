import { describe, expect, it } from 'vitest';
import {
  authorizeMfaManagementRequestSchema,
  mfaManagementStatusSuccessSchema,
  mfaManagementWebAuthnRenameRequestSchema,
} from './mfa-management';

describe('MFA management contracts', () => {
  it('accepts a closed status response with one TOTP factor', () => {
    expect(mfaManagementStatusSuccessSchema.safeParse({
      success: true,
      data: {
        totp: {
          configured_at_iso: '2026-07-31T00:00:00.000Z',
        },
        webauthn: {
          current_rp_id: 'studio.example.com',
          max_credentials: 10,
          credentials: [],
        },
        step_up: { mfa_required: true, freshness_seconds: 300 },
      },
    }).success).toBe(true);
    expect(mfaManagementStatusSuccessSchema.safeParse({
      success: true,
      data: {
        totp: {
          configured_at_iso: '2026-07-31T00:00:00.000Z',
        },
        webauthn: {
          current_rp_id: 'studio.example.com',
          max_credentials: 10,
          credentials: [],
        },
        step_up: { mfa_required: 'yes', freshness_seconds: 300 },
      },
    }).success).toBe(false);
  });

  it('requires a password and validates optional current MFA proof', () => {
    expect(authorizeMfaManagementRequestSchema.safeParse({
      operation: 'replace_totp',
      password: 'current password',
    }).success).toBe(true);
    expect(authorizeMfaManagementRequestSchema.safeParse({
      operation: 'replace_totp',
      password: 'current password',
      verification: { method: 'totp', code: '123456' },
    }).success).toBe(true);
    expect(authorizeMfaManagementRequestSchema.safeParse({
      operation: 'replace_totp',
      password: 'current password',
      verification: { method: 'totp', code: '123456' },
      unexpected: true,
    }).success).toBe(false);
  });

  it('keeps credential rename outside grants and binds removal exactly', () => {
    const credentialId = 'a'.repeat(32);
    expect(mfaManagementWebAuthnRenameRequestSchema.safeParse({
      credential_id: credentialId,
      display_name: 'Laptop passkey',
    }).success).toBe(true);
    expect(mfaManagementWebAuthnRenameRequestSchema.safeParse({
      credential_id: credentialId,
      display_name: 'Laptop passkey',
      management_token: 'm'.repeat(64),
    }).success).toBe(false);
    expect(authorizeMfaManagementRequestSchema.safeParse({
      operation: 'rename_webauthn',
      target_id: credentialId,
      password: 'current password',
    }).success).toBe(false);
    expect(authorizeMfaManagementRequestSchema.safeParse({
      operation: 'remove_webauthn',
      password: 'current password',
    }).success).toBe(false);
    expect(authorizeMfaManagementRequestSchema.safeParse({
      operation: 'add_webauthn',
      target_id: credentialId,
      password: 'current password',
    }).success).toBe(false);
  });

  it('binds account-access reset to a target and keeps password change self-scoped', () => {
    const userId = 'a'.repeat(32);
    expect(authorizeMfaManagementRequestSchema.safeParse({
      operation: 'reset_user_access',
      target_id: userId,
      password: 'current password',
    }).success).toBe(true);
    expect(authorizeMfaManagementRequestSchema.safeParse({
      operation: 'reset_user_access',
      password: 'current password',
    }).success).toBe(false);
    expect(authorizeMfaManagementRequestSchema.safeParse({
      operation: 'change_password',
      password: 'current password',
    }).success).toBe(true);
    expect(authorizeMfaManagementRequestSchema.safeParse({
      operation: 'change_password',
      target_id: userId,
      password: 'current password',
    }).success).toBe(false);
  });

  it('binds invitation cancellation and account deletion to an exact user', () => {
    const userId = 'a'.repeat(32);
    for (const operation of [
      'change_user_name',
      'cancel_user_invitation',
      'delete_user_account',
    ] as const) {
      expect(authorizeMfaManagementRequestSchema.safeParse({
        operation,
        target_id: userId,
        password: 'current password',
      }).success).toBe(true);
      expect(authorizeMfaManagementRequestSchema.safeParse({
        operation,
        password: 'current password',
      }).success).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';
import {
  passkeySignInOptionsRequestSchema,
  passkeySignInVerifyRequestSchema,
  webAuthnAuthenticationResponseSchema,
  webAuthnCredentialSummarySchema,
  webAuthnCredentialNameSchema,
  webAuthnLoginOptionsSuccessSchema,
  webAuthnRegistrationResponseSchema,
} from './webauthn';

describe('WebAuthn contracts', () => {
  it('accepts bounded browser authentication and registration responses', () => {
    expect(webAuthnAuthenticationResponseSchema.safeParse({
      id: 'credential',
      rawId: 'credential',
      response: {
        clientDataJSON: 'client',
        authenticatorData: 'authenticator',
        signature: 'signature',
      },
      clientExtensionResults: {},
      type: 'public-key',
      authenticatorAttachment: 'platform',
    }).success).toBe(true);
    expect(webAuthnRegistrationResponseSchema.safeParse({
      id: 'credential',
      rawId: 'credential',
      response: {
        clientDataJSON: 'client',
        attestationObject: 'attestation',
        transports: ['internal', 'hybrid', 'cable', 'smart-card'],
      },
      clientExtensionResults: {},
      type: 'public-key',
    }).success).toBe(true);
  });

  it('rejects unknown fields and unsafe credential names', () => {
    expect(webAuthnAuthenticationResponseSchema.safeParse({
      id: 'credential',
      rawId: 'credential',
      response: {
        clientDataJSON: 'client',
        authenticatorData: 'authenticator',
        signature: 'signature',
      },
      clientExtensionResults: {},
      type: 'public-key',
      token: 'unexpected',
    }).success).toBe(false);
    expect(webAuthnCredentialNameSchema.safeParse('   ').success)
      .toBe(false);
    expect(webAuthnCredentialNameSchema.parse('  MacBook Pro  '))
      .toBe('MacBook Pro');
  });

  it('keeps browser options and the opaque database token separate', () => {
    expect(webAuthnLoginOptionsSuccessSchema.safeParse({
      success: true,
      data: {
        options: {
          challenge: 'challenge',
          rpId: 'studio.example.com',
          userVerification: 'required',
        },
        challenge_token: 'a'.repeat(32),
        expires_at_iso: '2026-07-31T12:05:00.000Z',
      },
    }).success).toBe(true);
  });

  it('requires a discoverable credential user handle for passkey sign-in', () => {
    expect(passkeySignInOptionsRequestSchema.safeParse({}).success).toBe(true);
    expect(passkeySignInOptionsRequestSchema.safeParse({ email: 'owner@example.com' }).success)
      .toBe(false);

    const assertion = {
      id: 'credential',
      rawId: 'credential',
      response: {
        clientDataJSON: 'client',
        authenticatorData: 'authenticator',
        signature: 'signature',
        userHandle: 'opaque-user-handle',
      },
      clientExtensionResults: {},
      type: 'public-key',
    };
    expect(passkeySignInVerifyRequestSchema.safeParse({
      challenge_token: 'a'.repeat(32),
      response: assertion,
    }).success).toBe(true);
    expect(passkeySignInVerifyRequestSchema.safeParse({
      challenge_token: 'a'.repeat(32),
      response: {
        ...assertion,
        response: { ...assertion.response, userHandle: null },
      },
    }).success).toBe(false);
  });

  it('exposes best-effort attestation metadata without an all-zero AAGUID', () => {
    const credential = {
      id: 'a'.repeat(32),
      display_name: 'Security key',
      rp_id: 'studio.example.com',
      transports: ['usb'],
      credential_device_type: 'singleDevice',
      backed_up: false,
      attestation_format: 'packed',
      aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
      created_at_iso: '2026-07-31T12:00:00.000Z',
      last_used_at_iso: null,
    };
    expect(webAuthnCredentialSummarySchema.safeParse(credential).success)
      .toBe(true);
    expect(webAuthnCredentialSummarySchema.safeParse({
      ...credential,
      aaguid: null,
      attestation_format: 'none',
    }).success).toBe(true);
    expect(webAuthnCredentialSummarySchema.safeParse({
      ...credential,
      aaguid: '00000000-0000-0000-0000-000000000000',
    }).success).toBe(false);
  });
});

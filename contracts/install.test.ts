import { describe, expect, it } from 'vitest';
import {
  installRequestSchema,
  installResponseSchema,
} from './install';

const mfaProof = {
  enrollment_token: 'x'.repeat(32),
  totp_code: '123456',
};

describe('Studio install contract', () => {
  it('normalizes the initial administrator identity without altering the password', () => {
    expect(installRequestSchema.parse({
      admin_name: '  Studio Owner  ',
      admin_email: '  OWNER@Example.COM ',
      admin_password: 'harbor lantern canyon marble circuit',
      interface_locale: 'ko',
      mfa: mfaProof,
    })).toEqual({
      admin_name: 'Studio Owner',
      admin_email: 'owner@example.com',
      admin_password: 'harbor lantern canyon marble circuit',
      interface_locale: 'ko',
      mfa: mfaProof,
    });
  });

  it('requires a 15–256 character password and rejects unknown fields', () => {
    expect(installRequestSchema.safeParse({
      admin_name: 'Owner',
      admin_email: 'owner@example.com',
      admin_password: 'too-short',
      interface_locale: 'en',
      mfa: mfaProof,
    }).success).toBe(false);
    expect(installRequestSchema.safeParse({
      admin_name: 'Owner',
      admin_email: 'owner@example.com',
      admin_password: 'harbor lantern canyon marble circuit',
      interface_locale: 'en',
      mfa: mfaProof,
      install_token: 'must-not-be-in-the-json-body',
    }).success).toBe(false);
    expect(installRequestSchema.safeParse({
      admin_name: 'Owner',
      admin_email: 'owner@example.com',
      admin_password: 'harbor lantern canyon marble circuit',
      interface_locale: 'fr',
      mfa: mfaProof,
    }).success).toBe(false);
  });

  it('requires the initial Edge database and integration outcome', () => {
    expect(installResponseSchema.parse({
      success: true,
      data: {
        status: 'installed',
        schema_version: 1,
        edge_database: {
          status: 'installed',
          integration_mode: 'enabled',
        },
      },
    })).toEqual({
      success: true,
      data: {
        status: 'installed',
        schema_version: 1,
        edge_database: {
          status: 'installed',
          integration_mode: 'enabled',
        },
      },
    });
    expect(installResponseSchema.safeParse({
      success: true,
      data: {
        status: 'installed',
        schema_version: 1,
      },
    }).success).toBe(false);
  });
});

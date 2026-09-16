import { describe, expect, it } from 'vitest';
import {
  authenticatedSuccessSchema,
  loginRequestSchema,
  loginResponseSchema,
  mfaVerifyRequestSchema,
} from './auth';

describe('login contract', () => {
  it('accepts the minimal same-origin login request', () => {
    expect(loginRequestSchema.parse({
      email: 'admin@example.com',
      password: 'correct horse battery staple',
    })).toEqual({
      email: 'admin@example.com',
      password: 'correct horse battery staple',
    });
  });

  it('rejects unknown request fields and malformed email addresses', () => {
    expect(loginRequestSchema.safeParse({
      email: 'not-an-email',
      password: 'password',
      api_host: 'https://api.example.com',
    }).success).toBe(false);
  });

  it.each(['mfa_required', 'mfa_enrollment_required'] as const)(
    'accepts the %s continuation result',
    (status) => {
    expect(loginResponseSchema.safeParse({
      success: true,
      data: {
        status,
        continuation_token: 'x'.repeat(32),
        expires_at_iso: '2026-07-30T12:00:00.000Z',
        ...(status === 'mfa_required'
          ? {
            available_methods: ['totp'],
            preferred_method: 'totp',
          }
          : {}),
      },
    }).success).toBe(true);
    },
  );

  it('requires MFA before accepting an authenticated result', () => {
    expect(authenticatedSuccessSchema.parse({
      success: true,
      data: {
        status: 'authenticated',
      },
    })).toEqual({
      success: true,
      data: {
        status: 'authenticated',
      },
    });
    expect(loginResponseSchema.safeParse({
      success: true,
      data: { status: 'authenticated' },
    }).success).toBe(false);
  });

  it('accepts TOTP verification requests and rejects unknown methods', () => {
    expect(mfaVerifyRequestSchema.safeParse({
      continuation_token: 'x'.repeat(32),
      method: 'totp',
      code: '123456',
    }).success).toBe(true);
    expect(mfaVerifyRequestSchema.safeParse({
      continuation_token: 'x'.repeat(32),
      method: 'unknown_method',
      code: 'ABCD-EFGH-JKLM-NPQR',
    }).success).toBe(false);
  });

  it('accepts known error codes without localized copy', () => {
    expect(loginResponseSchema.parse({
      success: false,
      error: { code: 'INVALID_CREDENTIALS' },
    })).toEqual({
      success: false,
      error: { code: 'INVALID_CREDENTIALS' },
    });
  });

  it('rejects response messages and unknown error codes', () => {
    expect(loginResponseSchema.safeParse({
      success: true,
      data: {
        status: 'mfa_required',
        continuation_token: 'x'.repeat(32),
        expires_at_iso: '2026-07-30T12:00:00.000Z',
        available_methods: ['totp'],
        preferred_method: 'totp',
        message: 'Localized copy',
      },
    }).success).toBe(false);
    expect(loginResponseSchema.safeParse({
      success: false,
      error: { code: 'FUTURE_ERROR' },
    }).success).toBe(false);
  });
});

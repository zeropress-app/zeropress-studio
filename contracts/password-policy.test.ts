import { describe, expect, it } from 'vitest';
import {
  assessInstallPasswordPolicy,
  isContextPolicyReason,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './password-policy';

const validPassword = 'harbor lantern canyon marble circuit';

describe('initial administrator password policy', () => {
  it('accepts an unrelated long password without composition rules', () => {
    expect(assessInstallPasswordPolicy({
      password: validPassword,
      email: 'owner@example.com',
      displayName: 'Studio Owner',
    })).toEqual({
      allowed: true,
      requirements: {
        minimum_length: true,
        maximum_length: true,
        context_independent: true,
        uncommon: true,
      },
    });
  });

  it('enforces the 15–256 character boundary', () => {
    expect(assessInstallPasswordPolicy({
      password: 'x'.repeat(PASSWORD_MIN_LENGTH - 1),
    }).reason).toBe('min_length');
    expect(assessInstallPasswordPolicy({
      password: 'x'.repeat(PASSWORD_MAX_LENGTH + 1),
    }).reason).toBe('max_length');
  });

  it.each([
    {
      password: 'owner-lantern-canyon-marble',
      email: 'owner@example.com',
      reason: 'context_contains_identifier',
    },
    {
      password: 'lael-secure-password-2026',
      displayName: 'Lael Kim',
      reason: 'context_contains_identifier',
    },
  ] as const)('rejects contextual password $password', (input) => {
    const result = assessInstallPasswordPolicy(input);

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(input.reason);
    expect(isContextPolicyReason(result.reason)).toBe(true);
  });

  it('allows the Studio address and product name in a password', () => {
    expect(assessInstallPasswordPolicy({
      password: 'studio.zeropress.dev-lantern-canyon-marble',
    }).allowed).toBe(true);
  });

  it('normalizes Unicode and punctuation before contextual comparison', () => {
    const result = assessInstallPasswordPolicy({
      password: 'ｊｏｈｎ－ｓｍｉｔｈ－ｏｗｎｅｒ',
      email: 'john.smith.owner@example.com',
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'context_normalized_exact',
    });
  });

  it('rejects the bundled offline common-password list', () => {
    expect(assessInstallPasswordPolicy({
      password: '  Correct Horse Battery Staple  ',
    })).toMatchObject({
      allowed: false,
      reason: 'offline_common_password',
      requirements: {
        uncommon: false,
      },
    });
  });

  it('does not reject unrelated short context tokens', () => {
    expect(assessInstallPasswordPolicy({
      password: validPassword,
      displayName: 'Ab C',
      email: 'abc@example.com',
    }).allowed).toBe(true);
  });
});

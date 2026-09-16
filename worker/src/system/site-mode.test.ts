import { describe, expect, it } from 'vitest';
import { hasConfiguredInstallToken, resolveSiteMode } from './site-mode';

describe('Studio site mode', () => {
  it.each(['initial', 'operational', 'maintenance', 'recovery'] as const)(
    'accepts exact %s configuration',
    (mode) => {
      expect(resolveSiteMode(mode)).toEqual({ state: 'valid', mode });
    },
  );

  it.each([
    ['missing', undefined, 'SITE_MODE_MISSING'],
    ['empty', '', 'SITE_MODE_INVALID'],
    ['whitespace', ' operational ', 'SITE_MODE_INVALID'],
    ['different case', 'OPERATIONAL', 'SITE_MODE_INVALID'],
    ['unknown', 'enabled', 'SITE_MODE_INVALID'],
  ] as const)('fails closed for %s configuration', (_label, value, reason) => {
    expect(resolveSiteMode(value)).toEqual({ state: 'invalid', reason });
  });

  it('requires the shared Worker-secret format for the install token', () => {
    expect(hasConfiguredInstallToken(undefined)).toBe(false);
    expect(hasConfiguredInstallToken('')).toBe(false);
    expect(hasConfiguredInstallToken('   ')).toBe(false);
    expect(hasConfiguredInstallToken('x'.repeat(31))).toBe(false);
    expect(hasConfiguredInstallToken('한'.repeat(32))).toBe(false);
    expect(hasConfiguredInstallToken(`${'x'.repeat(16)} ${'x'.repeat(16)}`))
      .toBe(false);
    expect(hasConfiguredInstallToken('x'.repeat(32))).toBe(true);
    expect(hasConfiguredInstallToken('x'.repeat(256))).toBe(true);
    expect(hasConfiguredInstallToken('x'.repeat(257))).toBe(false);
  });
});

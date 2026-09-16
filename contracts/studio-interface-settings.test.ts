import { describe, expect, it } from 'vitest';
import {
  studioInterfaceSettingsSchema,
  updateStudioInterfaceSettingsRequestSchema,
} from './studio-interface-settings';

describe('Studio interface settings contract', () => {
  it('accepts a supported subset and canonicalizes registry order', () => {
    expect(studioInterfaceSettingsSchema.parse({
      default_locale: 'ko',
      enabled_locales: ['ko', 'en'],
    })).toEqual({
      default_locale: 'ko',
      enabled_locales: ['en', 'ko'],
    });
  });

  it('requires a unique non-empty subset containing the default locale', () => {
    for (const settings of [
      { default_locale: 'en', enabled_locales: [] },
      { default_locale: 'en', enabled_locales: ['ko'] },
      { default_locale: 'en', enabled_locales: ['en', 'en'] },
      { default_locale: 'fr', enabled_locales: ['en'] },
      { default_locale: 'en', enabled_locales: ['en'], unknown: true },
    ]) {
      expect(studioInterfaceSettingsSchema.safeParse(settings).success)
        .toBe(false);
    }
  });

  it('requires a complete settings document and optimistic revision', () => {
    expect(updateStudioInterfaceSettingsRequestSchema.safeParse({
      settings: {
        default_locale: 'en',
        enabled_locales: ['en'],
      },
      expected_revision: '1'.repeat(32),
    }).success).toBe(true);
    expect(updateStudioInterfaceSettingsRequestSchema.safeParse({
      settings: { default_locale: 'en' },
      expected_revision: '1'.repeat(32),
    }).success).toBe(false);
  });
});

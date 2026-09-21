import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_DEFAULTS,
  ANALYTICS_INITIAL_REVISION,
  analyticsSettingsSchema,
  updateAnalyticsSettingsSchema,
  testAnalyticsConnectionSchema,
} from './analytics';

describe('analytics contracts', () => {
  it('allows an unconfigured installation and requires connection identifiers when enabled', () => {
    expect(analyticsSettingsSchema.parse(ANALYTICS_DEFAULTS)).toEqual(
      ANALYTICS_DEFAULTS,
    );
    expect(
      analyticsSettingsSchema.safeParse({
        ...ANALYTICS_DEFAULTS,
        enabled: true,
      }).success,
    ).toBe(false);
    expect(
      analyticsSettingsSchema.parse({
        enabled: true,
        account_id: ` ${'A'.repeat(32)} `,
        site_tag: ' site-tag ',
      }),
    ).toEqual({
      enabled: true,
      account_id: 'a'.repeat(32),
      site_tag: 'site-tag',
    });
  });
  it('accepts explicit credential operations and rejects empty replacements', () => {
    const base = {
      settings: ANALYTICS_DEFAULTS,
      expected_revision: ANALYTICS_INITIAL_REVISION,
    };
    for (const credential of [
      { action: 'preserve' },
      { action: 'remove' },
      { action: 'replace', value: 'synthetic-token' },
    ]) {
      expect(
        updateAnalyticsSettingsSchema.safeParse({ ...base, credential })
          .success,
      ).toBe(true);
    }
    expect(
      updateAnalyticsSettingsSchema.safeParse({
        ...base,
        credential: { action: 'replace', value: '' },
      }).success,
    ).toBe(false);
    expect(
      updateAnalyticsSettingsSchema.safeParse({
        ...base,
        credential: { action: 'remove', value: 'token' },
      }).success,
    ).toBe(false);
  });
  it('requires complete connection identifiers before testing', () => {
    expect(
      testAnalyticsConnectionSchema.safeParse({ account_id: '', site_tag: '' })
        .success,
    ).toBe(false);
    expect(
      testAnalyticsConnectionSchema.safeParse({
        account_id: 'a'.repeat(32),
        site_tag: 'b'.repeat(32),
      }).success,
    ).toBe(true);
  });
});

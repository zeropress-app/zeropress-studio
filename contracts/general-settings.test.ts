import { describe, expect, it } from 'vitest';
import {
  GENERAL_SETTINGS_DEFAULTS,
  generalSettingsSchema,
  normalizeSiteLocale,
  normalizeSiteOrigin,
  normalizeSiteTimezone,
  updateGeneralSettingsRequestSchema,
} from './general-settings';

describe('general settings contract', () => {
  it('keeps the materialized defaults valid', () => {
    expect(generalSettingsSchema.parse(GENERAL_SETTINGS_DEFAULTS))
      .toEqual(GENERAL_SETTINGS_DEFAULTS);
  });

  it('normalizes authored values into Preview Data-compatible values', () => {
    expect(updateGeneralSettingsRequestSchema.parse({
      settings: {
        title: '  Example Site  ',
        description: '  A small publication.  ',
        url: 'https://Example.COM:443/',
        locale: 'ko-kr',
        timezone: 'Etc/UTC',
      },
      expected_revision: '0'.repeat(32),
    })).toEqual({
      settings: {
        title: 'Example Site',
        description: 'A small publication.',
        url: 'https://example.com',
        locale: 'ko-KR',
        timezone: 'UTC',
      },
      expected_revision: '0'.repeat(32),
    });
  });

  it('accepts canonical IANA zones and fixed offsets', () => {
    expect(normalizeSiteTimezone('Asia/Seoul')).toBe('Asia/Seoul');
    expect(normalizeSiteTimezone('+09:00')).toBe('+09:00');
    expect(normalizeSiteTimezone('-14:00')).toBe('-14:00');
    expect(normalizeSiteTimezone('+00:00')).toBe('UTC');
    expect(normalizeSiteTimezone('+14:01')).toBeNull();
    expect(normalizeSiteTimezone('+9:00')).toBeNull();
  });

  it('rejects unsafe site origins and malformed locale values', () => {
    expect(normalizeSiteOrigin('https://example.com/blog')).toBeNull();
    expect(normalizeSiteOrigin('https://user@example.com')).toBeNull();
    expect(normalizeSiteOrigin(' https://example.com')).toBeNull();
    expect(normalizeSiteOrigin('https://example.com?x=1')).toBeNull();
    expect(normalizeSiteOrigin('')).toBe('');
    expect(normalizeSiteLocale('ko_KR')).toBeNull();
    expect(normalizeSiteLocale('en-us')).toBe('en-US');
  });

  it('requires a complete closed settings object and a valid revision', () => {
    const base = {
      settings: GENERAL_SETTINGS_DEFAULTS,
      expected_revision: '0'.repeat(32),
    };
    expect(updateGeneralSettingsRequestSchema.safeParse(base).success)
      .toBe(true);
    expect(updateGeneralSettingsRequestSchema.safeParse({
      ...base,
      settings: { ...base.settings, extra: true },
    }).success).toBe(false);
    expect(updateGeneralSettingsRequestSchema.safeParse({
      ...base,
      settings: { ...base.settings, title: '   ' },
    }).success).toBe(false);
    expect(updateGeneralSettingsRequestSchema.safeParse({
      ...base,
      expected_revision: 'stale',
    }).success).toBe(false);
  });
});

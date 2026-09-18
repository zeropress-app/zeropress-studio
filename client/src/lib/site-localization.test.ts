import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeSiteLocale,
  describeSiteTimezone,
  readBrowserLocalizationDefaults,
} from './site-localization';

// Fix the reference instant so January and July offsets can be compared
// in a time zone that observes daylight saving time.
const WINTER = new Date('2026-01-15T12:00:00.000Z');
const SUMMER = new Date('2026-07-15T12:00:00.000Z');

describe('describeSiteLocale', () => {
  it('describes a canonical locale with its name in the display language', () => {
    const korean = describeSiteLocale('ko-KR', 'ko');
    expect(korean.canonical).toBe('ko-KR');
    expect(korean.normalized).toBe(false);
    expect(korean.unknown).toBe(false);
    expect(korean.displayName).toBe('한국어(대한민국)');

    // Display names follow the administrator's UI language, not the site locale.
    expect(describeSiteLocale('ko-KR', 'en').displayName)
      .toBe('Korean (South Korea)');
    expect(describeSiteLocale('pt-BR', 'en').displayName)
      .toBe('Brazilian Portuguese');
  });

  it('keeps a known language with an unknown region out of the advisory', () => {
    // The language is recognized, so the unknown-language warning does not apply.
    const description = describeSiteLocale('en-ZZ', 'en');
    expect(description.canonical).toBe('en-ZZ');
    expect(description.unknown).toBe(false);
    expect(description.displayName).toBe('English (Unknown Region)');
  });

  it('reports the value that saving will actually store', () => {
    const description = describeSiteLocale('KO-kr', 'en');
    expect(description.canonical).toBe('ko-KR');
    expect(description.normalized).toBe(true);
  });

  it('marks a structurally valid tag that matches no known language', () => {
    for (const tag of ['zz', 'qqq', 'xx-YY']) {
      const description = describeSiteLocale(tag, 'en');
      // The contract accepts this value, so saving remains allowed.
      expect(description.canonical, tag).not.toBeNull();
      expect(description.unknown, tag).toBe(true);
      expect(description.displayName, tag).toBeNull();
    }
  });

  it('describes nothing for input the contract rejects', () => {
    for (const value of ['ko_KR', ' ko-KR', '']) {
      const description = describeSiteLocale(value, 'en');
      expect(description.canonical, value).toBeNull();
      expect(description.unknown, value).toBe(false);
      expect(description.displayName, value).toBeNull();
    }
  });
});

describe('describeSiteTimezone', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockBrowserTimezone(timeZone: string) {
    const DateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (locales, options) {
      return new DateTimeFormat(locales, { timeZone, ...options });
    });
  }

  it('separates UTC, IANA names, and fixed offsets', () => {
    expect(describeSiteTimezone('UTC', 'en', WINTER).kind).toBe('utc');
    expect(describeSiteTimezone('Asia/Seoul', 'en', WINTER).kind).toBe('iana');
    expect(describeSiteTimezone('+09:00', 'en', WINTER).kind)
      .toBe('fixed_offset');
    // The contract normalizes a zero offset to UTC.
    const zero = describeSiteTimezone('+00:00', 'en', WINTER);
    expect(zero.canonical).toBe('UTC');
    expect(zero.kind).toBe('utc');
    expect(zero.normalized).toBe(true);
  });

  it('reports the value that saving will actually store', () => {
    const description = describeSiteTimezone('asia/seoul', 'en', WINTER);
    expect(description.canonical).toBe('Asia/Seoul');
    expect(description.normalized).toBe(true);
  });

  it('shows the current offset and a sample time for the chosen zone', () => {
    const description = describeSiteTimezone('Asia/Seoul', 'en', WINTER);
    expect(description.offsetLabel).toBe('GMT+09:00');
    expect(description.sample).toContain('2026');
    expect(description.sample).toContain('9:00');
  });

  it('detects whether an IANA zone observes daylight saving time', () => {
    expect(describeSiteTimezone('Europe/Berlin', 'en', WINTER)
      .observesDaylightSaving).toBe(true);
    expect(describeSiteTimezone('Europe/Berlin', 'en', SUMMER)
      .observesDaylightSaving).toBe(true);
    expect(describeSiteTimezone('Asia/Seoul', 'en', WINTER)
      .observesDaylightSaving).toBe(false);
    expect(describeSiteTimezone('UTC', 'en', WINTER)
      .observesDaylightSaving).toBe(false);
    // A fixed offset never changes during the year, so DST detection does not apply.
    expect(describeSiteTimezone('+01:00', 'en', WINTER)
      .observesDaylightSaving).toBe(false);
  });

  it('reflects that a fixed offset drifts from its region across the year', () => {
    const berlin = describeSiteTimezone('Europe/Berlin', 'en', SUMMER);
    const fixed = describeSiteTimezone('+01:00', 'en', SUMMER);
    // The same instant differs by one hour between these settings in summer.
    expect(berlin.offsetLabel).toBe('GMT+02:00');
    expect(fixed.offsetLabel).toBe('GMT+01:00');
  });

  it('describes nothing for input the contract rejects', () => {
    for (const value of ['KST', 'Asia/Seoul ', '+15:00', '']) {
      const description = describeSiteTimezone(value, 'en', WINTER);
      expect(description.canonical, value).toBeNull();
      expect(description.kind, value).toBeNull();
      expect(description.suggestedZone, value).toBeNull();
    }
  });

  it('never suggests a replacement zone for UTC or an IANA name', () => {
    expect(describeSiteTimezone('UTC', 'en', WINTER).suggestedZone).toBeNull();
    expect(describeSiteTimezone('Asia/Seoul', 'en', WINTER).suggestedZone)
      .toBeNull();
  });

  it.each([
    { zone: 'Asia/Seoul', at: WINTER, matching: '+09:00', mismatched: '+08:00', dst: false },
    { zone: 'Europe/Berlin', at: WINTER, matching: '+01:00', mismatched: '+02:00', dst: true },
    { zone: 'Europe/Berlin', at: SUMMER, matching: '+02:00', mismatched: '+01:00', dst: true },
  ])('suggests $zone only for its matching offset $matching', ({ zone, at, matching, mismatched, dst }) => {
    mockBrowserTimezone(zone);

    expect(describeSiteTimezone(matching, 'en', at)).toMatchObject({
      suggestedZone: zone,
      suggestedZoneObservesDaylightSaving: dst,
    });
    expect(describeSiteTimezone(mismatched, 'en', at)).toMatchObject({
      suggestedZone: null,
      suggestedZoneObservesDaylightSaving: false,
    });
  });

  it.each(['+00:00', '-00:00'])('normalizes %s to UTC without suggesting a replacement in a UTC browser', (offset) => {
    mockBrowserTimezone('UTC');

    expect(describeSiteTimezone(offset, 'en', WINTER)).toMatchObject({
      canonical: 'UTC',
      kind: 'utc',
      normalized: true,
      suggestedZone: null,
      suggestedZoneObservesDaylightSaving: false,
    });
  });
});

describe('readBrowserLocalizationDefaults', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers the browser language list over the region-stripped resolved locale', () => {
    // ICU returns `ko`, but retaining the region is more useful for the site locale.
    vi.stubGlobal('navigator', { languages: ['ko-KR', 'ko', 'en-US'] });

    expect(readBrowserLocalizationDefaults()).toEqual({
      locale: 'ko-KR',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  });

  it('skips unusable candidates and falls back to the resolved locale', () => {
    vi.stubGlobal('navigator', { languages: ['not a locale', 'pt-BR'] });

    expect(readBrowserLocalizationDefaults()?.locale).toBe('pt-BR');

    vi.stubGlobal('navigator', { languages: [] });
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    expect(readBrowserLocalizationDefaults()?.locale)
      .toBe(resolved.locale);
  });
});

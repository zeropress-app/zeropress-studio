import {
  normalizeSiteLocale,
  normalizeSiteTimezone,
} from '../../../contracts/general-settings';

/**
 * Explain site locale and time zone input in a readable form.
 *
 * Both fields accept free text, which the Worker contract normalizes before
 * saving. Show the canonical value and its meaning before saving inputs such
 * as `KO-kr` or `asia/seoul` that are valid but stored differently.
 *
 * Reuse the contract's `normalizeSite*` functions. This presentation layer
 * must not reject values that the contract accepts.
 */

const FIXED_OFFSET_PATTERN = /^[+-]\d{2}:\d{2}$/u;

export type SiteLocaleDescription = {
  /** Canonical value to store, or `null` when the contract rejects the input. */
  canonical: string | null;
  /** Whether saving changes the input string. */
  normalized: boolean;
  /** Language and region name in the current display language. */
  displayName: string | null;
  /**
   * Whether the tag has valid BCP 47 syntax but an unrecognized language.
   *
   * Canonical tags such as `zz` and `xx-YY` pass the contract. Allow saving,
   * but explain that themes and `Intl` consumers may not recognize them.
   */
  unknown: boolean;
};

export type SiteTimezoneKind = 'utc' | 'iana' | 'fixed_offset';

export type SiteTimezoneDescription = {
  /** Canonical value to store, or `null` when the contract rejects the input. */
  canonical: string | null;
  /** Whether saving changes the input string. */
  normalized: boolean;
  kind: SiteTimezoneKind | null;
  /** UTC offset at the reference instant, such as `GMT+09:00`. */
  offsetLabel: string | null;
  /** Reference instant formatted in this zone to help confirm the selection. */
  sample: string | null;
  /** Whether the IANA time zone observes daylight saving time. */
  observesDaylightSaving: boolean;
  /**
   * IANA time zone suggestion for a fixed offset.
   *
   * Listing every matching zone can bury the author's region in alphabetical
   * results. Suggest only the browser's zone, and only when its offset matches;
   * authors commonly work in the same time zone as their site.
   */
  suggestedZone: string | null;
  /** Whether the suggested zone observes daylight saving time. */
  suggestedZoneObservesDaylightSaving: boolean;
};

function zoneOffsetLabel(timezone: string, at: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    }).formatToParts(at);
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Compare January and July offsets in the same year. Different offsets mean
 * the zone changes during the year and cannot be replaced by a fixed offset.
 */
function observesDaylightSaving(timezone: string, at: Date): boolean {
  const year = at.getUTCFullYear();
  const january = zoneOffsetLabel(
    timezone,
    new Date(Date.UTC(year, 0, 15, 12)),
  );
  const july = zoneOffsetLabel(timezone, new Date(Date.UTC(year, 6, 15, 12)));
  if (january === null || july === null) return false;
  return january !== july;
}

function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function describeSiteLocale(
  value: string,
  displayLocale: string,
): SiteLocaleDescription {
  const canonical = normalizeSiteLocale(value);
  if (canonical === null) {
    return {
      canonical: null,
      normalized: false,
      displayName: null,
      unknown: false,
    };
  }

  let names: Intl.DisplayNames;
  try {
    names = new Intl.DisplayNames([displayLocale], { type: 'language' });
  } catch {
    // The canonical value remains useful even when a display name is unavailable.
    return {
      canonical,
      normalized: canonical !== value,
      displayName: null,
      unknown: false,
    };
  }

  /*
   * Check the base language subtag rather than the entire tag. `DisplayNames`
   * returns unrecognized subtags unchanged, but formats `xx-YY` as `xx (YY)`,
   * which defeats a comparison against the full tag.
   *
   * A known language with an unknown region, such as `en-ZZ`, does not trigger
   * this warning: it specifically indicates an unrecognized language.
   */
  let baseLanguage = canonical;
  try {
    baseLanguage = new Intl.Locale(canonical).language || canonical;
  } catch {
    // Fall back to comparing the full tag if the base language cannot be extracted.
  }
  const unknown = names.of(baseLanguage) === baseLanguage;

  return {
    canonical,
    normalized: canonical !== value,
    displayName: unknown ? null : names.of(canonical) ?? null,
    unknown,
  };
}

export function describeSiteTimezone(
  value: string,
  displayLocale: string,
  at: Date = new Date(),
): SiteTimezoneDescription {
  const canonical = normalizeSiteTimezone(value);
  if (canonical === null) {
    return {
      canonical: null,
      normalized: false,
      kind: null,
      offsetLabel: null,
      sample: null,
      observesDaylightSaving: false,
      suggestedZone: null,
      suggestedZoneObservesDaylightSaving: false,
    };
  }

  const kind: SiteTimezoneKind = canonical === 'UTC'
    ? 'utc'
    : FIXED_OFFSET_PATTERN.test(canonical) ? 'fixed_offset' : 'iana';

  let sample: string | null = null;
  try {
    sample = new Intl.DateTimeFormat(displayLocale, {
      timeZone: canonical,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(at);
  } catch {
    // Show the canonical value and offset even when an example is unavailable.
  }

  const offsetLabel = zoneOffsetLabel(canonical, at);

  let suggestedZone: string | null = null;
  if (kind === 'fixed_offset') {
    const browserZone = browserTimezone();
    if (
      browserZone !== null
      && offsetLabel !== null
      && zoneOffsetLabel(browserZone, at) === offsetLabel
    ) {
      suggestedZone = browserZone;
    }
  }

  return {
    canonical,
    normalized: canonical !== value,
    kind,
    offsetLabel,
    sample,
    observesDaylightSaving: kind === 'iana'
      && observesDaylightSaving(canonical, at),
    suggestedZone,
    suggestedZoneObservesDaylightSaving: suggestedZone !== null
      && observesDaylightSaving(suggestedZone, at),
  };
}

/**
 * Suggest the browser's locale and time zone only when both pass the contract.
 *
 * The site locale is independent of the administrator's Studio UI language.
 * Offer it as an explicit choice rather than applying it automatically.
 */
export function readBrowserLocalizationDefaults(): {
  locale: string;
  timezone: string;
} | null {
  let resolved: Intl.ResolvedDateTimeFormatOptions;
  try {
    resolved = Intl.DateTimeFormat().resolvedOptions();
  } catch {
    return null;
  }

  /*
   * Prefer the browser's language preference list. ICU may strip the region
   * from `resolvedOptions().locale` (returning `ko`), whereas retaining it
   * (`ko-KR`) gives the site more precise date and number formatting.
   */
  const candidates = [
    ...(typeof navigator === 'undefined' ? [] : navigator.languages ?? []),
    resolved.locale,
  ];
  let locale: string | null = null;
  for (const candidate of candidates) {
    locale = normalizeSiteLocale(candidate);
    if (locale !== null) break;
  }

  const timezone = normalizeSiteTimezone(resolved.timeZone);
  return locale !== null && timezone !== null ? { locale, timezone } : null;
}

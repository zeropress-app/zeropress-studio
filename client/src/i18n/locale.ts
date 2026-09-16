import {
  FALLBACK_INTERFACE_LOCALE,
  SUPPORTED_INTERFACE_LOCALES,
  type InterfaceLocale,
} from '../../../contracts/studio-interface-settings';

export const SUPPORTED_LOCALES = SUPPORTED_INTERFACE_LOCALES;
export const FALLBACK_LOCALE = FALLBACK_INTERFACE_LOCALE;
export const LOCALE_STORAGE_KEY = 'zeropress-studio.locale';

export type SupportedLocale = InterfaceLocale;

export const INTERFACE_LOCALE_METADATA = {
  en: { nativeLabel: 'English', direction: 'ltr' },
  ko: { nativeLabel: '한국어', direction: 'ltr' },
} as const satisfies Record<
  SupportedLocale,
  { nativeLabel: string; direction: 'ltr' | 'rtl' }
>;

export function normalizeLocale(
  value: string | null | undefined,
  allowedLocales: readonly SupportedLocale[] = SUPPORTED_LOCALES,
): SupportedLocale | null {
  if (!value) return null;
  let canonical: string;
  try {
    [canonical = ''] = Intl.getCanonicalLocales(
      value.trim().replaceAll('_', '-'),
    );
  } catch {
    return null;
  }
  const exact = allowedLocales.find((locale) => (
    locale.toLowerCase() === canonical.toLowerCase()
  ));
  if (exact) return exact;
  const language = canonical.split('-', 1)[0]?.toLowerCase();
  return allowedLocales.find((locale) => (
    locale.toLowerCase() === language
  )) ?? null;
}

export function resolveLocale(input: {
  storedLocale?: string | null;
  preferredLanguages?: readonly string[];
  enabledLocales?: readonly SupportedLocale[];
  defaultLocale?: SupportedLocale;
} = {}): SupportedLocale {
  const enabledLocales = input.enabledLocales?.length
    ? input.enabledLocales
    : SUPPORTED_LOCALES;
  const defaultLocale = normalizeLocale(
    input.defaultLocale,
    enabledLocales,
  ) ?? enabledLocales[0] ?? FALLBACK_LOCALE;
  const storedLocale = normalizeLocale(input.storedLocale, enabledLocales);
  if (storedLocale) return storedLocale;

  for (const language of input.preferredLanguages ?? []) {
    const locale = normalizeLocale(language, enabledLocales);
    if (locale) return locale;
  }

  return defaultLocale;
}

export function readInitialLocale(): SupportedLocale {
  let storedLocale: string | null = null;

  try {
    storedLocale = globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }

  const preferredLanguages = typeof navigator === 'undefined'
    ? []
    : navigator.languages;

  return resolveLocale({ storedLocale, preferredLanguages });
}

export function persistLocale(locale: SupportedLocale): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Language switching remains functional when persistence is unavailable.
  }
}

export function readPersistedLocale(): string | null {
  try {
    return globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

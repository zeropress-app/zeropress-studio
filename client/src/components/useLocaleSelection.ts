import { useTranslation } from 'react-i18next';
import { changeLocale } from '../i18n';
import {
  FALLBACK_LOCALE,
  INTERFACE_LOCALE_METADATA,
  normalizeLocale,
  type SupportedLocale,
} from '../i18n/locale';

/**
 * Shared state and actions for language selectors.
 *
 * Regular Studio passes the enabled locales resolved from D1. Maintenance & Recovery passes all
 * bundled locales independently of database state. Placement and appearance remain separate from
 * this policy.
 */
export function useLocaleSelection(
  availableLocales: readonly SupportedLocale[],
) {
  const { i18n } = useTranslation();
  const locale = normalizeLocale(
    i18n.language,
    availableLocales,
  ) ?? normalizeLocale(
    i18n.resolvedLanguage,
    availableLocales,
  ) ?? normalizeLocale(FALLBACK_LOCALE, availableLocales)
    ?? availableLocales[0]
    ?? FALLBACK_LOCALE;
  const options = availableLocales.map((value) => ({
    value,
    label: INTERFACE_LOCALE_METADATA[value].nativeLabel,
  }));

  async function selectLocale(value: string): Promise<boolean> {
    const nextLocale = normalizeLocale(value, availableLocales);
    if (!nextLocale) return false;
    await changeLocale(nextLocale);
    return true;
  }

  return { locale, options, selectLocale };
}

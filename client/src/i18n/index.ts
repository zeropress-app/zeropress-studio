import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  loadedNamespaces,
  loadNamespaceBundles,
} from './load-namespaces';
import {
  FALLBACK_LOCALE,
  INTERFACE_LOCALE_METADATA,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  persistLocale,
  readInitialLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from './locale';
import {
  BOOT_NAMESPACES,
  STUDIO_NAMESPACES,
  type StudioNamespace,
} from './namespaces';
import { BOOT_RESOURCES } from './resources';
import { isLocalStorageChange } from '../lib/local-storage-event';

function syncDocumentLanguage(language: string | undefined): void {
  if (typeof document === 'undefined') return;

  const locale = normalizeLocale(language) ?? FALLBACK_LOCALE;
  document.documentElement.lang = locale;
  document.documentElement.dir = INTERFACE_LOCALE_METADATA[locale].direction;
  document.title = i18n.t('documentTitle', { lng: locale, ns: 'auth' });
}

const initialLocale = readInitialLocale();

void i18n
  .use(initReactI18next)
  .init({
    // Inject only the fallback locale's boot catalog synchronously.
    // ensureNamespaces merges the rest through addResourceBundle.
    resources: BOOT_RESOURCES,
    lng: initialLocale,
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    load: 'currentOnly',
    defaultNS: 'common',
    ns: [...BOOT_NAMESPACES],
    // Do not suspend screens for catalogs that have not arrived yet.
    // The lazy route boundary owns loading timing and already renders
    // its own fallback.
    react: { useSuspense: false },
    interpolation: {
      escapeValue: false,
    },
    returnEmptyString: false,
    initAsync: false,
  });

i18n.on('languageChanged', syncDocumentLanguage);
syncDocumentLanguage(i18n.language ?? i18n.resolvedLanguage);

export function getCurrentLocale(): SupportedLocale {
  // Until the requested locale's catalog loads, i18next may report
  // the fallback locale as resolvedLanguage. Prefer the requested language
  // so the persisted locale's resources are actually loaded.
  return normalizeLocale(i18n.language)
    ?? normalizeLocale(i18n.resolvedLanguage)
    ?? FALLBACK_LOCALE;
}

/**
 * Prepare namespaces for the current locale. Lazy routes wait for this call alongside their screen
 * chunk and render only when their messages are ready.
 */
export async function ensureNamespaces(
  namespaces: readonly StudioNamespace[],
): Promise<void> {
  await loadNamespaceBundles(getCurrentLocale(), namespaces);
}

/**
 * Prepare catalogs needed before the first render. The fallback locale is already bundled; other
 * locales load their boot catalogs and then update the document title.
 */
export async function ensureBootNamespaces(): Promise<void> {
  await loadNamespaceBundles(getCurrentLocale(), BOOT_NAMESPACES);
  syncDocumentLanguage(i18n.language ?? i18n.resolvedLanguage);
}

/**
 * Prepare all catalogs for the current locale in environments without per-screen lazy loading,
 * such as test harnesses. Product screens should request only their own namespaces.
 */
export async function loadAllNamespaces(
  locale: SupportedLocale = getCurrentLocale(),
): Promise<void> {
  await loadNamespaceBundles(locale, STUDIO_NAMESPACES);
}

export async function changeLocale(locale: SupportedLocale): Promise<void> {
  persistLocale(locale);
  // Prepare the currently used namespaces in the new locale before switching,
  // so some messages do not temporarily remain in the fallback language.
  await loadNamespaceBundles(
    locale,
    loadedNamespaces(getCurrentLocale(), STUDIO_NAMESPACES),
  );
  await i18n.changeLanguage(locale);
}

/**
 * Apply the locale selected in another same-origin tab.
 *
 * The storage-event path does not write the value again. Use a sequence counter to order rapid
 * changes so an earlier catalog load cannot overwrite the latest choice.
 */
export function startLocaleSync(): () => void {
  let active = true;
  let sequence = 0;

  const handleStorage = (event: StorageEvent) => {
    if (!isLocalStorageChange(event, LOCALE_STORAGE_KEY)) return;
    const operation = ++sequence;
    const locale = normalizeLocale(event.newValue);
    if (!locale || locale === getCurrentLocale()) return;
    const namespaces = loadedNamespaces(
      getCurrentLocale(),
      STUDIO_NAMESPACES,
    );

    void loadNamespaceBundles(locale, namespaces)
      .then(async () => {
        if (!active || operation !== sequence) return;
        await i18n.changeLanguage(locale);
      })
      .catch(() => {
        // Keep the current locale if its replacement catalog cannot be fully loaded.
      });
  };

  globalThis.addEventListener?.('storage', handleStorage);
  return () => {
    active = false;
    sequence += 1;
    globalThis.removeEventListener?.('storage', handleStorage);
  };
}

export default i18n;

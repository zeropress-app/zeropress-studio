import i18next from 'i18next';
import type { SupportedLocale } from './locale';
import {
  namespaceFileName,
  type StudioNamespace,
} from './namespaces';

/**
 * Load one chunk for each locale/namespace pair on demand.
 *
 * A variable import path lets the bundler split locales/* into individual chunks, keeping the
 * initial bundle independent of locale count. Callers must declare the namespaces each screen
 * needs.
 */
async function importNamespaceBundle(
  locale: SupportedLocale,
  namespace: StudioNamespace,
): Promise<Record<string, unknown>> {
  const file = namespaceFileName(namespace);
  const module = await import(`./locales/${locale}/${file}.ts`) as
    Record<string, Record<string, unknown> | undefined>;
  const bundle = module[namespace];
  if (!bundle) {
    throw new Error(
      `Locale catalog ${locale}/${file} does not export "${namespace}".`,
    );
  }
  return bundle;
}

// Share in-flight requests when two screens request the same catalog.
// Keep successful entries cached; remove failed entries so
// the next call can retry.
const pendingBundles = new Map<string, Promise<void>>();

function loadNamespaceBundle(
  locale: SupportedLocale,
  namespace: StudioNamespace,
): Promise<void> {
  if (i18next.hasResourceBundle(locale, namespace)) return Promise.resolve();

  const cacheKey = `${locale}/${namespace}`;
  const cached = pendingBundles.get(cacheKey);
  if (cached) return cached;

  const pending = importNamespaceBundle(locale, namespace)
    .then((bundle) => {
      // deep=false, overwrite=false: preserve an existing catalog.
      i18next.addResourceBundle(locale, namespace, bundle, false, false);
    })
    .catch((error: unknown) => {
      pendingBundles.delete(cacheKey);
      throw error;
    });
  pendingBundles.set(cacheKey, pending);
  return pending;
}

/**
 * Wait until the requested namespaces are ready for a locale. Already loaded namespaces resolve
 * without a network request.
 */
export async function loadNamespaceBundles(
  locale: SupportedLocale,
  namespaces: readonly StudioNamespace[],
): Promise<void> {
  await Promise.all(namespaces.map(
    (namespace) => loadNamespaceBundle(locale, namespace),
  ));
}

/**
 * Namespaces already loaded for a locale. Prepare the same set when changing locales so the
 * current screen retains all its messages.
 */
export function loadedNamespaces(
  locale: SupportedLocale,
  candidates: readonly StudioNamespace[],
): StudioNamespace[] {
  return candidates.filter(
    (namespace) => i18next.hasResourceBundle(locale, namespace),
  );
}

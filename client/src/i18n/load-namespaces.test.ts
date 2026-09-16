import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { loadedNamespaces, loadNamespaceBundles } from './load-namespaces';
import { FALLBACK_LOCALE } from './locale';
import {
  BOOT_NAMESPACES,
  DEFERRED_NAMESPACES,
  STUDIO_NAMESPACES,
} from './namespaces';

// test-setup prepares all catalogs only for the current fallback locale.
// Other locales remain unloaded, so their lazy-loading path can be observed.
const OTHER_LOCALE = 'ko';

describe('locale namespace loader', () => {
  it('starts with no catalog for a locale that has not been requested', () => {
    expect(loadedNamespaces(OTHER_LOCALE, STUDIO_NAMESPACES)).toEqual([]);
  });

  it('materializes only the requested namespaces', async () => {
    const [first, second] = DEFERRED_NAMESPACES;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    await loadNamespaceBundles(OTHER_LOCALE, [first!]);

    expect(i18next.hasResourceBundle(OTHER_LOCALE, first!)).toBe(true);
    expect(i18next.hasResourceBundle(OTHER_LOCALE, second!)).toBe(false);
    expect(i18next.getResourceBundle(OTHER_LOCALE, first!))
      .toEqual(expect.any(Object));
  });

  it('resolves a repeated request without replacing the loaded catalog', async () => {
    const [namespace] = BOOT_NAMESPACES;
    await loadNamespaceBundles(OTHER_LOCALE, [namespace!]);
    const loaded = i18next.getResourceBundle(OTHER_LOCALE, namespace!);

    await loadNamespaceBundles(OTHER_LOCALE, [namespace!, namespace!]);

    expect(i18next.getResourceBundle(OTHER_LOCALE, namespace!)).toBe(loaded);
  });

  it('loads every registered namespace of every locale through one code path', async () => {
    await loadNamespaceBundles(OTHER_LOCALE, STUDIO_NAMESPACES);
    await loadNamespaceBundles(FALLBACK_LOCALE, STUDIO_NAMESPACES);

    expect(loadedNamespaces(OTHER_LOCALE, STUDIO_NAMESPACES))
      .toEqual([...STUDIO_NAMESPACES]);
    expect(loadedNamespaces(FALLBACK_LOCALE, STUDIO_NAMESPACES))
      .toEqual([...STUDIO_NAMESPACES]);
  });
});

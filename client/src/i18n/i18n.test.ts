import { describe, expect, it } from 'vitest';
import {
  FALLBACK_LOCALE,
  normalizeLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from './locale';
import {
  namespaceFileName,
  STUDIO_NAMESPACES,
  type StudioNamespace,
} from './namespaces';

function flattenResource(
  value: object,
  prefix = '',
  output = new Map<string, string>(),
): Map<string, string> {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'string') {
      output.set(path, child);
    } else {
      flattenResource(child as object, path, output);
    }
  }
  return output;
}

async function readCatalog(
  locale: SupportedLocale,
): Promise<Map<string, string>> {
  const flattened = new Map<string, string>();
  for (const namespace of STUDIO_NAMESPACES) {
    const file = namespaceFileName(namespace);
    const module = await import(`./locales/${locale}/${file}.ts`) as
      Record<StudioNamespace, object>;
    flattenResource(module[namespace], namespace, flattened);
  }
  return flattened;
}

describe('Studio locales', () => {
  it('resolves an explicit supported preference before the browser language', () => {
    expect(resolveLocale({
      storedLocale: 'ko-KR',
      preferredLanguages: ['en-US'],
    })).toBe('ko');
  });

  it('normalizes supported regional languages and falls back to English', () => {
    expect(normalizeLocale('en-GB')).toBe('en');
    expect(normalizeLocale('ko_KR')).toBe('ko');
    expect(resolveLocale({ preferredLanguages: ['fr-FR', 'ja-JP'] })).toBe(FALLBACK_LOCALE);
    expect(FALLBACK_LOCALE).toBe('en');
  });

  // With lazy namespaces, fallback resources must not conceal missing keys.
  // Compare every registered locale with the fallback locale, rather than checking
  // only Korean, so adding a locale with incomplete namespaces
  // fails this check.
  it('keeps every supported locale key-for-key equivalent to the fallback locale', async () => {
    const fallback = await readCatalog(FALLBACK_LOCALE);
    expect(fallback.size).toBeGreaterThan(0);
    expect([...fallback.values()].every((value) => value.trim().length > 0))
      .toBe(true);

    for (const locale of SUPPORTED_LOCALES) {
      if (locale === FALLBACK_LOCALE) continue;
      const catalog = await readCatalog(locale);
      expect([...catalog.keys()], `${locale} keys`)
        .toEqual([...fallback.keys()]);
      expect(
        [...catalog.values()].every((value) => value.trim().length > 0),
        `${locale} values`,
      ).toBe(true);
    }
  });
});

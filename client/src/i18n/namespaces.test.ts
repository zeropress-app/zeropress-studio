import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from './locale';
import {
  BOOT_NAMESPACES,
  DEFERRED_NAMESPACES,
  namespaceFileName,
  STUDIO_NAMESPACES,
  type StudioNamespace,
} from './namespaces';

const I18N_DIR = dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = resolve(I18N_DIR, '..');

function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return candidates.find((candidate) => (
    /\.(ts|tsx)$/.test(candidate) && existsSync(candidate)
  )) ?? null;
}

/**
 * Collect only static value imports. Type-only imports are absent at runtime, and dynamic imports
 * create separate chunks.
 */
function staticValueImports(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:^|\n)\s*import\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (/\bimport\s+type\b/.test(match[0])) continue;
    specifiers.push(match[1] ?? '');
  }
  return specifiers.filter(Boolean);
}

function namespacesUsedIn(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/useTranslation\(\s*'([^']+)'/g)) {
    found.add(m[1] ?? '');
  }
  for (const m of source.matchAll(/useTranslation\(\s*\[([^\]]+)\]/g)) {
    for (const n of (m[1] ?? '').matchAll(/'([^']+)'/g)) found.add(n[1] ?? '');
  }
  for (const m of source.matchAll(/\bns:\s*'([^']+)'/g)) found.add(m[1] ?? '');
  for (const m of source.matchAll(/getFixedT\([^)]*?'([^']+)'\s*\)/g)) {
    found.add(m[1] ?? '');
  }
  for (const m of source.matchAll(/<Trans[^>]*\sns="([^"]+)"/g)) {
    found.add(m[1] ?? '');
  }
  for (const m of source.matchAll(/\bt\(\s*'([a-zA-Z][a-zA-Z0-9]*):/g)) {
    found.add(m[1] ?? '');
  }
  found.delete('');
  return found;
}

type ModuleGraph = { files: Set<string>; namespaces: Set<string> };

function walkStaticGraph(entryRelative: string): ModuleGraph {
  const files = new Set<string>();
  const namespaces = new Set<string>();
  const queue = [resolve(CLIENT_SRC, entryRelative)];

  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    for (const namespace of namespacesUsedIn(source)) namespaces.add(namespace);
    for (const specifier of staticValueImports(source)) {
      const target = resolveModule(file, specifier);
      if (target) queue.push(target);
    }
  }

  return { files, namespaces };
}

function localeCatalogFiles(graph: ModuleGraph): string[] {
  const prefix = resolve(I18N_DIR, 'locales');
  return [...graph.files]
    .filter((file) => file.startsWith(`${prefix}/`))
    .map((file) => file.slice(prefix.length + 1))
    .sort();
}

const eagerGraph = walkStaticGraph('main.tsx');

describe('Studio message catalog namespaces', () => {
  it('registers every catalog file in every supported locale exactly once', () => {
    const expectedFiles = [...STUDIO_NAMESPACES]
      .map((namespace) => `${namespaceFileName(namespace)}.ts`)
      .sort();

    for (const locale of SUPPORTED_LOCALES) {
      const actualFiles = readdirSync(resolve(I18N_DIR, 'locales', locale))
        .filter((file) => file.endsWith('.ts'))
        .sort();
      expect(actualFiles, `${locale} catalog files`).toEqual(expectedFiles);
    }

    expect(new Set(STUDIO_NAMESPACES).size).toBe(STUDIO_NAMESPACES.length);
  });

  it('exports each namespace under its own name so the loader can find it', () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const namespace of STUDIO_NAMESPACES) {
        const file = resolve(
          I18N_DIR,
          'locales',
          locale,
          `${namespaceFileName(namespace)}.ts`,
        );
        const source = readFileSync(file, 'utf8');
        expect(
          source.includes(`export const ${namespace} =`),
          `${locale}/${namespace}`,
        ).toBe(true);
      }
    }
  });

  it('splits the registry into disjoint boot and deferred sets', () => {
    const boot = new Set<string>(BOOT_NAMESPACES);
    const deferred = new Set<string>(DEFERRED_NAMESPACES);

    expect(boot.size).toBe(BOOT_NAMESPACES.length);
    expect(deferred.size).toBe(DEFERRED_NAMESPACES.length);
    expect([...deferred].filter((namespace) => boot.has(namespace))).toEqual([]);
    expect(boot.size + deferred.size).toBe(STUDIO_NAMESPACES.length);
  });

  // This check defines the boot set. If an eager path starts using a new namespace,
  // first consider whether the screen should remain lazy before
  // adding that namespace to the boot list.
  it('keeps the eager module graph within the boot namespaces', () => {
    const boot = new Set<string>(BOOT_NAMESPACES);
    const eagerlyUsed = [...eagerGraph.namespaces].sort();

    expect(eagerlyUsed.filter((namespace) => !boot.has(namespace))).toEqual([]);
  });

  // Fix which catalogs enter the initial bundle. Statically importing anything
  // beyond the fallback locale's boot catalogs would make first-paint cost
  // grow with the number of supported locales.
  it('bundles only the fallback locale boot catalog into the eager graph', () => {
    const expected = [...BOOT_NAMESPACES]
      .map((namespace) => `en/${namespaceFileName(namespace)}.ts`)
      .sort();

    expect(localeCatalogFiles(eagerGraph)).toEqual(expected);
  });

  it('declares the deferred namespaces every lazy route actually needs', () => {
    const boot = new Set<string>(BOOT_NAMESPACES);

    // AuthenticatedApplication uses lazyScreen. App's Operations parent loads
    // its namespaces before child screens inherit them.
    // Inspect both patterns so newly added routes cannot
    // escape the check.
    const shellSource = readFileSync(
      resolve(CLIENT_SRC, 'AuthenticatedApplication.tsx'),
      'utf8',
    );
    const shellDeclarations = [...shellSource.matchAll(
      /lazyScreen\(\s*async \(\) => \(\{[\s\S]*?await import\('\.\/([^']+)'\)[\s\S]*?\}\),\s*\[([^\]]*)\],\s*\)/g,
    )];
    const shellCallSites = shellSource.match(/=\s*lazyScreen\(/g)?.length ?? 0;
    expect(shellCallSites).toBeGreaterThan(0);
    expect(shellDeclarations).toHaveLength(shellCallSites);

    const appSource = readFileSync(resolve(CLIENT_SRC, 'App.tsx'), 'utf8');
    const appBoundaryDeclarations = [...appSource.matchAll(
      /lazy\(async \(\) => \{[\s\S]*?import\('\.\/([^']+)'\)[\s\S]*?ensureNamespaces\(\s*\[([^\]]*)\]\s*\)[\s\S]*?\}\)/g,
    )];
    const appChildDeclarations = [...appSource.matchAll(
      /=\s*lazy\(async \(\) => \(\{[\s\S]*?await import\('\.\/([^']+)'\)[\s\S]*?\}\)\);/g,
    )];
    const appCallSites = appSource.match(/=\s*lazy\(/g)?.length ?? 0;
    expect(appBoundaryDeclarations).toHaveLength(1);
    expect(appBoundaryDeclarations.length + appChildDeclarations.length)
      .toBe(appCallSites);

    const shellScreens = shellDeclarations.map((match) => ({
      screen: match[1] ?? '',
      declared: [...(match[2] ?? '').matchAll(/'([^']+)'/g)]
        .map((namespace) => namespace[1] ?? '')
        .sort(),
    }));

    for (const { screen, declared } of shellScreens) {
      const required = [...walkStaticGraph(`${screen}.tsx`).namespaces]
        .filter((namespace) => !boot.has(namespace))
        .sort();
      expect(declared, `${screen} declares its deferred namespaces`)
        .toEqual(required);
    }

    const appBoundaryNamespaces = new Set(
      [...(appBoundaryDeclarations[0]?.[2] ?? '').matchAll(/'([^']+)'/g)]
        .map((namespace) => namespace[1] ?? ''),
    );
    const appRequiredNamespaces = new Set<string>();
    const appBoundaryScreen = appBoundaryDeclarations[0]?.[1] ?? '';
    for (const namespace of walkStaticGraph(
      `${appBoundaryScreen}.tsx`,
    ).namespaces) {
      if (!boot.has(namespace)) appRequiredNamespaces.add(namespace);
    }
    for (const match of appChildDeclarations) {
      const screen = match[1] ?? '';
      for (const namespace of walkStaticGraph(`${screen}.tsx`).namespaces) {
        if (!boot.has(namespace)) appRequiredNamespaces.add(namespace);
      }
    }
    expect([...appBoundaryNamespaces].sort(), (
      `${appBoundaryScreen} covers its nested lazy routes`
    )).toEqual([...appRequiredNamespaces].sort());
  });

  it('derives catalog file names without a second hand-written table', () => {
    expect(namespaceFileName('common' as StudioNamespace)).toBe('common');
    expect(namespaceFileName('wxrImport' as StudioNamespace)).toBe('wxr-import');
    expect(namespaceFileName('edgeSecuritySettings' as StudioNamespace))
      .toBe('edge-security-settings');
  });
});

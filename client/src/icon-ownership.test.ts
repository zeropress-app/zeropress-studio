import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describe,
  expect,
  it,
} from 'vitest';

const SOURCE_ROOT = fileURLToPath(new URL('.', import.meta.url));

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return [path];
  });
}

const sources = walk(SOURCE_ROOT)
  .filter((path) => path.endsWith('.tsx') && !path.endsWith('.test.tsx'))
  .map((path) => ({
    path: path.slice(SOURCE_ROOT.length),
    source: readFileSync(path, 'utf8'),
  }));

describe('Studio icon ownership', () => {
  it('uses shared icons for general-purpose SVG outside product identity and data charts', () => {
    const offenders = sources
      .filter(({ path, source }) => (
        path !== 'components/LogoMark.tsx'
        && path !== 'components/AnalyticsTrendChart.tsx'
        && /<svg\b/u.test(source)
      ))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('renders LogoMark only through the shared LogoBadge that owns its background', () => {
    const offenders = sources
      .filter(({ path, source }) => (
        path !== 'components/LogoBadge.tsx'
        && /(?:import\s*\{\s*LogoMark\s*\}|<LogoMark\b)/u.test(source)
      ))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('keeps the full Lucide catalog and dynamic loader out of the bundle', () => {
    const offenders = sources
      .filter(({ source }) => (
        /import\s+\*\s+as\s+\w+\s+from\s+['"]lucide-react['"]/u.test(source)
        || /from\s+['"]lucide-react\/dynamic['"]/u.test(source)
        || /\bDynamicIcon\b/u.test(source)
      ))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it('routes screen-level Lucide usage through the shared accessibility wrapper', () => {
    const offenders = sources
      .filter(({ path, source }) => (
        path !== 'components/primitives/StudioIcon.tsx'
        && /from\s+['"]lucide-react['"]/u.test(source)
        && !/\bStudioIcon\b/u.test(source)
        && !/<OperationsPageHeading\b/u.test(source)
      ))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describe,
  expect,
  it,
} from 'vitest';

/**
 * Screens reuse existing primitives instead of implementing them again.
 *
 * Extend the ownership checks in `modal-ownership.test.ts` to other primitives.
 * Duplicate markup can drift in behavior, such as a custom switch toggling
 * when a link inside its label is clicked.
 *
 * Detect these implementations by signature, and add a signature when a new
 * primitive is introduced.
 */

const SOURCE_ROOT = fileURLToPath(new URL('.', import.meta.url));

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return [path];
  });
}

const files = walk(SOURCE_ROOT).map((path) => ({
  path: path.slice(SOURCE_ROOT.length),
  source: readFileSync(path, 'utf8'),
}));

const sources = files.filter(({ path }) => path.endsWith('.tsx')
  && !path.endsWith('.test.tsx'));

const stylesheets = files.filter(({ path }) => path.endsWith('.css'));

/**
 * Markup signatures.
 *
 * `owners` lists files allowed to create this markup. Exclude tests because
 * they need to exercise primitive behavior.
 */
const MARKUP: ReadonlyArray<{
  label: string;
  primitive: string;
  pattern: RegExp;
  owners: readonly string[];
}> = [
  {
    label: 'switch',
    primitive: 'Switch',
    // role="switch" identifies a custom switch implementation.
    pattern: /role="switch"/u,
    owners: ['components/primitives/Switch.tsx'],
  },
  {
    label: 'table',
    primitive: 'DataTable',
    // A div-based table duplicates alignment, scrolling, and responsive behavior.
    pattern: /role="(?:table|row|columnheader|cell|rowheader)"/u,
    owners: [],
  },
  {
    label: 'tabs',
    primitive: 'Tabs / FilterTabs',
    pattern: /role="tablist"/u,
    owners: [
      'components/primitives/Tabs.tsx',
      'components/primitives/FilterTabs.tsx',
    ],
  },
  {
    label: 'action menu',
    primitive: 'ActionMenu',
    pattern: /role="menu(?:item)?"/u,
    owners: ['components/primitives/ActionMenu.tsx'],
  },
  {
    label: 'route loading screen',
    primitive: 'RouteLoading',
    // Owns the main landmark and skip-link target while route content is loading.
    // Keep the loading frame in one shared component.
    pattern: /className="studio-route-loading"/u,
    owners: ['components/primitives/RouteLoading.tsx'],
  },
];

/**
 * Style signatures.
 *
 * Screen-specific copies of primitive styling would miss changes to the
 * shared primitive.
 */
const STYLES: ReadonlyArray<{
  label: string;
  primitive: string;
  /** Stylesheets allowed to own this appearance; `primitives.css` is always exempt. */
  owners?: readonly string[];
  test: (selector: string, body: string) => boolean;
}> = [
  {
    label: 'switch track',
    primitive: 'Switch',
    // The combination of appearance: none and a pill-shaped replacement checkbox.
    test: (selector, body) => /\binput\b/u.test(selector)
      && /appearance:\s*none/u.test(body),
  },
  {
    label: 'horizontally scrolling table',
    primitive: 'DataTable',
    test: (selector, body) => /\btable\b/u.test(selector)
      && /overflow-x:\s*auto/u.test(body),
  },
  {
    label: 'inline status',
    primitive: 'InlineStatus',
    /*
     * A horizontal, vertically centered row in muted text with no padding,
     * border, or background is the shared inline status pattern.
     *
     * Bordered or filled status containers, such as `operations-upgrade-state`,
     * are a different pattern and are excluded when those declarations appear.
     */
    test: (_selector, body) => /display:\s*flex/u.test(body)
      && /align-items:\s*center/u.test(body)
      && /color:\s*var\(--studio-text-muted\)/u.test(body)
      && !/\b(?:border|padding|background|justify-content)/u.test(body),
  },
  {
    label: 'page column',
    primitive: 'shell route frame',
    owners: [
      'shell.css',
      // Pre-authentication screens render outside the shell and own their frame.
      'screens/auth.css',
      'screens/auth-setup.css',
      // Operations also renders outside the shell. `operations-page-column.test.ts`
      // separately verifies that its frame uses shared tokens.
      'screens/operations.css',
    ],
    /*
     * A centered container with an explicit width identifies a page frame.
     * Screen-specific copies can drift to different widths even within the same
     * management section.
     *
     * Centering without a width constraint is not a page frame and is excluded.
     */
    test: (_selector, body) => (
      /margin:\s*0\s+auto|margin-inline:\s*auto/u.test(body)
      && /(?:^|;)\s*(?:max-)?width:/u.test(body)
    ),
  },
];

describe('Primitive ownership', () => {
  it('routes screen notifications through the shared toast primitive', () => {
    const offenders = sources
      .filter(({ path, source }) => (
        path !== 'components/primitives/StudioToast.tsx'
        && /from\s+['"]sonner['"]/u.test(source)
      ))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it.each(MARKUP)(
    'lets only $primitive own $label markup',
    ({ pattern, owners }) => {
      const offenders = sources
        .filter(({ path, source }) => !owners.includes(path)
          && pattern.test(source))
        .map(({ path }) => path);
      expect(offenders).toEqual([]);
    },
  );

  it.each(STYLES)(
    'lets only $primitive style $label',
    ({ owners, test }) => {
      const offenders: string[] = [];
      for (const { path, source } of stylesheets) {
        if (path === 'primitives.css') continue;
        if (owners?.includes(path)) continue;
        for (const [, selector, body] of source
          .matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
          if (test(selector, body)) {
            offenders.push(`${path} :: ${selector.trim().replace(/\s+/gu, ' ')}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    },
  );
});

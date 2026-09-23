import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Standalone screens use the shared page column.
 *
 * Operations renders at `/system/operations` outside StudioShell and cannot
 * inherit `studio-route-content`. Its own body wrapper provides the page
 * width and gutters. The first hero also owns controls instead of a topbar.
 *
 * One authenticated parent layout owns the token and state, with six subpaths
 * rendered through Outlet. Desktop navigation and the select picker at widths
 * of 900px or less expose the same destinations.
 *
 * Browser tests verify geometry; this test ensures the layout uses shared
 * tokens so standalone screens stay aligned with the shell.
 */

const OPERATIONS = readFileSync(
  fileURLToPath(new URL('./screens/operations.css', import.meta.url)),
  'utf8',
);
const MARKUP = readFileSync(
  fileURLToPath(new URL('./OperationsPage.tsx', import.meta.url)),
  'utf8',
);
const NAVIGATION = readFileSync(
  fileURLToPath(
    new URL('./operations/OperationsNavigation.tsx', import.meta.url),
  ),
  'utf8',
);
const DATABASE_PAGE = readFileSync(
  fileURLToPath(
    new URL('./operations/OperationsDatabasePage.tsx', import.meta.url),
  ),
  'utf8',
);
const EDGE_PAGE = readFileSync(
  fileURLToPath(
    new URL('./operations/OperationsEdgePage.tsx', import.meta.url),
  ),
  'utf8',
);
const ACCESS_SHELL = readFileSync(
  fileURLToPath(
    new URL('./components/OperationsAccessShell.tsx', import.meta.url),
  ),
  'utf8',
);

function ruleBodyFrom(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} rule not found`);
  return source.slice(start, source.indexOf('\n}', start));
}

function ruleBody(selector: string): string {
  return ruleBodyFrom(OPERATIONS, selector);
}

function mediaBody(maxWidth: number): string {
  const marker = `@media (max-width: ${maxWidth}px) {`;
  const start = OPERATIONS.indexOf(marker);
  if (start < 0) throw new Error(`${marker} rule not found`);
  const next = OPERATIONS.indexOf('@media ', start + marker.length);
  return OPERATIONS.slice(start, next < 0 ? undefined : next);
}

describe('Operations dashboard page column', () => {
  it('shares the Studio sign-in frame for token authentication', () => {
    expect(ACCESS_SHELL).toContain('auth-shell auth-shell-login');
    expect(ACCESS_SHELL).toContain('auth-frame auth-frame-login');
    expect(ACCESS_SHELL).toContain(
      'auth-form-panel auth-form-panel-login',
    );
  });

  it('applies the body wrapper class in markup', () => {
    // The class must be present for its layout rules to apply.
    expect(MARKUP).toContain('className="operations-body"');
  });

  it('uses shared tokens for the body column', () => {
    const body = ruleBody('.operations-body');
    expect(body).toContain('var(--studio-standalone-page-width)');
    expect(body).toContain('var(--studio-page-gutter)');
    // Center the column so it does not hug the left edge on wide screens.
    expect(body).toMatch(/margin:\s*0\s+auto/u);
  });

  it('lets the first hero own branding and controls', () => {
    expect(MARKUP).toContain('className="operations-hero-toolbar"');
    expect(MARKUP).toContain('className="operations-hero-actions"');
  });

  it('lets the parent layout own navigation and Outlet', () => {
    expect(MARKUP).toMatch(/<OperationsNavigation\s[^>]*disabled=\{operationsBusy\}/u);
    expect(MARKUP).toContain('<Outlet');
    expect(MARKUP).toContain('satisfies OperationsOutletContext');
    expect(ruleBody('.operations-layout'))
      .toContain('232px minmax(0, 1fr)');
    expect(ruleBody('.operations-navigation,\n.operations-route'))
      .toContain('min-width: 0');
  });

  it('builds all six Operations destinations from one navigation list', () => {
    const sectionKeys = [...NAVIGATION.matchAll(
      /\{ key: '(overview|access|database|edge|recovery|danger)'/gu,
    )].map((match) => match[1]);

    expect(sectionKeys).toEqual([
      'overview',
      'access',
      'database',
      'edge',
      'recovery',
      'danger',
    ]);
    expect(NAVIGATION).toContain('<NavLink');
    expect(NAVIGATION).toContain('OPERATIONS_PATHS[section.key]');
  });

  it('uses a picker with the same destinations at 900px and below', () => {
    expect(ruleBody('.operations-navigation-picker'))
      .toContain('display: none');
    expect(ruleBody('.operations-navigation-sections'))
      .toContain('display: grid');

    const compact = mediaBody(900);
    expect(ruleBodyFrom(compact, '.operations-layout'))
      .toContain('grid-template-columns: minmax(0, 1fr)');
    expect(ruleBodyFrom(compact, '.operations-navigation-picker'))
      .toContain('display: block');
    expect(ruleBodyFrom(compact, '.operations-navigation-sections'))
      .toContain('display: none');
    expect(NAVIGATION).toContain('<select');
    expect(NAVIGATION).toContain('void navigate(event.target.value)');
  });

  it('keeps subpage content within the column on narrow screens', () => {
    // Implicit grid columns use `auto` and can expand to a table panel's min-content width.
    expect(ruleBody('.operations-stack')).toContain('minmax(0, 1fr)');
    expect(DATABASE_PAGE).toContain('className="operations-stack"');
    expect(EDGE_PAGE).toContain('className="operations-stack"');
  });

  it('wraps the hero toolbar on narrow screens and uses the shared locale switcher', () => {
    expect(ruleBody('.operations-hero-toolbar'))
      .toContain('flex-wrap: wrap');
    expect(ruleBody('.operations-hero-actions'))
      .toMatch(/flex:\s*0\s+0\s+auto/u);
    expect(MARKUP).toContain('<LocaleSwitcher');
  });
});

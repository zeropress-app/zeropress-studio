import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describe,
  expect,
  it,
} from 'vitest';

/**
 * Ensure referenced classes have CSS definitions.
 *
 * Removing a screen's old styles can silently break another screen that uses
 * the same class. Check that every static `className` has a definition in a
 * stylesheet.
 */

const SOURCE_ROOT = fileURLToPath(new URL('.', import.meta.url));

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return [path];
  });
}

const files = walk(SOURCE_ROOT);

const stylesheets = files
  .filter((path) => path.endsWith('.css'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');

const definedClasses = new Set(
  [...stylesheets.matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)].map((m) => m[1]),
);

/**
 * Register dynamically assembled primitive and state classes that cannot
 * be reconstructed reliably from static markup.
 */
const DYNAMIC_CLASSES = new Set([
  // State suffixes assembled as `is-${autosave.status}`.
  'is-idle', 'is-saving', 'is-saved', 'is-failed', 'is-disabled',
  // Assigned by the visual editor runtime and its media placeholders.
  'studio-visual-embed-placeholder', 'studio-visual-editor-surface',
  'sun-editor', 'sun-editor-editable', 'se-container', 'se-toolbar',
  'se-btn-module-border', 'se-menu-list', 'se-tooltip', 'se-tooltip-inner', 'se-tooltip-text',
  // SunEditor image attributes serialize to WordPress-compatible HTML classes.
  'alignleft', 'aligncenter', 'alignright',
]);

function classNamesInSource(): Map<string, string[]> {
  const usage = new Map<string, string[]>();
  for (const path of files) {
    if (!path.endsWith('.tsx')) continue;
    if (path.endsWith('.test.tsx')) continue;
    const source = readFileSync(path, 'utf8');
    // Check only static className strings. Exclude names assembled in template
    // literals because an isolated prefix would produce false positives.
    for (const match of source.matchAll(/className="([^"{}]+)"/gu)) {
      for (const name of match[1].split(/\s+/u).filter(Boolean)) {
        const seen = usage.get(name) ?? [];
        seen.push(path.slice(SOURCE_ROOT.length));
        usage.set(name, seen);
      }
    }
  }
  return usage;
}

/**
 * Collect definitions for the reverse check.
 *
 * `definedClasses` also scans comments and URLs, treating `.woff2` and `.txt`
 * as classes. To identify unused rules, remove comments first and collect
 * names only from selectors.
 */
function classesDeclaredInSelectors(): Map<string, string[]> {
  const declared = new Map<string, string[]>();
  for (const path of files) {
    if (!path.endsWith('.css')) continue;
    // The sandboxed body document contains authored and renderer-generated classes.
    if (path.endsWith('/editor/content-preview-body.css')) continue;
    const sheet = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
    for (const [, selector] of sheet.matchAll(/([^{}]+)\{[^{}]*\}/gu)) {
      for (const [, name] of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/gu)) {
        const seen = declared.get(name) ?? [];
        seen.push(path.slice(SOURCE_ROOT.length));
        declared.set(name, seen);
      }
    }
  }
  return declared;
}

/** All name fragments in markup, including prefixes assembled in template literals. */
function namesUsedInMarkup(): { tokens: Set<string>; prefixes: string[] } {
  const tokens = new Set<string>();
  const prefixes = new Set<string>();
  for (const path of files) {
    if (!path.endsWith('.tsx') || path.endsWith('.test.tsx')) continue;
    const source = readFileSync(path, 'utf8');
    for (const [name] of source.matchAll(/[a-zA-Z][\w-]*/gu)) tokens.add(name);
    // Names such as `studio-spinner-${size}` leave only their prefix in source.
    for (const [, prefix] of source.matchAll(/([a-zA-Z][\w-]*-)\$\{/gu)) {
      prefixes.add(prefix);
    }
  }
  return { tokens, prefixes: [...prefixes] };
}

describe('CSS class references', () => {
  const usage = classNamesInSource();

  it('uses classes with stylesheet definitions', () => {
    // All referenced classes now have stylesheet definitions.
    // No screen-specific exceptions remain.
    const orphans = [...usage.entries()]
      .filter(([name]) => !definedClasses.has(name)
        && !DYNAMIC_CLASSES.has(name))
      .map(([name, where]) => `${name} (${[...new Set(where)].join(', ')})`);
    expect(orphans).toEqual([]);
  });

  it('keeps only rules referenced by markup', () => {
    /*
     * Check the reverse direction for rules left behind after screen changes.
     * Unused rules increase the bundle without styling any markup.
     *
     * Treat any matching name fragment as usage to avoid mistaking dynamically
     * assembled classes for dead code. This catches only wholly unused rules.
     */
    const { tokens, prefixes } = namesUsedInMarkup();
    const unused = [...classesDeclaredInSelectors().entries()]
      .filter(([name]) => !tokens.has(name)
        && !DYNAMIC_CLASSES.has(name)
        && !prefixes.some((prefix) => name.startsWith(prefix)))
      .map(([name, where]) => `${name} (${[...new Set(where)].join(', ')})`);
    expect(unused).toEqual([]);
  });
});

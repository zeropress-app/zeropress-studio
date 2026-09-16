import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describe,
  expect,
  it,
} from 'vitest';

/**
 * Shared primitives own modal behavior.
 *
 * `Dialog` portals into the modal layer and makes the background `inert` while
 * open. Screens that create their own `role="dialog"` markup bypass this
 * protection and can diverge in focus trapping and Escape handling.
 */

const SOURCE_ROOT = fileURLToPath(new URL('.', import.meta.url));

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return [path];
  });
}

const files = walk(SOURCE_ROOT)
  .filter((path) => path.endsWith('.tsx') && !path.endsWith('.test.tsx'))
  .map((path) => ({ path: path.slice(SOURCE_ROOT.length), source: readFileSync(path, 'utf8') }));

/** Components allowed to own modal markup. */
const MODAL_OWNERS = new Set([
  'components/primitives/Dialog.tsx',
  // The mobile navigation drawer uses its own layout instead of Dialog's
  // appearance, but shares the same hook and modal layer for consistent behavior.
  'components/StudioShell.tsx',
]);


describe('Modal ownership', () => {
  it('keeps modal markup in the shared primitives', () => {
    // All modal implementations now use the shared ownership model.
    // No screen-specific exceptions remain.
    const handRolled = files
      .filter(({ path, source }) => !MODAL_OWNERS.has(path)
        && /role="dialog"/u.test(source))
      .map(({ path }) => path);
    expect(handRolled).toEqual([]);
  });

  it('keeps background locking in the shared modal layer', () => {
    // Screens must not manage `inert` themselves. Locking only `main` leaves
    // the sidebar and header reachable by keyboard while a modal is open.
    // `Dialog` applies the lock consistently to every sibling outside
    // the modal layer.
    const passingInert = files
      .filter(({ source }) => /\binert=\{/u.test(source))
      .map(({ path }) => path);
    expect(passingInert).toEqual([]);
  });
});

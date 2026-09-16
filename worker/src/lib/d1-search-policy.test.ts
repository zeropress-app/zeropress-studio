import { readdirSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';

function workerSourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const url = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
    if (entry.isDirectory()) return workerSourceFiles(url);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [url];
  });
}

describe('D1 administrator search policy', () => {
  it('does not bind LIKE or GLOB patterns from Worker source', () => {
    const sourceRoot = new URL('../', import.meta.url);
    const offenders = workerSourceFiles(sourceRoot).flatMap((url) => {
      const source = readFileSync(url, 'utf8');
      return /\b(?:LIKE|GLOB)\s+\?/iu.test(source)
        ? [url.pathname.slice(sourceRoot.pathname.length)]
        : [];
    });

    // D1 limits LIKE/GLOB patterns to 50 UTF-8 bytes. Administrator contains
    // searches use instr(lower(column), lower(?)) so valid multilingual input
    // cannot become a database-level failure at that platform boundary.
    expect(offenders).toEqual([]);
  });
});

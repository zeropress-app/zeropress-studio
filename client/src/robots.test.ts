import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Studio crawler policy', () => {
  it('disallows every crawler from every Studio route', () => {
    const robots = readFileSync(
      resolve(process.cwd(), 'client/public/robots.txt'),
      'utf8',
    );

    expect(robots).toBe('User-agent: *\nDisallow: /\n');
  });
});

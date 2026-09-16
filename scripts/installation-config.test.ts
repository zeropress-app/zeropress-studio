import { readFileSync } from 'node:fs';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';

type InstallationConfig = {
  assets?: { run_worker_first?: boolean | string[] };
  triggers?: { crons?: string[] };
};

function readInstallationConfig(): InstallationConfig {
  return parse(readFileSync(
    new URL('../wrangler.jsonc', import.meta.url),
    'utf8',
  )) as InstallationConfig;
}

describe('Installation configuration', () => {
  it('registers a schedule for the maintenance collectors', () => {
    expect(readInstallationConfig().triggers?.crons).toEqual(
      expect.arrayContaining([expect.stringMatching(/\S/u)]),
    );
  });

  it('registers API and managed Media paths for Worker routing', () => {
    expect(readInstallationConfig().assets?.run_worker_first).toEqual(
      expect.arrayContaining(['/api/*', '/__zeropress_media__/*']),
    );
  });
});

import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let root;

function environment(overrides = {}) {
  return {
    ...process.env,
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
    NODE_DISABLE_COLORS: undefined,
    CLOUDFLARE_ENV: '',
    npm_config_update_notifier: 'false',
    ...overrides,
  };
}

function initialize(env = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts/init-dev-vars.mjs')], {
    cwd: root, encoding: 'utf8', env: environment(env),
  });
}

function run(command) {
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', command], {
    cwd: root, encoding: 'utf8', env: environment(),
  });
}

function readVariables() {
  return Object.fromEntries(readFileSync(join(root, '.dev.vars'), 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('=')));
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-dev-vars-')));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(
    join(repositoryRoot, 'scripts/init-dev-vars.mjs'),
    join(root, 'scripts/init-dev-vars.mjs'),
  );
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  // Keep npm's real lifecycle hooks; replace only the long-running Vite commands.
  manifest.scripts.dev = 'node vite-stub.mjs';
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'vite-stub.mjs'), `
    import { existsSync, writeFileSync } from 'node:fs';
    writeFileSync('vite-call.json', JSON.stringify({
      args: process.argv.slice(2),
      devVarsPresent: existsSync('.dev.vars'),
    }));
  `);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('local development settings', () => {
  it('creates initial settings before Vite starts and preserves them on restart', () => {
    const first = run('dev');
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'vite-call.json'), 'utf8')))
      .toEqual({ args: [], devVarsPresent: true });
    const contents = readFileSync(join(root, '.dev.vars'), 'utf8');
    const variables = readVariables();
    expect(variables).toEqual({
      STUDIO_SITE_MODE: 'initial',
      STUDIO_AUTH_SECRET: expect.stringMatching(/^[a-f0-9]{64}$/u),
      STUDIO_INSTALL_TOKEN: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(variables.STUDIO_AUTH_SECRET).not.toBe(variables.STUDIO_INSTALL_TOKEN);
    expect(first.stdout).toContain('Created .dev.vars for local development.');
    for (const secret of [variables.STUDIO_AUTH_SECRET, variables.STUDIO_INSTALL_TOKEN]) {
      expect(first.stdout + first.stderr).not.toContain(secret);
    }
    if (process.platform !== 'win32') {
      expect(statSync(join(root, '.dev.vars')).mode & 0o777).toBe(0o600);
    }

    const second = run('dev');
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(join(root, '.dev.vars'), 'utf8')).toBe(contents);
  });

  it.each([
    { file: '.dev.vars', contents: '' },
    { file: '.dev.vars', contents: 'STUDIO_SITE_MODE=operational\n' },
    { file: '.env', contents: 'STUDIO_SITE_MODE=maintenance\n' },
    { file: '.env.local', contents: 'STUDIO_SITE_MODE=recovery\n' },
    { file: '.dev.vars.review', contents: 'STUDIO_SITE_MODE=operational\n' },
    { file: '.env.review', contents: 'STUDIO_SITE_MODE=maintenance\n' },
    { file: '.env.review.local', contents: 'STUDIO_SITE_MODE=recovery\n' },
  ])('preserves existing settings in $file without adding values', ({ file, contents }) => {
    writeFileSync(join(root, file), contents);
    const result = initialize({ CLOUDFLARE_ENV: 'review' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, file), 'utf8')).toBe(contents);
    if (file !== '.dev.vars') {
      // Creating this higher-priority file would hide the existing settings.
      expect(existsSync(join(root, '.dev.vars'))).toBe(false);
    }
  });

  it('generates new secrets for a fresh environment', () => {
    expect(initialize().status).toBe(0);
    const first = readVariables();
    rmSync(join(root, '.dev.vars'));
    expect(initialize().status).toBe(0);
    const second = readVariables();
    expect(new Set([
      first.STUDIO_AUTH_SECRET, first.STUDIO_INSTALL_TOKEN,
      second.STUDIO_AUTH_SECRET, second.STUDIO_INSTALL_TOKEN,
    ]).size).toBe(4);
  });

  it('highlights the created environment file when colors are enabled', () => {
    const result = initialize({ FORCE_COLOR: '1' });
    expect(result.status, result.stderr).toBe(0);
    expect(stripVTControlCharacters(result.stdout).trim()).toBe('Created .dev.vars for local development.');
    expect(result.stdout).toContain('\u001b[32mCreated ');
    expect(result.stdout).toContain('\u001b[1m.dev.vars\u001b[22m');
  });
});

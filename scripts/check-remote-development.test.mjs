import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let root;

function run(config, args = [], env = {}) {
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify(config));
  return spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['run', 'dev:enable-remote', '--', ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORCE_COLOR: undefined,
        NO_COLOR: undefined,
        NODE_DISABLE_COLORS: undefined,
        CLOUDFLARE_ENV: '',
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG_PATH: join(root, 'wrangler.log'),
        npm_config_update_notifier: 'false',
        ...env,
      },
    },
  );
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-remote-development-')));
  mkdirSync(join(root, 'scripts'));
  for (const file of ['check-remote-development.mjs', 'development-binding-policy.ts']) {
    copyFileSync(join(repositoryRoot, 'scripts', file), join(root, 'scripts', file));
  }
  symlinkSync(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  manifest.scripts['dev:enable-remote'] = manifest.scripts['dev:enable-remote']
    .replace(/^vite /u, 'node vite-stub.mjs ');
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

describe('remote development setup', () => {
  it('blocks npm dev:enable-remote with highlighted opt-in guidance before starting Vite', () => {
    const result = run({}, [], { FORCE_COLOR: '1' });
    expect(result.status).toBe(1);
    const message = [
      'Cannot start remote development.',
      '',
      'No remote bindings are enabled.',
      'In wrangler.jsonc, set "remote": true on the bindings you want to use remotely.',
      'For local development, run npm run dev.',
    ].join('\n');
    expect(stripVTControlCharacters(result.stderr).trim()).toBe(message);
    expect(result.stderr).toContain('\u001b[31mCannot start remote development.');
    expect(result.stderr).toContain('\u001b[1mwrangler.jsonc\u001b[22m');
    expect(result.stderr).toContain('\u001b[36m"remote": true\u001b[39m');
    expect(result.stderr).toContain('\u001b[36mnpm run dev\u001b[39m');
    expect(existsSync(join(root, 'vite-call.json'))).toBe(false);
  });

  it('blocks npm dev:enable-remote with a correction for a mismatched mail queue', () => {
    const config = {
      ai: { binding: 'AI', remote: true },
      queues: {
        producers: [{ binding: 'MAIL_QUEUE', queue: 'first' }],
        consumers: [{ queue: 'second' }],
      },
    };
    const result = run(config);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot start remote development.');
    expect(result.stderr).toContain('MAIL_QUEUE requires one producer and one consumer using the same queue in wrangler.jsonc.');
    expect(existsSync(join(root, 'vite-call.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))).toEqual(config);
  });

  it('starts Vite with caller settings and arguments after an explicit opt-in', () => {
    const config = { ai: { binding: 'AI', remote: true } };
    const result = run(config, ['--port', '5178']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'vite-call.json'), 'utf8'))).toEqual({
      args: ['--mode', 'enable-remote', '--port', '5178'],
      devVarsPresent: false,
    });
    expect(JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'))).toEqual(config);
  });
});

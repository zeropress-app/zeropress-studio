import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let root;
let browserDirectory;

function testEnvironment(overrides = {}) {
  return {
    ...process.env,
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
    NODE_DISABLE_COLORS: undefined,
    PWDEBUG: undefined,
    ZEROPRESS_E2E_UI_OUTPUT_DIR: undefined,
    PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
    npm_config_update_notifier: 'false',
    ...overrides,
  };
}

function run(command = 'test:e2e', args = [], environment = {}) {
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', command, '--', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: testEnvironment(environment),
  });
}

function install(name) {
  writeFileSync(join(browserDirectory, name), '', { mode: 0o755 });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-e2e-command-')));
  browserDirectory = join(root, 'browser-cache');
  mkdirSync(browserDirectory);
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(repositoryRoot, 'scripts/run-e2e.mjs'), join(root, 'scripts/run-e2e.mjs'));
  copyFileSync(join(repositoryRoot, 'package.json'), join(root, 'package.json'));

  const packageDirectory = join(root, 'node_modules/@playwright/test');
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({
    type: 'module', exports: { '.': './index.mjs', './cli': './cli.mjs' },
  }));
  writeFileSync(join(packageDirectory, 'index.mjs'), `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    export const chromium = {
      executablePath: () => join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium'),
      async launch(options) {
        writeFileSync('browser-check.json', JSON.stringify(options));
        if (existsSync('browser-error.txt')) throw new Error(readFileSync('browser-error.txt', 'utf8'));
        if (!existsSync(join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'headless-shell'))) {
          throw new Error("browserType.launch: Executable doesn't exist at headless-shell");
        }
        return { close: async () => writeFileSync('browser-closed', '') };
      },
    };
  `);
  writeFileSync(join(packageDirectory, 'cli.mjs'), `
    import { existsSync, readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const directory = process.env.ZEROPRESS_E2E_UI_OUTPUT_DIR;
    if (directory) {
      writeFileSync(join(directory, 'trace.zip'), 'private trace sentinel');
      writeFileSync('ui-session.txt', directory);
    }
    writeFileSync('playwright-call.json', JSON.stringify({
      args: process.argv.slice(2),
      browserChecked: existsSync('browser-check.json'),
      browserClosed: existsSync('browser-closed'),
    }));
    process.exitCode = existsSync('cli-exit-code') ? Number(readFileSync('cli-exit-code', 'utf8')) : 0;
    if (existsSync('keep-cli-open')) {
      setInterval(() => {}, 1000);
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
          setTimeout(() => {
            writeFileSync('cli-shutdown.json', JSON.stringify({
              signal, traceAvailable: existsSync(join(directory, 'trace.zip')),
            }));
            process.exit(signal === 'SIGINT' ? 130 : 143);
          }, 50);
        });
      }
    }
  `);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('UI trace lifetime', () => {
  it.each([0, 7])('removes only its own output after Playwright exits with status %i', (status) => {
    install('chromium');
    install('headless-shell');
    const otherSession = join(root, '.wrangler/e2e-ui/other-session');
    mkdirSync(otherSession, { recursive: true });
    writeFileSync(join(otherSession, 'trace.zip'), 'another session');
    writeFileSync(join(root, 'cli-exit-code'), String(status));

    const result = run('test:e2e:ui');
    expect(result.status, result.stderr).toBe(status);
    const directory = readFileSync(join(root, 'ui-session.txt'), 'utf8');
    expect(dirname(directory)).toBe(join(root, '.wrangler/e2e-ui'));
    expect(existsSync(directory)).toBe(false);
    expect(readFileSync(join(otherSession, 'trace.zip'), 'utf8')).toBe('another session');
  });

  it.each(['SIGINT', 'SIGTERM'])('keeps traces until Playwright finishes handling %s', async (signal) => {
    install('chromium');
    install('headless-shell');
    writeFileSync(join(root, 'keep-cli-open'), '');
    const child = spawn(process.execPath, ['scripts/run-e2e.mjs', '--ui'], {
      cwd: root, env: testEnvironment(), stdio: 'pipe',
    });
    const exited = once(child, 'exit');
    try {
      await vi.waitFor(() => expect(existsSync(join(root, 'ui-session.txt'))).toBe(true), { timeout: 5000 });
      const directory = readFileSync(join(root, 'ui-session.txt'), 'utf8');
      expect(readFileSync(join(directory, 'trace.zip'), 'utf8')).toBe('private trace sentinel');
      child.kill(signal);
      const [status] = await exited;
      expect(status).toBe(signal === 'SIGINT' ? 130 : 143);
      expect(JSON.parse(readFileSync(join(root, 'cli-shutdown.json'), 'utf8'))).toEqual({
        signal, traceAvailable: true,
      });
      expect(existsSync(directory)).toBe(false);
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await exited;
      }
    }
  });

  it.each(['--ui-port=0', '--ui-host=127.0.0.1'])('cleans up the browser-hosted UI session for %s', (argument) => {
    install('headless-shell');
    const result = run('test:e2e', [argument]);
    expect(result.status, result.stderr).toBe(0);
    const directory = readFileSync(join(root, 'ui-session.txt'), 'utf8');
    expect(existsSync(directory)).toBe(false);
  });

  it('runs ordinary tests independently of an inherited UI output directory', () => {
    install('headless-shell');
    const inherited = join(root, 'inherited-ui-output');
    mkdirSync(inherited);
    writeFileSync(join(inherited, 'trace.zip'), 'existing UI trace');
    const result = run('test:e2e', [], { ZEROPRESS_E2E_UI_OUTPUT_DIR: inherited });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(inherited, 'trace.zip'), 'utf8')).toBe('existing UI trace');
    expect(existsSync(join(root, 'ui-session.txt'))).toBe(false);
  });
});

describe('E2E browser setup', () => {
  it.each([
    { name: 'piped output', env: {}, colored: false },
    { name: 'NO_COLOR', env: { NO_COLOR: '1' }, colored: false },
    { name: 'FORCE_COLOR', env: { FORCE_COLOR: '1' }, colored: true },
  ])('explains the missing headless shell before running tests with $name', ({ env, colored }) => {
    install('chromium');
    const result = run('test:e2e', [], env);
    const message = [
      'Cannot start E2E tests.',
      '',
      'Chromium is not installed for the current Playwright version.',
      'Run npx playwright install chromium, then try again.',
    ].join('\n');
    expect(result.status).toBe(1);
    expect(stripVTControlCharacters(result.stderr).trim()).toBe(message);
    if (colored) {
      expect(result.stderr).toContain('\u001b[31mCannot start E2E tests.');
      expect(result.stderr).toContain('\u001b[36mnpx playwright install chromium\u001b[39m');
    } else {
      expect(result.stderr.trim()).toBe(message);
    }
    expect(existsSync(join(root, 'playwright-call.json'))).toBe(false);
  });

  it('closes the browser check before forwarding arguments and the test exit status', () => {
    install('headless-shell');
    writeFileSync(join(root, 'cli-exit-code'), '7');
    const result = run('test:e2e', ['--grep', 'account security', '--retries', '0']);
    expect(result.status, result.stderr).toBe(7);
    expect(JSON.parse(readFileSync(join(root, 'browser-check.json'), 'utf8'))).toEqual({ headless: true });
    expect(JSON.parse(readFileSync(join(root, 'playwright-call.json'), 'utf8'))).toEqual({
      args: ['test', '--grep', 'account security', '--retries', '0'],
      browserChecked: true,
      browserClosed: true,
    });
  });

  it.each([
    { missing: 'Chromium', installed: 'headless-shell' },
    { missing: 'Headless Shell', installed: 'chromium' },
  ])('explains the missing $missing before opening UI mode', ({ installed }) => {
    install(installed);
    const result = run('test:e2e:ui');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Run npx playwright install chromium, then try again.');
    expect(existsSync(join(root, 'playwright-call.json'))).toBe(false);
  });

  it('checks both browsers before opening UI mode with headless tests', () => {
    install('chromium');
    install('headless-shell');
    const result = run('test:e2e:ui');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'browser-check.json'), 'utf8'))).toEqual({ headless: true });
    expect(JSON.parse(readFileSync(join(root, 'playwright-call.json'), 'utf8'))).toEqual({
      args: ['test', '--ui'], browserChecked: true, browserClosed: true,
    });
  });

  it.each([
    { command: 'test:e2e', args: ['--headed'], forwarded: ['--headed'] },
    { command: 'test:e2e:ui', args: ['--headed'], forwarded: ['--ui', '--headed'] },
    { command: 'test:e2e', args: ['--debug'], forwarded: ['--debug'] },
    { command: 'test:e2e', args: ['--debug=inspector'], forwarded: ['--debug=inspector'] },
  ])('checks the headed executable for $command $args', ({ command, args, forwarded }) => {
    const missing = run(command, args);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('Run npx playwright install chromium, then try again.');
    expect(existsSync(join(root, 'playwright-call.json'))).toBe(false);

    install('chromium');
    const installed = run(command, args);
    expect(installed.status, installed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'playwright-call.json'), 'utf8'))).toEqual({
      args: ['test', ...forwarded], browserChecked: false, browserClosed: false,
    });
  });

  it.each([
    { args: ['--ui', '--ui-host=127.0.0.1'], env: {} },
    { args: ['--ui', '--ui-port', '0'], env: {} },
    { args: ['--debug=cli'], env: {} },
    { args: ['--debug', 'cli'], env: {} },
    { args: [], env: { PWDEBUG: 'console' } },
    { args: [], env: { PWDEBUG: 'false' } },
  ])('checks the headless shell for $args with $env', ({ args, env }) => {
    const missing = run('test:e2e', args, env);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('Run npx playwright install chromium, then try again.');
    expect(existsSync(join(root, 'playwright-call.json'))).toBe(false);

    install('headless-shell');
    const installed = run('test:e2e', args, env);
    expect(installed.status, installed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'playwright-call.json'), 'utf8'))).toEqual({
      args: ['test', ...args], browserChecked: true, browserClosed: true,
    });
  });

  it.each(['--list', '--help'])('allows %s without an installed browser', (argument) => {
    const result = run('test:e2e', [argument]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'playwright-call.json'), 'utf8'))).toEqual({
      args: ['test', argument], browserChecked: false, browserClosed: false,
    });
  });

  it('preserves a different browser startup error for diagnosis', () => {
    writeFileSync(join(root, 'browser-error.txt'), 'Host system is missing browser dependencies.');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe([
      'Cannot start E2E tests.', '', 'Host system is missing browser dependencies.',
    ].join('\n'));
    expect(existsSync(join(root, 'playwright-call.json'))).toBe(false);
  });
});

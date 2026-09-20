import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBuildDeployRunner } from './build-deploy-runner.mjs';
import { runBuildTool } from './fixtures/build-deploy.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = 'dist/zeropress_studio';
let root;
let execute;
function write(path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}
function runCli(command, args = [], env = {}) {
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', command, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
      NODE_DISABLE_COLORS: undefined,
      CLOUDFLARE_ENV: '',
      WRANGLER_CI_OVERRIDE_NAME: undefined,
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_PATH: join(root, 'wrangler.log'),
      npm_config_update_notifier: 'false',
      ...env,
    },
  });
}
function run(command, args = [], env = {}) {
  const output = [];
  const log = vi.spyOn(console, 'log').mockImplementation((message) => output.push(message));
  for (const [key, value] of Object.entries({
    CLOUDFLARE_ENV: '', WRANGLER_CI_OVERRIDE_NAME: undefined,
    WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'none',
    WRANGLER_LOG_PATH: join(root, 'wrangler.log'), ...env,
  })) vi.stubEnv(key, value);
  try {
    const action = { 'preview:wrangler': 'preview-wrangler', 'deploy:dry-run': 'dry-run' }[command] ?? command;
    execute(action, args[0] === '--' ? args.slice(1) : args);
    return { status: 0, stdout: output.join('\n'), stderr: '' };
  } catch (error) {
    return { status: 1, stdout: output.join('\n'), stderr: error.message };
  } finally {
    log.mockRestore();
    vi.unstubAllEnvs();
  }
}
function calls() {
  return existsSync(join(root, 'calls.jsonl'))
    ? readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    : [];
}
function assertBlocked() {
  const previousDeployments = calls().filter((call) => call.tool === 'wrangler');
  const result = run('deploy');
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('npm run build');
  expect(calls().filter((call) => call.tool === 'wrangler')).toEqual(previousDeployments);
  return result;
}
function changeConfig(changes) {
  const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8'));
  write('wrangler.jsonc', JSON.stringify({ ...config, ...changes }));
}
function wranglerCall(args, name = 'custom-studio') {
  return {
    tool: 'wrangler', args, name,
    configPath: join(root, artifact, 'wrangler.json'),
    userConfigPath: args.includes('--config')
      ? join(root, artifact, 'wrangler.json') : join(root, 'wrangler.jsonc'),
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-build-command-')));
  mkdirSync(join(root, 'scripts'));
  cpSync(join(repositoryRoot, 'package.json'), join(root, 'package.json'));
  for (const name of ['build-deploy.mjs', 'build-deploy-runner.mjs']) {
    cpSync(join(repositoryRoot, 'scripts', name), join(root, 'scripts', name));
  }
  mkdirSync(join(root, 'scripts/fixtures'));
  cpSync(join(repositoryRoot, 'scripts/fixtures/build-deploy.mjs'), join(root, 'scripts/fixtures/build-deploy.mjs'));
  execute = createBuildDeployRunner(root, (bin, args) => runBuildTool(root, bin, args));
  cpSync(join(repositoryRoot, 'scripts/wrangler-config.mjs'), join(root, 'scripts/wrangler-config.mjs'));
  write('wrangler.jsonc', JSON.stringify({
    name: 'custom-studio', main: './worker/src/index.ts', compatibility_date: '2026-09-07',
    keep_vars: true, ai: { binding: 'AI' },
    d1_databases: [{ binding: 'DB', database_name: 'custom-db' }],
  }));
  write('worker/src/index.ts', 'export default {};');
  write('node_modules/vite/package.json', '{"type":"module"}');
  symlinkSync(join(repositoryRoot, 'node_modules/jsonc-parser'), join(root, 'node_modules/jsonc-parser'), 'junction');
  write('node_modules/wrangler/package.json', '{"type":"module","exports":"./index.mjs"}');
  const wranglerModule = pathToFileURL(join(repositoryRoot, 'node_modules/wrangler/wrangler-dist/cli.js')).href;
  write('node_modules/wrangler/index.mjs', `
    export { unstable_readConfig, experimental_readRawConfig, experimental_patchConfig } from ${JSON.stringify(wranglerModule)};
  `);
  for (const bin of ['vite/bin/vite.js', 'wrangler/bin/wrangler.js']) {
    write(`node_modules/${bin}`, `
      import { runBuildTool } from '../../../scripts/fixtures/build-deploy.mjs';
      runBuildTool(process.cwd(), ${JSON.stringify(bin)}, process.argv.slice(2));
    `);
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('build and deployment commands', { timeout: 20_000 }, () => {
  it('builds Wrangler diagnostics locally and binds only to loopback', () => {
    const result = runCli('preview:wrangler', ['--', '--port', '8788']);
    expect(result.status, result.stderr).toBe(0);
    expect(calls()).toEqual([
      { tool: 'vite', args: ['build', '--mode', 'local-preview'] },
      wranglerCall([
        'dev', '--config', join(root, artifact, 'wrangler.json'), '--local',
        '--persist-to', 'client/.wrangler/state', '--port', '8788', '--ip', '127.0.0.1',
      ]),
    ]);
  });

  it.each([['--ip', '0.0.0.0'], ['--ip=0.0.0.0']])(
    'directs LAN preview to Vite when given %j', (...args) => {
      const result = run('preview:wrangler', ['--', ...args]);
      expect(result.status).toBe(1);
      expect(stripVTControlCharacters(result.stderr)).toContain('npm run preview -- --host 0.0.0.0');
      expect(calls()).toEqual([]);
    },
  );

  it('builds once for the Cloudflare build then deploy commands', () => {
    const config = readFileSync(join(root, 'wrangler.jsonc'), 'utf8');
    write('wrangler.jsonc', `// Installation settings\n${config.slice(0, -1)},}`);
    const build = runCli('build');
    expect(build.status, build.stderr).toBe(0);
    const deploy = runCli('deploy');
    expect(deploy.status, deploy.stderr).toBe(0);
    expect(deploy.stdout).toContain('Deploying Worker custom-studio.');
    expect(calls()).toEqual([
      { tool: 'vite', args: ['build'] },
      wranglerCall(['deploy']),
    ]);
    const redirectPath = join(root, '.wrangler/deploy/config.json');
    const redirect = JSON.parse(readFileSync(redirectPath, 'utf8'));
    expect(resolve(dirname(redirectPath), redirect.configPath)).toBe(join(root, artifact, 'wrangler.json'));
    expect(existsSync(join(root, 'client/.wrangler/deploy/config.json'))).toBe(true);
  });

  it('builds once and reuses deployment validation for dry runs', () => {
    const result = runCli('deploy:dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Validating deployment for Worker custom-studio.');
    expect(calls().map((call) => call.tool)).toEqual(['vite', 'wrangler']);
    expect(calls()[1]).toEqual(wranglerCall(['deploy', '--dry-run']));
  });

  it('explains a missing production build before calling a deployment tool', () => {
    const result = runCli('deploy');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No successful production build is available. Run npm run build before deploying.');
    expect(calls()).toEqual([]);
  });

  it('invalidates a previous success before a failing build', () => {
    expect(run('build').status).toBe(0);
    write('fail-build', '');
    expect(run('build').status).toBe(1);
    expect(existsSync(join(root, '.wrangler/deploy/config.json'))).toBe(false);
    assertBlocked();
  });

  it('does not deploy local-preview output or publish its root redirect', () => {
    expect(run('build').status).toBe(0);
    expect(run('build', ['--', '--mode', 'local-preview']).status).toBe(0);
    expect(existsSync(join(root, '.wrangler/deploy/config.json'))).toBe(false);
    expect(existsSync(join(root, 'client/.wrangler/deploy/config.json'))).toBe(true);
    assertBlocked();
  });

  it.each(['wrangler.json', 'index.js', '.deployable.json', '../client/index.html'])('rejects missing %s', (name) => {
    expect(run('build').status).toBe(0);
    rmSync(join(root, artifact, name));
    assertBlocked();
  });

  it('rejects a changed output configuration', () => {
    expect(run('build').status).toBe(0);
    const path = `${artifact}/wrangler.json`;
    const config = JSON.parse(readFileSync(join(root, path), 'utf8'));
    write(path, JSON.stringify({ ...config, name: 'changed-after-build' }));
    assertBlocked();
  });

  it('blocks an old Worker build until dry-run rebuilds for the current installation', () => {
    expect(run('build').status).toBe(0);
    changeConfig({ name: 'studio-demo' });
    const rejected = assertBlocked();
    expect(rejected.stderr).toContain('The build targets Worker "custom-studio", but wrangler.jsonc selects "studio-demo".');

    const dryRun = run('deploy:dry-run');
    expect(dryRun.status, dryRun.stderr).toBe(0);
    const deploy = run('deploy');
    expect(deploy.status, deploy.stderr).toBe(0);
    expect(calls()).toEqual([
      { tool: 'vite', args: ['build'] },
      { tool: 'vite', args: ['build'] },
      wranglerCall(['deploy', '--dry-run'], 'studio-demo'),
      wranglerCall(['deploy'], 'studio-demo'),
    ]);
  });

  it.each([
    { d1_databases: [{ binding: 'DB', database_name: 'another-db' }] },
    { d1_databases: [{ binding: 'DB', database_name: 'custom-db', database_id: '11111111-1111-4111-8111-111111111111' }] },
    { account_id: 'b'.repeat(32) },
  ])('requires rebuilding when installation settings change without renaming the Worker: %j', (changes) => {
    expect(run('build').status).toBe(0);
    changeConfig(changes);
    expect(assertBlocked().stderr).toContain('changed since the production build');
  });

  it.each(['{', '{}'])('blocks deployment when the source configuration cannot select a Worker: %s', (contents) => {
    expect(run('build').status).toBe(0);
    write('wrangler.jsonc', contents);
    expect(assertBlocked().stderr).toContain('Cannot read a valid Worker configuration from wrangler.jsonc.');
  });

  it('rejects a build made while installation settings change', () => {
    write('change-config-during-build', '');
    const result = run('build');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('wrangler.jsonc changed during the build.');
    assertBlocked();
  });

  it('accepts Wrangler formatting during a build when configuration values stay the same', () => {
    write('format-config-during-build', '');
    const result = run('build');
    expect(result.status, result.stderr).toBe(0);
    expect(run('deploy').status).toBe(0);
  });

  it('rejects a generated Worker name that differs from the source configuration', () => {
    write('wrong-build-target', '');
    const result = run('build');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('The build targets Worker "wrong-worker", but wrangler.jsonc selects "custom-studio".');
    assertBlocked();
  });

  it('requires a new build after selecting a different Cloudflare environment with the same Worker name', () => {
    changeConfig({ env: { staging: { name: 'custom-studio', d1_databases: [] } } });
    expect(run('build').status).toBe(0);
    const result = run('deploy', [], { CLOUDFLARE_ENV: 'staging' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('changed since the production build');
    expect(calls().map((call) => call.tool)).toEqual(['vite']);
  });

  it('rejects a Cloudflare Builds override that would change the verified target', () => {
    expect(run('build').status).toBe(0);
    const result = run('deploy', [], { WRANGLER_CI_OVERRIDE_NAME: 'another-worker' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cloudflare Builds selects Worker "another-worker", but the build targets "custom-studio".');
    expect(calls().map((call) => call.tool)).toEqual(['vite']);
    const accepted = run('deploy', [], { WRANGLER_CI_OVERRIDE_NAME: 'custom-studio' });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(calls().at(-1)).toEqual(wranglerCall(['deploy']));
  });

  it.each(['missing redirect', 'changed redirect', 'shadowed source'])('blocks unsafe Wrangler discovery: %s', (scenario) => {
    expect(run('build').status).toBe(0);
    if (scenario === 'missing redirect') rmSync(join(root, '.wrangler/deploy/config.json'));
    if (scenario === 'changed redirect') {
      write('other/wrangler.json', readFileSync(join(root, artifact, 'wrangler.json')));
      write('.wrangler/deploy/config.json', JSON.stringify({ configPath: '../../other/wrangler.json' }));
    }
    if (scenario === 'shadowed source') write('wrangler.json', '{"name":"another-worker"}');
    expect(assertBlocked().stderr).toContain('does not point to the verified build and wrangler.jsonc');
  });

  it.each([false, true])('preserves provisioned IDs in the source configuration when deployment failure is %s', (fails) => {
    expect(run('build').status).toBe(0);
    const outputBefore = readFileSync(join(root, artifact, 'wrangler.json'), 'utf8');
    write('provision-resource', '');
    if (fails) write('fail-deploy', '');
    const deployment = run('deploy');
    expect(deployment.status, deployment.stderr).toBe(fails ? 1 : 0);
    expect(calls().at(-1)).toEqual(wranglerCall(['deploy']));
    const provisionedId = '11111111-1111-4111-8111-111111111111';
    expect(JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).d1_databases).toEqual([
      { binding: 'DB', database_name: 'custom-db', database_id: provisionedId },
    ]);
    expect(readFileSync(join(root, artifact, 'wrangler.json'), 'utf8')).toBe(outputBefore);
    expect(assertBlocked().stderr).toContain('changed since the production build');

    rmSync(join(root, 'fail-deploy'), { force: true });
    expect(run('build').status).toBe(0);
    expect(JSON.parse(readFileSync(join(root, artifact, 'wrangler.json'), 'utf8')).d1_databases[0].database_id).toBe(provisionedId);
    expect(run('deploy').status).toBe(0);
  });

  it('does not mark an output containing local Secrets deployable', () => {
    write('leak-secret', '');
    expect(run('build').status).toBe(1);
    assertBlocked();
  });

  it('does not call Wrangler when dry-run preparation fails', () => {
    write('fail-build', '');
    expect(runCli('deploy:dry-run').status).toBe(1);
    expect(calls().map((call) => call.tool)).toEqual(['vite']);
  });
});

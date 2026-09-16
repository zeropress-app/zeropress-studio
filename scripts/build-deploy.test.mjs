import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = 'dist/zeropress_studio';
let root;
function write(path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}
function run(command, args = [], env = {}) {
  return spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', command, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
      NODE_DISABLE_COLORS: undefined,
      npm_config_update_notifier: 'false',
      ...env,
    },
  });
}
function calls() {
  return existsSync(join(root, 'calls.jsonl'))
    ? readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    : [];
}
function assertBlocked() {
  const result = run('deploy');
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain('npm run build');
  expect(calls().filter((call) => call.tool === 'wrangler')).toEqual([]);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'studio-build-command-')));
  mkdirSync(join(root, 'scripts'));
  cpSync(join(repositoryRoot, 'package.json'), join(root, 'package.json'));
  cpSync(join(repositoryRoot, 'scripts/build-deploy.mjs'), join(root, 'scripts/build-deploy.mjs'));
  write('node_modules/vite/package.json', '{"type":"module"}');
  write('node_modules/wrangler/package.json', '{"type":"module"}');
  write('node_modules/vite/bin/vite.js', `
    import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
    appendFileSync('calls.jsonl', JSON.stringify({tool:'vite', args:process.argv.slice(2)}) + '\\n');
    if (existsSync('fail-build')) process.exit(2);
    rmSync('dist', {recursive:true, force:true});
    mkdirSync('${artifact}', {recursive:true});
    mkdirSync('dist/client', {recursive:true});
    writeFileSync('${artifact}/index.js', 'export default {};');
    writeFileSync('dist/client/index.html', '<main>Studio</main>');
    const preview = process.argv.includes('local-preview');
    writeFileSync('${artifact}/wrangler.json', JSON.stringify({
      name:'custom-studio', main:'index.js', assets:{directory:'../client'},
      keep_vars:true, ai:preview ? undefined : {binding:'AI'},
      d1_databases:[{binding:'DB', database_name:'custom-db', ...(preview ? {remote:false} : {})}]
    }));
    if (existsSync('leak-secret')) writeFileSync('${artifact}/.dev.vars', 'SYNTHETIC=secret');
    mkdirSync('client/.wrangler/deploy', {recursive:true});
    writeFileSync('client/.wrangler/deploy/config.json', JSON.stringify({
      configPath:'../../../${artifact}/wrangler.json', auxiliaryWorkers:[]
    }));
  `);
  write('node_modules/wrangler/bin/wrangler.js', `
    import { appendFileSync } from 'node:fs';
    appendFileSync('calls.jsonl', JSON.stringify({tool:'wrangler', args:process.argv.slice(2)}) + '\\n');
  `);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('build and deployment commands', () => {
  it('builds once for the Cloudflare build then deploy commands', () => {
    const build = run('build');
    expect(build.status, build.stderr).toBe(0);
    const deploy = run('deploy');
    expect(deploy.status, deploy.stderr).toBe(0);
    expect(calls()).toEqual([
      { tool: 'vite', args: ['build'] },
      { tool: 'wrangler', args: ['deploy', '--config', join(root, artifact, 'wrangler.json')] },
    ]);
    const redirectPath = join(root, '.wrangler/deploy/config.json');
    const redirect = JSON.parse(readFileSync(redirectPath, 'utf8'));
    expect(resolve(dirname(redirectPath), redirect.configPath)).toBe(join(root, artifact, 'wrangler.json'));
    expect(existsSync(join(root, 'client/.wrangler/deploy/config.json'))).toBe(true);
  });

  it('builds once and reuses deployment validation for dry runs', () => {
    const result = run('deploy:dry-run');
    expect(result.status, result.stderr).toBe(0);
    expect(calls().map((call) => call.tool)).toEqual(['vite', 'wrangler']);
    expect(calls()[1].args).toEqual(['deploy', '--config', join(root, artifact, 'wrangler.json'), '--dry-run']);
  });

  it('does not build or deploy when no successful build exists', assertBlocked);

  it('highlights the deployment error and rebuild command when colors are enabled', () => {
    const result = run('deploy', [], { FORCE_COLOR: '1' });
    expect(result.status).toBe(1);
    expect(stripVTControlCharacters(result.stderr).trim())
      .toBe('No successful production build is available. Run npm run build before deploying.');
    expect(result.stderr).toContain('\u001b[31mNo successful production build is available.');
    expect(result.stderr).toContain('\u001b[36mnpm run build\u001b[39m');
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

  it('does not mark an output containing local Secrets deployable', () => {
    write('leak-secret', '');
    expect(run('build').status).toBe(1);
    assertBlocked();
  });

  it('does not call Wrangler when dry-run preparation fails', () => {
    write('fail-build', '');
    expect(run('deploy:dry-run').status).toBe(1);
    expect(calls().map((call) => call.tool)).toEqual(['vite']);
  });
});

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workerDirectory = join(root, 'dist/zeropress_studio');
const outputConfig = join(workerDirectory, 'wrangler.json');
const markerPath = join(workerDirectory, '.deployable.json');
const rootRedirect = join(root, '.wrangler/deploy/config.json');
const viteRedirect = join(root, 'client/.wrangler/deploy/config.json');
const rebuildMessage = 'Run npm run build before deploying.';

function invalidateDeployment() {
  rmSync(markerPath, { force: true });
  rmSync(rootRedirect, { force: true });
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readArtifact() {
  try {
    const contents = readFileSync(outputConfig);
    const config = JSON.parse(contents);
    if (
      !config.main || !statSync(resolve(workerDirectory, config.main)).isFile()
      || !config.assets?.directory
      || !statSync(resolve(workerDirectory, config.assets.directory, 'index.html')).isFile()
      || readdirSync(workerDirectory).some((name) => name.startsWith('.dev.vars'))
    ) throw new Error('Incomplete production output.');
    const bindings = [
      ...(config.d1_databases ?? []), ...(config.kv_namespaces ?? []),
      ...(config.r2_buckets ?? []), ...(config.queues?.producers ?? []), config.ai,
    ];
    if (bindings.some((binding) => binding && Object.hasOwn(binding, 'remote'))) {
      throw new Error('Development bindings in production output.');
    }
    return { version: 1, mode: 'production', configHash: createHash('sha256').update(contents).digest('hex') };
  } catch {
    throw new Error(`The production build artifact is missing or invalid. ${rebuildMessage}`);
  }
}

function run(bin, args) {
  const result = spawnSync(process.execPath, [join(root, 'node_modules', bin), ...args], {
    cwd: root, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${bin} ${result.signal ? `stopped by ${result.signal}` : `exited with code ${result.status}`}.`);
  }
}

function publishRootRedirect() {
  const redirect = JSON.parse(readFileSync(viteRedirect, 'utf8'));
  const rebase = (path) => relative(dirname(rootRedirect), resolve(dirname(viteRedirect), path));
  if (resolve(dirname(viteRedirect), redirect.configPath) !== outputConfig) {
    throw new Error('Vite did not select the expected Studio build artifact.');
  }
  writeJson(rootRedirect, {
    ...redirect,
    configPath: rebase(redirect.configPath),
    auxiliaryWorkers: (redirect.auxiliaryWorkers ?? []).map((worker) => ({
      ...worker, configPath: rebase(worker.configPath),
    })),
    ...(redirect.prerenderWorkerConfigPath ? {
      prerenderWorkerConfigPath: rebase(redirect.prerenderWorkerConfigPath),
    } : {}),
  });
}

function build(args) {
  invalidateDeployment();
  const mode = args.length === 0 ? 'production'
    : args.length === 2 && args[0] === '--mode' ? args[1] : null;
  if (mode !== 'production' && mode !== 'local-preview') {
    throw new Error('Build supports only --mode production or --mode local-preview.');
  }
  try {
    run('vite/bin/vite.js', ['build', ...args]);
    if (mode === 'production') {
      const marker = readArtifact();
      publishRootRedirect();
      writeJson(markerPath, marker);
    }
  } catch (error) {
    invalidateDeployment();
    throw error;
  }
}

function deploy(args) {
  if (args.some((arg) => arg !== '--dry-run')) {
    throw new Error('Deploy supports only --dry-run as an optional argument.');
  }
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    const artifact = readArtifact();
    if (marker.version !== artifact.version || marker.mode !== artifact.mode || marker.configHash !== artifact.configHash) {
      throw new Error('Build marker does not match the artifact.');
    }
  } catch {
    throw new Error(`No successful production build is available. ${rebuildMessage}`);
  }
  run('wrangler/bin/wrangler.js', ['deploy', '--config', outputConfig, ...args]);
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'build') build(args);
  else if (command === 'deploy') deploy(args);
  else if (command === 'dry-run' && args.length === 0) {
    build([]);
    deploy(['--dry-run']);
  } else throw new Error('Usage: build-deploy.mjs build [--mode local-preview] | deploy [--dry-run] | dry-run');
} catch (error) {
  const needsRebuild = error.message.endsWith(rebuildMessage);
  const heading = needsRebuild ? error.message.slice(0, -rebuildMessage.length).trimEnd() : error.message;
  const guidance = needsRebuild
    ? ` ${rebuildMessage.replace('npm run build', styleText('cyan', 'npm run build', { stream: process.stderr }))}`
    : '';
  console.error(`${styleText(['bold', 'red'], heading, { stream: process.stderr })}${guidance}`);
  process.exitCode = 1;
}

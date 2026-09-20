import { createHash } from 'node:crypto';
import {
  mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { styleText } from 'node:util';
import { experimental_readRawConfig, unstable_readConfig } from 'wrangler';
import { serializeWranglerConfig } from './wrangler-config.mjs';

export const rebuildMessage = 'Run npm run build before deploying.';

export function createBuildDeployRunner(root, run) {
  const sourceConfig = join(root, 'wrangler.jsonc');
  const workerDirectory = join(root, 'dist/zeropress_studio');
  const outputConfig = join(workerDirectory, 'wrangler.json');
  const markerPath = join(workerDirectory, '.deployable.json');
  const rootRedirect = join(root, '.wrangler/deploy/config.json');
  const viteRedirect = join(root, 'client/.wrangler/deploy/config.json');

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
        typeof config.name !== 'string' || !config.name
        || !config.main || !statSync(resolve(workerDirectory, config.main)).isFile()
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
      return {
        version: 3, mode: 'production', workerName: config.name,
        configHash: createHash('sha256').update(contents).digest('hex'),
      };
    } catch {
      throw new Error(`The production build artifact is missing or invalid. ${rebuildMessage}`);
    }
  }

  function stripMigrationMetadata() {
    const config = JSON.parse(readFileSync(outputConfig, 'utf8'));
    let changed = false;
    // Studio manages its database lifecycle. Vite's migration metadata must not
    // be written back to wrangler.jsonc during resource provisioning.
    for (const database of config.d1_databases ?? []) {
      for (const field of ['migrations_dir', 'migrations_pattern', 'migrations_table']) {
        if (Object.hasOwn(database, field)) {
          delete database[field];
          changed = true;
        }
      }
    }
    if (changed) writeJson(outputConfig, config);
  }

  function readSourceConfig() {
    try {
      const contents = serializeWranglerConfig(readFileSync(sourceConfig, 'utf8'));
      const config = unstable_readConfig({ config: sourceConfig }, { hideWarnings: true });
      if (typeof config.name !== 'string' || !config.name) throw new Error('Missing Worker name.');
      return {
        workerName: config.name,
        sourceConfigHash: createHash('sha256').update(contents)
          .update('\0').update(process.env.CLOUDFLARE_ENV ?? '').digest('hex'),
      };
    } catch {
      throw new Error(`Cannot read a valid Worker configuration from wrangler.jsonc. ${rebuildMessage}`);
    }
  }

  function assertWorkerName(source, artifact) {
    if (source.workerName !== artifact.workerName) {
      throw new Error(
        `The build targets Worker ${JSON.stringify(artifact.workerName)}, but wrangler.jsonc selects ${JSON.stringify(source.workerName)}. ${rebuildMessage}`,
      );
    }
  }

  function assertDeploymentRedirect() {
    try {
      const config = experimental_readRawConfig(
        { script: join(root, 'package.json') },
        { useRedirectIfAvailable: true },
      );
      if (config.configPath !== outputConfig || config.userConfigPath !== sourceConfig
        || config.deployConfigPath !== rootRedirect) {
        throw new Error('Unexpected deployment configuration.');
      }
    } catch {
      throw new Error(`The Wrangler deployment configuration does not point to the verified build and wrangler.jsonc. ${rebuildMessage}`);
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
      const source = mode === 'production' ? readSourceConfig() : null;
      run('vite/bin/vite.js', ['build', ...args]);
      stripMigrationMetadata();
      if (mode === 'production') {
        const artifact = readArtifact();
        if (source.sourceConfigHash !== readSourceConfig().sourceConfigHash) {
          throw new Error(`wrangler.jsonc changed during the build. ${rebuildMessage}`);
        }
        assertWorkerName(source, artifact);
        publishRootRedirect();
        assertDeploymentRedirect();
        writeJson(markerPath, { ...artifact, sourceConfigHash: source.sourceConfigHash });
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
    let marker;
    let artifact;
    try {
      marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      artifact = readArtifact();
      if (marker.version !== artifact.version || marker.mode !== artifact.mode || marker.configHash !== artifact.configHash) {
        throw new Error('Build marker does not match the artifact.');
      }
    } catch {
      throw new Error(`No successful production build is available. ${rebuildMessage}`);
    }
    const source = readSourceConfig();
    assertWorkerName(source, artifact);
    if (marker.sourceConfigHash !== source.sourceConfigHash) {
      throw new Error(`wrangler.jsonc or the selected environment changed since the production build. ${rebuildMessage}`);
    }
    assertDeploymentRedirect();
    const ciWorkerName = process.env.WRANGLER_CI_OVERRIDE_NAME;
    if (ciWorkerName !== undefined && ciWorkerName !== artifact.workerName) {
      throw new Error(
        `Cloudflare Builds selects Worker ${JSON.stringify(ciWorkerName)}, but the build targets ${JSON.stringify(artifact.workerName)}. Match the Worker name in wrangler.jsonc and Cloudflare Builds. ${rebuildMessage}`,
      );
    }
    console.log(`${args.includes('--dry-run') ? 'Validating deployment for' : 'Deploying'} Worker ${styleText('cyan', artifact.workerName)}.`);
    // Keep the source path available so Wrangler writes provisioned resource IDs to wrangler.jsonc.
    run('wrangler/bin/wrangler.js', ['deploy', ...args]);
  }

  function previewWrangler(args) {
    if (args.some((arg) => arg === '--ip' || arg.startsWith('--ip='))) {
      throw new Error('Wrangler preview listens on 127.0.0.1. For LAN access, run npm run preview -- --host 0.0.0.0.');
    }
    build(['--mode', 'local-preview']);
    run('wrangler/bin/wrangler.js', [
      'dev', '--config', outputConfig, '--local',
      '--persist-to', 'client/.wrangler/state', ...args, '--ip', '127.0.0.1',
    ]);
  }

  return (command, args = []) => {
    if (command === 'build') build(args);
    else if (command === 'deploy') deploy(args);
    else if (command === 'preview-wrangler') previewWrangler(args);
    else if (command === 'dry-run' && args.length === 0) {
      build([]);
      deploy(['--dry-run']);
    } else throw new Error('Usage: build-deploy.mjs build [--mode local-preview] | deploy [--dry-run] | dry-run | preview-wrangler [wrangler options]');
  };
}

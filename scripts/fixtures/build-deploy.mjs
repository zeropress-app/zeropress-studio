import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { experimental_patchConfig, experimental_readRawConfig, unstable_readConfig } from 'wrangler';

const artifact = 'dist/zeropress_studio';

export function runBuildTool(root, bin, args) {
  const path = (name) => join(root, name);
  const exists = (name) => existsSync(path(name));
  const write = (name, contents) => {
    mkdirSync(dirname(path(name)), { recursive: true });
    writeFileSync(path(name), contents);
  };
  const record = (call) => appendFileSync(path('calls.jsonl'), `${JSON.stringify(call)}\n`);

  if (bin === 'vite/bin/vite.js') {
    record({ tool: 'vite', args });
    if (exists('fail-build')) throw new Error('Simulated build failure.');
    rmSync(path('dist'), { recursive: true, force: true });
    write(`${artifact}/index.js`, 'export default {};');
    write('dist/client/index.html', '<main>Studio</main>');
    const preview = args.includes('local-preview');
    const config = unstable_readConfig({ config: path('wrangler.jsonc') }, { hideWarnings: true });
    write(`${artifact}/wrangler.json`, JSON.stringify({
      name: exists('wrong-build-target') ? 'wrong-worker' : config.name,
      main: 'index.js', assets: { directory: '../client' },
      keep_vars: true, ai: preview ? undefined : { binding: 'AI' },
      compatibility_date: config.compatibility_date, account_id: config.account_id,
      targetEnvironment: config.targetEnvironment,
      d1_databases: config.d1_databases.map((binding) => ({
        ...binding, migrations_dir: '../../migrations', ...(preview ? { remote: false } : {}),
      })),
    }));
    if (exists('leak-secret')) write(`${artifact}/.dev.vars`, 'SYNTHETIC=secret');
    write('client/.wrangler/deploy/config.json', JSON.stringify({
      configPath: `../../../${artifact}/wrangler.json`, auxiliaryWorkers: [],
    }));
    if (exists('change-config-during-build')) {
      experimental_patchConfig(path('wrangler.jsonc'), { name: 'changed-during-build' });
    }
    if (exists('format-config-during-build')) {
      experimental_patchConfig(path('wrangler.jsonc'), {}, false);
    }
    return;
  }

  if (bin !== 'wrangler/bin/wrangler.js') throw new Error(`Unexpected build tool: ${bin}`);
  const configIndex = args.indexOf('--config');
  const { rawConfig, configPath, userConfigPath } = experimental_readRawConfig(
    configIndex < 0 ? { script: path('package.json') } : { config: args[configIndex + 1] },
    { useRedirectIfAvailable: true },
  );
  record({ tool: 'wrangler', args, name: rawConfig.name, configPath, userConfigPath });
  if (exists('provision-resource') && !args.includes('--dry-run') && !rawConfig.d1_databases[0].database_id) {
    experimental_patchConfig(userConfigPath ?? configPath, {
      d1_databases: [{ ...rawConfig.d1_databases[0], database_id: '11111111-1111-4111-8111-111111111111' }],
    }, false);
  }
  if (exists('fail-deploy')) throw new Error('Simulated deployment failure.');
}

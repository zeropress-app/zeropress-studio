import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { formatWranglerConfig, serializeWranglerConfig } from './wrangler-config.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = `{
  // Installation settings
  "name": "studio-fixture",
  "triggers": {"crons": ["0 * * * *", "23 18 * * *"]},
  "d1_databases": [{"binding": "DB", "database_name": "fixture-db",}],
  "keep_vars": true,
}
`;
let root;
let configPath;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-config-format-'));
  configPath = join(root, 'wrangler.jsonc');
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'node_modules'));
  for (const name of ['format-wrangler.mjs', 'wrangler-config.mjs']) {
    cpSync(join(repositoryRoot, 'scripts', name), join(root, 'scripts', name));
  }
  symlinkSync(join(repositoryRoot, 'node_modules/jsonc-parser'), join(root, 'node_modules/jsonc-parser'), 'junction');
  writeFileSync(configPath, config);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(...args) {
  return spawnSync(process.execPath, ['scripts/format-wrangler.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
  });
}

it.each(['\n', '\r\n'])('matches installed Wrangler write-back formatting with %j line endings', (eol) => {
  const input = config.replaceAll('\n', eol);
  writeFileSync(configPath, input);
  const patch = spawnSync(process.execPath, [
    '--input-type=module', '-e',
    'import { experimental_patchConfig } from "wrangler"; experimental_patchConfig(process.argv[1], {}, false);',
    configPath,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(root, 'wrangler.log') },
    timeout: 10_000,
  });
  expect(patch.status, patch.stderr).toBe(0);
  const expected = readFileSync(configPath, 'utf8');
  const formatted = formatWranglerConfig(input);
  expect(formatted).toBe(expected);
  expect(formatWranglerConfig(formatted)).toBe(formatted);
  expect(parse(formatted)).toEqual(parse(input));
  expect(formatted).toContain('// Installation settings');
});

it('checks without writing and fixes formatting on explicit request', () => {
  const check = run('--check');
  expect(check.status).toBe(1);
  expect(check.stderr).toContain('Run npm run format:wrangler.');
  expect(readFileSync(configPath, 'utf8')).toBe(config);

  const format = run();
  expect(format.status, format.stderr).toBe(0);
  expect(readFileSync(configPath, 'utf8')).toBe(formatWranglerConfig(config));
  expect(run('--check').status).toBe(0);
});

it.each(['{"name": "studio-fixture", "keep_vars": }', '[]'])('leaves invalid input untouched: %s', (input) => {
  writeFileSync(configPath, input);
  for (const args of [[], ['--check']]) {
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid JSONC|must contain a JSON object/u);
    expect(readFileSync(configPath, 'utf8')).toBe(input);
  }
});

it('serializes equivalent JSONC independently of comments, whitespace, and object property order', () => {
  const reordered = `{
    "keep_vars": true,
    "d1_databases": [{"database_name": "fixture-db", "binding": "DB"}],
    "triggers": {"crons": ["0 * * * *", "23 18 * * *"]},
    "name": "studio-fixture"
  }`;
  expect(serializeWranglerConfig(config)).toBe(serializeWranglerConfig(reordered));
  expect(JSON.parse(serializeWranglerConfig(config))).toEqual(parse(config));
});

it.each([
  ['array order', { crons: ['first', 'second'] }, { crons: ['second', 'first'] }],
  ['scalar types', { enabled: true }, { enabled: 'true' }],
  ['string whitespace', { label: 'Studio' }, { label: ' Studio ' }],
])('preserves meaningful %s differences in configuration fingerprints', (_label, before, after) => {
  expect(serializeWranglerConfig(JSON.stringify(before)))
    .not.toBe(serializeWranglerConfig(JSON.stringify(after)));
});

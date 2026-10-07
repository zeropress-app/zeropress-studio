import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runMetadataUpdate } from './update-passkey-metadata.mjs';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); })); });
afterEach(() => { vi.unstubAllGlobals(); });
const commit = '1'.repeat(40);

it.each([
  ['downloaded', 'MDS downloaded and verified.'],
  ['not_modified', 'MDS checked: no new version (HTTP 304).'],
  ['cached', 'MDS cache reused and verified; no MDS update request was made.'],
  ['resumed', 'no MDS update request was made.'],
])('distinguishes %s from other MDS outcomes', async (status, message) => {
  const log = vi.fn(); const error = vi.fn();
  const update = vi.fn(async () => ({ serial: 5, models: 20, namesCommit: commit,
    mds: { status, nextCheckAt: '2026-10-01T01:00:00.000Z' } }));
  expect(await runMetadataUpdate([commit], { update, log, error })).toBe(0);
  expect(update).toHaveBeenCalledWith({ namesCommit: commit });
  const output = log.mock.calls.flat().join('\n');
  expect(output).toContain(message);
  expect(output).toContain('2026-10-01T01:00:00.000Z');
  expect(output).toContain('MDS 5, 20 models.');
  expect(output).toContain(commit);
  expect(error).not.toHaveBeenCalled();
});

it('returns a failure exit code without printing generation success after an update error', async () => {
  const log = vi.fn(); const error = vi.fn();
  const update = vi.fn(async () => { throw new Error('MDS download was rate-limited (HTTP 429).'); });
  expect(await runMetadataUpdate([], { update, log, error })).toBe(1);
  expect(log).not.toHaveBeenCalled();
  expect(error.mock.calls.flat().join('\n')).toContain('429');
});

it.each([['--cached'], ['main'], [commit, commit]])('rejects unsupported arguments before calling the updater: %j', async (...args) => {
  const update = vi.fn(); const log = vi.fn(); const error = vi.fn();
  expect(await runMetadataUpdate(args, { update, log, error })).toBe(1);
  expect(update).not.toHaveBeenCalled();
  expect(error.mock.calls.flat().join('\n')).toContain('--help');
});

it('shows help for the single command without updating metadata', async () => {
  const update = vi.fn(); const log = vi.fn();
  expect(await runMetadataUpdate(['--help'], { update, log })).toBe(0);
  expect(update).not.toHaveBeenCalled();
  const output = log.mock.calls.flat().join('\n');
  expect(output).toContain('npm run update:passkey-metadata');
  expect(output).not.toContain('generate:passkey-metadata');
  expect(output).toContain('local signed cache');
});

it('runs as a Node CLI and exits unsuccessfully for the removed cached flag', () => {
  const script = fileURLToPath(new URL('./update-passkey-metadata.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('npm run update:passkey-metadata');
  const invalid = spawnSync(process.execPath, [script, '--cached'], { encoding: 'utf8' });
  expect(invalid.status).toBe(1);
  expect(invalid.stderr).toContain('--help');
});

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updatePasskeyNames } from './update-passkey-names.mjs';

const commit = 'a'.repeat(40);
const source = 'https://raw.githubusercontent.com/passkeydeveloper/passkey-authenticator-aaguids/'
  + commit + '/combined_aaguid.json';
const existing = 'aaaaaaaa-0000-0000-0000-000000000001';
const added = 'bbbbbbbb-0000-0000-0000-000000000002';
const removed = 'cccccccc-0000-0000-0000-000000000003';
let root;
let outputPath;
let original;

function response(value) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-passkey-names-test-'));
  outputPath = join(root, 'names.json');
  original = JSON.stringify({
    source: 'https://example.com/previous-snapshot.json',
    names: { [existing]: 'Old name', [removed]: 'Removed authenticator' },
  });
  await writeFile(outputPath, original);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

describe('passkey name updates', () => {
  it('pins the latest revision, extracts sorted names, and reports changes for review', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{ sha: commit }]))
      .mockResolvedValueOnce(response({
        [added.toUpperCase()]: {
          name: 'Added authenticator',
          icon_light: 'data:image/svg+xml;base64,example',
          icon_dark: 'data:image/svg+xml;base64,example',
        },
        [existing]: { name: 'Renamed authenticator', extra: 'metadata' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await updatePasskeyNames({ outputPath })).toEqual({
      commit, total: 2, added: 1, changed: 1, removed: 1, updated: true,
    });
    const snapshot = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(snapshot).toEqual({
      source,
      names: { [existing]: 'Renamed authenticator', [added]: 'Added authenticator' },
    });
    expect(Object.keys(snapshot.names)).toEqual([existing, added]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/passkeydeveloper/passkey-authenticator-aaguids/commits?path=combined_aaguid.json&per_page=1',
      source,
    ]);
  });

  it('reproduces a pinned snapshot and recognizes an unchanged result', async () => {
    const fetchMock = vi.fn().mockImplementation(() => response({
      [existing]: { name: 'Example authenticator' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const freshOutputPath = join(root, 'fresh.json');

    expect(await updatePasskeyNames({ commit, outputPath: freshOutputPath })).toMatchObject({
      total: 1, added: 1, changed: 0, removed: 0, updated: true,
    });
    const first = await readFile(freshOutputPath, 'utf8');
    expect(await updatePasskeyNames({ commit, outputPath: freshOutputPath })).toMatchObject({
      total: 1, added: 0, changed: 0, removed: 0, updated: false,
    });
    expect(await readFile(freshOutputPath, 'utf8')).toBe(first);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([source, source]);
  });

  it.each([
    { label: 'an empty object', data: {} },
    { label: 'an array', data: [] },
    { label: 'an invalid AAGUID', data: { invalid: { name: 'Example' } } },
    { label: 'duplicate normalized AAGUIDs', data: {
      [existing]: { name: 'First' }, [existing.toUpperCase()]: { name: 'Second' },
    } },
    { label: 'a missing name', data: { [existing]: { icon_light: 'example' } } },
    { label: 'a blank name', data: { [existing]: { name: ' ' } } },
    { label: 'control characters in a name', data: { [existing]: { name: 'Example\u001b[31m' } } },
  ])('preserves the snapshot when upstream returns $label', async ({ data }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(data)));
    await expect(updatePasskeyNames({ commit, outputPath })).rejects.toThrow(/upstream/iu);
    expect(await readFile(outputPath, 'utf8')).toBe(original);
  });

  it.each([
    { label: 'an HTTP error', download: () => Promise.resolve(new Response('', { status: 503 })) },
    { label: 'invalid JSON', download: () => Promise.resolve(new Response('{')) },
    { label: 'a network failure', download: () => Promise.reject(new Error('Network unavailable')) },
  ])('preserves the snapshot after $label', async ({ download }) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(download));
    await expect(updatePasskeyNames({ commit, outputPath })).rejects.toThrow();
    expect(await readFile(outputPath, 'utf8')).toBe(original);
  });

  it('rejects a malformed revision returned by the commit API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response([{ sha: '../main' }])));
    await expect(updatePasskeyNames({ outputPath })).rejects.toThrow('40-character');
    expect(await readFile(outputPath, 'utf8')).toBe(original);
  });

  it('reports an invalid command argument with an unsuccessful exit status', () => {
    const script = fileURLToPath(new URL('./update-passkey-names.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, 'not-a-commit'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: undefined },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot update passkey names.');
    expect(result.stderr).toContain('40-character hexadecimal SHA');
  });
});

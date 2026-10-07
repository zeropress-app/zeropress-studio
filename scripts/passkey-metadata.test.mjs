import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '@simplewebauthn/server';
import { verifyMDSBlob } from '@simplewebauthn/server/helpers';
import { certificates, signedBlob, payload, AAGUID } from './test-helpers/fido.mjs';
import { generateMetadata, generateFromCache, updateMetadata } from './passkey-metadata.mjs';

const temporary = [];
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); })); });
afterEach(async () => { vi.unstubAllGlobals(); for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });
const reference = '2026-10-01T00:00:00.000Z';
const commit = '1'.repeat(40);
const names = { [AAGUID]: { name: 'Supplement name', icon_light: 'NOT_IN_OUTPUT' }, 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': { name: 'Apple Passwords' } };
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'fido-test-')); temporary.push(dir); return dir; }
const generate = (data) => generateMetadata({ payload: data, blobHash: 'a'.repeat(64), evaluatedAtIso: reference, names, namesCommit: commit });
const fingerprint = (certificate) => createHash('sha256').update(Buffer.from(certificate, 'base64')).digest('hex');

describe('static MDS generation', () => {
  it('verifies synthetic signed BLOBs through R46 and its cross-signed predecessor; rejects substitution and tampering', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
    const chain = await certificates();
    for (const roots of [[chain.root], [chain.r46]]) {
      SettingsService.setRootCertificates({ identifier: 'mds', certificates: roots.map((cert) => cert.toString('pem')) });
      expect((await verifyMDSBlob(await signedBlob(chain))).payload.no).toBe(1);
    }
    const blob = await signedBlob(chain);
    const parts = blob.split('.'); parts[1] = Buffer.from(JSON.stringify(payload(999))).toString('base64url');
    await expect(verifyMDSBlob(parts.join('.'))).rejects.toThrow();
    const attacker = await certificates();
    await expect(verifyMDSBlob(await signedBlob(attacker))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('gives MDS precedence, keeps non-certified models, removes icons and freezes future status reports', () => {
    const data = payload();
    data.entries[0].statusReports.push({ status: 'REVOKED', effectiveDate: '2099-01-01' });
    const result = generate(data);
    expect(result.client.models[AAGUID]).toMatchObject({ name: 'Synthetic authenticator', certification: 'certified', security_reports: [] });
    expect(result.client.snapshot).toEqual(result.worker.snapshot);
    expect(result.client.models['fbfc3007-154e-4ecc-8c0b-6e020557d7bd']).toMatchObject({ listed: false, certification: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('NOT_IN_OUTPUT');
    data.entries[0].statusReports = [{ status: 'NOT_FIDO_CERTIFIED' }];
    expect(generate(data).client.models[AAGUID].certification).toBe('not_certified');
  });
  it('produces identical trust metadata for every root permutation without changing signed input', async () => {
    const chain = await certificates();
    const roots = [chain.root, chain.r46, chain.cross].map((certificate) => certificate.toString('base64'));
    const data = payload();
    data.entries[0].metadataStatement.attestationRootCertificates = roots;
    const blob = await signedBlob(chain, data);
    const signedInput = JSON.parse(Buffer.from(blob.split('.')[1], 'base64url').toString());
    const original = structuredClone(signedInput);
    Object.freeze(signedInput.entries[0].metadataStatement.attestationRootCertificates);
    const expected = generate(signedInput);
    const actualRoots = expected.worker.statements[AAGUID].attestationRootCertificates;
    expect(actualRoots.map(fingerprint)).toEqual(roots.map(fingerprint).sort());
    expect(actualRoots.toSorted()).toEqual(roots.toSorted());
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const reordered = structuredClone(original);
      reordered.entries[0].metadataStatement.attestationRootCertificates = order.map((index) => roots[index]);
      expect(JSON.stringify(generate(reordered))).toBe(JSON.stringify(expected));
    }
    expect(signedInput).toEqual(original);
    SettingsService.setRootCertificates({ identifier: 'mds', certificates: [chain.r46.toString('pem')] });
    expect((await verifyMDSBlob(blob)).payload).toEqual(original);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains empty, single and duplicate roots, and preserves real certificate additions and removals', async () => {
    const chain = await certificates();
    const root = chain.root.toString('base64'); const other = chain.r46.toString('base64');
    const data = payload();
    const outputRoots = () => generate(data).worker.statements[AAGUID].attestationRootCertificates;
    expect(outputRoots()).toEqual([]);
    data.entries[0].metadataStatement.attestationRootCertificates = [root];
    expect(outputRoots()).toEqual([root]);
    data.entries[0].metadataStatement.attestationRootCertificates = [root, other, root];
    expect(outputRoots().toSorted()).toEqual([root, other, root].toSorted());
    data.entries[0].metadataStatement.attestationRootCertificates = [other];
    expect(outputRoots()).toEqual([other]);
  });
  it('regenerates during the wait period, checks MDS at the hourly boundary, and regenerates after 304', async () => {
    const dir = await directory(); const cache = join(dir, 'cache');
    let time = new Date(reference);
    const fetcher = vi.fn(async (url) => url.startsWith('https://mds.') ? new Response('signed blob') : new Response(JSON.stringify(names)));
    const verify = vi.fn(async () => payload());
    const options = { cache, outputRoot: dir, namesCommit: commit, now: () => time, fetcher, verify };
    expect(await updateMetadata(options)).toMatchObject({ mds: { status: 'downloaded' } });
    const file = join(dir, 'worker/src/auth/metadata/passkey-metadata.json'); const original = await readFile(file, 'utf8');
    const clientFile = join(dir, 'client/src/lib/passkey-authenticator-metadata.json');
    const originalClient = await readFile(clientFile, 'utf8');
    const staleOutput = { ...JSON.parse(originalClient), models: {} };
    await writeFile(clientFile, JSON.stringify(staleOutput));
    expect(await updateMetadata(options)).toMatchObject({ mds: { status: 'cached', nextCheckAt: '2026-10-01T01:00:00.000Z' } });
    expect(await readFile(clientFile, 'utf8')).toBe(originalClient);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await generateFromCache(options); expect(await readFile(file, 'utf8')).toBe(original);
    await writeFile(clientFile, JSON.stringify(staleOutput));
    time = new Date(time.getTime() + 3_600_000); fetcher.mockResolvedValue(new Response(null, { status: 304 }));
    expect(await updateMetadata(options)).toMatchObject({ mds: { status: 'not_modified' } });
    expect(fetcher.mock.lastCall[0]).toContain('localCopySerial=1'); expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readFile(clientFile, 'utf8')).toBe(originalClient);
    const manifest = JSON.parse(await readFile(join(cache, 'verified.json'), 'utf8'));
    await writeFile(join(cache, manifest.blob_file), JSON.stringify(payload()));
    await expect(generateFromCache(options)).rejects.toThrow('changed');
  });
  it.each([
    [undefined, '2026-10-02T01:00:00.000Z'],
    ['invalid', '2026-10-02T01:00:00.000Z'],
    ['30', '2026-10-02T01:00:00.000Z'],
    ['7200', '2026-10-02T02:00:00.000Z'],
    ['Fri, 02 Oct 2026 03:00:00 GMT', '2026-10-02T03:00:00.000Z'],
  ])('fails on 429 without retrying, and reuses cache on a subsequent invocation (%s)', async (retry, retryAt) => {
    const dir = await directory(); const cache = join(dir, 'cache');
    const options = { cache, outputRoot: dir, namesCommit: commit, now: () => new Date(reference), verify: async () => payload() };
    await updateMetadata({ ...options, fetcher: async (url) => new Response(url.startsWith('https://mds.') ? 'blob' : JSON.stringify(names)) });
    const file = join(dir, 'worker/src/auth/metadata/passkey-metadata.json'); const original = await readFile(file, 'utf8');
    const fetcher = vi.fn(async () => new Response(null, { status: 429, headers: retry ? { 'retry-after': retry } : {} }));
    await expect(updateMetadata({ ...options, now: () => new Date('2026-10-02'), fetcher })).rejects.toThrow('429');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(await readFile(file, 'utf8')).toBe(original);
    const result = await updateMetadata({ ...options, now: () => new Date('2026-10-02'), fetcher });
    expect(result).toMatchObject({ mds: { status: 'cached', nextCheckAt: retryAt } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readFile(file, 'utf8')).toBe(original);
  });
  it('preserves output on serial regression, signature failure, generation failure, and concurrent updates', async () => {
    const dir = await directory(); const options = { cache: join(dir, 'cache'), outputRoot: dir, namesCommit: commit, now: () => new Date(reference),
      fetcher: async (url) => new Response(url.startsWith('https://mds.') ? 'blob' : JSON.stringify(names)), verify: async () => payload(2) };
    await updateMetadata(options);
    const file = join(dir, 'worker/src/auth/metadata/passkey-metadata.json'); const original = await readFile(file, 'utf8');
    for (const [day, verify] of [[2, async () => payload(1)], [3, async () => { throw new Error('signature failure'); }], [4, async () => ({ ...payload(3), entries: [] })]]) {
      await expect(updateMetadata({ ...options, now: () => new Date(`2026-10-0${day}`), verify })).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(original);
    }
    await writeFile(join(options.cache, 'download.lock'), 'locked');
    await expect(updateMetadata(options)).rejects.toThrow('Another');
  });
});

it('does not roll a bundled snapshot back after the local cache is removed', async () => {
  const dir = await directory(); const options = { cache: join(dir, 'cache'), outputRoot: dir, namesCommit: commit, now: () => new Date(reference),
    fetcher: async (url) => new Response(url.startsWith('https://mds.') ? 'blob' : JSON.stringify(names)), verify: async () => payload(2) };
  await updateMetadata(options);
  const file = join(dir, 'worker/src/auth/metadata/passkey-metadata.json'); const original = await readFile(file, 'utf8');
  await expect(updateMetadata({ ...options, cache: join(dir, 'empty'), verify: async () => payload(1) })).rejects.toThrow('regressed');
  expect(await readFile(file, 'utf8')).toBe(original);
});
it('resumes a failed supplemental name download without another MDS request', async () => {
  const dir = await directory(); const fetcher = vi.fn(async (url) => url.startsWith('https://mds.') ? new Response('blob') : new Response(null, { status: 503 }));
  const options = { cache: join(dir, 'cache'), outputRoot: dir, namesCommit: commit, now: () => new Date(reference), fetcher, verify: async () => payload() };
  await expect(updateMetadata(options)).rejects.toThrow('cached');
  await expect(generateFromCache(options)).rejects.toThrow('names are missing');
  fetcher.mockImplementation(async (url) => {
    expect(url).toContain('raw.githubusercontent.com');
    return new Response(JSON.stringify(names));
  });
  await updateMetadata(options);
  expect(fetcher.mock.calls.filter(([url]) => url.startsWith('https://mds.'))).toHaveLength(1);
});

const modelPaths = ['client/src/lib/passkey-authenticator-metadata.json', 'worker/src/auth/metadata/passkey-metadata.json'];
const readOutputs = (dir) => Promise.all(modelPaths.map((file) => readFile(join(dir, file), 'utf8')));
const provider = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';
const nextCommit = '2'.repeat(40);

// Every upstream request must match an explicit local response; nothing is
// forwarded to real MDS or GitHub services.
function upstream() {
  const state = { commit, names, blob: 'signed blob', status: 200, namesStatus: 200 };
  const fetcher = vi.fn(async (input) => {
    const url = new URL(input);
    if (url.origin === 'https://mds.fidoalliance.org' && url.pathname === '/') {
      return new Response(state.status === 200 ? state.blob : null, { status: state.status });
    }
    if (url.href === 'https://api.github.com/repos/passkeydeveloper/passkey-authenticator-aaguids/commits?path=aaguid.json&per_page=1') {
      return Response.json([{ sha: state.commit }]);
    }
    if (url.href === 'https://raw.githubusercontent.com/passkeydeveloper/passkey-authenticator-aaguids/' + state.commit + '/aaguid.json') {
      return Response.json(state.names, { status: state.namesStatus });
    }
    throw new Error('Unexpected upstream request: ' + input);
  });
  return { state, fetcher, mdsRequests: () => fetcher.mock.calls.filter(([url]) => url.startsWith('https://mds.')) };
}

it.each([
  ['during the MDS wait period', '2026-10-01T00:30:00.000Z', 'cached', 1],
  ['after MDS returns 304', '2026-10-03T00:00:00.000Z', 'not_modified', 2],
])('updates names independently %s without moving the MDS reference date', async (_, currentTime, status, requests) => {
  const dir = await directory(); const remote = upstream();
  let time = new Date(reference);
  const data = payload();
  data.entries[0].statusReports.push({ status: 'REVOKED', effectiveDate: '2026-10-02' });
  const options = { cache: join(dir, 'cache'), outputRoot: dir, now: () => time, fetcher: remote.fetcher, verify: async () => data };
  await updateMetadata(options);
  const originals = await readOutputs(dir);
  remote.state.status = 304;
  remote.state.commit = nextCommit;
  remote.state.names = { ...names, [provider]: { name: 'Updated provider name' } };
  time = new Date(currentTime);
  expect(await updateMetadata(options)).toMatchObject({ namesCommit: nextCommit, mds: { status } });
  const outputs = (await readOutputs(dir)).map(JSON.parse);
  for (const output of outputs) {
    expect(output.models[provider].name).toBe('Updated provider name');
    expect(output.models[AAGUID].security_reports).toEqual([]);
    expect(output.snapshot).toMatchObject({ mds_no: 1, evaluated_at_iso: reference, names_commit: nextCommit });
    expect(output.snapshot.id).not.toBe(JSON.parse(originals[0]).snapshot.id);
  }
  expect(outputs[0].snapshot).toEqual(outputs[1].snapshot);
  expect(remote.mdsRequests()).toHaveLength(requests);
  if (status === 'not_modified') expect(remote.mdsRequests()[1][0]).toContain('localCopySerial=1');
});

it('uses an explicitly selected name revision while reusing cached MDS', async () => {
  const dir = await directory(); const remote = upstream();
  const options = { cache: join(dir, 'cache'), outputRoot: dir, now: () => new Date(reference), fetcher: remote.fetcher, verify: async () => payload() };
  await updateMetadata({ ...options, namesCommit: commit });
  remote.state.commit = nextCommit;
  remote.state.names = { ...names, [provider]: { name: 'Selected name' } };
  await updateMetadata({ ...options, namesCommit: nextCommit });
  expect(remote.mdsRequests()).toHaveLength(1);
  expect(remote.fetcher.mock.calls.some(([url]) => url.includes('api.github.com'))).toBe(false);
  expect(JSON.parse((await readOutputs(dir))[0]).models[provider].name).toBe('Selected name');
});

it('downloads new MDS when the wait ends and retains the existing pinned names without redownloading them', async () => {
  const dir = await directory(); const remote = upstream();
  let time = new Date(reference); let serial = 1;
  const options = { cache: join(dir, 'cache'), outputRoot: dir, namesCommit: commit, now: () => time, fetcher: remote.fetcher, verify: async () => payload(serial) };
  await updateMetadata(options);
  time = new Date('2026-10-01T01:00:00.000Z'); serial = 2; remote.state.blob = 'next signed blob';
  expect(await updateMetadata(options)).toMatchObject({ serial: 2, mds: { status: 'downloaded' } });
  expect(JSON.parse((await readOutputs(dir))[0]).snapshot).toMatchObject({ mds_no: 2, evaluated_at_iso: time.toISOString(), names_commit: commit });
  expect(remote.mdsRequests()).toHaveLength(2);
  expect(remote.fetcher.mock.calls.filter(([url]) => url.includes('raw.githubusercontent.com'))).toHaveLength(1);
});

it('reports the retry time without making another request when rate-limited and no cache exists', async () => {
  const dir = await directory(); const remote = upstream(); remote.state.status = 429;
  const options = { cache: join(dir, 'cache'), outputRoot: dir, now: () => new Date(reference), fetcher: remote.fetcher, verify: async () => payload() };
  await expect(updateMetadata(options)).rejects.toThrow('429');
  await expect(updateMetadata(options)).rejects.toThrow('No verified MDS cache is available');
  await expect(updateMetadata(options)).rejects.toThrow('2026-10-01T01:00:00.000Z');
  expect(remote.fetcher).toHaveBeenCalledTimes(1);
});

it('rejects a 304 response without a cached signed MDS', async () => {
  const dir = await directory(); const remote = upstream(); remote.state.status = 304;
  await expect(updateMetadata({ cache: join(dir, 'cache'), outputRoot: dir, fetcher: remote.fetcher })).rejects.toThrow('304 without a local copy');
  expect(remote.fetcher).toHaveBeenCalledTimes(1);
});

it.each(['blob_file', 'names_file'])('detects modified cached input during the wait period (%s)', async (field) => {
  const dir = await directory(); const remote = upstream();
  const options = { cache: join(dir, 'cache'), outputRoot: dir, namesCommit: commit, now: () => new Date(reference), fetcher: remote.fetcher, verify: async () => payload() };
  await updateMetadata(options);
  const originals = await readOutputs(dir);
  const manifest = JSON.parse(await readFile(join(options.cache, 'verified.json'), 'utf8'));
  await writeFile(join(options.cache, manifest[field]), '{}');
  await expect(updateMetadata(options)).rejects.toThrow('changed');
  expect(await readOutputs(dir)).toEqual(originals);
  expect(remote.mdsRequests()).toHaveLength(1);
});

it.each(['2026-10-01T00:30:00.000Z', '2026-10-01T01:00:00.000Z'])('still rejects certificate verification errors when reusing MDS at %s', async (currentTime) => {
  const dir = await directory(); const remote = upstream();
  const options = { cache: join(dir, 'cache'), outputRoot: dir, namesCommit: commit, now: () => new Date(reference), fetcher: remote.fetcher, verify: async () => payload() };
  await updateMetadata(options);
  const originals = await readOutputs(dir);
  remote.state.status = 304;
  await expect(updateMetadata({ ...options, now: () => new Date(currentTime), verify: async () => { throw new Error('Certificate revoked'); } })).rejects.toThrow('Certificate revoked');
  expect(await readOutputs(dir)).toEqual(originals);
});

it.each(['2026-10-01T00:30:00.000Z', '2026-10-01T01:00:00.000Z'])('preserves output after name failure and resumes without another MDS request (%s)', async (currentTime) => {
  const dir = await directory(); const remote = upstream(); let time = new Date(reference);
  const options = { cache: join(dir, 'cache'), outputRoot: dir, now: () => time, fetcher: remote.fetcher, verify: async () => payload() };
  await updateMetadata(options);
  const originals = await readOutputs(dir);
  remote.state.status = 304; remote.state.commit = nextCommit; remote.state.namesStatus = 503;
  time = new Date(currentTime);
  await expect(updateMetadata(options)).rejects.toThrow('Cannot download supplemental names');
  expect(await readOutputs(dir)).toEqual(originals);
  const count = remote.mdsRequests().length;
  time = new Date('2026-10-02'); remote.state.namesStatus = 200;
  remote.state.names = { ...names, [provider]: { name: 'Recovered name' } };
  expect(await updateMetadata(options)).toMatchObject({ namesCommit: nextCommit, mds: { status: 'resumed' } });
  expect(remote.mdsRequests()).toHaveLength(count);
  expect(JSON.parse((await readOutputs(dir))[0]).models[provider].name).toBe('Recovered name');
});

it('retries generation from fully downloaded input without any further download', async () => {
  const dir = await directory(); const remote = upstream();
  const options = { cache: join(dir, 'cache'), outputRoot: dir, now: () => new Date(reference), fetcher: remote.fetcher };
  await expect(updateMetadata({ ...options, verify: async () => ({ ...payload(), entries: [] }) })).rejects.toThrow('Invalid MDS payload');
  const requests = remote.fetcher.mock.calls.length;
  expect(await updateMetadata({ ...options, verify: async () => payload() })).toMatchObject({ mds: { status: 'resumed' } });
  expect(remote.fetcher).toHaveBeenCalledTimes(requests);
});

it('fails an MDS request without falling back to a successful cached generation', async () => {
  const dir = await directory(); const remote = upstream();
  const options = { cache: join(dir, 'cache'), outputRoot: dir, now: () => new Date(reference), fetcher: remote.fetcher, verify: async () => payload() };
  await updateMetadata(options);
  const originals = await readOutputs(dir);
  remote.state.status = 503;
  await expect(updateMetadata({ ...options, now: () => new Date('2026-10-02') })).rejects.toThrow('MDS download failed: HTTP 503');
  expect(await readOutputs(dir)).toEqual(originals);
  expect(remote.mdsRequests()).toHaveLength(2);
});

it('rejects malformed source revisions before making an MDS request', async () => {
  const dir = await directory(); const remote = upstream();
  await expect(updateMetadata({ cache: join(dir, 'cache'), outputRoot: dir, fetcher: remote.fetcher, namesCommit: 'main' })).rejects.toThrow('full supplemental source commit');
  expect(remote.fetcher).not.toHaveBeenCalled();
});

it('ships matching client and Worker snapshots without trust material in the client output', async () => {
  const client = JSON.parse(await readFile(new URL('../client/src/lib/passkey-authenticator-metadata.json', import.meta.url), 'utf8'));
  const worker = JSON.parse(await readFile(new URL('../worker/src/auth/metadata/passkey-metadata.json', import.meta.url), 'utf8'));
  expect(client.snapshot).toEqual(worker.snapshot);
  expect(client.models).toEqual(Object.fromEntries(Object.entries(worker.models).map(([id, model]) => [id, {
    ...model, security_reports: model.security_reports.map(({ status }) => ({ status })),
  }])));
  expect(Object.keys(client)).toEqual(['snapshot', 'models']);
  expect(JSON.stringify(client)).not.toMatch(/attestationRootCertificates|BEGIN CERTIFICATE|icon_dark|icon_light/u);
  expect(Object.keys(worker.statements)).toEqual(Object.entries(worker.models).filter(([, model]) => model.listed).map(([id]) => id));
  for (const statement of Object.values(worker.statements)) {
    const fingerprints = statement.attestationRootCertificates.map(fingerprint);
    expect(fingerprints).toEqual(fingerprints.toSorted());
  }
});

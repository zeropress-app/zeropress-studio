import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsService } from '@simplewebauthn/server';
import { verifyMDSBlob } from '@simplewebauthn/server/helpers';
import { describePasskeyModel, passkeySnapshotSchema } from '../contracts/passkey-metadata.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_CACHE = join(root, '.cache/fido-mds');
const MDS = 'https://mds.fidoalliance.org/';
const repo = 'passkeydeveloper/passkey-authenticator-aaguids';
const aaguidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const stringList = (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value, null, 2) + '\n';
function sortTrustRoots(certificates) {
  // These are alternative trust anchors, not an ordered attestation chain.
  // Compare DER fingerprints without locale-dependent string collation.
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  return certificates.map((certificate) => ({
    certificate, fingerprint: sha(Buffer.from(certificate, 'base64')),
  })).sort((left, right) => compare(left.fingerprint, right.fingerprint)
    || compare(left.certificate, right.certificate)).map(({ certificate }) => certificate);
}
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function atomic(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + crypto.randomUUID() + '.tmp';
  try { await writeFile(temporary, contents); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export async function verifyBlob(blob) {
  const roots = await readJson(join(root, 'scripts/fido/mds-roots.json'));
  if (!Array.isArray(roots.certificates) || roots.certificates.length === 0) throw new Error('Missing pinned MDS trust roots.');
  SettingsService.setRootCertificates({ identifier: 'mds', certificates: roots.certificates });
  const { payload } = await verifyMDSBlob(blob);
  return payload;
}
export function generateMetadata({ payload, blobHash, evaluatedAtIso, names, namesCommit }) {
  if (!Number.isSafeInteger(payload.no) || payload.no <= 0 || !Array.isArray(payload.entries) || !payload.entries.length) {
    throw new Error('Invalid MDS payload.');
  }
  const source = { mds_no: payload.no, blob_sha256: blobHash, evaluated_at_iso: evaluatedAtIso,
    next_update: payload.nextUpdate, names_commit: namesCommit, source: MDS };
  const snapshot = passkeySnapshotSchema.parse({ id: sha(JSON.stringify(source)), ...source });
  const models = Object.create(null);
  const statements = Object.create(null);
  for (const [id, entry] of Object.entries(names)) {
    if (!aaguidPattern.test(id) || typeof entry?.name !== 'string' || !entry.name.trim()
      || /[\u0000-\u001f\u007f]/u.test(entry.name)) throw new Error('Invalid supplemental authenticator name.');
    models[id] = { name: entry.name.trim(), listed: false, certification: 'unknown', certification_level: null,
      security_reports: [], key_protection: [] };
  }
  const seen = new Set();
  for (const entry of payload.entries) {
    if (!entry.aaguid) continue;
    const id = entry.aaguid.toLowerCase();
    if (!aaguidPattern.test(id) || seen.has(id)) throw new Error('Invalid or duplicate MDS AAGUID.');
    seen.add(id);
    const m = entry.metadataStatement;
    if (!m || m.aaguid?.toLowerCase() !== id || typeof m.description !== 'string'
      || !m.description.trim() || /[\u0000-\u001f\u007f]/u.test(m.description)
      || !Array.isArray(entry.statusReports) || !stringList(m.attestationRootCertificates)
      || !stringList(m.authenticationAlgorithms) || !stringList(m.attestationTypes)
      || !stringList(m.keyProtection)) throw new Error('Incomplete MDS model: ' + id);
    const reports = entry.statusReports.map(({ status, effectiveDate, authenticatorVersion, certificate, batchCertificate }) => {
      if (typeof status !== 'string' || !status || /[\u0000-\u001f\u007f]/u.test(status)
        || (effectiveDate !== undefined && (typeof effectiveDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(effectiveDate) || !Number.isFinite(Date.parse(effectiveDate))))
        || (authenticatorVersion !== undefined && (!Number.isSafeInteger(authenticatorVersion) || authenticatorVersion < 0))
        || [certificate, batchCertificate].some((value) => value !== undefined && (typeof value !== 'string' || !value.trim()))) {
        throw new Error('Invalid MDS status report.');
      }
      return { status, ...(effectiveDate ? { effectiveDate } : {}),
        ...(authenticatorVersion !== undefined ? { authenticatorVersion } : {}),
        ...(certificate ? { certificate } : {}), ...(batchCertificate ? { batchCertificate } : {}) };
    });
    models[id] = describePasskeyModel({ description: m.description, statusReports: reports,
      keyProtection: m.keyProtection, evaluatedAtIso });
    statements[id] = { authenticationAlgorithms: m.authenticationAlgorithms, attestationTypes: m.attestationTypes,
      attestationRootCertificates: sortTrustRoots(m.attestationRootCertificates), rogueListPresent: Boolean(entry.rogueListURL) };
  }
  const sorted = (value) => Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  // Security reports contain certificate scopes: these stay exclusively in the Worker bundle.
  const display = Object.fromEntries(Object.entries(sorted(models)).map(([id, model]) => [id, {
    ...model, security_reports: model.security_reports.map(({ status }) => ({ status })),
  }]));
  return { client: { snapshot, models: display }, worker: { snapshot, models: sorted(models), statements: sorted(statements) } };
}
async function productSnapshots(outputRoot) {
  const paths = ['client/src/lib/passkey-authenticator-metadata.json', 'worker/src/auth/metadata/passkey-metadata.json'];
  return (await Promise.all(paths.map(async (path) => {
    const product = await readJson(join(outputRoot, path));
    return product ? passkeySnapshotSchema.parse(product.snapshot) : null;
  }))).filter(Boolean);
}
function checkSerial(candidate, previous) {
  for (const snapshot of previous.filter(Boolean)) {
    if (candidate.mds_no < snapshot.mds_no || (candidate.mds_no === snapshot.mds_no && candidate.blob_sha256 !== snapshot.blob_sha256)) {
      throw new Error('MDS serial regressed or changed without advancing. Existing metadata was kept.');
    }
  }
}
async function withCacheLock(cache, work) {
  await mkdir(cache, { recursive: true });
  let lock;
  try { lock = await open(join(cache, 'download.lock'), 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Another metadata update is running.'); throw e; }
  try { return await work(); }
  finally { await lock.close(); await rm(join(cache, 'download.lock'), { force: true }); }
}
export async function generateFromCache(options = {}) {
  const cache = options.cache ?? DEFAULT_CACHE;
  return withCacheLock(cache, () => generateCached({ ...options, cache }));
}
async function generateCached({ cache = DEFAULT_CACHE, outputRoot = root, verify = verifyBlob } = {}) {
  const pending = await readJson(join(cache, 'pending.json'));
  if (pending && !pending.names_file) throw new Error('The signed MDS download is cached, but supplemental names are missing. Run update:passkey-metadata to resume without downloading MDS again.');
  const saved = pending ?? await readJson(join(cache, 'verified.json'));
  if (!saved) throw new Error('No verified MDS download. Run npm run update:passkey-metadata first.');
  if (!/^[a-f0-9]{64}\.jwt$/u.test(saved.blob_file ?? '') || !/^[a-f0-9]{64}\.json$/u.test(saved.names_file ?? '')) throw new Error('Invalid cache manifest.');
  const blob = await readFile(join(cache, saved.blob_file), 'utf8');
  if (sha(blob) !== saved.blob_sha256) throw new Error('Cached MDS BLOB has changed.');
  const payload = await verify(blob);
  if (payload.no !== saved.mds_no) throw new Error('Cached MDS serial does not match.');
  const names = await readJson(join(cache, saved.names_file));
  if (sha(json(names)) !== saved.names_sha256) throw new Error('Cached supplemental names have changed.');
  checkSerial(saved, [...await productSnapshots(outputRoot), await readJson(join(cache, 'verified.json'))]);
  const generated = generateMetadata({ payload, blobHash: saved.blob_sha256,
    evaluatedAtIso: saved.evaluated_at_iso, names, namesCommit: saved.names_commit });
  const files = [
    [join(outputRoot, 'client/src/lib/passkey-authenticator-metadata.json'), json(generated.client)],
    [join(outputRoot, 'worker/src/auth/metadata/passkey-metadata.json'), json(generated.worker)],
  ];
  const previous = await Promise.all(files.map(async ([path]) => {
    try { return await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }));
  try { for (const [path, contents] of files) await atomic(path, contents); }
  catch (error) {
    for (let i = 0; i < files.length; i++) {
      if (previous[i] === null) await rm(files[i][0], { force: true });
      else await atomic(files[i][0], previous[i]);
    }
    throw error;
  }
  await atomic(join(cache, 'verified.json'), json({ ...saved, models: Object.keys(generated.client.models).length }));
  await rm(join(cache, 'pending.json'), { force: true });
  return { serial: payload.no, models: Object.keys(generated.client.models).length };
}
export async function updateMetadata({ cache = DEFAULT_CACHE, outputRoot = root, fetcher = fetch,
  verify = verifyBlob, now = () => new Date(), namesCommit } = {}) {
  if (namesCommit !== undefined && !/^[a-f0-9]{40}$/u.test(namesCommit)) {
    throw new Error('Expected a full supplemental source commit SHA.');
  }
  return withCacheLock(cache, async () => {
    const previous = await readJson(join(cache, 'verified.json'));
    const products = await productSnapshots(outputRoot);
    const request = await readJson(join(cache, 'request.json'));
    const time = now();
    const get = (url) => fetcher(url, { headers: { 'User-Agent': 'ZeroPress-Studio-passkey-metadata' }, signal: AbortSignal.timeout(30_000), redirect: 'error' });
    // A failed name fetch/generation resumes the already-downloaded signed input.
    // It must not cause another MDS request, even on a later invocation.
    let verified = await readJson(join(cache, 'pending.json'));
    let mdsStatus = 'resumed';
    let nextCheckAt = request?.retry_at;
    if (!verified) {
      if (request?.retry_at && Date.parse(request.retry_at) > time.getTime()) {
        if (!previous) {
          throw new Error('No verified MDS cache is available. MDS downloads are limited to once per hour. Try again after ' + request.retry_at + '.');
        }
        verified = previous;
        mdsStatus = 'cached';
      } else {
        nextCheckAt = new Date(time.getTime() + 3_600_000).toISOString();
        await atomic(join(cache, 'request.json'), json({ requested_at: time.toISOString(), retry_at: nextCheckAt }));
        const response = await get(MDS + (previous ? '?localCopySerial=' + previous.mds_no : ''));
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          const parsed = retry && /^\d+$/u.test(retry) ? time.getTime() + Number(retry) * 1000 : Date.parse(retry ?? '');
          const minimum = time.getTime() + 3_600_000;
          const retryAt = new Date(Number.isFinite(parsed) && parsed <= 8.64e15 ? Math.max(parsed, minimum) : minimum).toISOString();
          await atomic(join(cache, 'request.json'), json({ requested_at: time.toISOString(), retry_at: retryAt }));
          throw new Error('MDS download was rate-limited (HTTP 429). Existing metadata was kept. ' + (retry ? 'Retry-After was received. ' : 'MDS permits one download per hour. ') + 'Try again after ' + retryAt + '.');
        }
        if (response.status === 304) {
          if (!previous) throw new Error('MDS returned 304 without a local copy.');
          verified = previous;
          mdsStatus = 'not_modified';
        } else {
          if (response.status !== 200) throw new Error('MDS download failed: HTTP ' + response.status + '. Existing metadata was kept.');
          const blob = await response.text();
          if (blob.length > 32 * 1024 * 1024) throw new Error('MDS download exceeds the size limit.');
          const blobHash = sha(blob);
          const blobFile = blobHash + '.jwt';
          await atomic(join(cache, blobFile), blob);
          const payload = await verify(blob);
          checkSerial({ mds_no: payload.no, blob_sha256: blobHash }, [previous, ...products]);
          const same = [previous, ...products].find((snapshot) => snapshot?.blob_sha256 === blobHash);
          verified = { mds_no: payload.no, blob_sha256: blobHash, blob_file: blobFile,
            evaluated_at_iso: same?.evaluated_at_iso ?? time.toISOString() };
          mdsStatus = 'downloaded';
        }
      }
    }
    if (mdsStatus !== 'resumed' || !verified.names_file || (namesCommit && namesCommit !== verified.names_commit)) {
      // MDS and the supplemental list change independently. Only a completed
      // pending download keeps its pinned names while resuming generation.
      const availableNames = [verified, previous];
      const { mds_no, blob_sha256, blob_file, evaluated_at_iso } = verified;
      verified = { mds_no, blob_sha256, blob_file, evaluated_at_iso };
      await atomic(join(cache, 'pending.json'), json(verified));
      if (!namesCommit) {
        const commits = await get('https://api.github.com/repos/' + repo + '/commits?path=aaguid.json&per_page=1');
        if (!commits.ok) throw new Error('Cannot resolve supplemental name revision: HTTP ' + commits.status + '. MDS download is cached.');
        namesCommit = (await commits.json())[0]?.sha;
      }
      if (!/^[a-f0-9]{40}$/u.test(namesCommit ?? '')) throw new Error('Expected a full supplemental source commit SHA.');
      const cachedNames = availableNames.find((entry) => entry?.names_file && entry.names_commit === namesCommit);
      if (cachedNames) {
        verified = { ...verified, names_commit: namesCommit, names_file: cachedNames.names_file, names_sha256: cachedNames.names_sha256 };
      } else {
        const nameResponse = await get('https://raw.githubusercontent.com/' + repo + '/' + namesCommit + '/aaguid.json');
        if (!nameResponse.ok) throw new Error('Cannot download supplemental names: HTTP ' + nameResponse.status + '. MDS download is cached.');
        const names = await nameResponse.json();
        const namesHash = sha(json(names));
        const namesFile = namesHash + '.json';
        await atomic(join(cache, namesFile), json(names));
        verified = { ...verified, names_commit: namesCommit, names_file: namesFile, names_sha256: namesHash };
      }
      await atomic(join(cache, 'pending.json'), json(verified));
    }
    const result = await generateCached({ cache, outputRoot, verify });
    return { ...result, mds: { status: mdsStatus, nextCheckAt }, namesCommit: verified.names_commit };
  });
}

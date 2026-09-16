import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';

const repository = 'passkeydeveloper/passkey-authenticator-aaguids';
const latestCommitUrl = 'https://api.github.com/repos/' + repository
  + '/commits?path=combined_aaguid.json&per_page=1';
const defaultOutputPath = fileURLToPath(new URL(
  '../client/src/lib/passkey-authenticator-names.json', import.meta.url,
));
const commitPattern = /^[a-f0-9]{40}$/iu;
const aaguidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ZeroPress-Studio-passkey-names' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('Download failed: HTTP ' + response.status + ' from ' + url);
  return response.json();
}

function extractNames(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('The upstream authenticator list must be a JSON object.');
  }
  const names = new Map();
  for (const [aaguid, entry] of Object.entries(data)) {
    const key = aaguid.toLowerCase();
    if (!aaguidPattern.test(key) || names.has(key)) {
      throw new Error('The upstream list contains an invalid or duplicate AAGUID.');
    }
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim()
      || /[\u0000-\u001f\u007f]/u.test(entry.name)) {
      throw new Error('The upstream list contains an invalid name for ' + key + '.');
    }
    names.set(key, entry.name.trim());
  }
  if (names.size === 0) {
    throw new Error('The upstream authenticator list is empty. Check the source repository before updating.');
  }
  return Object.fromEntries([...names.keys()].sort().map((key) => [key, names.get(key)]));
}

export async function updatePasskeyNames({ commit, outputPath = defaultOutputPath } = {}) {
  if (commit === undefined) {
    const commits = await fetchJson(latestCommitUrl);
    commit = commits?.[0]?.sha;
  }
  if (typeof commit !== 'string' || !commitPattern.test(commit)) {
    throw new Error('An upstream commit must be a full 40-character hexadecimal SHA.');
  }
  commit = commit.toLowerCase();
  const source = 'https://raw.githubusercontent.com/' + repository + '/'
    + commit + '/combined_aaguid.json';
  const names = extractNames(await fetchJson(source));
  let previousContents;
  try {
    previousContents = await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const previousNames = previousContents === undefined ? {} : JSON.parse(previousContents).names;
  const contents = JSON.stringify({ source, names }, null, 2) + '\n';
  const result = {
    commit,
    total: Object.keys(names).length,
    added: Object.keys(names).filter((key) => !Object.hasOwn(previousNames, key)).length,
    changed: Object.keys(names).filter((key) => Object.hasOwn(previousNames, key)
      && names[key] !== previousNames[key]).length,
    removed: Object.keys(previousNames).filter((key) => !Object.hasOwn(names, key)).length,
    updated: contents !== previousContents,
  };
  if (result.updated) {
    const temporaryDirectory = await mkdtemp(join(dirname(outputPath), '.passkey-names-'));
    try {
      const temporaryPath = join(temporaryDirectory, 'snapshot.json');
      await writeFile(temporaryPath, contents);
      await rename(temporaryPath, outputPath);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) {
      throw new Error('Usage: npm run update:passkey-names -- [upstream-commit-sha]');
    }
    const result = await updatePasskeyNames({ commit: process.argv[2] });
    const heading = result.updated ? 'Updated passkey names.' : 'Passkey names are up to date.';
    console.log(styleText('green', heading));
    console.log(result.total + ' entries: ' + result.added + ' added, '
      + result.changed + ' changed, ' + result.removed + ' removed.');
    console.log('Source commit: ' + result.commit);
    if (result.updated) {
      console.log('Review client/src/lib/passkey-authenticator-names.json before committing.');
    }
  } catch (error) {
    console.error(styleText(['bold', 'red'], 'Cannot update passkey names.', { stream: process.stderr }));
    console.error(error.message);
    process.exitCode = 1;
  }
}

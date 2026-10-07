import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs, styleText } from 'node:util';

export const upstreamRepository = 'zeropress-app/zeropress-studio';
export const statePath = '.zeropress/upstream.json';
const releasePattern = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const shaPattern = /^[a-f0-9]{40}$/u;
const workflowPath = '.github/workflows/update-studio.yml';
const workflowTemplatePath = 'scripts/templates/update-studio.yml';
const gitEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', HUSKY: '0' };

function git(root, args, options = {}) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
    stdio: ['pipe', 'pipe', 'pipe'], env: gitEnvironment, ...options,
  });
}

function release(tag) {
  if (typeof tag !== 'string' || !releasePattern.test(tag)) {
    throw new Error('Use a fixed release tag such as v0.7.3. Branches and moving tags are not supported.');
  }
  return tag.slice(1).split('.').map(BigInt);
}

function compareReleases(left, right) {
  const a = release(left);
  const b = release(right);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function snapshot(root, commit, path) {
  if (!git(root, ['ls-tree', commit, '--', path]).trim()) return null;
  return git(root, ['show', `${commit}:${path}`], { encoding: null });
}

function packageVersion(contents) {
  const value = JSON.parse(contents.toString());
  if (value.name !== '@zeropress/studio') throw new Error('The selected repository is not ZeroPress Studio.');
  release(`v${value.version}`);
  return `v${value.version}`;
}

function protectedPath(path) {
  return path === 'wrangler.jsonc' || path === statePath || path.startsWith('.github/workflows/')
    || /(^|\/)(?:\.env[^/]*|\.dev.vars[^/]*|\.wrangler|node_modules|dist)(?:\/|$)/u.test(path);
}

async function configuration(contents) {
  let parser;
  try {
    parser = await import('jsonc-parser');
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('Install the updater dependencies with npm ci, then run the update again.');
  }
  const { parse, printParseErrorCode } = parser;
  const errors = [];
  const value = parse(contents?.toString() ?? '', errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Cannot read release wrangler.jsonc${errors.length ? `: ${printParseErrorCode(errors[0].error)}` : '.'}`);
  }
  return value;
}

function fetchRelease(root, upstream, tag) {
  const ref = `refs/zeropress/releases/${tag}`;
  try {
    git(root, ['fetch', '--quiet', '--no-tags', '--depth=1', upstream, `refs/tags/${tag}:${ref}`]);
    const commit = git(root, ['rev-parse', `${ref}^{commit}`]).trim();
    if (packageVersion(snapshot(root, commit, 'package.json')) !== tag) {
      throw new Error(`The package version does not match ${tag}.`);
    }
    return { tag, commit };
  } catch (error) {
    throw new Error(`Cannot use upstream release ${tag}. Check that the tag exists and matches its package version.`, { cause: error });
  }
}

function readState(root) {
  if (!existsSync(join(root, statePath))) return null;
  const state = JSON.parse(readFileSync(join(root, statePath), 'utf8'));
  if (state.format !== 1 || state.repository !== upstreamRepository || !shaPattern.test(state.commit)) {
    throw new Error(`Invalid ${statePath}. Restore its last reviewed contents before updating.`);
  }
  release(state.tag);
  return state;
}

function checkDependencies(root, tag) {
  if (packageVersion(readFileSync(join(root, 'package.json'))) !== tag) {
    throw new Error('The merged package version does not match the requested release. Review package.json manually.');
  }
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  if (lock.version !== tag.slice(1) || lock.packages?.['']?.version !== tag.slice(1)) {
    throw new Error('The merged lockfile does not match the requested release. Review package-lock.json manually.');
  }
  const invalid = Object.entries(lock.packages).filter(([name, entry]) => name !== ''
    && (entry.link === true || !String(entry.resolved ?? '').startsWith('https://registry.npmjs.org/')));
  if (invalid.length) throw new Error('The update contains local or non-registry dependencies. Use the published Studio release.');
}

export async function prepareUpdate({ root, output, from, target, upstream = `https://github.com/${upstreamRepository}.git` }) {
  release(target);
  root = resolve(root);
  output = resolve(output);
  const location = relative(root, output);
  if (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('Choose an update output directory outside the installation repository.');
  }
  if (git(root, ['status', '--porcelain', '--untracked-files=normal']).trim()) {
    throw new Error('The installation repository has uncommitted changes. Commit or preserve them before preparing an update.');
  }
  const state = readState(root);
  if (state && from && from !== state.tag) throw new Error(`The installed release is recorded as ${state.tag}; do not override it with ${from}.`);
  from = state?.tag ?? from;
  if (!from) throw new Error('Enter the installed release tag for the first update. Later updates use .zeropress/upstream.json.');
  release(from);
  if (packageVersion(readFileSync(join(root, 'package.json'))) !== from) {
    throw new Error('The installed release tag does not match package.json. Select the release this installation is based on.');
  }
  if (compareReleases(target, from) < 0) throw new Error('This action cannot downgrade Studio. Use the documented recovery procedure.');

  mkdirSync(output, { recursive: false });
  const candidate = join(output, 'candidate');
  try {
    const baseCommit = git(root, ['rev-parse', 'HEAD']).trim();
    git(root, ['clone', '--quiet', '--no-local', '--no-checkout', root, candidate]);
    git(candidate, ['checkout', '--quiet', '--detach', baseCommit]);
    const previous = fetchRelease(candidate, upstream, from);
    if (state && state.commit !== previous.commit) {
      throw new Error(`The upstream ${from} tag has moved since the last update. Stop and review the release source.`);
    }
    const next = target === from ? previous : fetchRelease(candidate, upstream, target);
    if (target === from) {
      rmSync(output, { recursive: true });
      return { changed: false, baseCommit, target };
    }

    const paths = git(candidate, ['diff', '--name-only', '--no-renames', '-z', previous.commit, next.commit]).split('\0').filter(Boolean);
    if (paths.includes('wrangler.jsonc') && !isDeepStrictEqual(
      await configuration(snapshot(candidate, previous.commit, 'wrangler.jsonc')),
      await configuration(snapshot(candidate, next.commit, 'wrangler.jsonc')),
    )) {
      throw new Error(`This release changes Wrangler settings. Review https://github.com/${upstreamRepository}/compare/${from}...${target} and update manually; your installation configuration has been preserved.`);
    }
    const protectedChanges = new Set(paths.filter((path) => protectedPath(path) && path !== 'wrangler.jsonc'));
    if (paths.includes(workflowTemplatePath)) protectedChanges.add(workflowPath);
    for (const path of protectedChanges) {
      const installed = snapshot(candidate, baseCommit, path);
      // Deploy to Cloudflare omits workflows; local updates do not require installing them.
      if (path.startsWith('.github/workflows/') && installed === null) continue;
      const expected = path === workflowPath
        ? snapshot(candidate, next.commit, workflowTemplatePath) ?? snapshot(candidate, next.commit, path)
        : snapshot(candidate, next.commit, path);
      if (!isDeepStrictEqual(installed, expected)) {
        throw new Error(`Review and apply ${path} manually before retrying. Installation files and GitHub workflows are not replaced by the updater.`);
      }
    }

    const editable = paths.filter((path) => !protectedPath(path));
    if (editable.length) {
      const patch = git(candidate, ['diff', '--binary', '--full-index', '--no-renames', previous.commit, next.commit, '--', ...editable], { encoding: null });
      try {
        git(candidate, ['apply', '--3way', '--index', '--whitespace=nowarn'], { input: patch });
      } catch {
        const conflicts = git(candidate, ['diff', '--name-only', '--diff-filter=U']).trim();
        throw new Error(`The release conflicts with installation changes${conflicts ? `:\n${conflicts}` : '.'}\nResolve the update manually. The installation repository has not been changed.`);
      }
    }
    checkDependencies(candidate, target);
    mkdirSync(join(candidate, dirname(statePath)), { recursive: true });
    writeFileSync(join(candidate, statePath), JSON.stringify({ format: 1, repository: upstreamRepository, ...next }, null, 2) + '\n');
    git(candidate, ['add', '--', statePath]);
    const patch = git(candidate, ['diff', '--cached', '--binary', '--full-index', '--no-renames'], { encoding: null });
    const files = git(candidate, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
    const metadata = {
      format: 1, repository: upstreamRepository, baseCommit, from: previous, target: next,
      tree: git(candidate, ['write-tree']).trim(), patchSha256: digest(patch),
      databaseChanges: files.some((path) => (path.startsWith('database/') && !path.endsWith('.md'))
        || path === 'worker/src/system/schema-version.ts' || path === 'contracts/edge-mail-queue.ts'),
    };
    writeFileSync(join(output, 'update.patch'), patch);
    writeFileSync(join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
    return { changed: true, baseCommit, target, candidate, files };
  } catch (error) {
    rmSync(output, { recursive: true, force: true });
    throw error;
  }
}

function readBundle(directory) {
  const metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
  const patch = readFileSync(join(directory, 'update.patch'));
  if (metadata.format !== 1 || metadata.repository !== upstreamRepository
    || ![metadata.baseCommit, metadata.from?.commit, metadata.target?.commit, metadata.tree].every((value) => shaPattern.test(value))
    || typeof metadata.databaseChanges !== 'boolean' || metadata.patchSha256 !== digest(patch)) {
    throw new Error('The prepared update is invalid or has changed. Run the update checks again.');
  }
  if (compareReleases(metadata.target.tag, metadata.from.tag) <= 0) throw new Error('The prepared update is not a newer release.');
  return { metadata, patch };
}

export function validateUpdate({ bundle, installBrowser = true, onProgress = () => {}, run = (command, args, cwd) => execFileSync(command, args, {
  cwd, stdio: 'inherit', timeout: 10 * 60_000,
  shell: process.platform === 'win32',
  env: { ...process.env, HUSKY: '0', WRANGLER_SEND_METRICS: 'false' },
}) }) {
  const { metadata } = readBundle(bundle);
  delete metadata.validated;
  writeFileSync(join(bundle, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  const candidate = join(bundle, 'candidate');
  for (const [command, ...args] of [
    ['npm', 'ci'], ['npm', 'run', 'format:wrangler:check'], ['npm', 'test'],
    ['npm', 'run', 'typecheck'], ['npm', 'run', 'deploy:dry-run'],
    ...(installBrowser ? [['npx', 'playwright', 'install', '--with-deps', 'chromium']] : []),
    ['npm', 'run', 'test:e2e'],
  ]) {
    try {
      onProgress(`Running ${[command, ...args].join(' ')}...`);
      run(command, args, candidate);
    } catch (error) {
      const playwrightPackage = join(candidate, 'node_modules/playwright/package.json');
      if (!installBrowser && args[1] === 'test:e2e' && existsSync(playwrightPackage)) {
        const { version } = JSON.parse(readFileSync(playwrightPackage, 'utf8'));
        if (releasePattern.test(`v${version}`)) {
          throw new Error(`E2E validation failed. If the output above reports a missing browser, install Chromium for the target release with:\nnpx --yes playwright@${version} install chromium\nThen retry the update. Your installation has not been changed.`, { cause: error });
        }
      }
      throw error;
    }
  }
  if (git(candidate, ['diff', '--name-only']).trim()
    || git(candidate, ['ls-files', '--others', '--exclude-standard']).trim()
    || git(candidate, ['write-tree']).trim() !== metadata.tree) {
    throw new Error('Validation changed the candidate source. Review those changes and prepare the update again.');
  }
  writeFileSync(join(bundle, 'metadata.json'), JSON.stringify({ ...metadata, validated: true }, null, 2) + '\n');
}

export function updateBody(metadata) {
  return [
    `Update Studio from **${metadata.from.tag}** to **${metadata.target.tag}**.`,
    '',
    `[Upstream changes](https://github.com/${upstreamRepository}/compare/${metadata.from.tag}...${metadata.target.tag})`,
    `Source commit: \`${metadata.target.commit}\`.`,
    '',
    'Dependency installation, tests, typecheck, deployment dry run, and local E2E passed before this PR was created.',
    'The installation Wrangler configuration and existing customizations are preserved. Dashboard variables and Secrets are not changed.',
    ...(metadata.databaseChanges ? [
      '',
      `**Database or Edge mail contract files changed.** Review the release changes and [Maintenance & Recovery](https://github.com/${upstreamRepository}/blob/${metadata.target.commit}/docs/maintenance-and-recovery.md) before merging. Back up affected data and follow the supported upgrade order. This action does not run database upgrades or update the Edge Worker.`,
    ] : []),
    '',
    'Merging into the Cloudflare production branch triggers the configured deployment. Database upgrades remain separate operations.',
  ].join('\n');
}

async function githubRequest(repository, token, path, { method = 'GET', body, optional = false } = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    method, headers: {
      Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ZeroPress-Studio-updater',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status}. Check repository Actions permissions and "Allow GitHub Actions to create and approve pull requests", then retry.`);
  }
  return response.json();
}

function pushBranch(root, repository, branch, token) {
  git(root, ['push', `https://github.com/${repository}.git`, `HEAD:refs/heads/${branch}`], {
    env: {
      ...gitEnvironment,
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    },
  });
}

function applyPreparedUpdate(root, metadata, patch) {
  git(root, ['apply', '--index', '--whitespace=nowarn'], { input: patch });
  if (git(root, ['write-tree']).trim() !== metadata.tree) throw new Error('The prepared update no longer matches the validated tree.');
  const paths = git(root, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
  if (paths.some((path) => path !== statePath && protectedPath(path))) {
    throw new Error('The prepared update attempts to replace an installation file or GitHub workflow.');
  }
  const state = readState(root);
  if (state?.tag !== metadata.target.tag || state?.commit !== metadata.target.commit) {
    throw new Error('The prepared update does not record the validated release.');
  }
}

function localGit(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, ...options,
  });
}

function localInstallation(root) {
  let top;
  try {
    top = localGit(root, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw new Error('Run the local updater from a cloned Studio installation repository.');
  }
  if (realpathSync(root) !== realpathSync(top)) throw new Error('Run the local updater from the installation repository root.');
  packageVersion(readFileSync(join(root, 'package.json')));
  const gitDirectory = localGit(root, ['rev-parse', '--absolute-git-dir']).trim();
  if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'].some((path) => existsSync(join(gitDirectory, path)))) {
    throw new Error('Finish the current Git merge, rebase, or cherry-pick before updating Studio.');
  }
  if (localGit(root, ['status', '--porcelain', '--untracked-files=normal']).trim()) {
    throw new Error('The installation repository has uncommitted changes, including staged or untracked files. Commit or preserve them before updating Studio.');
  }
  const current = localGit(root, ['branch', '--show-current']).trim();
  if (!current) throw new Error('Switch to the installation repository\'s default branch before updating Studio; HEAD is detached.');
  let origin;
  let references;
  try {
    origin = localGit(root, ['remote', 'get-url', 'origin']).trim();
  } catch {
    throw new Error('Add your installation repository as the origin remote before updating Studio.');
  }
  if (/(?:^|[/:@])github\.com[:/]zeropress-app\/zeropress-studio(?:\.git)?\/?$/iu.test(origin)) {
    throw new Error('Run the updater in your Studio installation repository, not the upstream repository.');
  }
  try {
    references = localGit(root, ['ls-remote', '--symref', 'origin', 'HEAD']);
  } catch {
    throw new Error('Cannot read origin. Check your network connection and Git authentication, then retry.');
  }
  const base = /^ref: refs\/heads\/([^\r\n\t]+)\tHEAD$/mu.exec(references)?.[1];
  const remoteCommit = /^([a-f0-9]{40})\tHEAD$/mu.exec(references)?.[1];
  if (!base || !remoteCommit) throw new Error('Cannot determine origin\'s default branch. Set a default branch in the installation repository before updating.');
  if (current !== base) throw new Error(`Switch to the installation repository's default branch (${base}) before updating Studio.`);
  const baseCommit = localGit(root, ['rev-parse', 'HEAD']).trim();
  if (baseCommit !== remoteCommit) {
    throw new Error(`Your ${base} branch differs from origin/${base}. Fetch and review your local and remote commits, synchronize the branch, then retry. Nothing was pulled or reset.`);
  }
  return { base, baseCommit, origin };
}

export async function updateLocal({ root, from, target, upstream, validate = validateUpdate,
  selectReleases, confirm, onProgress = () => {} }) {
  if (!selectReleases) release(target);
  root = resolve(root);
  onProgress('Checking the installation repository...');
  const before = localInstallation(root);
  try {
    localGit(root, ['var', 'GIT_AUTHOR_IDENT']);
    localGit(root, ['var', 'GIT_COMMITTER_IDENT']);
  } catch {
    throw new Error('Configure your Git user.name and user.email before updating Studio.');
  }
  if (selectReleases) {
    const installed = packageVersion(readFileSync(join(root, 'package.json')));
    const state = readState(root);
    if (state && state.tag !== installed) throw new Error('The recorded installed release does not match package.json. Review the installation before updating.');
    ({ from, target } = await selectReleases({ root, base: before.base, installed, recorded: Boolean(state) }));
    release(target);
  }
  const directory = mkdtempSync(join(tmpdir(), 'zeropress-studio-update-'));
  const bundle = join(directory, 'update');
  let branch;
  try {
    onProgress('Preparing an isolated update...');
    const result = await prepareUpdate({ root, output: bundle, from, target, upstream });
    if (!result.changed) return result;
    onProgress('Validating the update...');
    await validate({ bundle, installBrowser: false, onProgress });
    const { metadata, patch } = readBundle(bundle);
    if (metadata.validated !== true) throw new Error('The update has not passed validation. Run the update checks before creating a branch.');
    if (confirm && await confirm({ from: metadata.from.tag, target: metadata.target.tag,
      files: result.files, databaseChanges: metadata.databaseChanges }) !== true) {
      return { changed: false, cancelled: true, target };
    }
    // Confirmation can take time. Recheck the checkout and origin afterwards.
    const after = localInstallation(root);
    if (!isDeepStrictEqual(before, after) || metadata.baseCommit !== before.baseCommit) {
      throw new Error('The installation branch or origin changed during validation. Run the updater again.');
    }
    localGit(root, ['apply', '--check', '--index', '--whitespace=nowarn'], { input: patch });
    onProgress('Creating the update branch and commit...');
    const time = new Date().toISOString();
    const name = `studio-update/${time.slice(2, 10).replaceAll('-', '')}-${time.slice(11, 16).replace(':', '')}-${randomBytes(3).toString('hex')}`;
    try {
      localGit(root, ['switch', '--no-track', '-c', name]);
    } finally {
      if (localGit(root, ['branch', '--show-current']).trim() === name) branch = name;
    }
    if (branch !== name || localGit(root, ['rev-parse', 'HEAD']).trim() !== before.baseCommit
      || localGit(root, ['status', '--porcelain', '--untracked-files=normal']).trim()) {
      throw new Error('The checkout changed while creating the update branch.');
    }
    applyPreparedUpdate(root, metadata, patch);
    // Local commits use the caller's identity, hooks, and signing configuration.
    localGit(root, ['commit', '--quiet', '-m', `chore: update Studio to ${metadata.target.tag}`], { stdio: 'inherit', timeout: 10 * 60_000 });
    if (localGit(root, ['rev-parse', 'HEAD^{tree}']).trim() !== metadata.tree
      || localGit(root, ['rev-parse', 'HEAD^']).trim() !== metadata.baseCommit
      || localGit(root, ['status', '--porcelain', '--untracked-files=normal']).trim()) {
      throw new Error('Commit hooks changed the validated update. Review the update branch before publishing it.');
    }
    return { changed: true, branch, base: before.base, target, commit: localGit(root, ['rev-parse', 'HEAD']).trim(), databaseChanges: metadata.databaseChanges };
  } catch (error) {
    if (branch) {
      throw new Error(`Cannot finish the update on ${branch}. Review git status and the Git output above, then finish or discard this branch manually. The original ${before.base} branch has not been advanced.\n${error.message}`, { cause: error });
    }
    throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function publishUpdate({ root, bundle, repository, token, request, push = pushBranch }) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(repository) || repository.toLowerCase() === upstreamRepository) {
    throw new Error('Run the updater in your Studio installation repository, not the upstream repository.');
  }
  if (!token) throw new Error('The update publisher requires the repository GITHUB_TOKEN.');
  request ??= (path, options) => githubRequest(repository, token, path, options);
  const { metadata, patch } = readBundle(bundle);
  if (metadata.validated !== true) throw new Error('The update has not passed validation. Run the update checks before creating a PR.');
  const repo = await request('');
  const branch = `zeropress/update-studio-${metadata.target.tag}`;
  const base = repo.default_branch;
  const prs = await request(`pulls?state=all&head=${encodeURIComponent(repository.split('/')[0] + ':' + branch)}&base=${encodeURIComponent(base)}`);
  if (prs.length) {
    const existing = prs.find((pr) => pr.state === 'open');
    if (existing) return { created: false, url: existing.html_url };
    throw new Error(`A previous update PR for ${metadata.target.tag} was closed. Review that PR before trying again.`);
  }
  const latest = await request(`git/ref/heads/${encodeURIComponent(base)}`);
  if (latest.object.sha !== metadata.baseCommit || git(root, ['rev-parse', 'HEAD']).trim() !== metadata.baseCommit) {
    throw new Error('The installation branch changed during validation. Run the updater again against the current branch.');
  }
  if (git(root, ['status', '--porcelain', '--untracked-files=normal']).trim()) {
    throw new Error('The publishing checkout is not clean. Run the updater again.');
  }
  applyPreparedUpdate(root, metadata, patch);
  const existingBranch = await request(`git/ref/heads/${encodeURIComponent(branch)}`, { optional: true });
  if (existingBranch) {
    const commit = await request(`git/commits/${existingBranch.object.sha}`);
    if (commit.tree.sha !== metadata.tree || commit.parents[0]?.sha !== metadata.baseCommit) {
      throw new Error('The update branch already contains different changes. Review it before retrying; it will not be overwritten.');
    }
  } else {
    git(root, ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
      'commit', '--quiet', '-m', `chore: update Studio to ${metadata.target.tag}`]);
    push(root, repository, branch, token);
  }
  const pr = await request('pulls', {
    method: 'POST', body: { title: `chore: update Studio to ${metadata.target.tag}`, head: branch, base, body: updateBody(metadata) },
  });
  return { created: true, url: pr.html_url };
}

class UpdateCancelled extends Error {
  constructor() { super('Studio update cancelled.'); }
}

function question(input, output, message) {
  if (input.destroyed || input.readableEnded) return Promise.reject(new UpdateCancelled());
  return new Promise((resolve, reject) => {
    const prompt = createInterface({ input, output });
    const closed = () => finish(null);
    const interrupted = () => { output.write('\n'); finish(null); };
    function finish(answer) {
      prompt.off('close', closed);
      prompt.off('SIGINT', interrupted);
      prompt.close();
      if (answer === null) reject(new UpdateCancelled());
      else resolve(answer.trim());
    }
    prompt.once('close', closed);
    prompt.once('SIGINT', interrupted);
    prompt.question(message, finish);
  });
}

function printLocalResult(result, output) {
  const log = (message) => output.write(message + '\n');
  if (result.cancelled) {
    log('Studio update cancelled. The installation repository was not changed.');
  } else if (!result.changed) {
    log(`Studio is already based on ${result.target}.`);
  } else {
    log(styleText('green', `Prepared Studio ${result.target} on ${result.branch}.`, { stream: output }));
    log('Review the commit, then push the update branch:');
    log('  git show HEAD');
    log(`  git push --set-upstream origin ${result.branch}`);
    log(`Merge the reviewed branch into ${result.base} when ready.`);
    if (result.databaseChanges) log('Database or Edge contract files changed. Review docs/maintenance-and-recovery.md before merging; database upgrades remain separate operations.');
  }
}

async function interactiveUpdate({ root, input, output, upstream, validate }) {
  const log = (message) => output.write(message + '\n');
  const ask = (message) => question(input, output, message);
  const readRelease = async (message, fallback, check) => {
    for (;;) {
      const value = await ask(message) || fallback;
      try { release(value); check(value); return value; }
      catch (error) { log(error.message); }
    }
  };
  try {
    return await updateLocal({ root, upstream, validate,
      onProgress: (message) => log(styleText('cyan', message, { stream: output })),
      selectReleases: async ({ root, base, installed, recorded }) => {
        log(`Installation: ${JSON.stringify(root)}`);
        log(`Branch: ${base}`);
        log('The update is validated in an isolated copy. You will confirm before creating a local branch and commit.');
        log('Press Ctrl+C to cancel.');
        let from = installed;
        if (recorded) log(`Installed release: ${installed} (recorded in ${statePath})`);
        else from = await readRelease(`Installed release [${installed}]: `, installed, (value) => {
          if (value !== installed) throw new Error('The installed release must match package.json.');
        });
        const target = await readRelease('Target release (vX.Y.Z): ', undefined, (value) => {
          if (compareReleases(value, from) < 0) throw new Error('Downgrades are not supported. Choose the installed release or a newer release.');
        });
        return { from, target };
      },
      confirm: async ({ from, target, files, databaseChanges }) => {
        log('\nValidation passed.');
        log(`Installed release: ${from}`);
        log(`Target release:    ${target}`);
        log(`Changed files:     ${files.length}`);
        log(`Upstream changes: https://github.com/${upstreamRepository}/compare/${from}...${target}`);
        log(`Database or Edge contract files changed: ${databaseChanges ? 'yes — review docs/maintenance-and-recovery.md before merging' : 'no'}.`);
        for (;;) {
          const answer = (await ask('Create an update branch and commit these changes? [y/N] ')).toLowerCase();
          if (answer === 'y' || answer === 'yes') return true;
          if (answer === '' || answer === 'n' || answer === 'no') return false;
          log('Enter y or n.');
        }
      },
    });
  } catch (error) {
    if (!(error instanceof UpdateCancelled)) throw error;
    return { changed: false, cancelled: true };
  }
}

export async function runUpdate(args, { root = process.cwd(), input = process.stdin, output = process.stdout,
  env = process.env, upstream, validate } = {}) {
  if (args.length === 0) {
    const inCI = [env.CI, env.GITHUB_ACTIONS].some((value) => value && !/^(?:false|0)$/iu.test(value));
    if (!input.isTTY || !output.isTTY || inCI) {
      throw new Error('Interactive updates require a terminal outside CI. Use node scripts/update-studio.mjs local --target vX.Y.Z [--from vX.Y.Z].');
    }
    const result = await interactiveUpdate({ root, input, output, upstream, validate });
    printLocalResult(result, output);
    return result;
  }
  const [command, ...rest] = args;
  if (command === '--help') {
    output.write('Usage: node scripts/update-studio.mjs\n       node scripts/update-studio.mjs local --target vX.Y.Z [--from vX.Y.Z]\nRun without arguments in a terminal for guided local updates and confirmation after validation.\nUse --from only for the first explicit update. Local updates create a validated commit on a new branch; they do not push.\n');
    return;
  }
  if (command === 'local') {
    const { values } = parseArgs({ args: rest, options: { target: { type: 'string' }, from: { type: 'string' } } });
    const result = await updateLocal({ root, ...values, upstream, validate });
    printLocalResult(result, output);
    return result;
  }
  const directory = process.env.STUDIO_UPDATE_DIRECTORY
    ?? (process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, 'studio-update') : undefined);
  if (rest.length || !['prepare', 'validate', 'publish'].includes(command) || !directory) {
    throw new Error('Use node scripts/update-studio.mjs local --target vX.Y.Z [--from vX.Y.Z], or run the Update Studio workflow from the installation repository Actions tab.');
  }
  if (command === 'prepare') {
    const result = await prepareUpdate({
      root: process.cwd(), output: directory,
      from: process.env.STUDIO_UPDATE_FROM || undefined, target: process.env.STUDIO_UPDATE_TARGET,
    });
    console.log(result.changed ? `Prepared Studio ${result.target} for validation.` : `Studio is already based on ${result.target}.`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\nbase_commit=${result.baseCommit}\n`);
  } else if (command === 'validate') {
    validateUpdate({ bundle: directory });
    console.log('Studio update validation passed.');
  } else {
    const result = await publishUpdate({
      root: process.cwd(), bundle: directory,
      repository: process.env.GITHUB_REPOSITORY, token: process.env.GH_TOKEN,
    });
    const message = `${result.created ? 'Created update PR' : 'Existing update PR'}: ${result.url}`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n');
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    await runUpdate(process.argv.slice(2));
  } catch (error) {
    console.error(styleText(['bold', 'red'], 'Cannot complete the Studio update.', { stream: process.stderr }));
    console.error(error.message);
    process.exitCode = 1;
  }
}

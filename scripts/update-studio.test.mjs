import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareUpdate, publishUpdate, runUpdate, statePath, updateLocal, upstreamRepository, validateUpdate } from './update-studio.mjs';

const git = (root, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
  cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, HUSKY: '0', GIT_TERMINAL_PROMPT: '0' },
});
const write = (root, path, contents) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
};
const read = (root, path) => readFileSync(join(root, path), 'utf8');
const commit = (root, message = 'fixture') => {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD').trim();
};
function version(root, value) {
  write(root, 'package.json', JSON.stringify({ name: '@zeropress/studio', version: value }));
  write(root, 'package-lock.json', JSON.stringify({ version: value, packages: { '': { version: value } } }));
}

let directory;
let upstream;
let seed;
let sourceCommit;
let targetCommit;
let root;
let output;
let runDirectory;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'studio-updater-fixtures-'));
  upstream = join(directory, 'upstream');
  seed = join(directory, 'installation');
  mkdirSync(upstream);
  git(upstream, 'init', '-qb', 'main');
  version(upstream, '0.7.1');
  const files = {
    '.gitignore': '.env*\n.dev.vars*\nnode_modules/\ndist/\n.wrangler/\n',
    'wrangler.jsonc': JSON.stringify({ name: 'zeropress-studio', keep_vars: true, compatibility_date: '2026-09-07' }),
    '.github/workflows/test.yml': 'name: Package Tests\n',
    'worker/src/index.ts': ['const feature = 1;', ...Array.from({ length: 12 }, (_, n) => `// line ${n}`), 'const installation = "default";', ''].join('\n'),
    'obsolete.txt': 'old file\n',
    'logo.bin': Buffer.from([0, 1, 2, 3]),
  };
  for (const [path, contents] of Object.entries(files)) write(upstream, path, contents);
  sourceCommit = commit(upstream);
  git(upstream, 'tag', 'v0.7.1');

  // Deploy to Cloudflare installations can have an unrelated initial commit.
  mkdirSync(seed);
  git(seed, 'init', '-qb', 'main');
  version(seed, '0.7.1');
  for (const [path, contents] of Object.entries(files)) write(seed, path, contents);
  write(seed, 'wrangler.jsonc', '{"name":"customer-studio","keep_vars":true,"compatibility_date":"2026-09-07","d1_databases":[{"binding":"DB","database_id":"customer-database-id"}]}\n');
  write(seed, 'worker/src/index.ts', files['worker/src/index.ts'].replace('"default"', '"customer"'));
  write(seed, '.github/workflows/test.yml', 'name: Customer tests\n');
  write(seed, 'customer-notes.txt', 'keep\n');
  commit(seed);

  version(upstream, '0.7.2');
  write(upstream, 'worker/src/index.ts', files['worker/src/index.ts'].replace('feature = 1', 'feature = 2'));
  write(upstream, 'wrangler.jsonc', '// Reformatted by Wrangler\n{\n\t"keep_vars": true,\n\t"compatibility_date": "2026-09-07",\n\t"name": "zeropress-studio",\n}\n');
  write(upstream, 'logo.bin', Buffer.from([0, 1, 4, 3]));
  write(upstream, 'added.txt', 'new file\n');
  write(upstream, 'scripts/update-studio.mjs', '// Updater introduced in this release.\n');
  write(upstream, 'worker/src/system/schema-version.ts', 'export const STUDIO_SCHEMA_VERSION = 2;\n');
  rmSync(join(upstream, 'obsolete.txt'));
  targetCommit = commit(upstream);
  git(upstream, 'tag', 'v0.7.2');
  git(upstream, 'tag', 'v9.9.9');

  version(upstream, '0.7.3');
  write(upstream, 'added.txt', 'next release\n');
  commit(upstream);
  git(upstream, 'tag', 'v0.7.3');

  version(upstream, '0.8.0');
  write(upstream, 'wrangler.jsonc', '{"name":"zeropress-studio","keep_vars":true,"compatibility_date":"2026-09-26"}');
  commit(upstream);
  git(upstream, 'tag', 'v0.8.0');

  git(upstream, 'checkout', '--quiet', 'v0.7.2');
  version(upstream, '0.8.1');
  write(upstream, '.github/workflows/test.yml', 'name: New required tests\n');
  commit(upstream);
  git(upstream, 'tag', 'v0.8.1');

  git(upstream, 'checkout', '--quiet', 'v0.7.2');
  version(upstream, '0.8.2');
  write(upstream, '.github/workflows/update-studio.yml', 'name: Update Studio\n');
  commit(upstream);
  git(upstream, 'tag', 'v0.8.2');
  version(upstream, '0.8.3');
  rmSync(join(upstream, '.github/workflows/update-studio.yml'));
  write(upstream, 'scripts/templates/update-studio.yml', 'name: Update Studio\n');
  commit(upstream);
  git(upstream, 'tag', 'v0.8.3');
  version(upstream, '0.8.4');
  write(upstream, 'scripts/templates/update-studio.yml', 'name: Updated workflow\n');
  commit(upstream);
  git(upstream, 'tag', 'v0.8.4');
});

beforeEach(() => {
  runDirectory = mkdtempSync(join(directory, 'case-'));
  root = join(runDirectory, 'customer');
  output = join(runDirectory, 'update');
  git(directory, 'clone', '--quiet', '--no-local', '--depth=1', seed, root);
  write(root, '.env.local', 'PRIVATE_VALUE=preserved\n');
});
afterEach(() => rmSync(runDirectory, { recursive: true, force: true }));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const prepare = (options = {}) => prepareUpdate({ root, output, upstream, from: 'v0.7.1', target: 'v0.7.2', ...options });
const metadata = () => JSON.parse(read(output, 'metadata.json'));
function fakeGitHub(overrides = {}) {
  const request = vi.fn(async (path, options) => {
    if (path === '') return { default_branch: 'main' };
    if (path.startsWith('pulls?')) return [];
    if (path === 'git/ref/heads/main') return { object: { sha: metadata().baseCommit } };
    if (path.startsWith('git/ref/heads/zeropress')) return null;
    if (path === 'pulls' && options?.method === 'POST') return { html_url: 'https://github.com/customer/studio/pull/1' };
    throw new Error(`Unexpected GitHub request: ${path}`);
  });
  return { root, bundle: output, repository: 'customer/studio', token: 'fixture-token', request, push: vi.fn(), ...overrides };
}

describe('Studio release updates', () => {
  it('merges a fixed release into unrelated installation history while retaining installation files and custom code', async () => {
    const before = { head: git(root, 'rev-parse', 'HEAD'), index: readFileSync(join(root, '.git/index')), config: read(root, 'wrangler.jsonc') };
    expect(before.head.trim()).not.toBe(sourceCommit);
    const result = await prepare();
    const candidate = result.candidate;
    expect(result.changed).toBe(true);
    expect(read(candidate, 'worker/src/index.ts')).toContain('feature = 2');
    expect(read(candidate, 'worker/src/index.ts')).toContain('installation = "customer"');
    expect(read(candidate, 'wrangler.jsonc')).toBe(before.config);
    expect(read(candidate, '.github/workflows/test.yml')).toBe('name: Customer tests\n');
    expect(read(candidate, 'customer-notes.txt')).toBe('keep\n');
    expect(read(candidate, 'added.txt')).toBe('new file\n');
    expect(existsSync(join(candidate, 'obsolete.txt'))).toBe(false);
    expect(readFileSync(join(candidate, 'logo.bin'))).toEqual(Buffer.from([0, 1, 4, 3]));
    expect(JSON.parse(read(candidate, statePath))).toEqual({ format: 1, repository: upstreamRepository, tag: 'v0.7.2', commit: targetCommit });
    expect(metadata().databaseChanges).toBe(true);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before.head);
    expect(readFileSync(join(root, '.git/index'))).toEqual(before.index);
    expect(read(root, '.env.local')).toBe('PRIVATE_VALUE=preserved\n');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('uses the recorded release for subsequent updates and treats the same release as up to date', async () => {
    const result = await prepare();
    commit(result.candidate);
    const nextOutput = join(runDirectory, 'next-update');
    const next = await prepare({ root: result.candidate, output: nextOutput, from: undefined, target: 'v0.7.3' });
    expect(read(next.candidate, 'added.txt')).toBe('next release\n');
    const same = await prepare({ root: result.candidate, output: join(runDirectory, 'same-release'), from: undefined });
    expect(same.changed).toBe(false);
  });

  it('accepts an updater copied from the target release into an older installation', async () => {
    const updater = git(upstream, 'show', 'v0.7.2:scripts/update-studio.mjs');
    write(root, 'scripts/update-studio.mjs', updater);
    commit(root);
    const result = await prepare();
    expect(read(result.candidate, 'scripts/update-studio.mjs')).toBe(updater);
    expect(JSON.parse(read(result.candidate, statePath)).tag).toBe('v0.7.2');
  });

  it.each(['main', 'latest', 'v01.2.3', 'v0.7.3-beta.1', '--upload-pack=other'])('rejects an unfixed or invalid target %s', async (target) => {
    await expect(prepare({ target })).rejects.toThrow('fixed release tag');
  });

  it('rejects an unknown baseline, a downgrade, a missing tag, and a tag with the wrong package version', async () => {
    await expect(prepare({ from: undefined })).rejects.toThrow('first update');
    await expect(prepare({ target: 'v0.7.0' })).rejects.toThrow('cannot downgrade');
    await expect(prepare({ target: 'v0.9.0' })).rejects.toThrow('Cannot use upstream release');
    await expect(prepare({ target: 'v9.9.9' })).rejects.toThrow('package version');
  });

  it('blocks an upstream tag that no longer matches the recorded commit', async () => {
    write(root, statePath, JSON.stringify({ format: 1, repository: upstreamRepository, tag: 'v0.7.1', commit: 'a'.repeat(40) }));
    commit(root);
    await expect(prepare({ from: undefined })).rejects.toThrow('tag has moved');
  });

  it('preserves the installation when code conflicts or a locally modified file is removed upstream', async () => {
    write(root, 'worker/src/index.ts', read(root, 'worker/src/index.ts').replace('feature = 1', 'feature = 99'));
    write(root, 'obsolete.txt', 'customer data\n');
    const head = commit(root);
    await expect(prepare()).rejects.toThrow('conflicts with installation changes');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(read(root, 'obsolete.txt')).toBe('customer data\n');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('stops for semantic Wrangler changes and permits a workflow change after the customer applies it', async () => {
    await expect(prepare({ target: 'v0.8.0' })).rejects.toThrow('changes Wrangler settings');
    await expect(prepare({ target: 'v0.8.1' })).rejects.toThrow('apply .github/workflows/test.yml manually');
    write(root, '.github/workflows/test.yml', 'name: New required tests\n');
    commit(root);
    const result = await prepare({ target: 'v0.8.1' });
    expect(read(result.candidate, '.github/workflows/test.yml')).toBe('name: New required tests\n');
  });

  it('refuses uncommitted installation changes', async () => {
    write(root, 'customer-notes.txt', 'unsaved\n');
    await expect(prepare()).rejects.toThrow('uncommitted changes');
  });

  it('updates Cloudflare installations without requiring upstream CI workflows', async () => {
    git(root, 'rm', '.github/workflows/test.yml');
    commit(root);
    const result = await prepare({ target: 'v0.8.1' });
    expect(packageVersionIn(result.candidate)).toBe('0.8.1');
    expect(read(result.candidate, 'wrangler.jsonc')).toBe(read(root, 'wrangler.jsonc'));
  });

  it('preserves an installed updater when its canonical YAML moves into scripts', async () => {
    const first = await prepare({ target: 'v0.8.2' });
    write(first.candidate, '.github/workflows/update-studio.yml', 'name: Update Studio\n');
    commit(first.candidate);
    const moved = await prepare({ root: first.candidate, output: join(runDirectory, 'moved'), from: undefined, target: 'v0.8.3' });
    expect(read(moved.candidate, '.github/workflows/update-studio.yml')).toBe('name: Update Studio\n');
    expect(read(moved.candidate, 'scripts/templates/update-studio.yml')).toBe('name: Update Studio\n');
    commit(moved.candidate);
    await expect(prepare({ root: moved.candidate, output: join(runDirectory, 'changed-template'), from: undefined, target: 'v0.8.4' }))
      .rejects.toThrow('apply .github/workflows/update-studio.yml manually');
    write(moved.candidate, '.github/workflows/update-studio.yml', 'name: Updated workflow\n');
    commit(moved.candidate);
    const reviewed = await prepare({ root: moved.candidate, output: join(runDirectory, 'reviewed-template'), from: undefined, target: 'v0.8.4' });
    expect(read(reviewed.candidate, 'scripts/templates/update-studio.yml')).toBe('name: Updated workflow\n');
  });

  it('requires every validation to pass before publishing and invalidates an earlier successful validation on failure', async () => {
    await prepare();
    validateUpdate({ bundle: output, run: vi.fn() });
    expect(metadata().validated).toBe(true);
    const failure = vi.fn((command, args) => {
      if (args[0] === 'test') throw new Error('Candidate tests failed');
    });
    expect(() => validateUpdate({ bundle: output, run: failure })).toThrow('Candidate tests failed');
    const publisher = fakeGitHub();
    await expect(publishUpdate(publisher)).rejects.toThrow('has not passed validation');
    expect(publisher.request).not.toHaveBeenCalled();
    expect(publisher.push).not.toHaveBeenCalled();
  });

  it('rejects candidate source mutations during validation', async () => {
    const result = await prepare();
    expect(() => validateUpdate({ bundle: output, run: () => write(result.candidate, 'added.txt', 'rewritten by build') }))
      .toThrow('changed the candidate source');
  });

  it('runs the same candidate checks locally while leaving browser installation to the user', async () => {
    await prepare();
    const run = vi.fn();
    validateUpdate({ bundle: output, installBrowser: false, run });
    expect(run.mock.calls.map(([command, args]) => [command, ...args])).toEqual([
      ['npm', 'ci'], ['npm', 'run', 'format:wrangler:check'], ['npm', 'test'],
      ['npm', 'run', 'typecheck'], ['npm', 'run', 'deploy:dry-run'], ['npm', 'run', 'test:e2e'],
    ]);
    expect(metadata().validated).toBe(true);
  });

  it('provides the target Playwright version when local E2E preparation needs a browser', async () => {
    const result = await prepare();
    write(result.candidate, 'node_modules/playwright/package.json', '{"version":"1.63.0"}');
    expect(() => validateUpdate({ bundle: output, installBrowser: false, run: (command, args) => {
      if (args[1] === 'test:e2e') throw new Error('Chromium is not installed');
    } })).toThrow('npx --yes playwright@1.63.0 install chromium');
    expect(metadata().validated).toBeUndefined();
  });

  it('publishes the validated tree to a review branch and creates a PR with database guidance', async () => {
    await prepare();
    validateUpdate({ bundle: output, run: vi.fn() });
    const remote = join(runDirectory, 'remote.git');
    git(runDirectory, 'clone', '--quiet', '--bare', root, remote);
    const publisher = fakeGitHub({ push: vi.fn((cwd, repository, branch) => git(cwd, 'push', remote, `HEAD:refs/heads/${branch}`)) });
    const result = await publishUpdate(publisher);
    expect(result).toEqual({ created: true, url: 'https://github.com/customer/studio/pull/1' });
    expect(git(remote, 'rev-parse', 'main').trim()).toBe(metadata().baseCommit);
    expect(git(remote, 'rev-parse', 'zeropress/update-studio-v0.7.2^{tree}').trim()).toBe(metadata().tree);
    const [, options] = publisher.request.mock.calls.find(([path, options]) => path === 'pulls' && options?.method === 'POST');
    expect(options.body.base).toBe('main');
    expect(options.body.body).toContain('Database or Edge mail contract files changed');
    expect(options.body.body).toContain(targetCommit);
  });

  it('reuses an existing PR without pushing over customer edits', async () => {
    await prepare();
    validateUpdate({ bundle: output, run: vi.fn() });
    const publisher = fakeGitHub({ request: vi.fn(async (path) => path === ''
      ? { default_branch: 'main' } : [{ state: 'open', html_url: 'https://github.com/customer/studio/pull/2' }]) });
    expect(await publishUpdate(publisher)).toEqual({ created: false, url: 'https://github.com/customer/studio/pull/2' });
    expect(publisher.push).not.toHaveBeenCalled();
  });

  it('resumes after a successful branch push and failed PR creation without pushing again', async () => {
    await prepare();
    validateUpdate({ bundle: output, run: vi.fn() });
    const remote = join(runDirectory, 'remote.git');
    git(runDirectory, 'clone', '--quiet', '--bare', root, remote);
    const publisher = fakeGitHub({ push: vi.fn((cwd, repository, branch) => git(cwd, 'push', remote, `HEAD:refs/heads/${branch}`)) });
    const ordinaryRequest = publisher.request.getMockImplementation();
    publisher.request.mockImplementation((path, options) => {
      if (path === 'pulls' && options?.method === 'POST') throw new Error('Temporary GitHub error');
      return ordinaryRequest(path, options);
    });
    await expect(publishUpdate(publisher)).rejects.toThrow('Temporary GitHub error');

    const retryRoot = join(runDirectory, 'retry');
    git(runDirectory, 'clone', '--quiet', '--branch', 'main', remote, retryRoot);
    const branchCommit = git(remote, 'rev-parse', 'zeropress/update-studio-v0.7.2').trim();
    publisher.root = retryRoot;
    publisher.push.mockClear();
    publisher.request.mockImplementation((path, options) => {
      if (path.startsWith('git/ref/heads/zeropress')) return { object: { sha: branchCommit } };
      if (path === `git/commits/${branchCommit}`) return { tree: { sha: metadata().tree }, parents: [{ sha: metadata().baseCommit }] };
      return ordinaryRequest(path, options);
    });
    expect((await publishUpdate(publisher)).created).toBe(true);
    expect(publisher.push).not.toHaveBeenCalled();
    expect(git(remote, 'rev-parse', 'main').trim()).toBe(metadata().baseCommit);
  });

  it('rejects a changed base branch and a modified patch before writing to GitHub', async () => {
    await prepare();
    validateUpdate({ bundle: output, run: vi.fn() });
    const publisher = fakeGitHub();
    const ordinaryRequest = publisher.request.getMockImplementation();
    publisher.request.mockImplementation((path, options) => path === 'git/ref/heads/main'
      ? { object: { sha: 'f'.repeat(40) } } : ordinaryRequest(path, options));
    await expect(publishUpdate(publisher)).rejects.toThrow('branch changed during validation');
    write(output, 'update.patch', read(output, 'update.patch') + '\n');
    await expect(publishUpdate(publisher)).rejects.toThrow('invalid or has changed');
    expect(publisher.push).not.toHaveBeenCalled();
  });
});

const packageVersionIn = (directory) => JSON.parse(read(directory, 'package.json')).version;

function terminal() {
  const input = new PassThrough();
  let text = ''; let offset = 0;
  const output = new Writable({ write(chunk, encoding, done) { text += chunk.toString(); done(); } });
  input.isTTY = true; output.isTTY = true; output.columns = 120;
  return {
    input, output,
    text: () => stripVTControlCharacters(text),
    async answer(prompt, answer, beforeAnswer = () => {}) {
      await vi.waitFor(() => expect(stripVTControlCharacters(text.slice(offset))).toContain(prompt));
      offset = text.length;
      beforeAnswer();
      if (answer === null) input.end();
      else input.write(answer === '\x03' ? answer : answer + '\n');
    },
    close() { input.destroy(); output.destroy(); },
  };
}

describe('local Studio updates', () => {
  let remote;
  let originalHead;
  const validate = (options) => validateUpdate({ ...options, run: vi.fn() });
  const update = (options = {}) => updateLocal({ root, from: 'v0.7.1', target: 'v0.7.2', upstream, validate, ...options });

  beforeEach(() => {
    remote = join(runDirectory, 'origin.git');
    git(runDirectory, 'clone', '--quiet', '--bare', root, remote);
    git(root, 'remote', 'set-url', 'origin', remote);
    git(root, 'config', 'user.name', 'Installation Operator');
    git(root, 'config', 'user.email', 'operator@example.com');
    git(root, 'config', 'commit.gpgsign', 'false');
    git(root, 'config', 'core.hooksPath', join(root, '.git/hooks'));
    originalHead = git(root, 'rev-parse', 'HEAD').trim();
  });

  it('commits the validated update with the local identity and hooks while preserving the base and remote', async () => {
    const hook = join(root, '.git/hooks/pre-commit');
    writeFileSync(hook, '#!/bin/sh\nprintf "ran" > "$(git rev-parse --git-dir)/hook-ran"\n');
    chmodSync(hook, 0o755);
    const result = await update();
    expect(result).toMatchObject({ changed: true, base: 'main', target: 'v0.7.2', databaseChanges: true });
    expect(result.branch).toMatch(/^studio-update\/\d{6}-\d{4}-[a-f0-9]{6}$/u);
    expect(git(root, 'branch', '--show-current').trim()).toBe(result.branch);
    expect(git(root, 'log', '-1', '--format=%s').trim()).toBe('chore: update Studio to v0.7.2');
    expect(git(root, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Installation Operator <operator@example.com>');
    expect(read(root, '.git/hook-ran')).toBe('ran');
    expect(git(root, 'rev-parse', 'main').trim()).toBe(originalHead);
    expect(git(remote, 'for-each-ref', '--format=%(refname)').trim()).toBe('refs/heads/main');
    expect(git(remote, 'rev-parse', 'main').trim()).toBe(originalHead);
    expect(read(root, '.env.local')).toBe('PRIVATE_VALUE=preserved\n');
    expect(JSON.parse(read(root, statePath)).tag).toBe('v0.7.2');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('uses the remote default branch instead of a stale origin/HEAD or main assumption', async () => {
    git(root, 'branch', '-m', 'production');
    git(remote, 'branch', '-m', 'production');
    const result = await update();
    expect(result.base).toBe('production');
    expect(git(root, 'rev-parse', 'production').trim()).toBe(originalHead);
  });

  it.each(['staged', 'unstaged', 'untracked'])('preserves %s changes and refuses the update', async (kind) => {
    const path = kind === 'untracked' ? 'new.txt' : 'customer-notes.txt';
    write(root, path, 'user work\n');
    if (kind === 'staged') git(root, 'add', '--', path);
    const index = readFileSync(join(root, '.git/index'));
    await expect(update()).rejects.toThrow('uncommitted changes');
    expect(read(root, path)).toBe('user work\n');
    expect(readFileSync(join(root, '.git/index'))).toEqual(index);
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(originalHead);
  });

  it.each(['feature', 'detached', 'merge'])('requires an idle default branch when the checkout is %s', async (state) => {
    if (state === 'feature') git(root, 'switch', '-c', 'feature');
    if (state === 'detached') git(root, 'checkout', '--detach');
    if (state === 'merge') write(root, '.git/MERGE_HEAD', originalHead + '\n');
    await expect(update()).rejects.toThrow(state === 'merge' ? 'Finish the current Git' : 'default branch');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(originalHead);
  });

  it.each(['ahead', 'behind', 'diverged'])('requires synchronization when the local branch is %s', async (state) => {
    if (state !== 'ahead') {
      const peer = join(runDirectory, 'peer');
      git(runDirectory, 'clone', '--quiet', remote, peer);
      write(peer, 'remote.txt', 'remote change\n');
      commit(peer);
      git(peer, 'push', 'origin', 'main');
    }
    if (state !== 'behind') {
      write(root, 'local.txt', 'local change\n');
      commit(root);
    }
    const head = git(root, 'rev-parse', 'HEAD');
    await expect(update()).rejects.toThrow('differs from origin/main');
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('explains a missing origin, unresolved remote HEAD, and an upstream checkout', async () => {
    git(root, 'remote', 'remove', 'origin');
    await expect(update()).rejects.toThrow('origin remote');
    git(root, 'remote', 'add', 'origin', remote);
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/missing');
    await expect(update()).rejects.toThrow('Cannot determine');
    git(root, 'remote', 'set-url', 'origin', 'git@github.com:zeropress-app/zeropress-studio.git');
    await expect(update()).rejects.toThrow('not the upstream repository');
  });

  it('preserves the original checkout when candidate validation fails', async () => {
    const index = readFileSync(join(root, '.git/index'));
    await expect(update({ validate: () => { throw new Error('Candidate tests failed'); } })).rejects.toThrow('Candidate tests failed');
    expect(git(root, 'branch', '--show-current').trim()).toBe('main');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(originalHead);
    expect(readFileSync(join(root, '.git/index'))).toEqual(index);
    expect(packageVersionIn(root)).toBe('0.7.1');
  });

  it('rechecks local edits and remote changes after validation', async () => {
    await expect(update({ validate: (options) => {
      validate(options);
      write(root, 'customer-notes.txt', 'written during validation\n');
    } })).rejects.toThrow('uncommitted changes');
    expect(read(root, 'customer-notes.txt')).toBe('written during validation\n');
    git(root, 'restore', '--', 'customer-notes.txt');
    await expect(update({ validate: (options) => {
      validate(options);
      git(remote, 'branch', '-m', 'renamed');
    } })).rejects.toThrow('default branch (renamed)');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(originalHead);
  });

  it.each(['checkout', 'origin'])('rechecks %s changes made during final confirmation', async (location) => {
    await expect(update({ confirm: () => {
      if (location === 'checkout') write(root, 'customer-notes.txt', 'edited while confirming\n');
      else git(remote, 'branch', '-m', 'renamed');
      return true;
    } })).rejects.toThrow(location === 'checkout' ? 'uncommitted changes' : 'default branch (renamed)');
    expect(git(root, 'branch', '--show-current').trim()).toBe('main');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(originalHead);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
  });

  it('leaves a failed local commit on its review branch without resetting the staged update', async () => {
    const hook = join(root, '.git/hooks/pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    await expect(update()).rejects.toThrow('finish or discard this branch manually');
    expect(git(root, 'branch', '--show-current').trim()).toMatch(/^studio-update\//u);
    expect(git(root, 'rev-parse', 'main').trim()).toBe(originalHead);
    expect(git(root, 'diff', '--cached', '--name-only')).toContain(statePath);
    expect(packageVersionIn(root)).toBe('0.7.2');
  });

  it('honors local commit signing instead of silently disabling it', async () => {
    const signer = join(root, '.git/failing-signer');
    writeFileSync(signer, '#!/bin/sh\nexit 1\n');
    chmodSync(signer, 0o755);
    git(root, 'config', 'commit.gpgsign', 'true');
    git(root, 'config', 'gpg.program', signer);
    await expect(update()).rejects.toThrow('finish or discard this branch manually');
    expect(git(root, 'config', '--local', '--get', 'commit.gpgsign').trim()).toBe('true');
    expect(git(root, 'rev-parse', 'main').trim()).toBe(originalHead);
  });

  it('accepts an already installed release without creating an update commit', async () => {
    expect(await update({ target: 'v0.7.1' })).toMatchObject({ changed: false, target: 'v0.7.1' });
    expect(git(root, 'branch', '--show-current').trim()).toBe('main');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(originalHead);
  });

  it('explains local command syntax and rejects unknown options before working on Git', async () => {
    await expect(runUpdate(['local', '--target', 'latest'])).rejects.toThrow('fixed release tag');
    await expect(runUpdate(['local', '--target', 'v0.7.3', '--push'])).rejects.toThrow('Unknown option');
    await expect(runUpdate([])).rejects.toThrow('local --target');
  });

  describe('guided terminal updates', () => {
    let io;
    let validation;
    let bundle;
    const start = (args = [], overrides = {}) => {
      const pending = runUpdate(args, { root, upstream, validate: validation,
        input: io.input, output: io.output, env: {}, ...overrides });
      // Keep failures handled while the driver waits for a prompt.
      pending.catch(() => {});
      return pending;
    };
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request'); }));
      io = terminal();
      validation = vi.fn((options) => {
        bundle = options.bundle;
        validate(options);
      });
      bundle = undefined;
    });
    afterEach(() => { io.close(); vi.unstubAllGlobals(); });

    it('retries invalid versions, validates before confirmation, and creates only a reviewed local commit', async () => {
      const index = readFileSync(join(root, '.git/index'));
      const pending = start();
      await io.answer('Installed release [v0.7.1]: ', 'latest');
      await io.answer('Installed release [v0.7.1]: ', 'v0.7.0');
      await io.answer('Installed release [v0.7.1]: ', '');
      await io.answer('Target release (vX.Y.Z): ', 'latest');
      await io.answer('Target release (vX.Y.Z): ', 'v0.6.0');
      await io.answer('Target release (vX.Y.Z): ', 'v0.7.2');
      await io.answer('Create an update branch and commit these changes? [y/N] ', 'maybe', () => {
        expect(validation).toHaveBeenCalledTimes(1);
        expect(git(root, 'status', '--porcelain')).toBe('');
        expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(originalHead);
        expect(readFileSync(join(root, '.git/index'))).toEqual(index);
      });
      await io.answer('Create an update branch and commit these changes? [y/N] ', ' yes ');
      const result = await pending;
      expect(result).toMatchObject({ changed: true, target: 'v0.7.2' });
      expect(git(root, 'branch', '--show-current').trim()).toBe(result.branch);
      expect(git(remote, 'rev-parse', 'main').trim()).toBe(originalHead);
      expect(git(root, 'rev-parse', 'main').trim()).toBe(originalHead);
      expect(existsSync(dirname(bundle))).toBe(false);
      for (const message of ['must match package.json', 'Downgrades are not supported', 'Running npm ci', 'Running npm run test:e2e',
        'Validation passed.', 'Changed files:', 'Database or Edge contract files changed: yes', 'Enter y or n.',
        'git show HEAD', `git push --set-upstream origin ${result.branch}`]) expect(io.text()).toContain(message);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('uses the recorded release without asking the installed version again', async () => {
      write(root, statePath, JSON.stringify({ format: 1, repository: upstreamRepository, tag: 'v0.7.1', commit: sourceCommit }));
      commit(root);
      git(root, 'push', 'origin', 'main');
      const pending = start();
      await io.answer('Target release (vX.Y.Z): ', 'v0.7.2');
      await io.answer('Create an update branch and commit these changes? [y/N] ', 'y');
      expect(await pending).toMatchObject({ changed: true, target: 'v0.7.2' });
      expect(io.text()).toContain('Installed release: v0.7.1 (recorded in .zeropress/upstream.json)');
      expect(io.text()).not.toContain('Installed release [');
    });

    it.each([
      ['installed', null], ['target', '\x03'], ['confirm', null], ['confirm', '\x03'], ['confirm', ''], ['confirm', 'n'],
    ])('cancels at %s for %j without changing the checkout or index', async (stage, answer) => {
      const index = readFileSync(join(root, '.git/index'));
      const pending = start();
      await io.answer('Installed release [v0.7.1]: ', stage === 'installed' ? answer : '');
      if (stage !== 'installed') await io.answer('Target release (vX.Y.Z): ', stage === 'target' ? answer : 'v0.7.2');
      if (stage === 'confirm') await io.answer('Create an update branch and commit these changes? [y/N] ', answer);
      expect(await pending).toMatchObject({ changed: false, cancelled: true });
      expect(git(root, 'branch', '--show-current').trim()).toBe('main');
      expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(originalHead);
      expect(git(root, 'status', '--porcelain')).toBe('');
      expect(readFileSync(join(root, '.git/index'))).toEqual(index);
      expect(io.text()).toContain('Studio update cancelled.');
      if (bundle) expect(existsSync(dirname(bundle))).toBe(false);
      else expect(validation).not.toHaveBeenCalled();
    });

    it('reports an already installed release without validation or a commit prompt', async () => {
      const pending = start();
      await io.answer('Installed release [v0.7.1]: ', '');
      await io.answer('Target release (vX.Y.Z): ', 'v0.7.1');
      expect(await pending).toMatchObject({ changed: false, target: 'v0.7.1' });
      expect(validation).not.toHaveBeenCalled();
      expect(io.text()).toContain('Studio is already based on v0.7.1.');
      expect(io.text()).not.toContain('Create an update branch');
      expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(originalHead);
    });

    it('does not ask for confirmation after a failed validation', async () => {
      validation.mockImplementation(() => { throw new Error('Candidate tests failed'); });
      const pending = start();
      await io.answer('Installed release [v0.7.1]: ', '');
      await io.answer('Target release (vX.Y.Z): ', 'v0.7.2');
      await expect(pending).rejects.toThrow('Candidate tests failed');
      expect(io.text()).not.toContain('Validation passed.');
      expect(io.text()).not.toContain('Create an update branch');
      expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(originalHead);
    });

    it('checks repository state before asking for versions', async () => {
      write(root, 'customer-notes.txt', 'uncommitted\n');
      await expect(start()).rejects.toThrow('uncommitted changes');
      expect(io.text()).not.toContain('Installed release [');
      expect(validation).not.toHaveBeenCalled();
    });

    it.each(['stdin', 'stdout', 'CI', 'GITHUB_ACTIONS'])('rejects no-argument execution with %s before accessing a repository', async (mode) => {
      if (mode === 'stdin') io.input.isTTY = false;
      if (mode === 'stdout') io.output.isTTY = false;
      await expect(start([], { root: join(runDirectory, 'missing'), env: { [mode]: 'true' } }))
        .rejects.toThrow('Interactive updates require a terminal outside CI');
      expect(io.text()).toBe('');
      expect(validation).not.toHaveBeenCalled();
    });

    it('keeps explicit local commands non-interactive even in a CI environment', async () => {
      const result = await start(['local', '--from', 'v0.7.1', '--target', 'v0.7.2'], { env: { CI: 'true' } });
      expect(result.changed).toBe(true);
      expect(io.text()).not.toContain('Installed release [');
      expect(io.text()).not.toContain('Create an update branch');
      expect(validation).toHaveBeenCalledTimes(1);
    });
  });
});

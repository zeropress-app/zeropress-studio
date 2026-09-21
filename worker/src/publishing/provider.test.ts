import { describe, expect, it, vi } from 'vitest';
import { createGithubPublisher } from './provider';
import {
  forbidPublishingNetwork,
  syntheticGithub,
  TARGET,
  TOKEN,
} from './test-support';
forbidPublishingNetwork();
describe('GitHub metadata provider', () => {
  it('pins nested path traversal and file history to HEAD without fetching content', async () => {
    const api = syntheticGithub();
    const result = await createGithubPublisher(TOKEN, api).inspect(TARGET);
    expect(result.file.commit.sha).toBe(api.state.lastCommit);
    expect(result.file.blob_sha).toBe(api.state.blob);
    expect(api.requests.map(({ url }) => url.pathname)).toEqual([
      '/repos/example/site/git/ref/heads/main',
      '/repos/example/site/git/commits/' + 'a'.repeat(40),
      '/repos/example/site/commits',
      '/repos/example/site/git/trees/' + 'd'.repeat(40),
      '/repos/example/site/git/trees/' + '1'.repeat(40),
    ]);
  });
  it('resolves a branch containing a slash by checking actual branch references', async () => {
    const target = { ...TARGET, branch: 'release/current' };
    const api = syntheticGithub({ target });
    expect(
      (
        await createGithubPublisher(TOKEN, api).resolveUrl(
          'https://github.com/example/site/blob/release/current/data/preview.json',
        )
      ).file.target,
    ).toEqual(target);
  });
  it('requires manual input when two branch/file interpretations exist', async () => {
    const a = syntheticGithub({
      target: { ...TARGET, branch: 'release', path: 'current/data.json' },
    });
    const b = syntheticGithub({
      target: { ...TARGET, branch: 'release/current', path: 'data.json' },
    });
    let selected = a;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).includes('/git/ref/heads/'))
        selected = String(input).endsWith('release/current') ? b : a;
      return selected.fetch(input, init);
    });
    await expect(
      createGithubPublisher(TOKEN, { fetch }).resolveUrl(
        'https://github.com/example/site/blob/release/current/data.json',
      ),
    ).rejects.toMatchObject({ code: 'PUBLISHING_URL_AMBIGUOUS' });
  });
  it.each([
    { mode: '120000', type: 'blob' },
    { mode: '160000', type: 'commit' },
    { mode: '040000', type: 'tree' },
  ])('rejects a non-regular target %j', async (entry) => {
    await expect(
      createGithubPublisher(TOKEN, syntheticGithub(entry)).inspect(TARGET),
    ).rejects.toMatchObject({ code: 'PUBLISHING_TARGET_INVALID' });
  });
  it('refuses truncated trees and missing files instead of creating a new file', async () => {
    for (const [options, code] of [
      [{ truncated: true }, 'PUBLISHING_RESPONSE_INVALID'],
      [{ missing: true }, 'PUBLISHING_TARGET_NOT_FOUND'],
    ] as const)
      await expect(
        createGithubPublisher(TOKEN, syntheticGithub(options)).inspect(TARGET),
      ).rejects.toMatchObject({ code });
  });
  it.each(['v0.7.1', 'a'.repeat(40)])(
    'rejects tags and commit references as branches: %s',
    async (branch) => {
      await expect(
        createGithubPublisher(TOKEN, syntheticGithub()).resolveUrl(
          `https://github.com/example/site/blob/${branch}/data/preview.json`,
        ),
      ).rejects.toMatchObject({ code: 'PUBLISHING_TARGET_NOT_FOUND' });
    },
  );
  it.each([
    [401, 'PUBLISHING_AUTHENTICATION_FAILED'],
    [403, 'PUBLISHING_PERMISSION_DENIED'],
    [404, 'PUBLISHING_TARGET_NOT_FOUND'],
    [429, 'PUBLISHING_RATE_LIMITED'],
    [503, 'PUBLISHING_UNAVAILABLE'],
  ] as const)('classifies HTTP %s', async (status, code) => {
    await expect(
      createGithubPublisher(
        TOKEN,
        syntheticGithub({ readStatus: status }),
      ).inspect(TARGET),
    ).rejects.toMatchObject({ code });
  });
  it('honors secondary rate limits and aborts timed out requests', async () => {
    await expect(
      createGithubPublisher(
        TOKEN,
        syntheticGithub({ readStatus: 403, headers: { 'retry-after': '30' } }),
      ).inspect(TARGET),
    ).rejects.toMatchObject({ code: 'PUBLISHING_RATE_LIMITED' });
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('timeout')),
          ),
        ),
    );
    await expect(
      createGithubPublisher(TOKEN, { fetch, timeoutMs: 10 }).inspect(TARGET),
    ).rejects.toMatchObject({ code: 'PUBLISHING_UNAVAILABLE' });
  });
});

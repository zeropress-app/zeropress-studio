import { describe, expect, it } from 'vitest';
import {
  parseGithubFileUrl,
  publishRequestSchema,
  publishingTargetSchema,
  publishingSettingsSchema,
  PUBLISHING_DEFAULTS,
  githubTokenUrl,
  githubFileUrl,
} from './publishing';
const target = {
  owner: 'example',
  repo: 'site',
  branch: 'release/current',
  path: 'data/preview.json',
};
describe('publishing contracts', () => {
  it('requires the compared file and prepared data fingerprints for publishing', () => {
    const request = {
      expected_revision: '0'.repeat(32), expected_data_hash: 'd'.repeat(64), expected_blob_sha: 'b'.repeat(40),
    };
    expect(publishRequestSchema.parse(request)).toEqual(request);
    expect(publishRequestSchema.safeParse({ expected_revision: request.expected_revision }).success).toBe(false);
    expect(publishRequestSchema.safeParse({ ...request, expected_data_hash: 'invalid' }).success).toBe(false);
    expect(publishRequestSchema.safeParse({ ...request, expected_blob_sha: null }).success).toBe(false);
  });
  it('allows a disabled installation without a target and requires one when enabled', () => {
    expect(publishingSettingsSchema.parse(PUBLISHING_DEFAULTS)).toEqual(
      PUBLISHING_DEFAULTS,
    );
    expect(
      publishingSettingsSchema.safeParse({
        ...PUBLISHING_DEFAULTS,
        enabled: true,
      }).success,
    ).toBe(false);
    expect(publishingTargetSchema.parse(target)).toEqual(target);
  });
  it('parses URL components without guessing branch boundaries', () => {
    expect(parseGithubFileUrl(githubFileUrl(target) + '?plain=1#L1')).toEqual({
      owner: target.owner,
      repo: target.repo,
      segments: ['release', 'current', 'data', 'preview.json'],
    });
  });
  it.each([
    'https://evil.example/example/site/blob/main/data.json',
    'https://github.com.evil.example/o/r/blob/main/data.json',
    'https://token@github.com/o/r/blob/main/data.json',
    'https://github.com/o/r/blob/main/../data.json',
    'https://github.com/o/r/blob/main/%2e%2e/data.json',
    'https://github.com/o/r/blob/main/%2Fdata.json',
    'http://github.com/o/r/blob/main/data.json',
    'https://github.com/o/r/tree/main',
  ])('rejects an unsafe or non-file URL: %s', (value) =>
    expect(parseGithubFileUrl(value)).toBeNull(),
  );
  it.each([
    'HEAD',
    'a'.repeat(40),
    'main..old',
    'bad.lock',
    'bad@{1}',
    '/main',
    'main/',
    'main\nInjected: trailer',
  ])('rejects non-branch inputs: %s', (branch) =>
    expect(
      publishingTargetSchema.safeParse({ ...target, branch }).success,
    ).toBe(false),
  );
  it.each([
    '../data.json',
    'data/../data.json',
    'data.json\nZeroPress-Publish: 1',
    'file.txt',
    'data\\file.json',
  ])('rejects invalid paths: %s', (path) =>
    expect(publishingTargetSchema.safeParse({ ...target, path }).success).toBe(
      false,
    ),
  );
  it('prefills a fine-grained token with repository Contents write permission', () => {
    const url = new URL(githubTokenUrl(target.owner));
    expect(url.origin).toBe('https://github.com');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: 'ZeroPress Studio Publishing',
      contents: 'write',
      target_name: 'example',
    });
  });
});

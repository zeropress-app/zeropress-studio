import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  gitBlobSha,
  previewDataHash,
  publishCommitMessage,
  readPublishMetadata,
} from './metadata';
import { TARGET } from './test-support';

describe('publishing hashes and commit trailers', () => {
  it('ignores only the root generation time and object key order', async () => {
    const original = {
      generated_at: 'yesterday',
      generator: 'one',
      nested: { generated_at: 'nested', b: 2, a: ' value ' },
      list: [1, 2],
    };
    const hash = await previewDataHash(original);
    expect(
      await previewDataHash({
        list: [1, 2],
        nested: { a: ' value ', generated_at: 'nested', b: 2 },
        generator: 'one',
        generated_at: 'today',
      }),
    ).toBe(hash);
    for (const changed of [
      { ...original, generator: 'two' },
      { ...original, list: [2, 1] },
      { ...original, nested: { ...original.nested, generated_at: 'changed' } },
      { ...original, comment_token: 'changed' },
    ])
      expect(await previewDataHash(changed)).not.toBe(hash);
  });
  it('matches Git itself for UTF-8 data including a final LF', async () => {
    const bytes = new TextEncoder().encode('{"title":"한글 🌍"}\n');
    expect(await gitBlobSha(bytes)).toBe(
      execFileSync('git', ['hash-object', '--stdin'], {
        input: bytes,
        encoding: 'utf8',
      }).trim(),
    );
    expect(await gitBlobSha(new TextEncoder().encode('hello\n'))).toBe(
      'ce013625030ba8dba906f756967f9e9ca394464a',
    );
  });
  it('accepts only a complete, unambiguous trailer for the current blob and path', () => {
    const blobSha = 'b'.repeat(40),
      dataHash = 'c'.repeat(64);
    const message = publishCommitMessage({
      path: TARGET.path,
      blobSha,
      dataHash,
    });
    expect(readPublishMetadata(message, TARGET, blobSha)).toEqual({
      status: 'valid',
      metadata: { path: TARGET.path, blobSha, dataHash },
    });
    expect(readPublishMetadata('manual change', TARGET, blobSha).status).toBe(
      'missing',
    );
    expect(readPublishMetadata(message, TARGET, 'd'.repeat(40)).status).toBe(
      'mismatched',
    );
    for (const invalid of [
      message.replace('Publish: 1', 'Publish: 2'),
      message.replace(TARGET.path, 'other.json'),
      message.replace('sha256:', 'sha1:'),
      message + '\nZeroPress-Publish: 1',
      'ZeroPress-Path: hidden.json\n' + message,
      'zeropress-publish: 1\n' + message,
      message + '\nunrelated trailing text',
    ])
      expect(readPublishMetadata(invalid, TARGET, blobSha).status).toBe(
        'invalid',
      );
  });
});

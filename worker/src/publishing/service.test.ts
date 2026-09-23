import { describe, expect, it, vi } from 'vitest';
import { publishSite } from './service';
import { previewDataHash, publishCommitMessage } from './metadata';
import {
  forbidPublishingNetwork,
  previewDocument,
  syntheticGithub,
  TARGET,
  TOKEN,
} from './test-support';
forbidPublishingNetwork();
const run = async (
  api: ReturnType<typeof syntheticGithub>,
  document = previewDocument(),
) =>
  publishSite({
    target: TARGET,
    token: TOKEN,
    expectedDataHash: await previewDataHash(document.preview_data),
    expectedBlobSha: api.state.blob,
    fetch: api.fetch,
    generate: async () => document,
  });
describe('site publishing', () => {
  it('publishes a canonical JSON larger than 1 MB with correct blob metadata, then skips unchanged data', async () => {
    const api = syntheticGithub();
    const document = previewDocument();
    document.preview_data.site.description = 'Synthetic 🌍 '.repeat(120000);
    const result = await run(api, document);
    expect(result).toMatchObject({
      outcome: 'committed',
      file: { blob_sha: api.state.blob, data_hash: await previewDataHash(document.preview_data) },
    });
    const uploaded = Buffer.from(
      api.state.uploads[0]!.content!,
      'base64',
    ).toString('utf8');
    expect(Buffer.byteLength(uploaded)).toBeGreaterThan(1024 * 1024);
    expect(uploaded).toBe(
      JSON.stringify(document.preview_data, null, 2) + '\n',
    );
    expect(api.state.message).toContain(
      'ZeroPress-Blob-SHA: ' + api.state.blob,
    );
    document.preview_data.generated_at = '2026-09-22T00:00:00.000Z';
    expect(await run(api, document)).toMatchObject({ outcome: 'unchanged' });
    expect(api.state.uploads).toHaveLength(1);
    api.state.head = 'f'.repeat(40); // An unrelated file changed after this file's commit.
    expect(await run(api, document)).toMatchObject({ outcome: 'unchanged' });
    expect(api.state.uploads).toHaveLength(1);
    document.preview_data.site.title = 'Changed';
    expect(await run(api, document)).toMatchObject({ outcome: 'committed' });
    expect(api.state.uploads).toHaveLength(2);
  });
  it.each(['missing', 'damaged', 'external'])(
    'writes a new baseline when metadata is %s',
    async (kind) => {
      const dataHash = await previewDataHash(previewDocument().preview_data);
      const api = syntheticGithub({
        message:
          kind === 'external'
            ? publishCommitMessage({
                path: TARGET.path,
                dataHash,
                blobSha: '0'.repeat(40),
              })
            : kind,
        blob: 'b'.repeat(40),
      });
      expect(await run(api)).toMatchObject({ outcome: 'committed' });
      expect(api.state.uploads).toHaveLength(1);
    },
  );
  it.each([
    [409, 'changed SHA', 'PUBLISHING_CONFLICT'],
    [422, 'sha does not match', 'PUBLISHING_CONFLICT'],
    [403, 'protected branch', 'PUBLISHING_BRANCH_RESTRICTED'],
    [403, 'denied', 'PUBLISHING_PERMISSION_DENIED'],
    [404, 'deleted', 'PUBLISHING_TARGET_NOT_FOUND'],
  ] as const)(
    'does not retry rejected writes: %s %s',
    async (status, message, code) => {
      const api = syntheticGithub({ putStatus: status, putMessage: message });
      await expect(run(api)).rejects.toMatchObject({ code });
      expect(api.state.uploads).toHaveLength(1);
    },
  );
  it('confirms a lost write response using only metadata, without repeating PUT', async () => {
    const api = syntheticGithub({ loseResponse: true });
    expect(await run(api)).toMatchObject({ outcome: 'confirmed' });
    expect(api.state.uploads).toHaveLength(1);
  });
  it('returns an unknown outcome when a lost response cannot be reconciled', async () => {
    const api = syntheticGithub({ loseWithoutWrite: true });
    await expect(run(api)).rejects.toMatchObject({
      code: 'PUBLISHING_RESULT_UNKNOWN',
    });
    expect(api.state.uploads).toHaveLength(1);
  });
  it('rejects changed site data after preparation without writing to GitHub', async () => {
    const api = syntheticGithub();
    const document = previewDocument();
    const expectedDataHash = await previewDataHash(document.preview_data);
    document.preview_data.site.title = 'Edited after preparation';
    await expect(publishSite({
      target: TARGET, token: TOKEN, fetch: api.fetch,
      expectedDataHash, expectedBlobSha: api.state.blob,
      generate: async () => document,
    })).rejects.toMatchObject({ code: 'PUBLISHING_DATA_CHANGED' });
    expect(api.state.uploads).toHaveLength(0);
  });
  it('rejects a remote edit since comparison before generating or overwriting data', async () => {
    const api = syntheticGithub();
    const expectedBlobSha = api.state.blob;
    api.state.blob = 'f'.repeat(40);
    const generate = vi.fn(async () => previewDocument());
    await expect(publishSite({
      target: TARGET, token: TOKEN, fetch: api.fetch,
      expectedDataHash: await previewDataHash(previewDocument().preview_data),
      expectedBlobSha, generate,
    })).rejects.toMatchObject({ code: 'PUBLISHING_CONFLICT' });
    expect(generate).not.toHaveBeenCalled();
    expect(api.state.uploads).toHaveLength(0);
  });
  it('stops when the shared export preflight rejects the data', async () => {
    const api = syntheticGithub();
    const failure = Response.json(
      { success: false, error: { code: 'EDGE_TARGET_PROJECTION_PENDING' } },
      { status: 409 },
    );
    const generate = vi.fn(async () => failure);
    expect(
      await publishSite({
        target: TARGET,
        token: TOKEN,
        fetch: api.fetch,
        expectedDataHash: '0'.repeat(64),
        expectedBlobSha: api.state.blob,
        generate,
      }),
    ).toBe(failure);
    expect(api.state.uploads).toHaveLength(0);
  });
});

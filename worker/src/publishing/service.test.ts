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
const run = (
  api: ReturnType<typeof syntheticGithub>,
  document = previewDocument(),
) =>
  publishSite({
    target: TARGET,
    token: TOKEN,
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
      file: { blob_sha: api.state.blob },
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
        generate,
      }),
    ).toBe(failure);
    expect(api.state.uploads).toHaveLength(0);
  });
});

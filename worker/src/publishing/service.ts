import type {
  PublishingTarget,
  PublishingResult,
} from '../../../contracts/publishing';
import type { PreviewDataExportDocument } from '../../../contracts/preview-data';
import {
  createGithubPublisher,
  PublishingFailure,
  UncertainGithubWrite,
} from './provider';
import { gitBlobSha, previewDataHash, publishCommitMessage } from './metadata';

export async function publishSite(input: {
  target: PublishingTarget;
  token: string;
  expectedDataHash: string;
  expectedBlobSha: string;
  generate: () => Promise<PreviewDataExportDocument | Response>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<PublishingResult | Response> {
  const provider = createGithubPublisher(input.token, {
    fetch: input.fetch,
    signal: input.signal,
    timeoutMs: 60_000,
  });
  const snapshot = await provider.inspect(input.target);
  if (snapshot.file.blob_sha !== input.expectedBlobSha)
    throw new PublishingFailure('PUBLISHING_CONFLICT');
  const document = await input.generate();
  if (document instanceof Response) return document;
  const dataHash = await previewDataHash(document.preview_data);
  if (dataHash !== input.expectedDataHash)
    throw new PublishingFailure('PUBLISHING_DATA_CHANGED');
  if (snapshot.metadata?.dataHash === dataHash)
    return { outcome: 'unchanged', file: snapshot.file };
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(document.preview_data, null, 2)}\n`,
  );
  const blobSha = await gitBlobSha(bytes);
  const message = publishCommitMessage({
    path: input.target.path,
    dataHash,
    blobSha,
  });
  try {
    return {
      outcome: 'committed',
      file: await provider.update(snapshot, { bytes, blobSha, dataHash, message }),
    };
  } catch (error) {
    if (!(error instanceof UncertainGithubWrite)) throw error;
    // A lost PUT response is not permission to repeat the write.
    try {
      const current = await createGithubPublisher(input.token, {
        fetch: input.fetch,
        timeoutMs: 8_000,
      }).inspect(input.target);
      if (
        current.file.blob_sha === blobSha &&
        current.metadata?.dataHash === dataHash
      )
        return { outcome: 'confirmed', file: current.file };
    } catch {
      /* Leave the outcome unknown until GitHub can confirm it. */
    }
    throw new PublishingFailure('PUBLISHING_RESULT_UNKNOWN');
  }
}

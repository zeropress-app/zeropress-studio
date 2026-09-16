import {
  createManagedMediaUploadRequestSchema,
  type ManagedMediaUploadResponse,
} from '../../../contracts/media-upload';
import {
  requestCancelManagedMediaUploadIntent,
  requestCreateManagedMediaUploadIntent,
  uploadManagedMediaFile,
} from './media-client';

export type ManagedMediaUploadStage =
  | { kind: 'preparing' }
  | { kind: 'uploading'; uploadId: string }
  | { kind: 'completed' };

/**
 * One shared intent + byte-stream lifecycle for the upload queue, generated
 * images, and browser-authored image edits. A failed stream never leaves an
 * intent intentionally active; cancellation remains best-effort because the
 * server also expires intents durably.
 */
export async function storeManagedMediaFile(input: {
  csrfToken: string;
  file: File;
  width: number | null;
  height: number | null;
  durationMs?: number | null;
  alt: string;
  signal?: AbortSignal;
  onStage?: (stage: ManagedMediaUploadStage) => void;
  onProgress?: (loaded: number, total: number) => void;
}): Promise<ManagedMediaUploadResponse> {
  const request = createManagedMediaUploadRequestSchema.parse({
    filename: input.file.name,
    size_bytes: input.file.size,
    width: input.width,
    height: input.height,
    duration_ms: input.durationMs ?? null,
    alt: input.alt,
  });
  input.onStage?.({ kind: 'preparing' });
  let uploadId: string | null = null;
  try {
    const prepared = await requestCreateManagedMediaUploadIntent(
      input.csrfToken,
      request,
      input.signal,
    );
    if (!prepared.success) return prepared;
    uploadId = prepared.data.upload_id;
    if (input.signal?.aborted) {
      throw new DOMException('Upload aborted.', 'AbortError');
    }
    input.onStage?.({ kind: 'uploading', uploadId });
    const uploaded = await uploadManagedMediaFile({
      csrfToken: input.csrfToken,
      uploadId,
      file: input.file,
      signal: input.signal,
      onProgress: input.onProgress,
    });
    if (uploaded.success) {
      uploadId = null;
      input.onStage?.({ kind: 'completed' });
    }
    return uploaded;
  } finally {
    if (uploadId) {
      void requestCancelManagedMediaUploadIntent(input.csrfToken, uploadId)
        .catch(() => undefined);
    }
  }
}

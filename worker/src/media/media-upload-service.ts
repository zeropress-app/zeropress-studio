import type { Media } from '../../../contracts/media';
import type { MediaAiGeneration } from '../../../contracts/media-ai-generation';
import {
  MANAGED_MEDIA_SVG_UPLOAD_MAX_BYTES,
} from '../../../contracts/media-upload';
import {
  sanitizeSvg,
  SvgSanitizationError,
  SVG_SANITIZER_MAX_INPUT_BYTES,
  SVG_SANITIZER_POLICY,
} from '@zeropress/svg-hush';
import {
  completeManagedMediaUpload,
  getManagedMediaUploadIntent,
} from './media-upload-repository';
import {
  enforceExactUploadLength,
  inspectManagedMediaUploadBody,
  ManagedMediaUploadSizeError,
} from './media-upload-signature';
import { queueMediaObjectDeletion } from './media-object-cleanup';
import {
  logOperationalFailure,
  StudioOperationalError,
} from '../lib/operational-error';

export type StoreManagedMediaUploadResult =
  | { kind: 'completed'; media: Media }
  | { kind: 'intent_not_found' }
  | { kind: 'intent_expired' }
  | { kind: 'size_mismatch' }
  | { kind: 'signature_invalid' }
  | { kind: 'svg_sanitization_failed' }
  | { kind: 'source_conflict' };

const R2_UNKNOWN_STREAM_LENGTH_MESSAGE =
  'provided readable stream must have a known length';

if (MANAGED_MEDIA_SVG_UPLOAD_MAX_BYTES !== SVG_SANITIZER_MAX_INPUT_BYTES) {
  throw new TypeError('Studio SVG upload and sanitizer input limits differ.');
}

function isUnknownR2StreamLengthError(error: unknown): boolean {
  return error instanceof Error
    && error.message.toLowerCase().includes(R2_UNKNOWN_STREAM_LENGTH_MESSAGE);
}

async function compensateUploadedObject(input: {
  db: D1Database;
  bucket: R2Bucket;
  storageKey: string;
  now: Date;
  cause: unknown;
}): Promise<void> {
  try {
    await input.bucket.delete(input.storageKey);
  } catch (deleteError) {
    let queueError: unknown;
    try {
      await queueMediaObjectDeletion({
        db: input.db,
        storageKey: input.storageKey,
        now: input.now,
      });
    } catch (error) {
      queueError = error;
    }
    logOperationalFailure('MEDIA_UPLOAD_COMPENSATION_DELETE_FAILED', {
      cause: deleteError,
      metadata: {
        resource: 'MEDIA_BUCKET',
        related_resource: 'DB',
        action: 'compensate_failed_media_upload',
        storage_key: input.storageKey,
        database_error: input.cause instanceof Error
          ? input.cause.message
          : String(input.cause),
        queue_error: queueError instanceof Error
          ? queueError.message
          : queueError === undefined ? undefined : String(queueError),
      },
    });
  }
}

export async function storeManagedMediaUpload(input: {
  db: D1Database;
  bucket: R2Bucket;
  uploadId: string;
  userId: string;
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  now?: Date;
  createRevision?: () => string;
  generatedBy?: MediaAiGeneration;
}): Promise<StoreManagedMediaUploadResult> {
  const now = input.now ?? new Date();
  const intent = await getManagedMediaUploadIntent({
    db: input.db,
    id: input.uploadId,
    userId: input.userId,
  });
  if (!intent) return { kind: 'intent_not_found' };
  if (Date.parse(intent.expiresAtIso) <= now.getTime()) {
    return { kind: 'intent_expired' };
  }
  if (input.contentLength !== intent.sizeBytes) {
    return { kind: 'size_mismatch' };
  }

  let object: R2Object | null;
  let streamSizeMismatch = false;
  let storedSizeBytes = intent.sizeBytes;
  try {
    let uploadBody: Uint8Array | ReadableStream<Uint8Array>;
    if (intent.descriptor.mime_type === 'image/svg+xml') {
      if (intent.sizeBytes > MANAGED_MEDIA_SVG_UPLOAD_MAX_BYTES) {
        return { kind: 'svg_sanitization_failed' };
      }
      const checkedBody = enforceExactUploadLength(
        input.body,
        intent.sizeBytes,
        () => { streamSizeMismatch = true; },
      );
      const source = await new Response(checkedBody).bytes();
      try {
        uploadBody = sanitizeSvg(source);
      } catch (error) {
        if (error instanceof SvgSanitizationError) {
          return { kind: 'svg_sanitization_failed' };
        }
        throw new StudioOperationalError('MEDIA_UPLOAD_SVG_SANITIZER_FAILED', {
          cause: error,
          metadata: {
            resource: 'SVG_SANITIZER',
            action: 'sanitize_managed_svg_upload',
          },
        });
      }
      storedSizeBytes = uploadBody.byteLength;
    } else {
      const inspected = await inspectManagedMediaUploadBody({
        body: input.body,
        signature: intent.descriptor.signature,
      });
      if (!inspected.valid || !inspected.stream) {
        return { kind: 'signature_invalid' };
      }
      const checkedBody = enforceExactUploadLength(
        inspected.stream,
        intent.sizeBytes,
        () => { streamSizeMismatch = true; },
      );
      // Signature inspection and exact-size validation rebuild the incoming
      // Request body as ordinary streams. R2 requires the final stream itself
      // to carry a known length; Content-Length alone is not enough.
      uploadBody = checkedBody.pipeThrough(
        new FixedLengthStream(intent.sizeBytes),
      );
    }
    object = await input.bucket.put(
      intent.storageKey,
      uploadBody,
      {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: {
          contentType: intent.descriptor.mime_type,
          cacheControl: 'public, max-age=31536000, immutable',
          contentDisposition: intent.descriptor.disposition,
        },
        customMetadata: {
          zeropress_media_id: intent.mediaId,
          ...(input.generatedBy ? {
            zeropress_origin: 'ai-generated',
            zeropress_ai_model: input.generatedBy.model,
            zeropress_ai_prompt_version: input.generatedBy.prompt_version,
            zeropress_ai_aspect_ratio: input.generatedBy.aspect_ratio,
            zeropress_ai_seed: String(input.generatedBy.seed),
          } : {}),
          ...(intent.descriptor.mime_type === 'image/svg+xml'
            ? { zeropress_svg_policy: SVG_SANITIZER_POLICY }
            : {}),
        },
      },
    );
  } catch (error) {
    if (streamSizeMismatch || error instanceof ManagedMediaUploadSizeError) {
      return { kind: 'size_mismatch' };
    }
    if (error instanceof StudioOperationalError) throw error;
    const code = isUnknownR2StreamLengthError(error)
      ? 'MEDIA_UPLOAD_STREAM_LENGTH_METADATA_LOST'
      : 'MEDIA_UPLOAD_R2_WRITE_FAILED';
    throw new StudioOperationalError(code, {
      cause: error,
      metadata: {
        resource: 'MEDIA_BUCKET',
        action: 'put_media_object',
        ...(code === 'MEDIA_UPLOAD_STREAM_LENGTH_METADATA_LOST'
          ? { reason: 'final_stream_length_unknown' }
          : {}),
        storage_key: intent.storageKey,
        media_id: intent.mediaId,
      },
    });
  }
  if (!object) return { kind: 'source_conflict' };
  if (object.size !== storedSizeBytes) {
    await compensateUploadedObject({
      db: input.db,
      bucket: input.bucket,
      storageKey: intent.storageKey,
      now,
      cause: new ManagedMediaUploadSizeError(),
    });
    return { kind: 'size_mismatch' };
  }

  try {
    const media = await completeManagedMediaUpload({
      db: input.db,
      intent,
      storedSizeBytes,
      aiGeneration: input.generatedBy,
      now,
      createRevision: input.createRevision,
    });
    return { kind: 'completed', media };
  } catch (error) {
    await compensateUploadedObject({
      db: input.db,
      bucket: input.bucket,
      storageKey: intent.storageKey,
      now,
      cause: error,
    });
    throw error;
  }
}

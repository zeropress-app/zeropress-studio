import type { Context } from 'hono';
import {
  AI_IMAGE_SEED_MAX,
  generateAiImageSuccessSchema,
  type GenerateAiImageRequest,
} from '../../../contracts/ai-image';
import { createManagedMediaUploadRequestSchema } from '../../../contracts/media-upload';
import {
  MEDIA_AI_GENERATION_VERSION,
  mediaAiGenerationSchema,
} from '../../../contracts/media-ai-generation';
import { errorResponse } from '../lib/http';
import { logOperationalFailure } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import { createManagedMediaUploadIntent } from '../media/media-upload-repository';
import { storeManagedMediaUpload } from '../media/media-upload-service';
import {
  AI_IMAGE_MODEL,
  AI_IMAGE_PROMPT_VERSION,
  AiImageContentRejectedError,
  AiImageProviderError,
  AiImageResponseInvalidError,
  generateAiImage,
} from './image-service';
import { requireAiGenerationCapacity } from './request-boundary';

export type GenerateAiImage = typeof generateAiImage;

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! & AI_IMAGE_SEED_MAX;
}

function generatedFilename(input: {
  now: Date;
  seed: number;
  extension: 'jpg' | 'png';
}): string {
  const timestamp = input.now.toISOString()
    .replace(/[-:]/gu, '')
    .replace(/\.\d{3}Z$/u, 'Z');
  return `ai-generated-${timestamp}-${input.seed}.${input.extension}`;
}

export async function handleAiImageRequest(input: {
  context: Context<StudioHonoEnvironment>;
  request: GenerateAiImageRequest;
  userId: string;
  bucket: R2Bucket;
  now: Date;
  generate?: GenerateAiImage;
  createUploadIntent?: typeof createManagedMediaUploadIntent;
  storeUpload?: typeof storeManagedMediaUpload;
  createId?: () => string;
  createRevision?: () => string;
}): Promise<Response> {
  const { context: c } = input;
  const ai = await requireAiGenerationCapacity({
    context: c,
    userId: input.userId,
    action: 'generate_image',
    limiterAction: 'limit_image_generation',
    targetType: 'media',
  });
  if (ai instanceof Response) return ai;

  const seed = input.request.seed ?? randomSeed();
  let generated;
  try {
    generated = await (input.generate ?? generateAiImage)({
      ai,
      prompt: input.request.prompt,
      aspectRatio: input.request.aspect_ratio,
      seed,
    });
  } catch (error) {
    if (error instanceof AiImageContentRejectedError) {
      return errorResponse(c, 422, 'AI_IMAGE_CONTENT_REJECTED');
    }
    if (error instanceof AiImageResponseInvalidError) {
      logOperationalFailure('AI_IMAGE_RESPONSE_INVALID', {
        metadata: {
          resource: 'AI',
          action: 'generate_image',
          target_type: 'media',
          model: AI_IMAGE_MODEL,
          prompt_version: AI_IMAGE_PROMPT_VERSION,
        },
      });
      return errorResponse(c, 502, 'AI_IMAGE_RESPONSE_INVALID');
    }
    const reason = error instanceof AiImageProviderError
      ? error.reason
      : 'request_failed';
    logOperationalFailure('AI_IMAGE_GENERATION_FAILED', {
      metadata: {
        resource: 'AI',
        action: 'generate_image',
        target_type: 'media',
        model: AI_IMAGE_MODEL,
        prompt_version: AI_IMAGE_PROMPT_VERSION,
        reason,
        ...(error instanceof AiImageProviderError ? {
          ...(error.providerStatus === undefined ? {} : {
            provider_status: error.providerStatus,
          }),
          ...(error.providerCode === undefined ? {} : {
            provider_code: error.providerCode,
          }),
        } : {}),
      },
    });
    return errorResponse(c, 503, 'AI_SERVICE_UNAVAILABLE');
  }

  const authored = createManagedMediaUploadRequestSchema.parse({
    filename: generatedFilename({
      now: input.now,
      seed: generated.seed,
      extension: generated.extension,
    }),
    size_bytes: generated.bytes.byteLength,
    width: generated.width,
    height: generated.height,
    duration_ms: null,
    alt: input.request.alt,
  });
  const prepared = await (
    input.createUploadIntent ?? createManagedMediaUploadIntent
  )({
    db: c.env.DB,
    userId: input.userId,
    authored,
    enforceQueueLimit: false,
    now: input.now,
    createId: input.createId,
  });
  if (prepared.kind !== 'completed') {
    logOperationalFailure('AI_IMAGE_STORAGE_FAILED', {
      metadata: {
        resource: 'DB',
        related_resource: 'MEDIA_BUCKET',
        action: 'create_ai_image_upload_intent',
        reason: prepared.kind,
      },
    });
    return errorResponse(c, 503, 'MEDIA_UPLOAD_NOT_AVAILABLE');
  }
  const generation = mediaAiGenerationSchema.parse({
    version: MEDIA_AI_GENERATION_VERSION,
    model: AI_IMAGE_MODEL,
    prompt_version: AI_IMAGE_PROMPT_VERSION,
    prompt: input.request.prompt,
    aspect_ratio: input.request.aspect_ratio,
    seed: generated.seed,
  });
  const stored = await (input.storeUpload ?? storeManagedMediaUpload)({
    db: c.env.DB,
    bucket: input.bucket,
    uploadId: prepared.intent.id,
    userId: input.userId,
    body: new Blob([generated.bytes]).stream(),
    contentLength: generated.bytes.byteLength,
    now: input.now,
    createRevision: input.createRevision,
    generatedBy: generation,
  });
  if (stored.kind !== 'completed') {
    logOperationalFailure('AI_IMAGE_STORAGE_FAILED', {
      metadata: {
        resource: 'MEDIA_BUCKET',
        related_resource: 'DB',
        action: 'store_ai_generated_media',
        reason: stored.kind,
      },
    });
    return errorResponse(c, 503, 'MEDIA_UPLOAD_NOT_AVAILABLE');
  }
  return c.json(generateAiImageSuccessSchema.parse({
    success: true,
    data: {
      media: stored.media,
      generation,
    },
  }), 201);
}

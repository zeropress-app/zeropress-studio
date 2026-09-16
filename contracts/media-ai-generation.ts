import { z } from 'zod';

export const MEDIA_AI_GENERATION_VERSION = 1;
export const MEDIA_AI_GENERATION_JSON_MAX_CODE_UNITS = 16_384;
export const AI_IMAGE_PROMPT_MAX_CODE_POINTS = 2_048;
export const AI_IMAGE_SEED_MAX = 2_147_483_647;

export const aiImageAspectRatioSchema = z.enum([
  'landscape',
  'square',
  'portrait',
]);

const canonicalAiImagePromptSchema = z.string().superRefine((value, context) => {
  const length = Array.from(value).length;
  if (value !== value.trim() || length < 1 || length > AI_IMAGE_PROMPT_MAX_CODE_POINTS) {
    context.addIssue({
      code: 'custom',
      message: 'AI image prompts must be canonical and contain 1 to 2,048 Unicode code points.',
    });
  }
});

const aiImageModelSchema = z.string().superRefine((value, context) => {
  const length = Array.from(value).length;
  if (
    value !== value.trim()
    || length < 1
    || length > 255
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'AI image model identifiers must be canonical printable text.',
    });
  }
});

const aiImagePromptVersionSchema = z.string()
  .regex(/^[a-z][a-z0-9-]{0,63}$/u);

export const mediaAiGenerationSchema = z.object({
  version: z.literal(MEDIA_AI_GENERATION_VERSION),
  model: aiImageModelSchema,
  prompt_version: aiImagePromptVersionSchema,
  prompt: canonicalAiImagePromptSchema,
  aspect_ratio: aiImageAspectRatioSchema,
  seed: z.number().int().min(0).max(AI_IMAGE_SEED_MAX),
}).strict();

export function serializeMediaAiGeneration(
  value: MediaAiGeneration,
): string {
  const serialized = JSON.stringify(mediaAiGenerationSchema.parse(value));
  if (serialized.length > MEDIA_AI_GENERATION_JSON_MAX_CODE_UNITS) {
    throw new TypeError('AI image generation metadata exceeds its storage boundary.');
  }
  return serialized;
}

export function parseMediaAiGenerationJson(value: string): MediaAiGeneration {
  if (value.length > MEDIA_AI_GENERATION_JSON_MAX_CODE_UNITS) {
    throw new TypeError('Stored AI image generation metadata exceeds its boundary.');
  }
  return mediaAiGenerationSchema.parse(JSON.parse(value));
}

export type AiImageAspectRatio = z.infer<typeof aiImageAspectRatioSchema>;
export type MediaAiGeneration = z.infer<typeof mediaAiGenerationSchema>;

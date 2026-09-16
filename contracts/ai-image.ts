import { z } from 'zod';
import { apiErrorSchema } from './api';
import { mediaAltInputSchema, mediaSchema } from './media';
import {
  AI_IMAGE_PROMPT_MAX_CODE_POINTS,
  AI_IMAGE_SEED_MAX,
  aiImageAspectRatioSchema,
  mediaAiGenerationSchema,
} from './media-ai-generation';

export {
  AI_IMAGE_PROMPT_MAX_CODE_POINTS,
  AI_IMAGE_SEED_MAX,
  aiImageAspectRatioSchema,
} from './media-ai-generation';

export const AI_IMAGE_BINARY_MAX_BYTES = 8 * 1024 * 1024;

export const aiImagePromptSchema = z.string().transform((value, context) => {
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > AI_IMAGE_PROMPT_MAX_CODE_POINTS) {
    context.addIssue({
      code: 'custom',
      message: 'AI image prompts must contain 1 to 2,048 Unicode code points.',
    });
    return z.NEVER;
  }
  return normalized;
});

export const generateAiImageRequestSchema = z.object({
  prompt: aiImagePromptSchema,
  alt: mediaAltInputSchema,
  aspect_ratio: aiImageAspectRatioSchema,
  seed: z.number().int().min(0).max(AI_IMAGE_SEED_MAX).optional(),
}).strict();

export const generateAiImageSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    media: mediaSchema,
    generation: mediaAiGenerationSchema,
  }).strict(),
}).strict();

export const generateAiImageResponseSchema = z.union([
  generateAiImageSuccessSchema,
  apiErrorSchema,
]);

export type { AiImageAspectRatio } from './media-ai-generation';
export type GenerateAiImageRequest = z.infer<typeof generateAiImageRequestSchema>;
export type GenerateAiImageResponse = z.infer<typeof generateAiImageResponseSchema>;

import { z } from 'zod';
import { apiErrorSchema } from './api';

export const AI_EXCERPT_TITLE_MAX_LENGTH = 200;
export const AI_EXCERPT_CONTENT_MAX_LENGTH = 2_000_000;
export const AI_EXCERPT_MAX_LENGTH = 500;

export const aiExcerptDocumentTypeSchema = z.enum([
  'plaintext',
  'markdown',
  'html',
]);

export const aiExcerptRequestSchema = z.object({
  title: z.string().max(AI_EXCERPT_TITLE_MAX_LENGTH),
  content: z.string().max(AI_EXCERPT_CONTENT_MAX_LENGTH),
  document_type: aiExcerptDocumentTypeSchema,
}).strict();

export const aiExcerptSchema = z.string()
  .min(1)
  .max(AI_EXCERPT_MAX_LENGTH)
  .refine((value) => value === value.trim());

export const aiExcerptSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    excerpt: aiExcerptSchema,
    source_truncated: z.boolean(),
  }).strict(),
}).strict();

export const aiExcerptResponseSchema = z.union([
  aiExcerptSuccessSchema,
  apiErrorSchema,
]);

export type AiExcerptDocumentType = z.infer<
  typeof aiExcerptDocumentTypeSchema
>;
export type AiExcerptRequest = z.infer<typeof aiExcerptRequestSchema>;
export type AiExcerptSuccess = z.infer<typeof aiExcerptSuccessSchema>;
export type AiExcerptResponse = z.infer<typeof aiExcerptResponseSchema>;

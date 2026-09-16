import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  POST_TITLE_MAX_LENGTH,
} from './posts';
import {
  AI_CONTENT_DRAFT_BRIEF_MAX_LENGTH,
  AI_CONTENT_DRAFT_CONTENT_MAX_LENGTH,
  aiContentDraftCandidateSchema,
  aiContentDraftLengthSchema,
  aiContentDraftToneSchema,
  type AiContentDraftCandidate,
  type AiContentDraftLength,
  type AiContentDraftTone,
} from './ai-content-draft';

export const AI_POST_DRAFT_BRIEF_MAX_LENGTH =
  AI_CONTENT_DRAFT_BRIEF_MAX_LENGTH;
export const AI_POST_DRAFT_CONTENT_MAX_LENGTH =
  AI_CONTENT_DRAFT_CONTENT_MAX_LENGTH;
export const aiPostDraftToneSchema = aiContentDraftToneSchema;
export const aiPostDraftLengthSchema = aiContentDraftLengthSchema;

const aiPostDraftRequestShape = {
  title: z.string().max(POST_TITLE_MAX_LENGTH),
  brief: z.string().max(AI_POST_DRAFT_BRIEF_MAX_LENGTH),
  tone: aiPostDraftToneSchema,
  length: aiPostDraftLengthSchema,
};

export const aiPostDraftRequestSchema = z.discriminatedUnion(
  'document_type',
  [
    z.object({
      ...aiPostDraftRequestShape,
      document_type: z.literal('html'),
      editor_mode: z.enum(['source', 'visual']),
    }).strict(),
    z.object({
      ...aiPostDraftRequestShape,
      document_type: z.literal('markdown'),
      editor_mode: z.literal('source'),
    }).strict(),
    z.object({
      ...aiPostDraftRequestShape,
      document_type: z.literal('plaintext'),
      editor_mode: z.literal('source'),
    }).strict(),
  ],
);

export const aiPostDraftCandidateSchema = aiContentDraftCandidateSchema;

export const aiPostDraftSuccessSchema = z.object({
  success: z.literal(true),
  data: aiPostDraftCandidateSchema,
}).strict();

export const aiPostDraftResponseSchema = z.union([
  aiPostDraftSuccessSchema,
  apiErrorSchema,
]);

export type AiPostDraftTone = AiContentDraftTone;
export type AiPostDraftLength = AiContentDraftLength;
export type AiPostDraftRequest = z.infer<typeof aiPostDraftRequestSchema>;
type AiPostDraftTargetFromRequest<Request> = Request extends unknown
  ? Pick<Request, Extract<keyof Request, 'document_type' | 'editor_mode'>>
  : never;
export type AiPostDraftTarget = AiPostDraftTargetFromRequest<
  AiPostDraftRequest
>;
export type AiPostDraftCandidate = AiContentDraftCandidate;
export type AiPostDraftResponse = z.infer<typeof aiPostDraftResponseSchema>;

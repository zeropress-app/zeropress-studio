import { z } from 'zod';
import { apiErrorSchema } from './api';
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
import { PAGE_TITLE_MAX_LENGTH } from './pages';

export const AI_PAGE_DRAFT_BRIEF_MAX_LENGTH =
  AI_CONTENT_DRAFT_BRIEF_MAX_LENGTH;
export const AI_PAGE_DRAFT_CONTENT_MAX_LENGTH =
  AI_CONTENT_DRAFT_CONTENT_MAX_LENGTH;

export const aiPageDraftPresetSchema = z.enum([
  'general',
  'about',
  'landing',
  'policy_outline',
]);

const aiPageDraftRequestShape = {
  title: z.string().max(PAGE_TITLE_MAX_LENGTH),
  brief: z.string().max(AI_PAGE_DRAFT_BRIEF_MAX_LENGTH),
  preset: aiPageDraftPresetSchema,
  tone: aiContentDraftToneSchema,
  length: aiContentDraftLengthSchema,
};

export const aiPageDraftRequestSchema = z.discriminatedUnion(
  'document_type',
  [
    z.object({
      ...aiPageDraftRequestShape,
      document_type: z.literal('html'),
      editor_mode: z.enum(['source', 'visual']),
    }).strict(),
    z.object({
      ...aiPageDraftRequestShape,
      document_type: z.literal('markdown'),
      editor_mode: z.literal('source'),
    }).strict(),
    z.object({
      ...aiPageDraftRequestShape,
      document_type: z.literal('plaintext'),
      editor_mode: z.literal('source'),
    }).strict(),
  ],
);

export const aiPageDraftCandidateSchema = aiContentDraftCandidateSchema;

export const aiPageDraftSuccessSchema = z.object({
  success: z.literal(true),
  data: aiPageDraftCandidateSchema,
}).strict();

export const aiPageDraftResponseSchema = z.union([
  aiPageDraftSuccessSchema,
  apiErrorSchema,
]);

export type AiPageDraftPreset = z.infer<typeof aiPageDraftPresetSchema>;
export type AiPageDraftTone = AiContentDraftTone;
export type AiPageDraftLength = AiContentDraftLength;
export type AiPageDraftRequest = z.infer<typeof aiPageDraftRequestSchema>;
type AiPageDraftTargetFromRequest<Request> = Request extends unknown
  ? Pick<Request, Extract<keyof Request, 'document_type' | 'editor_mode'>>
  : never;
export type AiPageDraftTarget = AiPageDraftTargetFromRequest<AiPageDraftRequest>;
export type AiPageDraftCandidate = AiContentDraftCandidate;
export type AiPageDraftResponse = z.infer<typeof aiPageDraftResponseSchema>;

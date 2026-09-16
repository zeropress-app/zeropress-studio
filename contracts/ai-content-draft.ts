import { z } from 'zod';

export const AI_CONTENT_DRAFT_BRIEF_MAX_LENGTH = 8_000;
export const AI_CONTENT_DRAFT_CONTENT_MAX_LENGTH = 32_768;
export const AI_CONTENT_DRAFT_MAX_BLOCKS = 64;
export const AI_CONTENT_DRAFT_MAX_VISIBLE_CODE_POINTS = 16_000;

export const aiContentDraftToneSchema = z.enum([
  'informative',
  'professional',
  'conversational',
]);

export const aiContentDraftLengthSchema = z.enum([
  'short',
  'medium',
  'long',
]);

const aiContentDraftCandidateShape = {
  title: z.string()
    .min(1)
    .max(200)
    .refine((value) => value === value.trim()),
  excerpt: z.string()
    .min(1)
    .max(500)
    .refine((value) => value === value.trim()),
  content: z.string()
    .min(1)
    .max(AI_CONTENT_DRAFT_CONTENT_MAX_LENGTH),
};

export const aiContentDraftCandidateSchema = z.union([
  z.object({
    ...aiContentDraftCandidateShape,
    document_type: z.literal('html'),
    editor_mode: z.literal('visual'),
    editor_profile: z.literal('tiptap-v1'),
  }).strict(),
  z.object({
    ...aiContentDraftCandidateShape,
    document_type: z.literal('html'),
    editor_mode: z.literal('source'),
    editor_profile: z.null(),
  }).strict(),
  z.object({
    ...aiContentDraftCandidateShape,
    document_type: z.literal('markdown'),
    editor_mode: z.literal('source'),
    editor_profile: z.null(),
  }).strict(),
  z.object({
    ...aiContentDraftCandidateShape,
    document_type: z.literal('plaintext'),
    editor_mode: z.literal('source'),
    editor_profile: z.null(),
  }).strict(),
]);

export type AiContentDraftTone = z.infer<typeof aiContentDraftToneSchema>;
export type AiContentDraftLength = z.infer<typeof aiContentDraftLengthSchema>;
export type AiContentDraftCandidate = z.infer<
  typeof aiContentDraftCandidateSchema
>;
type AiContentDraftTargetFromCandidate<Candidate> = Candidate extends unknown
  ? Pick<
    Candidate,
    Extract<keyof Candidate, 'document_type' | 'editor_mode'>
  >
  : never;
export type AiContentDraftTarget = AiContentDraftTargetFromCandidate<
  AiContentDraftCandidate
>;

import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  contentEditorModeSchema,
} from './content-editor';
import { settingsRevisionSchema } from './settings-revision';

export const AI_POST_EDIT_SELECTION_MAX_LENGTH = 65_536;
export const AI_POST_EDIT_CONTEXT_MAX_LENGTH = 2_000;
export const AI_POST_EDIT_INSTRUCTION_MAX_LENGTH = 4_000;
export const AI_POST_EDIT_REPLACEMENT_MAX_LENGTH = 32_768;
export const AI_POST_EDIT_VISIBLE_MAX_CODE_POINTS = 12_000;

export const aiPostEditOperationSchema = z.enum(['expand', 'rewrite']);
export const aiPostEditToneSchema = z.enum([
  'preserve',
  'informative',
  'professional',
  'conversational',
]);
export const aiPostEditSelectionKindSchema = z.enum([
  'inline',
  'block',
  'source',
]);

const aiPostEditContextSchema = z.string()
  .max(AI_POST_EDIT_CONTEXT_MAX_LENGTH * 2)
  .refine(
    (value) => Array.from(value).length <= AI_POST_EDIT_CONTEXT_MAX_LENGTH,
    'AI Post edit context is too long.',
  );

const aiPostEditTargetSchema = z.discriminatedUnion('document_type', [
  z.object({
    document_type: z.literal('html'),
    editor_mode: contentEditorModeSchema,
  }).strict(),
  z.object({
    document_type: z.enum(['markdown', 'plaintext']),
    editor_mode: z.literal('source'),
  }).strict(),
]);

export const aiPostEditRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
  operation: aiPostEditOperationSchema,
  instruction: z.string().max(AI_POST_EDIT_INSTRUCTION_MAX_LENGTH),
  tone: aiPostEditToneSchema,
  target: aiPostEditTargetSchema,
  selection: z.object({
    kind: aiPostEditSelectionKindSchema,
    source: z.string().min(1).max(AI_POST_EDIT_SELECTION_MAX_LENGTH),
    context_before: aiPostEditContextSchema,
    context_after: aiPostEditContextSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.operation === 'expand' && value.instruction.trim() === '') {
    context.addIssue({
      code: 'custom',
      path: ['instruction'],
      message: 'Expansion requires author instructions.',
    });
  }
  if (
    value.selection.kind === 'inline'
    && !(value.target.document_type === 'html'
      && value.target.editor_mode === 'visual')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['selection', 'kind'],
      message: 'Inline selections are available only in the visual HTML editor.',
    });
  }
  if (
    value.selection.kind === 'block'
    && !(value.target.document_type === 'html'
      && value.target.editor_mode === 'visual')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['selection', 'kind'],
      message: 'Block selections are available only in the visual HTML editor.',
    });
  }
  if (
    value.selection.kind === 'source'
    && value.target.editor_mode !== 'source'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['selection', 'kind'],
      message: 'Source selections require source editor mode.',
    });
  }
});

export const aiPostEditReplacementSchema = z.string()
  .min(1)
  .max(AI_POST_EDIT_REPLACEMENT_MAX_LENGTH);

export const aiPostEditSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    replacement: aiPostEditReplacementSchema,
  }).strict(),
}).strict();

export const aiPostEditResponseSchema = z.union([
  aiPostEditSuccessSchema,
  apiErrorSchema,
]);

export type AiPostEditOperation = z.infer<typeof aiPostEditOperationSchema>;
export type AiPostEditTone = z.infer<typeof aiPostEditToneSchema>;
export type AiPostEditSelectionKind = z.infer<
  typeof aiPostEditSelectionKindSchema
>;
export type AiPostEditRequest = z.infer<typeof aiPostEditRequestSchema>;
export type AiPostEditResponse = z.infer<typeof aiPostEditResponseSchema>;
export type AiPostEditTarget = z.infer<typeof aiPostEditTargetSchema>;

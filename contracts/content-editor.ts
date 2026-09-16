import { z } from 'zod';

export const CONTENT_EDITOR_PROFILE = 'tiptap-v1' as const;
export const CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS = 131_072;
export const CONTENT_EDITOR_VISUAL_MAX_NODES = 5_000;

export const contentEditorModeSchema = z.enum(['source', 'visual']);
export const contentEditorProfileSchema = z.literal(CONTENT_EDITOR_PROFILE)
  .nullable();

export const contentEditorFieldsSchema = z.object({
  editor_mode: contentEditorModeSchema,
  editor_profile: contentEditorProfileSchema,
}).strict();

export function validateContentEditorState(
  value: {
    content: string;
    document_type: 'plaintext' | 'markdown' | 'html';
    editor_mode: 'source' | 'visual';
    editor_profile: typeof CONTENT_EDITOR_PROFILE | null;
  },
  context: z.core.$RefinementCtx,
) {
  if (value.editor_mode === 'visual') {
    if (
      value.document_type !== 'html'
      || value.editor_profile !== CONTENT_EDITOR_PROFILE
    ) {
      context.addIssue({
        code: 'custom',
        path: ['editor_mode'],
        message: 'Visual editing requires HTML and the tiptap-v1 profile.',
      });
    }
    if (value.content.length > CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS) {
      context.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'Visual HTML exceeds the editor size limit.',
      });
    }
    return;
  }

  if (value.editor_profile !== null) {
    context.addIssue({
      code: 'custom',
      path: ['editor_profile'],
      message: 'Source editing must not declare a visual editor profile.',
    });
  }
}

export function sourceEditorState() {
  return {
    editor_mode: 'source' as const,
    editor_profile: null,
  };
}

export function visualEditorState() {
  return {
    editor_mode: 'visual' as const,
    editor_profile: CONTENT_EDITOR_PROFILE,
  };
}

export type ContentEditorMode = z.infer<typeof contentEditorModeSchema>;
export type ContentEditorProfile = z.infer<typeof contentEditorProfileSchema>;

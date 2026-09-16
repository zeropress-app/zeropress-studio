import { describe, expect, it } from 'vitest';
import {
  AI_POST_DRAFT_BRIEF_MAX_LENGTH,
  AI_POST_DRAFT_CONTENT_MAX_LENGTH,
  aiPostDraftRequestSchema,
  aiPostDraftSuccessSchema,
} from './ai-post-draft';

describe('AI Post draft contract', () => {
  it('accepts the bounded closed generation request', () => {
    expect(aiPostDraftRequestSchema.parse({
      title: 'Working title',
      brief: 'Write a practical introduction.',
      tone: 'informative',
      length: 'medium',
      document_type: 'html',
      editor_mode: 'visual',
    })).toEqual({
      title: 'Working title',
      brief: 'Write a practical introduction.',
      tone: 'informative',
      length: 'medium',
      document_type: 'html',
      editor_mode: 'visual',
    });
    expect(aiPostDraftRequestSchema.safeParse({
      title: '',
      brief: 'x'.repeat(AI_POST_DRAFT_BRIEF_MAX_LENGTH + 1),
      tone: 'informative',
      length: 'medium',
      document_type: 'markdown',
      editor_mode: 'source',
    }).success).toBe(false);
    expect(aiPostDraftRequestSchema.safeParse({
      title: '', brief: '', tone: 'informative', length: 'medium',
      document_type: 'plaintext', editor_mode: 'source', extra: true,
    }).success).toBe(false);
    expect(aiPostDraftRequestSchema.safeParse({
      title: 'Title', brief: '', tone: 'informative', length: 'medium',
      document_type: 'markdown', editor_mode: 'visual',
    }).success).toBe(false);
  });

  it('accepts each canonical target format and rejects invalid editor pairs', () => {
    const base = {
      success: true,
      data: {
        title: 'Generated title',
        excerpt: 'Generated excerpt.',
        content: '<p>Generated body.</p>',
      },
    };
    expect(aiPostDraftSuccessSchema.safeParse({
      ...base,
      data: {
        ...base.data,
        document_type: 'html',
        editor_mode: 'visual',
        editor_profile: 'tiptap-v1',
      },
    }).success).toBe(true);
    for (const target of [
      { document_type: 'html', editor_mode: 'source', editor_profile: null },
      { document_type: 'markdown', editor_mode: 'source', editor_profile: null },
      { document_type: 'plaintext', editor_mode: 'source', editor_profile: null },
    ]) {
      expect(aiPostDraftSuccessSchema.safeParse({
        ...base,
        data: { ...base.data, ...target },
      }).success).toBe(true);
    }
    expect(aiPostDraftSuccessSchema.safeParse({
      ...base,
      data: {
        ...base.data,
        document_type: 'markdown',
        editor_mode: 'visual',
        editor_profile: 'tiptap-v1',
      },
    }).success).toBe(false);
    expect(aiPostDraftSuccessSchema.safeParse({
      success: true,
      data: {
        title: 'Generated title',
        excerpt: 'Generated excerpt.',
        content: 'x'.repeat(AI_POST_DRAFT_CONTENT_MAX_LENGTH + 1),
        document_type: 'html',
        editor_mode: 'visual',
        editor_profile: 'tiptap-v1',
      },
    }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  AI_PAGE_DRAFT_BRIEF_MAX_LENGTH,
  aiPageDraftRequestSchema,
  aiPageDraftSuccessSchema,
} from './ai-page-draft';

describe('AI Page draft contract', () => {
  it('accepts each explicit purpose in a bounded closed request', () => {
    for (const preset of ['general', 'about', 'landing', 'policy_outline']) {
      expect(aiPageDraftRequestSchema.safeParse({
        title: 'Working title',
        brief: 'Use only the supplied operational facts.',
        preset,
        tone: 'professional',
        length: 'medium',
        document_type: 'html',
        editor_mode: 'visual',
      }).success).toBe(true);
    }
    expect(aiPageDraftRequestSchema.safeParse({
      title: '',
      brief: 'x'.repeat(AI_PAGE_DRAFT_BRIEF_MAX_LENGTH + 1),
      preset: 'general',
      tone: 'informative',
      length: 'medium',
      document_type: 'markdown',
      editor_mode: 'source',
    }).success).toBe(false);
    expect(aiPageDraftRequestSchema.safeParse({
      title: 'Title', brief: '', preset: 'general', tone: 'informative',
      length: 'short', document_type: 'plaintext', editor_mode: 'source',
      unknown: true,
    }).success).toBe(false);
  });

  it('uses the same canonical editor-state candidates as Post drafts', () => {
    const base = {
      success: true,
      data: {
        title: 'About ZeroPress',
        excerpt: 'A concise introduction.',
        content: '<p>Generated body.</p>',
      },
    };
    expect(aiPageDraftSuccessSchema.safeParse({
      ...base,
      data: {
        ...base.data,
        document_type: 'html',
        editor_mode: 'visual',
        editor_profile: 'tiptap-v1',
      },
    }).success).toBe(true);
    expect(aiPageDraftSuccessSchema.safeParse({
      ...base,
      data: {
        ...base.data,
        document_type: 'markdown',
        editor_mode: 'visual',
        editor_profile: 'tiptap-v1',
      },
    }).success).toBe(false);
  });
});

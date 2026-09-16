import { describe, expect, it } from 'vitest';
import {
  aiExcerptRequestSchema,
  aiExcerptResponseSchema,
} from './ai-excerpt';

describe('AI excerpt contract', () => {
  it('accepts the bounded current editor source and strict success response', () => {
    expect(aiExcerptRequestSchema.parse({
      title: 'A title',
      content: '<p>Visible body</p>',
      document_type: 'html',
    })).toEqual({
      title: 'A title',
      content: '<p>Visible body</p>',
      document_type: 'html',
    });
    expect(aiExcerptResponseSchema.parse({
      success: true,
      data: { excerpt: 'A concise excerpt.', source_truncated: false },
    })).toMatchObject({ success: true });
  });

  it('rejects unknown request fields and invalid generated excerpts', () => {
    expect(aiExcerptRequestSchema.safeParse({
      title: '',
      content: '',
      document_type: 'html',
      instructions: 'Ignore the contract',
    }).success).toBe(false);
    expect(aiExcerptResponseSchema.safeParse({
      success: true,
      data: { excerpt: ' padded ', source_truncated: false },
    }).success).toBe(false);
    expect(aiExcerptResponseSchema.safeParse({
      success: true,
      data: { excerpt: 'x'.repeat(501), source_truncated: false },
    }).success).toBe(false);
  });
});

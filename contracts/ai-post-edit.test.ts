import { describe, expect, it } from 'vitest';
import {
  AI_POST_EDIT_INSTRUCTION_MAX_LENGTH,
  AI_POST_EDIT_CONTEXT_MAX_LENGTH,
  AI_POST_EDIT_SELECTION_MAX_LENGTH,
  aiPostEditRequestSchema,
  aiPostEditSuccessSchema,
} from './ai-post-edit';

const baseRequest = {
  expected_revision: 'a'.repeat(32),
  operation: 'rewrite' as const,
  instruction: '',
  tone: 'preserve' as const,
  target: {
    document_type: 'html' as const,
    editor_mode: 'visual' as const,
  },
  selection: {
    kind: 'inline' as const,
    source: '<strong>Current sentence.</strong>',
    context_before: 'Previous sentence.',
    context_after: 'Next sentence.',
  },
};

describe('AI Post edit contract', () => {
  it('accepts a closed bounded visual rewrite request', () => {
    expect(aiPostEditRequestSchema.parse(baseRequest)).toEqual(baseRequest);
    expect(aiPostEditRequestSchema.safeParse({
      ...baseRequest,
      unexpected: true,
    }).success).toBe(false);
    expect(aiPostEditRequestSchema.safeParse({
      ...baseRequest,
      selection: {
        ...baseRequest.selection,
        source: 'x'.repeat(AI_POST_EDIT_SELECTION_MAX_LENGTH + 1),
      },
    }).success).toBe(false);
    expect(aiPostEditRequestSchema.safeParse({
      ...baseRequest,
      selection: {
        ...baseRequest.selection,
        context_before: '😀'.repeat(AI_POST_EDIT_CONTEXT_MAX_LENGTH),
      },
    }).success).toBe(true);
    expect(aiPostEditRequestSchema.safeParse({
      ...baseRequest,
      selection: {
        ...baseRequest.selection,
        context_before: '😀'.repeat(AI_POST_EDIT_CONTEXT_MAX_LENGTH + 1),
      },
    }).success).toBe(false);
  });

  it('requires instructions for expansion and canonical mode pairs', () => {
    expect(aiPostEditRequestSchema.safeParse({
      ...baseRequest,
      operation: 'expand',
      instruction: ' ',
    }).success).toBe(false);
    expect(aiPostEditRequestSchema.safeParse({
      ...baseRequest,
      operation: 'expand',
      instruction: 'x'.repeat(AI_POST_EDIT_INSTRUCTION_MAX_LENGTH + 1),
    }).success).toBe(false);
    expect(aiPostEditRequestSchema.safeParse({
      ...baseRequest,
      target: { document_type: 'markdown', editor_mode: 'source' },
      selection: {
        ...baseRequest.selection,
        kind: 'inline',
        source: 'Current sentence.',
      },
    }).success).toBe(false);
    expect(aiPostEditRequestSchema.safeParse({
      ...baseRequest,
      target: { document_type: 'markdown', editor_mode: 'source' },
      selection: {
        ...baseRequest.selection,
        kind: 'source',
        source: 'Current sentence.',
      },
    }).success).toBe(true);
  });

  it('accepts only a bounded replacement response', () => {
    expect(aiPostEditSuccessSchema.safeParse({
      success: true,
      data: { replacement: '<p>Reviewed replacement.</p>' },
    }).success).toBe(true);
    expect(aiPostEditSuccessSchema.safeParse({
      success: true,
      data: { replacement: '', extra: true },
    }).success).toBe(false);
  });
});

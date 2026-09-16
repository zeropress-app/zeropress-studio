import { describe, expect, it } from 'vitest';
import {
  AI_IMAGE_PROMPT_MAX_CODE_POINTS,
  generateAiImageRequestSchema,
} from './ai-image';
import {
  parseMediaAiGenerationJson,
  serializeMediaAiGeneration,
} from './media-ai-generation';

describe('AI image contract', () => {
  it('normalizes one bounded request without exposing model controls', () => {
    expect(generateAiImageRequestSchema.parse({
      prompt: '  A quiet library at sunrise  ',
      alt: '  Quiet library  ',
      aspect_ratio: 'landscape',
      seed: 42,
    })).toEqual({
      prompt: 'A quiet library at sunrise',
      alt: 'Quiet library',
      aspect_ratio: 'landscape',
      seed: 42,
    });
    expect(generateAiImageRequestSchema.safeParse({
      prompt: 'A quiet library',
      alt: '',
      aspect_ratio: 'square',
      model: 'other-model',
    }).success).toBe(false);
  });

  it('counts Unicode code points at the prompt boundary', () => {
    expect(generateAiImageRequestSchema.safeParse({
      prompt: '😀'.repeat(AI_IMAGE_PROMPT_MAX_CODE_POINTS),
      alt: '',
      aspect_ratio: 'portrait',
    }).success).toBe(true);
    expect(generateAiImageRequestSchema.safeParse({
      prompt: '😀'.repeat(AI_IMAGE_PROMPT_MAX_CODE_POINTS + 1),
      alt: '',
      aspect_ratio: 'portrait',
    }).success).toBe(false);
  });

  it('round-trips strict, versioned Media provenance', () => {
    const generation = {
      version: 1 as const,
      model: '@cf/black-forest-labs/flux-2-klein-4b',
      prompt_version: 'image-v1',
      prompt: 'A quiet library at sunrise',
      aspect_ratio: 'landscape' as const,
      seed: 42,
    };
    expect(parseMediaAiGenerationJson(
      serializeMediaAiGeneration(generation),
    )).toEqual(generation);
    expect(() => parseMediaAiGenerationJson(JSON.stringify({
      ...generation,
      internal_prompt: 'not part of the contract',
    }))).toThrow();
  });
});

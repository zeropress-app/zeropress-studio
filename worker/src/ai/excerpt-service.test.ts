import { describe, expect, it, vi } from 'vitest';
import {
  AI_EXCERPT_MODEL,
  AI_EXCERPT_PROMPT_VERSION,
  AiExcerptProviderError,
  AiExcerptResponseInvalidError,
  AiExcerptSourceEmptyError,
  generateAiExcerpt,
  prepareAiExcerptSource,
} from './excerpt-service';

describe('AI excerpt service', () => {
  it('projects reader-visible source and rejects an empty document', () => {
    expect(prepareAiExcerptSource({
      title: '  Visible title  ',
      content: '<script>hidden()</script><p>Hello &amp; goodbye.</p>',
      document_type: 'html',
    })).toEqual({
      title: 'Visible title',
      contentPlainText: 'Hello & goodbye.',
      sourceTruncated: false,
    });
    expect(() => prepareAiExcerptSource({
      title: '   ',
      content: '<style>body { color: red }</style>',
      document_type: 'html',
    })).toThrow(AiExcerptSourceEmptyError);
  });

  it('keeps the first 12,000 and last 4,000 Unicode code points', () => {
    const source = prepareAiExcerptSource({
      title: '',
      content: `${'가'.repeat(12_100)}${'🙂'.repeat(4_100)}`,
      document_type: 'plaintext',
    });
    expect(source.sourceTruncated).toBe(true);
    expect(Array.from(source.contentPlainText!.split('\n\n')[0])).toHaveLength(12_000);
    expect(Array.from(source.contentPlainText!.split('\n\n').at(-1)!)).toHaveLength(4_000);
    expect(source.contentPlainText!.endsWith('🙂'.repeat(4_000))).toBe(true);
  });

  it('uses the fixed model and prompt version with structured output', async () => {
    const run = vi.fn().mockResolvedValue({ excerpt: 'A generated excerpt.' });
    const source = prepareAiExcerptSource({
      title: 'Title',
      content: '<p>Body text.</p>',
      document_type: 'html',
    });
    await expect(generateAiExcerpt({
      ai: { run } as unknown as Ai,
      source,
    })).resolves.toEqual({
      excerpt: 'A generated excerpt.',
      sourceTruncated: false,
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe(AI_EXCERPT_MODEL);
    expect(run.mock.calls[0][1]).toMatchObject({
      max_tokens: 512,
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: { required: ['excerpt'] },
      },
    });
    expect(JSON.stringify(run.mock.calls[0][1])).toContain(
      AI_EXCERPT_PROMPT_VERSION,
    );
  });

  it('parses a fenced provider response without retrying', async () => {
    const run = vi.fn().mockResolvedValue({
      response: '```json\n{"excerpt":"  Generated\\ntext.  "}\n```',
    });
    await expect(generateAiExcerpt({
      ai: { run } as unknown as Ai,
      source: {
        title: 'Title',
        contentPlainText: null,
        sourceTruncated: false,
      },
    })).resolves.toMatchObject({ excerpt: 'Generated text.' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('classifies invalid output and provider failure separately', async () => {
    await expect(generateAiExcerpt({
      ai: {
        run: vi.fn().mockResolvedValue({ response: '{"excerpt":""}' }),
      } as unknown as Ai,
      source: {
        title: 'Title',
        contentPlainText: null,
        sourceTruncated: false,
      },
    })).rejects.toBeInstanceOf(AiExcerptResponseInvalidError);

    const run = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    await expect(generateAiExcerpt({
      ai: { run } as unknown as Ai,
      source: {
        title: 'Title',
        contentPlainText: null,
        sourceTruncated: false,
      },
    })).rejects.toMatchObject({
      name: 'AiExcerptProviderError',
      reason: 'request_failed',
    } satisfies Partial<AiExcerptProviderError>);
    expect(run).toHaveBeenCalledOnce();
  });

  it('bounds a stalled provider request', async () => {
    await expect(generateAiExcerpt({
      ai: {
        run: vi.fn().mockReturnValue(new Promise(() => undefined)),
      } as unknown as Ai,
      source: {
        title: 'Title',
        contentPlainText: null,
        sourceTruncated: false,
      },
      timeoutMs: 1,
    })).rejects.toMatchObject({
      name: 'AiExcerptProviderError',
      reason: 'timeout',
    } satisfies Partial<AiExcerptProviderError>);
  });
});

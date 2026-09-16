import { describe, expect, it, vi } from 'vitest';
import type { AiPostEditRequest } from '../../../contracts/ai-post-edit';
import {
  AI_POST_EDIT_MODEL,
  AI_POST_EDIT_PROMPT_VERSION,
  AiPostEditResponseInvalidError,
  AiPostEditSelectionEmptyError,
  AiPostEditSelectionUnsupportedError,
  generateAiPostEdit,
  prepareAiPostEditSource,
} from './post-edit-service';

function request(input: Partial<AiPostEditRequest> = {}): AiPostEditRequest {
  return {
    expected_revision: 'a'.repeat(32),
    operation: 'rewrite',
    instruction: 'Make it more direct.',
    tone: 'preserve',
    target: { document_type: 'html', editor_mode: 'visual' },
    selection: {
      kind: 'block',
      source: '<p>Make the current sentence clearer.</p>',
      context_before: 'Previous sentence',
      context_after: 'Next sentence',
    },
    ...input,
  };
}

describe('AI Post edit service', () => {
  it('prepares reader-visible text and rejects protected or empty selections', () => {
    expect(prepareAiPostEditSource(request())).toMatchObject({
      selectedPlainText: 'Make the current sentence clearer.',
      htmlSourceShape: null,
      contextBefore: 'Previous sentence',
      contextAfter: 'Next sentence',
    });
    expect(() => prepareAiPostEditSource(request({
      selection: {
        kind: 'block',
        source: '<p><a href="https://example.com">Protected link</a></p>',
        context_before: '',
        context_after: '',
      },
    }))).toThrow(AiPostEditSelectionUnsupportedError);
    expect(() => prepareAiPostEditSource(request({
      selection: {
        kind: 'block',
        source: '<p> </p>',
        context_before: '',
        context_after: '',
      },
    }))).toThrow(AiPostEditSelectionEmptyError);
    expect(prepareAiPostEditSource(request({
      selection: {
        kind: 'block',
        source: '<p>Current sentence.</p>',
        context_before: '<a href="https://private.example">Visible label</a>',
        context_after: '<img src="https://private.example/image.png">After',
      },
    }))).toMatchObject({
      contextBefore: 'Visible label',
      contextAfter: 'After',
    });
  });

  it('uses fixed model and prompt constants and accepts safe semantic HTML', async () => {
    const run = vi.fn().mockResolvedValue({
      replacement: '<p>A clearer sentence.</p>',
    });
    await expect(generateAiPostEdit({
      ai: { run } as unknown as Ai,
      source: prepareAiPostEditSource(request()),
    })).resolves.toBe('<p>A clearer sentence.</p>');
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe(AI_POST_EDIT_MODEL);
    expect(run.mock.calls[0][1]).toMatchObject({
      max_tokens: 4_096,
      temperature: 0.3,
      response_format: {
        type: 'json_schema',
        json_schema: { required: ['replacement'] },
      },
    });
    expect(JSON.stringify(run.mock.calls[0][1])).toContain(
      AI_POST_EDIT_PROMPT_VERSION,
    );
  });

  it('preserves inline text shape and HTML-escapes plain source replacements', async () => {
    const inline = prepareAiPostEditSource(request({
      selection: {
        kind: 'inline',
        source: '<strong>Selected words</strong>',
        context_before: '',
        context_after: '',
      },
    }));
    await expect(generateAiPostEdit({
      ai: { run: vi.fn().mockResolvedValue({ replacement: 'Clear words' }) } as unknown as Ai,
      source: inline,
    })).resolves.toBe('Clear words');

    const sourceText = prepareAiPostEditSource(request({
      target: { document_type: 'html', editor_mode: 'source' },
      selection: {
        kind: 'source',
        source: 'Selected words',
        context_before: '<p>',
        context_after: '</p>',
      },
    }));
    expect(sourceText.htmlSourceShape).toBe('text');
    await expect(generateAiPostEdit({
      ai: { run: vi.fn().mockResolvedValue({
        replacement: 'A < B & "quoted"',
      }) } as unknown as Ai,
      source: sourceText,
    })).resolves.toBe('A &lt; B &amp; &quot;quoted&quot;');
  });

  it('rejects generated links, attributes, and malformed envelopes', async () => {
    for (const replacement of [
      '<p onclick="alert(1)">Unsafe.</p>',
      '<p><a href="https://example.com">Unsafe link.</a></p>',
      '<!-- hidden instruction --><p>Unsafe comment.</p>',
    ]) {
      await expect(generateAiPostEdit({
        ai: { run: vi.fn().mockResolvedValue({ replacement }) } as unknown as Ai,
        source: prepareAiPostEditSource(request()),
      })).rejects.toBeInstanceOf(AiPostEditResponseInvalidError);
    }
    await expect(generateAiPostEdit({
      ai: { run: vi.fn().mockResolvedValue({ text: 'missing envelope' }) } as unknown as Ai,
      source: prepareAiPostEditSource(request()),
    })).rejects.toBeInstanceOf(AiPostEditResponseInvalidError);
  });
});

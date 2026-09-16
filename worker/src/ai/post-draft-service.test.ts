import { describe, expect, it, vi } from 'vitest';
import {
  AI_POST_DRAFT_MODEL,
  AI_POST_DRAFT_PROMPT_VERSION,
  AiPostDraftProviderError,
  AiPostDraftResponseInvalidError,
  AiPostDraftSourceEmptyError,
  generateAiPostDraft,
  prepareAiPostDraftSource,
} from './post-draft-service';

const validOutput = {
  title: 'A safe draft title',
  excerpt: 'A draft excerpt for human review.',
  blocks: [
    { type: 'heading', level: 2, text: 'Getting started' },
    { type: 'paragraph', text: 'The first paragraph contains <script> as text.' },
    { type: 'bullet_list', items: ['First item', 'Second & item'] },
    { type: 'blockquote', text: 'A quotation to review' },
    { type: 'code_block', text: 'const value = "<safe>";\nvalue;' },
  ],
} as const;

describe('AI Post draft service', () => {
  it('normalizes the author source and rejects a blank request', () => {
    expect(prepareAiPostDraftSource({
      title: '  Working title ',
      brief: '  Cover the practical steps. ',
      tone: 'informative',
      length: 'medium',
      document_type: 'html',
      editor_mode: 'visual',
    })).toEqual({
      title: 'Working title',
      brief: 'Cover the practical steps.',
      tone: 'informative',
      length: 'medium',
      documentType: 'html',
      editorMode: 'visual',
    });
    expect(() => prepareAiPostDraftSource({
      title: '  ',
      brief: '\n',
      tone: 'informative',
      length: 'medium',
      document_type: 'plaintext',
      editor_mode: 'source',
    })).toThrow(AiPostDraftSourceEmptyError);
  });

  it('uses fixed model and prompt constants with a bounded structured response', async () => {
    const run = vi.fn().mockResolvedValue(validOutput);
    await expect(generateAiPostDraft({
      ai: { run } as unknown as Ai,
      source: prepareAiPostDraftSource({
        title: 'Title',
        brief: 'Please write a draft.',
        tone: 'professional',
        length: 'short',
        document_type: 'html',
        editor_mode: 'visual',
      }),
    })).resolves.toMatchObject({
      title: validOutput.title,
      excerpt: validOutput.excerpt,
      document_type: 'html',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toBe(AI_POST_DRAFT_MODEL);
    expect(run.mock.calls[0][1]).toMatchObject({
      max_tokens: 4_096,
      temperature: 0.5,
      top_p: 0.9,
      repetition_penalty: 1.1,
      response_format: {
        type: 'json_schema',
        json_schema: { required: ['title', 'excerpt', 'blocks'] },
      },
    });
    expect(JSON.stringify(run.mock.calls[0][1])).toContain(
      AI_POST_DRAFT_PROMPT_VERSION,
    );
  });

  it('escapes every generated block and emits deterministic Tiptap HTML', async () => {
    const result = await generateAiPostDraft({
      ai: { run: vi.fn().mockResolvedValue(validOutput) } as unknown as Ai,
      source: {
        title: null,
        brief: 'Write safely.',
        tone: 'informative',
        length: 'medium',
        documentType: 'html',
        editorMode: 'visual',
      },
    });
    expect(result.content).toBe([
      '<h2>Getting started</h2>',
      '<p>The first paragraph contains &lt;script&gt; as text.</p>',
      '<ul>',
      '  <li>',
      '    <p>First item</p>',
      '  </li>',
      '  <li>',
      '    <p>Second &amp; item</p>',
      '  </li>',
      '</ul>',
      '<blockquote>',
      '  <p>A quotation to review</p>',
      '</blockquote>',
      '<pre>const value = &quot;&lt;safe&gt;&quot;;\nvalue;</pre>',
    ].join('\n'));
    expect(result.content).not.toMatch(/<script|onclick|javascript:/iu);
  });

  it('serializes the same semantic blocks for HTML source, Markdown, and plaintext', async () => {
    const run = vi.fn().mockResolvedValue(validOutput);
    const common = {
      ai: { run } as unknown as Ai,
      source: {
        title: null,
        brief: 'Write safely.',
        tone: 'informative' as const,
        length: 'medium' as const,
      },
    };

    const htmlSource = await generateAiPostDraft({
      ...common,
      source: {
        ...common.source,
        documentType: 'html',
        editorMode: 'source',
      },
    });
    expect(htmlSource).toMatchObject({
      document_type: 'html',
      editor_mode: 'source',
      editor_profile: null,
    });
    expect(htmlSource.content).toContain('&lt;script&gt;');

    const markdown = await generateAiPostDraft({
      ...common,
      source: {
        ...common.source,
        documentType: 'markdown',
        editorMode: 'source',
      },
    });
    expect(markdown).toMatchObject({
      document_type: 'markdown',
      editor_mode: 'source',
      editor_profile: null,
    });
    expect(markdown.content).toBe([
      '## Getting started',
      '',
      'The first paragraph contains \\<script\\> as text.',
      '',
      '- First item',
      '- Second & item',
      '',
      '> A quotation to review',
      '',
      '```',
      'const value = "<safe>";',
      'value;',
      '```',
    ].join('\n'));

    const plaintext = await generateAiPostDraft({
      ...common,
      source: {
        ...common.source,
        documentType: 'plaintext',
        editorMode: 'source',
      },
    });
    expect(plaintext).toMatchObject({
      document_type: 'plaintext',
      editor_mode: 'source',
      editor_profile: null,
    });
    expect(plaintext.content).toBe([
      'Getting started',
      '',
      'The first paragraph contains <script> as text.',
      '',
      '• First item',
      '• Second & item',
      '',
      '> A quotation to review',
      '',
      '    const value = "<safe>";',
      '    value;',
    ].join('\n'));
  });

  it('parses wrapped JSON and rejects invalid or oversized model output', async () => {
    await expect(generateAiPostDraft({
      ai: {
        run: vi.fn().mockResolvedValue({
          response: `\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``,
        }),
      } as unknown as Ai,
      source: {
        title: 'Title', brief: null, tone: 'informative', length: 'short',
        documentType: 'html', editorMode: 'source',
      },
    })).resolves.toMatchObject({ title: validOutput.title });

    await expect(generateAiPostDraft({
      ai: {
        run: vi.fn().mockResolvedValue({
          ...validOutput,
          blocks: Array.from({ length: 5 }, () => ({
            type: 'paragraph',
            text: '가'.repeat(4_000),
          })),
        }),
      } as unknown as Ai,
      source: {
        title: 'Title', brief: null, tone: 'informative', length: 'long',
        documentType: 'markdown', editorMode: 'source',
      },
    })).rejects.toBeInstanceOf(AiPostDraftResponseInvalidError);
  });

  it('does not retry provider failure and bounds a stalled request', async () => {
    const failed = vi.fn().mockRejectedValue(new Error('private provider text'));
    await expect(generateAiPostDraft({
      ai: { run: failed } as unknown as Ai,
      source: {
        title: 'Title', brief: null, tone: 'informative', length: 'short',
        documentType: 'plaintext', editorMode: 'source',
      },
    })).rejects.toMatchObject({
      name: 'AiPostDraftProviderError',
      reason: 'request_failed',
    } satisfies Partial<AiPostDraftProviderError>);
    expect(failed).toHaveBeenCalledOnce();

    await expect(generateAiPostDraft({
      ai: {
        run: vi.fn().mockReturnValue(new Promise(() => undefined)),
      } as unknown as Ai,
      source: {
        title: 'Title', brief: null, tone: 'informative', length: 'short',
        documentType: 'html', editorMode: 'visual',
      },
      timeoutMs: 1,
    })).rejects.toMatchObject({
      name: 'AiPostDraftProviderError',
      reason: 'timeout',
    } satisfies Partial<AiPostDraftProviderError>);
  });
});

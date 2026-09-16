import { describe, expect, it, vi } from 'vitest';
import {
  AI_PAGE_DRAFT_MODEL,
  AI_PAGE_DRAFT_PROMPT_VERSION,
  AiPageDraftProviderError,
  AiPageDraftResponseInvalidError,
  AiPageDraftSourceEmptyError,
  generateAiPageDraft,
  prepareAiPageDraftSource,
} from './page-draft-service';

const output = {
  title: 'About the project',
  excerpt: 'A short introduction for visitors.',
  blocks: [
    { type: 'heading', level: 2, text: 'Purpose' },
    { type: 'paragraph', text: 'This Page uses only supplied facts.' },
  ],
} as const;

describe('AI Page draft service', () => {
  it('normalizes input and requires an explicit brief for policy outlines', () => {
    expect(prepareAiPageDraftSource({
      title: '  About ',
      brief: '  Explain the project. ',
      preset: 'about',
      tone: 'professional',
      length: 'medium',
      document_type: 'html',
      editor_mode: 'visual',
    })).toEqual({
      title: 'About',
      brief: 'Explain the project.',
      preset: 'about',
      tone: 'professional',
      length: 'medium',
      documentType: 'html',
      editorMode: 'visual',
    });
    expect(() => prepareAiPageDraftSource({
      title: 'Privacy policy',
      brief: ' ',
      preset: 'policy_outline',
      tone: 'professional',
      length: 'long',
      document_type: 'plaintext',
      editor_mode: 'source',
    })).toThrow(AiPageDraftSourceEmptyError);
  });

  it('uses fixed model and Page prompt constants with preset-specific boundaries', async () => {
    for (const preset of ['general', 'about', 'landing', 'policy_outline'] as const) {
      const run = vi.fn().mockResolvedValue(output);
      const result = await generateAiPageDraft({
        ai: { run } as unknown as Ai,
        source: prepareAiPageDraftSource({
          title: 'Working Page',
          brief: 'Use these supplied facts.',
          preset,
          tone: 'professional',
          length: 'medium',
          document_type: 'html',
          editor_mode: 'visual',
        }),
      });
      expect(result).toMatchObject({
        document_type: 'html',
        editor_mode: 'visual',
        editor_profile: 'tiptap-v1',
      });
      expect(run.mock.calls[0][0]).toBe(AI_PAGE_DRAFT_MODEL);
      const options = run.mock.calls[0][1] as {
        messages: Array<{ content: string }>;
      };
      const serialized = JSON.stringify(options);
      expect(serialized).toContain(AI_PAGE_DRAFT_PROMPT_VERSION);
      expect(JSON.parse(options.messages[1].content)).toMatchObject({ preset });
      if (preset === 'landing') {
        expect(serialized).toContain('Do not create links, buttons');
      }
      if (preset === 'policy_outline') {
        expect(serialized).toContain('not legal advice');
        expect(serialized).toContain('[TODO: describe the missing fact]');
      }
    }
  });

  it('shares safe serializers and maps invalid/provider output to Page errors', async () => {
    await expect(generateAiPageDraft({
      ai: { run: vi.fn().mockResolvedValue(output) } as unknown as Ai,
      source: {
        title: null,
        brief: 'Draft this Page.',
        preset: 'general',
        tone: 'informative',
        length: 'short',
        documentType: 'markdown',
        editorMode: 'source',
      },
    })).resolves.toMatchObject({
      content: '## Purpose\n\nThis Page uses only supplied facts.',
      document_type: 'markdown',
      editor_mode: 'source',
      editor_profile: null,
    });

    await expect(generateAiPageDraft({
      ai: { run: vi.fn().mockResolvedValue({ title: 'Invalid' }) } as unknown as Ai,
      source: {
        title: 'Title', brief: null, preset: 'general', tone: 'informative',
        length: 'short', documentType: 'plaintext', editorMode: 'source',
      },
    })).rejects.toBeInstanceOf(AiPageDraftResponseInvalidError);

    await expect(generateAiPageDraft({
      ai: { run: vi.fn().mockRejectedValue(new Error('private')) } as unknown as Ai,
      source: {
        title: 'Title', brief: null, preset: 'general', tone: 'informative',
        length: 'short', documentType: 'plaintext', editorMode: 'source',
      },
    })).rejects.toMatchObject({
      name: 'AiPageDraftProviderError',
      reason: 'request_failed',
    } satisfies Partial<AiPageDraftProviderError>);
  });
});

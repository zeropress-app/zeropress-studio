// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from '../i18n';
import { AiImageGenerationDialog } from './AiImageGenerationDialog';

const MEDIA_ID = '1'.repeat(32);
const NOW = '2026-08-21T01:00:00.000Z';
const generatedMedia = {
  id: MEDIA_ID,
  kind: 'image' as const,
  filename: 'ai-generated.png',
  mime_type: 'image/png',
  location: { type: 'r2' as const, key: `uploads/2026/08/${MEDIA_ID}.png` },
  size_bytes: 12_345,
  width: 1024,
  height: 576,
  duration_ms: null,
  alt: 'A quiet library',
  collection: null,
  usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
  revision: '2'.repeat(32),
  created_at_iso: NOW,
  updated_at_iso: NOW,
};

function generatedResponse() {
  return Response.json({
    success: true,
    data: {
      media: generatedMedia,
      generation: {
        version: 1,
        model: '@cf/black-forest-labs/flux-2-klein-4b',
        prompt_version: 'image-v1',
        prompt: 'A quiet library at sunrise',
        aspect_ratio: 'landscape',
        seed: 42,
      },
    },
  });
}

beforeEach(async () => {
  await changeLocale('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AiImageGenerationDialog', () => {
  it('stores the generated result before requiring an explicit picker use action', async () => {
    const fetchMock = vi.fn().mockResolvedValue(generatedResponse());
    vi.stubGlobal('fetch', fetchMock);
    const onGenerated = vi.fn();
    const onUse = vi.fn();
    const user = userEvent.setup();
    render(
      <AiImageGenerationDialog
        csrfToken="csrf-token-with-at-least-thirty-two-characters"
        delivery={{ media_origin: '', r2_preview_available: true }}
        onClose={vi.fn()}
        onGenerated={onGenerated}
        onUse={onUse}
        onSessionEnded={vi.fn()}
      />,
    );

    await user.type(
      screen.getByRole('textbox', { name: 'Image description' }),
      'A quiet library at sunrise',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Alternative text' }),
      'A quiet library',
    );
    await user.type(screen.getByRole('spinbutton', { name: 'Seed (optional)' }), '42');
    await user.click(screen.getByRole('button', { name: 'Generate image' }));

    await waitFor(() => expect(onGenerated).toHaveBeenCalledWith(generatedMedia));
    expect(onUse).not.toHaveBeenCalled();
    expect(screen.getByText('Saved as managed Media')).toBeInTheDocument();
    const request = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(request[0]).toBe('/api/media/ai/images');
    expect(JSON.parse(String(request[1].body))).toEqual({
      prompt: 'A quiet library at sunrise',
      alt: 'A quiet library',
      aspect_ratio: 'landscape',
      seed: 42,
    });

    await user.click(screen.getByRole('button', { name: 'Use this image' }));
    expect(onUse).toHaveBeenCalledWith(
      generatedMedia,
      { media_origin: '', r2_preview_available: true },
    );
  });

  it.each([
    {
      locale: 'en' as const,
      promptLabel: 'Image description',
      generateLabel: 'Generate image',
      message: 'The AI service rejected this image during content screening. Try a different image description.',
    },
    {
      locale: 'ko' as const,
      promptLabel: '이미지 설명',
      generateLabel: '이미지 생성',
      message: 'AI 서비스의 콘텐츠 검사에서 이미지 생성이 거부되었습니다. 이미지 설명을 바꿔 주세요.',
    },
  ])('explains content rejection in $locale and accepts an edited prompt', async ({
    locale, promptLabel, generateLabel, message,
  }) => {
    await changeLocale(locale);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        success: false,
        error: { code: 'AI_IMAGE_CONTENT_REJECTED' },
      }, { status: 422 }))
      .mockResolvedValueOnce(generatedResponse());
    vi.stubGlobal('fetch', fetchMock);
    const onGenerated = vi.fn();
    const user = userEvent.setup();
    render(
      <AiImageGenerationDialog
        csrfToken="csrf-token-with-at-least-thirty-two-characters"
        delivery={{ media_origin: '', r2_preview_available: true }}
        onClose={vi.fn()}
        onGenerated={onGenerated}
        onSessionEnded={vi.fn()}
      />,
    );
    const prompt = screen.getByRole('textbox', { name: promptLabel });
    await user.type(prompt, 'minecraft game');
    await user.click(screen.getByRole('button', { name: generateLabel }));

    expect(await screen.findByText(message)).toBeVisible();
    expect(prompt).toHaveValue('minecraft game');
    expect(screen.getByRole('button', { name: generateLabel })).toBeEnabled();
    expect(onGenerated).not.toHaveBeenCalled();

    await user.clear(prompt);
    await user.type(prompt, 'A quiet library at sunrise');
    await user.click(screen.getByRole('button', { name: generateLabel }));
    await waitFor(() => expect(onGenerated).toHaveBeenCalledExactlyOnceWith(generatedMedia));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1].body)).prompt)
      .toBe('A quiet library at sunrise');
  });
});

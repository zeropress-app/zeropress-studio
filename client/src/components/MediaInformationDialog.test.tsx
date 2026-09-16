// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { changeLocale } from '../i18n';
import { MediaInformationDialog } from './MediaInformationDialog';

const MEDIA_ID = '1'.repeat(32);
const NOW = '2026-08-30T01:00:00.000Z';
const media = {
  id: MEDIA_ID,
  kind: 'image' as const,
  filename: 'ai-generated.png',
  mime_type: 'image/png',
  location: {
    type: 'r2' as const,
    key: `uploads/2026/08/${MEDIA_ID}.png`,
  },
  size_bytes: 12_345,
  width: 1024,
  height: 576,
  duration_ms: null,
  alt: 'Quiet library',
  collection: null,
  usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
  revision: '2'.repeat(32),
  created_at_iso: NOW,
  updated_at_iso: NOW,
};

beforeEach(async () => {
  await changeLocale('en');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MediaInformationDialog', () => {
  it('opens at the filename instead of a control below the preview and metadata', () => {
    render(
      <MemoryRouter>
        <MediaInformationDialog
          media={media}
          delivery={{ media_origin: '', r2_preview_available: true }}
          canManage={false}
          onClose={vi.fn()}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: media.filename })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Copy content reference' }))
      .not.toHaveFocus();
  });

  it('shows private AI generation details through the aggregate information API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        media_id: MEDIA_ID,
        generation: {
          version: 1,
          model: '@cf/black-forest-labs/flux-2-klein-4b',
          prompt_version: 'image-v1',
          prompt: 'A quiet library at sunrise',
          aspect_ratio: 'landscape',
          seed: 42,
        },
        references: {
          items: [],
          pagination: { page: 1, per_page: 20, total: 0, total_pages: 0 },
        },
      },
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <MediaInformationDialog
          media={media}
          delivery={{ media_origin: '', r2_preview_available: true }}
          canManage
          onClose={vi.fn()}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('AI generation details')).toBeInTheDocument();
    expect(screen.getByText('@cf/black-forest-labs/flux-2-klein-4b'))
      .toBeInTheDocument();
    expect(screen.getByText('image-v1')).toBeInTheDocument();
    expect(screen.getByText('Landscape · 16:9')).toBeInTheDocument();
    expect(screen.getByText('A quiet library at sunrise')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `/api/media/${MEDIA_ID}/information?page=1&per_page=20`,
    );
  });
});

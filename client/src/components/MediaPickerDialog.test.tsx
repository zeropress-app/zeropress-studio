// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { changeLocale } from '../i18n';
import { MediaPickerDialog } from './MediaPickerDialog';

const COLLECTION_ID = '1'.repeat(32);
const MEDIA_ID = '2'.repeat(32);
const NOW = '2026-08-09T01:00:00.000Z';

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('MediaPickerDialog', () => {
  it('shares collection, server-search, purpose, and pagination semantics', async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn((request: RequestInfo | URL) => {
      const path = String(request);
      requests.push(path);
      if (path === '/api/media/collections') {
        return Promise.resolve(json({
          success: true,
          data: {
            items: [{
              id: COLLECTION_ID,
              name: 'Photography',
              media_count: 1,
              revision: '3'.repeat(32),
              created_at_iso: NOW,
              updated_at_iso: NOW,
            }],
            total_media_count: 1,
            unfiled_media_count: 0,
          },
        }));
      }
      const parsed = new URL(path, 'https://studio.local');
      const page = Number(parsed.searchParams.get('page'));
      return Promise.resolve(json({
        success: true,
        data: {
          items: [{
            id: MEDIA_ID,
            kind: 'image',
            filename: page === 2 ? 'second.jpg' : 'hero.jpg',
            mime_type: 'image/jpeg',
            location: {
              type: 'external',
              url: `https://media.example/${page === 2 ? 'second' : 'hero'}.jpg`,
            },
            size_bytes: null,
            width: 1600,
            height: 900,
            duration_ms: null,
            alt: 'Hero',
            collection: { id: COLLECTION_ID, name: 'Photography' },
            usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
            revision: '4'.repeat(32),
            created_at_iso: NOW,
            updated_at_iso: NOW,
          }],
          pagination: {
            page,
            per_page: 50,
            total: 51,
            total_pages: 2,
          },
          delivery: {
            media_origin: '',
            r2_preview_available: true,
          },
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MediaPickerDialog
          purpose="branding_logo"
          selectedId={null}
          copy={{
            kicker: 'BRANDING',
            title: 'Choose a logo',
            description: 'Choose an image.',
            select: 'Choose',
            selectNamed: (filename) => `Choose ${filename}`,
            emptyTitle: 'No images',
            emptyDescription: 'Change the filters.',
          }}
          onClose={vi.fn()}
          onSelect={onSelect}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText('hero.jpg')).toBeInTheDocument();
    expect(requests).toContain(
      '/api/media?search=&kind=all&purpose=branding_logo&collection=all&page=1&per_page=50',
    );

    await user.selectOptions(screen.getByRole('combobox', {
      name: 'Collection',
    }), COLLECTION_ID);
    await waitFor(() => expect(requests).toContain(
      `/api/media?search=&kind=all&purpose=branding_logo&collection=${COLLECTION_ID}&page=1&per_page=50`,
    ));

    await user.type(screen.getByRole('searchbox', { name: 'Search Media' }), ' hero ');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(requests).toContain(
      `/api/media?search=hero&kind=all&purpose=branding_logo&collection=${COLLECTION_ID}&page=1&per_page=50`,
    ));

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('second.jpg')).toBeInTheDocument();
    expect(requests).toContain(
      `/api/media?search=hero&kind=all&purpose=branding_logo&collection=${COLLECTION_ID}&page=2&per_page=50`,
    );
    await user.click(screen.getByRole('button', { name: 'Choose second.jpg' }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'second.jpg' }),
      { media_origin: '', r2_preview_available: true },
    );
  });
});

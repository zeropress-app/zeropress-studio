// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import {
  BRANDING_SETTINGS_INITIAL_REVISION,
  materializeSiteBrandingSettingsDefaults,
  type BrandingMediaAsset,
} from '../../contracts/branding-settings';
import type { Media } from '../../contracts/media';
import { SiteBrandingPage } from './SiteBrandingPage';
import { changeLocale } from './i18n';

const PNG_ID = '1'.repeat(32);
const LOGO_ID = '2'.repeat(32);
const png: BrandingMediaAsset = {
  id: PNG_ID,
  filename: 'favicon.png',
  mime_type: 'image/png',
  location: { type: 'external', url: 'https://assets.example/favicon.png' },
  format: 'png',
  preview_url: 'https://assets.example/favicon.png',
};
const logo: BrandingMediaAsset = {
  id: LOGO_ID,
  filename: 'logo.webp',
  mime_type: 'image/webp',
  location: { type: 'external', url: 'https://assets.example/logo.webp' },
  format: 'other_image',
  preview_url: 'https://assets.example/logo.webp',
};
const initialDocument = {
  settings: materializeSiteBrandingSettingsDefaults(),
  selected_assets: {
    icon: null,
    icon_dark: null,
    apple_touch_icon: null,
    logo: null,
  },
  revision: BRANDING_SETTINGS_INITIAL_REVISION,
  updated_at_iso: null,
};

function pickerMedia(asset: BrandingMediaAsset): Media {
  return {
    id: asset.id,
    kind: 'image',
    filename: asset.filename,
    mime_type: asset.mime_type,
    location: asset.location,
    size_bytes: null,
    width: null,
    height: null,
    duration_ms: null,
    alt: '',
    collection: null,
    usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
    revision: 'a'.repeat(32),
    created_at_iso: '2026-08-03T10:00:00.000Z',
    updated_at_iso: '2026-08-03T10:00:00.000Z',
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('SiteBrandingPage', () => {
  it('selects favicon and logo Media and saves one revision-bound document', async () => {
    const fetchMock = vi.fn().mockImplementation(async (
      path: string,
      init?: RequestInit,
    ) => {
      if (path === '/api/settings/branding' && init?.method === 'PUT') {
        return new Response(JSON.stringify({
          success: true,
          data: {
            settings: {
              favicon: {
                icon_media_id: PNG_ID,
                icon_dark_media_id: null,
                apple_touch_icon_media_id: null,
              },
              logo: { media_id: LOGO_ID, alt: 'Example Site' },
            },
            selected_assets: {
              icon: png,
              icon_dark: null,
              apple_touch_icon: null,
              logo,
            },
            revision: '3'.repeat(32),
            updated_at_iso: '2026-08-03T12:00:00.000Z',
          },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (path === '/api/media/collections') {
        return new Response(JSON.stringify({
          success: true,
          data: {
            items: [],
            total_media_count: 2,
            unfiled_media_count: 2,
          },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (path.startsWith('/api/media?')) {
        const purpose = new URL(path, 'https://studio.local')
          .searchParams.get('purpose');
        const items = purpose === 'branding_favicon'
          ? [pickerMedia(png)]
          : [pickerMedia(png), pickerMedia(logo)];
        return new Response(JSON.stringify({
          success: true,
          data: {
            items,
            pagination: {
              page: 1,
              per_page: 50,
              total: items.length,
              total_pages: 1,
            },
            delivery: { media_origin: '', r2_preview_available: true },
          },
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        success: true,
        data: initialDocument,
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/settings/site/branding']}>
        <SiteBrandingPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Site Branding' }))
      .toBeInTheDocument();
    expect(screen.getByText('Using default icons')).toBeInTheDocument();
    expect(screen.queryByText(/need a Media origin/iu)).not.toBeInTheDocument();
    expect(screen.getByRole('link', {
      name: 'Add images in Media',
    })).toHaveAttribute('href', '/media');

    await user.click(screen.getAllByRole('button', { name: 'Choose Media' })[0]);
    await user.click(await screen.findByRole('button', {
      name: 'Choose favicon.png',
    }));
    await user.click(screen.getAllByRole('button', { name: 'Choose Media' })[2]);
    await user.click(await screen.findByRole('button', {
      name: 'Choose logo.webp',
    }));
    await user.type(
      screen.getByLabelText('Alternative text (optional)'),
      'Example Site',
    );
    await user.click(screen.getByRole('button', { name: 'Save branding' }));

    await screen.findByText('Site Branding saved.');
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put?.[0]).toBe('/api/settings/branding');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      settings: {
        favicon: {
          icon_media_id: PNG_ID,
          icon_dark_media_id: null,
          apple_touch_icon_media_id: null,
        },
        logo: { media_id: LOGO_ID, alt: 'Example Site' },
      },
      expected_revision: BRANDING_SETTINGS_INITIAL_REVISION,
    });
    await waitFor(() => expect(screen.getByText('All changes are saved.'))
      .toBeInTheDocument());
  });
});

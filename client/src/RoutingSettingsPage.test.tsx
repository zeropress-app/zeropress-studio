// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import {
  materializeRoutingSettingsDefaults,
  ROUTING_SETTINGS_INITIAL_REVISION,
} from '../../contracts/routing-settings';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { changeLocale } from './i18n';
import { RoutingSettingsPage } from './RoutingSettingsPage';

const PAGE_ID = '1'.repeat(32);
const session: CurrentSessionSuccess['data'] = {
  user: {
    id: '2'.repeat(32),
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: {
    id: '3'.repeat(32),
    created_at_iso: '2026-08-01T00:00:00.000Z',
    last_seen_at_iso: '2026-08-01T00:05:00.000Z',
    idle_expires_at_iso: '2026-08-01T12:05:00.000Z',
    absolute_expires_at_iso: '2026-08-08T00:00:00.000Z',
    network: {
      ip_address: '203.0.113.10',
      asn: null,
      as_organization: null,
      country_code: null,
    },
  },
  csrf_token: 'c'.repeat(43),
  edge_integration: { mode: 'enabled', database_state: 'ready' },
};

const initialDocument = {
  settings: materializeRoutingSettingsDefaults(),
  revision: ROUTING_SETTINGS_INITIAL_REVISION,
  updated_at_iso: null,
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function optionsResponse() {
  return response({
    success: true,
    data: {
      items: [{ id: PAGE_ID, title: 'Home', path: 'home' }],
    },
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/site/routing']}>
      <Routes>
        <Route
          path="/settings/site/routing"
          element={(
            <RoutingSettingsPage
              data={session}
              onSessionEnded={vi.fn()}
            />
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('RoutingSettingsPage', () => {
  it('loads Build Core defaults and saves a canonical Page Front Page document', async () => {
    const savedSettings = {
      ...initialDocument.settings,
      permalinks: {
        ...initialDocument.settings.permalinks,
        posts: '/journal/:slug/',
      },
      front_page: { type: 'page' as const, page_id: PAGE_ID },
      post_index: { enabled: true, path: '/blog/', paginate: true },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: initialDocument }))
      .mockResolvedValueOnce(optionsResponse())
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          settings: savedSettings,
          revision: '4'.repeat(32),
          updated_at_iso: '2026-08-01T06:00:00.000Z',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('combobox', { name: 'Output style' }))
      .toHaveValue('directory');
    expect(screen.getByRole('textbox', { name: 'Post pattern' }))
      .toHaveValue('/posts/:slug/');
    expect(screen.getByRole('radio', { name: /Theme index/ }))
      .toBeChecked();
    expect(screen.getByRole('switch', { name: 'Generate Post index' }))
      .toBeChecked();

    const postPattern = screen.getByRole('textbox', { name: 'Post pattern' });
    await user.clear(postPattern);
    await user.type(postPattern, '/journal/:slug');
    await user.click(screen.getByRole('radio', { name: /Published Page/ }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Front Page selection' }),
      PAGE_ID,
    );
    const postIndexPath = screen.getByRole('textbox', {
      name: 'Post index path',
    });
    await user.clear(postIndexPath);
    await user.type(postIndexPath, '/blog');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('URL and Homepage settings saved.'))
      .toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const request = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(request.method).toBe('PUT');
    expect(request.headers).toMatchObject({
      'X-ZeroPress-CSRF': session.csrf_token,
    });
    expect(JSON.parse(String(request.body))).toEqual({
      settings: savedSettings,
      expected_revision: initialDocument.revision,
    });
  });

  it('blocks the Front Page and root Post index collision locally', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: initialDocument }))
      .mockResolvedValueOnce(optionsResponse()));
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('combobox', { name: 'Output style' });
    await user.click(screen.getByRole('radio', { name: /Published Page/ }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Front Page selection' }),
      PAGE_ID,
    );
    expect(screen.getByRole('textbox', { name: 'Post index path' }))
      .toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/cannot both use/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeDisabled();
  });

  it('preserves a trusted standalone Front Page document when saving', async () => {
    const html = '<!doctype html>\n<html><body>Standalone</body></html>\n';
    const savedSettings = {
      ...initialDocument.settings,
      front_page: { type: 'standalone_html' as const, html },
      post_index: { enabled: true, path: '/blog/', paginate: true },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: initialDocument }))
      .mockResolvedValueOnce(optionsResponse())
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          settings: savedSettings,
          revision: '6'.repeat(32),
          updated_at_iso: '2026-08-01T06:00:00.000Z',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('combobox', { name: 'Output style' });
    await user.click(screen.getByRole('radio', { name: /Standalone HTML/ }));
    const standalone = screen.getByRole('textbox', {
      name: 'Trusted full HTML document',
    });
    await user.type(standalone, html);
    await user.click(screen.getByRole('radio', { name: /Theme index/ }));
    await user.click(screen.getByRole('radio', { name: /Standalone HTML/ }));
    expect(screen.getByRole('textbox', {
      name: 'Trusted full HTML document',
    })).toHaveValue(html);
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeDisabled();
    const postIndexPath = screen.getByRole('textbox', {
      name: 'Post index path',
    });
    await user.clear(postIndexPath);
    await user.type(postIndexPath, '/blog');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('URL and Homepage settings saved.'))
      .toBeInTheDocument();
    expect(JSON.parse(String(
      (fetchMock.mock.calls[2]?.[1] as RequestInit).body,
    ))).toEqual({
      settings: savedSettings,
      expected_revision: initialDocument.revision,
    });
  });

  it('sends boundary-slash-only edits so the Worker can return canonical settings', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: initialDocument }))
      .mockResolvedValueOnce(optionsResponse())
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          ...initialDocument,
          revision: '5'.repeat(32),
          updated_at_iso: '2026-08-01T06:00:00.000Z',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();
    const postPattern = await screen.findByRole('textbox', {
      name: 'Post pattern',
    });
    await user.clear(postPattern);
    await user.type(postPattern, '/posts/:slug');
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(JSON.parse(String(
      (fetchMock.mock.calls[2]?.[1] as RequestInit).body,
    )).settings.permalinks.posts).toBe('/posts/:slug/');
    expect(await screen.findByText('URL and Homepage settings saved.'))
      .toBeInTheDocument();
    expect(postPattern).toHaveValue('/posts/:slug/');
  });

  it('keeps the settings form usable when the optional Page picker request fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: initialDocument }))
      .mockRejectedValueOnce(new TypeError('network unavailable')));
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('combobox', { name: 'Output style' }))
      .toHaveValue('directory');
    await user.click(screen.getByRole('radio', { name: /Published Page/ }));
    expect(await screen.findByText(/Published Pages could not be loaded/))
      .toBeInTheDocument();
    expect(screen.queryByText('URL settings could not be loaded'))
      .not.toBeInTheDocument();
  });

  it('reviews missing route defaults before repairing the complete document', async () => {
    const recovery = {
      expected_revision: '6'.repeat(32),
      missing_fields: ['permalinks'],
      proposed_settings: initialDocument.settings,
    };
    const repairedDocument = {
      settings: recovery.proposed_settings,
      revision: '7'.repeat(32),
      updated_at_iso: '2026-08-01T06:10:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: false,
        error: { code: 'SITE_ROUTING_SETTINGS_INCOMPLETE', recovery },
      }, 409))
      .mockResolvedValueOnce(response({
        success: true,
        data: repairedDocument,
      }))
      .mockResolvedValueOnce(optionsResponse());
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', {
      name: 'Review recovery',
    }));
    const dialog = screen.getByRole('dialog', {
      name: 'Fill missing URL and Homepage settings?',
    });
    expect(within(dialog).getByText('Permalinks')).toBeInTheDocument();
    expect(within(dialog).getByText(/URLs and the homepage in the next site build/u)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', {
      name: 'Fill missing settings',
    }));

    expect(await screen.findByText('URL and Homepage settings saved.'))
      .toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Post pattern' }))
      .toHaveValue('/posts/:slug/');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/settings/routing/repair');
    expect(JSON.parse(String(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body,
    ))).toEqual({
      expected_revision: recovery.expected_revision,
      missing_fields: recovery.missing_fields,
    });
  });

  it('keeps the selected Page while searching a bounded option list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: initialDocument }))
      .mockResolvedValueOnce(optionsResponse())
      .mockResolvedValueOnce(optionsResponse());
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('combobox', { name: 'Output style' });
    await user.click(screen.getByRole('radio', { name: /Published Page/ }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Front Page selection' }),
      PAGE_ID,
    );
    await user.type(
      screen.getByRole('searchbox', { name: 'Find a published Page' }),
      'docs{Enter}',
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/settings/routing/page-options?search=docs&selected_page_id=${PAGE_ID}`,
    );
    expect(screen.getByRole('combobox', { name: 'Front Page selection' }))
      .toHaveValue(PAGE_ID);
  });
});

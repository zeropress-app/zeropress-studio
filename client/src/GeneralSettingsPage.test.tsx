// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { GeneralSettingsPage } from './GeneralSettingsPage';
import { changeLocale } from './i18n';

const session: CurrentSessionSuccess['data'] = {
  user: {
    id: '1'.repeat(32),
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: {
    id: '2'.repeat(32),
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
  settings: {
    title: 'ZeroPress',
    description: '',
    url: '',
    locale: 'en-US',
    timezone: 'UTC',
  },
  revision: '0'.repeat(32),
  updated_at_iso: null,
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderPage(
  extra?: ReactNode,
  onSiteIdentityChanged?: (identity: { title: string; url: string }) => void,
) {
  return render(
    <MemoryRouter initialEntries={['/settings/site/general']}>
      {extra}
      <Routes>
        <Route
          path="/settings/site/general"
          element={(
            <GeneralSettingsPage
              data={session}
              onSiteIdentityChanged={onSiteIdentityChanged}
              onSessionEnded={vi.fn()}
            />
          )}
        />
        <Route path="/elsewhere" element={<main>Elsewhere</main>} />
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

describe('GeneralSettingsPage', () => {
  it('loads materialized settings and saves a complete revision-bound document', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: initialDocument,
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          settings: {
            ...initialDocument.settings,
            title: 'Example Site',
            url: 'https://example.com',
          },
          revision: '3'.repeat(32),
          updated_at_iso: '2026-08-01T03:00:00.000Z',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    const onSiteIdentityChanged = vi.fn();
    renderPage(undefined, onSiteIdentityChanged);

    const title = await screen.findByRole('textbox', { name: 'Site title' });
    expect(screen.getByRole('navigation', { name: 'Site settings' }))
      .toBeInTheDocument();
    expect(screen.getByRole('link', {
      name: 'Maintenance & Recovery (opens in a new window)',
    })).toHaveAttribute('href', '/system/operations');
    expect(screen.getByRole('link', {
      name: 'Maintenance & Recovery (opens in a new window)',
    })).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('link', { name: 'WordPress import' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Edge services' }))
      .not.toBeInTheDocument();
    expect(title).toHaveValue('ZeroPress');
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeDisabled();
    await user.clear(title);
    await user.type(title, '  Example Site  ');
    await user.type(screen.getByRole('textbox', {
      name: 'Site URL',
    }), 'https://EXAMPLE.com/');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await screen.findByText('General settings saved.');
    expect(title).toHaveValue('Example Site');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(request.method).toBe('PUT');
    expect(request.headers).toMatchObject({
      'X-ZeroPress-CSRF': session.csrf_token,
    });
    expect(JSON.parse(String(request.body))).toEqual({
      settings: {
        ...initialDocument.settings,
        title: '  Example Site  ',
        url: 'https://EXAMPLE.com/',
      },
      expected_revision: initialDocument.revision,
    });
    expect(onSiteIdentityChanged).toHaveBeenCalledWith({
      title: 'Example Site',
      url: 'https://example.com',
    });
  });

  it('keeps local edits visible after a stale revision and reloads explicitly', async () => {
    const latestDocument = {
      ...initialDocument,
      settings: { ...initialDocument.settings, title: 'Other session' },
      revision: '4'.repeat(32),
      updated_at_iso: '2026-08-01T04:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: initialDocument }))
      .mockResolvedValueOnce(response({
        success: false,
        error: { code: 'SETTINGS_REVISION_CONFLICT' },
      }, 409))
      .mockResolvedValueOnce(response({ success: true, data: latestDocument }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    const title = await screen.findByRole('textbox', { name: 'Site title' });
    await user.clear(title);
    await user.type(title, 'My local edit');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    const conflict = await screen.findByRole('alert');
    expect(conflict).toHaveTextContent(
      'General Settings changed in another session',
    );
    expect(title).toHaveValue('My local edit');
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeDisabled();

    await user.click(within(conflict).getByRole('button', {
      name: 'Load latest values',
    }));
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Site title' })).toHaveValue('Other session');
    });
  });

  it('validates Preview Data-compatible URL, locale, and timezone values locally', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    })));
    const user = userEvent.setup();
    renderPage();

    const url = await screen.findByRole('textbox', {
      name: 'Site URL',
    });
    await user.type(url, 'https://example.com/path');
    expect(url).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/valid HTTP\(S\) origin/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeDisabled();
  });

  it('names the stored locale and timezone so machine codes are readable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    })));
    renderPage();

    expect(await screen.findByText('Stored as en-US · American English'))
      .toBeInTheDocument();
    expect(screen.getByText(/^Stored as UTC · GMT · now /u))
      .toBeInTheDocument();
  });

  it('reports the value a normalizing input will actually store', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    })));
    const user = userEvent.setup();
    renderPage();

    const timezone = await screen.findByRole('combobox', {
      name: 'Site timezone',
    });
    await user.clear(timezone);
    await user.type(timezone, 'asia/seoul');

    expect(timezone).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText(
      /^Normalized on save to Asia\/Seoul · GMT\+09:00 · now /u,
    )).toBeInTheDocument();
  });

  it('trims pasted whitespace instead of rejecting the value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    })));
    const user = userEvent.setup();
    renderPage();

    const locale = await screen.findByRole('combobox', {
      name: 'Site language',
    });
    await user.clear(locale);
    await user.paste(' ko-KR ');

    expect(locale).toHaveValue('ko-KR');
    expect(locale).not.toHaveAttribute('aria-invalid');
  });

  it('warns that a fixed offset ignores daylight saving time', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    })));
    const user = userEvent.setup();
    renderPage();

    const timezone = await screen.findByRole('combobox', {
      name: 'Site timezone',
    });
    // UTC initially needs no warning. Check the warning text specifically
    // to distinguish it from the field's permanent description.
    expect(screen.queryByText(/A fixed offset ignores/u))
      .not.toBeInTheDocument();

    await user.clear(timezone);
    await user.type(timezone, '+09:00');

    // The contract permits this value, so saving must remain available.
    expect(timezone).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText(/A fixed offset ignores/u)).toBeInTheDocument();

    // The warning disappears after switching to an IANA name.
    await user.clear(timezone);
    await user.type(timezone, 'Asia/Seoul');
    expect(screen.queryByText(/A fixed offset ignores/u))
      .not.toBeInTheDocument();
  });

  it('flags a locale that matches no known language without blocking the save', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    })));
    const user = userEvent.setup();
    renderPage();

    const locale = await screen.findByRole('combobox', {
      name: 'Site language',
    });
    await user.clear(locale);
    await user.type(locale, 'zz');

    expect(locale).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText(/does not match a known language or region/u))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeEnabled();
  });

  it('fills both localization fields from the browser in one action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    })));
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    const user = userEvent.setup();
    renderPage();

    const action = await screen.findByRole('button', {
      name: 'Use browser settings',
    });
    expect(action).toHaveAccessibleDescription(expect.stringContaining(resolved.timeZone));
    await user.click(action);

    expect(screen.getByRole('combobox', { name: 'Site timezone' }))
      .toHaveValue(resolved.timeZone);
    // Do not offer the same action again after it has been applied.
    expect(action).toBeDisabled();
  });

  it('asks before following an internal link with unsaved changes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    })));
    const user = userEvent.setup();
    renderPage(<Link to="/elsewhere">Go elsewhere</Link>);

    const title = await screen.findByRole('textbox', { name: 'Site title' });
    await user.type(title, ' changed');
    await user.click(screen.getByRole('link', { name: 'Go elsewhere' }));

    const dialog = screen.getByRole('dialog', {
      name: 'Leave without saving?',
    });
    expect(within(dialog).getByRole('button', { name: 'Keep editing' }))
      .toHaveFocus();
    await user.click(within(dialog).getByRole('button', {
      name: 'Discard and leave',
    }));
    expect(await screen.findByText('Elsewhere')).toBeInTheDocument();
  });

  it('shows and explicitly applies a bounded missing-field recovery plan', async () => {
    const recovery = {
      expected_revision: '6'.repeat(32),
      missing_fields: ['description'],
      proposed_settings: {
        ...initialDocument.settings,
        title: 'Preserved title',
      },
    };
    const repairedDocument = {
      settings: recovery.proposed_settings,
      revision: '7'.repeat(32),
      updated_at_iso: '2026-08-01T05:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: false,
        error: { code: 'SITE_SETTINGS_INCOMPLETE', recovery },
      }, 409))
      .mockResolvedValueOnce(response({
        success: true,
        data: repairedDocument,
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', {
      name: 'Review recovery',
    }));
    const dialog = screen.getByRole('dialog', {
      name: 'Fill missing General Settings?',
    });
    expect(within(dialog).getByText('Site description')).toBeInTheDocument();
    expect(within(dialog).getByText('(empty)')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', {
      name: 'Fill missing settings',
    }));

    expect(await screen.findByText('General settings saved.'))
      .toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Site title' }))
      .toHaveValue('Preserved title');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/settings/general/repair');
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(JSON.parse(String(request.body))).toEqual({
      expected_revision: recovery.expected_revision,
      missing_fields: recovery.missing_fields,
    });
  });
});

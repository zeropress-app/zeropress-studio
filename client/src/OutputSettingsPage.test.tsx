// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import {
  materializeOutputSettingsDefaults,
  OUTPUT_SETTINGS_INITIAL_REVISION,
} from '../../contracts/output-settings';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { changeLocale } from './i18n';
import { OutputSettingsPage } from './OutputSettingsPage';

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
  settings: materializeOutputSettingsDefaults(),
  revision: OUTPUT_SETTINGS_INITIAL_REVISION,
  updated_at_iso: null,
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/settings/site/output']}>
      <Routes>
        <Route
          path="/settings/site/output"
          element={(
            <OutputSettingsPage
              data={session}
              onSessionEnded={vi.fn()}
            />
          )}
        />
        <Route
          path="/settings/site/general"
          element={<main>General settings destination</main>}
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

describe('OutputSettingsPage', () => {
  it('renders safe defaults and saves one complete revision-bound document', async () => {
    const savedSettings = {
      ...initialDocument.settings,
      expose_generator: false,
      search: { enabled: false },
      posts_per_page: 30,
      date_style: 'full' as const,
      footer: {
        copyright_text: '© 2026 Example',
        attribution: false,
      },
      robots: { allow_indexing: true },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: initialDocument,
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          settings: savedSettings,
          revision: '3'.repeat(32),
          updated_at_iso: '2026-08-01T06:00:00.000Z',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    const postsPerPage = await screen.findByRole('spinbutton', {
      name: 'Posts per page',
    });
    expect(postsPerPage).toHaveValue(10);
    expect(screen.getByRole('combobox', { name: 'Date style' }))
      .toHaveValue('medium');
    expect(screen.getByRole('combobox', { name: 'Time style' }))
      .toHaveValue('none');
    expect(screen.getByRole('switch', { name: 'Enable static search' }))
      .toBeChecked();
    expect(screen.getByRole('switch', { name: 'Generate RSS feed' }))
      .toBeChecked();
    expect(screen.getByRole('switch', {
      name: 'Generate chronological archive',
    })).toBeChecked();
    expect(screen.getByRole('textbox', {
      name: 'Copyright or legal text (optional)',
    })).toHaveValue('');
    expect(screen.getByRole('switch', {
      name: 'Allow ZeroPress attribution',
    })).toBeChecked();
    expect(screen.getByRole('switch', {
      name: 'Allow search-engine indexing',
    })).not.toBeChecked();

    await user.clear(postsPerPage);
    await user.type(postsPerPage, '30');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Date style' }),
      'full',
    );
    await user.click(screen.getByRole('switch', {
      name: 'Enable static search',
    }));
    await user.click(screen.getByRole('switch', {
      name: 'Allow search-engine indexing',
    }));
    await user.click(screen.getByRole('switch', {
      name: 'Expose ZeroPress generator metadata',
    }));
    await user.type(screen.getByRole('textbox', {
      name: 'Copyright or legal text (optional)',
    }), '  © 2026 Example  ');
    await user.click(screen.getByRole('switch', {
      name: 'Allow ZeroPress attribution',
    }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    await screen.findByText('Display and output settings saved.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(request.method).toBe('PUT');
    expect(request.headers).toMatchObject({
      'X-ZeroPress-CSRF': session.csrf_token,
    });
    expect(JSON.parse(String(request.body))).toEqual({
      settings: savedSettings,
      expected_revision: initialDocument.revision,
    });
  });

  it('keeps edits visible after a conflict and reloads only on request', async () => {
    const latestDocument = {
      ...initialDocument,
      settings: {
        ...initialDocument.settings,
        archive: { enabled: false },
      },
      revision: '4'.repeat(32),
      updated_at_iso: '2026-08-01T06:10:00.000Z',
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

    const feed = await screen.findByRole('switch', {
      name: 'Generate RSS feed',
    });
    await user.click(feed);
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    const conflict = await screen.findByRole('alert');
    expect(conflict).toHaveTextContent(
      'Output settings changed in another session',
    );
    expect(feed).not.toBeChecked();
    await user.click(within(conflict).getByRole('button', {
      name: 'Load latest values',
    }));
    await waitFor(() => {
      expect(screen.getByRole('switch', {
        name: 'Generate chronological archive',
      })).not.toBeChecked();
    });
    expect(screen.getByRole('switch', { name: 'Generate RSS feed' }))
      .toBeChecked();
  });

  it('rejects a non-positive or fractional posts-per-page value locally', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    })));
    const user = userEvent.setup();
    renderPage();

    const postsPerPage = await screen.findByRole('spinbutton', {
      name: 'Posts per page',
    });
    await user.clear(postsPerPage);
    await user.type(postsPerPage, '0');
    expect(postsPerPage).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter a whole number of at least 1.'))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeDisabled();

    await user.clear(postsPerPage);
    await user.type(postsPerPage, '1.5');
    expect(screen.getByRole('button', { name: 'Save settings' }))
      .toBeDisabled();
  });

  it('previews the selected date and time styles from the current runtime', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    })));
    const user = userEvent.setup();
    renderPage();

    const dateStyle = await screen.findByRole('combobox', {
      name: 'Date style',
    });
    const timeStyle = screen.getByRole('combobox', { name: 'Time style' });
    const sampleOf = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(undefined, options).format(new Date());
    const shownSample = () => document
      .querySelector('.settings-datetime-sample')?.textContent ?? null;

    // The default is a medium date with no time.
    expect(shownSample()).toBe(sampleOf({ dateStyle: 'medium' }));
    expect(screen.getByText(/Previewed in this browser’s language and timezone/u))
      .toBeInTheDocument();

    // Changing the format updates the preview.
    await user.selectOptions(dateStyle, 'full');
    await user.selectOptions(timeStyle, 'short');
    expect(shownSample())
      .toBe(sampleOf({ dateStyle: 'full', timeStyle: 'short' }));

    // When both parts are hidden, explain that instead of showing an example.
    await user.selectOptions(dateStyle, 'none');
    await user.selectOptions(timeStyle, 'none');
    expect(shownSample()).toBeNull();
    expect(screen.getByText(/No date or time style is selected/u))
      .toBeInTheDocument();
  });

  it('warns before leaving through the settings sub-navigation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    })));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('switch', {
      name: 'Generate RSS feed',
    }));
    await user.click(screen.getByRole('link', { name: 'General' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Leave without saving?',
    });
    expect(within(dialog).getByRole('button', { name: 'Keep editing' }))
      .toHaveFocus();
    await user.click(within(dialog).getByRole('button', {
      name: 'Discard and leave',
    }));
    expect(await screen.findByText('General settings destination'))
      .toBeInTheDocument();
  });
});

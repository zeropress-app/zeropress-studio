// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { changeLocale } from './i18n';
import { StudioInterfaceSettingsPage } from './StudioInterfaceSettingsPage';
import { StudioInterfaceSettingsProvider } from './StudioInterfaceSettingsContext';

const session: CurrentSessionSuccess['data'] = {
  user: {
    id: '1'.repeat(32),
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: {
    id: '2'.repeat(32),
    created_at_iso: '2026-08-10T00:00:00.000Z',
    last_seen_at_iso: '2026-08-10T00:05:00.000Z',
    idle_expires_at_iso: '2026-08-10T12:05:00.000Z',
    absolute_expires_at_iso: '2026-08-17T00:00:00.000Z',
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
    default_locale: 'en' as const,
    enabled_locales: ['en', 'ko'] as ('en' | 'ko')[],
  },
  revision: '1'.repeat(32),
  updated_at_iso: '2026-08-10T00:00:00.000Z',
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderPage() {
  return render(
    <StudioInterfaceSettingsProvider>
      <MemoryRouter>
        <StudioInterfaceSettingsPage
          data={session}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>
    </StudioInterfaceSettingsProvider>,
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

describe('StudioInterfaceSettingsPage', () => {
  it('stores one enabled locale and applies the organization policy immediately', async () => {
    const savedDocument = {
      settings: {
        default_locale: 'en' as const,
        enabled_locales: ['en'] as ('en' | 'ko')[],
      },
      revision: '2'.repeat(32),
      updated_at_iso: '2026-08-10T03:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: initialDocument,
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: savedDocument,
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    const english = await screen.findByRole('checkbox', {
      name: /English/u,
    });
    const korean = screen.getByRole('checkbox', { name: /한국어/u });
    expect(english).toBeChecked();
    expect(english).toBeDisabled();
    expect(korean).toBeChecked();

    await user.click(korean);
    await user.click(screen.getByRole('button', {
      name: 'Save interface settings',
    }));

    expect(await screen.findByText('Studio interface settings were saved.'))
      .toBeInTheDocument();
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/settings/interface');
    expect(request).toMatchObject({
      method: 'PUT',
      headers: expect.objectContaining({
        'X-ZeroPress-CSRF': session.csrf_token,
      }),
    });
    expect(JSON.parse(String(request.body))).toEqual({
      settings: savedDocument.settings,
      expected_revision: initialDocument.revision,
    });
  });

  it('automatically keeps a newly selected default locale enabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: {
        ...initialDocument,
        settings: {
          default_locale: 'en',
          enabled_locales: ['en'],
        },
      },
    })));
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(await screen.findByRole('combobox', {
      name: 'Default language',
    }), 'ko');

    expect(screen.getByRole('checkbox', { name: /English/u })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /한국어/u })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /한국어/u })).toBeDisabled();
  });
});

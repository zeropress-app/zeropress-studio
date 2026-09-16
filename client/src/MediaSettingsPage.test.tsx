// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import {
  materializeMediaSettingsDefaults,
  MEDIA_SETTINGS_INITIAL_REVISION,
} from '../../contracts/media-settings';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { changeLocale } from './i18n';
import { MediaSettingsPage } from './MediaSettingsPage';

const session: CurrentSessionSuccess['data'] = {
  user: {
    id: '1'.repeat(32),
    email: 'owner@example.com',
    name: 'Owner',
    roles: ['admin'],
  },
  session: {
    id: '2'.repeat(32),
    created_at_iso: '2026-08-02T00:00:00.000Z',
    last_seen_at_iso: '2026-08-02T00:05:00.000Z',
    idle_expires_at_iso: '2026-08-02T12:05:00.000Z',
    absolute_expires_at_iso: '2026-08-09T00:00:00.000Z',
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
  settings: materializeMediaSettingsDefaults(),
  revision: MEDIA_SETTINGS_INITIAL_REVISION,
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
    <MemoryRouter>
      <MediaSettingsPage data={session} onSessionEnded={vi.fn()} />
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

describe('MediaSettingsPage', () => {
  it('stores a canonical media origin and delivery capability', async () => {
    const savedDocument = {
      settings: {
        media_origin: 'https://media.example',
        media_delivery_mode: 'media_domain' as const,
      },
      revision: '3'.repeat(32),
      updated_at_iso: '2026-08-02T06:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: initialDocument }))
      .mockResolvedValueOnce(response({ success: true, data: savedDocument }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    const origin = await screen.findByRole('textbox', { name: 'Media address' });
    await user.type(origin, 'https://MEDIA.example:443/');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Delivery mode' }),
      'media_domain',
    );
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    expect(await screen.findByText('Media Settings saved.')).toBeInTheDocument();
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/settings/media');
    expect(JSON.parse(String(request.body))).toEqual({
      settings: savedDocument.settings,
      expected_revision: MEDIA_SETTINGS_INITIAL_REVISION,
    });
  });

  it('keeps media-domain mode invalid until a dedicated origin exists', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      success: true,
      data: initialDocument,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('textbox', { name: 'Media address' });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Delivery mode' }),
      'media_domain',
    );
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a valid media origin',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

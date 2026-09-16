// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { EdgeSecuritySettingsPage } from './EdgeSecuritySettingsPage';
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
    created_at_iso: '2026-08-05T00:00:00.000Z',
    last_seen_at_iso: '2026-08-05T00:05:00.000Z',
    idle_expires_at_iso: '2026-08-05T12:05:00.000Z',
    absolute_expires_at_iso: '2026-08-12T00:00:00.000Z',
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
    comment_write_verification_mode: 'pow',
    newsletter_subscribe_verification_mode: 'pow',
    form_submit_verification_mode: 'pow',
    turnstile_sitekey: null,
    ip_address_retention_days: 30,
  },
  revision: '1'.repeat(32),
  updated_at_iso: '2026-08-05T01:00:00Z',
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
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

describe('EdgeSecuritySettingsPage', () => {
  it('requires a public sitekey for Turnstile and saves a complete policy', async () => {
    const savedSettings = {
      ...initialDocument.settings,
      comment_write_verification_mode: 'turnstile',
      turnstile_sitekey: '0x4AAAAA-test',
      ip_address_retention_days: 45,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: initialDocument }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          settings: savedSettings,
          revision: '3'.repeat(32),
          updated_at_iso: '2026-08-05T02:00:00Z',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/settings/edge/request-security']}>
        <EdgeSecuritySettingsPage
          data={session}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Edge Security' }))
      .toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Comment submission' }))
      .toHaveValue('pow');
    expect(screen.getByRole('spinbutton', { name: 'Retention period (days)' }))
      .toHaveValue(30);
    expect(screen.getByText('Configure the Worker secret separately'))
      .toBeInTheDocument();
    expect(screen.getByText('TURNSTILE_SECRET_KEY')).toBeInTheDocument();
    expect(screen.getByText('Secret')).toBeInTheDocument();
    expect(screen.getByText(/Use a Secret rather than a plaintext variable/u))
      .toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Comment submission' }),
      'turnstile',
    );
    expect(screen.getByText(
      'Enter the public Turnstile sitekey while any write surface uses Turnstile.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Edge Security' }))
      .toBeDisabled();

    await user.type(
      screen.getByRole('textbox', { name: 'Turnstile sitekey' }),
      ' 0x4AAAAA-test ',
    );
    const retention = screen.getByRole('spinbutton', {
      name: 'Retention period (days)',
    });
    await user.clear(retention);
    await user.type(retention, '45');
    await user.click(screen.getByRole('button', {
      name: 'Save Edge Security',
    }));

    expect(await screen.findByText(
      'Edge public request security settings saved.',
    )).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/settings/edge-security');
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
});

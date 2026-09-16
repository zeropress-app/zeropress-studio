// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { changeLocale } from './i18n';
import { PasswordChangePage } from './PasswordChangePage';

const accountData: CurrentSessionSuccess['data'] = {
  user: {
    id: '1'.repeat(32),
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: {
    id: '2'.repeat(32),
    created_at_iso: '2026-07-31T00:00:00.000Z',
    last_seen_at_iso: '2026-07-31T11:59:00.000Z',
    idle_expires_at_iso: '2026-08-01T00:00:00.000Z',
    absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
    network: {
      ip_address: '203.0.113.10',
      asn: 13335,
      as_organization: 'Cloudflare, Inc.',
      country_code: 'KR',
    },
  },
  csrf_token: 'c'.repeat(43),
  edge_integration: { mode: 'enabled', database_state: 'ready' },
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

describe('PasswordChangePage', () => {
  it('uses an operation-bound grant and waits to return to sign-in after revoking every session', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          totp: { configured_at_iso: '2026-07-30T12:00:00.000Z' },
          webauthn: {
            current_rp_id: 'studio.local',
            max_credentials: 10,
            credentials: [],
          },
          step_up: { mfa_required: false, freshness_seconds: 300 },
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'authorized',
          operation: 'change_password',
          management_token: 'm'.repeat(64),
          expires_at_iso: '2026-07-31T12:05:00.000Z',
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'password_changed',
          revoked_sessions: 3,
          current_session_ended: true,
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onSessionEnded = vi.fn();
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <PasswordChangePage
          data={accountData}
          onSessionEnded={onSessionEnded}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', {
      name: 'Confirm and replace your password',
    })).toBeInTheDocument();
    await user.type(
      screen.getByLabelText('Current password'),
      'current secure password',
    );
    const nextPassword = 'Harbor lantern canyon marble circuit 942!';
    await user.type(screen.getByLabelText('New password'), nextPassword);
    await user.type(
      screen.getByLabelText('Confirm new password'),
      nextPassword,
    );
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('heading', { name: 'Password changed' }))
      .toBeInTheDocument();
    expect(screen.getByText(/All 3 active sessions were ended/))
      .toBeInTheDocument();
    expect(onSessionEnded).not.toHaveBeenCalled();
    const authorization = JSON.parse(
      fetchMock.mock.calls[1][1].body as string,
    );
    expect(authorization).toEqual({
      operation: 'change_password',
      password: 'current secure password',
    });
    const completion = JSON.parse(
      fetchMock.mock.calls[2][1].body as string,
    );
    expect(completion).toEqual({
      management_token: 'm'.repeat(64),
      new_password: nextPassword,
    });

    await user.click(screen.getByRole('button', {
      name: 'Return to sign in',
    }));
    expect(onSessionEnded).toHaveBeenCalledOnce();
  });
});

// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { AccountSecurityPage } from './AccountSecurityPage';
import { changeLocale } from './i18n';

const currentSessionId = 'ffeeddccbbaa99887766554433221100';
const otherSessionId = '00112233445566778899aabbccddeeff';
const accountData: CurrentSessionSuccess['data'] = {
  user: {
    id: '0123456789abcdef0123456789abcdef',
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: {
    id: currentSessionId,
    created_at_iso: '2026-07-31T00:00:00.000Z',
    last_seen_at_iso: '2026-07-31T00:05:00.000Z',
    idle_expires_at_iso: '2026-07-31T12:05:00.000Z',
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

const sessionItems = [
  {
    id: currentSessionId,
    is_current: true,
    created_at_iso: '2026-07-31T00:00:00.000Z',
    last_seen_at_iso: '2026-07-31T00:05:00.000Z',
    idle_expires_at_iso: '2026-07-31T12:05:00.000Z',
    absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
    user_agent: 'Mozilla/5.0 Current Browser',
    network: {
      ip_address: '203.0.113.10',
      asn: 13335,
      as_organization: 'Cloudflare, Inc.',
      country_code: 'KR',
    },
  },
  {
    id: otherSessionId,
    is_current: false,
    created_at_iso: '2026-07-30T00:00:00.000Z',
    last_seen_at_iso: '2026-07-30T06:00:00.000Z',
    idle_expires_at_iso: '2026-07-31T10:00:00.000Z',
    absolute_expires_at_iso: '2026-08-06T00:00:00.000Z',
    user_agent: 'Mozilla/5.0 Other Browser',
    network: {
      ip_address: '192.0.2.20',
      asn: null,
      as_organization: null,
      country_code: 'US',
    },
  },
] as const;

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function listResponse() {
  return response({
    success: true,
    data: {
      items: sessionItems,
      max_sessions: 5,
    },
  });
}

function mfaStatusResponse() {
  return response({
    success: true,
    data: {
      totp: {
        configured_at_iso: '2026-07-30T12:00:00.000Z',
      },
      webauthn: {
        current_rp_id: 'localhost',
        max_credentials: 10,
        credentials: [],
      },
      step_up: { mfa_required: false, freshness_seconds: 300 },
    },
  });
}

function renderPage(onSessionEnded = vi.fn()) {
  return render(
    <MemoryRouter>
      <AccountSecurityPage
        data={accountData}
        onSessionEnded={onSessionEnded}
      />
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

describe('AccountSecurityPage', () => {
  it('shows current and other session security metadata', async () => {
    vi.stubGlobal('fetch', vi.fn((path: string) =>
      Promise.resolve(path.endsWith('/mfa/management/status')
        ? mfaStatusResponse()
        : listResponse())
    ));

    renderPage();

    expect(await screen.findByRole('heading', {
      name: 'Active sessions',
    })).toBeInTheDocument();
    expect(await screen.findByRole('heading', {
      name: 'Multi-factor authentication',
    })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change password' }))
      .toHaveAttribute('href', '/my-account/security/password');
    expect(screen.getByRole('link', {
      name: 'Replace authenticator',
    })).toHaveAttribute('href', '/my-account/security/mfa/replace');
    expect(await screen.findByText('Current session')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.10')).toBeInTheDocument();
    expect(screen.getByText('AS13335 · Cloudflare, Inc.'))
      .toBeInTheDocument();
    expect(screen.getByText('Mozilla/5.0 Current Browser'))
      .toBeInTheDocument();
    expect(screen.getByText('192.0.2.20')).toBeInTheDocument();
    expect(screen.getByText('Mozilla/5.0 Other Browser'))
      .toBeInTheDocument();
  });

  it('keeps a failed revocation confirmation open and permits retry', async () => {
    let revokeAttempts = 0;
    const fetchMock = vi.fn((path: string, _init?: RequestInit) => {
      if (path.endsWith('/mfa/management/status')) {
        return Promise.resolve(mfaStatusResponse());
      }
      if (path.endsWith('/sessions')) {
        return Promise.resolve(listResponse());
      }
      revokeAttempts += 1;
      return Promise.resolve(revokeAttempts === 1
        ? response({
          success: false,
          error: { code: 'INTERNAL_ERROR' },
        }, 500)
        : response({
        success: true,
        data: {
          status: 'session_revoked',
          revoked: true,
          current_session_ended: false,
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    renderPage();

    await user.click(await screen.findByRole('button', {
      name: 'End session',
    }));
    const dialog = screen.getByRole('dialog', {
      name: 'End this session?',
    });
    expect(within(dialog).getByRole('button', {
      name: 'Keep sessions',
    })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', {
      name: 'End session',
    }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Studio could not end the requested session. Please try again.',
    );

    await user.click(within(dialog).getByRole('button', {
      name: 'End session',
    }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'The selected session has been ended.',
    );
    expect(screen.queryByText('192.0.2.20')).not.toBeInTheDocument();
    const revokeCall = fetchMock.mock.calls.find(
      ([path]) => path === '/api/auth/sessions/revoke',
    );
    expect(revokeCall?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-ZeroPress-CSRF': 'c'.repeat(43),
      },
      body: JSON.stringify({ session_id: otherSessionId }),
    });
  });

  it('ends all other sessions or the current session through confirmation', async () => {
    const fetchMock = vi.fn((path: string, _init?: RequestInit) => {
      if (path.endsWith('/mfa/management/status')) {
        return Promise.resolve(mfaStatusResponse());
      }
      if (path.endsWith('/sessions')) {
        return Promise.resolve(listResponse());
      }
      if (path.endsWith('/sessions/revoke-others')) {
        return Promise.resolve(response({
          success: true,
          data: {
            status: 'other_sessions_revoked',
            revoked_count: 1,
          },
        }));
      }
      return Promise.resolve(response({
        success: true,
        data: {
          status: 'session_revoked',
          revoked: true,
          current_session_ended: true,
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const onSessionEnded = vi.fn();
    const user = userEvent.setup();

    renderPage(onSessionEnded);

    await user.click(await screen.findByRole('button', {
      name: 'End all other sessions',
    }));
    let dialog = screen.getByRole('dialog', {
      name: 'End all other sessions?',
    });
    await user.click(within(dialog).getByRole('button', {
      name: 'End other sessions',
    }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Other sessions ended: 1.',
    );
    expect(screen.queryByText('192.0.2.20')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', {
      name: 'Sign out this session',
    }));
    dialog = screen.getByRole('dialog', {
      name: 'Sign out this session?',
    });
    await user.click(within(dialog).getByRole('button', {
      name: 'End session',
    }));
    expect(onSessionEnded).toHaveBeenCalledOnce();
    const revokeCall = fetchMock.mock.calls.find(
      ([path]) => path === '/api/auth/sessions/revoke',
    );
    expect(JSON.parse(String(revokeCall?.[1]?.body))).toEqual({
      session_id: currentSessionId,
    });
  });
});

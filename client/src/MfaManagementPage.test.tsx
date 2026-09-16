// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { changeLocale } from './i18n';
import { MfaManagementPage } from './MfaManagementPage';

const csrfToken = 'c'.repeat(43);
const managementToken = 'm'.repeat(64);

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function statusResponse(mfaRequired: boolean) {
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
      step_up: {
        mfa_required: mfaRequired,
        freshness_seconds: 300,
      },
    },
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

describe('MfaManagementPage', () => {
  it('starts authenticator replacement without asking for a recently supplied MFA code', async () => {
    const fetchMock = vi.fn((path: string) => {
      if (path.endsWith('/status')) {
        return Promise.resolve(statusResponse(false));
      }
      if (path.endsWith('/authorize')) {
        return Promise.resolve(response({
          success: true,
          data: {
            status: 'authorized',
            operation: 'replace_totp',
            management_token: managementToken,
            expires_at_iso: '2026-07-31T12:05:00.000Z',
          },
        }));
      }
      return Promise.resolve(response({
        success: true,
        data: {
          method: 'totp',
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          otpauth_uri: 'otpauth://totp/ZeroPress%20Studio%3Aowner%40example.com?secret=JBSWY3DPEHPK3PXP',
          enrollment_token: 'e'.repeat(64),
          expires_at_iso: '2026-07-31T12:15:00.000Z',
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <MfaManagementPage
          operation="replace_totp"
          data={{ csrf_token: csrfToken }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText(
      'This session completed MFA recently, so another code is not required for this step.',
    )).toBeInTheDocument();
    await user.type(screen.getByLabelText('Current password'), 'password');
    await user.click(screen.getByRole('button', {
      name: 'Continue securely',
    }));
    expect(await screen.findByRole('heading', {
      name: 'Register the replacement authenticator',
    })).toBeInTheDocument();
    expect(screen.getByText('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'))
      .toBeInTheDocument();
  });
});

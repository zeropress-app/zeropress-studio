// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from './i18n';
import { UserActivationPage } from './UserActivationPage';
import { consumeSetupTokenFromLocation } from './lib/setup-location';

const invitationToken = `${'1'.repeat(32)}.${'A'.repeat(43)}`;

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderActivation(setupToken: string) {
  return render(
    <MemoryRouter>
      <UserActivationPage setupToken={setupToken} />
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
  window.history.replaceState({}, '', `/activate#token=${invitationToken}`);
});

describe('UserActivationPage', () => {
  it('removes the bearer from the address and activates only after password and MFA', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          email: 'author@example.com',
          purpose: 'invitation',
          name: 'Site Author',
          role: 'author',
          expires_at_iso: '2026-08-01T12:00:00.000Z',
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          method: 'totp',
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          otpauth_uri: 'otpauth://totp/ZeroPress%20Studio%3Aauthor%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=ZeroPress%20Studio',
          enrollment_token: 'e'.repeat(64),
          expires_at_iso: '2026-07-31T12:10:00.000Z',
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: { status: 'user_activated' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const user = userEvent.setup();
    const consumedToken = consumeSetupTokenFromLocation();
    renderActivation(consumedToken);

    expect(window.location.hash).toBe('');
    expect(await screen.findByText('Site Author')).toBeInTheDocument();
    expect(screen.getByText('author@example.com · Author'))
      .toBeInTheDocument();
    const activationRegion = screen.getByRole('region', {
      name: 'Studio account activation',
    });
    expect(activationRegion).toHaveClass('auth-frame-activation');
    expect(activationRegion.querySelector('.auth-activation-rail'))
      .toBeInTheDocument();
    expect(activationRegion.querySelector('.auth-activation-panel'))
      .toContainElement(screen.getByLabelText('Password'));
    expect(screen.getByRole('navigation', {
      name: 'Account setup progress',
    })).toBeInTheDocument();
    expect(screen.getByText('Password setup').closest('li'))
      .toHaveAttribute('aria-current', 'step');
    const expires = activationRegion.querySelector('time');
    expect(expires).toHaveAttribute(
      'datetime',
      '2026-08-01T12:00:00.000Z',
    );
    expect(expires).toHaveTextContent(new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date('2026-08-01T12:00:00.000Z')));
    const language = screen.getByLabelText('Language');
    await user.selectOptions(language, 'ko');
    expect(await screen.findByRole('heading', {
      name: 'Studio 계정을 활성화하세요',
    })).toBeInTheDocument();
    expect(expires).toHaveTextContent(new Intl.DateTimeFormat('ko', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date('2026-08-01T12:00:00.000Z')));
    await user.selectOptions(language, 'en');
    expect(await screen.findByRole('heading', {
      name: 'Activate your Studio account',
    })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to MFA' }))
      .toBeDisabled();
    expect(screen.getByLabelText('Password'))
      .toHaveAttribute('placeholder', 'At least 15 characters');
    await user.type(
      screen.getByLabelText('Password'),
      'harbor lantern canyon marble circuit',
    );
    await user.type(
      screen.getByLabelText('Confirm password'),
      'harbor lantern canyon marble circuit',
    );
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Confirm password'))
      .toHaveAttribute('type', 'text');
    expect(screen.queryByRole('checkbox', { name: 'Show password' }))
      .not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Continue to MFA',
    }));

    expect(await screen.findByText('Connect an authenticator app'))
      .toBeInTheDocument();
    await user.type(
      screen.getByLabelText(/Current 6-digit authenticator code/),
      '123456',
    );
    await user.click(screen.getByRole('button', {
      name: 'Activate account',
    }));

    expect(await screen.findByRole('heading', {
      name: 'Your Studio account is active',
    })).toBeInTheDocument();
    expect(screen.getByText('ACCOUNT ACTIVATION')).toBeInTheDocument();
    expect(screen.getByText(
      'Your password and authenticator are configured. You can now sign in.',
    )).toBeInTheDocument();
    const completedRegion = screen.getByRole('region', {
      name: 'Studio account activation',
    });
    expect(completedRegion).toHaveClass('standalone-status');
    expect(completedRegion).not.toHaveClass('auth-frame-activation');
    const signInLink = screen.getByRole('link', { name: 'Go to sign in' });
    expect(signInLink).toHaveAttribute('href', '/');
    expect(signInLink).not.toHaveAttribute('target');
    const setupRequest = JSON.parse(
      fetchMock.mock.calls[1][1].body as string,
    );
    expect(setupRequest.setup_token).toBe(invitationToken);
    expect(window.location.href).not.toContain(invitationToken);
  });

  it('shows a generic terminal state when no invitation bearer exists', async () => {
    window.history.replaceState({}, '', '/activate');
    renderActivation('');

    expect(await screen.findByRole('heading', {
      name: 'This setup link cannot be used',
    })).toBeInTheDocument();
    expect(screen.getByRole('region', {
      name: 'Studio account activation',
    })).toHaveClass('standalone-status');
  });

  it('presents credential recovery as a replacement of revoked sign-in material', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: {
        purpose: 'credential_recovery',
        email: 'author@example.com',
        name: 'Site Author',
        role: 'author',
        expires_at_iso: '2026-07-31T13:00:00.000Z',
      },
    })));

    renderActivation(invitationToken);

    expect(await screen.findByRole('heading', {
      name: 'Recover your Studio account',
    })).toBeInTheDocument();
    expect(screen.getByText(/Previous sign-in credentials are already revoked/))
      .toBeInTheDocument();
  });
});

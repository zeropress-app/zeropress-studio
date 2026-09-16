// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';
import { changeLocale } from './i18n';
import { LOCALE_STORAGE_KEY } from './i18n/locale';
import { setThemePreference, THEME_STORAGE_KEY } from './lib/theme-preference';

const webAuthnMocks = vi.hoisted(() => ({
  supported: false,
  startAuthentication: vi.fn(),
}));

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => webAuthnMocks.supported,
  startAuthentication: webAuthnMocks.startAuthentication,
}));

const continuationToken = 'c'.repeat(64);
const enrollmentToken = 'e'.repeat(64);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  setThemePreference('system');
  webAuthnMocks.supported = false;
  webAuthnMocks.startAuthentication.mockReset();
  await changeLocale('en');
});

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function loginContinuation(status: 'mfa_required' | 'mfa_enrollment_required') {
  return {
    success: true,
    data: {
      status,
      continuation_token: continuationToken,
      expires_at_iso: '2026-07-30T12:05:00.000Z',
      ...(status === 'mfa_required'
        ? {
          available_methods: ['totp'],
          preferred_method: 'totp',
        }
        : {}),
    },
  };
}

async function submitCredentials(onAuthenticated = vi.fn()) {
  const user = userEvent.setup();
  render(<LoginPage onAuthenticated={onAuthenticated} />);
  await user.type(screen.getByLabelText('Email'), 'admin@example.com');
  await user.type(screen.getByLabelText('Password'), 'password');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  return user;
}

describe('LoginPage', () => {
  it('offers the shared two-state appearance control only on the full page', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<LoginPage onAuthenticated={vi.fn()} />);

    expect(screen.getByText(
      'Enter your email and password to continue.',
    )).toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Use dark appearance',
    }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    rerender(<LoginPage onAuthenticated={vi.fn()} embedded />);
    expect(screen.queryByRole('button', {
      name: 'Use light appearance',
    })).not.toBeInTheDocument();
  });

  it('offers a direct discoverable passkey sign-in without asking for email', async () => {
    webAuthnMocks.supported = true;
    const assertion = {
      id: 'credential',
      rawId: 'credential',
      response: {
        clientDataJSON: 'client',
        authenticatorData: 'authenticator',
        signature: 'signature',
        userHandle: 'opaque-user-handle',
      },
      clientExtensionResults: {},
      type: 'public-key',
    };
    webAuthnMocks.startAuthentication.mockResolvedValue(assertion);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          options: {
            challenge: 'challenge',
            rpId: 'localhost',
            userVerification: 'required',
            allowCredentials: [],
          },
          challenge_token: 'a'.repeat(32),
          expires_at_iso: '2026-08-11T12:05:00.000Z',
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'authenticated',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onAuthenticated = vi.fn();
    const user = userEvent.setup();
    render(<LoginPage onAuthenticated={onAuthenticated} />);

    await user.click(screen.getByRole('button', {
      name: 'Sign in with a passkey',
    }));

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/passkey/options');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({});
    expect(webAuthnMocks.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({
        allowCredentials: [],
        userVerification: 'required',
      }),
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/auth/passkey/verify');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      challenge_token: 'a'.repeat(32),
      response: assertion,
    });
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it('uses an explicitly selected user-verifying WebAuthn credential', async () => {
    webAuthnMocks.supported = true;
    const assertion = {
      id: 'credential',
      rawId: 'credential',
      response: {
        clientDataJSON: 'client',
        authenticatorData: 'authenticator',
        signature: 'signature',
      },
      clientExtensionResults: {},
      type: 'public-key',
    };
    webAuthnMocks.startAuthentication.mockResolvedValue(assertion);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        ...loginContinuation('mfa_required'),
        data: {
          ...loginContinuation('mfa_required').data,
          available_methods: [
            'webauthn',
            'totp',
          ],
          preferred_method: 'webauthn',
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          options: {
            challenge: 'challenge',
            rpId: 'localhost',
            userVerification: 'discouraged',
          },
          challenge_token: 'a'.repeat(32),
          expires_at_iso: '2026-07-30T12:05:00.000Z',
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'authenticated',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onAuthenticated = vi.fn();
    const user = await submitCredentials(onAuthenticated);

    await screen.findByRole('heading', { name: 'Verify your identity' });
    expect(screen.getByLabelText('Passkey or security key'))
      .toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Use passkey' }));

    expect(webAuthnMocks.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({
        userVerification: 'discouraged',
      }),
    });
    expect(fetchMock.mock.calls[1]?.[0])
      .toBe('/api/auth/mfa/webauthn/options');
    expect(fetchMock.mock.calls[2]?.[0])
      .toBe('/api/auth/mfa/webauthn/verify');
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)))
      .toMatchObject({
        continuation_token: continuationToken,
        challenge_token: 'a'.repeat(32),
        response: assertion,
      });
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it('requires and verifies a TOTP code after the password', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(loginContinuation('mfa_required')))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'authenticated',
        },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onAuthenticated = vi.fn();
    const user = await submitCredentials(onAuthenticated);

    expect(
      await screen.findByRole('heading', { name: 'Verify your identity' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('Six-digit code'), '123456');
    await user.click(
      screen.getByRole('button', { name: 'Verify and sign in' }),
    );

    expect(onAuthenticated).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/auth/mfa/verify');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      continuation_token: continuationToken,
      method: 'totp',
      code: '123456',
    });
  });

  it('forces fresh MFA enrollment for an account without a factor', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        response(loginContinuation('mfa_enrollment_required')),
      )
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          method: 'totp',
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          otpauth_uri: 'otpauth://totp/ZeroPress%20Studio%3Aadmin%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          enrollment_token: enrollmentToken,
          expires_at_iso: '2026-07-30T12:15:00.000Z',
        },
      }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          status: 'authenticated',
        },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const onAuthenticated = vi.fn();
    const user = await submitCredentials(onAuthenticated);

    expect(
      await screen.findByRole('heading', { name: 'Protect this account' }),
    ).toBeInTheDocument();
    await user.type(
      screen.getByLabelText('Current 6-digit authenticator code'),
      '654321',
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Verify MFA and sign in',
      }),
    );

    expect(onAuthenticated).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/auth/mfa/enrollment/setup',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      continuation_token: continuationToken,
      mfa: {
        enrollment_token: enrollmentToken,
        totp_code: '654321',
      },
    });
  });

  it('shows generic credential and MFA failures without leaking account state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      response({
        success: false,
        error: { code: 'INVALID_CREDENTIALS' },
      }, 401),
    ));
    await submitCredentials();

    expect(await screen.findByText('Sign-in failed')).toBeInTheDocument();
    expect(screen.getByText('The email or password is incorrect.'))
      .toBeInTheDocument();
  });

  it('updates the MFA screen to Korean and persists the preference', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      response(loginContinuation('mfa_required')),
    ));
    const user = await submitCredentials();
    await screen.findByLabelText('Six-digit code');

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Language' }),
      'ko',
    );
    expect(await screen.findByText('본인 확인')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '확인 후 로그인' }))
      .toBeInTheDocument();
    expect(document.documentElement.lang).toBe('ko');
    expect(document.title).toBe('로그인 · ZeroPress Studio');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ko');
  });
});

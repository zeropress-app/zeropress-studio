// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { INITIAL_CHECKING_MIN_VISIBLE_MS } from './components/InitialCheckingGate';
import { changeLocale } from './i18n';

const installToken = 'installer-token-value-000000000000';
const setupToken = `${'1'.repeat(32)}.${'A'.repeat(43)}`;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  await changeLocale('en');
});

function statusResponse(input: {
  studioVersion?: string;
  siteMode:
    | 'initial'
    | 'operational'
    | 'maintenance'
    | 'recovery'
    | null;
  database?: Record<string, unknown>;
  access: Record<string, unknown>;
  installationConfiguration?: Record<string, unknown> | null;
  operations?: 'available' | 'not_found' | 'setup_required';
}) {
  return {
    success: true,
    data: {
      studio_version: input.studioVersion,
      site_mode: input.siteMode,
      database: input.database ?? {
        state: 'ready',
        schema_version: 1,
        target_schema_version: 1,
      },
      access: input.access,
      installation_configuration: input.installationConfiguration ?? null,
      operations: input.operations === 'setup_required'
        ? { state: 'setup_required', configuration: { allowed_ips: 'valid', token: 'missing' } }
        : { state: input.operations ?? 'not_found' },
    },
  };
}

function mockStatus(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    jsonResponse(payload),
  ));
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function anonymousSessionResponse() {
  return jsonResponse({
    success: false,
    error: { code: 'AUTHENTICATION_REQUIRED' },
  }, 401);
}

function interfaceConfigResponse(input: {
  defaultLocale?: 'en' | 'ko';
  enabledLocales?: ('en' | 'ko')[];
} = {}) {
  return jsonResponse({
    success: true,
    data: {
      default_locale: input.defaultLocale ?? 'en',
      enabled_locales: input.enabledLocales ?? ['en', 'ko'],
    },
  });
}

function authenticatedSessionResponse() {
  return {
    success: true,
    data: {
      user: {
        id: '0123456789abcdef0123456789abcdef',
        email: 'owner@example.com',
        name: 'Studio Owner',
        roles: ['admin'],
      },
      session: {
        id: 'fedcba9876543210fedcba9876543210',
        created_at_iso: '2026-07-31T00:00:00.000Z',
        last_seen_at_iso: '2026-07-31T00:05:00.000Z',
        idle_expires_at_iso: '2099-07-31T12:05:00.000Z',
        absolute_expires_at_iso: '2099-08-07T00:00:00.000Z',
        network: {
          ip_address: '2001:db8::10',
          asn: null,
          as_organization: null,
          country_code: null,
        },
      },
      csrf_token: 'c'.repeat(43),
      edge_integration: { mode: 'enabled', database_state: 'ready' },
    },
  };
}

function dashboardSummaryResponse() {
  return {
    success: true,
    data: {
      generated_at_iso: '2026-07-31T00:06:00.000Z',
      content: {
        posts: {
          access: { scope: 'all' },
          total: 0,
          draft: 0,
          published: 0,
          trash: 0,
        },
        pages: { total: 0, draft: 0, published: 0, trash: 0 },
        media: { total: 0, managed: 0, external: 0 },
      },
      mail: { configured: false },
      edge: { status: 'unavailable', pending_target_events: 0 },
    },
  };
}

function cloudflareAccessSettingsResponse() {
  return {
    success: true,
    data: {
      settings: {
        mode: 'disabled',
        issuer: null,
        audience: null,
        bound_origin: null,
        verified_at_iso: null,
      },
      revision: '0'.repeat(32),
      updated_at_iso: null,
      detection_state: 'not_detected',
      detected: null,
    },
  };
}

function activeSessionsResponse() {
  return {
    success: true,
    data: {
      items: [{
        id: 'fedcba9876543210fedcba9876543210',
        is_current: true,
        created_at_iso: '2026-07-31T00:00:00.000Z',
        last_seen_at_iso: '2026-07-31T00:05:00.000Z',
        idle_expires_at_iso: '2026-07-31T12:05:00.000Z',
        absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
        user_agent: 'Test Browser',
        network: {
          ip_address: '2001:db8::10',
          asn: null,
          as_organization: null,
          country_code: null,
        },
      }],
      max_sessions: 5,
    },
  };
}

function mfaManagementStatusResponse() {
  return {
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
  };
}

describe('SystemBootstrap', () => {
  it('does not flash the login form before operational status is verified', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }))
      .mockResolvedValueOnce(interfaceConfigResponse())
      .mockResolvedValueOnce(anonymousSessionResponse()));

    const { container } = render(<App />);

    expect(screen.queryByRole('heading', { name: 'Getting Studio ready' }))
      .not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(container.querySelector('.auth-shell'))
      .toHaveClass('auth-shell-pending');
    expect(container.querySelector('.auth-frame-chrome'))
      .not.toBeInTheDocument();
    expect(container.querySelector('.standalone-status'))
      .not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveClass('visually-hidden');
    expect(screen.getByRole('status')).toHaveTextContent('Getting Studio ready');

    resolveFetch?.(new Response(JSON.stringify(statusResponse({
      siteMode: 'operational',
      access: { state: 'operational' },
    }))));

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Getting Studio ready' }))
      .not.toBeInTheDocument();
  });

  it('reveals a slow initial check after two seconds and keeps it stable', async () => {
    vi.useFakeTimers();
    let resolveStatus: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveStatus = resolve;
      }))
      .mockResolvedValueOnce(interfaceConfigResponse())
      .mockResolvedValueOnce(anonymousSessionResponse()));

    render(<App />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(screen.queryByRole('heading', { name: 'Getting Studio ready' }))
      .not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole('heading', { name: 'Getting Studio ready' }))
      .toBeInTheDocument();

    await act(async () => {
      resolveStatus?.(jsonResponse(statusResponse({
        siteMode: 'operational',
        access: { state: 'operational' },
      })));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INITIAL_CHECKING_MIN_VISIBLE_MS - 1);
    });
    expect(screen.getByRole('heading', { name: 'Getting Studio ready' }))
      .toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('hides the language selector when the organization enables one locale', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'operational',
        access: { state: 'operational' },
      })))
      .mockResolvedValueOnce(interfaceConfigResponse({
        defaultLocale: 'en',
        enabledLocales: ['en'],
      }))
      .mockResolvedValueOnce(anonymousSessionResponse());
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Language' }))
      .not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/system/status',
      '/api/system/interface-config',
      '/api/auth/session',
    ]);
  });

  it('applies the organization locale policy before rendering account activation', async () => {
    window.history.replaceState(null, '', '/activate');
    const fetchMock = vi.fn().mockResolvedValueOnce(interfaceConfigResponse({
      defaultLocale: 'en',
      enabledLocales: ['en'],
    }));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('heading', {
      name: 'This setup link cannot be used',
    })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Language' }))
      .not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/system/interface-config',
    );
  });

  it('uses the same delayed check across activation configuration and token inspection', async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, '', '/activate');
    let resolveInterface: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveInterface = resolve;
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          purpose: 'invitation',
          email: 'author@example.com',
          name: 'Site Author',
          role: 'author',
          expires_at_iso: '2026-08-01T12:00:00.000Z',
        },
      })));

    render(<App setupToken={setupToken} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(screen.queryByRole('heading', {
      name: 'Checking this setup link…',
    })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole('heading', {
      name: 'Checking this setup link…',
    })).toBeInTheDocument();

    await act(async () => {
      resolveInterface?.(interfaceConfigResponse());
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(INITIAL_CHECKING_MIN_VISIBLE_MS);
    });
    expect(screen.getByRole('heading', {
      name: 'Activate your Studio account',
    })).toBeInTheDocument();
  });

  it('shows the installer instead of login', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'initial',
        database: {
          state: 'uninstalled',
          target_schema_version: 1,
        },
        access: { state: 'installation' },
      })))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { state: 'authorized' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole('heading', {
      name: 'Verify the install token',
    })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', {
      name: 'Studio installation progress',
    })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Install token').parentElement
      ?.querySelector('.lucide-key-round')).toBeInTheDocument();
    expect(screen.queryByText('STUDIO_INSTALL_TOKEN')).not.toBeInTheDocument();
    expect(screen.queryByText(/Cloudflare Secret, not a plaintext Variable/u))
      .not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use dark appearance' }))
      .toBeInTheDocument();

    const localeSelect = screen.getByRole('combobox', { name: 'Language' });
    await user.selectOptions(localeSelect, 'ko');
    expect(await screen.findByRole('heading', {
      name: '설치 토큰 확인',
    })).toBeInTheDocument();
    expect(localeSelect).toHaveValue('ko');
    await user.selectOptions(localeSelect, 'en');

    await user.type(screen.getByLabelText('Install token'), installToken);
    await user.click(screen.getByRole('button', {
      name: 'Continue to installation',
    }));

    const licenseHeading = await screen.findByRole('heading', {
      name: 'Open-source license',
    });
    expect(licenseHeading).toBeInTheDocument();
    expect(screen.getByText(
      'ZeroPress Studio is provided under the Apache License 2.0. Review the terms before continuing.',
    )).toBeInTheDocument();
    const progress = screen.getByRole('navigation', {
      name: 'Studio installation progress',
    });
    const installRail = licenseHeading.closest('.auth-install-rail');
    const headingSlot = installRail?.querySelector(
      '.auth-install-header-slot',
    );
    expect(installRail).not.toBeNull();
    expect(headingSlot?.querySelectorAll('.setup-header-install'))
      .toHaveLength(3);
    expect(headingSlot?.querySelectorAll(
      '.setup-header-install[data-active="false"][aria-hidden="true"]',
    )).toHaveLength(2);
    expect(progress.parentElement).toBe(installRail);
    expect(within(progress).getByText('License').closest('li'))
      .toHaveAttribute('aria-current', 'step');
    expect(within(progress).getByText('Administrator setup').closest('li'))
      .not.toHaveAttribute('aria-current');
    expect(screen.getByLabelText('Apache License 2.0 text'))
      .toHaveTextContent('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION');
    const licenseSourceLink = screen.getByRole('link', {
      name: 'View LICENSE on GitHub. Opens in a new tab.',
    });
    expect(licenseSourceLink).toHaveAttribute(
      'href',
      'https://github.com/zeropress-app/zeropress-studio/blob/main/LICENSE',
    );
    expect(licenseSourceLink).toHaveAttribute('target', '_blank');
    expect(licenseSourceLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(licenseSourceLink.querySelector('.lucide-external-link'))
      .toBeInTheDocument();
    expect(screen.queryByLabelText('Install token')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use dark appearance' }))
      .toBeInTheDocument();

    const continueButton = screen.getByRole('button', {
      name: 'Continue to administrator setup',
    });
    expect(continueButton.querySelector('.lucide-arrow-right'))
      .toBeInTheDocument();
    await user.click(continueButton);

    const administratorHeading = screen.getByRole('heading', {
      name: 'Create the first administrator',
    });
    expect(administratorHeading).toHaveFocus();
    expect(administratorHeading.closest('.setup-header-install'))
      .toHaveAttribute('data-active', 'true');
    expect(licenseHeading.closest('.setup-header-install'))
      .toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByLabelText('Install token')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', {
      name: 'Installation authorization',
    })).not.toBeInTheDocument();
    expect(screen.queryByText(
      'Enter the one-time install token configured for this deployment.',
    )).not.toBeInTheDocument();
    expect(screen.queryByText(
      'Use 32–256 printable ASCII characters without spaces. The value must exactly match the Worker secret configured by the operator.',
    )).not.toBeInTheDocument();
    expect(screen.getByLabelText('Administrator password')).toBeInTheDocument();
    expect(screen.queryByRole('heading', {
      name: 'Administrator account',
    })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', {
      name: 'Password checks',
    })).toBeInTheDocument();
    expect(screen.getByText(
      'The strength estimate will appear as you type.',
    )).toBeInTheDocument();
    expect(screen.getByText('15–256 characters').closest('li'))
      .toHaveAttribute('data-state', 'pending');
    expect(screen.getByText(
      'Spaces are allowed; uppercase, number, and symbol composition rules are not required.',
    )).toBeInTheDocument();
    expect(screen.queryByText(
      'Use a unique password of 15–256 characters. Spaces are allowed.',
    )).not.toBeInTheDocument();
    expect(screen.getByLabelText('Administrator name').parentElement
      ?.querySelector('.lucide-user-round')).toBeInTheDocument();
    expect(screen.getByLabelText('Administrator email').parentElement
      ?.querySelector('.lucide-mail')).toBeInTheDocument();
    expect(screen.getByLabelText('Administrator password').parentElement
      ?.querySelector('.lucide-lock-keyhole')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm password').parentElement
      ?.querySelector('.lucide-shield-check')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show password' })
      .querySelector('.lucide-eye')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to license' })
      .querySelector('.lucide-arrow-left')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue to MFA setup' })
      .querySelector('.lucide-arrow-right')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/system/install/access',
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${installToken}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      }),
    );
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it('rejects a non-ASCII install token before creating an HTTP header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(statusResponse({
      siteMode: 'initial',
      database: {
        state: 'uninstalled',
        target_schema_version: 1,
      },
      access: { state: 'installation' },
    })));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole('heading', {
      name: 'Verify the install token',
    })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Install token'), '한'.repeat(32));
    await user.click(screen.getByRole('button', {
      name: 'Continue to installation',
    }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The install token must contain 32–256 printable ASCII characters without spaces.',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps the install token in memory and clears it when the page is left', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'initial',
        database: {
          state: 'uninstalled',
          target_schema_version: 1,
        },
        access: { state: 'installation' },
      })))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { state: 'authorized' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    const tokenInput = await screen.findByLabelText('Install token');
    await user.type(tokenInput, 'temporary-token-draft');
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(screen.getByLabelText('Install token')).toHaveValue('');

    await user.type(screen.getByLabelText('Install token'), installToken);
    await user.click(screen.getByRole('button', {
      name: 'Continue to installation',
    }));
    expect(await screen.findByRole('heading', {
      name: 'Open-source license',
    })).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(screen.getByRole('heading', {
      name: 'Verify the install token',
    })).toBeInTheDocument();
    expect(screen.getByLabelText('Install token')).toHaveValue('');
  });

  it('submits the install token only as Bearer authorization and refreshes status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(statusResponse({
        siteMode: 'initial',
        database: {
          state: 'uninstalled',
          target_schema_version: 1,
        },
        access: { state: 'installation' },
      })), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { state: 'authorized' },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          method: 'totp',
          secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
          issuer: 'studio.example.com · Studio',
          account_name: 'owner@example.com',
          otpauth_uri: 'otpauth://totp/studio.example.com%20%C2%B7%20Studio%3Aowner%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=studio.example.com%20%C2%B7%20Studio&algorithm=SHA1&digits=6&period=30',
          enrollment_token: 'e'.repeat(64),
          expires_at_iso: '2026-07-30T12:15:00.000Z',
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          status: 'installed',
          schema_version: 1,
          edge_database: {
            status: 'skipped_nonempty',
            integration_mode: 'disabled',
          },
        },
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(statusResponse({
        siteMode: 'initial',
        access: { state: 'activation_required' },
      })), {
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole('heading', {
      name: 'Verify the install token',
    })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Install token'), installToken);
    await user.click(screen.getByRole('button', {
      name: 'Continue to installation',
    }));
    expect(await screen.findByRole('heading', {
      name: 'Open-source license',
    })).toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Continue to administrator setup',
    }));

    await user.type(screen.getByLabelText('Administrator name'), '  Studio Owner  ');
    await user.type(screen.getByLabelText('Administrator email'), 'OWNER@Example.COM');
    await user.type(
      screen.getByLabelText('Administrator password'),
      'harbor lantern canyon marble circuit',
    );
    await user.type(
      screen.getByLabelText('Confirm password'),
      'harbor lantern canyon marble circuit',
    );
    await user.click(
      screen.getByRole('button', { name: 'Continue to MFA setup' }),
    );
    expect(
      await screen.findByLabelText('Current 6-digit authenticator code'),
    ).toBeInTheDocument();
    const mfaAccount = screen.getByText('Service name')
      .closest('.auth-enrollment-account');
    expect(mfaAccount?.tagName).toBe('DL');
    expect(within(mfaAccount as HTMLElement).getByText('owner@example.com'))
      .toBeInTheDocument();
    expect(within(mfaAccount as HTMLElement).getByText('studio.example.com · Studio'))
      .toBeInTheDocument();
    expect(mfaAccount?.parentElement).toHaveClass('auth-enrollment-details');
    expect(mfaAccount?.parentElement?.querySelector('.auth-manual-key'))
      .not.toBeNull();
    expect(screen.getByRole('button', { name: 'Back to administrator setup' }))
      .toHaveClass('studio-button-lg');
    expect(screen.getByRole('button', { name: 'Back to administrator setup' })
      .querySelector('.lucide-arrow-left')).toBeInTheDocument();
    expect(screen.getByLabelText('Current 6-digit authenticator code')
      .parentElement?.querySelector('.lucide-smartphone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install ZeroPress Studio' })
      .querySelector('.lucide-shield-check')).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', {
      name: 'Studio installation progress',
    })).getByText('MFA setup').closest('li'))
      .toHaveAttribute('aria-current', 'step');
    await user.type(
      screen.getByLabelText('Current 6-digit authenticator code'),
      '123456',
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Install ZeroPress Studio',
      }),
    );

    expect(await screen.findByText('Installation is complete')).toBeInTheDocument();
    const finalization = screen.getByRole('region', {
      name: 'Enable Studio sign-in',
    });
    expect(within(finalization).queryByText(/Remove the STUDIO_INSTALL_TOKEN/))
      .not.toBeInTheDocument();
    expect(within(finalization).getAllByRole('listitem')).toHaveLength(2);
    expect(within(finalization).getByText('STUDIO_SITE_MODE'))
      .toBeInTheDocument();
    expect(within(finalization).getByText('Plain variable'))
      .toBeInTheDocument();
    expect(within(finalization).getByText('Set the value to operational.'))
      .toBeInTheDocument();
    expect(within(finalization).getByText(
      'Redeploy the Worker with the updated configuration.',
    )).toBeInTheDocument();
    expect(screen.getByText(
      'The Edge database was not installed automatically',
    )).toBeInTheDocument();
    expect(screen.getByText(/bound Edge database is not empty/))
      .toHaveTextContent(/Edge integration disabled/);
    expect(screen.getByRole('button', { name: 'Check configuration again' })
      .querySelector('.lucide-refresh-cw')).toBeInTheDocument();
    const completeProgress = screen.getByRole('navigation', {
      name: 'Studio installation progress',
    });
    for (const label of ['License', 'Administrator setup', 'MFA setup']) {
      expect(within(completeProgress).getByText(label).closest('li'))
        .toHaveAttribute('data-state', 'completed');
    }
    expect(within(completeProgress).queryByText('Complete'))
      .not.toBeInTheDocument();
    expect(completeProgress.querySelector('[aria-current="step"]'))
      .toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const accessCall = fetchMock.mock.calls[1];
    expect(accessCall[0]).toBe('/api/system/install/access');
    expect(accessCall[1]).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${installToken}`,
      },
    });
    expect(accessCall[1]?.body).toBeUndefined();
    const setupCall = fetchMock.mock.calls[2];
    expect(setupCall[0]).toBe('/api/system/install/mfa/setup');
    expect(JSON.parse(String(setupCall[1]?.body))).toEqual({
      admin_email: 'owner@example.com',
    });
    expect(String(setupCall[1]?.body)).not.toContain(
      'harbor lantern canyon marble circuit',
    );
    const installCall = fetchMock.mock.calls[3];
    expect(installCall[0]).toBe('/api/system/install');
    expect(installCall[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${installToken}`,
        'Content-Type': 'application/json',
      },
    });
    expect(JSON.parse(String(installCall[1]?.body))).toEqual({
      admin_name: 'Studio Owner',
      admin_email: 'owner@example.com',
      admin_password: 'harbor lantern canyon marble circuit',
      interface_locale: 'en',
      mfa: {
        enrollment_token: 'e'.repeat(64),
        totp_code: '123456',
      },
    });
    expect(String(installCall[1]?.body)).not.toContain(installToken);
  });

  it('blocks an offline common password without making an install request', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(statusResponse({
        siteMode: 'initial',
        database: {
          state: 'uninstalled',
          target_schema_version: 1,
        },
        access: { state: 'installation' },
      })), {
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { state: 'authorized' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole('heading', {
      name: 'Verify the install token',
    })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Install token'), installToken);
    await user.click(screen.getByRole('button', {
      name: 'Continue to installation',
    }));
    expect(await screen.findByRole('heading', {
      name: 'Open-source license',
    })).toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Continue to administrator setup',
    }));

    await user.type(screen.getByLabelText('Administrator name'), 'Studio Owner');
    await user.type(screen.getByLabelText('Administrator email'), 'owner@example.com');
    await user.type(
      screen.getByLabelText('Administrator password'),
      'correct horse battery staple',
    );
    await user.type(
      screen.getByLabelText('Confirm password'),
      'correct horse battery staple',
    );
    await user.click(
      screen.getByRole('button', { name: 'Continue to MFA setup' }),
    );

    expect(
      await screen.findByText(
        'Choose a password that passes every required policy check.',
      ),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows maintenance and activation as distinct states', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'maintenance',
        access: { state: 'maintenance' },
        operations: 'available',
      })));
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<App />);
    expect(await screen.findByText('Studio is temporarily unavailable')).toBeInTheDocument();
    expect(document.querySelector('.standalone-status'))
      .not.toHaveClass('standalone-status-wide');
    expect(await screen.findByRole('link', {
      name: 'Open Maintenance & Recovery',
    })).toHaveAttribute('href', '/system/operations');
    expect(screen.getByText(/Planned lifecycle work is in progress/))
      .toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/system/status',
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers)
      .not.toHaveProperty('Authorization');
    expect(screen.queryByText(/matching Worker operational log/))
      .not.toBeInTheDocument();
    unmount();

    mockStatus(statusResponse({
      siteMode: 'initial',
      access: { state: 'activation_required' },
    }));
    render(<App />);
    expect(await screen.findByText('Installation is complete')).toBeInTheDocument();
    expect(screen.getByText(
      'Finish the remaining Worker configuration before signing in.',
    )).toBeInTheDocument();
    const finalization = screen.getByRole('region', {
      name: 'Enable Studio sign-in',
    });
    expect(within(finalization).queryByText(/Remove the STUDIO_INSTALL_TOKEN/))
      .not.toBeInTheDocument();
    expect(within(finalization).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(/matching Worker operational log/))
      .not.toBeInTheDocument();
  });

  it('explains how to install an operational Studio with an empty database', async () => {
    mockStatus(statusResponse({
      siteMode: 'operational',
      database: {
        state: 'uninstalled',
        target_schema_version: 11,
      },
      access: {
        state: 'blocked',
        reason: 'DATABASE_UNINSTALLED',
      },
    }));

    render(<App />);

    expect(await screen.findByText('Complete the installation setup'))
      .toBeInTheDocument();
    expect(screen.getByText(
      'Complete the remaining Worker setting, redeploy, then check the setup again.',
    )).toBeInTheDocument();
    expect(document.querySelector('.standalone-status'))
      .toHaveClass('standalone-status-wide');
    const requirements = screen.getByRole('region', {
      name: 'Installation Worker settings',
    });
    const siteMode = within(requirements).getByRole('region', {
      name: 'STUDIO_SITE_MODE',
    });
    expect(siteMode).toHaveTextContent('Plain variableSTUDIO_SITE_MODE');
    expect(siteMode).toHaveTextContent(
      'Change the value to initial before installation.',
    );
    expect(within(siteMode).getByText('Change required'))
      .toHaveClass('studio-pill-attention');
    const authSecret = within(requirements).getByRole('region', {
      name: 'STUDIO_AUTH_SECRET',
    });
    expect(within(authSecret).getByText('Configured'))
      .toHaveClass('studio-pill-positive');
    expect(authSecret).toHaveClass('auth-secret-requirement-compact');
    expect(authSecret).toHaveTextContent(
      'Protects MFA data and stored service credentials.',
    );
    const installTokenRequirement = within(requirements).getByRole('region', {
      name: 'STUDIO_INSTALL_TOKEN',
    });
    expect(installTokenRequirement)
      .toHaveTextContent('SecretSTUDIO_INSTALL_TOKEN');
    expect(installTokenRequirement).toHaveTextContent(
      'Used to access the Studio installer.',
    );
    expect(within(installTokenRequirement).getByText('Check required'))
      .toHaveClass('studio-pill-attention');
    expect(within(installTokenRequirement).queryByText(
      /Not set|Invalid|Configured/,
    ))
      .not.toBeInTheDocument();
    expect(within(installTokenRequirement).getByRole('button', {
      name: 'Generate STUDIO_INSTALL_TOKEN',
    })).toHaveTextContent('Generate value');
    const guide = within(requirements).getByRole('link', {
      name: 'Open setup guide',
    });
    expect(guide).toHaveClass('auth-secret-guide-link');
    expect(guide).toHaveAttribute('target', '_blank');
    expect(screen.queryByText(/matching Worker operational log/))
      .not.toBeInTheDocument();
    expect(document.querySelector('.standalone-status'))
      .toHaveClass('standalone-status-warning');
    expect(screen.getByRole('button', { name: 'Check setup again' })
      .querySelector('.lucide-refresh-cw')).toBeInTheDocument();
  });

  it('keeps the completion experience while requiring removal of a retained post-install token binding', async () => {
    mockStatus(statusResponse({
      siteMode: 'initial',
      access: {
        state: 'blocked',
        reason: 'INSTALL_TOKEN_STILL_CONFIGURED',
      },
    }));

    render(<App />);

    expect(await screen.findByText('Installation is complete'))
      .toBeInTheDocument();
    expect(screen.getByText(
      'Finish the remaining Worker configuration before signing in.',
    )).toBeInTheDocument();
    const finalization = screen.getByRole('region', {
      name: 'Enable Studio sign-in',
    });
    expect(within(finalization).getByText('STUDIO_INSTALL_TOKEN'))
      .toBeInTheDocument();
    expect(within(finalization).getByText('Secret')).toBeInTheDocument();
    expect(within(finalization).getByText(
      'Delete this Runtime secret.',
    )).toBeInTheDocument();
    expect(within(finalization).getAllByRole('listitem')).toHaveLength(3);
    const progress = screen.getByRole('navigation', {
      name: 'Studio installation progress',
    });
    for (const label of ['License', 'Administrator setup', 'MFA setup']) {
      expect(within(progress).getByText(label).closest('li'))
        .toHaveAttribute('data-state', 'completed');
    }
    expect(within(progress).queryByText('Complete')).not.toBeInTheDocument();
    expect(progress.querySelector('[aria-current="step"]')).toBeNull();
    expect(screen.queryByText(/matching Worker operational log/))
      .not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('uses a compact correction screen for the authentication secret', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockStatus(statusResponse({
      siteMode: 'operational',
      access: {
        state: 'blocked',
        reason: 'AUTH_SECRET_NOT_CONFIGURED',
      },
    }));

    render(<App />);

    expect(await screen.findByText('Set the Studio authentication secret'))
      .toBeInTheDocument();
    expect(screen.getByText('CONFIGURATION REQUIRED')).toBeInTheDocument();
    expect(screen.getByText(/STUDIO_AUTH_SECRET is missing or invalid/))
      .toHaveTextContent(/redeploy, then check again/);
    expect(screen.getByText(
      'Use 32–256 printable ASCII characters without spaces.',
    )).toBeInTheDocument();
    expect(screen.getByText(
      'If this Studio was already in use, restore its existing value.',
    )).toBeInTheDocument();
    expect(screen.queryByText(/Protects MFA data/)).not.toBeInTheDocument();
    expect(screen.queryByText(/matching Worker operational log/))
      .not.toBeInTheDocument();
    expect(document.querySelector('.standalone-status'))
      .toHaveClass('standalone-status-wide');
    expect(document.querySelector('.auth-secret-setup-compact'))
      .toBeInTheDocument();

    expect(screen.queryByLabelText('Generated STUDIO_AUTH_SECRET'))
      .not.toBeInTheDocument();
    const guide = screen.getByRole('link', { name: 'Open setup guide' });
    expect(guide).toHaveAttribute(
      'href',
      'https://studio.zeropress.dev/getting-started/worker-secrets/',
    );
    expect(guide).toHaveAttribute('target', '_blank');
    expect(guide.querySelector('.lucide-external-link'))
      .toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Check configuration again',
    }).querySelector('.lucide-refresh-cw')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', {
      name: 'Generate value',
    }));
    const generated = screen.getByLabelText<HTMLInputElement>(
      'Generated STUDIO_AUTH_SECRET',
    );
    expect(generated.value).toMatch(/^[0-9a-f]{64}$/u);
    expect(fetch).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole('button', { name: 'Copy value' }));
    expect(writeText).toHaveBeenCalledWith(generated.value);
    await waitFor(() => {
      expect(screen.getByText('Generated value copied.')).toBeVisible();
    });
    expect(screen.getByText('Success:')).toHaveClass('visually-hidden');

    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    await waitFor(() => {
      expect(screen.queryByLabelText('Generated STUDIO_AUTH_SECRET'))
        .not.toBeInTheDocument();
    });
  });

  it('shows both independent Worker secret requirements before initial installation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockStatus(statusResponse({
      siteMode: 'initial',
      database: {
        state: 'uninstalled',
        target_schema_version: 1,
      },
      access: {
        state: 'blocked',
        reason: 'AUTH_SECRET_NOT_CONFIGURED',
      },
      installationConfiguration: {
        site_mode: 'initial',
        auth_secret: 'missing',
        install_token: 'missing',
      },
    }));

    render(<App />);

    expect(await screen.findByText('Complete the installation setup'))
      .toBeInTheDocument();
    expect(screen.getByRole('region', {
      name: 'Installation Worker settings',
    })).toBeInTheDocument();
    expect(screen.getByText(/remaining Worker setting/))
      .toBeInTheDocument();
    const storageGuidance = screen.getByText(
      /unique value for each Secret/,
    );
    const guide = within(storageGuidance).getByRole('link', {
      name: 'Open setup guide',
    });
    expect(storageGuidance).toHaveClass('auth-secret-storage-guidance');
    expect(guide).toHaveClass('auth-secret-guide-link');
    expect(guide).not.toHaveClass('studio-button');
    expect(guide).toHaveAttribute('target', '_blank');
    expect(guide.querySelector('.lucide-external-link'))
      .not.toBeInTheDocument();
    const siteMode = screen.getByRole('region', { name: 'STUDIO_SITE_MODE' });
    expect(within(siteMode).getByText('Configured')).toBeInTheDocument();
    expect(within(siteMode).getByText('Plain variable')).toBeInTheDocument();
    expect(within(siteMode).getByText(/initial installation mode is active/))
      .toBeInTheDocument();

    const authSecret = screen.getByRole('region', {
      name: 'STUDIO_AUTH_SECRET',
    });
    const installToken = screen.getByRole('region', {
      name: 'STUDIO_INSTALL_TOKEN',
    });
    expect(within(authSecret).getByText('Not set')).toBeInTheDocument();
    expect(within(authSecret).getByText('Secret')).toBeInTheDocument();
    expect(within(installToken).getByText('Not set')).toBeInTheDocument();
    expect(within(installToken).getByText('Secret')).toBeInTheDocument();

    const generateAuthSecret = within(authSecret).getByRole('button', {
      name: 'Generate STUDIO_AUTH_SECRET',
    });
    const generateInstallToken = within(installToken).getByRole('button', {
      name: 'Generate STUDIO_INSTALL_TOKEN',
    });
    expect(generateAuthSecret.querySelector('.lucide-key-round'))
      .toBeInTheDocument();
    expect(generateInstallToken.querySelector('.lucide-key-round'))
      .toBeInTheDocument();
    await userEvent.click(generateAuthSecret);
    await userEvent.click(generateInstallToken);

    const authValue = within(authSecret).getByLabelText<HTMLInputElement>(
      'Generated STUDIO_AUTH_SECRET',
    ).value;
    const installValue = within(installToken).getByLabelText<HTMLInputElement>(
      'Generated STUDIO_INSTALL_TOKEN',
    ).value;
    expect(authValue).toMatch(/^[0-9a-f]{64}$/u);
    expect(installValue).toMatch(/^[0-9a-f]{64}$/u);
    expect(authValue).not.toBe(installValue);
    expect(fetch).toHaveBeenCalledOnce();
    expect(within(authSecret).queryByText(
      /Keep this value in a safe place until installation is complete/,
    )).not.toBeInTheDocument();
    const installTokenRetention = within(installToken).getByText(
      /Keep this value in a safe place until installation is complete/,
    );
    expect(installTokenRetention).toHaveClass('auth-secret-retention-note');
    expect(installTokenRetention.querySelector('.lucide-clock-3'))
      .toBeInTheDocument();
    const copyAuthSecret = within(authSecret).getByRole('button', {
      name: 'Copy value',
    });
    expect(copyAuthSecret.querySelector('.lucide-copy')).toBeInTheDocument();
    await userEvent.click(copyAuthSecret);
    await waitFor(() => {
      expect(screen.getByText('The generated STUDIO_AUTH_SECRET value was copied.')).toBeVisible();
    });

    const copyInstallToken = within(installToken).getByRole('button', {
      name: 'Copy value',
    });
    await userEvent.click(copyInstallToken);
    expect(writeText).toHaveBeenLastCalledWith(installValue);
    await waitFor(() => {
      expect(screen.getByText(
        'STUDIO_INSTALL_TOKEN copied. Keep it safe until installation is complete.',
      )).toBeVisible();
    });
  });

  it('keeps a valid auth secret visible while helping configure the temporary install token', async () => {
    mockStatus(statusResponse({
      siteMode: 'initial',
      database: {
        state: 'uninstalled',
        target_schema_version: 1,
      },
      access: {
        state: 'blocked',
        reason: 'INSTALL_TOKEN_NOT_CONFIGURED',
      },
      installationConfiguration: {
        site_mode: 'initial',
        auth_secret: 'valid',
        install_token: 'invalid',
      },
    }));

    render(<App />);

    const authSecret = await screen.findByRole('region', {
      name: 'STUDIO_AUTH_SECRET',
    });
    expect(document.querySelector('.standalone-status'))
      .toHaveClass('standalone-status-wide');
    const installToken = screen.getByRole('region', {
      name: 'STUDIO_INSTALL_TOKEN',
    });
    expect(within(authSecret).getByText('Configured')).toBeInTheDocument();
    expect(authSecret).toHaveClass('auth-secret-requirement-compact');
    expect(within(authSecret).getByText(
      'Protects MFA data and stored service credentials.',
    )).toBeInTheDocument();
    expect(within(authSecret).queryByRole('button')).not.toBeInTheDocument();
    expect(within(installToken).getByText('Invalid')).toBeInTheDocument();
    expect(installToken).not.toHaveClass('auth-secret-requirement-compact');
    expect(within(installToken).getByRole('button', {
      name: 'Generate STUDIO_INSTALL_TOKEN',
    })).toBeInTheDocument();
    expect(within(installToken).getByRole('button', {
      name: 'Generate STUDIO_INSTALL_TOKEN',
    })).toHaveTextContent('Generate value');
    expect(within(installToken).getByText(
      'Used to access the Studio installer.',
    ))
      .toBeInTheDocument();
  });

  it('uses a wide frame for a standalone install token requirement', async () => {
    mockStatus(statusResponse({
      siteMode: 'initial',
      access: {
        state: 'blocked',
        reason: 'INSTALL_TOKEN_NOT_CONFIGURED',
      },
    }));

    render(<App />);

    expect(await screen.findByText('Installation is not authorized'))
      .toBeInTheDocument();
    expect(document.querySelector('.standalone-status'))
      .toHaveClass('standalone-status-wide');
    expect(screen.getByText('STUDIO_INSTALL_TOKEN')).toBeInTheDocument();
  });

  it('does not promise an operational log for a transient database update state', async () => {
    mockStatus(statusResponse({
      siteMode: 'operational',
      database: {
        state: 'update_in_progress',
        schema_version: 10,
        target_schema_version: 11,
      },
      access: {
        state: 'blocked',
        reason: 'DATABASE_SCHEMA_STATE_INVALID',
      },
    }));

    render(<App />);

    expect(await screen.findByText('The database needs recovery'))
      .toBeInTheDocument();
    expect(screen.getByText(/supported lifecycle recovery flow/))
      .toBeInTheDocument();
    expect(screen.queryByText(/matching Worker operational log/))
      .not.toBeInTheDocument();
  });

  it('shows the bounded maintenance journey when a database upgrade is required', async () => {
    mockStatus(statusResponse({
      siteMode: 'operational',
      database: {
        state: 'upgrade_required',
        schema_version: 1,
        target_schema_version: 2,
      },
      access: {
        state: 'blocked',
        reason: 'DATABASE_UPGRADE_REQUIRED',
      },
    }));

    render(<App />);

    expect(await screen.findByText('Update the Studio database'))
      .toBeInTheDocument();
    expect(document.querySelector('.standalone-status'))
      .toHaveClass('standalone-status-wide');
    expect(screen.getByText(
      /This database was created by an earlier Studio version/,
    )).toBeInTheDocument();
    const schemaStatus = screen.getByRole('region', {
      name: 'Database schema',
    });
    expect(within(schemaStatus).getByText('Version 1 → 2'))
      .toBeInTheDocument();
    expect(within(schemaStatus).getByText('Update required'))
      .toHaveClass('studio-pill-attention');
    expect(screen.getByText('Switch to maintenance mode'))
      .toBeInTheDocument();
    expect(screen.getByText(
      'Set STUDIO_SITE_MODE to maintenance and redeploy the Worker.',
    )).toBeInTheDocument();
    expect(screen.getByText('Back up and update')).toBeInTheDocument();
    expect(screen.getByText(/create and keep a Studio database backup/))
      .toBeInTheDocument();
    expect(screen.getByText(/Restore access in recovery mode/))
      .toBeInTheDocument();
    expect(screen.queryByText(/matching Worker operational log/))
      .not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Check status again',
    }).querySelector('.lucide-refresh-cw')).toBeInTheDocument();
    expect(screen.queryByRole('link', {
      name: 'Open Maintenance & Recovery',
    })).not.toBeInTheDocument();
  });

  it('compares Worker and database versions and refreshes them after deployment', async () => {
    vi.useFakeTimers();
    const newerDatabase = (studioVersion: string, targetVersion: number) => (
      statusResponse({
        studioVersion,
        siteMode: 'operational',
        database: {
          state: 'newer_than_code',
          schema_version: 13,
          target_schema_version: targetVersion,
        },
        access: { state: 'blocked', reason: 'DATABASE_NEWER_THAN_CODE' },
      })
    );
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(newerDatabase('0.6.9', 11)))
      .mockResolvedValueOnce(jsonResponse(newerDatabase('0.6.10', 12)));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => { render(<App />); });

    const comparison = screen.getByRole('region', {
      name: 'Version comparison',
    });
    for (const [label, value] of [
      ['Studio version (Worker)', '0.6.9'],
      ['Database schema', '13'],
      ['Worker supports schema', '11'],
    ]) {
      expect(within(comparison).getByText(label).nextElementSibling)
        .toHaveTextContent(value);
    }
    expect(screen.getByText(/Worker’s DB binding/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check after deployment' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INITIAL_CHECKING_MIN_VISIBLE_MS);
    });

    const refreshed = screen.getByRole('region', { name: 'Version comparison' });
    expect(within(refreshed).getByText('Studio version (Worker)').nextElementSibling)
      .toHaveTextContent('0.6.10');
    expect(within(refreshed).getByText('Worker supports schema').nextElementSibling)
      .toHaveTextContent('12');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps schema guidance usable when an older Worker cannot report its release', async () => {
    mockStatus(statusResponse({
      siteMode: 'operational',
      database: {
        state: 'newer_than_code',
        schema_version: 13,
        target_schema_version: 11,
      },
      access: { state: 'blocked', reason: 'DATABASE_NEWER_THAN_CODE' },
    }));

    render(<App />);

    const comparison = await screen.findByRole('region', { name: 'Version comparison' });
    expect(within(comparison).getByText('Studio version (Worker)').nextElementSibling)
      .toHaveTextContent('Not reported');
    expect(within(comparison).getByText('Database schema').nextElementSibling)
      .toHaveTextContent('13');
    expect(within(comparison).getByText('Worker supports schema').nextElementSibling)
      .toHaveTextContent('11');
    expect(screen.getByRole('button', { name: 'Check after deployment' }))
      .toBeEnabled();
  });

  it('explains limited recovery access and prioritizes the protected operations route', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'recovery',
        access: { state: 'recovery' },
        operations: 'available',
      }))));
    render(<App />);

    expect(await screen.findByText('Studio access is limited during recovery'))
      .toBeInTheDocument();
    expect(screen.getByText('RECOVERY MODE')).toBeInTheDocument();
    const operationsLink = await screen.findByRole('link', {
      name: 'Open Maintenance & Recovery',
    });
    const retryButton = screen.getByRole('button', {
      name: 'Check recovery status',
    });
    expect(operationsLink).toHaveAttribute('href', '/system/operations');
    expect(operationsLink).not.toHaveAttribute('target');
    expect(operationsLink).toHaveClass('studio-button-primary');
    expect(operationsLink).toHaveClass('studio-button-block');
    expect(retryButton).toHaveClass('studio-button-secondary');
    expect(retryButton).toHaveClass('studio-button-block');
    expect(operationsLink.querySelector('.lucide-wrench')).toBeInTheDocument();
    expect(retryButton.querySelector('.lucide-refresh-cw')).toBeInTheDocument();
    expect(document.querySelector('.standalone-status-icon'))
      .not.toBeInTheDocument();
    expect(
      operationsLink.compareDocumentPosition(retryButton)
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText(/Normal sign-in is paused/))
      .toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: /Use (?:dark|light) appearance/,
    })).toBeInTheDocument();
  });

  it('keeps maintenance details and its entry point hidden outside the operations boundary', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'maintenance',
        access: { state: 'maintenance' },
        operations: 'not_found',
      })));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByText('Maintenance is in progress. Try again later.'))
      .toBeInTheDocument();
    expect(screen.queryByText(/Planned lifecycle work is in progress/))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('link', {
      name: 'Open Maintenance & Recovery',
    })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not expose recovery operations when their availability cannot be verified', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'recovery',
        access: { state: 'recovery' },
        operations: 'setup_required',
      }))));

    render(<App />);

    expect(await screen.findByText(/Recovery work is in progress/))
      .toHaveTextContent(/normal Studio access has been restored/);
    expect(screen.getByRole('button', {
      name: 'Check recovery status',
    }))
      .toBeInTheDocument();
    expect(screen.queryByText(/Normal sign-in is paused/))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('link', {
      name: 'Open Maintenance & Recovery',
    })).not.toBeInTheDocument();
  });

  it('shows installation guidance without a dead operations link for an empty database', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'recovery',
        database: {
          state: 'uninstalled',
          target_schema_version: 13,
        },
        access: { state: 'recovery' },
        operations: 'not_found',
      }))));

    render(<App />);

    expect(await screen.findByText('Complete the installation setup'))
      .toBeInTheDocument();
    const requirements = screen.getByRole('region', {
      name: 'Installation Worker settings',
    });
    const siteMode = within(requirements).getByRole('region', {
      name: 'STUDIO_SITE_MODE',
    });
    expect(within(siteMode).getByText('Change required'))
      .toBeInTheDocument();
    const installToken = within(requirements).getByRole('region', {
      name: 'STUDIO_INSTALL_TOKEN',
    });
    expect(within(installToken).getByText('Check required'))
      .toBeInTheDocument();
    expect(within(requirements).queryByRole('region', {
      name: 'STUDIO_AUTH_SECRET',
    })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', {
      name: 'Open Maintenance & Recovery',
    })).not.toBeInTheDocument();
    expect(screen.queryByText(/matching Worker operational log/))
      .not.toBeInTheDocument();
  });

  it('keeps recovery available for an allowed operator with an empty database', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'recovery',
        database: {
          state: 'uninstalled',
          target_schema_version: 13,
        },
        access: { state: 'recovery' },
        operations: 'available',
      }))));

    render(<App />);

    expect(await screen.findByRole('link', {
      name: 'Open Maintenance & Recovery',
    })).toHaveAttribute('href', '/system/operations');
    expect(screen.getByText(/Normal sign-in is paused/))
      .toBeInTheDocument();
    expect(screen.queryByText('Studio is not installed'))
      .not.toBeInTheDocument();
  });

  it('shows a safe blocked state without rendering raw server details', async () => {
    mockStatus(statusResponse({
      siteMode: null,
      access: {
        state: 'blocked',
        reason: 'SITE_MODE_MISSING',
      },
    }));

    render(<App />);

    expect(await screen.findByText('Set the Studio site mode'))
      .toBeInTheDocument();
    expect(document.querySelector('.standalone-status'))
      .toHaveClass('standalone-status-wide');
    expect(screen.getByText(/then redeploy the Worker/)).toBeInTheDocument();
    const siteMode = screen.getByRole('region', { name: 'STUDIO_SITE_MODE' });
    expect(within(siteMode).getByText('Not set'))
      .toHaveClass('studio-pill-attention');
    expect(siteMode).toHaveClass('auth-secret-requirement-compact');
    expect(screen.queryByText(/matching Worker operational log/))
      .not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Check configuration again',
    }).querySelector('.lucide-refresh-cw')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('distinguishes an invalid site mode from a missing setting', async () => {
    mockStatus(statusResponse({
      siteMode: null,
      access: {
        state: 'blocked',
        reason: 'SITE_MODE_INVALID',
      },
    }));

    render(<App />);

    expect(await screen.findByText('Correct the Studio site mode'))
      .toBeInTheDocument();
    expect(document.querySelector('.standalone-status'))
      .toHaveClass('standalone-status-wide');
    expect(screen.getByText(/Use initial, operational/)).toHaveTextContent(
      /then redeploy the Worker/,
    );
    const siteMode = screen.getByRole('region', { name: 'STUDIO_SITE_MODE' });
    expect(within(siteMode).getByText('Invalid'))
      .toHaveClass('studio-pill-critical');
    expect(within(siteMode).queryByText('Not set')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Check configuration again',
    }).querySelector('.lucide-refresh-cw')).toBeInTheDocument();
  });

  it('recovers from a malformed response through the retry action', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify(statusResponse({
        siteMode: 'operational',
        access: { state: 'operational' },
      }))))
      .mockResolvedValueOnce(interfaceConfigResponse())
      .mockResolvedValueOnce(anonymousSessionResponse());
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByText('Studio cannot start')).toBeInTheDocument();

    await userEvent.setup().click(
      screen.getByRole('button', { name: 'Check again' }),
    );

    expect(await screen.findByLabelText(
      'Email',
      {},
      { timeout: INITIAL_CHECKING_MIN_VISIBLE_MS + 500 },
    )).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('moves from password and MFA authentication into the Dashboard', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'operational',
        access: { state: 'operational' },
      })))
      .mockResolvedValueOnce(interfaceConfigResponse())
      .mockResolvedValueOnce(anonymousSessionResponse())
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          status: 'mfa_required',
          continuation_token: 'c'.repeat(64),
          expires_at_iso: '2026-07-31T00:05:00.000Z',
          available_methods: ['totp'],
          preferred_method: 'totp',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          status: 'authenticated',
        },
      }))
      .mockResolvedValueOnce(jsonResponse(authenticatedSessionResponse()))
      .mockResolvedValueOnce(jsonResponse(dashboardSummaryResponse()))
      .mockResolvedValueOnce(jsonResponse(cloudflareAccessSettingsResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'password');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(await screen.findByLabelText('Six-digit code'), '123456');
    await user.click(screen.getByRole('button', {
      name: 'Verify and sign in',
    }));

    expect(await screen.findByRole('heading', { name: 'Dashboard' }))
      .toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/system/status',
      '/api/system/interface-config',
      '/api/auth/session',
      '/api/auth/login',
      '/api/auth/mfa/verify',
      '/api/auth/session',
      '/api/dashboard/summary',
      '/api/settings/access',
    ]);
  });

  it('restores an authenticated session and signs out through confirmation', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'operational',
        access: { state: 'operational' },
      })))
      .mockResolvedValueOnce(interfaceConfigResponse())
      .mockResolvedValueOnce(jsonResponse(authenticatedSessionResponse()))
      .mockResolvedValueOnce(jsonResponse(dashboardSummaryResponse()))
      .mockResolvedValueOnce(jsonResponse(cloudflareAccessSettingsResponse()))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { status: 'logged_out' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Dashboard' }))
      .toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Studio Owner' }))
      .not.toBeInTheDocument();
    expect(screen.queryByText('owner@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('2001:db8::10')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', {
      name: 'Open account menu for Studio Owner',
    }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Sign out of Studio?',
    });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Stay signed in' }))
      .toHaveFocus();
    await user.click(within(dialog).getByRole('button', {
      name: 'Sign out',
    }));

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[5]?.[0]).toBe('/api/auth/logout');
    expect(fetchMock.mock.calls[5]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-ZeroPress-CSRF': 'c'.repeat(43),
      },
      body: '{}',
    });
  });

  it('locks the mounted application when the local session deadline passes', async () => {
    const expired = authenticatedSessionResponse();
    expired.data.session.idle_expires_at_iso = '2000-01-01T00:00:00.000Z';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'operational',
        access: { state: 'operational' },
      })))
      .mockResolvedValueOnce(interfaceConfigResponse())
      .mockResolvedValueOnce(jsonResponse(expired))
      .mockResolvedValueOnce(jsonResponse(dashboardSummaryResponse()));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const dialog = await screen.findByRole('dialog', {
      name: 'Sign in to continue',
    });
    expect(within(dialog).getByLabelText('Password')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', {
      name: 'Discard this workspace',
    })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  it('navigates to Account Security without reloading authentication', async () => {
    const fetchMock = vi.fn((path: string) => {
      if (path === '/api/system/status') {
        return Promise.resolve(jsonResponse(statusResponse({
          siteMode: 'operational',
          access: { state: 'operational' },
        })));
      }
      if (path === '/api/system/interface-config') {
        return Promise.resolve(interfaceConfigResponse());
      }
      if (path === '/api/auth/session') {
        return Promise.resolve(jsonResponse(authenticatedSessionResponse()));
      }
      if (path === '/api/auth/sessions') {
        return Promise.resolve(jsonResponse(activeSessionsResponse()));
      }
      if (path === '/api/dashboard/summary') {
        return Promise.resolve(jsonResponse(dashboardSummaryResponse()));
      }
      if (path === '/api/settings/access') {
        return Promise.resolve(jsonResponse(cloudflareAccessSettingsResponse()));
      }
      return Promise.resolve(jsonResponse(mfaManagementStatusResponse()));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Dashboard' }))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Open account menu for Studio Owner',
    }));
    await user.click(screen.getByRole('link', {
      name: 'Account security',
    }));

    expect(await screen.findByRole('heading', {
      name: 'Account security',
    })).toBeInTheDocument();
    expect(await screen.findByText('Current session')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/my-account/security');
    expect(fetchMock.mock.calls.map(([path]) => path).slice(0, 2)).toEqual([
      '/api/system/status',
      '/api/system/interface-config',
    ]);
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(
      expect.arrayContaining([
        '/api/auth/sessions',
        '/api/auth/mfa/management/status',
      ]),
    );

    await user.click(screen.getByRole('link', { name: 'Dashboard' }));
    expect(screen.getByRole('heading', { name: 'Dashboard' }))
      .toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it('opens browser-local Studio preferences without loading site settings', async () => {
    const fetchMock = vi.fn((path: string) => {
      if (path === '/api/system/status') {
        return Promise.resolve(jsonResponse(statusResponse({
          siteMode: 'operational',
          access: { state: 'operational' },
        })));
      }
      if (path === '/api/system/interface-config') {
        return Promise.resolve(interfaceConfigResponse());
      }
      if (path === '/api/auth/session') {
        return Promise.resolve(jsonResponse(authenticatedSessionResponse()));
      }
      return Promise.resolve(jsonResponse(dashboardSummaryResponse()));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Dashboard' }))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Open account menu for Studio Owner',
    }));
    await user.click(screen.getByRole('link', {
      name: 'Studio preferences',
    }));

    expect(await screen.findByRole('heading', {
      name: 'Studio preferences',
    })).toBeInTheDocument();
    expect(screen.getByRole('combobox', {
      name: 'Studio interface language',
    })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/my-account/preferences');
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/system/status',
      '/api/system/interface-config',
      '/api/auth/session',
      '/api/dashboard/summary',
      '/api/settings/access',
    ]);
  });

  it('restores a direct Account Security route after session bootstrap', async () => {
    window.history.replaceState(null, '', '/my-account/security');
    const fetchMock = vi.fn((path: string) => {
      if (path === '/api/system/status') {
        return Promise.resolve(jsonResponse(statusResponse({
          siteMode: 'operational',
          access: { state: 'operational' },
        })));
      }
      if (path === '/api/system/interface-config') {
        return Promise.resolve(interfaceConfigResponse());
      }
      if (path === '/api/auth/session') {
        return Promise.resolve(jsonResponse(authenticatedSessionResponse()));
      }
      if (path === '/api/auth/sessions') {
        return Promise.resolve(jsonResponse(activeSessionsResponse()));
      }
      return Promise.resolve(jsonResponse(mfaManagementStatusResponse()));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('heading', {
      name: 'Account security',
    })).toBeInTheDocument();
    expect(await screen.findByText('Current session')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' }))
      .not.toBeInTheDocument();
  });

  it('restores a direct MFA management route inside the application shell', async () => {
    window.history.replaceState(
      null,
      '',
      '/my-account/security/mfa/replace',
    );
    const fetchMock = vi.fn((path: string) => {
      if (path === '/api/system/status') {
        return Promise.resolve(jsonResponse(statusResponse({
          siteMode: 'operational',
          access: { state: 'operational' },
        })));
      }
      if (path === '/api/system/interface-config') {
        return Promise.resolve(interfaceConfigResponse());
      }
      if (path === '/api/auth/session') {
        return Promise.resolve(jsonResponse(authenticatedSessionResponse()));
      }
      return Promise.resolve(jsonResponse(mfaManagementStatusResponse()));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('heading', {
      name: 'Replace authenticator',
    })).toBeInTheDocument();
    expect(await screen.findByLabelText('Current password'))
      .toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/system/status',
      '/api/system/interface-config',
      '/api/auth/session',
      '/api/auth/mfa/management/status',
    ]);
  });

  it('reauthenticates in place and preserves unsaved form state', async () => {
    window.history.replaceState(null, '', '/settings/site/general');
    let sessionRequests = 0;
    let settingsWrites = 0;
    const settingsDocument = {
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
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === '/api/system/status') {
        return Promise.resolve(jsonResponse(statusResponse({
          siteMode: 'operational',
          access: { state: 'operational' },
        })));
      }
      if (path === '/api/system/interface-config') {
        return Promise.resolve(interfaceConfigResponse());
      }
      if (path === '/api/auth/session') {
        sessionRequests += 1;
        const payload = authenticatedSessionResponse();
        if (sessionRequests === 2) {
          payload.data.session.id = 'a'.repeat(32);
          payload.data.csrf_token = 'd'.repeat(43);
        }
        return Promise.resolve(jsonResponse(payload));
      }
      if (path === '/api/settings/general' && init?.method === 'GET') {
        return Promise.resolve(jsonResponse({
          success: true,
          data: settingsDocument,
        }));
      }
      if (path === '/api/settings/general' && init?.method === 'PUT') {
        settingsWrites += 1;
        if (settingsWrites === 1) {
          return Promise.resolve(anonymousSessionResponse());
        }
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            settings: { ...settingsDocument.settings, title: 'Draft title' },
            revision: '1'.repeat(32),
            updated_at_iso: '2026-08-09T12:00:00.000Z',
          },
        }));
      }
      if (path === '/api/auth/login') {
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            status: 'mfa_required',
            continuation_token: 'c'.repeat(64),
            expires_at_iso: '2099-08-09T12:05:00.000Z',
            available_methods: ['totp'],
            preferred_method: 'totp',
          },
        }));
      }
      if (path === '/api/auth/mfa/verify') {
        return Promise.resolve(jsonResponse({
          success: true,
          data: {
            status: 'authenticated',
          },
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    const title = await screen.findByRole('textbox', { name: 'Site title' });
    await user.clear(title);
    await user.type(title, 'Draft title');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Sign in to continue',
    });
    expect(window.location.pathname).toBe('/settings/site/general');
    expect(screen.getByDisplayValue('Draft title'))
      .toHaveValue('Draft title');
    expect(within(dialog).queryByLabelText('Email')).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Password'), 'password');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.type(
      await within(dialog).findByLabelText('Six-digit code'),
      '123456',
    );
    await user.click(within(dialog).getByRole('button', {
      name: 'Verify and sign in',
    }));

    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: 'Sign in to continue',
    })).not.toBeInTheDocument());
    expect(window.location.pathname).toBe('/settings/site/general');
    expect(screen.getByRole('textbox', { name: 'Site title' }))
      .toHaveValue('Draft title');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(settingsWrites).toBe(2));
    const lastWrite = fetchMock.mock.calls
      .filter(([path, init]) => (
        path === '/api/settings/general' && init?.method === 'PUT'
      ))
      .at(-1);
    expect(lastWrite?.[1]?.headers).toMatchObject({
      'X-ZeroPress-CSRF': 'd'.repeat(43),
    });
  });

  it('does not attach preserved state to a different authenticated user', async () => {
    const differentUser = authenticatedSessionResponse();
    differentUser.data.user.id = '9'.repeat(32);
    differentUser.data.user.email = 'other@example.com';
    differentUser.data.csrf_token = 'e'.repeat(43);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'operational',
        access: { state: 'operational' },
      })))
      .mockResolvedValueOnce(interfaceConfigResponse())
      .mockResolvedValueOnce(jsonResponse(authenticatedSessionResponse()))
      .mockResolvedValueOnce(anonymousSessionResponse())
      .mockResolvedValueOnce(jsonResponse(cloudflareAccessSettingsResponse()))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          status: 'mfa_required',
          continuation_token: 'c'.repeat(64),
          expires_at_iso: '2099-08-09T12:05:00.000Z',
          available_methods: ['totp'],
          preferred_method: 'totp',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          status: 'authenticated',
        },
      }))
      .mockResolvedValueOnce(jsonResponse(differentUser))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: { status: 'logged_out' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(<App />);
    const dialog = await screen.findByRole('dialog', {
      name: 'Sign in to continue',
    });
    await user.type(within(dialog).getByLabelText('Password'), 'password');
    await user.click(within(dialog).getByRole('button', { name: 'Continue' }));
    await user.type(
      await within(dialog).findByLabelText('Six-digit code'),
      '123456',
    );
    await user.click(within(dialog).getByRole('button', {
      name: 'Verify and sign in',
    }));

    expect(await screen.findByText(/You signed in with a different account/))
      .toBeInTheDocument();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/auth/logout');
    expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({
      headers: expect.objectContaining({
        'X-ZeroPress-CSRF': 'e'.repeat(43),
      }),
    });
  });

  it('renders an authenticated not-found route instead of falling back to Dashboard', async () => {
    window.history.replaceState(null, '', '/not-a-studio-route');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(statusResponse({
        siteMode: 'operational',
        access: { state: 'operational' },
      })))
      .mockResolvedValueOnce(interfaceConfigResponse())
      .mockResolvedValueOnce(jsonResponse(authenticatedSessionResponse()));
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    expect(await screen.findByRole('heading', {
      name: 'Page not found',
    })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Dashboard' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Return to Dashboard' }))
      .toHaveAttribute('href', '/');
  });
});

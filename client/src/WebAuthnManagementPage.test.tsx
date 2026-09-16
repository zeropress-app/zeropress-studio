// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { changeLocale } from './i18n';
import { WebAuthnManagementPage } from './WebAuthnManagementPage';

const webAuthnMocks = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: () => true,
  startAuthentication: webAuthnMocks.startAuthentication,
  startRegistration: webAuthnMocks.startRegistration,
}));

vi.mock('./lib/passkey-authenticator-names.json', () => ({
  names: {
    '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Example Passkey Provider',
  },
}));

const csrfToken = 'c'.repeat(43);
const managementToken = 'm'.repeat(64);

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function statusResponse(credentials: unknown[] = []) {
  return response({
    success: true,
    data: {
      totp: {
        configured_at_iso: '2026-07-30T12:00:00.000Z',
      },
      webauthn: {
        current_rp_id: 'localhost',
        max_credentials: 10,
        credentials,
      },
      step_up: { mfa_required: false, freshness_seconds: 300 },
    },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  webAuthnMocks.startAuthentication.mockReset();
  webAuthnMocks.startRegistration.mockReset();
  await changeLocale('en');
});

describe('WebAuthnManagementPage', () => {
  it.each([
    { locale: 'en' as const, label: 'Authenticator: Example Passkey Provider', prefix: /^Authenticator:/u },
    { locale: 'ko' as const, label: '인증기: Example Passkey Provider', prefix: /^인증기:/u },
  ])('shows available authenticator names alongside user labels in $locale', async ({ locale, label, prefix }) => {
    await changeLocale(locale);
    const credentials = [
      { display_name: 'Laptop passkey', aaguid: '08987058-CADC-4B81-B6E1-30DE50DCBE96' },
      { display_name: 'Security key', aaguid: '11111111-2222-3333-4444-555555555555' },
      { display_name: 'Older passkey', aaguid: null },
    ].map((credential, index) => ({
      ...credential,
      id: String(index + 1).repeat(32),
      rp_id: 'localhost',
      transports: ['internal'],
      credential_device_type: 'multiDevice',
      backed_up: true,
      attestation_format: 'none',
      created_at_iso: '2026-07-31T12:00:00.000Z',
      last_used_at_iso: null,
    }));
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => statusResponse(credentials)));

    render(
      <MemoryRouter>
        <WebAuthnManagementPage data={{ csrf_token: csrfToken }} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );

    const namedCard = (await screen.findByRole('heading', { name: 'Laptop passkey' })).closest('article')!;
    expect(within(namedCard).getByText(label)).toBeVisible();
    for (const credential of credentials.slice(1)) {
      const card = screen.getByRole('heading', { name: credential.display_name }).closest('article')!;
      expect(within(card).queryByText(prefix)).not.toBeInTheDocument();
      if (credential.aaguid) expect(within(card).getByText(credential.aaguid)).toBeVisible();
    }
  });

  it('registers a named credential through an explicit browser ceremony', async () => {
    const registration = {
      id: 'credential',
      rawId: 'credential',
      response: {
        clientDataJSON: 'client',
        attestationObject: 'attestation',
        transports: ['internal'],
      },
      clientExtensionResults: {},
      type: 'public-key',
    };
    const registeredCredential = {
      id: 'a'.repeat(32),
      display_name: 'MacBook Touch ID',
      rp_id: 'localhost',
      transports: ['internal'],
      credential_device_type: 'multiDevice',
      backed_up: true,
      attestation_format: 'packed',
      aaguid: '08987058-cadc-4b81-b6e1-30de50dcbe96',
      created_at_iso: '2026-07-31T12:00:00.000Z',
      last_used_at_iso: null,
    };
    webAuthnMocks.startRegistration.mockResolvedValue(registration);
    const fetchMock = vi.fn((path: string, _init?: RequestInit) => {
      if (path.endsWith('/status')) {
        const loadedAfterRegistration = fetchMock.mock.calls.filter(
          ([calledPath]) => String(calledPath).endsWith('/status'),
        ).length > 1;
        return Promise.resolve(statusResponse(
          loadedAfterRegistration ? [registeredCredential] : [],
        ));
      }
      if (path.endsWith('/authorize')) {
        return Promise.resolve(response({
          success: true,
          data: {
            status: 'authorized',
            operation: 'add_webauthn',
            management_token: managementToken,
            expires_at_iso: '2026-07-31T12:05:00.000Z',
          },
        }));
      }
      if (path.endsWith('/registration/options')) {
        return Promise.resolve(response({
          success: true,
          data: {
            options: {
              challenge: 'challenge',
              rp: { id: 'localhost', name: 'ZeroPress Studio' },
              user: {
                id: 'dXNlcg',
                name: 'owner@example.com',
                displayName: 'Studio Owner',
              },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
              authenticatorSelection: {
                residentKey: 'required',
                userVerification: 'required',
              },
            },
            challenge_token: 'b'.repeat(32),
            expires_at_iso: '2026-07-31T12:05:00.000Z',
          },
        }));
      }
      if (path.endsWith('/registration/complete')) {
        return Promise.resolve(response({
          success: true,
          data: {
            status: 'webauthn_registered',
            credential: registeredCredential,
          },
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <WebAuthnManagementPage
          data={{ csrf_token: csrfToken }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole(
      'button',
      { name: 'Add passkey' },
    ));
    await user.type(
      screen.getByLabelText('Credential name'),
      'MacBook Touch ID',
    );
    await user.type(
      screen.getByLabelText('Current password'),
      'current password',
    );
    await user.click(screen.getByRole(
      'button',
      { name: 'Register passkey' },
    ));

    expect(await screen.findByText('Passkey registered'))
      .toBeInTheDocument();
    expect(screen.getByText('packed')).toBeInTheDocument();
    expect(screen.getByText('Authenticator: Example Passkey Provider')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'MacBook Touch ID' })).toBeVisible();
    expect(screen.getByText(
      '08987058-cadc-4b81-b6e1-30de50dcbe96',
    )).toBeInTheDocument();
    expect(webAuthnMocks.startRegistration).toHaveBeenCalledWith({
      optionsJSON: expect.objectContaining({
        authenticatorSelection: expect.objectContaining({
          userVerification: 'required',
        }),
      }),
    });
    const completeCall = fetchMock.mock.calls.find(
      ([path]) => String(path).endsWith('/registration/complete'),
    );
    expect(JSON.parse(String(completeCall?.[1]?.body))).toMatchObject({
      display_name: 'MacBook Touch ID',
      response: registration,
    });
  });

  it('renames a credential without password or MFA re-authentication', async () => {
    const credential = {
      id: 'a'.repeat(32),
      display_name: 'MacBook Touch ID',
      rp_id: 'localhost',
      transports: ['internal'],
      credential_device_type: 'multiDevice',
      backed_up: true,
      attestation_format: 'packed',
      aaguid: null,
      created_at_iso: '2026-07-31T12:00:00.000Z',
      last_used_at_iso: null,
    };
    const renamedCredential = {
      ...credential,
      display_name: 'Desk passkey',
    };
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path.endsWith('/status')) {
        const renamed = fetchMock.mock.calls.some(
          ([calledPath]) => String(calledPath).endsWith('/rename'),
        );
        return Promise.resolve(statusResponse([
          renamed ? renamedCredential : credential,
        ]));
      }
      if (path.endsWith('/rename')) {
        return Promise.resolve(response({
          success: true,
          data: {
            status: 'webauthn_renamed',
            credential: renamedCredential,
          },
        }));
      }
      throw new Error(`Unexpected request: ${path} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <WebAuthnManagementPage
          data={{ csrf_token: csrfToken }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole(
      'button',
      { name: 'Rename' },
    ));
    const nameInput = screen.getByLabelText('Credential name');
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();
    await user.clear(nameInput);
    await user.type(nameInput, 'Desk passkey');
    await user.click(screen.getByRole('button', { name: 'Save name' }));

    expect(await screen.findByText('Credential renamed'))
      .toBeInTheDocument();
    const renameCall = fetchMock.mock.calls.find(
      ([path]) => String(path).endsWith('/rename'),
    );
    expect(JSON.parse(String(renameCall?.[1]?.body))).toEqual({
      credential_id: credential.id,
      display_name: 'Desk passkey',
    });
    expect(fetchMock.mock.calls.some(
      ([path]) => String(path).endsWith('/authorize'),
    )).toBe(false);
  });
});

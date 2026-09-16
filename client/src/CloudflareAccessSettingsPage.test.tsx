// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { CloudflareAccessManager } from './CloudflareAccessSettingsPage';
import { changeLocale, ensureNamespaces } from './i18n';

const operationsToken = 'operations-token-value-000000000000';

const identity = {
  issuer: 'https://zeropress.cloudflareaccess.com',
  team_domain: 'zeropress',
  audience: 'a'.repeat(64),
  identity_email: 'owner@example.com',
};

const disabledDocument = {
  settings: {
    mode: 'disabled' as const,
    issuer: null,
    audience: null,
    bound_origin: null,
    verified_at_iso: null,
  },
  revision: '1'.repeat(32),
  updated_at_iso: '2026-08-28T00:00:00.000Z',
  detection_state: 'verified' as const,
  detected: identity,
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderPage(onSessionEnded = vi.fn()) {
  return render(
    <MemoryRouter>
      <CloudflareAccessManager
        token={operationsToken}
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
  await ensureNamespaces(['accessSettings']);
  await changeLocale('en');
});

describe('CloudflareAccessManager', () => {
  it('enables only the verified application without editable identity fields', async () => {
    const requiredDocument = {
      settings: {
        mode: 'required' as const,
        issuer: identity.issuer,
        audience: identity.audience,
        bound_origin: 'https://studio.example.com',
        verified_at_iso: '2026-08-28T01:00:00.000Z',
      },
      revision: '2'.repeat(32),
      updated_at_iso: '2026-08-28T01:00:00.000Z',
      detection_state: 'verified' as const,
      detected: identity,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: disabledDocument }))
      .mockResolvedValueOnce(response({ success: true, data: requiredDocument }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Cloudflare Access is verified'))
      .toBeInTheDocument();
    expect(screen.getByText(identity.audience)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/system/operations/cloudflare-access',
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers)
      .get('Authorization')).toBe(`Bearer ${operationsToken}`);

    await user.click(screen.getByRole('button', {
      name: 'Require Cloudflare Access',
    }));
    const dialog = screen.getByRole('dialog', {
      name: 'Require Cloudflare Access?',
    });
    await user.click(within(dialog).getByRole('button', {
      name: 'Apply change',
    }));

    expect(await screen.findByText(
      'Cloudflare Access is now required for protected Studio requests.',
    )).toBeInTheDocument();
    expect(screen.getByText('https://studio.example.com')).toBeInTheDocument();
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      '/api/system/operations/cloudflare-access',
    );
    expect(request).toMatchObject({
      method: 'PUT',
      credentials: 'same-origin',
      headers: expect.objectContaining({
        Authorization: `Bearer ${operationsToken}`,
        'X-Requested-With': 'XMLHttpRequest',
      }),
    });
    expect(JSON.parse(String(request.body))).toEqual({
      mode: 'required',
      expected_revision: disabledDocument.revision,
    });
  });

  it('does not offer activation when no verified Access assertion is present', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: true,
      data: {
        ...disabledDocument,
        detection_state: 'not_detected',
        detected: null,
      },
    })));
    renderPage();

    expect(await screen.findByText('Cloudflare Access was not detected'))
      .toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Require Cloudflare Access',
    })).toBeDisabled();
  });
});

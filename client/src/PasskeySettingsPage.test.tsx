// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from './i18n';
import { PasskeySettingsPage } from './PasskeySettingsPage';
import { security as en } from './i18n/locales/en/security';
import { security as ko } from './i18n/locales/ko/security';
import type { PasskeySettingsDocument } from '../../contracts/passkey-settings';

const policy: PasskeySettingsDocument = {
  settings: { require_fido_certified_authenticator: false }, revision: '0'.repeat(32), updated_at_iso: null,
  snapshot: { id: 'a'.repeat(64), mds_no: 1, blob_sha256: 'b'.repeat(64), evaluated_at_iso: '2026-10-01T00:00:00.000Z',
    next_update: '2026-11-01', names_commit: 'c'.repeat(40), source: 'https://mds.fidoalliance.org/' },
};
const routers: ReturnType<typeof createMemoryRouter>[] = [];
const csrf = 'c'.repeat(43);
const token = 'm'.repeat(64);
const reply = (data: unknown, success = true, status = 200) => new Response(JSON.stringify(success ? { success, data } : { success, error: data }), { status });
afterEach(() => { cleanup(); routers.splice(0).forEach((router) => router.dispose()); vi.unstubAllGlobals(); });
beforeEach(() => localStorage.clear());

function setup(conflict = false) {
  const writes: unknown[] = [];
  const authorizations: unknown[] = [];
  let current = structuredClone(policy);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/settings/passkeys') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)); writes.push(body);
        expect(new Headers(init.headers).get('X-ZeroPress-CSRF')).toBe(csrf);
        if (conflict) return reply({ code: 'SETTINGS_REVISION_CONFLICT' }, false, 409);
        current = { ...current, settings: body.settings, revision: 'd'.repeat(32), updated_at_iso: '2026-10-01T01:00:00.000Z' };
      }
      return reply(current);
    }
    if (url === '/api/auth/mfa/management/status') return reply({
      totp: { configured_at_iso: '2026-10-01T00:00:00.000Z' },
      webauthn: { registration_policy: current, current_rp_id: 'localhost', max_credentials: 10, credentials: [] },
      step_up: { mfa_required: false, freshness_seconds: 300 },
    });
    if (url === '/api/auth/mfa/management/authorize') {
      const body = JSON.parse(String(init?.body)); authorizations.push(body);
      return reply({ status: 'authorized', operation: 'change_passkey_policy', management_token: token, expires_at_iso: '2026-10-01T01:05:00.000Z' });
    }
    throw new Error('Unexpected network call: ' + url);
  }));
  const router = createMemoryRouter([{ path: '/settings/site/security', element: <PasskeySettingsPage data={{ csrf_token: csrf }} onSessionEnded={vi.fn()} /> }], { initialEntries: ['/settings/site/security'] });
  routers.push(router); render(<RouterProvider router={router} />);
  return { writes, authorizations };
}

describe('Studio passkey registration policy UI', () => {
  it.each([['en', en], ['ko', ko]] as const)('confirms the change with reauthentication and preserves the OFF default in %s', async (locale, copy) => {
    await changeLocale(locale); const state = setup(); const user = userEvent.setup();
    const toggle = await screen.findByRole('switch', { name: copy.passkeyPolicy.label });
    expect(toggle).not.toBeChecked(); expect(screen.getByText(copy.passkeyPolicy.scope)).toBeVisible();
    toggle.focus(); await user.keyboard(' '); expect(toggle).toBeChecked();
    await user.click(screen.getByRole('button', { name: copy.passkeyPolicy.save }));
    const dialog = screen.getByRole('dialog', { name: copy.management.authorize.title });
    expect(state.writes).toEqual([]);
    await user.type(within(dialog).getByLabelText(copy.management.authorize.password), 'synthetic password');
    await user.click(within(dialog).getByRole('button', { name: copy.passkeyPolicy.save }));
    expect(await screen.findByText(copy.passkeyPolicy.saved)).toBeVisible();
    expect(state.authorizations).toEqual([{ operation: 'change_passkey_policy', password: 'synthetic password' }]);
    expect(state.writes).toEqual([{ settings: { require_fido_certified_authenticator: true }, expected_revision: policy.revision, management_token: token }]);
  });
  it('keeps the unsaved draft on revision conflict and explicitly reloads it', async () => {
    await changeLocale('en'); setup(true); const user = userEvent.setup();
    await user.click(await screen.findByRole('switch', { name: en.passkeyPolicy.label }));
    await user.click(screen.getByRole('button', { name: en.passkeyPolicy.save }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(en.management.authorize.password), 'synthetic password');
    await user.click(within(dialog).getByRole('button', { name: en.passkeyPolicy.save }));
    expect(await screen.findByText(en.passkeyPolicy.conflict)).toBeVisible();
    expect(screen.getByRole('switch', { name: en.passkeyPolicy.label })).toBeChecked();
    await user.click(screen.getByRole('button', { name: en.passkeyPolicy.reload }));
    expect(await screen.findByRole('switch', { name: en.passkeyPolicy.label })).not.toBeChecked();
  });
});

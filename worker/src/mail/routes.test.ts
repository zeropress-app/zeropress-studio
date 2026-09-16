import { describe, expect, it, vi } from 'vitest';
import { MAIL_SETTINGS_INITIAL_REVISION, materializeMailSettingsDefaults } from '../../../contracts/mail-settings';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { MailProviderFailure } from './provider';
import { createMailRoutes } from './routes';

const session = {
  user: { id: '1'.repeat(32), email: 'owner@example.com', name: 'Owner', roles: ['admin'] },
  session: { id: '2'.repeat(32) },
  csrfToken: 'c'.repeat(43),
  authRevision: '3'.repeat(32),
  mfaVerifiedAtIso: '2026-08-04T00:00:00.000Z',
} as ResolvedSession;
const document = {
  settings: materializeMailSettingsDefaults(),
  credentials: { resend_api_key_configured: false, cloudflare_api_token_configured: false },
  configured: false,
  revision: MAIL_SETTINGS_INITIAL_REVISION,
  updated_at_iso: null,
};
const env = {
  DB: {} as D1Database,
  KV: {} as KVNamespace,
  AUTH_ROUTE_RATE_LIMITER: { limit: vi.fn() },
  STUDIO_AUTH_SECRET: 'test-auth-secret-value-with-at-least-32-characters',
} as Env;

function post(path: string, body: unknown) {
  return new Request(`https://studio.local/${path}`, {
    method: 'POST',
    headers: { Origin: 'https://studio.local', 'Content-Type': 'application/json', 'X-ZeroPress-CSRF': session.csrfToken },
    body: JSON.stringify(body),
  });
}

function put(body: unknown) {
  return new Request('https://studio.local/', {
    method: 'PUT',
    headers: { Origin: 'https://studio.local', 'Content-Type': 'application/json', 'X-ZeroPress-CSRF': session.csrfToken },
    body: JSON.stringify(body),
  });
}

describe('mail delivery routes', () => {
  it('never returns credential material in settings documents', async () => {
    const routes = createMailRoutes({ resolveSession: vi.fn().mockResolvedValue(session), readSettings: vi.fn().mockResolvedValue(document) });
    const response = await routes.fetch(new Request('https://studio.local/'), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: document,
    });
  });

  it('tests an unsaved provider credential without storing it', async () => {
    const verifyCredential = vi.fn().mockResolvedValue(undefined);
    const readStoredCredential = vi.fn();
    const routes = createMailRoutes({ resolveSession: vi.fn().mockResolvedValue(session), verifyCredential, readStoredCredential });
    const response = await routes.fetch(post('test-connection', { provider: 'resend', credential: 're_unsaved' }), env);
    expect(response.status).toBe(200);
    expect(verifyCredential).toHaveBeenCalledWith({ provider: 'resend', credential: 're_unsaved' });
    expect(readStoredCredential).not.toHaveBeenCalled();
  });

  it('sends a test message only through stored complete configuration', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const routes = createMailRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      readRuntimeConfiguration: vi.fn().mockResolvedValue({
        kind: 'configured',
        settings: { provider: 'resend', from_email: 'mail@example.com', from_name: 'ZeroPress', cloudflare_account_id: '' },
        credential: 're_secret',
      }),
      send,
      now: () => new Date('2026-08-04T02:00:00.000Z'),
    });
    const response = await routes.fetch(post('send-test', { recipient: 'owner@example.com' }), env);
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'resend',
      credential: 're_secret',
      to: 'owner@example.com',
      subject: 'ZeroPress Studio test email',
    }));
  });

  it('returns a stable authentication error for rejected credentials', async () => {
    const routes = createMailRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      verifyCredential: vi.fn().mockRejectedValue(new MailProviderFailure('authentication_failed')),
    });
    const response = await routes.fetch(post('test-connection', { provider: 'resend', credential: 're_bad' }), env);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ success: false, error: { code: 'MAIL_PROVIDER_AUTHENTICATION_FAILED' } });
  });

  it('does not expose an unsaved credential to a cross-site request', async () => {
    const verifyCredential = vi.fn();
    const routes = createMailRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      verifyCredential,
    });
    const response = await routes.fetch(new Request(
      'https://studio.local/test-connection',
      {
        method: 'POST',
        headers: {
          Origin: 'https://attacker.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          provider: 'resend',
          credential: 're_unsaved',
        }),
      },
    ), env);
    expect(response.status).toBe(403);
    expect(verifyCredential).not.toHaveBeenCalled();
  });

  it('turns off Newsletter confirmation before disabling the mail provider', async () => {
    const disableNewsletterRuntime = vi.fn().mockResolvedValue(undefined);
    const updateSettings = vi.fn().mockResolvedValue({
      kind: 'completed',
      document,
    });
    const now = new Date('2026-08-04T03:00:00.000Z');
    const routes = createMailRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      disableNewsletterRuntime,
      updateSettings,
      now: () => now,
    });
    const response = await routes.fetch(put({
      settings: materializeMailSettingsDefaults(),
      credentials: {
        resend_api_key: { action: 'preserve' },
        cloudflare_api_token: { action: 'preserve' },
      },
      expected_revision: MAIL_SETTINGS_INITIAL_REVISION,
    }), { ...env, EDGE_DB: {} as D1Database });
    expect(response.status).toBe(200);
    expect(disableNewsletterRuntime).toHaveBeenCalledWith({
      edgeDb: expect.anything(),
      now,
    });
    expect(disableNewsletterRuntime.mock.invocationCallOrder[0])
      .toBeLessThan(updateSettings.mock.invocationCallOrder[0] ?? 0);
  });
});

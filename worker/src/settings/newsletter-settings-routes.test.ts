import { describe, expect, it, vi } from 'vitest';
import { NEWSLETTER_SETTINGS_INITIAL_REVISION, materializeNewsletterSettingsDefaults } from '../../../contracts/newsletter-settings';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createNewsletterSettingsRoutes } from './newsletter-settings-routes';

const session = {
  user: { id: '1'.repeat(32), email: 'owner@example.com', name: 'Owner', roles: ['admin'] },
  session: { id: '2'.repeat(32) },
  csrfToken: 'c'.repeat(43),
  authRevision: '3'.repeat(32),
  mfaVerifiedAtIso: '2026-08-04T00:00:00.000Z',
} as ResolvedSession;
const document = { settings: materializeNewsletterSettingsDefaults(), revision: NEWSLETTER_SETTINGS_INITIAL_REVISION, updated_at_iso: null };
const env = { DB: {} as D1Database, KV: {} as KVNamespace, AUTH_ROUTE_RATE_LIMITER: { limit: vi.fn() } } as Env;

describe('Newsletter settings routes', () => {
  it('protects reads and returns a materialized document', async () => {
    const routes = createNewsletterSettingsRoutes({ resolveSession: vi.fn().mockResolvedValue(session), readSettings: vi.fn().mockResolvedValue(document) });
    const response = await routes.fetch(new Request('https://studio.local/'), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: document });
  });

  it('normalizes and revision-binds complete writes', async () => {
    const updateSettings = vi.fn().mockResolvedValue({ kind: 'completed', document });
    const routes = createNewsletterSettingsRoutes({ resolveSession: vi.fn().mockResolvedValue(session), updateSettings });
    const response = await routes.fetch(new Request('https://studio.local/', {
      method: 'PUT',
      headers: { Origin: 'https://studio.local', 'Content-Type': 'application/json', 'X-ZeroPress-CSRF': session.csrfToken },
      body: JSON.stringify({
        settings: { ...document.settings, title: '  Updates  ' },
        expected_revision: document.revision,
      }),
    }), env);
    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      settings: { ...document.settings, title: 'Updates' },
      expectedRevision: document.revision,
      updatedBy: session.user.id,
    }));
  });

  it('rejects state changes without the session CSRF token', async () => {
    const updateSettings = vi.fn();
    const routes = createNewsletterSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      updateSettings,
    });
    const response = await routes.fetch(new Request('https://studio.local/', {
      method: 'PUT',
      headers: {
        Origin: 'https://studio.local',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        settings: document.settings,
        expected_revision: document.revision,
      }),
    }), env);
    expect(response.status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

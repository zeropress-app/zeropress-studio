import { describe, expect, it, vi } from 'vitest';
import {
  BRANDING_SETTINGS_INITIAL_REVISION,
  materializeSiteBrandingSettingsDefaults,
} from '../../../contracts/branding-settings';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createSiteBrandingRoutes } from './branding-settings-routes';

const NOW = new Date('2026-08-03T12:00:00.000Z');
const USER_ID = '1'.repeat(32);
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const session = {
  user: {
    id: USER_ID,
    email: 'owner@example.com',
    name: 'Owner',
    roles: ['admin'],
  },
  session: { id: '2'.repeat(32) },
  csrfToken: CSRF_TOKEN,
  authRevision: '3'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;

const document = {
  settings: materializeSiteBrandingSettingsDefaults(),
  selected_assets: {
    icon: null,
    icon_dark: null,
    apple_touch_icon: null,
    logo: null,
  },
  revision: BRANDING_SETTINGS_INITIAL_REVISION,
  updated_at_iso: null,
};

function env(): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

function mutation(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://studio.local/', {
    method: 'PUT',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF_TOKEN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('Site Branding routes', () => {
  it('requires settings.manage for reads', async () => {
    const readSettings = vi.fn();
    const routes = createSiteBrandingRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...session,
        user: { ...session.user, roles: ['editor'] },
      }),
      readSettings,
    });
    expect((await routes.fetch(new Request('https://studio.local/'), env())).status)
      .toBe(403);
    expect(readSettings).not.toHaveBeenCalled();
  });

  it('returns one complete document', async () => {
    const routes = createSiteBrandingRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      readSettings: vi.fn().mockResolvedValue(document),
    });
    await expect((await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    )).json()).resolves.toEqual({ success: true, data: document });
  });

  it('normalizes a complete update and maps expected selection failures', async () => {
    const updateSettings = vi.fn()
      .mockResolvedValueOnce({ kind: 'media_not_found' })
      .mockResolvedValueOnce({ kind: 'media_type_not_allowed' })
      .mockResolvedValueOnce({ kind: 'completed', document });
    const routes = createSiteBrandingRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      updateSettings,
      now: () => NOW,
      createRevision: () => '4'.repeat(32),
    });
    const requestBody = {
      settings: {
        ...materializeSiteBrandingSettingsDefaults(),
        logo: { media_id: null, alt: '   ' },
      },
      expected_revision: BRANDING_SETTINGS_INITIAL_REVISION,
    };
    const missing = await routes.fetch(mutation(requestBody), env());
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({
      success: false,
      error: { code: 'SITE_BRANDING_MEDIA_NOT_FOUND' },
    });
    const invalidType = await routes.fetch(mutation(requestBody), env());
    expect(invalidType.status).toBe(400);
    await expect(invalidType.json()).resolves.toEqual({
      success: false,
      error: { code: 'SITE_BRANDING_MEDIA_TYPE_NOT_ALLOWED' },
    });
    expect((await routes.fetch(mutation(requestBody), env())).status).toBe(200);
    expect(updateSettings).toHaveBeenLastCalledWith({
      db: expect.anything(),
      settings: materializeSiteBrandingSettingsDefaults(),
      expectedRevision: BRANDING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: expect.any(Function),
    });
  });

  it('requires same-origin, CSRF, and a complete body', async () => {
    const updateSettings = vi.fn();
    const routes = createSiteBrandingRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      updateSettings,
    });
    const body = {
      settings: materializeSiteBrandingSettingsDefaults(),
      expected_revision: BRANDING_SETTINGS_INITIAL_REVISION,
    };
    expect((await routes.fetch(mutation(body, {
      Origin: 'https://other.example',
    }), env())).status).toBe(403);
    expect((await routes.fetch(mutation(body, {
      'X-ZeroPress-CSRF': 'wrong',
    }), env())).status).toBe(403);
    expect((await routes.fetch(mutation({
      settings: { logo: { media_id: null, alt: '' } },
      expected_revision: BRANDING_SETTINGS_INITIAL_REVISION,
    }), env())).status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

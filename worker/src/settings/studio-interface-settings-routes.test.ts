import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createStudioInterfaceSettingsRoutes } from './studio-interface-settings-routes';

const NOW = new Date('2026-08-10T03:00:00.000Z');
const USER_ID = '1'.repeat(32);
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const REVISION = '2'.repeat(32);
const administratorSession = {
  user: {
    id: USER_ID,
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: { id: '3'.repeat(32) },
  csrfToken: CSRF_TOKEN,
  authRevision: '4'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;

const document = {
  settings: {
    default_locale: 'en' as const,
    enabled_locales: ['en', 'ko'] as ('en' | 'ko')[],
  },
  revision: REVISION,
  updated_at_iso: NOW.toISOString(),
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

function updateRequest(body: unknown, headers: Record<string, string> = {}) {
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

describe('Studio interface settings routes', () => {
  it('requires settings.manage before reading the organization policy', async () => {
    const readSettings = vi.fn();
    const routes = createStudioInterfaceSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
      readSettings,
    });

    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(response.status).toBe(403);
    expect(readSettings).not.toHaveBeenCalled();
  });

  it('returns the revisioned organization interface policy', async () => {
    const routes = createStudioInterfaceSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      readSettings: vi.fn().mockResolvedValue(document),
    });

    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: document,
    });
  });

  it('canonicalizes enabled locales before the atomic revision write', async () => {
    const updatedDocument = {
      settings: {
        default_locale: 'ko' as const,
        enabled_locales: ['en', 'ko'] as ('en' | 'ko')[],
      },
      revision: '5'.repeat(32),
      updated_at_iso: NOW.toISOString(),
    };
    const updateSettings = vi.fn().mockResolvedValue({
      kind: 'completed',
      document: updatedDocument,
    });
    const routes = createStudioInterfaceSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
      now: () => NOW,
      createRevision: () => '5'.repeat(32),
    });

    const response = await routes.fetch(updateRequest({
      settings: {
        default_locale: 'ko',
        enabled_locales: ['ko', 'en'],
      },
      expected_revision: REVISION,
    }), env());

    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      db: expect.anything(),
      settings: {
        default_locale: 'ko',
        enabled_locales: ['en', 'ko'],
      },
      expectedRevision: REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: expect.any(Function),
    });
  });

  it('rejects empty, unsupported, and default-disabled locale policies', async () => {
    const updateSettings = vi.fn();
    const routes = createStudioInterfaceSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
    });
    for (const settings of [
      { default_locale: 'en', enabled_locales: [] },
      { default_locale: 'fr', enabled_locales: ['fr'] },
      { default_locale: 'en', enabled_locales: ['ko'] },
    ]) {
      const response = await routes.fetch(updateRequest({
        settings,
        expected_revision: REVISION,
      }), env());
      expect(response.status).toBe(400);
    }
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('requires exact same-origin and the current session CSRF token', async () => {
    const updateSettings = vi.fn();
    const routes = createStudioInterfaceSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
    });
    const body = {
      settings: document.settings,
      expected_revision: REVISION,
    };

    expect((await routes.fetch(updateRequest(body, {
      Origin: 'https://other.example',
    }), env())).status).toBe(403);
    expect((await routes.fetch(updateRequest(body, {
      'X-ZeroPress-CSRF': 'wrong-token',
    }), env())).status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('returns a stable optimistic-concurrency conflict', async () => {
    const routes = createStudioInterfaceSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings: vi.fn().mockResolvedValue({
        kind: 'revision_conflict',
      }),
    });
    const response = await routes.fetch(updateRequest({
      settings: document.settings,
      expected_revision: REVISION,
    }), env());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'SETTINGS_REVISION_CONFLICT' },
    });
  });
});

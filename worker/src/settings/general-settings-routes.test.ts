import { describe, expect, it, vi } from 'vitest';
import {
  GENERAL_SETTINGS_INITIAL_REVISION,
  type GeneralSettingsRecoveryPlan,
} from '../../../contracts/general-settings';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createGeneralSettingsRoutes } from './general-settings-routes';
import { GeneralSettingsIncompleteError } from './general-settings-repository';

const NOW = new Date('2026-08-01T04:00:00.000Z');
const USER_ID = '1'.repeat(32);
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const administratorSession = {
  user: {
    id: USER_ID,
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: { id: '2'.repeat(32) },
  csrfToken: CSRF_TOKEN,
  authRevision: '3'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;

const document = {
  settings: {
    title: 'ZeroPress',
    description: '',
    url: '',
    locale: 'en-US',
    timezone: 'UTC',
  },
  revision: GENERAL_SETTINGS_INITIAL_REVISION,
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

function repairRequest(body: unknown) {
  return new Request('https://studio.local/repair', {
    method: 'POST',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

describe('General Settings routes', () => {
  it('requires settings.manage before reading settings', async () => {
    const readSettings = vi.fn();
    const routes = createGeneralSettingsRoutes({
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

  it('returns a fully materialized general-settings document', async () => {
    const routes = createGeneralSettingsRoutes({
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

  it('returns a bounded recovery plan and applies an explicit repair', async () => {
    const recovery: GeneralSettingsRecoveryPlan = {
      expected_revision: '4'.repeat(32),
      missing_fields: ['description'],
      proposed_settings: document.settings,
    };
    const repairSettings = vi.fn().mockResolvedValue({
      kind: 'completed',
      document: {
        ...document,
        revision: '5'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    });
    const routes = createGeneralSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      readSettings: vi.fn().mockRejectedValue(
        new GeneralSettingsIncompleteError(recovery),
      ),
      repairSettings,
      now: () => NOW,
    });

    const inspect = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(inspect.status).toBe(409);
    await expect(inspect.json()).resolves.toEqual({
      success: false,
      error: { code: 'SITE_SETTINGS_INCOMPLETE', recovery },
    });

    const repaired = await routes.fetch(repairRequest({
      expected_revision: recovery.expected_revision,
      missing_fields: recovery.missing_fields,
    }), env());
    expect(repaired.status).toBe(200);
    expect(repairSettings).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: recovery.expected_revision,
      missingFields: recovery.missing_fields,
      updatedBy: USER_ID,
    }));
  });

  it('normalizes a complete update and binds it to the current revision', async () => {
    const updateSettings = vi.fn().mockResolvedValue({
      kind: 'completed',
      document: {
        settings: {
          title: 'Example Site',
          description: 'A publication.',
          url: 'https://example.com',
          locale: 'ko-KR',
          timezone: 'UTC',
        },
        revision: '4'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    });
    const routes = createGeneralSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
      now: () => NOW,
      createRevision: () => '4'.repeat(32),
    });
    const response = await routes.fetch(updateRequest({
      settings: {
        title: '  Example Site  ',
        description: '  A publication.  ',
        url: 'https://EXAMPLE.com/',
        locale: 'ko-kr',
        timezone: 'Etc/UTC',
      },
      expected_revision: GENERAL_SETTINGS_INITIAL_REVISION,
    }), env());

    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      db: expect.anything(),
      settings: {
        title: 'Example Site',
        description: 'A publication.',
        url: 'https://example.com',
        locale: 'ko-KR',
        timezone: 'UTC',
      },
      expectedRevision: GENERAL_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: expect.any(Function),
    });
  });

  it('requires exact same-origin and the session CSRF token', async () => {
    const updateSettings = vi.fn();
    const routes = createGeneralSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
    });
    const body = {
      settings: document.settings,
      expected_revision: document.revision,
    };

    expect((await routes.fetch(updateRequest(body, {
      Origin: 'https://other.example',
    }), env())).status).toBe(403);
    expect((await routes.fetch(updateRequest(body, {
      'X-ZeroPress-CSRF': 'wrong-token',
    }), env())).status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('rejects incomplete and oversized update bodies without writing', async () => {
    const updateSettings = vi.fn();
    const routes = createGeneralSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
    });
    const incomplete = await routes.fetch(updateRequest({
      settings: {
        title: 'ZeroPress',
        description: '',
        url: '',
        locale: 'en-US',
      },
      expected_revision: GENERAL_SETTINGS_INITIAL_REVISION,
    }), env());
    expect(incomplete.status).toBe(400);

    const oversized = await routes.fetch(updateRequest({
      settings: {
        ...document.settings,
        description: 'x'.repeat(33 * 1024),
      },
      expected_revision: document.revision,
    }), env());
    expect(oversized.status).toBe(413);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('returns a stable conflict without exposing the current document', async () => {
    const routes = createGeneralSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings: vi.fn().mockResolvedValue({
        kind: 'revision_conflict',
      }),
    });
    const response = await routes.fetch(updateRequest({
      settings: document.settings,
      expected_revision: document.revision,
    }), env());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'SETTINGS_REVISION_CONFLICT' },
    });
  });
});

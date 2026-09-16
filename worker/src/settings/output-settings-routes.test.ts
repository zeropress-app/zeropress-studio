import { describe, expect, it, vi } from 'vitest';
import {
  materializeOutputSettingsDefaults,
  OUTPUT_SETTINGS_INITIAL_REVISION,
} from '../../../contracts/output-settings';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createOutputSettingsRoutes } from './output-settings-routes';

const NOW = new Date('2026-08-01T06:00:00.000Z');
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
  settings: materializeOutputSettingsDefaults(),
  revision: OUTPUT_SETTINGS_INITIAL_REVISION,
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

describe('Homepage and output settings routes', () => {
  it('requires settings.manage before reading settings', async () => {
    const readSettings = vi.fn();
    const routes = createOutputSettingsRoutes({
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

  it('returns a fully materialized output-settings document', async () => {
    const routes = createOutputSettingsRoutes({
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

  it('writes a complete revision-bound Preview Data-shaped document', async () => {
    const settings = {
      ...materializeOutputSettingsDefaults(),
      expose_generator: false,
      search: { enabled: false },
      posts_per_page: 30,
      footer: {
        copyright_text: '© 2026 Example',
        attribution: false,
      },
      robots: { allow_indexing: true },
    };
    const updateSettings = vi.fn().mockResolvedValue({
      kind: 'completed',
      document: {
        settings,
        revision: '4'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    });
    const routes = createOutputSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
      now: () => NOW,
      createRevision: () => '4'.repeat(32),
    });
    const response = await routes.fetch(updateRequest({
      settings: {
        ...settings,
        footer: {
          copyright_text: '  © 2026 Example  ',
          attribution: false,
        },
      },
      expected_revision: OUTPUT_SETTINGS_INITIAL_REVISION,
    }), env());

    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      db: expect.anything(),
      settings,
      expectedRevision: OUTPUT_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: expect.any(Function),
    });
  });

  it('requires exact same-origin and the session CSRF token', async () => {
    const updateSettings = vi.fn();
    const routes = createOutputSettingsRoutes({
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

  it('rejects malformed and oversized bodies without writing', async () => {
    const updateSettings = vi.fn();
    const routes = createOutputSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
    });
    const malformed = await routes.fetch(updateRequest({
      settings: {
        ...document.settings,
        search: true,
      },
      expected_revision: document.revision,
    }), env());
    expect(malformed.status).toBe(400);

    const oversized = await routes.fetch(updateRequest({
      settings: document.settings,
      expected_revision: document.revision,
      padding: 'x'.repeat(33 * 1024),
    }), env());
    expect(oversized.status).toBe(413);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('returns a stable conflict without exposing the current document', async () => {
    const routes = createOutputSettingsRoutes({
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

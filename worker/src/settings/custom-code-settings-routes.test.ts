import { describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
  CUSTOM_HTML_SLOT_MAX_CODE_POINTS,
  materializeCustomCodeSettingsDefaults,
} from '../../../contracts/custom-code-settings';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createCustomCodeSettingsRoutes } from './custom-code-settings-routes';

const NOW = new Date('2026-08-04T01:00:00.000Z');
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
  settings: materializeCustomCodeSettingsDefaults(),
  revision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
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

describe('Custom Code settings routes', () => {
  it('requires settings.manage and returns one complete document', async () => {
    const readSettings = vi.fn().mockResolvedValue(document);
    const denied = createCustomCodeSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...session,
        user: { ...session.user, roles: ['editor'] },
      }),
      readSettings,
    });
    expect((await denied.fetch(new Request('https://studio.local/'), env())).status)
      .toBe(403);
    expect(readSettings).not.toHaveBeenCalled();

    const allowed = createCustomCodeSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      readSettings,
    });
    await expect((await allowed.fetch(
      new Request('https://studio.local/'),
      env(),
    )).json()).resolves.toEqual({ success: true, data: document });
  });

  it('writes the complete raw document and maps a stale revision', async () => {
    const settings = {
      custom_css: { enabled: true, content: '  body {}\n' },
      custom_html: {
        head_end: { enabled: true, content: '<meta name="x">\n' },
        body_end: { enabled: false, content: '<script>draft()</script>\n' },
      },
    };
    const updateSettings = vi.fn()
      .mockResolvedValueOnce({ kind: 'revision_conflict' })
      .mockResolvedValueOnce({
        kind: 'completed',
        document: {
          settings,
          revision: '4'.repeat(32),
          updated_at_iso: NOW.toISOString(),
        },
      });
    const routes = createCustomCodeSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      updateSettings,
      now: () => NOW,
      createRevision: () => '4'.repeat(32),
    });
    const body = {
      settings,
      expected_revision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
    };
    expect((await routes.fetch(mutation(body), env())).status).toBe(409);
    expect((await routes.fetch(mutation(body), env())).status).toBe(200);
    expect(updateSettings).toHaveBeenLastCalledWith({
      db: expect.anything(),
      settings,
      expectedRevision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: expect.any(Function),
    });
  });

  it('requires same-origin, CSRF, complete fields, and HTML limits', async () => {
    const updateSettings = vi.fn();
    const routes = createCustomCodeSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      updateSettings,
    });
    const settings = materializeCustomCodeSettingsDefaults();
    const body = {
      settings,
      expected_revision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
    };
    expect((await routes.fetch(mutation(body, {
      Origin: 'https://other.example',
    }), env())).status).toBe(403);
    expect((await routes.fetch(mutation(body, {
      'X-ZeroPress-CSRF': 'wrong',
    }), env())).status).toBe(403);
    expect((await routes.fetch(mutation({
      settings: { custom_css: settings.custom_css },
      expected_revision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
    }), env())).status).toBe(400);

    const oversized = materializeCustomCodeSettingsDefaults();
    oversized.custom_html.body_end.content = 'x'.repeat(
      CUSTOM_HTML_SLOT_MAX_CODE_POINTS + 1,
    );
    expect((await routes.fetch(mutation({
      settings: oversized,
      expected_revision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
    }), env())).status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

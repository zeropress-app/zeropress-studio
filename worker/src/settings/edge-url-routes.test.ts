import { describe, expect, it, vi } from 'vitest';
import {
  materializeEdgeUrlSettingsDefaults,
  EDGE_URL_SETTINGS_INITIAL_REVISION,
} from '../../../contracts/edge-url';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createEdgeUrlSettingsRoutes } from './edge-url-routes';

const NOW = new Date('2026-08-02T06:00:00.000Z');
const USER_ID = '1'.repeat(32);
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const administratorSession = {
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
  settings: materializeEdgeUrlSettingsDefaults(),
  revision: EDGE_URL_SETTINGS_INITIAL_REVISION,
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

describe('Edge URL settings routes', () => {
  it('rejects readers without Edge feature access', async () => {
    const readSettings = vi.fn();
    const routes = createEdgeUrlSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['unknown'] },
      }),
      readSettings,
    });
    expect((await routes.fetch(new Request('https://studio.local/'), env())).status)
      .toBe(403);
    expect(readSettings).not.toHaveBeenCalled();
  });

  it('allows authors to read public connection state but reserves writes for administrators', async () => {
    const readSettings = vi.fn().mockResolvedValue(document);
    const updateSettings = vi.fn();
    const routes = createEdgeUrlSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue({ ...administratorSession, user: { ...administratorSession.user, roles: ['author'] } }),
      readSettings, updateSettings,
    });
    expect((await routes.fetch(new Request('https://studio.local/'), env())).status).toBe(200);
    expect((await routes.fetch(updateRequest({ settings: document.settings, expected_revision: document.revision }), env())).status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('requires a session and validates CSRF before writing', async () => {
    const updateSettings = vi.fn();
    const anonymous = createEdgeUrlSettingsRoutes({ resolveSession: vi.fn().mockResolvedValue(null), updateSettings });
    expect((await anonymous.fetch(new Request('https://studio.local/'), env())).status).toBe(401);
    const routes = createEdgeUrlSettingsRoutes({ resolveSession: vi.fn().mockResolvedValue(administratorSession), updateSettings });
    expect((await routes.fetch(updateRequest({ settings: document.settings, expected_revision: document.revision }, { 'X-ZeroPress-CSRF': 'wrong' }), env())).status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('normalizes and writes one complete revision-bound document', async () => {
    const saved = {
      settings: {
        edge_origin: 'https://media.example',
      },
      revision: '4'.repeat(32),
      updated_at_iso: NOW.toISOString(),
    };
    const updateSettings = vi.fn().mockResolvedValue({
      kind: 'completed',
      document: saved,
    });
    const routes = createEdgeUrlSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
      now: () => NOW,
      createRevision: () => '4'.repeat(32),
    });
    const response = await routes.fetch(updateRequest({
      settings: {
        edge_origin: 'https://MEDIA.example:443/',
      },
      expected_revision: document.revision,
    }), env());
    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      db: expect.anything(),
      settings: saved.settings,
      expectedRevision: document.revision,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: expect.any(Function),
    });
  });

  it('rejects missing origins, stale writes, and cross-origin mutation', async () => {
    const updateSettings = vi.fn().mockResolvedValue({
      kind: 'revision_conflict',
    });
    const routes = createEdgeUrlSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
    });
    expect((await routes.fetch(updateRequest({
      settings: {
        edge_origin: 'https://edge.example/api',
      },
      expected_revision: document.revision,
    }), env())).status).toBe(400);
    expect((await routes.fetch(updateRequest({
      settings: document.settings,
      expected_revision: document.revision,
    }, { Origin: 'https://other.example' }), env())).status).toBe(403);
    const stale = await routes.fetch(updateRequest({
      settings: document.settings,
      expected_revision: document.revision,
    }), env());
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      success: false,
      error: { code: 'SETTINGS_REVISION_CONFLICT' },
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
  });
});

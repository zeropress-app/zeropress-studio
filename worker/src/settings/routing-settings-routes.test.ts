import { describe, expect, it, vi } from 'vitest';
import {
  materializeRoutingSettingsDefaults,
  ROUTING_SETTINGS_INITIAL_REVISION,
  type RoutingSettingsRecoveryPlan,
} from '../../../contracts/routing-settings';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createRoutingSettingsRoutes } from './routing-settings-routes';
import { RoutingSettingsIncompleteError } from './routing-settings-repository';

const NOW = new Date('2026-08-01T06:00:00.000Z');
const USER_ID = '1'.repeat(32);
const PAGE_ID = '2'.repeat(32);
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
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
  settings: materializeRoutingSettingsDefaults(),
  revision: ROUTING_SETTINGS_INITIAL_REVISION,
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

describe('URLs and Homepage settings routes', () => {
  it('requires settings.manage before reading settings or Page options', async () => {
    const readSettings = vi.fn();
    const listPageOptions = vi.fn();
    const routes = createRoutingSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
      readSettings,
      listPageOptions,
    });
    expect((await routes.fetch(new Request('https://studio.local/'), env())).status)
      .toBe(403);
    expect((await routes.fetch(
      new Request('https://studio.local/page-options'),
      env(),
    )).status).toBe(403);
    expect(readSettings).not.toHaveBeenCalled();
    expect(listPageOptions).not.toHaveBeenCalled();
  });

  it('returns a materialized document and bounded Page options', async () => {
    const routes = createRoutingSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      readSettings: vi.fn().mockResolvedValue(document),
      listPageOptions: vi.fn().mockResolvedValue([{
        id: PAGE_ID,
        title: 'Home',
        path: 'home',
      }]),
    });
    const settingsResponse = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(settingsResponse.status).toBe(200);
    await expect(settingsResponse.json()).resolves.toEqual({
      success: true,
      data: document,
    });
    const optionsResponse = await routes.fetch(new Request(
      `https://studio.local/page-options?search=home&selected_page_id=${PAGE_ID}`,
    ), env());
    expect(optionsResponse.status).toBe(200);
    await expect(optionsResponse.json()).resolves.toEqual({
      success: true,
      data: { items: [{ id: PAGE_ID, title: 'Home', path: 'home' }] },
    });
  });

  it('returns a bounded recovery plan and applies an explicit repair', async () => {
    const recovery: RoutingSettingsRecoveryPlan = {
      expected_revision: '8'.repeat(32),
      missing_fields: ['permalinks'],
      proposed_settings: document.settings,
    };
    const repairSettings = vi.fn().mockResolvedValue({
      kind: 'completed',
      document: {
        ...document,
        revision: '9'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    });
    const routes = createRoutingSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      readSettings: vi.fn().mockRejectedValue(
        new RoutingSettingsIncompleteError(recovery),
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
      error: { code: 'SITE_ROUTING_SETTINGS_INCOMPLETE', recovery },
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

  it('canonicalizes authored paths before the revision-bound write', async () => {
    const updateSettings = vi.fn().mockImplementation(async (input) => ({
      kind: 'completed',
      document: {
        settings: input.settings,
        revision: '5'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    }));
    const routes = createRoutingSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
      now: () => NOW,
      createRevision: () => '5'.repeat(32),
    });
    const authored = {
      ...materializeRoutingSettingsDefaults(),
      permalinks: {
        ...materializeRoutingSettingsDefaults().permalinks,
        posts: ' /journal/:slug ',
      },
      post_index: { enabled: true, path: '/journal', paginate: true },
    };
    const response = await routes.fetch(updateRequest({
      settings: authored,
      expected_revision: ROUTING_SETTINGS_INITIAL_REVISION,
    }), env());
    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        permalinks: expect.objectContaining({ posts: '/journal/:slug/' }),
        post_index: { enabled: true, path: '/journal/', paginate: true },
      }),
      updatedBy: USER_ID,
    }));
  });

  it('preserves standalone Front Page HTML through the API contract', async () => {
    const updateSettings = vi.fn().mockImplementation(async (input) => ({
      kind: 'completed',
      document: {
        settings: input.settings,
        revision: '6'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    }));
    const routes = createRoutingSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
      now: () => NOW,
      createRevision: () => '6'.repeat(32),
    });
    const html = '  <!doctype html>\n<title>Standalone</title>\n';
    const response = await routes.fetch(updateRequest({
      settings: {
        ...materializeRoutingSettingsDefaults(),
        front_page: { type: 'standalone_html', html },
        post_index: { enabled: true, path: '/blog/', paginate: true },
      },
      expected_revision: ROUTING_SETTINGS_INITIAL_REVISION,
    }), env());
    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        front_page: { type: 'standalone_html', html },
      }),
    }));
  });

  it('accepts a standalone document larger than the former settings limit', async () => {
    const updateSettings = vi.fn().mockImplementation(async (input) => ({
      kind: 'completed',
      document: {
        settings: input.settings,
        revision: '7'.repeat(32),
        updated_at_iso: NOW.toISOString(),
      },
    }));
    const routes = createRoutingSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
    });
    const html = `<!doctype html><main>${'x'.repeat(40 * 1024)}</main>`;
    const response = await routes.fetch(updateRequest({
      settings: {
        ...materializeRoutingSettingsDefaults(),
        front_page: { type: 'standalone_html', html },
        post_index: { enabled: true, path: '/blog/', paginate: true },
      },
      expected_revision: ROUTING_SETTINGS_INITIAL_REVISION,
    }), env());

    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        front_page: { type: 'standalone_html', html },
      }),
    }));
  });

  it('rejects root collisions and enforces same-origin CSRF', async () => {
    const updateSettings = vi.fn();
    const routes = createRoutingSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
    });
    const settings = {
      ...document.settings,
      front_page: { type: 'page', page_id: PAGE_ID },
    };
    expect((await routes.fetch(updateRequest({
      settings,
      expected_revision: document.revision,
    }), env())).status).toBe(400);
    expect((await routes.fetch(updateRequest({
      settings: document.settings,
      expected_revision: document.revision,
    }, { Origin: 'https://other.example' }), env())).status).toBe(403);
    expect((await routes.fetch(updateRequest({
      settings: document.settings,
      expected_revision: document.revision,
    }, { 'X-ZeroPress-CSRF': 'wrong' }), env())).status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('returns stable revision and selected-Page conflicts', async () => {
    for (const [kind, code] of [
      ['revision_conflict', 'SETTINGS_REVISION_CONFLICT'],
      ['front_page_not_found', 'ROUTING_FRONT_PAGE_NOT_FOUND'],
    ] as const) {
      const routes = createRoutingSettingsRoutes({
        resolveSession: vi.fn().mockResolvedValue(administratorSession),
        updateSettings: vi.fn().mockResolvedValue({ kind }),
      });
      const response = await routes.fetch(updateRequest({
        settings: document.settings,
        expected_revision: document.revision,
      }), env());
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: { code },
      });
    }
  });
});

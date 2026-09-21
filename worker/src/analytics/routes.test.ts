import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  GENERAL_SETTINGS_DEFAULTS,
  GENERAL_SETTINGS_INITIAL_REVISION,
} from '../../../contracts/general-settings';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env, StudioHonoEnvironment } from '../types';
import {
  createAnalyticsRoutes,
  createAnalyticsSettingsRoutes,
  type AnalyticsRouteDependencies,
} from './routes';
import {
  DOCUMENT,
  forbidAnalyticsNetwork,
  memoryAnalyticsCache,
  NOW,
  SYNTHETIC_TOKEN,
  syntheticAnalyticsApi,
} from './test-support';

forbidAnalyticsNetwork();
const session = {
  user: {
    id: '1'.repeat(32),
    email: 'owner@example.com',
    name: 'Owner',
    roles: ['admin'],
  },
  session: { id: '2'.repeat(32) },
  csrfToken: 'c'.repeat(43),
  authRevision: '3'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;
const general = {
  settings: { ...GENERAL_SETTINGS_DEFAULTS, url: 'https://example.com' },
  revision: GENERAL_SETTINGS_INITIAL_REVISION,
  updated_at_iso: null,
};
function setup(overrides: AnalyticsRouteDependencies = {}) {
  const dependencies = {
    resolveSession: vi.fn().mockResolvedValue(session),
    readSettings: vi.fn().mockResolvedValue(DOCUMENT),
    readGeneralSettings: vi.fn().mockResolvedValue(general),
    readCredential: vi.fn().mockResolvedValue(SYNTHETIC_TOKEN),
    readRuntimeSettings: vi
      .fn()
      .mockResolvedValue({ document: DOCUMENT, token: SYNTHETIC_TOKEN }),
    updateSettings: vi
      .fn()
      .mockResolvedValue({ kind: 'completed', document: DOCUMENT }),
    fetch: syntheticAnalyticsApi(),
    now: () => NOW,
    ...overrides,
  };
  const app = new Hono<StudioHonoEnvironment>();
  app.route(
    '/api/settings/analytics',
    createAnalyticsSettingsRoutes(dependencies),
  );
  app.route('/api/analytics', createAnalyticsRoutes(dependencies));
  const env = {
    DB: {} as D1Database,
    KV: memoryAnalyticsCache().kv,
    STUDIO_AUTH_SECRET: 'synthetic-auth-secret-with-at-least-32-characters',
  } as Env;
  return { app, env, dependencies };
}
function request(path: string, method = 'GET', body?: unknown) {
  return new Request(`https://studio.example${path}`, {
    method,
    headers: {
      Origin: 'https://studio.example',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': session.csrfToken,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
describe('analytics routes', () => {
  it.each(['30m', '6h', '12h', '24h', '3d', '7d', '14d', '21d', '30d'])(
    'serves the selected relative period %s',
    async (period) => {
      const { app, env } = setup();
      const response = await app.fetch(
        request(`/api/analytics/summary?period=${period}`),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        success: true,
        data: { period },
      });
    },
  );
  it.each([null, 'editor', 'author'])(
    'restricts every endpoint for %s',
    async (role) => {
      const { app, env, dependencies } = setup({
        resolveSession: vi
          .fn()
          .mockResolvedValue(
            role === null
              ? null
              : { ...session, user: { ...session.user, roles: [role] } },
          ),
      });
      for (const [path, method] of [
        ['/api/settings/analytics', 'GET'],
        ['/api/settings/analytics', 'PUT'],
        ['/api/settings/analytics/test-connection', 'POST'],
        ['/api/analytics/summary', 'GET'],
      ]) {
        const response = await app.fetch(
          request(path!, method!, method === 'GET' ? undefined : {}),
          env,
        );
        expect(response.status).toBe(role === null ? 401 : 403);
      }
      expect(dependencies.fetch).not.toHaveBeenCalled();
      expect(dependencies.readCredential).not.toHaveBeenCalled();
    },
  );
  it('returns settings status and keeps the response private', async () => {
    const { app, env } = setup();
    const response = await app.fetch(request('/api/settings/analytics'), env);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, data: DOCUMENT });
  });
  it.each(['origin', 'csrf'])(
    'rejects unsafe connection tests before reading secrets: %s',
    async (failure) => {
      const { app, env, dependencies } = setup();
      const req = request('/api/settings/analytics/test-connection', 'POST', {
        account_id: DOCUMENT.settings.account_id,
        site_tag: DOCUMENT.settings.site_tag,
      });
      if (failure === 'origin')
        req.headers.set('Origin', 'https://attacker.example');
      else req.headers.delete('X-ZeroPress-CSRF');
      expect((await app.fetch(req, env)).status).toBe(403);
      expect(dependencies.readCredential).not.toHaveBeenCalled();
      expect(dependencies.fetch).not.toHaveBeenCalled();
    },
  );
  it('checks an unsaved token without storing it or claiming that an empty site is collecting', async () => {
    const { app, env, dependencies } = setup();
    const response = await app.fetch(
      request('/api/settings/analytics/test-connection', 'POST', {
        account_id: DOCUMENT.settings.account_id,
        site_tag: DOCUMENT.settings.site_tag,
        credential: SYNTHETIC_TOKEN,
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { status: 'no_data' },
    });
    expect(dependencies.readCredential).not.toHaveBeenCalled();
    expect(dependencies.updateSettings).not.toHaveBeenCalled();
  });
  it('reports detected data when testing a saved token', async () => {
    const { app, env, dependencies } = setup({
      fetch: syntheticAnalyticsApi([
        { at: '2026-09-21T10:00:00Z', path: '/hello' },
      ]),
    });
    const response = await app.fetch(
      request('/api/settings/analytics/test-connection', 'POST', {
        account_id: DOCUMENT.settings.account_id,
        site_tag: DOCUMENT.settings.site_tag,
      }),
      env,
    );
    expect(await response.json()).toEqual({
      success: true,
      data: { status: 'data_found' },
    });
    expect(dependencies.readCredential).toHaveBeenCalledTimes(1);
  });
  it('defaults to the last 24 hours and distinguishes disabled analytics from zero traffic', async () => {
    const { app, env, dependencies } = setup();
    const response = await app.fetch(request('/api/analytics/summary'), env);
    const body = (await response.json()) as {
      data: { period: string; daily: unknown[]; total: unknown };
    };
    expect(body.data.period).toBe('24h');
    expect(body.data.daily).toHaveLength(2);
    expect(body.data.total).toEqual({ pageviews: 0, visits: 0 });
    vi.mocked(dependencies.readRuntimeSettings).mockResolvedValueOnce({
      document: { ...DOCUMENT, configured: false },
      token: null,
    });
    const disabled = await app.fetch(request('/api/analytics/summary'), env);
    expect(await disabled.json()).toEqual({
      success: false,
      error: { code: 'ANALYTICS_NOT_CONFIGURED' },
    });
  });
  it('handles provider errors through the mounted route without exposing response text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, env } = setup({
      fetch: vi.fn(async () =>
        Response.json({
          errors: [{ message: `not authorized ${SYNTHETIC_TOKEN}` }],
        }),
      ),
    });
    const response = await app.fetch(request('/api/analytics/summary'), env);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'ANALYTICS_AUTHENTICATION_FAILED' },
    });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(
      SYNTHETIC_TOKEN,
    );
  });
  it('does not query Cloudflare without a public-site URL', async () => {
    const { app, env, dependencies } = setup({
      readGeneralSettings: vi.fn().mockResolvedValue({
        ...general,
        settings: { ...general.settings, url: '' },
      }),
    });
    const response = await app.fetch(request('/api/analytics/summary'), env);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'ANALYTICS_SITE_NOT_CONFIGURED' },
    });
    expect(dependencies.fetch).not.toHaveBeenCalled();
  });
  it('preserves revision conflicts in the settings API', async () => {
    const { app, env } = setup({
      updateSettings: vi.fn().mockResolvedValue({ kind: 'revision_conflict' }),
    });
    const response = await app.fetch(
      request('/api/settings/analytics', 'PUT', {
        settings: DOCUMENT.settings,
        credential: { action: 'preserve' },
        expected_revision: DOCUMENT.revision,
      }),
      env,
    );
    expect(response.status).toBe(409);
  });
});

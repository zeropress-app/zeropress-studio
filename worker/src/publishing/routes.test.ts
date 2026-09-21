import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PUBLISHING_DEFAULTS } from '../../../contracts/publishing';
import {
  createPublishingRoutes,
  createPublishingSettingsRoutes,
  type PublishingRouteDependencies,
} from './routes';
import {
  DOCUMENT,
  NOW,
  TARGET,
  TOKEN,
  forbidPublishingNetwork,
  previewDocument,
  syntheticGithub,
} from './test-support';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env, StudioHonoEnvironment } from '../types';
forbidPublishingNetwork();
const session = {
  user: {
    id: '1'.repeat(32),
    email: 'owner@example.test',
    name: 'Owner',
    roles: ['admin'],
  },
  session: { id: '2'.repeat(32) },
  csrfToken: 'c'.repeat(43),
  authRevision: '3'.repeat(32),
  mfaVerifiedAtIso: NOW,
} as ResolvedSession;
function setup(overrides: PublishingRouteDependencies = {}) {
  const api = syntheticGithub();
  const dependencies = {
    resolveSession: vi.fn().mockResolvedValue(session),
    readSettings: vi.fn().mockResolvedValue(DOCUMENT),
    readRuntimeSettings: vi
      .fn()
      .mockResolvedValue({ document: DOCUMENT, token: TOKEN }),
    updateSettings: vi
      .fn()
      .mockResolvedValue({ kind: 'completed', document: DOCUMENT }),
    prepareExport: vi.fn().mockResolvedValue(previewDocument()),
    fetch: api.fetch,
    ...overrides,
  };
  const app = new Hono<StudioHonoEnvironment>();
  app.route(
    '/api/settings/publishing',
    createPublishingSettingsRoutes(dependencies),
  );
  app.route('/api/publishing', createPublishingRoutes(dependencies));
  const env = {
    DB: {} as D1Database,
    STUDIO_AUTH_SECRET: 'synthetic-auth-secret-with-at-least-32-characters',
  } as Env;
  return { app, env, dependencies, api };
}
function request(path: string, method = 'GET', body?: unknown) {
  return new Request('https://studio.example' + path, {
    method,
    headers: {
      Origin: 'https://studio.example',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': session.csrfToken,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const endpoints = [
  ['/api/settings/publishing', 'GET'],
  ['/api/settings/publishing', 'PUT'],
  ['/api/settings/publishing/test-connection', 'POST'],
  ['/api/publishing/status', 'GET'],
  ['/api/publishing', 'POST'],
] as const;
describe('publishing API authorization and snapshots', () => {
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
      for (const [path, method] of endpoints)
        expect(
          (
            await app.fetch(
              request(path, method, method === 'GET' ? undefined : {}),
              env,
            )
          ).status,
        ).toBe(role === null ? 401 : 403);
      expect(dependencies.readRuntimeSettings).not.toHaveBeenCalled();
      expect(dependencies.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(['origin', 'csrf'])(
    'blocks unsafe mutations before reading secrets: %s',
    async (failure) => {
      const { app, env, dependencies } = setup();
      for (const [path, method] of endpoints.filter(
        ([, method]) => method !== 'GET',
      )) {
        const req = request(path, method, {});
        if (failure === 'origin')
          req.headers.set('Origin', 'https://attacker.example');
        else req.headers.delete('X-ZeroPress-CSRF');
        expect((await app.fetch(req, env)).status).toBe(403);
      }
      expect(dependencies.readRuntimeSettings).not.toHaveBeenCalled();
      expect(dependencies.fetch).not.toHaveBeenCalled();
    },
  );
  it('returns a private settings document without decrypting the token', async () => {
    const { app, env, dependencies } = setup();
    const response = await app.fetch(request('/api/settings/publishing'), env);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, data: DOCUMENT });
    expect(dependencies.readRuntimeSettings).not.toHaveBeenCalled();
  });
  it('checks unsaved credentials and resolves a URL without persisting them', async () => {
    const { app, env, dependencies } = setup();
    const response = await app.fetch(
      request('/api/settings/publishing/test-connection', 'POST', {
        file_url: 'https://github.com/example/site/blob/main/data/preview.json',
        credential: TOKEN,
        expected_revision: DOCUMENT.revision,
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(TOKEN);
    expect(dependencies.updateSettings).not.toHaveBeenCalled();
    expect(dependencies.readRuntimeSettings).not.toHaveBeenCalled();
  });
  it('stores the resolved branch and path, rather than the URL guess', async () => {
    const target = { ...TARGET, branch: 'release/current' };
    const api = syntheticGithub({ target });
    const { app, env, dependencies } = setup({ fetch: api.fetch });
    expect(
      (
        await app.fetch(
          request('/api/settings/publishing', 'PUT', {
            settings: {
              ...DOCUMENT.settings,
              branch: 'release',
              path: 'current/data/preview.json',
            },
            credential: { action: 'preserve' },
            expected_revision: DOCUMENT.revision,
            file_url:
              'https://github.com/example/site/blob/release/current/data/preview.json',
          }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(dependencies.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { enabled: true, ...target } }),
    );
  });
  it('rejects stale connection checks and publishing before using GitHub or generating data', async () => {
    const { app, env, dependencies } = setup();
    for (const path of [
      '/api/settings/publishing/test-connection',
      '/api/publishing',
    ])
      expect(
        (
          await app.fetch(
            request(path, 'POST', { expected_revision: 'f'.repeat(32) }),
            env,
          )
        ).status,
      ).toBe(409);
    expect(dependencies.fetch).not.toHaveBeenCalled();
    expect(dependencies.prepareExport).not.toHaveBeenCalled();
  });
  it('preserves revision conflicts on save', async () => {
    const { app, env } = setup({
      updateSettings: vi.fn().mockResolvedValue({ kind: 'revision_conflict' }),
    });
    expect(
      (
        await app.fetch(
          request('/api/settings/publishing', 'PUT', {
            settings: DOCUMENT.settings,
            credential: { action: 'preserve' },
            expected_revision: DOCUMENT.revision,
          }),
          env,
        )
      ).status,
    ).toBe(409);
  });
  it.each([false, true])(
    'keeps disabled publishing local with configured=%s',
    async (configured) => {
      const { app, env, dependencies } = setup({
        readRuntimeSettings: vi.fn().mockResolvedValue({
          document: {
            ...DOCUMENT,
            settings: { ...PUBLISHING_DEFAULTS, ...(configured ? TARGET : {}) },
            configured,
            token_configured: configured,
          },
          token: TOKEN,
        }),
      });
      expect(
        await (await app.fetch(request('/api/publishing/status'), env)).json(),
      ).toEqual({
        success: true,
        data: {
          enabled: false,
          configured,
          file: null,
          revision: DOCUMENT.revision,
        },
      });
      expect(
        (
          await app.fetch(
            request('/api/publishing', 'POST', {
              expected_revision: DOCUMENT.revision,
            }),
            env,
          )
        ).status,
      ).toBe(409);
      expect(dependencies.fetch).not.toHaveBeenCalled();
      expect(dependencies.prepareExport).not.toHaveBeenCalled();
    },
  );
  it('reads the latest file commit when a saved connection is enabled', async () => {
    const { app, env, dependencies } = setup();
    const response = await app.fetch(request('/api/publishing/status'), env);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        enabled: true,
        configured: true,
        revision: DOCUMENT.revision,
        file: { target: TARGET },
      },
    });
    expect(dependencies.fetch).toHaveBeenCalled();
    expect(dependencies.prepareExport).not.toHaveBeenCalled();
  });
  it('publishes through the common data preparation service', async () => {
    const { app, env, dependencies } = setup();
    const response = await app.fetch(
      request('/api/publishing', 'POST', {
        expected_revision: DOCUMENT.revision,
      }),
      env,
    );
    expect(await response.json()).toMatchObject({
      success: true,
      data: { outcome: 'committed' },
    });
    expect(dependencies.prepareExport).toHaveBeenCalledTimes(1);
  });
  it('does not expose provider responses or credentials in errors or logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app, env } = setup({
      fetch: vi.fn(async () =>
        Response.json(
          { message: `private provider error ${TOKEN}` },
          { status: 503 },
        ),
      ),
    });
    const response = await app.fetch(request('/api/publishing/status'), env);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'PUBLISHING_UNAVAILABLE' },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      'private provider error',
    );
  });
});

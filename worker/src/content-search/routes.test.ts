import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentSearchIndexStatus } from '../../../contracts/content-search-index';
import type { AuditContext } from '../audit/service';
import type { ResolvedSession } from '../auth/session-repository';
import { createApp } from '../index';
import { createFakeD1 } from '../test-helpers/fake-d1';
import type { Env, StudioHonoEnvironment } from '../types';
import { ContentSearchRebuildError } from './rebuild';
import { createContentSearchIndexRoutes } from './routes';

const CSRF = 'c'.repeat(43);
const OPERATION = 'd'.repeat(32);
const INITIATOR = { userId: '1'.repeat(32), userEmail: 'first@example.com' };
const STATUS: ContentSearchIndexStatus = {
  state: 'in_progress', reason: 'manual_rebuild', phase: 'posts',
  operation_id: OPERATION, post_public_id_cursor: 5, page_public_id_cursor: 0,
  processed_posts: 5, processed_pages: 0, total_posts: 8, total_pages: 1,
  available: true,
};
const STEP = {
  operation_id: OPERATION, expected_phase: 'posts',
  expected_post_public_id_cursor: 5, expected_page_public_id_cursor: 0,
};
const PATHS = ['/', '/rebuild/start', '/rebuild/step'] as const;

function session(role = 'admin'): ResolvedSession {
  return {
    user: { id: '2'.repeat(32), name: 'Current Admin', email: 'current@example.com', roles: [role] },
    session: { id: '3'.repeat(32) }, csrfToken: CSRF, authRevision: '4'.repeat(32),
  } as ResolvedSession;
}
function request(path: string, overrides: Record<string, string> = {}, body?: unknown) {
  return new Request(`https://studio.local${path}`, {
    method: path.endsWith('/start') || path.endsWith('/step') ? 'POST' : 'GET',
    ...(path.endsWith('/start') || path.endsWith('/step') ? {
      headers: { Origin: 'https://studio.local', 'Content-Type': 'application/json',
        'X-ZeroPress-CSRF': CSRF, ...overrides },
      body: JSON.stringify(body ?? (path.endsWith('/step') ? STEP : {})),
    } : {}),
  });
}
function setup(role: string | null = 'admin') {
  const audit = { events: [], network: {} } as unknown as AuditContext;
  const dependencies = {
    resolveSession: vi.fn().mockResolvedValue(role ? session(role) : null),
    inspect: vi.fn().mockResolvedValue(STATUS),
    start: vi.fn().mockResolvedValue(STATUS),
    step: vi.fn().mockResolvedValue({ ...STATUS, state: 'ready', phase: null, operation_id: null }),
    readInitiator: vi.fn().mockResolvedValue(INITIATOR),
    restoreInProgress: vi.fn().mockResolvedValue(false),
    reconciliationInProgress: vi.fn().mockResolvedValue(false),
  };
  const app = new Hono<StudioHonoEnvironment>();
  app.use('*', async (c, next) => { c.set('audit', audit); await next(); });
  app.route('/', createContentSearchIndexRoutes(dependencies));
  app.onError((_error, c) => c.json({ success: false, error: { code: 'SYSTEM_NOT_AVAILABLE' } }, 503));
  const env = { DB: {} } as Env;
  return { app, env, audit, dependencies };
}
afterEach(() => vi.restoreAllMocks());

describe('administrator content-search rebuild routes', () => {
  it.each(PATHS)('requires an administrator session for %s', async (path) => {
    for (const [role, expected] of [[null, 401], ['editor', 403]] as const) {
      const { app, env, dependencies } = setup(role);
      const response = await app.fetch(request(path), env);
      expect(response.status).toBe(expected);
      expect(dependencies.inspect).not.toHaveBeenCalled();
      expect(dependencies.start).not.toHaveBeenCalled();
      expect(dependencies.step).not.toHaveBeenCalled();
    }
  });
  it.each(['/rebuild/start', '/rebuild/step'])('checks origin, CSRF and input before %s', async (path) => {
    const { app, env, dependencies } = setup();
    const invalidHeaders: Record<string, string>[] = [
      { Origin: 'https://attacker.example' },
      { 'X-ZeroPress-CSRF': '' },
      { 'X-ZeroPress-CSRF': 'wrong-token' },
    ];
    for (const headers of invalidHeaders) {
      expect((await app.fetch(request(path, headers), env)).status).toBe(403);
    }
    expect((await app.fetch(request(path, {}, { unexpected: true }), env)).status).toBe(400);
    expect(dependencies.start).not.toHaveBeenCalled();
    expect(dependencies.step).not.toHaveBeenCalled();
  });
  it('starts only a required rebuild and audits the authenticated administrator', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { app, env, dependencies, audit } = setup();
    const response = await app.fetch(request('/rebuild/start'), env);
    expect(response.status).toBe(200);
    expect(dependencies.start).toHaveBeenCalledWith({
      db: env.DB, expectedState: 'rebuild_required',
      initiator: { userId: session().user.id, userEmail: session().user.email },
    });
    expect(audit.events).toMatchObject([{
      action: 'operations_search', actor: { kind: 'user', name: 'Current Admin' },
      metadata: { stage: 'started', operation_id: OPERATION },
    }]);
  });
  it('continues the shared checkpoint and keeps the original initiator separate from the current actor', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { app, env, dependencies, audit } = setup();
    const response = await app.fetch(request('/rebuild/step'), env);
    await expect(response.json()).resolves.toMatchObject({ success: true, data: {
      status: 'completed', content_search_index: { state: 'ready' },
    } });
    expect(dependencies.step).toHaveBeenCalledWith({ db: env.DB, request: STEP });
    expect(audit.events).toMatchObject([{
      actor: { id: session().user.id, name: 'Current Admin' },
      metadata: {
        stage: 'completed', operation_id: OPERATION,
        initiator: { id: INITIATOR.userId, email: INITIATOR.userEmail },
      },
    }]);
  });
  it.each(['restoreInProgress', 'reconciliationInProgress'] as const)(
    'pauses dashboard actions while %s', async (dependency) => {
      const { app, env, dependencies } = setup();
      dependencies[dependency].mockResolvedValue(true);
      const status = await app.fetch(request('/'), env);
      await expect(status.json()).resolves.toMatchObject({ data: { available: false } });
      for (const path of PATHS.slice(1)) {
        expect((await app.fetch(request(path), env)).status).toBe(409);
      }
      expect(dependencies.start).not.toHaveBeenCalled();
      expect(dependencies.step).not.toHaveBeenCalled();
    },
  );
  it('reports a changed checkpoint without recording a successful step', async () => {
    const { app, env, dependencies, audit } = setup();
    dependencies.step.mockRejectedValue(new ContentSearchRebuildError('state_conflict', 'Changed'));
    const response = await app.fetch(request('/rebuild/step'), env);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT' },
    });
    expect(audit.events).toEqual([]);
  });
  it('records verification failure and returns a recovery response', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { app, env, dependencies, audit } = setup();
    dependencies.step.mockRejectedValue(new ContentSearchRebuildError('integrity_failed', 'Mismatch'));
    const response = await app.fetch(request('/rebuild/step'), env);
    expect(response.status).toBe(409);
    expect(audit.events).toMatchObject([{
      action: 'operations_search', outcome: 'failed',
      metadata: { operation_id: OPERATION },
    }]);
  });
  it('uses the application operational gate and no-store headers', async () => {
    const { dependencies } = setup();
    const app = createApp({ contentSearchIndex: dependencies });
    const env = {
      DB: createFakeD1().database, KV: {} as KVNamespace,
      STUDIO_SITE_MODE: 'operational', STUDIO_AUTH_SECRET: 's'.repeat(64),
    } as Env;
    const response = await app.fetch(request('/api/content-search-index'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    for (const mode of ['maintenance', 'recovery', 'initial']) {
      for (const path of PATHS) {
        const response = await app.fetch(
          request(`/api/content-search-index${path === '/' ? '' : path}`),
          { ...env, STUDIO_SITE_MODE: mode },
        );
        expect(response.status).toBe(503);
      }
    }
    expect(dependencies.start).not.toHaveBeenCalled();
    expect(dependencies.step).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { StudioOperationalError } from '../lib/operational-error';
import { createDashboardRoutes as createDashboardRoutesImpl } from './routes';

function createDashboardRoutes(
  dependencies: Parameters<typeof createDashboardRoutesImpl>[0],
) {
  return createDashboardRoutesImpl({
    ...dependencies,
    readEdgeMode: vi.fn().mockResolvedValue('enabled'),
    countPendingEdgeTargets: vi.fn().mockResolvedValue(0),
    inspectEdge: vi.fn().mockResolvedValue({ state: 'ready' }),
  });
}

const NOW = new Date('2026-08-04T03:00:00.000Z');

function session(role: 'admin' | 'editor' | 'author'): ResolvedSession {
  return {
    user: { id: '1'.repeat(32), email: 'user@example.com', name: 'User', roles: [role] },
    session: { id: '2'.repeat(32) },
    csrfToken: 'c'.repeat(43), authRevision: '3'.repeat(32),
    mfaVerifiedAtIso: NOW.toISOString(),
  } as ResolvedSession;
}

function env(): Env {
  return {
    DB: {} as D1Database, EDGE_DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: { limit: vi.fn() },
  };
}

const content = {
  posts: {
    access: { scope: 'all' as const },
    total: 1,
    draft: 0,
    published: 1,
    trash: 0,
  },
  pages: { total: 0, draft: 0, published: 0, trash: 0 },
  media: { total: 0, managed: 0, external: 0 },
};
const edge = {
  status: 'available' as const,
  pending_target_events: 0,
  comments: { pending: 1, enabled: true, api_configured: true },
  forms: { unread_submissions: 1 },
  newsletters: {
    pending_confirmations: 1, confirmation_enabled: true,
    confirmation_ready: true,
  },
};

describe('Dashboard routes', () => {
  it('returns all authorized administrator sections', async () => {
    const readStudio = vi.fn().mockResolvedValue(content);
    const readEdge = vi.fn().mockResolvedValue(edge);
    const routes = createDashboardRoutes({
      resolveSession: vi.fn().mockResolvedValue(session('admin')),
      readStudio, readEdge,
      readMail: vi.fn().mockResolvedValue({ configured: true }),
      now: () => NOW,
    });
    const response = await routes.fetch(new Request('https://studio.local/summary'), env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { generated_at_iso: NOW.toISOString(), content, mail: { configured: true }, edge },
    });
    expect(readStudio).toHaveBeenCalledWith({
      db: expect.anything(),
      permissions: { posts: true, pages: true, media: true },
      postAccess: { scope: 'all' },
    });
  });

  it('returns only the linked Author\'s Post totals', async () => {
    const authorContent = {
      posts: {
        ...content.posts,
        access: {
          scope: 'own' as const,
          author: { id: 'site-author', display_name: 'Site Author' },
        },
      },
      pages: null,
      media: null,
    };
    const readStudio = vi.fn().mockResolvedValue(authorContent);
    const readEdge = vi.fn();
    const readMail = vi.fn();
    const routes = createDashboardRoutes({
      resolveSession: vi.fn().mockResolvedValue(session('author')),
      resolvePostAccess: vi.fn().mockResolvedValue({
        scope: 'own',
        author: { id: 'site-author', display_name: 'Site Author' },
      }),
      readStudio, readEdge, readMail, now: () => NOW,
    });
    const response = await routes.fetch(new Request('https://studio.local/summary'), env());
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        content: authorContent,
        mail: null,
        edge: { status: 'not_requested' },
      },
    });
    expect(readStudio).toHaveBeenCalledWith({
      db: expect.anything(),
      permissions: { posts: true, pages: false, media: false },
      postAccess: {
        scope: 'own',
        author: { id: 'site-author', display_name: 'Site Author' },
      },
      postAuthorId: 'site-author',
    });
    expect(readEdge).not.toHaveBeenCalled();
    expect(readMail).not.toHaveBeenCalled();
  });

  it('degrades only the Edge section and records the operational failure', async () => {
    const logEdgeFailure = vi.fn();
    const routes = createDashboardRoutes({
      resolveSession: vi.fn().mockResolvedValue(session('editor')),
      readStudio: vi.fn().mockResolvedValue(content),
      readMail: vi.fn().mockResolvedValue({ configured: true }),
      readEdge: vi.fn().mockRejectedValue(new StudioOperationalError(
        'DASHBOARD_EDGE_DATABASE_QUERY_FAILED',
      )),
      logEdgeFailure,
      now: () => NOW,
    });
    const response = await routes.fetch(new Request('https://studio.local/summary'), env());
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        content,
        edge: { status: 'unavailable', pending_target_events: 0 },
      },
    });
    expect(logEdgeFailure).toHaveBeenCalledOnce();
  });

  it('reports unavailable without reading aggregates when Edge health is incomplete', async () => {
    const readEdge = vi.fn();
    const logEdgeFailure = vi.fn();
    const routes = createDashboardRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(session('admin')),
      readStudio: vi.fn().mockResolvedValue(content),
      readMail: vi.fn().mockResolvedValue({ configured: true }),
      readEdge,
      readEdgeMode: vi.fn().mockResolvedValue('enabled'),
      countPendingEdgeTargets: vi.fn().mockResolvedValue(0),
      inspectEdge: vi.fn().mockResolvedValue({
        state: 'unavailable',
        reason: 'edge_kv_binding_missing',
      }),
      logEdgeFailure,
      now: () => NOW,
    });

    const response = await routes.fetch(
      new Request('https://studio.local/summary'),
      env(),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        edge: { status: 'unavailable', pending_target_events: 0 },
      },
    });
    expect(readEdge).not.toHaveBeenCalled();
    expect(logEdgeFailure).toHaveBeenCalledOnce();
    expect(logEdgeFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'EDGE_INTEGRATION_HEALTH_CHECK_FAILED',
    }));
  });

  it('preserves reconciliation state while returning readable Edge aggregates', async () => {
    const readEdge = vi.fn().mockResolvedValue(edge);
    const logEdgeFailure = vi.fn();
    const routes = createDashboardRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(session('admin')),
      readStudio: vi.fn().mockResolvedValue(content),
      readMail: vi.fn().mockResolvedValue({ configured: true }),
      readEdge,
      readEdgeMode: vi.fn().mockResolvedValue('enabled'),
      countPendingEdgeTargets: vi.fn().mockResolvedValue(0),
      inspectEdge: vi.fn().mockResolvedValue({
        state: 'reconciliation_required',
      }),
      logEdgeFailure,
      now: () => NOW,
    });

    const response = await routes.fetch(
      new Request('https://studio.local/summary'),
      env(),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        edge: {
          ...edge,
          status: 'reconciliation_required',
        },
      },
    });
    expect(readEdge).toHaveBeenCalledOnce();
    expect(logEdgeFailure).not.toHaveBeenCalled();
  });

  it('reports disabled without querying or logging Edge resources', async () => {
    const readEdge = vi.fn();
    const logEdgeFailure = vi.fn();
    const routes = createDashboardRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(session('admin')),
      readStudio: vi.fn().mockResolvedValue(content),
      readMail: vi.fn().mockResolvedValue({ configured: true }),
      readEdge,
      readEdgeMode: vi.fn().mockResolvedValue('disabled'),
      countPendingEdgeTargets: vi.fn().mockResolvedValue(2),
      inspectEdge: vi.fn(),
      logEdgeFailure,
      now: () => NOW,
    });
    const response = await routes.fetch(
      new Request('https://studio.local/summary'),
      env(),
    );
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        edge: { status: 'disabled', pending_target_events: 2 },
      },
    });
    expect(readEdge).not.toHaveBeenCalled();
    expect(logEdgeFailure).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    const routes = createDashboardRoutes({
      resolveSession: vi.fn().mockResolvedValue(null),
    });
    expect((await routes.fetch(new Request('https://studio.local/summary'), env())).status).toBe(401);
  });
});

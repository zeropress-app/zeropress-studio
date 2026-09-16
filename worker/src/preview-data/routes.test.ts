import { afterEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_PREVIEW_DATA_GENERATOR } from '../../../contracts/studio-version';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createPreviewDataRoutes as createPreviewDataRoutesImpl } from './routes';
import { StudioOperationalError } from '../lib/operational-error';

function createPreviewDataRoutes(
  dependencies: Parameters<typeof createPreviewDataRoutesImpl>[0],
) {
  return createPreviewDataRoutesImpl({
    ...dependencies,
    readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
    drainProjections: vi.fn().mockResolvedValue({
      processedEvents: 0,
      remainingEvents: 0,
    }),
    inspectEdge: vi.fn().mockResolvedValue({ state: 'ready' }),
    inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
      state: 'ready', reason: 'ready', currentSchemaVersion: 3,
    }),
  });
}

const NOW = new Date('2026-08-01T06:00:00.000Z');
const administratorSession = {
  user: {
    id: '1'.repeat(32),
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: { id: '2'.repeat(32) },
  csrfToken: 'csrf-token-with-at-least-thirty-two-characters',
  authRevision: '3'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;

const document = {
  preview_data: {
    $schema: 'https://schemas.zeropress.dev/preview-data/v0.7/schema.json',
    version: '0.7' as const,
    generator: STUDIO_PREVIEW_DATA_GENERATOR,
    generated_at: '2026-08-01T06:00:00Z',
    site: {
      title: 'ZeroPress',
      description: '',
      url: '',
      media_origin: '',
      locale: 'en-US',
      posts_per_page: 10,
      date_style: 'medium' as const,
      time_style: 'none' as const,
      timezone: 'UTC',
      robots: { allow_indexing: false },
    },
    content: {
      authors: [],
      posts: [],
      pages: [],
      categories: [],
      tags: [],
    },
  },
  validation: {
    status: 'valid' as const,
    contract_version: '0.7' as const,
    warnings: [],
  },
};

function env(): Env {
  return {
    DB: {} as D1Database,
    EDGE_DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Preview Data export route', () => {
  it('returns a no-store count summary without entering the export or Edge pipeline', async () => {
    const readSummary = vi.fn().mockResolvedValue({
      authors: 1,
      posts: 274,
      pages: 1,
      categories: 4,
      tags: 667,
      menus: 2,
    });
    const generateExport = vi.fn();
    const readEdgeIntegrationMode = vi.fn();
    const drainProjections = vi.fn();
    const inspectEdge = vi.fn();
    const inspectEdgeDatabaseRuntime = vi.fn();
    const routes = createPreviewDataRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      readSummary,
      generateExport,
      readEdgeIntegrationMode,
      drainProjections,
      inspectEdge,
      inspectEdgeDatabaseRuntime,
    });

    const response = await routes.fetch(
      new Request('https://studio.local/summary'),
      env(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        authors: 1,
        posts: 274,
        pages: 1,
        categories: 4,
        tags: 667,
        menus: 2,
      },
    });
    expect(readSummary).toHaveBeenCalledOnce();
    expect(readSummary).toHaveBeenCalledWith({ db: expect.anything() });
    expect(generateExport).not.toHaveBeenCalled();
    expect(readEdgeIntegrationMode).not.toHaveBeenCalled();
    expect(drainProjections).not.toHaveBeenCalled();
    expect(inspectEdge).not.toHaveBeenCalled();
    expect(inspectEdgeDatabaseRuntime).not.toHaveBeenCalled();
  });

  it('requires publish.manage before reading the count summary', async () => {
    const readSummary = vi.fn();
    const routes = createPreviewDataRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
      readSummary,
    });

    const response = await routes.fetch(
      new Request('https://studio.local/summary'),
      env(),
    );
    expect(response.status).toBe(403);
    expect(readSummary).not.toHaveBeenCalled();
  });

  it('requires publish.manage before generating an export', async () => {
    const generateExport = vi.fn();
    const routes = createPreviewDataRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
      generateExport,
    });

    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(response.status).toBe(403);
    expect(generateExport).not.toHaveBeenCalled();
  });

  it('returns one validated no-store projection for an administrator', async () => {
    const generateExport = vi.fn().mockResolvedValue(document);
    const routes = createPreviewDataRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      generateExport,
      now: () => NOW,
    });

    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: document,
    });
    expect(generateExport).toHaveBeenCalledWith({
      db: expect.anything(),
      edgeDb: expect.anything(),
      generatedAt: NOW,
    });
  });

  it('requires authentication without invoking the projection', async () => {
    const generateExport = vi.fn();
    const routes = createPreviewDataRoutes({
      resolveSession: vi.fn().mockResolvedValue(null),
      generateExport,
    });
    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );

    expect(response.status).toBe(401);
    expect(generateExport).not.toHaveBeenCalled();
  });

  it('omits Edge projection inputs while integration is disabled', async () => {
    const generateExport = vi.fn().mockResolvedValue(document);
    const drainProjections = vi.fn();
    const inspectEdge = vi.fn();
    const routes = createPreviewDataRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      generateExport,
      readEdgeIntegrationMode: vi.fn().mockResolvedValue('disabled'),
      drainProjections,
      inspectEdge,
      now: () => NOW,
    });
    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(response.status).toBe(200);
    expect(generateExport).toHaveBeenCalledWith({
      db: expect.anything(),
      generatedAt: NOW,
    });
    expect(drainProjections).not.toHaveBeenCalled();
    expect(inspectEdge).not.toHaveBeenCalled();
  });

  it('blocks export while durable target events remain after the synchronous drain', async () => {
    const generateExport = vi.fn();
    const inspectEdge = vi.fn();
    const routes = createPreviewDataRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      generateExport,
      readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
      drainProjections: vi.fn().mockResolvedValue({
        processedEvents: 250,
        remainingEvents: 1,
      }),
      inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
        state: 'ready', reason: 'ready', currentSchemaVersion: 3,
      }),
      inspectEdge,
      now: () => NOW,
    });

    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_TARGET_PROJECTION_PENDING' },
    });
    expect(inspectEdge).not.toHaveBeenCalled();
    expect(generateExport).not.toHaveBeenCalled();
  });

  it('reports an explicit unavailable state when the pre-export drain fails', async () => {
    const generateExport = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(
      () => undefined,
    );
    const routes = createPreviewDataRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      generateExport,
      readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
      drainProjections: vi.fn().mockRejectedValue(new StudioOperationalError(
        'COMMENT_TARGET_OUTBOX_DATABASE_WRITE_FAILED',
        { metadata: { resource: 'DB', action: 'acknowledge_outbox' } },
      )),
      inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
        state: 'ready', reason: 'ready', currentSchemaVersion: 3,
      }),
      inspectEdge: vi.fn(),
      now: () => NOW,
    });

    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_INTEGRATION_UNAVAILABLE' },
    });
    expect(generateExport).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it.each([
    [{ state: 'reconciliation_required' as const }, 409, 'EDGE_RECONCILIATION_REQUIRED'],
    [{ state: 'unavailable' as const, reason: 'database_unavailable' as const }, 503, 'EDGE_INTEGRATION_UNAVAILABLE'],
  ])('fails explicitly when enabled Edge health is %s', async (
    health,
    status,
    code,
  ) => {
    const generateExport = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(
      () => undefined,
    );
    const routes = createPreviewDataRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      generateExport,
      readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
      drainProjections: vi.fn().mockResolvedValue({
        processedEvents: 0,
        remainingEvents: 0,
      }),
      inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
        state: 'ready', reason: 'ready', currentSchemaVersion: 3,
      }),
      inspectEdge: vi.fn().mockResolvedValue(health),
      now: () => NOW,
    });

    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code },
    });
    expect(generateExport).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(
      health.state === 'unavailable' ? 1 : 0,
    );
  });
});

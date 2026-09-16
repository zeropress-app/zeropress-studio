import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import { COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT } from '../comments/target-projection-outbox';
import type { Env } from '../types';
import {
  createWxrCoreImportRoutes as createWxrCoreImportRoutesImpl,
} from './wxr-core-import-routes';

function createWxrCoreImportRoutes(
  dependencies: NonNullable<
    Parameters<typeof createWxrCoreImportRoutesImpl>[0]
  > = {},
) {
  return createWxrCoreImportRoutesImpl({
    ...dependencies,
    readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
    inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
      state: 'ready', reason: 'ready', currentSchemaVersion: 3,
    }),
    drainProjections: dependencies.drainProjections ?? vi.fn().mockResolvedValue({
      processedEvents: 0,
      remainingEvents: 0,
    }),
  });
}

const NOW = new Date('2026-08-02T09:00:00.000Z');
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const adminSession = {
  user: {
    id: '1'.repeat(32),
    email: 'admin@example.com',
    name: 'Administrator',
    roles: ['admin'],
  },
  session: { id: '2'.repeat(32) },
  csrfToken: CSRF_TOKEN,
  authRevision: '3'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;

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

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://studio.local/core/chunk', {
    method: 'POST',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF_TOKEN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function finalizeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://studio.local/settings/finalize', {
    method: 'POST',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF_TOKEN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const routingSettings = {
  permalinks: {
    output_style: 'html-extension' as const,
    posts: '/post/:public_id/',
    pages: '/:slug/',
    categories: '/categories/:slug/',
    tags: '/tags/:slug/',
  },
  front_page: { type: 'theme_index' as const },
  post_index: { enabled: true, path: '/', paginate: true },
};

const finalizeBody = {
  general_settings: {
    settings: {
      title: 'Imported site',
      description: '',
      url: 'https://example.com',
      locale: 'en-US',
      timezone: 'UTC',
    },
    expected_revision: '3'.repeat(32),
  },
  routing_settings: {
    settings: routingSettings,
    expected_revision: '4'.repeat(32),
  },
};

const postChunk = {
  phase: 'posts' as const,
  rows: [{
    public_id: 13261,
    title: 'Imported Post',
    slug: 'imported-post',
    content: '<p>Hello</p>',
    document_type: 'html' as const,
    editor_mode: 'visual' as const,
    editor_profile: 'tiptap-v1' as const,
    excerpt: 'Hello',
    status: 'published' as const,
    author_id: 'wordpress-author',
    category_slugs: [],
    tag_slugs: [],
    discoverability: 'default' as const,
    allow_comments: true,
    featured_image_location: null,
    published_at_iso: '2026-07-01T00:00:00Z',
    created_at_iso: '2026-07-01T00:00:00Z',
    updated_at_iso: '2026-07-01T00:00:00Z',
  }],
};

const commentChunk = {
  phase: 'comments' as const,
  rows: [{
    public_id: 501,
    target_type: 'post' as const,
    target_public_id: 13261,
    parent_public_id: null,
    author_name: 'Reader',
    author_email: '',
    content_text: 'Imported comment',
    status: 'approved' as const,
    created_at_iso: '2026-07-02T00:00:00Z',
  }],
};

const menuChunk = {
  phase: 'menus' as const,
  rows: [{ menu_id: 'primary', name: 'Primary', items: [] }],
};

describe('WXR core import routes', () => {
  it('allows only administrators and flushes persisted Post targets', async () => {
    const importChunk = vi.fn().mockResolvedValue({
      summary: {
        phase: 'posts', processed: 1, created: 1, updated: 0,
        unchanged: 0, failed: 0, failures: [],
      },
    });
    const flushProjectionAfterChunk = vi.fn().mockResolvedValue(undefined);
    const routes = createWxrCoreImportRoutes({
      resolveSession: vi.fn().mockResolvedValue(adminSession),
      importChunk,
      flushProjectionAfterChunk,
      now: () => NOW,
    });
    const response = await routes.fetch(request(postChunk), env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { phase: 'posts', created: 1 },
    });
    expect(importChunk).toHaveBeenCalledWith({
      db: expect.anything(),
      request: postChunk,
      now: NOW,
      createId: undefined,
      createRevision: undefined,
    });
    expect(flushProjectionAfterChunk).toHaveBeenCalledOnce();

    const deniedRoutes = createWxrCoreImportRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...adminSession,
        user: { ...adminSession.user, roles: ['editor'] },
      }),
      importChunk,
    });
    expect((await deniedRoutes.fetch(request(postChunk), env())).status).toBe(403);
    expect(importChunk).toHaveBeenCalledTimes(1);
  });

  it('enforces closed input, exact same-origin CSRF, and the body hard limit', async () => {
    const importChunk = vi.fn();
    const routes = createWxrCoreImportRoutes({
      resolveSession: vi.fn().mockResolvedValue(adminSession),
      importChunk,
    });
    expect((await routes.fetch(request({ ...postChunk, extra: true }), env())).status)
      .toBe(400);
    expect((await routes.fetch(request(postChunk, {
      Origin: 'https://other.example',
    }), env())).status).toBe(403);
    expect((await routes.fetch(request(postChunk, {
      'X-ZeroPress-CSRF': 'wrong-token',
    }), env())).status).toBe(403);

    const oversized = new Request('https://studio.local/core/chunk', {
      method: 'POST',
      headers: {
        Origin: 'https://studio.local',
        'Content-Type': 'application/json',
        'X-ZeroPress-CSRF': CSRF_TOKEN,
      },
      body: JSON.stringify({ phase: 'authors', rows: [{
        id: 'author', display_name: 'x'.repeat(8 * 1024 * 1024),
      }] }),
    });
    expect((await routes.fetch(oversized, env())).status).toBe(413);
    expect(importChunk).not.toHaveBeenCalled();
  });

  it('dispatches the final Comments phase directly to EDGE_DB', async () => {
    const importChunk = vi.fn();
    const importCommentChunk = vi.fn().mockResolvedValue({
      summary: {
        phase: 'comments', processed: 1, created: 1, updated: 0,
        unchanged: 0, failed: 0, failures: [],
      },
    });
    const flushProjectionAfterChunk = vi.fn();
    const drainProjections = vi.fn().mockResolvedValue({
      processedEvents: 1,
      remainingEvents: 0,
    });
    const routes = createWxrCoreImportRoutes({
      resolveSession: vi.fn().mockResolvedValue(adminSession),
      importChunk,
      importCommentChunk,
      flushProjectionAfterChunk,
      drainProjections,
      now: () => NOW,
    });
    const environment = env();
    const response = await routes.fetch(request(commentChunk), environment);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { phase: 'comments', created: 1 },
    });
    expect(importCommentChunk).toHaveBeenCalledWith({
      edgeDb: environment.EDGE_DB,
      request: commentChunk,
    });
    expect(importChunk).not.toHaveBeenCalled();
    expect(flushProjectionAfterChunk).not.toHaveBeenCalled();
    expect(drainProjections).toHaveBeenCalledWith({
      env: environment,
      limit: COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT,
      now: NOW,
    });
  });

  it('does not start Comments while target projection events remain', async () => {
    const importCommentChunk = vi.fn();
    const drainProjections = vi.fn().mockResolvedValue({
      processedEvents: 250,
      remainingEvents: 1,
    });
    const routes = createWxrCoreImportRoutes({
      resolveSession: vi.fn().mockResolvedValue(adminSession),
      importCommentChunk,
      drainProjections,
      now: () => NOW,
    });

    const response = await routes.fetch(request(commentChunk), env());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_TARGET_PROJECTION_PENDING' },
    });
    expect(importCommentChunk).not.toHaveBeenCalled();
  });

  it('dispatches the Menu phase to the Studio DB importer', async () => {
    const importChunk = vi.fn().mockResolvedValue({
      summary: {
        phase: 'menus', processed: 1, created: 1, updated: 0,
        unchanged: 0, failed: 0, failures: [],
      },
    });
    const importCommentChunk = vi.fn();
    const flushProjectionAfterChunk = vi.fn();
    const routes = createWxrCoreImportRoutes({
      resolveSession: vi.fn().mockResolvedValue(adminSession),
      importChunk,
      importCommentChunk,
      flushProjectionAfterChunk,
      now: () => NOW,
    });
    const environment = env();
    const response = await routes.fetch(request(menuChunk), environment);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { phase: 'menus', created: 1 },
    });
    expect(importChunk).toHaveBeenCalledWith({
      db: environment.DB,
      request: menuChunk,
      now: NOW,
      createId: undefined,
      createRevision: undefined,
    });
    expect(importCommentChunk).not.toHaveBeenCalled();
    expect(flushProjectionAfterChunk).not.toHaveBeenCalled();
  });

  it('rejects direct Comment chunks while preserving Studio-only phases', async () => {
    const importChunk = vi.fn().mockResolvedValue({
      summary: {
        phase: 'menus', processed: 1, created: 1, updated: 0,
        unchanged: 0, failed: 0, failures: [],
      },
    });
    const importCommentChunk = vi.fn();
    const flushProjectionAfterChunk = vi.fn();
    const routes = createWxrCoreImportRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(adminSession),
      importChunk,
      importCommentChunk,
      flushProjectionAfterChunk,
      readEdgeIntegrationMode: vi.fn().mockResolvedValue('disabled'),
      now: () => NOW,
    });
    const comments = await routes.fetch(request(commentChunk), env());
    expect(comments.status).toBe(409);
    await expect(comments.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_INTEGRATION_DISABLED' },
    });
    expect(importCommentChunk).not.toHaveBeenCalled();

    const menus = await routes.fetch(request(menuChunk), env());
    expect(menus.status).toBe(200);
    expect(importChunk).toHaveBeenCalledOnce();
    expect(flushProjectionAfterChunk).not.toHaveBeenCalled();
  });

  it('finalizes General and Routing settings through one authenticated request', async () => {
    const finalizeSettings = vi.fn().mockResolvedValue({
      kind: 'completed',
      generalSettings: {
        result: 'updated',
        document: {
          settings: finalizeBody.general_settings.settings,
          revision: '5'.repeat(32),
          updated_at_iso: NOW.toISOString(),
        },
      },
      routingSettings: {
        result: 'unchanged',
        document: {
          settings: routingSettings,
          revision: '4'.repeat(32),
          updated_at_iso: null,
        },
      },
    });
    const routes = createWxrCoreImportRoutes({
      resolveSession: vi.fn().mockResolvedValue(adminSession),
      finalizeSettings,
      now: () => NOW,
      createRevision: () => '5'.repeat(32),
    });
    const environment = env();
    const response = await routes.fetch(finalizeRequest(finalizeBody), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        general_settings: { result: 'updated' },
        routing_settings: { result: 'unchanged' },
      },
    });
    expect(finalizeSettings).toHaveBeenCalledWith({
      db: environment.DB,
      request: finalizeBody,
      updatedBy: adminSession.user.id,
      now: NOW,
      createRevision: expect.any(Function),
    });
  });

  it('maps stale finalization to a settings revision conflict', async () => {
    const finalizeSettings = vi.fn().mockResolvedValue({
      kind: 'revision_conflict',
    });
    const routes = createWxrCoreImportRoutes({
      resolveSession: vi.fn().mockResolvedValue(adminSession),
      finalizeSettings,
    });
    const response = await routes.fetch(finalizeRequest(finalizeBody), env());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'SETTINGS_REVISION_CONFLICT' },
    });
  });
});

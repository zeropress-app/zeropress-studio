import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createPageRoutes } from './routes';
import { ContentSearchQueryInvalidError } from '../../../contracts/content-search';
import { ContentSearchIndexNotReadyError } from '../content-search/index-repository';
import { materializeRoutingSettingsDefaults } from '../../../contracts/routing-settings';

const NOW = new Date('2026-08-01T08:00:00.000Z');
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const page = {
  id: '1'.repeat(32),
  public_id: 100_000_000_001,
  parent: null,
  title: 'About',
  slug: 'about',
  path: 'about',
  content: '# About',
  document_type: 'markdown' as const,
  editor_mode: 'source' as const,
  editor_profile: null,
  excerpt: 'About this site.',
  status: 'draft' as const,
  discoverability: 'default' as const,
  allow_comments: false,
  featured_image: null,
  revision: '2'.repeat(32),
  created_at_iso: NOW.toISOString(),
  updated_at_iso: NOW.toISOString(),
};

const editorSession = {
  user: {
    id: '3'.repeat(32),
    email: 'editor@example.com',
    name: 'Site Editor',
    roles: ['editor'],
  },
  session: { id: '4'.repeat(32) },
  csrfToken: CSRF_TOKEN,
  authRevision: '5'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;

function env(): Env {
  const edgeStatement = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true, results: [], meta: {} }),
  };
  return {
    DB: {} as D1Database,
    EDGE_DB: {
      prepare: vi.fn().mockReturnValue(edgeStatement),
    } as unknown as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

function mutationRequest(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`https://studio.local${path}`, {
    method,
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF_TOKEN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const authored = {
  parent_id: null,
  title: '  About  ',
  slug: 'about',
  content: '# About',
  document_type: 'markdown' as const,
  editor_mode: 'source' as const,
  editor_profile: null,
  excerpt: '  About this site.  ',
  status: 'draft' as const,
  discoverability: 'default' as const,
  allow_comments: false,
  featured_image_id: null,
};

const savedRevision = {
  revision_id: '6'.repeat(32),
  saved_at_iso: '2026-07-31T08:00:00.000Z',
  current: false,
  title: 'Earlier Page',
  status: 'draft' as const,
  snapshot: {
    version: 1 as const,
    content_type: 'page' as const,
    draft: {
      parent_id: null,
      title: 'Earlier Page',
      slug: 'earlier-page',
      content: '# Earlier',
      document_type: 'markdown' as const,
      excerpt: 'Earlier excerpt',
      status: 'draft' as const,
      discoverability: 'default' as const,
      allow_comments: true,
      featured_image_id: null,
    },
    references: { parent: null, featured_image: null },
  },
  snapshot_sha256: '9'.repeat(64),
};

describe('Page routes', () => {
  it('returns mixed bounded lifecycle results and drains only changed targets', async () => {
    const bulkLifecycle = vi.fn().mockResolvedValue({
      target_status: 'trash',
      results: [{
        id: page.id,
        outcome: 'skipped',
        reason: 'front_page_protected',
      }],
      summary: {
        requested: 1,
        updated: 0,
        unchanged: 0,
        conflict: 0,
        skipped: 1,
      },
    });
    const scheduleProjectionDrain = vi.fn();
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      bulkLifecycle,
      scheduleProjectionDrain,
      now: () => NOW,
    });
    const response = await routes.fetch(mutationRequest(
      '/bulk-lifecycle',
      'POST',
      {
        target_status: 'trash',
        items: [{ id: page.id, expected_revision: page.revision }],
      },
    ), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        results: [{ reason: 'front_page_protected' }],
        summary: { skipped: 1 },
      },
    });
    expect(bulkLifecycle).toHaveBeenCalledWith({
      db: expect.anything(),
      request: {
        target_status: 'trash',
        items: [{ id: page.id, expected_revision: page.revision }],
      },
      now: NOW,
      createRevision: undefined,
    });
    expect(scheduleProjectionDrain).not.toHaveBeenCalled();
  });

  it('discovers the latest recovery draft and schedules its outbox drain', async () => {
    const autosave = {
      draft_id: '8'.repeat(32),
      target_id: null,
      base_revision: null,
      snapshot: savedRevision.snapshot,
      snapshot_sha256: '9'.repeat(64),
      created_at_iso: NOW.toISOString(),
      updated_at_iso: NOW.toISOString(),
      expires_at_iso: '2026-08-08T08:00:00.000Z',
    };
    const readRecentAutosave = vi.fn().mockResolvedValue(autosave);
    const promoteAutosave = vi.fn().mockResolvedValue({
      kind: 'completed',
      page,
    });
    const syncCommentTarget = vi.fn();
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      readRecentAutosave,
      promoteAutosave,
      scheduleProjectionDrain: syncCommentTarget,
      now: () => NOW,
    });
    const recent = await routes.fetch(
      new Request('https://studio.local/autosave/recent'),
      env(),
    );
    expect(recent.status).toBe(200);
    expect((await recent.json())).toEqual({
      success: true,
      data: { autosave },
    });

    const promoted = await routes.fetch(mutationRequest(
      '/autosave/promote',
      'POST',
      { draft_id: autosave.draft_id },
    ), env());
    expect(promoted.status).toBe(201);
    expect((await promoted.json())).toEqual({
      success: true,
      data: { status: 'draft_promoted', page },
    });
    expect(syncCommentTarget).toHaveBeenCalledOnce();
  });

  it('deletes only the current user Page autosave through CSRF protection', async () => {
    const deleteAutosave = vi.fn().mockResolvedValue(true);
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      deleteAutosave,
    });
    const response = await routes.fetch(mutationRequest('/autosave', 'DELETE', {
      draft_id: '8'.repeat(32),
    }), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { status: 'autosave_deleted', deleted: true },
    });
    expect(deleteAutosave).toHaveBeenCalledWith({
      db: expect.anything(),
      userId: editorSession.user.id,
      draftId: '8'.repeat(32),
    });
    expect((await routes.fetch(mutationRequest('/autosave', 'DELETE', {
      draft_id: '8'.repeat(32),
    }, { Origin: 'https://other.example' }), env())).status).toBe(403);
  });

  it('allows editors, rejects authors, and returns list metadata', async () => {
    const listPages = vi.fn().mockResolvedValue({
      items: [{
        id: page.id,
        public_id: page.public_id,
        parent: page.parent,
        title: page.title,
        slug: page.slug,
        path: page.path,
        document_type: page.document_type,
        excerpt: page.excerpt,
        status: page.status,
        discoverability: page.discoverability,
        allow_comments: page.allow_comments,
        revision: page.revision,
        created_at_iso: page.created_at_iso,
        updated_at_iso: page.updated_at_iso,
        search_match: null,
      }],
      pagination: { page: 1, per_page: 50, total: 1, total_pages: 1 },
      status_counts: { all: 1, draft: 1, published: 0, trash: 0 },
    });
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listPages,
      readRoutingSettings: vi.fn().mockResolvedValue({
        settings: {
          ...materializeRoutingSettingsDefaults(),
          permalinks: {
            ...materializeRoutingSettingsDefaults().permalinks,
            pages: '/content/:slug/',
          },
        },
        revision: 'a'.repeat(32),
        updated_at_iso: null,
      }),
    });
    const response = await routes.fetch(new Request(
      'https://studio.local/?search=About&status=draft&page=1&per_page=50',
    ), env());
    expect(response.status).toBe(200);
    expect(listPages).toHaveBeenCalledWith({
      db: expect.anything(),
      query: { search: 'About', status: 'draft', page: 1, per_page: 50 },
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        items: [{ public_url: '/content/about/' }],
      },
    });

    const denied = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...editorSession,
        user: { ...editorSession.user, roles: ['author'] },
      }),
      listPages: vi.fn(),
    });
    expect((await denied.fetch(
      new Request('https://studio.local/'), env(),
    )).status).toBe(403);
  });

  it('returns stable semantic and lifecycle errors for Page searches', async () => {
    const invalid = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listPages: vi.fn().mockRejectedValue(new ContentSearchQueryInvalidError()),
    });
    const invalidResponse = await invalid.fetch(
      new Request('https://studio.local/?search=%2B%2F*'),
      env(),
    );
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toEqual({
      success: false,
      error: { code: 'CONTENT_SEARCH_QUERY_INVALID' },
    });

    const notReady = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listPages: vi.fn().mockRejectedValue(
        new ContentSearchIndexNotReadyError('rebuild_required'),
      ),
    });
    const notReadyResponse = await notReady.fetch(
      new Request('https://studio.local/?search=guide'),
      env(),
    );
    expect(notReadyResponse.status).toBe(503);
    await expect(notReadyResponse.json()).resolves.toEqual({
      success: false,
      error: { code: 'CONTENT_SEARCH_INDEX_NOT_READY' },
    });
  });

  it('returns parent options with current Page context', async () => {
    const listParentOptions = vi.fn().mockResolvedValue([{
      id: '6'.repeat(32),
      title: 'Docs',
      slug: 'docs',
      path: 'docs',
    }]);
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listParentOptions,
    });
    const response = await routes.fetch(new Request(
      `https://studio.local/parent-options?search=Docs&current_page_id=${page.id}`,
    ), env());
    expect(response.status).toBe(200);
    expect(listParentOptions).toHaveBeenCalledWith({
      db: expect.anything(),
      search: 'Docs',
      currentPageId: page.id,
    });
  });

  it('creates canonical Page input only with exact same-origin CSRF', async () => {
    const createPage = vi.fn().mockResolvedValue({ kind: 'completed', page });
    const syncCommentTarget = vi.fn().mockResolvedValue(undefined);
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createPage,
      scheduleProjectionDrain: syncCommentTarget,
      now: () => NOW,
      createId: () => page.id,
      createRevision: () => page.revision,
    });
    const response = await routes.fetch(
      mutationRequest('/', 'POST', authored), env(),
    );
    expect(response.status).toBe(201);
    expect(createPage).toHaveBeenCalledWith({
      db: expect.anything(),
      authored: {
        ...authored,
        title: page.title,
        excerpt: page.excerpt,
      },
      now: NOW,
      createId: expect.any(Function),
      createRevision: expect.any(Function),
      autosaveUserId: '3'.repeat(32),
    });
    expect(syncCommentTarget).toHaveBeenCalledOnce();
    expect((await routes.fetch(mutationRequest('/', 'POST', authored, {
      Origin: 'https://other.example',
    }), env())).status).toBe(403);
    expect(createPage).toHaveBeenCalledTimes(1);
  });

  it('maps Page hierarchy and lifecycle conflicts', async () => {
    const createPage = vi.fn()
      .mockResolvedValueOnce({ kind: 'slug_conflict' })
      .mockResolvedValueOnce({ kind: 'parent_not_found' });
    const updatePage = vi.fn()
      .mockResolvedValueOnce({ kind: 'parent_cycle' })
      .mockResolvedValueOnce({ kind: 'has_children' })
      .mockResolvedValueOnce({ kind: 'revision_conflict' });
    const deletePage = vi.fn()
      .mockResolvedValueOnce({ kind: 'not_in_trash' })
      .mockResolvedValueOnce({ kind: 'has_children' })
      .mockResolvedValueOnce({
        kind: 'completed',
        publicId: page.public_id,
      });
    const deleteCommentTarget = vi.fn().mockResolvedValue(undefined);
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createPage,
      updatePage,
      deletePage,
      scheduleProjectionDrain: deleteCommentTarget,
    });
    const duplicate = await routes.fetch(
      mutationRequest('/', 'POST', authored), env(),
    );
    await expect(duplicate.json()).resolves.toEqual({
      success: false,
      error: { code: 'PAGE_SLUG_CONFLICT' },
    });
    expect((await routes.fetch(
      mutationRequest('/', 'POST', authored), env(),
    )).status).toBe(404);

    const updateBody = { ...authored, expected_revision: page.revision };
    for (const expectedStatus of [409, 409, 409]) {
      expect((await routes.fetch(mutationRequest(
        `/${page.id}`, 'PUT', updateBody,
      ), env())).status).toBe(expectedStatus);
    }
    for (const expectedStatus of [409, 409, 200]) {
      expect((await routes.fetch(mutationRequest(
        `/${page.id}`, 'DELETE', { expected_revision: page.revision },
      ), env())).status).toBe(expectedStatus);
    }
    expect(deleteCommentTarget).toHaveBeenCalledOnce();
  });

  it('restores a saved Page revision through the atomic canonical update path', async () => {
    const restoredPage = {
      ...page,
      title: savedRevision.snapshot.draft.title,
      slug: savedRevision.snapshot.draft.slug,
      path: savedRevision.snapshot.draft.slug,
      content: savedRevision.snapshot.draft.content,
      excerpt: savedRevision.snapshot.draft.excerpt,
      allow_comments: true,
      revision: '7'.repeat(32),
    };
    const updatePage = vi.fn().mockResolvedValue({
      kind: 'completed',
      page: restoredPage,
    });
    const syncCommentTarget = vi.fn().mockResolvedValue(undefined);
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      getPage: vi.fn().mockResolvedValue(page),
      readRevision: vi.fn().mockResolvedValue(savedRevision),
      updatePage,
      scheduleProjectionDrain: syncCommentTarget,
      now: () => NOW,
      createRevision: () => restoredPage.revision,
    });
    const response = await routes.fetch(mutationRequest(
      `/${page.id}/revisions/${savedRevision.revision_id}/restore`,
      'POST',
      { expected_revision: page.revision },
    ), env());
    expect(response.status).toBe(200);
    expect(updatePage).toHaveBeenCalledWith({
      db: expect.anything(),
      id: page.id,
      authored: {
        ...savedRevision.snapshot.draft,
        editor_mode: 'source',
        editor_profile: null,
        expected_revision: page.revision,
      },
      now: NOW,
      createRevision: expect.any(Function),
      beforeStatusChange: expect.any(Function),
      autosaveUserId: editorSession.user.id,
    });
    expect(syncCommentTarget).toHaveBeenCalledOnce();
  });

  it('rejects malformed IDs and oversized request bodies before writes', async () => {
    const updatePage = vi.fn();
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      updatePage,
    });
    expect((await routes.fetch(mutationRequest(
      '/not-an-id',
      'PUT',
      { ...authored, expected_revision: page.revision },
    ), env())).status).toBe(400);
    const oversized = new Request('https://studio.local/', {
      method: 'POST',
      headers: {
        Origin: 'https://studio.local',
        'Content-Type': 'application/json',
        'Content-Length': String(8 * 1024 * 1024 + 1),
        'X-ZeroPress-CSRF': CSRF_TOKEN,
      },
      body: '{}',
    });
    expect((await routes.fetch(oversized, env())).status).toBe(413);
    expect(updatePage).not.toHaveBeenCalled();
  });

  it('maps Front Page protection to a stable semantic conflict', async () => {
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      updatePage: vi.fn().mockResolvedValue({
        kind: 'front_page_protected',
      }),
      deletePage: vi.fn().mockResolvedValue({
        kind: 'front_page_protected',
      }),
    });
    const update = await routes.fetch(mutationRequest(
      `/${page.id}`,
      'PUT',
      { ...authored, expected_revision: page.revision },
    ), env());
    expect(update.status).toBe(409);
    await expect(update.json()).resolves.toEqual({
      success: false,
      error: { code: 'PAGE_IS_FRONT_PAGE' },
    });
    const remove = await routes.fetch(mutationRequest(
      `/${page.id}`,
      'DELETE',
      { expected_revision: page.revision },
    ), env());
    expect(remove.status).toBe(409);
    await expect(remove.json()).resolves.toEqual({
      success: false,
      error: { code: 'PAGE_IS_FRONT_PAGE' },
    });
  });
});

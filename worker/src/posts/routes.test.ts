import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createPostRoutes } from './routes';
import { ContentSearchQueryInvalidError } from '../../../contracts/content-search';
import { ContentSearchIndexNotReadyError } from '../content-search/index-repository';
import { materializeRoutingSettingsDefaults } from '../../../contracts/routing-settings';

const NOW = new Date('2026-08-01T08:00:00.000Z');
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const post = {
  id: '1'.repeat(32),
  public_id: 100_000_000_001,
  title: 'First Post',
  slug: 'first-post',
  content: '# Hello',
  document_type: 'markdown' as const,
  editor_mode: 'source' as const,
  editor_profile: null,
  excerpt: 'Hello',
  status: 'draft' as const,
  author: {
    id: 'Studio-Owner',
    display_name: 'Studio Owner',
  },
  categories: [{
    id: '2'.repeat(32),
    name: 'News',
    slug: 'news',
  }],
  tags: [{
    id: '3'.repeat(32),
    name: 'Featured',
    slug: 'featured',
  }],
  discoverability: 'default' as const,
  allow_comments: true,
  featured_image: null,
  published_at_iso: null,
  revision: '4'.repeat(32),
  created_at_iso: NOW.toISOString(),
  updated_at_iso: NOW.toISOString(),
};

const editorSession = {
  user: {
    id: '5'.repeat(32),
    email: 'editor@example.com',
    name: 'Site Editor',
    roles: ['editor'],
  },
  session: { id: '6'.repeat(32) },
  csrfToken: CSRF_TOKEN,
  authRevision: '7'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;

const authorSession = {
  ...editorSession,
  user: {
    ...editorSession.user,
    roles: ['author'],
  },
} as ResolvedSession;

const adminSession = {
  ...editorSession,
  user: {
    ...editorSession.user,
    roles: ['admin'],
  },
} as ResolvedSession;

const ownAccess = {
  scope: 'own' as const,
  author: post.author,
};

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
  title: '  First Post  ',
  slug: 'first-post',
  content: '# Hello',
  document_type: 'markdown' as const,
  editor_mode: 'source' as const,
  editor_profile: null,
  excerpt: '  Hello  ',
  status: 'draft' as const,
  author_id: post.author.id,
  category_ids: [post.categories[0].id],
  tag_ids: [post.tags[0].id],
  discoverability: 'default' as const,
  allow_comments: true,
  featured_image_id: null,
};

const savedRevision = {
  revision_id: '8'.repeat(32),
  saved_at_iso: '2026-07-31T08:00:00.000Z',
  current: false,
  title: 'Earlier Post',
  status: 'draft' as const,
  snapshot: {
    version: 1 as const,
    content_type: 'post' as const,
    draft: {
      title: 'Earlier Post',
      slug: 'earlier-post',
      content: '# Earlier',
      document_type: 'markdown' as const,
      excerpt: 'Earlier excerpt',
      status: 'draft' as const,
      author_id: post.author.id,
      category_ids: [post.categories[0].id],
      tag_ids: [post.tags[0].id],
      discoverability: 'default' as const,
      allow_comments: false,
      featured_image_id: null,
    },
    references: {
      author: post.author,
      categories: post.categories,
      tags: post.tags,
      featured_image: null,
    },
  },
  snapshot_sha256: '9'.repeat(64),
};

describe('Post routes', () => {
  it('runs bounded lifecycle changes in the caller Post scope and schedules one drain', async () => {
    const bulkLifecycle = vi.fn().mockResolvedValue({
      target_status: 'published',
      results: [{
        id: post.id,
        outcome: 'updated',
        status: 'published',
        revision: '8'.repeat(32),
      }],
      summary: {
        requested: 1,
        updated: 1,
        unchanged: 0,
        conflict: 0,
        skipped: 0,
      },
    });
    const scheduleProjectionDrain = vi.fn();
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(authorSession),
      resolveAccess: vi.fn().mockResolvedValue(ownAccess),
      bulkLifecycle,
      scheduleProjectionDrain,
      now: () => NOW,
    });
    const response = await routes.fetch(mutationRequest(
      '/bulk-lifecycle',
      'POST',
      {
        target_status: 'published',
        items: [{ id: post.id, expected_revision: post.revision }],
      },
    ), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { summary: { updated: 1 } },
    });
    expect(bulkLifecycle).toHaveBeenCalledWith({
      db: expect.anything(),
      request: {
        target_status: 'published',
        items: [{ id: post.id, expected_revision: post.revision }],
      },
      authorScope: {
        authorId: post.author.id,
        userId: authorSession.user.id,
      },
      now: NOW,
      createRevision: undefined,
    });
    expect(scheduleProjectionDrain).toHaveBeenCalledOnce();

    const duplicate = await routes.fetch(mutationRequest(
      '/bulk-lifecycle',
      'POST',
      {
        target_status: 'draft',
        items: [
          { id: post.id, expected_revision: post.revision },
          { id: post.id, expected_revision: post.revision },
        ],
      },
    ), env());
    expect(duplicate.status).toBe(400);
    expect(bulkLifecycle).toHaveBeenCalledOnce();
  });

  it('discovers the latest unbound recovery draft and schedules its outbox drain', async () => {
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
      post,
    });
    const syncCommentTarget = vi.fn();
    const routes = createPostRoutes({
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
    expect(readRecentAutosave).toHaveBeenCalledWith({
      db: expect.anything(),
      userId: editorSession.user.id,
      now: NOW,
    });

    const promoted = await routes.fetch(mutationRequest(
      '/autosave/promote',
      'POST',
      { draft_id: autosave.draft_id },
    ), env());
    expect(promoted.status).toBe(201);
    expect((await promoted.json())).toEqual({
      success: true,
      data: { status: 'draft_promoted', post },
    });
    expect(promoteAutosave).toHaveBeenCalledWith(expect.objectContaining({
      db: expect.anything(),
      userId: editorSession.user.id,
      draftId: autosave.draft_id,
      now: NOW,
    }));
    expect(syncCommentTarget).toHaveBeenCalledOnce();
  });

  it('reads user-scoped autosaves and rejects stale autosave writes', async () => {
    const readAutosave = vi.fn().mockResolvedValue(null);
    const putAutosave = vi.fn().mockResolvedValue({
      kind: 'revision_conflict',
    });
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      readAutosave,
      putAutosave,
      now: () => NOW,
    });
    const read = await routes.fetch(new Request(
      `https://studio.local/autosave?target_id=${post.id}`,
    ), env());
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ success: true, data: { autosave: null } });
    expect(readAutosave).toHaveBeenCalledWith({
      db: expect.anything(),
      userId: editorSession.user.id,
      locator: { targetId: post.id },
      now: NOW,
    });

    const write = await routes.fetch(mutationRequest('/autosave', 'PUT', {
      draft_id: '8'.repeat(32),
      target_id: post.id,
      base_revision: post.revision,
      snapshot: {
        version: 2,
        content_type: 'post',
        draft: {
          ...authored,
          title: post.title,
          excerpt: post.excerpt,
        },
        references: {
          author: post.author,
          categories: post.categories,
          tags: post.tags,
          featured_image: null,
        },
      },
    }), env());
    expect(write.status).toBe(409);
    expect((await write.json())).toEqual({
      success: false,
      error: { code: 'POST_REVISION_CONFLICT' },
    });
  });

  it('returns list metadata and scopes Authors to their linked profile', async () => {
    // Response parsing is intentionally exercised with the exact summary shape.
    const listPosts = vi.fn().mockResolvedValue({
      items: [{
        id: post.id,
        public_id: post.public_id,
        title: post.title,
        slug: post.slug,
        document_type: post.document_type,
        excerpt: post.excerpt,
        status: post.status,
        author: post.author,
        discoverability: post.discoverability,
        allow_comments: post.allow_comments,
        published_at_iso: post.published_at_iso,
        revision: post.revision,
        created_at_iso: post.created_at_iso,
        updated_at_iso: post.updated_at_iso,
        search_match: null,
      }],
      pagination: { page: 1, per_page: 50, total: 1, total_pages: 1 },
      status_counts: { all: 1, draft: 1, published: 0, trash: 0 },
    });
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listPosts,
      readGeneralSettings: vi.fn().mockResolvedValue({
        settings: {
          title: 'Example',
          description: '',
          url: 'https://example.com',
          locale: 'en-US',
          timezone: '+09:00',
        },
        revision: 'a'.repeat(32),
        updated_at_iso: null,
      }),
      readRoutingSettings: vi.fn().mockResolvedValue({
        settings: {
          ...materializeRoutingSettingsDefaults(),
          permalinks: {
            ...materializeRoutingSettingsDefaults().permalinks,
            output_style: 'html-extension',
            posts: '/post/:public_id/',
          },
        },
        revision: 'b'.repeat(32),
        updated_at_iso: null,
      }),
    });
    const response = await routes.fetch(new Request(
      'https://studio.local/?search=First&status=draft&author_id=Studio-Owner&page=1&per_page=50',
    ), env());
    expect(response.status).toBe(200);
    expect(listPosts).toHaveBeenCalledWith({
      db: expect.anything(),
      query: {
        search: 'First',
        status: 'draft',
        author_id: 'Studio-Owner',
        page: 1,
        per_page: 50,
      },
      authorId: 'Studio-Owner',
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        items: [{ public_url: '/post/100000000001' }],
      },
    });

    const authorList = vi.fn().mockResolvedValue({
      items: [],
      pagination: { page: 1, per_page: 50, total: 0, total_pages: 0 },
      status_counts: { all: 0, draft: 0, published: 0, trash: 0 },
    });
    const authorRoutes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(authorSession),
      resolveAccess: vi.fn().mockResolvedValue(ownAccess),
      listPosts: authorList,
    });
    const authorResponse = await authorRoutes.fetch(
      new Request('https://studio.local/'), env(),
    );
    expect(authorResponse.status).toBe(200);
    await expect(authorResponse.json()).resolves.toMatchObject({
      success: true,
      data: { access: ownAccess },
    });
    expect(authorList).toHaveBeenCalledWith({
      db: expect.anything(),
      query: { search: '', status: 'all', page: 1, per_page: 50 },
      authorId: post.author.id,
    });

    const injectedFilter = await authorRoutes.fetch(
      new Request(
        'https://studio.local/?author_id=Other-Author',
      ),
      env(),
    );
    expect(injectedFilter.status).toBe(403);
    await expect(injectedFilter.json()).resolves.toEqual({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(authorList).toHaveBeenCalledOnce();
  });

  it('returns stable semantic and lifecycle errors for Post searches', async () => {
    const invalid = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listPosts: vi.fn().mockRejectedValue(new ContentSearchQueryInvalidError()),
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

    const notReady = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listPosts: vi.fn().mockRejectedValue(
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

  it('fails closed when an Author has no linked public profile', async () => {
    const listPosts = vi.fn().mockResolvedValue({
      items: [],
      pagination: { page: 1, per_page: 50, total: 0, total_pages: 0 },
      status_counts: { all: 0, draft: 0, published: 0, trash: 0 },
    });
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(authorSession),
      resolveAccess: vi.fn().mockResolvedValue({
        scope: 'unavailable',
        reason: 'author_not_linked',
      }),
      listPosts,
      createPost: vi.fn(),
    });
    const listResponse = await routes.fetch(
      new Request('https://studio.local/'), env(),
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        access: { scope: 'unavailable', reason: 'author_not_linked' },
        items: [],
      },
    });
    expect(listPosts).toHaveBeenCalledWith({
      db: expect.anything(),
      query: { search: '', status: 'all', page: 1, per_page: 50 },
      authorId: null,
    });

    const createResponse = await routes.fetch(
      mutationRequest('/', 'POST', authored), env(),
    );
    expect(createResponse.status).toBe(409);
    await expect(createResponse.json()).resolves.toEqual({
      success: false,
      error: { code: 'POST_AUTHOR_NOT_LINKED' },
    });
  });

  it('enforces Author ownership on Post detail and mutations', async () => {
    const getPost = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(post);
    const createPost = vi.fn().mockResolvedValue({ kind: 'completed', post });
    const updatePost = vi.fn().mockResolvedValue({ kind: 'completed', post });
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(authorSession),
      resolveAccess: vi.fn().mockResolvedValue(ownAccess),
      getPost,
      createPost,
      updatePost,
      scheduleProjectionDrain: vi.fn(),
    });

    const foreignDetail = await routes.fetch(
      new Request(`https://studio.local/${post.id}`), env(),
    );
    expect(foreignDetail.status).toBe(404);
    expect(getPost).toHaveBeenNthCalledWith(1, {
      db: expect.anything(),
      id: post.id,
      authorId: post.author.id,
    });

    const mismatchedCreate = await routes.fetch(mutationRequest('/', 'POST', {
      ...authored,
      author_id: 'Other-Author',
    }), env());
    expect(mismatchedCreate.status).toBe(403);
    expect(createPost).not.toHaveBeenCalled();

    const createResponse = await routes.fetch(
      mutationRequest('/', 'POST', authored), env(),
    );
    expect(createResponse.status).toBe(201);
    expect(createPost).toHaveBeenCalledWith(expect.objectContaining({
      authorScope: {
        authorId: post.author.id,
        userId: authorSession.user.id,
      },
    }));

    const updateResponse = await routes.fetch(mutationRequest(
      `/${post.id}`,
      'PUT',
      { ...authored, expected_revision: post.revision },
    ), env());
    expect(updateResponse.status).toBe(200);
    expect(updatePost).toHaveBeenCalledWith(expect.objectContaining({
      id: post.id,
      authorScope: {
        authorId: post.author.id,
        userId: authorSession.user.id,
      },
    }));
  });

  it('hides foreign Post autosaves, revisions, restores, and deletion', async () => {
    const readAutosave = vi.fn();
    const putAutosave = vi.fn();
    const listRevisions = vi.fn();
    const readRevision = vi.fn();
    const updatePost = vi.fn();
    const deletePost = vi.fn();
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(authorSession),
      resolveAccess: vi.fn().mockResolvedValue(ownAccess),
      getPost: vi.fn().mockResolvedValue(null),
      readAutosave,
      putAutosave,
      listRevisions,
      readRevision,
      updatePost,
      deletePost,
    });
    const autosaveSnapshot = {
      version: 2,
      content_type: 'post',
      draft: { ...authored, title: post.title, excerpt: post.excerpt },
      references: {
        author: post.author,
        categories: post.categories,
        tags: post.tags,
        featured_image: null,
      },
    };
    const responses = [
      await routes.fetch(new Request(
        `https://studio.local/autosave?target_id=${post.id}`,
      ), env()),
      await routes.fetch(mutationRequest('/autosave', 'PUT', {
        draft_id: '8'.repeat(32),
        target_id: post.id,
        base_revision: post.revision,
        snapshot: autosaveSnapshot,
      }), env()),
      await routes.fetch(new Request(
        `https://studio.local/${post.id}/revisions`,
      ), env()),
      await routes.fetch(new Request(
        `https://studio.local/${post.id}/revisions/${savedRevision.revision_id}`,
      ), env()),
      await routes.fetch(mutationRequest(
        `/${post.id}/revisions/${savedRevision.revision_id}/restore`,
        'POST',
        { expected_revision: post.revision },
      ), env()),
      await routes.fetch(mutationRequest(
        `/${post.id}`,
        'DELETE',
        { expected_revision: post.revision },
      ), env()),
    ];
    expect(responses.map((response) => response.status))
      .toEqual([404, 404, 404, 404, 404, 404]);
    for (const operation of [
      readAutosave,
      putAutosave,
      listRevisions,
      readRevision,
      updatePost,
      deletePost,
    ]) expect(operation).not.toHaveBeenCalled();
  });

  it('returns bounded searchable editor options', async () => {
    const listOptions = vi.fn().mockResolvedValue([{
      kind: 'author',
      id: post.author.id,
      label: post.author.display_name,
      slug: null,
    }]);
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listOptions,
    });
    const response = await routes.fetch(new Request(
      'https://studio.local/options?kind=author&search=Owner',
    ), env());
    expect(response.status).toBe(200);
    expect(listOptions).toHaveBeenCalledWith({
      db: expect.anything(),
      kind: 'author',
      search: 'Owner',
    });
  });

  it('creates canonical Post input only with exact same-origin CSRF', async () => {
    const createPost = vi.fn().mockResolvedValue({
      kind: 'completed',
      post,
    });
    const syncCommentTarget = vi.fn().mockResolvedValue(undefined);
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createPost,
      scheduleProjectionDrain: syncCommentTarget,
      now: () => NOW,
      createId: () => post.id,
      createRevision: () => post.revision,
    });
    const response = await routes.fetch(
      mutationRequest('/', 'POST', authored), env(),
    );
    expect(response.status).toBe(201);
    expect(createPost).toHaveBeenCalledWith({
      db: expect.anything(),
      authored: {
        ...authored,
        title: post.title,
        excerpt: post.excerpt,
      },
      now: NOW,
      createId: expect.any(Function),
      createRevision: expect.any(Function),
      autosaveUserId: '5'.repeat(32),
    });
    expect(syncCommentTarget).toHaveBeenCalledOnce();
    expect((await routes.fetch(mutationRequest('/', 'POST', authored, {
      Origin: 'https://other.example',
    }), env())).status).toBe(403);
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it('maps Post, revision, slug, and reference conflicts', async () => {
    const createPost = vi.fn()
      .mockResolvedValueOnce({ kind: 'slug_conflict' })
      .mockResolvedValueOnce({ kind: 'author_not_found' })
      .mockResolvedValueOnce({ kind: 'category_not_found' });
    const updatePost = vi.fn()
      .mockResolvedValueOnce({ kind: 'revision_conflict' })
      .mockResolvedValueOnce({ kind: 'not_found' });
    const deletePost = vi.fn()
      .mockResolvedValueOnce({ kind: 'not_in_trash' })
      .mockResolvedValueOnce({
        kind: 'completed',
        publicId: post.public_id,
      });
    const deleteCommentTarget = vi.fn().mockResolvedValue(undefined);
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createPost,
      updatePost,
      deletePost,
      scheduleProjectionDrain: deleteCommentTarget,
    });

    const duplicate = await routes.fetch(
      mutationRequest('/', 'POST', authored), env(),
    );
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({
      success: false,
      error: { code: 'POST_SLUG_CONFLICT' },
    });
    expect((await routes.fetch(
      mutationRequest('/', 'POST', authored), env(),
    )).status).toBe(404);
    expect((await routes.fetch(
      mutationRequest('/', 'POST', authored), env(),
    )).status).toBe(404);

    const updateBody = {
      ...authored,
      expected_revision: post.revision,
    };
    expect((await routes.fetch(mutationRequest(
      `/${post.id}`, 'PUT', updateBody,
    ), env())).status).toBe(409);
    expect((await routes.fetch(mutationRequest(
      `/${post.id}`, 'PUT', updateBody,
    ), env())).status).toBe(404);
    expect((await routes.fetch(mutationRequest(
      `/${post.id}`,
      'DELETE',
      { expected_revision: post.revision },
    ), env())).status).toBe(409);
    expect((await routes.fetch(mutationRequest(
      `/${post.id}`,
      'DELETE',
      { expected_revision: post.revision },
    ), env())).status).toBe(200);
    expect(deleteCommentTarget).toHaveBeenCalledOnce();
  });

  it('lists, compares, and restores a saved Post revision through canonical update', async () => {
    const restoredPost = {
      ...post,
      title: savedRevision.snapshot.draft.title,
      slug: savedRevision.snapshot.draft.slug,
      content: savedRevision.snapshot.draft.content,
      excerpt: savedRevision.snapshot.draft.excerpt,
      allow_comments: false,
      revision: 'a'.repeat(32),
    };
    const getPost = vi.fn().mockResolvedValue(post);
    const listRevisions = vi.fn().mockResolvedValue({
      current_revision: post.revision,
      items: [{
        revision_id: post.revision,
        saved_at_iso: post.updated_at_iso,
        current: true,
        title: post.title,
        status: post.status,
      }, {
        revision_id: savedRevision.revision_id,
        saved_at_iso: savedRevision.saved_at_iso,
        current: false,
        title: savedRevision.title,
        status: savedRevision.status,
      }],
    });
    const readRevision = vi.fn().mockResolvedValue(savedRevision);
    const updatePost = vi.fn().mockResolvedValue({
      kind: 'completed',
      post: restoredPost,
    });
    const syncCommentTarget = vi.fn().mockResolvedValue(undefined);
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      getPost,
      listRevisions,
      readRevision,
      updatePost,
      scheduleProjectionDrain: syncCommentTarget,
      now: () => NOW,
      createRevision: () => restoredPost.revision,
    });

    const listResponse = await routes.fetch(new Request(
      `https://studio.local/${post.id}/revisions`,
    ), env());
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json() as {
      success: boolean;
      data: { current_revision: string; items: Array<{ current: boolean }> };
    };
    expect(listBody).toMatchObject({
      success: true,
      data: { current_revision: post.revision },
    });
    expect(listBody.data.items).toHaveLength(2);
    expect(listBody.data.items[0]).toMatchObject({ current: true });

    const detailResponse = await routes.fetch(new Request(
      `https://studio.local/${post.id}/revisions/${savedRevision.revision_id}`,
    ), env());
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      success: true,
      data: { revision_id: savedRevision.revision_id, current: false },
    });

    const restoreResponse = await routes.fetch(mutationRequest(
      `/${post.id}/revisions/${savedRevision.revision_id}/restore`,
      'POST',
      { expected_revision: post.revision },
    ), env());
    expect(restoreResponse.status).toBe(200);
    expect(updatePost).toHaveBeenCalledWith({
      db: expect.anything(),
      id: post.id,
      authored: {
        ...savedRevision.snapshot.draft,
        editor_mode: 'source',
        editor_profile: null,
        expected_revision: post.revision,
      },
      now: NOW,
      createRevision: expect.any(Function),
      autosaveUserId: editorSession.user.id,
    });
    expect(syncCommentTarget).toHaveBeenCalledOnce();
  });

  it('distinguishes missing saved Post revisions and restore conflicts', async () => {
    const readRevision = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(savedRevision);
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      getPost: vi.fn().mockResolvedValue(post),
      readRevision,
      updatePost: vi.fn().mockResolvedValue({ kind: 'revision_conflict' }),
    });
    const missing = await routes.fetch(new Request(
      `https://studio.local/${post.id}/revisions/${savedRevision.revision_id}`,
    ), env());
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      success: false,
      error: { code: 'POST_SAVED_REVISION_NOT_FOUND' },
    });
    const conflict = await routes.fetch(mutationRequest(
      `/${post.id}/revisions/${savedRevision.revision_id}/restore`,
      'POST',
      { expected_revision: post.revision },
    ), env());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      success: false,
      error: { code: 'POST_REVISION_CONFLICT' },
    });
  });

  it('rejects malformed IDs and oversized request bodies before writes', async () => {
    const updatePost = vi.fn();
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      updatePost,
    });
    expect((await routes.fetch(mutationRequest(
      '/not-an-id',
      'PUT',
      { ...authored, expected_revision: post.revision },
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
    expect(updatePost).not.toHaveBeenCalled();
  });

  it('materializes and queues one explicit notification for a published Post revision', async () => {
    const published = {
      ...post,
      status: 'published' as const,
      published_at_iso: NOW.toISOString(),
    };
    const prepareNotification = vi.fn().mockResolvedValue({
      kind: 'prepared',
      newsletterId: 'a'.repeat(32),
      idempotencyPrefix: `post-notification:${post.id}:${post.revision}:`,
      recipientCount: 12,
      newlyQueuedCount: 12,
      pendingCount: 12,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(adminSession),
      getPost: vi.fn().mockResolvedValue(published),
      readMailSettings: vi.fn().mockResolvedValue({ configured: true }),
      readGeneralSettings: vi.fn().mockResolvedValue({
        settings: { timezone: 'UTC' },
      }),
      readRoutingSettings: vi.fn().mockResolvedValue({
        settings: materializeRoutingSettingsDefaults(),
      }),
      readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
      inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
        state: 'ready',
        reason: 'ready',
        currentSchemaVersion: 3,
      }),
      preparePostNotification: prepareNotification,
      now: () => NOW,
    });
    const bindings = {
      ...env(),
      MAIL_QUEUE: { send } as unknown as Queue,
    };
    const response = await routes.fetch(mutationRequest(
      `/${post.id}/newsletter-notification`,
      'POST',
      { expected_revision: post.revision },
    ), bindings);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'queued',
        post_id: post.id,
        post_revision: post.revision,
        recipient_count: 12,
        newly_queued_count: 12,
      },
    });
    expect(prepareNotification).toHaveBeenCalledWith(expect.objectContaining({
      postId: post.id,
      postRevision: post.revision,
      subject: 'New post: First Post',
      now: NOW,
    }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      contract_version: 1,
      type: 'newsletter.post_notification.dispatch',
      snapshot: expect.objectContaining({
        post_id: post.id,
        post_revision: post.revision,
        public_path: '/posts/first-post/',
      }),
      after_idempotency_key: null,
    }));
  });

  it('requires Newsletter management and a published current revision before queuing', async () => {
    const send = vi.fn();
    const editorRoutes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
    });
    const bindings = {
      ...env(),
      MAIL_QUEUE: { send } as unknown as Queue,
    };
    const forbidden = await editorRoutes.fetch(mutationRequest(
      `/${post.id}/newsletter-notification`,
      'POST',
      { expected_revision: post.revision },
    ), bindings);
    expect(forbidden.status).toBe(403);

    const draftRoutes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(adminSession),
      getPost: vi.fn().mockResolvedValue(post),
      readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
      inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
        state: 'ready', reason: 'ready', currentSchemaVersion: 3,
      }),
    });
    const draft = await draftRoutes.fetch(mutationRequest(
      `/${post.id}/newsletter-notification`,
      'POST',
      { expected_revision: post.revision },
    ), bindings);
    expect(draft.status).toBe(409);
    await expect(draft.json()).resolves.toEqual({
      success: false,
      error: { code: 'NEWSLETTER_POST_NOTIFICATION_REQUIRES_PUBLISHED' },
    });
    expect(send).not.toHaveBeenCalled();
  });
});

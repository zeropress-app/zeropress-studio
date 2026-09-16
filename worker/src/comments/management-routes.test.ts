import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import {
  createCommentManagementRoutes as createCommentManagementRoutesImpl,
} from './management-routes';

function createCommentManagementRoutes(
  dependencies: Parameters<typeof createCommentManagementRoutesImpl>[0],
) {
  return createCommentManagementRoutesImpl({
    ...dependencies,
    readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
    inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
      state: 'ready', reason: 'ready', currentSchemaVersion: 3,
    }),
  });
}

const NOW = new Date('2026-08-02T00:00:00.000Z');
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const comment = {
  id: '1'.repeat(32),
  public_id: 101,
  target_type: 'post' as const,
  target_public_id: 100_000_000_001,
  target: {
    type: 'post' as const,
    id: '2'.repeat(32),
    public_id: 100_000_000_001,
    title: 'First Post',
    slug: 'first-post',
  },
  parent_public_id: null,
  reply: { available: false as const, reason: 'not_approved' as const },
  author: {
    name: 'Reader',
    email: 'reader@example.com',
    kind: 'guest' as const,
  },
  content_text: 'Hello',
  status: 'pending' as const,
  ip_address: '203.0.113.1',
  user_agent: 'Example browser',
  created_at_iso: NOW.toISOString(),
  updated_at_iso: NOW.toISOString(),
};

const editorSession = {
  user: {
    id: '3'.repeat(32),
    email: 'editor@example.com',
    name: 'Editor',
    roles: ['editor'],
  },
  session: { id: '4'.repeat(32) },
  csrfToken: CSRF_TOKEN,
  authRevision: '5'.repeat(32),
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

function mutationRequest(method: 'PUT' | 'DELETE', body: unknown) {
  return new Request(`https://studio.local/${comment.id}`, {
    method,
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

function creationRequest(body: unknown) {
  return new Request('https://studio.local/', {
    method: 'POST',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

function bulkRequest(body: unknown) {
  return new Request('https://studio.local/bulk-moderation', {
    method: 'POST',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

describe('comment moderation routes', () => {
  it('lists eligible authoring targets', async () => {
    const listTargets = vi.fn().mockResolvedValue([comment.target]);
    const routes = createCommentManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listTargets,
    });
    const response = await routes.fetch(new Request(
      'https://studio.local/targets?target_type=post&search=First',
    ), env());
    expect(response.status).toBe(200);
    expect(listTargets).toHaveBeenCalledWith({
      db: expect.anything(),
      edgeDb: expect.anything(),
      query: { target_type: 'post', search: 'First' },
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { items: [comment.target] },
    });
  });

  it('allows editors to list comments and denies authors', async () => {
    const listComments = vi.fn().mockResolvedValue({
      items: [comment],
      pagination: { page: 1, per_page: 50, total: 1, total_pages: 1 },
      status_counts: {
        all: 1,
        pending: 1,
        approved: 0,
        spam: 0,
        trash: 0,
      },
    });
    const routes = createCommentManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listComments,
    });
    const response = await routes.fetch(new Request(
      'https://studio.local/?status=pending&target_type=post&page=1&per_page=50',
    ), env());
    expect(response.status).toBe(200);
    expect(listComments).toHaveBeenCalledWith({
      db: expect.anything(),
      edgeDb: expect.anything(),
      query: {
        search: '',
        status: 'pending',
        target_type: 'post',
        page: 1,
        per_page: 50,
      },
    });

    const denied = createCommentManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...editorSession,
        user: { ...editorSession.user, roles: ['author'] },
      }),
      listComments,
    });
    expect((await denied.fetch(new Request('https://studio.local/'), env()))
      .status).toBe(403);
  });

  it('updates and deletes with same-origin CSRF and maps conflicts', async () => {
    const updateComment = vi.fn()
      .mockResolvedValueOnce({ kind: 'completed', comment })
      .mockResolvedValueOnce({ kind: 'revision_conflict' });
    const deleteComment = vi.fn()
      .mockResolvedValueOnce({
        kind: 'moved_to_trash',
        comment: { ...comment, status: 'trash' },
      })
      .mockResolvedValueOnce({
        kind: 'permanently_deleted',
        deletedCount: 3,
      });
    const routes = createCommentManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      updateComment,
      deleteComment,
      now: () => NOW,
    });
    const updateBody = {
      status: 'approved',
      expected_updated_at_iso: comment.updated_at_iso,
    };
    expect((await routes.fetch(mutationRequest('PUT', updateBody), env()))
      .status).toBe(200);
    expect(updateComment).toHaveBeenCalledWith({
      db: expect.anything(),
      edgeDb: expect.anything(),
      id: comment.id,
      update: updateBody,
      now: NOW,
    });
    expect((await routes.fetch(mutationRequest('PUT', updateBody), env()))
      .status).toBe(409);
    expect((await routes.fetch(mutationRequest('DELETE', {
      expected_updated_at_iso: comment.updated_at_iso,
    }), env())).status).toBe(200);
    const permanent = await routes.fetch(mutationRequest('DELETE', {
      expected_updated_at_iso: comment.updated_at_iso,
    }), env());
    expect(permanent.status).toBe(200);
    await expect(permanent.json()).resolves.toEqual({
      success: true,
      data: { status: 'permanently_deleted', deleted_count: 3 },
    });

    const crossOrigin = mutationRequest('PUT', updateBody);
    crossOrigin.headers.set('Origin', 'https://other.example');
    expect((await routes.fetch(crossOrigin, env())).status).toBe(403);
  });

  it('runs bounded bulk moderation behind the same capability and CSRF gate', async () => {
    const data = {
      operation: 'set_status' as const,
      status: 'approved' as const,
      results: [{
        id: comment.id,
        outcome: 'updated' as const,
        status: 'approved' as const,
        updated_at_iso: '2026-08-02T00:00:00.001Z',
      }],
      summary: {
        requested: 1,
        updated: 1,
        unchanged: 0,
        conflict: 0,
        skipped: 0,
        deleted_comments: 0,
      },
    };
    const bulkModerate = vi.fn().mockResolvedValue(data);
    const routes = createCommentManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      bulkModerate,
      now: () => NOW,
    });
    const body = {
      operation: 'set_status',
      status: 'approved',
      items: [{
        id: comment.id,
        expected_updated_at_iso: comment.updated_at_iso,
      }],
    };
    const response = await routes.fetch(bulkRequest(body), env());
    expect(response.status).toBe(200);
    expect(bulkModerate).toHaveBeenCalledWith({
      edgeDb: expect.anything(),
      request: body,
      now: NOW,
    });
    await expect(response.json()).resolves.toEqual({ success: true, data });

    const invalid = await routes.fetch(bulkRequest({
      ...body,
      items: [body.items[0], body.items[0]],
    }), env());
    expect(invalid.status).toBe(400);
    expect(bulkModerate).toHaveBeenCalledOnce();

    const crossOrigin = bulkRequest(body);
    crossOrigin.headers.set('Origin', 'https://other.example');
    expect((await routes.fetch(crossOrigin, env())).status).toBe(403);
  });

  it('creates Studio comments from the authenticated user and maps stale targets', async () => {
    const createdComment = {
      ...comment,
      status: 'approved' as const,
      author: {
        name: editorSession.user.name,
        email: editorSession.user.email,
        kind: 'site_user' as const,
      },
      reply: { available: true as const },
    };
    const createComment = vi.fn()
      .mockResolvedValueOnce({ kind: 'completed', comment: createdComment })
      .mockResolvedValueOnce({ kind: 'target_not_available' })
      .mockResolvedValueOnce({ kind: 'reply_not_available' })
      .mockResolvedValueOnce({ kind: 'state_conflict' });
    const routes = createCommentManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createComment,
      now: () => NOW,
    });
    const body = {
      target_type: 'post',
      target_public_id: comment.target_public_id,
      parent_public_id: null,
      content_text: 'Studio comment',
    };
    const created = await routes.fetch(creationRequest(body), env());
    expect(created.status).toBe(201);
    expect(createComment).toHaveBeenCalledWith({
      db: expect.anything(),
      edgeDb: expect.anything(),
      author: editorSession.user,
      comment: body,
      now: NOW,
    });
    expect((await routes.fetch(creationRequest(body), env())).status).toBe(409);
    expect((await routes.fetch(creationRequest(body), env())).status).toBe(409);
    expect((await routes.fetch(creationRequest(body), env())).status).toBe(409);

    const crossOrigin = creationRequest(body);
    crossOrigin.headers.set('Origin', 'https://other.example');
    expect((await routes.fetch(crossOrigin, env())).status).toBe(403);
  });

  it('normalizes new comments, replies, and edits before passing them to storage', async () => {
    const createComment = vi.fn().mockResolvedValue({ kind: 'completed', comment });
    const updateComment = vi.fn().mockResolvedValue({ kind: 'completed', comment });
    const routes = createCommentManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createComment,
      updateComment,
    });
    const content = ' \u0000© 😊 👨‍👩‍👧‍👦\r\n\r\n\r\n ところで、\t今日は忙しい。 ';
    const expected = '© 😊 👨‍👩‍👧‍👦\n\nところで、 今日は忙しい。';
    for (const parentId of [null, comment.public_id]) {
      const response = await routes.fetch(creationRequest({
        target_type: 'post', target_public_id: comment.target_public_id,
        parent_public_id: parentId, content_text: content,
      }), env());
      expect(response.status).toBe(201);
      expect(createComment).toHaveBeenLastCalledWith(expect.objectContaining({
        comment: {
          target_type: 'post', target_public_id: comment.target_public_id,
          parent_public_id: parentId, content_text: expected,
        },
      }));
    }
    const response = await routes.fetch(mutationRequest('PUT', {
      content_text: content, expected_updated_at_iso: comment.updated_at_iso,
    }), env());
    expect(response.status).toBe(200);
    expect(updateComment).toHaveBeenCalledWith(expect.objectContaining({
      update: { content_text: expected, expected_updated_at_iso: comment.updated_at_iso },
    }));
  });

  it.each([
    ['empty normalized content', ' \u0000\u0007\u001B\u007F\u0085\u009F\t\r\n '],
    ['overlong emoji content', `${'😊'.repeat(2500)}©`],
    ['non-string content', 123],
  ])('rejects %s without writing comments', async (_label, content) => {
    const createComment = vi.fn();
    const updateComment = vi.fn();
    const routes = createCommentManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession), createComment, updateComment,
    });
    expect((await routes.fetch(creationRequest({
      target_type: 'post', target_public_id: comment.target_public_id,
      parent_public_id: null, content_text: content,
    }), env())).status).toBe(400);
    expect((await routes.fetch(mutationRequest('PUT', {
      content_text: content, expected_updated_at_iso: comment.updated_at_iso,
    }), env())).status).toBe(400);
    expect(createComment).not.toHaveBeenCalled();
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('rejects malformed filters, IDs, and empty mutations', async () => {
    const routes = createCommentManagementRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listComments: vi.fn(),
      updateComment: vi.fn(),
    });
    expect((await routes.fetch(new Request(
      'https://studio.local/?target_public_id=123',
    ), env())).status).toBe(400);
    expect((await routes.fetch(new Request('https://studio.local/not-an-id', {
      method: 'PUT',
      headers: {
        Origin: 'https://studio.local',
        'Content-Type': 'application/json',
        'X-ZeroPress-CSRF': CSRF_TOKEN,
      },
      body: JSON.stringify({
        expected_updated_at_iso: comment.updated_at_iso,
      }),
    }), env())).status).toBe(400);
  });

  it('checks capability before returning the disabled integration gate', async () => {
    const readMode = vi.fn().mockResolvedValue('disabled');
    const listComments = vi.fn();
    const authorRoutes = createCommentManagementRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue({
        ...editorSession,
        user: { ...editorSession.user, roles: ['author'] },
      }),
      readEdgeIntegrationMode: readMode,
      listComments,
    });
    expect((await authorRoutes.fetch(
      new Request('https://studio.local/'), env(),
    )).status).toBe(403);
    expect(readMode).not.toHaveBeenCalled();

    const editorRoutes = createCommentManagementRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      readEdgeIntegrationMode: readMode,
      listComments,
    });
    const response = await editorRoutes.fetch(
      new Request('https://studio.local/'), env(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_INTEGRATION_DISABLED' },
    });
    expect(listComments).not.toHaveBeenCalled();
  });
});

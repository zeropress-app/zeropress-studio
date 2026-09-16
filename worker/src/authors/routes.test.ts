import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createAuthorRoutes } from './routes';

const NOW = new Date('2026-08-01T08:00:00.000Z');
const USER_ID = '1'.repeat(32);
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const author = {
  id: 'Lael-Rukius',
  display_name: 'HYEONG HWAN, MUN',
  user: null,
  avatar: null,
  revision: '2'.repeat(32),
  created_at_iso: NOW.toISOString(),
  updated_at_iso: NOW.toISOString(),
};
const authorListItem = { ...author, post_count: 3 };
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

function env(): Env {
  return {
    DB: {} as D1Database,
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

describe('Author routes', () => {
  it('requires authors.manage and returns bounded list metadata', async () => {
    const listAuthors = vi.fn().mockResolvedValue({
      items: [authorListItem],
      pagination: { page: 1, per_page: 50, total: 1, total_pages: 1 },
      summary: { total: 3, linked: 1, unlinked: 2 },
    });
    const routes = createAuthorRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      listAuthors,
    });
    const response = await routes.fetch(
      new Request('https://studio.local/?search=Lael&linked=all&page=1&per_page=50'),
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        items: [authorListItem],
        pagination: { page: 1, per_page: 50, total: 1, total_pages: 1 },
        summary: { total: 3, linked: 1, unlinked: 2 },
      },
    });
    expect(listAuthors).toHaveBeenCalledWith({
      db: expect.anything(),
      query: { search: 'Lael', linked: 'all', page: 1, per_page: 50 },
    });

    const denied = createAuthorRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
      listAuthors: vi.fn(),
    });
    expect((await denied.fetch(new Request('https://studio.local/'), env())).status)
      .toBe(403);
  });

  it('creates canonical authors only with exact same-origin CSRF', async () => {
    const createAuthor = vi.fn().mockResolvedValue({
      kind: 'completed',
      author,
    });
    const routes = createAuthorRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      createAuthor,
      now: () => NOW,
      createRevision: () => '2'.repeat(32),
    });
    const requestBody = {
      id: 'Lael-Rukius',
      display_name: '  HYEONG HWAN, MUN  ',
      user_id: null,
      avatar_media_id: null,
    };
    const response = await routes.fetch(
      mutationRequest('/', 'POST', requestBody),
      env(),
    );
    expect(response.status).toBe(201);
    expect(createAuthor).toHaveBeenCalledWith({
      db: expect.anything(),
      id: 'Lael-Rukius',
      displayName: 'HYEONG HWAN, MUN',
      userId: null,
      avatarMediaId: null,
      now: NOW,
      createRevision: expect.any(Function),
    });

    expect((await routes.fetch(mutationRequest('/', 'POST', requestBody, {
      Origin: 'https://other.example',
    }), env())).status).toBe(403);
    expect((await routes.fetch(mutationRequest('/', 'POST', requestBody, {
      'X-ZeroPress-CSRF': 'wrong-token',
    }), env())).status).toBe(403);
    expect(createAuthor).toHaveBeenCalledTimes(1);
  });

  it('maps immutable-ID, user-link, not-found, and revision conflicts', async () => {
    const createAuthor = vi.fn()
      .mockResolvedValueOnce({ kind: 'id_conflict' })
      .mockResolvedValueOnce({ kind: 'user_conflict' });
    const updateAuthor = vi.fn()
      .mockResolvedValueOnce({ kind: 'not_found' })
      .mockResolvedValueOnce({ kind: 'revision_conflict' });
    const routes = createAuthorRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      createAuthor,
      updateAuthor,
    });
    const createBody = {
      id: author.id,
      display_name: author.display_name,
      user_id: null,
      avatar_media_id: null,
    };
    for (const expected of ['AUTHOR_ID_CONFLICT', 'AUTHOR_USER_CONFLICT']) {
      const response = await routes.fetch(
        mutationRequest('/', 'POST', createBody), env(),
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: { code: expected },
      });
    }
    const updateBody = {
      display_name: author.display_name,
      user_id: null,
      avatar_media_id: null,
      expected_revision: author.revision,
    };
    const notFound = await routes.fetch(
      mutationRequest(`/${author.id}`, 'PUT', updateBody), env(),
    );
    expect(notFound.status).toBe(404);
    const stale = await routes.fetch(
      mutationRequest(`/${author.id}`, 'PUT', updateBody), env(),
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHOR_REVISION_CONFLICT' },
    });
  });

  it('rejects an avatar Media row that disappeared or is not an image', async () => {
    const createAuthor = vi.fn().mockResolvedValue({
      kind: 'media_not_found',
    });
    const routes = createAuthorRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      createAuthor,
    });
    const response = await routes.fetch(mutationRequest('/', 'POST', {
      id: author.id,
      display_name: author.display_name,
      user_id: null,
      avatar_media_id: '9'.repeat(32),
    }), env());
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'MEDIA_NOT_FOUND' },
    });
  });

  it('deletes using an explicit current revision and validates ID paths', async () => {
    const deleteAuthor = vi.fn().mockResolvedValue({ kind: 'completed' });
    const routes = createAuthorRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      deleteAuthor,
    });
    const response = await routes.fetch(mutationRequest(
      `/${author.id}`,
      'DELETE',
      { expected_revision: author.revision },
    ), env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: 'author_deleted', id: author.id },
    });
    expect(deleteAuthor).toHaveBeenCalledWith({
      db: expect.anything(),
      id: author.id,
      expectedRevision: author.revision,
    });
    const invalid = await routes.fetch(mutationRequest(
      '/bad%20id',
      'DELETE',
      { expected_revision: author.revision },
    ), env());
    expect(invalid.status).toBe(400);
  });

  it('reports an Author referenced by content without deleting it', async () => {
    const deleteAuthor = vi.fn().mockResolvedValue({ kind: 'in_use' });
    const routes = createAuthorRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      deleteAuthor,
    });
    const response = await routes.fetch(mutationRequest(
      `/${author.id}`,
      'DELETE',
      { expected_revision: author.revision },
    ), env());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHOR_IN_USE' },
    });
  });
});

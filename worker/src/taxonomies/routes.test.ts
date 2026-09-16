import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createTaxonomyRoutes } from './routes';

const NOW = new Date('2026-08-01T08:00:00.000Z');
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const term = {
  id: '1'.repeat(32),
  taxonomy: 'category' as const,
  name: 'Product News',
  slug: 'product-news',
  description: 'Announcements.',
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

describe('Taxonomy routes', () => {
  it('allows editors, rejects authors, and returns bounded list metadata', async () => {
    const listTerms = vi.fn().mockResolvedValue({
      items: [{ ...term, post_count: 3 }],
      pagination: { page: 1, per_page: 50, total: 1, total_pages: 1 },
      summary: { categories: 4, tags: 12 },
    });
    const routes = createTaxonomyRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listTerms,
    });
    const response = await routes.fetch(new Request(
      'https://studio.local/categories?search=News&page=1&per_page=50',
    ), env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        items: [{ ...term, post_count: 3 }],
        summary: { categories: 4, tags: 12 },
        pagination: { total: 1 },
      },
    });
    expect(listTerms).toHaveBeenCalledWith({
      db: expect.anything(),
      taxonomy: 'category',
      query: { search: 'News', page: 1, per_page: 50 },
    });

    const denied = createTaxonomyRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...editorSession,
        user: { ...editorSession.user, roles: ['author'] },
      }),
      listTerms: vi.fn(),
    });
    expect((await denied.fetch(
      new Request('https://studio.local/tags'), env(),
    )).status).toBe(403);
    expect((await routes.fetch(
      new Request('https://studio.local/unknown'), env(),
    )).status).toBe(404);
  });

  it('creates canonical terms only with exact same-origin CSRF', async () => {
    const createTerm = vi.fn().mockResolvedValue({
      kind: 'completed',
      term,
    });
    const routes = createTaxonomyRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createTerm,
      now: () => NOW,
      createId: () => term.id,
      createRevision: () => term.revision,
    });
    const body = {
      name: '  Product News  ',
      slug: 'product-news',
      description: '  Announcements.  ',
    };
    const response = await routes.fetch(
      mutationRequest('/categories', 'POST', body), env(),
    );
    expect(response.status).toBe(201);
    expect(createTerm).toHaveBeenCalledWith({
      db: expect.anything(),
      taxonomy: 'category',
      name: term.name,
      slug: term.slug,
      description: term.description,
      now: NOW,
      createId: expect.any(Function),
      createRevision: expect.any(Function),
    });
    expect((await routes.fetch(mutationRequest('/categories', 'POST', body, {
      Origin: 'https://other.example',
    }), env())).status).toBe(403);
    expect(createTerm).toHaveBeenCalledTimes(1);
  });

  it('maps slug, revision, referenced-term, and not-found conflicts', async () => {
    const createTerm = vi.fn().mockResolvedValue({ kind: 'slug_conflict' });
    const updateTerm = vi.fn()
      .mockResolvedValueOnce({ kind: 'revision_conflict' })
      .mockResolvedValueOnce({ kind: 'not_found' });
    const deleteTerm = vi.fn().mockResolvedValue({ kind: 'in_use' });
    const routes = createTaxonomyRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createTerm,
      updateTerm,
      deleteTerm,
    });
    const authored = {
      name: term.name,
      slug: term.slug,
      description: term.description,
    };
    const duplicate = await routes.fetch(
      mutationRequest('/categories', 'POST', authored), env(),
    );
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({
      success: false,
      error: { code: 'TAXONOMY_SLUG_CONFLICT' },
    });
    const updateBody = {
      ...authored,
      expected_revision: term.revision,
    };
    expect((await routes.fetch(mutationRequest(
      `/categories/${term.id}`, 'PUT', updateBody,
    ), env())).status).toBe(409);
    expect((await routes.fetch(mutationRequest(
      `/categories/${term.id}`, 'PUT', updateBody,
    ), env())).status).toBe(404);
    const referenced = await routes.fetch(mutationRequest(
      `/categories/${term.id}`,
      'DELETE',
      { expected_revision: term.revision },
    ), env());
    expect(referenced.status).toBe(409);
    await expect(referenced.json()).resolves.toEqual({
      success: false,
      error: { code: 'TAXONOMY_TERM_IN_USE' },
    });
  });
});

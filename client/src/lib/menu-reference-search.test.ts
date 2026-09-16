// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MenuReferenceKind } from '../../../contracts/menus';
import { requestMenuReferenceSearch } from './menu-reference-search';
import { referenceCategory, referencePage, referencePost, referenceSearchResponse } from '../test/menu-reference-fixtures';

afterEach(() => { vi.unstubAllGlobals(); });

describe('Menu reference search adapters', () => {
  it.each([
    { kind: 'post', path: '/api/posts', item: referencePost, title: referencePost.title, detail: referencePost.slug },
    { kind: 'page', path: '/api/pages', item: referencePage, title: referencePage.title, detail: '/docs/guide/' },
    { kind: 'category', path: '/api/taxonomies/categories', item: referenceCategory, title: 'News', detail: 'news' },
    { kind: 'tag', path: '/api/taxonomies/tags', item: { ...referenceCategory, taxonomy: 'tag' as const }, title: 'News', detail: 'news' },
  ] as const)('reuses $kind search and keeps only the typed internal ID and display snapshot', async ({ kind, path, item, title, detail }) => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(referenceSearchResponse(url, [item])));
    vi.stubGlobal('fetch', fetchMock);
    const result = await requestMenuReferenceSearch({ kind, search: '한글 %_ docs', status: 'published', page: 1 });
    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
    expect(url.pathname).toBe(path);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      search: '한글 %_ docs', page: '1', per_page: '20',
      ...(kind === 'post' || kind === 'page' ? { status: 'published' } : {}),
    });
    expect(result.items).toEqual([{
      reference: { kind, reference_id: item.id, title, detail },
      status: kind === 'post' || kind === 'page' ? 'published' : null,
    }]);
    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: 'GET', credentials: 'same-origin' }));
  });

  it('requests a real page beyond the first 100 rows without accumulating a select catalog', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(referenceSearchResponse(url, [referencePost], 125)));
    vi.stubGlobal('fetch', fetchMock);
    const result = await requestMenuReferenceSearch({ kind: 'post', search: '', status: 'published', page: 7 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toContain('page=7&per_page=20');
    expect(result.pagination).toEqual({ page: 7, per_page: 20, total: 125, total_pages: 7 });
    expect(result.items[0].reference.reference_id).toBe(referencePost.id);
  });

  it.each(['post', 'page'] as const)('keeps drafts selectable through the existing %s status filter', async (kind) => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(referenceSearchResponse(url, [
      { ...(kind === 'post' ? referencePost : referencePage), status: 'draft' },
    ])));
    vi.stubGlobal('fetch', fetchMock);
    const result = await requestMenuReferenceSearch({ kind, search: '', status: 'draft', page: 1 });
    expect(fetchMock.mock.calls[0][0]).toContain('status=draft');
    expect(result.items[0].status).toBe('draft');
  });

  it.each(['post', 'page'] as const)('rejects an unexpected Trash row from %s instead of silently changing pagination', async (kind) => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(referenceSearchResponse(url, [
      { ...(kind === 'post' ? referencePost : referencePage), status: 'trash' },
    ]))));
    await expect(requestMenuReferenceSearch({ kind, search: '', status: 'published', page: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects a taxonomy response for the wrong typed namespace', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(referenceSearchResponse(url, [referenceCategory]))));
    await expect(requestMenuReferenceSearch({ kind: 'tag', search: '', status: 'published', page: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects a response for a different pagination boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(referenceSearchResponse('/api/posts?page=1&per_page=50', [referencePost]))));
    await expect(requestMenuReferenceSearch({ kind: 'post', search: '', status: 'published', page: 2 }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each(['AUTHENTICATION_REQUIRED', 'FORBIDDEN', 'CONTENT_SEARCH_QUERY_INVALID', 'CONTENT_SEARCH_INDEX_NOT_READY'])(
    'preserves %s without an automatic fallback or retry', async (code) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, error: { code } })));
      vi.stubGlobal('fetch', fetchMock);
      await expect(requestMenuReferenceSearch({ kind: 'post', search: 'test', status: 'published', page: 1 }))
        .rejects.toMatchObject({ code });
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it.each(['post', 'page', 'category', 'tag'] satisfies MenuReferenceKind[])('forwards %s request cancellation to the existing client', async (kind) => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }));
    const controller = new AbortController();
    const request = requestMenuReferenceSearch({ kind, search: '', status: 'published', page: 1 }, controller.signal);
    controller.abort();
    expect(signal?.aborted).toBe(true);
    await expect(request).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

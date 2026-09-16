// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuReferenceKind } from '../../../contracts/menus';
import { changeLocale } from '../i18n';
import { referenceCategory, referencePage, referencePost, referenceSearchResponse } from '../test/menu-reference-fixtures';
import { MenuReferencePicker } from './MenuReferencePicker';

function setup(kind: MenuReferenceKind = 'post') {
  const callbacks = { onSelect: vi.fn(), onBack: vi.fn(), onSessionEnded: vi.fn() };
  render(<MenuReferencePicker kind={kind} selectedId="" {...callbacks} />);
  return callbacks;
}

beforeEach(async () => { localStorage.clear(); await changeLocale('en'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Menu reference search view', () => {
  it('can select beyond 100 rows with server pagination, and resets the page when searching or filtering', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((path: string) => {
      const url = new URL(path, 'http://localhost');
      const page = Number(url.searchParams.get('page'));
      return Promise.resolve(referenceSearchResponse(path, [{
        ...referencePost, id: page.toString(16).padStart(32, '0'), title: `Post on page ${page}`,
        status: url.searchParams.get('status') === 'draft' ? 'draft' : 'published',
      }], 125));
    });
    vi.stubGlobal('fetch', fetchMock);
    const callbacks = setup();
    await screen.findByText('Page 1 of 7');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    for (let page = 2; page <= 7; page++) {
      await user.click(screen.getByRole('button', { name: 'Next' }));
      await screen.findByText(`Page ${page} of 7`);
    }
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Select Post on page 7' }));
    expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith({
      kind: 'post', reference_id: '7'.padStart(32, '0'), title: 'Post on page 7', detail: 'found-post',
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await user.type(screen.getByRole('searchbox', { name: 'Search content' }), 'Needle');
    expect(fetchMock).toHaveBeenCalledTimes(7);
    await user.click(screen.getByRole('button', { name: 'Search content' }));
    await screen.findByText('Page 1 of 7');
    expect(Object.fromEntries(new URL(fetchMock.mock.lastCall![0], 'http://localhost').searchParams))
      .toEqual({ search: 'Needle', page: '1', per_page: '20', status: 'published' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 7');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'draft');
    await screen.findByText('Page 1 of 7');
    expect(Object.fromEntries(new URL(fetchMock.mock.lastCall![0], 'http://localhost').searchParams))
      .toEqual({ search: 'Needle', page: '1', per_page: '20', status: 'draft' });
    expect(screen.queryByRole('option', { name: 'Trash' })).not.toBeInTheDocument();
  });

  it.each([
    { kind: 'page', item: referencePage, name: 'Guide', detail: '/docs/guide/' },
    { kind: 'category', item: referenceCategory, name: 'News', detail: 'news' },
    { kind: 'tag', item: { ...referenceCategory, taxonomy: 'tag' as const }, name: 'News', detail: 'news' },
  ] as const)('renders and selects a $kind using the correct typed ID', async ({ kind, item, name, detail }) => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(referenceSearchResponse(path, [item]))));
    const callbacks = setup(kind);
    expect(await screen.findByText(detail, { selector: '.navigation-reference-detail' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Status' }) !== null).toBe(kind === 'page');
    // A labelled Select button must not overlap the identity's icon-action slot on mobile.
    expect(screen.getByRole('button', { name: `Select ${name}` }).closest('td')).toHaveAttribute('data-stack', 'wide');
    await user.click(screen.getByRole('button', { name: `Select ${name}` }));
    expect(callbacks.onSelect).toHaveBeenCalledExactlyOnceWith({ kind, reference_id: item.id, title: name, detail });
  });

  it('keeps search errors distinct from empty results and retries without losing the query', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const fetchMock = vi.fn((path: string) => {
      const query = new URL(path, 'http://localhost').searchParams.get('search');
      if (query && attempt++ === 0) return Promise.resolve(new Response(JSON.stringify({
        success: false, error: { code: 'CONTENT_SEARCH_INDEX_NOT_READY' },
      })));
      return Promise.resolve(referenceSearchResponse(path, []));
    });
    vi.stubGlobal('fetch', fetchMock);
    setup();
    await screen.findByText('No content found');
    await user.type(screen.getByRole('searchbox', { name: 'Search content' }), 'Query');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent('Content search is temporarily unavailable. Try again later.');
    expect(screen.queryByText('No content found')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search content' })).toHaveValue('Query');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('No content found');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.lastCall?.[0]).toContain('search=Query');
  });

  it('ignores a stale response and aborts the previous query when a new search is submitted', async () => {
    const user = userEvent.setup();
    let finish!: (response: Response) => void;
    let pendingSignal: AbortSignal | undefined;
    let pendingPath = '';
    const fetchMock = vi.fn((path: string, init: RequestInit) => {
      const query = new URL(path, 'http://localhost').searchParams.get('search');
      if (query === 'Old') {
        pendingSignal = init.signal ?? undefined;
        pendingPath = path;
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return Promise.resolve(referenceSearchResponse(path, []));
    });
    vi.stubGlobal('fetch', fetchMock);
    setup();
    await screen.findByText('No content found');
    await user.type(screen.getByRole('searchbox', { name: 'Search content' }), 'Old{Enter}');
    await screen.findByText('Loading content…');
    await user.clear(screen.getByRole('searchbox', { name: 'Search content' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search content' }), 'New{Enter}');
    await screen.findByText('No content found');
    expect(pendingSignal?.aborted).toBe(true);
    await act(async () => finish(referenceSearchResponse(pendingPath, [referencePost])));
    expect(screen.queryByText('Found Post')).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search content' })).toHaveValue('New');
  });

  it('hands an expired session to the existing authentication boundary', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: false, error: { code: 'AUTHENTICATION_REQUIRED' },
    }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const callbacks = setup();
    await screen.findByRole('alert');
    expect(callbacks.onSessionEnded).toHaveBeenCalledOnce();
    expect(callbacks.onSelect).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

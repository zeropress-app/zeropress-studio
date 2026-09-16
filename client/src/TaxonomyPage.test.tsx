// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import type { TaxonomyListSummary, TaxonomyTerm } from '../../contracts/taxonomies';
import { changeLocale } from './i18n';
import { TaxonomyPage } from './TaxonomyPage';
import { StudioToaster } from './components/primitives';

const session: CurrentSessionSuccess['data'] = {
  user: {
    id: '1'.repeat(32),
    email: 'editor@example.com',
    name: 'Site Editor',
    roles: ['editor'],
  },
  session: {
    id: '2'.repeat(32),
    created_at_iso: '2026-08-01T00:00:00.000Z',
    last_seen_at_iso: '2026-08-01T00:05:00.000Z',
    idle_expires_at_iso: '2026-08-01T12:05:00.000Z',
    absolute_expires_at_iso: '2026-08-08T00:00:00.000Z',
    network: {
      ip_address: '203.0.113.10',
      asn: null,
      as_organization: null,
      country_code: null,
    },
  },
  csrf_token: 'c'.repeat(43),
  edge_integration: { mode: 'enabled', database_state: 'ready' },
};

const category = {
  id: '3'.repeat(32),
  taxonomy: 'category' as const,
  name: 'Product News',
  slug: 'product-news',
  description: 'Announcements.',
  revision: '4'.repeat(32),
  created_at_iso: '2026-08-01T08:00:00.000Z',
  updated_at_iso: '2026-08-01T08:00:00.000Z',
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function termList(
  items: (TaxonomyTerm & { post_count?: number })[],
  options: { page?: number; total?: number; summary?: TaxonomyListSummary } = {},
) {
  const total = options.total ?? items.length;
  return response({
    success: true,
    data: {
      items: items.map((item) => ({ ...item, post_count: item.post_count ?? 0 })),
      summary: options.summary ?? {
        categories: items.filter((item) => item.taxonomy === 'category').length,
        tags: items.filter((item) => item.taxonomy === 'tag').length,
      },
      pagination: {
        page: options.page ?? 1,
        per_page: 50,
        total,
        total_pages: Math.ceil(total / 50),
      },
    },
  });
}

function renderPage(onSessionEnded = vi.fn()) {
  return render(
    <MemoryRouter>
      <StudioToaster />
      <TaxonomyPage data={session} onSessionEnded={onSessionEnded} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('TaxonomyPage', () => {
  it('creates a public Category with a suggested editable slug', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(termList([]))
      .mockResolvedValueOnce(response({ success: true, data: category }, 201))
      .mockResolvedValueOnce(termList([category]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('heading', { name: 'No categories yet' }))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New category' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Create category' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Product News');
    expect(screen.getByRole('textbox', { name: 'Slug' }))
      .toHaveValue('product-news');
    await user.type(
      screen.getByRole('textbox', { name: 'Description (optional)' }),
      'Announcements.',
    );
    await user.click(screen.getByRole('button', { name: 'Create category' }));

    expect(await screen.findByText('Product News was created.'))
      .toBeInTheDocument();
    expect(screen.getByText('product-news', { selector: 'code' }))
      .toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(table).toHaveClass('studio-table-stacked-compact');
    expect(within(table).getByRole('button', { name: 'Edit Product News' }).closest('td'))
      .toHaveAttribute('data-stack', 'primary');
    expect(within(table).getByText(category.description).closest('td'))
      .toHaveAttribute('data-stack', 'wide');
    expect(within(table).getByRole('button', { name: 'Actions for Product News' }).closest('td'))
      .toHaveAttribute('data-stack', 'actions');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/taxonomies/categories');
    const mutation = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(mutation).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'X-ZeroPress-CSRF': session.csrf_token,
      }),
    });
    expect(JSON.parse(String(mutation.body))).toEqual({
      name: 'Product News',
      slug: 'product-news',
      description: 'Announcements.',
    });
  });

  it('allows slug edits and keeps the dialog open on revision conflicts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(termList([category]))
      .mockResolvedValueOnce(response({
        success: false,
        error: { code: 'TAXONOMY_REVISION_CONFLICT' },
      }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(category.slug, { selector: 'code' });
    await user.click(screen.getByRole('button', { name: 'Edit Product News' }));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    const slug = screen.getByRole('textbox', { name: 'Slug' });
    await user.clear(slug);
    await user.type(slug, 'release.v0.7');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This item changed after you opened it',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const mutation = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(JSON.parse(String(mutation.body))).toMatchObject({
      slug: 'release.v0.7',
      expected_revision: category.revision,
    });
  });

  it('loads Tags independently when the taxonomy tab changes', async () => {
    const tag = { ...category, taxonomy: 'tag' as const, name: 'Featured', slug: 'featured' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(termList([category]))
      .mockResolvedValueOnce(termList([tag]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(category.slug, { selector: 'code' });
    await user.click(screen.getByRole('tab', { name: /^Tags/ }));
    expect(await screen.findByText(tag.slug, { selector: 'code' }))
      .toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/api/taxonomies/tags?');
  });

  it('supports keyboard navigation between Category and Tag tabs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(termList([category]))
      .mockResolvedValueOnce(termList([]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(category.slug, { selector: 'code' });
    const categoriesTab = screen.getByRole('tab', { name: /^Categories/ });
    categoriesTab.focus();
    await user.keyboard('{ArrowRight}');

    expect(await screen.findByRole('heading', { name: 'No tags yet' }))
      .toBeInTheDocument();
    const tagsTab = screen.getByRole('tab', { name: /^Tags/ });
    expect(tagsTab).toHaveAttribute('aria-selected', 'true');
    expect(tagsTab).toHaveFocus();
  });

  it('keeps controls mounted while loading and shows global counts separately from search results', async () => {
    let finishSearch!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => { finishSearch = resolve; });
    const summary = { categories: 4, tags: 667 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(termList([{ ...category, post_count: 3 }], { summary }))
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(termList([], { summary }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();
    const tab = await screen.findByRole('tab', { name: 'Categories 4' });
    expect(screen.getByRole('tab', { name: 'Tags 667' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '3' })).toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Search categories' });
    await user.type(search, '  100% useful  ');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('status')).toHaveTextContent('Loading categories and tags');
    expect(screen.getByRole('searchbox')).toBe(search);
    expect(screen.getByRole('tab', { name: 'Categories 4' })).toBe(tab);
    expect(screen.getByRole('button', { name: 'New category' })).toBeDisabled();
    expect(fetchMock.mock.calls[1]?.[0])
      .toBe('/api/taxonomies/categories?search=100%25+useful&page=1&per_page=50');
    finishSearch(termList([category], { summary }));
    expect(await screen.findByText('Search results: 1')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Categories 4' })).toBe(tab);
    await user.click(screen.getByRole('tab', { name: 'Tags 667' }));
    expect(await screen.findByRole('heading', { name: 'No tags yet' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search tags' })).toHaveValue('');
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/taxonomies/tags?search=&page=1&per_page=50');
  });

  it('keeps Tag descriptions and Unicode slug suggestions in the compact editor', async () => {
    const tag = { ...category, taxonomy: 'tag' as const, name: '릴리스 소식', slug: 'release.v0.7' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(termList([]))
      .mockResolvedValueOnce(termList([]))
      .mockResolvedValueOnce(response({ success: true, data: tag }, 201))
      .mockResolvedValueOnce(termList([tag]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('button', { name: 'New category' });
    await user.click(screen.getByRole('tab', { name: /^Tags/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'New tag' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'New tag' }));
    const modal = screen.getByRole('dialog', { name: 'Create tag' });
    expect(within(modal).getByText(/even without linked posts/)).toBeInTheDocument();
    const name = screen.getByRole('textbox', { name: 'Name' });
    await user.type(name, '릴리스');
    const slug = screen.getByRole('textbox', { name: 'Slug' });
    expect(slug).toHaveValue('릴리스');
    await user.clear(slug);
    await user.type(slug, 'release.v0.7');
    await user.type(name, ' 소식');
    expect(slug).toHaveValue('release.v0.7');
    const description = screen.getByRole('textbox', { name: 'Description (optional)' });
    expect(description).toHaveAttribute('rows', '3');
    await user.type(description, 'Announcements.');
    await user.click(screen.getByRole('button', { name: 'Create tag' }));
    expect(await screen.findByText('릴리스 소식 was created.')).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      name: '릴리스 소식', slug: 'release.v0.7', description: 'Announcements.',
    });
  });

  it('opens row actions through the menu and keeps referenced-term errors inside the dialog', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(termList([{ ...category, post_count: 3 }]))
      .mockResolvedValueOnce(response({
        success: false, error: { code: 'TAXONOMY_TERM_IN_USE' },
      }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();
    const trigger = await screen.findByRole('button', { name: 'Actions for Product News' });
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const modal = screen.getByRole('dialog', { name: 'Delete Product News category?' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await within(modal).findByRole('alert')).toHaveTextContent('including drafts and posts in Trash');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)))
      .toEqual({ expected_revision: category.revision });
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe('DELETE');
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });

  it('moves back from a deleted last-page item and retains the deletion report inline', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(termList([category], { total: 51 }))
      .mockResolvedValueOnce(termList([category], { total: 51, page: 2 }))
      .mockResolvedValueOnce(response({
        success: true,
        data: { status: 'taxonomy_term_deleted', taxonomy: 'category', id: category.id },
      }))
      .mockResolvedValueOnce(termList([
        { ...category, id: '5'.repeat(32), name: 'Other category', slug: 'other-category' },
      ], { total: 50, summary: { categories: 50, tags: 0 } }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions for Product News' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Product News was deleted.')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[1]?.[0]).toContain('page=2');
    expect(fetchMock.mock.calls[3]?.[0]).toContain('page=1');
    expect(screen.getByText('Product News was deleted.').closest('.content-list-message'))
      .toBeInTheDocument();
  });

  it('retains the toolbar after a load failure and retries without inventing zero counts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: false, error: { code: 'INTERNAL_ERROR' } }, 500))
      .mockResolvedValueOnce(termList([]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load categories and tags');
    expect(screen.getByRole('tab', { name: 'Categories' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search categories' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('tab', { name: 'Categories 0' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New category' })).toBeEnabled();
  });

  it('delegates an expired session from the list request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: false, error: { code: 'AUTHENTICATION_REQUIRED' },
    }, 401)));
    const onSessionEnded = vi.fn();
    renderPage(onSessionEnded);
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
  });
});

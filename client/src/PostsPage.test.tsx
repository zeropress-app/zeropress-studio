// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { PostsPage } from './PostsPage';
import { changeLocale } from './i18n';
import type { PostListItem } from '../../contracts/posts';

const post: PostListItem = {
  id: '1'.repeat(32),
  public_id: 100_000_000_001,
  title: 'First Post',
  slug: 'first-post',
  public_url: '/post/100000000001',
  document_type: 'markdown',
  excerpt: 'Hello',
  status: 'trash',
  author: { id: 'Studio-Owner', display_name: 'Studio Owner' },
  discoverability: 'default',
  allow_comments: true,
  published_at_iso: null,
  revision: '2'.repeat(32),
  created_at_iso: '2026-08-01T08:00:00.000Z',
  updated_at_iso: '2026-08-01T08:00:00.000Z',
  search_match: null,
};

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function list(
  items: PostListItem[],
  access: unknown = { scope: 'all' },
) {
  return response({
    success: true,
    data: {
      access,
      items,
      pagination: {
        page: 1,
        per_page: 50,
        total: items.length,
        total_pages: items.length === 0 ? 0 : 1,
      },
      status_counts: {
        all: items.length,
        draft: 0,
        published: 0,
        trash: items.length,
      },
    },
  });
}

function authorOptions() {
  return response({
    success: true,
    data: {
      kind: 'author',
      items: [{
        kind: 'author',
        id: 'Studio-Owner',
        label: 'Studio Owner',
        slug: null,
      }],
    },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('PostsPage', () => {
  it('keeps mobile page selection outside the header and limits selection to 10 Posts', async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      ...post,
      id: (index + 1).toString(16).padStart(32, '0'),
      public_id: post.public_id + index,
      title: `Post ${index + 1}`,
      slug: `post-${index + 1}`,
      public_url: `/post/${post.public_id + index}`,
    }));
    vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(
      path.startsWith('/api/posts/options') ? authorOptions() : list(items),
    )));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PostsPage
          data={{ csrf_token: 'c'.repeat(43), user: { roles: ['editor'] } }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    const selectPage = await screen.findByRole('checkbox', {
      name: 'Select up to 10 Posts on this page',
    });
    const table = screen.getByRole('table', { name: 'Posts' });
    expect(table).toHaveClass('studio-table-stacked-compact');
    expect(screen.getAllByRole('checkbox', { name: 'Select up to 10 Posts on this page' }))
      .toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Posts' })).toContainElement(selectPage);
    expect(selectPage.closest('table')).toBeNull();
    expect(table.querySelector('thead input[type="checkbox"]')).toBeNull();
    expect(within(table).getByRole('checkbox', { name: 'Select Post 1' }).closest('td'))
      .toHaveAttribute('data-stack', 'select');
    expect(within(table).getByRole('link', {
      name: /^Post 1\s*\/post\/100000000001$/u,
    }).closest('td'))
      .toHaveAttribute('data-stack', 'primary');
    expect(within(table).getByRole('button', { name: 'Actions for Post 1' }).closest('td'))
      .toHaveAttribute('data-stack', 'actions');

    await user.click(screen.getByRole('checkbox', { name: 'Select Post 12' }));
    expect(selectPage).toBePartiallyChecked();
    await user.click(selectPage);

    expect(selectPage).toBeChecked();
    expect(selectPage).not.toBePartiallyChecked();
    expect(within(table).getAllByRole('checkbox', { checked: true })).toHaveLength(10);
    expect(screen.getByRole('checkbox', { name: 'Select Post 10' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Post 11' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select Post 12' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Post 12' })).toBeDisabled();

    await user.click(selectPage);
    expect(within(table).getAllByRole('checkbox', { checked: false })).toHaveLength(12);
    expect(screen.getByRole('checkbox', { name: 'Select Post 12' })).toBeEnabled();
    expect(selectPage).not.toBePartiallyChecked();
  });

  it('renders safe plain-text search context and announces result count', async () => {
    vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(
      path.startsWith('/api/posts/options')
        ? authorOptions()
        : list([{
            ...post,
            search_match: {
              field: 'content',
              text: 'Visible Apache and PHP content',
              highlights: [
                { start: 8, end: 14 },
                { start: 19, end: 22 },
              ],
            },
          }]),
    )));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PostsPage
          data={{
            csrf_token: 'c'.repeat(43),
            user: { roles: ['editor'] },
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    const context = await screen.findByLabelText('Matching content');
    expect(screen.getByText("Write, publish, and manage your site's Posts."))
      .toBeInTheDocument();
    const createLink = screen.getByRole('link', { name: 'New Post' });
    expect(createLink).toHaveAttribute('href', '/posts/new');
    expect(createLink.closest('.content-list-toolbar-controls'))
      .not.toBeNull();
    expect(screen.getByRole('group', { name: 'Posts' }))
      .toHaveClass('studio-table-scroll-framed');
    expect(context).toHaveTextContent('Visible Apache and PHP content');
    expect([...context.querySelectorAll('mark')].map((node) => node.textContent))
      .toEqual(['Apache', 'PHP']);
    await user.type(screen.getByRole('searchbox', { name: 'Search Posts' }), 'Apache PHP');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText('1 matching Posts found.')).toBeInTheDocument();
  });

  it('offers an effective clear action when the search index is not ready', async () => {
    const fetchMock = vi.fn((path: string) => {
      if (path.startsWith('/api/posts/options')) {
        return Promise.resolve(authorOptions());
      }
      const search = new URL(path, 'https://studio.local')
        .searchParams.get('search');
      return Promise.resolve(search
        ? response({
            success: false,
            error: { code: 'CONTENT_SEARCH_INDEX_NOT_READY' },
          }, 503)
        : list([post]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PostsPage
          data={{
            csrf_token: 'c'.repeat(43),
            user: { roles: ['editor'] },
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('link', { name: /First Post/ });
    await user.type(screen.getByRole('searchbox', { name: 'Search Posts' }), 'needle');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText(/rebuilds its index/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' }))
      .not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByRole('link', { name: /First Post/ }))
      .toBeInTheDocument();
  });

  it('applies a manager Author filter from the route to the bounded list query', async () => {
    const fetchMock = vi.fn((path: string) => Promise.resolve(
      path.startsWith('/api/posts/options')
        ? authorOptions()
        : list([post]),
    ));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/posts?author_id=Studio-Owner']}>
        <PostsPage
          data={{
            csrf_token: 'c'.repeat(43),
            user: { roles: ['editor'] },
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('option', { name: 'Studio Owner' }))
      .toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Author' }))
      .toHaveValue('Studio-Owner');
    await waitFor(() => {
      const listCall = fetchMock.mock.calls.find(([path]) => (
        String(path).startsWith('/api/posts?')
      ));
      expect(new URL(String(listCall?.[0]), 'https://studio.local')
        .searchParams.get('author_id')).toBe('Studio-Owner');
    });
  });

  it('shows status counts and permanently deletes only a trashed Post', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([post]))
      .mockResolvedValueOnce(authorOptions())
      .mockResolvedValueOnce(response({
        success: true,
        data: { status: 'post_deleted', id: post.id },
      }))
      .mockResolvedValueOnce(list([]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PostsPage
          data={{
            csrf_token: 'c'.repeat(43),
            user: { roles: ['admin'] },
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('link', { name: /First Post/ }))
      .toHaveAttribute('href', `/posts/${post.id}`);
    expect(screen.getByRole('button', { name: /Trash/ }))
      .toHaveTextContent('1');
    await user.click(screen.getByRole('button', {
      name: 'Actions for First Post',
    }));
    const actionMenu = screen.getByRole('menu', {
      name: 'Actions for First Post',
    });
    expect(within(actionMenu).getByRole('menuitem', { name: 'Edit' }))
      .toHaveAttribute('href', `/posts/${post.id}`);
    await user.click(within(actionMenu).getByRole('menuitem', {
      name: 'Delete permanently',
    }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(
      'This cannot be undone.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));

    expect(await screen.findByText('“First Post” was permanently deleted.'))
      .toBeInTheDocument();
    const mutation = fetchMock.mock.calls[2];
    expect(mutation?.[0]).toBe(`/api/posts/${post.id}`);
    expect(mutation?.[1]).toMatchObject({ method: 'DELETE' });
    expect(JSON.parse(String((mutation?.[1] as RequestInit).body))).toEqual({
      expected_revision: post.revision,
    });
  });

  it('selects bounded Posts, confirms a lifecycle change, and reports row outcomes', async () => {
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path.startsWith('/api/posts/options')) {
        return Promise.resolve(authorOptions());
      }
      if (path === '/api/posts/bulk-lifecycle') {
        return Promise.resolve(response({
          success: true,
          data: {
            target_status: 'published',
            results: [{
              id: post.id,
              outcome: 'updated',
              status: 'published',
              revision: '4'.repeat(32),
            }],
            summary: {
              requested: 1,
              updated: 1,
              unchanged: 0,
              conflict: 0,
              skipped: 0,
            },
          },
        }));
      }
      expect(init?.method ?? 'GET').toBe('GET');
      return Promise.resolve(list([post]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PostsPage
          data={{
            csrf_token: 'c'.repeat(43),
            user: { roles: ['editor'] },
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    await user.click(await screen.findByRole('checkbox', {
      name: 'Select First Post',
    }));
    expect(screen.getByText('1 Posts selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Publish 1 selected Posts?');
    await user.click(within(dialog).getByRole('button', { name: 'Apply status' }));

    expect(await screen.findByText('Bulk Post lifecycle completed'))
      .toBeInTheDocument();
    expect(screen.getByText(/1 updated, 0 already current/u)).toBeInTheDocument();
    expect(screen.getByText('Status updated.', { exact: false }))
      .toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'First Post' })[0])
      .toHaveAttribute('href', `/posts/${post.id}`);
    const mutation = fetchMock.mock.calls.find(([path]) => (
      path === '/api/posts/bulk-lifecycle'
    ));
    expect(mutation?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String((mutation?.[1] as RequestInit).body))).toEqual({
      target_status: 'published',
      items: [{ id: post.id, expected_revision: post.revision }],
    });
    expect(screen.getByRole('checkbox', { name: 'Select First Post' }))
      .not.toBeChecked();
  });

  it('ends the local session when list authentication is lost', async () => {
    const onSessionEnded = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    }, 401)));
    render(
      <MemoryRouter>
        <PostsPage
          data={{
            csrf_token: 'c'.repeat(43),
            user: { roles: ['author'] },
          }}
          onSessionEnded={onSessionEnded}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
  });

  it('explains a missing Author link and disables Post creation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(list([], {
      scope: 'unavailable',
      reason: 'author_not_linked',
    })));
    render(
      <MemoryRouter>
        <PostsPage
          data={{
            csrf_token: 'c'.repeat(43),
            user: { roles: ['author'] },
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', {
      name: 'Your account is not linked to an Author',
    })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New Post' }))
      .not.toBeInTheDocument();
  });

  it('does not expose the manager Author filter to a contributor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(list([], {
      scope: 'own',
      author: { id: 'Studio-Owner', display_name: 'Studio Owner' },
    })));
    render(
      <MemoryRouter initialEntries={['/posts?author_id=Other-Author']}>
        <PostsPage
          data={{
            csrf_token: 'c'.repeat(43),
            user: { roles: ['author'] },
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Showing only Posts assigned/))
      .toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Author' }))
      .not.toBeInTheDocument();
    const listCall = vi.mocked(fetch).mock.calls[0];
    expect(new URL(String(listCall?.[0]), 'https://studio.local')
      .searchParams.has('author_id')).toBe(false);
  });
});

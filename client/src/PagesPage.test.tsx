// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { PagesPage } from './PagesPage';
import { changeLocale } from './i18n';
import type { PageListItem } from '../../contracts/pages';

const page: PageListItem = {
  id: '1'.repeat(32),
  public_id: 100_000_000_001,
  parent: {
    id: '2'.repeat(32),
    title: 'Docs',
    slug: 'docs',
  },
  title: 'Guide',
  slug: 'guide',
  path: 'docs/guide',
  public_url: '/content/docs/guide/',
  document_type: 'markdown',
  excerpt: 'Start here.',
  status: 'trash',
  discoverability: 'default',
  allow_comments: false,
  revision: '3'.repeat(32),
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

function list(items: PageListItem[]) {
  return response({
    success: true,
    data: {
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('PagesPage', () => {
  it('keeps mobile page selection outside the header and limits selection to 10 Pages', async () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      ...page,
      id: (index + 1).toString(16).padStart(32, '0'),
      public_id: page.public_id + index,
      title: `Page ${index + 1}`,
      slug: `page-${index + 1}`,
      path: `docs/page-${index + 1}`,
      public_url: `/content/docs/page-${index + 1}/`,
    }));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(list(items))));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PagesPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    const selectPage = await screen.findByRole('checkbox', {
      name: 'Select up to 10 Pages on this page',
    });
    const table = screen.getByRole('table', { name: 'Pages' });
    expect(table).toHaveClass('studio-table-stacked-compact');
    expect(screen.getAllByRole('checkbox', { name: 'Select up to 10 Pages on this page' }))
      .toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Pages' })).toContainElement(selectPage);
    expect(selectPage.closest('table')).toBeNull();
    expect(table.querySelector('thead input[type="checkbox"]')).toBeNull();
    expect(within(table).getByRole('checkbox', { name: 'Select Page 1' }).closest('td'))
      .toHaveAttribute('data-stack', 'select');
    expect(within(table).getByRole('link', {
      name: /^Page 1\s*\/content\/docs\/page-1\/$/u,
    }).closest('td'))
      .toHaveAttribute('data-stack', 'primary');
    expect(within(table).getByRole('button', { name: 'Actions for Page 1' }).closest('td'))
      .toHaveAttribute('data-stack', 'actions');

    await user.click(screen.getByRole('checkbox', { name: 'Select Page 12' }));
    expect(selectPage).toBePartiallyChecked();
    await user.click(selectPage);

    expect(selectPage).toBeChecked();
    expect(selectPage).not.toBePartiallyChecked();
    expect(within(table).getAllByRole('checkbox', { checked: true })).toHaveLength(10);
    expect(screen.getByRole('checkbox', { name: 'Select Page 10' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Page 11' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select Page 12' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Page 12' })).toBeDisabled();

    await user.click(selectPage);
    expect(within(table).getAllByRole('checkbox', { checked: false })).toHaveLength(12);
    expect(screen.getByRole('checkbox', { name: 'Select Page 12' })).toBeEnabled();
    expect(selectPage).not.toBePartiallyChecked();
  });

  it('renders a plain excerpt context without interpreting markup', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(list([{
      ...page,
      search_match: {
        field: 'excerpt',
        text: '<script>literal</script> recovery guide',
        highlights: [{ start: 25, end: 33 }],
      },
    }]))));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PagesPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    const context = await screen.findByLabelText('Matching excerpt');
    expect(context).toHaveTextContent('<script>literal</script> recovery guide');
    expect(context.querySelector('script')).toBeNull();
    expect(context.querySelector('mark')).toHaveTextContent('recovery');
    await user.type(screen.getByRole('searchbox', { name: 'Search Pages' }), 'recovery');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText('1 matching Pages found.')).toBeInTheDocument();
  });

  it('shows effective hierarchy and permanently deletes a trashed Page', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([page]))
      .mockResolvedValueOnce(response({
        success: true,
        data: { status: 'page_deleted', id: page.id },
      }))
      .mockResolvedValueOnce(list([]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PagesPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    const pageLink = await screen.findByRole('link', { name: /Guide/ });
    expect(pageLink).toHaveAttribute('href', `/pages/${page.id}`);
    expect(pageLink).toHaveTextContent('/docs/guide');
    expect(screen.getByText('Docs')).toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Actions for Guide',
    }));
    const actionMenu = screen.getByRole('menu', {
      name: 'Actions for Guide',
    });
    expect(within(actionMenu).getByRole('menuitem', { name: 'Edit' }))
      .toHaveAttribute('href', `/pages/${page.id}`);
    await user.click(within(actionMenu).getByRole('menuitem', {
      name: 'Delete permanently',
    }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));

    expect(await screen.findByText('“Guide” was permanently deleted.'))
      .toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/pages/${page.id}`);
    expect(JSON.parse(String(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body,
    ))).toEqual({ expected_revision: page.revision });
  });

  it('keeps skipped Pages selected and explains hierarchy policy after bulk lifecycle', async () => {
    const fetchMock = vi.fn((path: string) => {
      if (path === '/api/pages/bulk-lifecycle') {
        return Promise.resolve(response({
          success: true,
          data: {
            target_status: 'trash',
            results: [{
              id: page.id,
              outcome: 'skipped',
              reason: 'has_children',
            }],
            summary: {
              requested: 1,
              updated: 0,
              unchanged: 0,
              conflict: 0,
              skipped: 1,
            },
          },
        }));
      }
      return Promise.resolve(list([page]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PagesPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    const checkbox = await screen.findByRole('checkbox', {
      name: 'Select Guide',
    });
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Move to Trash' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', {
      name: 'Apply status',
    }));

    expect(await screen.findByText('Bulk Page lifecycle completed'))
      .toBeInTheDocument();
    expect(screen.getByText(
      'Move its direct child Pages before moving it to Trash.',
      { exact: false },
    ))
      .toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select Guide' })).toBeChecked();
  });

  it('ends the local session when list authentication is lost', async () => {
    const onSessionEnded = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    }, 401)));
    render(
      <MemoryRouter>
        <PagesPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={onSessionEnded}
        />
      </MemoryRouter>,
    );
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
  });
});

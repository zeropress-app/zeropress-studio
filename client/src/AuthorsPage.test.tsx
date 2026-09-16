// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import type {
  Author,
  AuthorListSummary,
} from '../../contracts/authors';
import { AuthorsPage } from './AuthorsPage';
import { changeLocale } from './i18n';
import { StudioToaster } from './components/primitives';

const session: CurrentSessionSuccess['data'] = {
  user: {
    id: '1'.repeat(32),
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
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

const author: Author = {
  id: 'Lael-Rukius',
  display_name: 'Lael Rukius',
  user: {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    status: 'active' as const,
  },
  avatar: null,
  revision: '3'.repeat(32),
  created_at_iso: '2026-08-01T08:00:00.000Z',
  updated_at_iso: '2026-08-01T08:00:00.000Z',
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authorList(
  items: Author[],
  summary: AuthorListSummary = {
    total: items.length,
    linked: items.filter((item) => item.user !== null).length,
    unlinked: items.filter((item) => item.user === null).length,
  },
) {
  return response({
    success: true,
    data: {
      items: items.map((item) => ({ ...item, post_count: 0 })),
      pagination: {
        page: 1,
        per_page: 50,
        total: items.length,
        total_pages: items.length === 0 ? 0 : 1,
      },
      summary,
    },
  });
}

function userOptions(linkedAuthorId: string | null) {
  return response({
    success: true,
    data: {
      items: [{
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        status: 'active',
        linked_author_id: linkedAuthorId,
      }],
    },
  });
}

function renderPage(onSessionEnded = vi.fn(), initialEntry = '/authors') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <StudioToaster />
      <AuthorsPage data={session} onSessionEnded={onSessionEnded} />
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

describe('AuthorsPage', () => {
  it('uses a Media reference search link as the initial Author filter', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(authorList([author]))
      .mockResolvedValueOnce(userOptions(author.id));
    vi.stubGlobal('fetch', fetchMock);
    renderPage(
      vi.fn(),
      '/authors?search=Lael%20Rukius&edit=Lael-Rukius',
    );

    expect(await screen.findByText(author.id, { selector: 'code' }))
      .toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search' }))
      .toHaveValue('Lael Rukius');
    expect(String(fetchMock.mock.calls[0]?.[0]))
      .toContain('search=Lael+Rukius');
    expect(await screen.findByRole('dialog'))
      .toHaveTextContent('Edit public author');
  });

  it('filters Authors by their optional Studio account link', async () => {
    const fetchMock = vi.fn((request: RequestInfo | URL) => {
      const path = String(request);
      if (path.startsWith('/api/authors?')) {
        return Promise.resolve(authorList([author], {
          total: 5,
          linked: 3,
          unlinked: 2,
        }));
      }
      if (path === '/api/authors/user-options') {
        return Promise.resolve(userOptions(author.id));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(author.id, { selector: 'code' });
    const table = screen.getByRole('table');
    expect(table).toHaveClass('studio-table-stacked-compact');
    expect(within(table).getByText(author.id, { selector: 'code' }).closest('td'))
      .toHaveAttribute('data-stack', 'primary');
    expect(within(table).getByRole('button', { name: `Actions for ${author.display_name}` }).closest('td'))
      .toHaveAttribute('data-stack', 'actions');
    const overview = screen.getByLabelText('Author overview');
    const metricValue = (label: string) => within(
      within(overview).getByText(label, { selector: 'dt' }).parentElement!,
    ).getByText(/\d/u, { selector: 'dd' });
    expect(metricValue('All authors')).toHaveTextContent('5');
    expect(metricValue('Linked accounts')).toHaveTextContent('3');
    expect(metricValue('Not linked')).toHaveTextContent('2');
    const filters = screen.getByRole('group', {
      name: 'Filter by account link',
    });
    expect(within(filters).getByRole('button', { name: 'All authors' }))
      .toHaveAttribute('aria-pressed', 'true');

    await user.click(within(filters).getByRole('button', { name: 'Linked' }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([request]) => (
      String(request).includes('linked=linked')
    ))).toBe(true));
    expect(within(filters).getByRole('button', { name: 'Linked' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('creates an immutable public ID and optional one-to-one account link', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(authorList([]))
      .mockResolvedValueOnce(userOptions(null))
      .mockResolvedValueOnce(response({ success: true, data: author }, 201))
      .mockResolvedValueOnce(authorList([author]))
      .mockResolvedValueOnce(userOptions(author.id));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('heading', { name: 'No authors yet' }))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New author' }));
    await user.type(screen.getByRole('textbox', { name: 'Display name' }), 'Lael Rukius');
    expect(screen.getByRole('textbox', { name: 'Author ID' }))
      .toHaveValue('Lael-Rukius');
    await user.selectOptions(
      screen.getByRole('combobox', {
        name: 'Linked Studio account (optional)',
      }),
      session.user.id,
    );
    await user.click(screen.getByRole('button', { name: 'Create author' }));

    expect(await screen.findByText('Lael Rukius was created.'))
      .toBeInTheDocument();
    expect(screen.getByText(author.id, { selector: 'code' }))
      .toBeInTheDocument();
    const mutation = fetchMock.mock.calls[2];
    expect(mutation?.[0]).toBe('/api/authors');
    expect(mutation?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'X-ZeroPress-CSRF': session.csrf_token,
      }),
    });
    expect(JSON.parse(String((mutation?.[1] as RequestInit).body))).toEqual({
      id: author.id,
      display_name: author.display_name,
      user_id: session.user.id,
      avatar_media_id: null,
    });
  });

  it('keeps Author ID read-only while editing and reports revision conflicts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(authorList([author]))
      .mockResolvedValueOnce(userOptions(author.id))
      .mockResolvedValueOnce(response({
        success: false,
        error: { code: 'AUTHOR_REVISION_CONFLICT' },
      }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(author.id, { selector: 'code' });
    expect(screen.getByRole('link', { name: 'View Posts' }))
      .toHaveAttribute('href', '/posts?author_id=Lael-Rukius');
    await user.click(screen.getByRole('button', {
      name: 'Actions for Lael Rukius',
    }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    expect(screen.getByRole('textbox', { name: 'Author ID' }))
      .toHaveAttribute('readonly');
    const displayName = screen.getByRole('textbox', { name: 'Display name' });
    await user.clear(displayName);
    await user.type(displayName, 'Updated Name');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This author changed after you opened it',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const mutation = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(JSON.parse(String(mutation.body))).toMatchObject({
      display_name: 'Updated Name',
      expected_revision: author.revision,
    });
  });

  it('selects an image through the shared Media picker and saves its Media ID', async () => {
    const mediaId = '9'.repeat(32);
    const avatar = {
      id: mediaId,
      kind: 'image',
      filename: 'avatar.png',
      mime_type: 'image/png',
      location: {
        type: 'external',
        url: 'https://media.example.com/authors/avatar.png',
      },
      size_bytes: 1024,
      width: 256,
      height: 256,
      duration_ms: null,
      alt: '',
      collection: null,
      usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
      revision: '8'.repeat(32),
      created_at_iso: author.created_at_iso,
      updated_at_iso: author.updated_at_iso,
    } as const;
    let updated = false;
    const fetchMock = vi.fn((request: RequestInfo | URL, init?: RequestInit) => {
      const path = String(request);
      if (path.startsWith('/api/authors?')) {
        return Promise.resolve(authorList([updated ? {
          ...author,
          avatar: {
            id: avatar.id,
            filename: avatar.filename,
            mime_type: avatar.mime_type,
            location: avatar.location,
            preview_url: avatar.location.url,
          },
        } : author]));
      }
      if (path === '/api/authors/user-options') {
        return Promise.resolve(userOptions(author.id));
      }
      if (path === '/api/media/collections') {
        return Promise.resolve(response({
          success: true,
          data: {
            items: [],
            total_media_count: 1,
            unfiled_media_count: 1,
          },
        }));
      }
      if (path.includes('purpose=author_avatar')) {
        return Promise.resolve(response({
          success: true,
          data: {
            items: [avatar],
            pagination: {
              page: 1,
              per_page: 50,
              total: 1,
              total_pages: 1,
            },
            delivery: { media_origin: '', r2_preview_available: true },
          },
        }));
      }
      if (path === `/api/authors/${author.id}` && init?.method === 'PUT') {
        updated = true;
        return Promise.resolve(response({
          success: true,
          data: {
            ...author,
            avatar: {
              id: avatar.id,
              filename: avatar.filename,
              mime_type: avatar.mime_type,
              location: avatar.location,
              preview_url: avatar.location.url,
            },
          },
        }));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByText(author.id, { selector: 'code' });
    await user.click(screen.getByRole('button', {
      name: 'Actions for Lael Rukius',
    }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Choose image' }));
    expect(await screen.findByText('avatar.png')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => String(path).includes(
      'purpose=author_avatar',
    ))).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Use avatar.png' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Lael Rukius was updated.');

    const mutation = fetchMock.mock.calls.find(([path, init]) => (
      String(path) === `/api/authors/${author.id}`
      && (init as RequestInit | undefined)?.method === 'PUT'
    ));
    expect(JSON.parse(String((mutation?.[1] as RequestInit).body)))
      .toMatchObject({ avatar_media_id: mediaId });
  });

  it('ends the local session when the API reports authentication loss', async () => {
    const onSessionEnded = vi.fn();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({
        success: false,
        error: { code: 'AUTHENTICATION_REQUIRED' },
      }, 401))
      .mockResolvedValueOnce(userOptions(null)));
    renderPage(onSessionEnded);
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
  });
});

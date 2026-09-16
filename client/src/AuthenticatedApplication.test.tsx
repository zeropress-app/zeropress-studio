// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { AuthenticatedApplication } from './AuthenticatedApplication';
import { changeLocale } from './i18n';

const editorSession: CurrentSessionSuccess['data'] = {
  user: {
    id: '1'.repeat(32),
    email: 'editor@example.com',
    name: 'Site Editor',
    roles: ['editor'],
  },
  session: {
    id: '2'.repeat(32),
    created_at_iso: '2026-07-31T00:00:00.000Z',
    last_seen_at_iso: '2026-07-31T00:05:00.000Z',
    idle_expires_at_iso: '2026-07-31T12:05:00.000Z',
    absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
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
const adminSession: CurrentSessionSuccess['data'] = {
  ...editorSession,
  user: { ...editorSession.user, roles: ['admin'] },
};
const edgeDisabledAdminSession: CurrentSessionSuccess['data'] = {
  ...adminSession,
  edge_integration: { mode: 'disabled', database_state: null },
};
const edgeUpgradeAdminSession: CurrentSessionSuccess['data'] = {
  ...adminSession,
  edge_integration: {
    mode: 'enabled',
    database_state: 'upgrade_required',
  },
};
const authorSession: CurrentSessionSuccess['data'] = {
  ...editorSession,
  user: { ...editorSession.user, roles: ['author'] },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('AuthenticatedApplication authorization presentation', () => {
  it('hides Edge-managed navigation and explains disabled direct routes', async () => {
    const first = render(
      <MemoryRouter initialEntries={['/comments']}>
        <AuthenticatedApplication
          data={edgeDisabledAdminSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', {
      name: 'Edge services are disabled',
    })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Comments' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Forms' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Newsletters' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('link', {
      name: 'Open Edge Services settings',
    })).toHaveAttribute('href', '/settings/edge');
    expect(screen.queryByRole('navigation', { name: 'Edge services' }))
      .not.toBeInTheDocument();
    first.unmount();

    render(
      <MemoryRouter initialEntries={['/settings/edge/comments']}>
        <AuthenticatedApplication
          data={edgeDisabledAdminSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', {
      name: 'Edge services are disabled',
    })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Edge services' }))
      .toHaveClass('edge-settings-navigation');
    expect(screen.getByRole('combobox', { name: 'Edge services section' }))
      .toHaveValue('/settings/edge');
    expect(screen.queryByRole('link', { name: 'Comments' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mail delivery' }))
      .toBeInTheDocument();
  });

  it('pauses only Edge-backed routes when the Edge database needs upgrade', async () => {
    render(
      <MemoryRouter initialEntries={['/forms']}>
        <AuthenticatedApplication
          data={edgeUpgradeAdminSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', {
      name: 'Edge services need a database upgrade',
    })).toBeInTheDocument();
    expect(screen.getByRole('link', {
      name: 'Open Maintenance & Recovery',
    })).toHaveAttribute('href', '/system/operations/edge');
    expect(screen.getByRole('link', { name: 'Posts' })).toBeInTheDocument();
  });

  it('shows Post management to editors and resolves the direct route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        access: { scope: 'all' },
        items: [],
        pagination: {
          page: 1,
          per_page: 50,
          total: 0,
          total_pages: 0,
        },
        status_counts: {
          all: 0,
          draft: 0,
          published: 0,
          trash: 0,
        },
      },
    }), { headers: { 'Content-Type': 'application/json' } })));
    render(
      <MemoryRouter initialEntries={['/posts']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'No Posts yet' }))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Posts' }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('opens scoped Posts but not Pages for Authors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        access: {
          scope: 'own',
          author: { id: 'site-author', display_name: 'Site Author' },
        },
        items: [],
        pagination: { page: 1, per_page: 50, total: 0, total_pages: 0 },
        status_counts: { all: 0, draft: 0, published: 0, trash: 0 },
      },
    }), { headers: { 'Content-Type': 'application/json' } })));
    const { unmount } = render(
      <MemoryRouter initialEntries={['/posts']}>
        <AuthenticatedApplication
          data={authorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByText(
      'Showing only Posts assigned to your public Author profile, Site Author.',
    )).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Posts' }))
      .toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Pages' }))
      .not.toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter initialEntries={['/pages']}>
        <AuthenticatedApplication
          data={authorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', {
      name: 'You cannot open this Studio page',
    })).toBeInTheDocument();
  });

  it('shows Page management to editors and resolves the direct route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        items: [],
        pagination: {
          page: 1,
          per_page: 50,
          total: 0,
          total_pages: 0,
        },
        status_counts: {
          all: 0,
          draft: 0,
          published: 0,
          trash: 0,
        },
      },
    }), { headers: { 'Content-Type': 'application/json' } })));
    render(
      <MemoryRouter initialEntries={['/pages']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'No Pages yet' }))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pages' }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('shows taxonomy management to editors and resolves the direct route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        items: [],
        pagination: {
          page: 1,
          per_page: 50,
          total: 0,
          total_pages: 0,
        },
      },
    }), { headers: { 'Content-Type': 'application/json' } })));
    render(
      <MemoryRouter initialEntries={['/taxonomy']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Categories & Tags' }))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Categories & Tags' }))
      .toBeInTheDocument();
  });

  it('shows Menu management to editors and resolves the direct route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => (
      Promise.resolve(new Response(JSON.stringify({
        success: true,
        data: { items: [] },
      }), { headers: { 'Content-Type': 'application/json' } }))
    )));
    render(
      <MemoryRouter initialEntries={['/menus']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Menus' }))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Menus' }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('shows Widget management to editors and resolves the direct route', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => (
      Promise.resolve(new Response(JSON.stringify(path.includes(
        '/api/widgets/author-options',
      ) ? {
        success: true,
        data: { items: [] },
      } : {
        success: true,
        data: { items: [] },
      }), { headers: { 'Content-Type': 'application/json' } }))
    )));
    render(
      <MemoryRouter initialEntries={['/widgets']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Widgets' }))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Widgets' }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('hides user management and rejects its direct route for an editor', async () => {
    render(
      <MemoryRouter initialEntries={['/users']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', {
      name: 'You cannot open this Studio page',
    })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Users' }))
      .not.toBeInTheDocument();
  });

  it('keeps WordPress import available without a persistent sidebar item', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/import/wordpress']}>
        <AuthenticatedApplication
          data={adminSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', {
      name: 'Import from WordPress',
    })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import WordPress' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Site settings' }))
      .not.toBeInTheDocument();
    unmount();

    render(
      <MemoryRouter initialEntries={['/import/wordpress']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', {
      name: 'You cannot open this Studio page',
    })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import WordPress' }))
      .not.toBeInTheDocument();
  });

  it.each([
    '/settings/import/wordpress',
    '/settings/general',
    '/settings/edge-services',
  ])('does not retain the former flat route %s', async (path) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <AuthenticatedApplication
          data={adminSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', {
      name: 'Page not found',
    })).toBeInTheDocument();
  });

  it('exposes Newsletter management only to administrators', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => {
      const payload = path.includes('/runtime')
        ? {
            success: true,
            data: {
              confirmation_enabled: false,
              mail_configured: false,
              ready: false,
              updated_at_iso: '2026-08-01T00:00:00.000Z',
            },
          }
        : {
            success: true,
            data: {
              items: [],
              pagination: {
                page: 1,
                per_page: 100,
                total: 0,
                total_pages: 0,
              },
            },
          };
      return Promise.resolve(new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    const { unmount } = render(
      <MemoryRouter initialEntries={['/newsletters']}>
        <AuthenticatedApplication
          data={adminSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Newsletters' }))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Newsletters' }))
      .toHaveAttribute('aria-current', 'page');
    unmount();

    render(
      <MemoryRouter initialEntries={['/newsletters']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', {
      name: 'You cannot open this Studio page',
    })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Newsletters' }))
      .not.toBeInTheDocument();
  });

  it('exposes Form management to editors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      const payload = {
        success: true,
        data: {
          items: [],
          pagination: {
            page: 1,
            per_page: 100,
            total: 0,
            total_pages: 0,
          },
        },
      };
      return Promise.resolve(new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    render(
      <MemoryRouter initialEntries={['/forms']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Forms' }))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Forms' }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('hides author management and rejects its direct route for an editor', async () => {
    render(
      <MemoryRouter initialEntries={['/authors']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', {
      name: 'You cannot open this Studio page',
    })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Authors' }))
      .not.toBeInTheDocument();
  });

  it('hides General Settings and rejects its direct route for an editor', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/site/general']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', {
      name: 'You cannot open this Studio page',
    })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Site settings' }))
      .not.toBeInTheDocument();
  });

  it('rejects the output settings route for an editor', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/site/output']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', {
      name: 'You cannot open this Studio page',
    })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Site settings' }))
      .not.toBeInTheDocument();
  });

  it('rejects the URLs and Homepage settings route for an editor', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/site/routing']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', {
      name: 'You cannot open this Studio page',
    })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Site settings' }))
      .not.toBeInTheDocument();
  });

  it('hides site export and rejects its direct route for an editor', async () => {
    render(
      <MemoryRouter initialEntries={['/publish']}>
        <AuthenticatedApplication
          data={editorSession}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', {
      name: 'You cannot open this Studio page',
    })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Export' }))
      .not.toBeInTheDocument();
  });
});

// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { DashboardPage } from './DashboardPage';
import { changeLocale } from './i18n';

const dashboardData: CurrentSessionSuccess['data'] = {
  user: {
    id: '0123456789abcdef0123456789abcdef',
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin', 'editor'],
  },
  session: {
    id: 'fedcba9876543210fedcba9876543210',
    created_at_iso: '2026-07-31T00:00:00.000Z',
    last_seen_at_iso: '2026-07-31T00:05:00.000Z',
    idle_expires_at_iso: '2026-07-31T12:05:00.000Z',
    absolute_expires_at_iso: '2026-08-07T00:00:00.000Z',
    network: {
      ip_address: '203.0.113.41',
      asn: 13335,
      as_organization: 'Cloudflare, Inc.',
      country_code: 'KR',
    },
  },
  csrf_token: 'c'.repeat(43),
  edge_integration: { mode: 'enabled', database_state: 'ready' },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    success: true,
    data: {
      generated_at_iso: '2026-08-04T01:00:00.000Z',
      content: {
        posts: {
          access: { scope: 'all' },
          total: 9,
          draft: 2,
          published: 6,
          trash: 1,
        },
        pages: { total: 4, draft: 1, published: 3, trash: 0 },
        media: { total: 7, managed: 5, external: 2 },
      },
      mail: { configured: true },
      content_search_index: { state: 'ready' },
      edge: {
        status: 'available',
        pending_target_events: 0,
        comments: { pending: 2, enabled: true, api_configured: true },
        forms: { unread_submissions: 3 },
        newsletters: {
          pending_confirmations: 1, confirmation_enabled: true,
          confirmation_ready: true,
        },
      },
    },
  }), { headers: { 'Content-Type': 'application/json' } })));
});

describe('DashboardPage', () => {
  it.each([
    { locale: 'en' as const, region: 'Service readiness', comments: 'Comment settings', newsletter: 'Delivery settings', mail: 'Mail settings', unconfigured: 'Not configured' },
    { locale: 'ko' as const, region: '서비스 준비 상태', comments: '댓글 설정', newsletter: '전송 설정', mail: '메일 설정', unconfigured: '미설정' },
  ])('connects readiness actions to the relevant settings in $locale', async (copy) => {
    await changeLocale(copy.locale);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        generated_at_iso: '2026-08-04T01:00:00.000Z',
        content: { posts: null, pages: null, media: null },
        content_search_index: { state: 'ready' },
        mail: { configured: false },
        edge: {
          status: 'available', pending_target_events: 0,
          comments: { pending: 0, enabled: true, api_configured: false },
          forms: null,
          newsletters: { pending_confirmations: 0, confirmation_enabled: false, confirmation_ready: false },
        },
      },
    })));
    render(<MemoryRouter><DashboardPage data={dashboardData} onSessionEnded={vi.fn()} /></MemoryRouter>);

    const readiness = within(await screen.findByRole('region', { name: copy.region }));
    expect(readiness.getByRole('link', { name: copy.comments }))
      .toHaveAttribute('href', '/settings/edge/comments#comment-api');
    expect(readiness.getByRole('link', { name: copy.newsletter }))
      .toHaveAttribute('href', '/newsletters?tab=runtime');
    expect(readiness.getByRole('link', { name: copy.mail }))
      .toHaveAttribute('href', '/settings/edge/mail');
    expect(readiness.getByText(copy.unconfigured)).toBeVisible();
  });

  it.each(['admin', 'editor'] as const)('offers Edge configuration only to an authorized %s', async (role) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        generated_at_iso: '2026-08-04T01:00:00.000Z',
        content: { posts: null, pages: null, media: null },
        content_search_index: null, mail: null,
        edge: { status: 'disabled', pending_target_events: 0 },
      },
    })));
    render(<MemoryRouter><DashboardPage
      data={{ ...dashboardData, user: { ...dashboardData.user, roles: [role] } }}
      onSessionEnded={vi.fn()}
    /></MemoryRouter>);
    const readiness = within(await screen.findByRole('region', { name: 'Service readiness' }));
    expect(readiness.getByText('Disabled')).toBeVisible();
    if (role === 'admin') {
      expect(readiness.getByRole('link', { name: 'Edge settings' }))
        .toHaveAttribute('href', '/settings/edge');
    } else {
      expect(readiness.queryByRole('link')).not.toBeInTheDocument();
    }
  });

  it('keeps comment readiness visible to editors without offering administrator settings', async () => {
    render(<MemoryRouter><DashboardPage
      data={{ ...dashboardData, user: { ...dashboardData.user, roles: ['editor'] } }}
      onSessionEnded={vi.fn()}
    /></MemoryRouter>);
    const readiness = within(await screen.findByRole('region', { name: 'Service readiness' }));
    expect(readiness.getByRole('group', { name: 'Comments' })).toHaveTextContent('Ready');
    expect(readiness.queryByRole('link')).not.toBeInTheDocument();
    expect(readiness.queryByRole('button')).not.toBeInTheDocument();
  });

  it('avoids repeating account details and shows the capability-aware operational overview', async () => {
    const view = render(<MemoryRouter><DashboardPage data={dashboardData} onSessionEnded={vi.fn()} /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Dashboard' }))
      .toBeInTheDocument();
    expect(screen.queryByText('Studio Owner')).not.toBeInTheDocument();
    expect(screen.queryByText('owner@example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('203.0.113.41')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Content overview')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Posts/ })).toHaveTextContent('9');
    expect(screen.getByText('comments awaiting moderation')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Create a Post/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import from WordPress' }))
      .not.toBeInTheDocument();
    const secondaryGrid = view.container.querySelector('.dashboard-secondary-grid');
    expect(secondaryGrid).not.toBeNull();
    expect(secondaryGrid).toContainElement(
      screen.getByRole('heading', { name: 'Needs review' }).closest('section'),
    );
    expect(secondaryGrid).toContainElement(
      screen.getByRole('heading', { name: 'Quick actions' }).closest('section'),
    );
  });

  it('offers WordPress import to an administrator only while Posts and Pages are both empty', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        generated_at_iso: '2026-08-04T01:00:00.000Z',
        content: {
          posts: {
            access: { scope: 'all' },
            total: 0,
            draft: 0,
            published: 0,
            trash: 0,
          },
          pages: { total: 0, draft: 0, published: 0, trash: 0 },
          media: { total: 0, managed: 0, external: 0 },
        },
        mail: null,
        content_search_index: { state: 'ready' },
        edge: { status: 'not_requested' },
      },
    })));
    render(
      <MemoryRouter>
        <DashboardPage data={dashboardData} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('link', { name: 'Import from WordPress' }))
      .toHaveAttribute('href', '/import/wordpress');
  });

  it('keeps Studio data visible when the Edge overview is unavailable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        generated_at_iso: '2026-08-04T01:00:00.000Z',
        content: {
          posts: {
            access: { scope: 'all' },
            total: 1,
            draft: 0,
            published: 1,
            trash: 0,
          },
          pages: null,
          media: null,
        },
        mail: null,
        content_search_index: null,
        edge: { status: 'unavailable', pending_target_events: 0 },
      },
    })));
    render(<MemoryRouter><DashboardPage data={{ ...dashboardData, user: { ...dashboardData.user, roles: ['editor'] } }} onSessionEnded={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByText('Edge overview is temporarily unavailable')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Posts/ })).toHaveTextContent('1');
  });

  it('shows disabled Edge integration only as a capability-aware readiness row', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        generated_at_iso: '2026-08-04T01:00:00.000Z',
        content: {
          posts: {
            access: { scope: 'all' },
            total: 1,
            draft: 0,
            published: 1,
            trash: 0,
          },
          pages: null,
          media: null,
        },
        mail: null,
        content_search_index: null,
        edge: { status: 'disabled', pending_target_events: 0 },
      },
    })));

    render(
      <MemoryRouter>
        <DashboardPage
          data={{
            ...dashboardData,
            user: { ...dashboardData.user, roles: ['editor'] },
          }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Service readiness' }))
      .toBeInTheDocument();
    const row = screen.getByText('Studio Edge integration')
      .closest('.dashboard-runtime-row');
    expect(row).toHaveTextContent('Studio Edge integration');
    expect(row).toHaveTextContent('Disabled');
    expect(screen.queryByText('Studio Edge integration is disabled'))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Edge Services/ }))
      .not.toBeInTheDocument();
  });

  it('explains target reconciliation without presenting it as an Edge outage', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        generated_at_iso: '2026-08-04T01:00:00.000Z',
        content: {
          posts: {
            access: { scope: 'all' },
            total: 454,
            draft: 180,
            published: 274,
            trash: 0,
          },
          pages: { total: 9, draft: 8, published: 1, trash: 0 },
          media: { total: 1857, managed: 1, external: 1856 },
        },
        mail: { configured: false },
        content_search_index: { state: 'ready' },
        edge: {
          status: 'reconciliation_required',
          pending_target_events: 0,
          comments: { pending: 2, enabled: true, api_configured: true },
          forms: { unread_submissions: 3 },
          newsletters: {
            pending_confirmations: 1,
            confirmation_enabled: false,
            confirmation_ready: false,
          },
        },
      },
    })));

    render(
      <MemoryRouter>
        <DashboardPage data={dashboardData} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Check Edge comment links'))
      .toBeInTheDocument();
    expect(screen.queryByText('Edge overview is temporarily unavailable'))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' }))
      .not.toBeInTheDocument();
    expect(screen.queryByText(/Worker operational log/))
      .not.toBeInTheDocument();
    expect(screen.getByText('comments awaiting moderation'))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review Edge Services' }))
      .toHaveAttribute('href', '/settings/edge');
  });

  it('names the linked Author workspace and hides creation when the link is unavailable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        generated_at_iso: '2026-08-04T01:00:00.000Z',
        content: {
          posts: {
            access: {
              scope: 'own',
              author: { id: 'Site-Author', display_name: 'Site Author' },
            },
            total: 2,
            draft: 1,
            published: 1,
            trash: 0,
          },
          pages: null,
          media: null,
        },
        mail: null,
        content_search_index: null,
        edge: { status: 'not_requested' },
      },
    })));
    const authorData = {
      ...dashboardData,
      user: { ...dashboardData.user, roles: ['author'] },
    };
    const view = render(
      <MemoryRouter>
        <DashboardPage data={authorData} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('link', { name: /My Posts · Site Author/ }))
      .toHaveTextContent('2');
    expect(screen.getByRole('link', { name: 'Create a Post' }))
      .toBeInTheDocument();
    expect(screen.queryByText('Studio Edge integration'))
      .not.toBeInTheDocument();

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: {
        generated_at_iso: '2026-08-04T01:01:00.000Z',
        content: {
          posts: {
            access: {
              scope: 'unavailable',
              reason: 'author_not_linked',
            },
            total: 0,
            draft: 0,
            published: 0,
            trash: 0,
          },
          pages: null,
          media: null,
        },
        mail: null,
        content_search_index: null,
        edge: { status: 'not_requested' },
      },
    })));
    view.unmount();
    render(
      <MemoryRouter>
        <DashboardPage data={authorData} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByText(
      'Ask an administrator to link your account to a public Author profile before writing Posts.',
    )).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create a Post' }))
      .not.toBeInTheDocument();
  });

  it('offers verified optional Access only to a settings administrator', async () => {
    const fetchMock = vi.fn((path: string) => Promise.resolve(new Response(
      JSON.stringify(path === '/api/settings/access' ? {
        success: true,
        data: {
          settings: {
            mode: 'disabled',
            issuer: null,
            audience: null,
            bound_origin: null,
            verified_at_iso: null,
          },
          revision: '1'.repeat(32),
          updated_at_iso: null,
          detection_state: 'verified',
          detected: {
            issuer: 'https://zeropress.cloudflareaccess.com',
            team_domain: 'zeropress',
            audience: 'a'.repeat(64),
            identity_email: 'owner@example.com',
          },
        },
      } : {
        success: true,
        data: {
          generated_at_iso: '2026-08-28T01:00:00.000Z',
          content: {
            posts: {
              access: { scope: 'all' },
              total: 1,
              draft: 0,
              published: 1,
              trash: 0,
            },
            pages: null,
            media: null,
          },
          mail: null,
          content_search_index: { state: 'ready' },
          edge: { status: 'not_requested' },
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <DashboardPage data={dashboardData} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Strengthen Studio access'))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review Studio access' }))
      .toHaveAttribute('href', '/system/operations/access');
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/dashboard/summary',
      '/api/settings/access',
    ]);
  });
});

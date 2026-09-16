// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  screen,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import packageJson from '../../../package.json';
import type { CurrentSessionSuccess } from '../../../contracts/session';
import { changeLocale } from '../i18n';
import {
  setThemePreference,
  THEME_STORAGE_KEY,
} from '../lib/theme-preference';
import { PageHeader } from './primitives';
import { StudioShell } from './StudioShell';

const sessionData: CurrentSessionSuccess['data'] = {
  user: {
    id: '0123456789abcdef0123456789abcdef',
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
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
  site_title: 'Editorial Magazine',
  site_url: 'https://example.com',
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function TestPage(input: {
  description?: string;
  kicker?: string;
  title: string;
  content: string;
}) {
  const titleId = `${input.title.toLowerCase().replace(/[^a-z]+/gu, '-')}-title`;
  return (
    <main id="studio-main-content" aria-labelledby={titleId}>
      <PageHeader
        titleId={titleId}
        kicker={input.kicker}
        title={input.title}
        description={input.description}
      />
      <p>{input.content}</p>
    </main>
  );
}

function renderShell(input: {
  data?: CurrentSessionSuccess['data'];
  initialPath?: string;
  onSessionEnded?: () => void;
} = {}) {
  return render(
    <MemoryRouter initialEntries={[input.initialPath ?? '/']}>
      <Routes>
        <Route
          element={(
            <StudioShell
              data={input.data ?? sessionData}
              onSessionEnded={input.onSessionEnded ?? vi.fn()}
            />
          )}
        >
          <Route
            index
            element={(
              <TestPage
                kicker="STUDIO"
                title="Dashboard"
                content="Dashboard content"
              />
            )}
          />
          <Route
            path="my-account/preferences"
            element={(
              <TestPage
                kicker="PREFERENCES"
                title="Studio preferences"
                content="Preferences content"
              />
            )}
          />
          <Route
            path="my-account/security"
            element={(
              <TestPage
                kicker="ACCOUNT SECURITY"
                title="Account security"
                content="Security content"
              />
            )}
          />
          <Route
            path="settings/site/output"
            element={(
              <TestPage
                kicker="SITE OUTPUT"
                title="Homepage & output"
                content="Output settings content"
              />
            )}
          />
          <Route
            path="settings/site/routing"
            element={(
              <TestPage
                kicker="ROUTING"
                title="URLs & Homepage"
                content="Routing settings content"
              />
            )}
          />
          <Route
            path="settings/site/media"
            element={(
              <TestPage
                kicker="MEDIA DELIVERY"
                title="Media settings"
                description="Configure media delivery."
                content="Media settings content"
              />
            )}
          />
          <Route
            path="settings/edge/mail"
            element={(
              <TestPage
                kicker="MAIL DELIVERY"
                title="Mail delivery"
                content="Mail settings content"
              />
            )}
          />
          <Route
            path="publish"
            element={(
              <TestPage
                kicker="SITE EXPORT"
                title="Export site data"
                content="Export content"
              />
            )}
          />
          <Route
            path="posts/:postId"
            element={(
              <TestPage
                kicker="CONTENT"
                title="Edit Post"
                content="Post editor content"
              />
            )}
          />
          <Route
            path="pages/:pageId"
            element={(
              <TestPage
                kicker="CONTENT"
                title="Edit Page"
                content="Page editor content"
              />
            )}
          />
          <Route
            path="import/wordpress"
            element={(
              <TestPage
                kicker="WORDPRESS MIGRATION"
                title="Import from WordPress"
                description="Import an existing WordPress site."
                content="WordPress import content"
              />
            )}
          />
          <Route
            path="comments"
            element={(
              <TestPage
                kicker="COMMENT MODERATION"
                title="Comments"
                description="Review and moderate comments."
                content="Comments content"
              />
            )}
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  setThemePreference('system');
  await changeLocale('en');
});

describe('StudioShell', () => {
  it.each([
    {
      path: '/settings/site/media',
      kicker: 'MEDIA DELIVERY',
      title: 'Media settings',
      description: 'Configure media delivery.',
    },
    {
      path: '/import/wordpress',
      kicker: 'WORDPRESS MIGRATION',
      title: 'Import from WordPress',
      description: 'Import an existing WordPress site.',
    },
    {
      path: '/comments',
      kicker: 'COMMENT MODERATION',
      title: 'Comments',
      description: 'Review and moderate comments.',
    },
  ])(
    'keeps the $path title and description in the persistent topbar',
    ({ path, kicker, title, description }) => {
      renderShell({ initialPath: path });

      const topbar = document.querySelector('.studio-topbar');
      const pageContext = document.querySelector('.studio-page-context');
      const main = screen.getByRole('main', { name: title });
      const heading = within(topbar as HTMLElement).getByRole('heading', {
        level: 1,
        name: title,
      });

      expect(topbar).not.toBeNull();
      expect(pageContext).not.toBeNull();
      expect(heading).toHaveClass('studio-page-context-title');
      expect(heading).toHaveAttribute('id', main.getAttribute('aria-labelledby'));
      expect(within(pageContext as HTMLElement).getByText(description))
        .toHaveClass('studio-page-context-description');
      expect(within(main).queryByRole('heading', { level: 1 })).toBeNull();
      expect(within(main).queryByText(kicker)).toBeNull();
      expect(document.querySelector('.studio-page-header')).toBeNull();
    },
  );

  it('keeps product navigation in the sidebar and account actions in the account menu', async () => {
    const user = userEvent.setup();
    renderShell();

    const studioNavigation = screen.getByRole('navigation', {
      name: 'Studio navigation',
    });
    expect(within(studioNavigation).getByRole('link', {
      name: 'Dashboard',
    })).toHaveAttribute('aria-current', 'page');
    // The version belongs in the content footer's contentinfo landmark, outside the sidebar.
    expect(within(screen.getByRole('contentinfo'))
      .getByText(`ZeroPress Studio ${packageJson.version}`))
      .toBeInTheDocument();
    expect(within(document.getElementById('studio-sidebar') as HTMLElement)
      .queryByText(new RegExp(packageJson.version, 'u')))
      .not.toBeInTheDocument();
    const siteTitle = screen.getByText('Editorial Magazine');
    expect(siteTitle).toHaveClass('studio-site-title');
    expect(siteTitle.parentElement?.children[0]).toBe(siteTitle);
    const visitSite = screen.getByRole('link', { name: 'Visit Site' });
    expect(visitSite).toHaveAttribute('href', 'https://example.com');
    expect(visitSite).toHaveAttribute('target', '_blank');
    expect(visitSite).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(studioNavigation).getByRole('link', {
      name: 'Users',
    })).toBeInTheDocument();
    expect(within(studioNavigation).getByRole('link', {
      name: 'Export',
    })).toBeInTheDocument();
    expect(within(studioNavigation).getByRole('link', {
      name: 'Authors',
    })).toBeInTheDocument();
    expect(within(studioNavigation).getByRole('link', {
      name: 'Posts',
    })).toBeInTheDocument();
    expect(within(studioNavigation).getByRole('link', {
      name: 'Pages',
    })).toBeInTheDocument();
    expect(within(studioNavigation).getByRole('link', {
      name: 'Menus',
    })).toBeInTheDocument();
    expect(within(studioNavigation).getByRole('link', {
      name: 'Newsletters',
    })).toBeInTheDocument();
    expect(within(studioNavigation).getByRole('link', {
      name: 'Forms',
    })).toBeInTheDocument();
    expect(within(studioNavigation).getByRole('link', {
      name: 'Site settings',
    })).toBeInTheDocument();
    expect(within(studioNavigation).queryByRole('link', {
      name: 'Import WordPress',
    })).not.toBeInTheDocument();
    expect(within(studioNavigation).getByRole('link', {
      name: 'Edge services',
    })).toBeInTheDocument();
    expect(within(studioNavigation).getAllByRole('link').map((link) => (
      link.textContent?.trim()
    ))).toEqual([
      'Dashboard',
      'Export',
      'Posts',
      'Pages',
      'Media',
      'Authors',
      'Categories & Tags',
      'Comments',
      'Forms',
      'Newsletters',
      'Edge services',
      'Menus',
      'Widgets',
      'Site settings',
      'Users',
    ]);
    expect(within(studioNavigation).getByText('Overview'))
      .toHaveClass('visually-hidden');
    expect(within(studioNavigation).getByText('Content'))
      .toHaveClass('studio-navigation-section-label');
    expect(within(studioNavigation).getByText('Engagement'))
      .toHaveClass('studio-navigation-section-label');
    expect(within(studioNavigation).getByText('Site'))
      .toHaveClass('studio-navigation-section-label');
    expect(within(studioNavigation).getByText('Utilities'))
      .toHaveClass('visually-hidden');
    expect(within(studioNavigation).queryByRole('link', {
      name: 'Account security',
    })).not.toBeInTheDocument();
    expect(screen.queryByText(sessionData.user.email)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', {
      name: 'Open account menu for Studio Owner',
    }));
    const accountMenu = document.getElementById('studio-account-menu');
    expect(accountMenu).not.toBeNull();
    expect(within(accountMenu as HTMLElement).getByText('Administrator'))
      .toBeInTheDocument();
    expect(within(accountMenu as HTMLElement)
      .queryByText(sessionData.user.email)).not.toBeInTheDocument();
    const accountNavigation = screen.getByRole('navigation', {
      name: 'Account navigation',
    });
    expect(within(accountNavigation).getByRole('link', {
      name: 'Studio preferences',
    })).toBeInTheDocument();
    await user.click(within(accountNavigation).getByRole('link', {
      name: 'Account security',
    }));

    expect(await screen.findByText('Security content')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Account security' }))
      .toBeInTheDocument();
    expect(screen.queryByRole('navigation', {
      name: 'Account navigation',
    })).not.toBeInTheDocument();
  });

  it('shows every assigned system role in product order without exposing email', async () => {
    const user = userEvent.setup();
    renderShell({
      data: {
        ...sessionData,
        user: {
          ...sessionData.user,
          roles: ['author', 'admin', 'editor'],
        },
      },
    });

    expect(screen.queryByText(sessionData.user.email)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Open account menu for Studio Owner',
    }));

    const accountMenu = document.getElementById('studio-account-menu');
    expect(accountMenu).not.toBeNull();
    expect(within(accountMenu as HTMLElement).getByText(
      'Administrator · Editor · Author',
    )).toBeInTheDocument();
    expect(within(accountMenu as HTMLElement)
      .queryByText(sessionData.user.email)).not.toBeInTheDocument();
  });

  it('uses the linked Author avatar and falls back to initials after an image error', () => {
    const { container } = renderShell({
      data: {
        ...sessionData,
        user: {
          ...sessionData.user,
          avatar_preview_url: 'https://media.example.com/authors/owner.png',
        },
      },
    });
    const avatar = container.querySelector('.studio-account-avatar');
    const image = avatar?.querySelector('img');
    expect(image).toHaveAttribute(
      'src',
      'https://media.example.com/authors/owner.png',
    );
    expect(image).toHaveAttribute('referrerpolicy', 'no-referrer');
    act(() => image?.dispatchEvent(new Event('error')));
    expect(avatar).toHaveTextContent('SO');
    expect(avatar?.querySelector('img')).toBeNull();
  });

  it('keeps interface controls out of the topbar and exposes them on demand', async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.queryByRole('combobox', { name: 'Language' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Appearance' }))
      .not.toBeInTheDocument();

    await user.click(screen.getByRole('button', {
      name: 'Open account menu for Studio Owner',
    }));
    expect(screen.getByRole('group', { name: 'Appearance' }))
      .toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    await user.click(screen.getByRole('link', {
      name: 'Studio preferences',
    }));
    expect(await screen.findByText('Preferences content')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Studio preferences' }))
      .toBeInTheDocument();
  });

  it('keeps the site title while omitting Visit Site without a canonical URL', () => {
    renderShell({ data: { ...sessionData, site_url: undefined } });

    expect(screen.getByText('Editorial Magazine')).toHaveClass(
      'studio-site-title',
    );
    expect(screen.queryByRole('link', { name: 'Visit Site' }))
      .not.toBeInTheDocument();
  });

  it('omits the optional site identity affordances when both values are absent', () => {
    renderShell({
      data: {
        ...sessionData,
        site_title: undefined,
        site_url: undefined,
      },
    });

    expect(screen.queryByText('Editorial Magazine')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Visit Site' }))
      .not.toBeInTheDocument();
  });

  it('shows Authors only the scoped Post workspace', () => {
    renderShell({
      data: {
        ...sessionData,
        user: { ...sessionData.user, roles: ['author'] },
      },
    });
    const studioNavigation = screen.getByRole('navigation', {
      name: 'Studio navigation',
    });
    expect(within(studioNavigation).getByRole('link', { name: 'Posts' }))
      .toBeInTheDocument();
    for (const name of [
      'Pages',
      'Media',
      'Authors',
      'Comments',
      'Site settings',
      'Edge services',
      'Import WordPress',
      'Export',
    ]) {
      expect(within(studioNavigation).queryByRole('link', { name }))
        .not.toBeInTheDocument();
    }
  });

  it('keeps Site settings active on a nested site settings page', () => {
    renderShell({ initialPath: '/settings/site/output' });

    const studioNavigation = screen.getByRole('navigation', {
      name: 'Studio navigation',
    });
    expect(within(studioNavigation).getByRole('link', {
      name: 'Site settings',
    })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Homepage & output' }))
      .toBeInTheDocument();
  });

  it('marks Export active and renders its page heading', () => {
    renderShell({ initialPath: '/publish' });

    const studioNavigation = screen.getByRole('navigation', {
      name: 'Studio navigation',
    });
    expect(within(studioNavigation).getByRole('link', {
      name: 'Export',
    })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Export site data' }))
      .toBeInTheDocument();
  });

  it('keeps Site settings active on the URLs and Homepage route', () => {
    renderShell({ initialPath: '/settings/site/routing' });

    const studioNavigation = screen.getByRole('navigation', {
      name: 'Studio navigation',
    });
    expect(within(studioNavigation).getByRole('link', {
      name: 'Site settings',
    })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'URLs & Homepage' }))
      .toBeInTheDocument();
  });

  it('keeps Edge services active on a nested Edge settings page', () => {
    renderShell({ initialPath: '/settings/edge/mail' });

    const studioNavigation = screen.getByRole('navigation', {
      name: 'Studio navigation',
    });
    expect(within(studioNavigation).getByRole('link', {
      name: 'Edge services',
    })).toHaveAttribute('aria-current', 'page');
    expect(within(studioNavigation).getByRole('link', {
      name: 'Site settings',
    })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('heading', { name: 'Mail delivery' }))
      .toBeInTheDocument();
  });

  it('keeps Posts active on a dynamic editor route', () => {
    renderShell({ initialPath: `/posts/${'a'.repeat(32)}` });

    const studioNavigation = screen.getByRole('navigation', {
      name: 'Studio navigation',
    });
    expect(within(studioNavigation).getByRole('link', {
      name: 'Posts',
    })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Edit Post' }))
      .toBeInTheDocument();
  });

  it('keeps Pages active on a dynamic editor route', () => {
    renderShell({ initialPath: `/pages/${'b'.repeat(32)}` });

    const studioNavigation = screen.getByRole('navigation', {
      name: 'Studio navigation',
    });
    expect(within(studioNavigation).getByRole('link', {
      name: 'Pages',
    })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Edit Page' }))
      .toBeInTheDocument();
  });

  it('keeps a failed global sign-out confirmation open and permits retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        success: false,
        error: { code: 'INTERNAL_ERROR' },
      }, 500))
      .mockResolvedValueOnce(response({
        success: true,
        data: { status: 'logged_out' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onSessionEnded = vi.fn();
    const user = userEvent.setup();
    renderShell({ onSessionEnded });

    await user.click(screen.getByRole('button', {
      name: 'Open account menu for Studio Owner',
    }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Sign out of Studio?',
    });
    expect(within(dialog).getByRole('button', {
      name: 'Stay signed in',
    })).toHaveFocus();

    await user.click(within(dialog).getByRole('button', {
      name: 'Sign out',
    }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Studio could not end this session. Please try again.',
    );
    expect(onSessionEnded).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', {
      name: 'Sign out',
    }));
    expect(onSessionEnded).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns focus to the account button after the sign-out dialog closes', async () => {
    const user = userEvent.setup();
    renderShell();

    const accountButton = screen.getByRole('button', {
      name: 'Open account menu for Studio Owner',
    });
    await user.click(accountButton);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The sign-out button disappears with the account menu. Restore focus to the
    // account button so it does not fall back to the document body.
    expect(accountButton).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });

  it('collapses the sidebar while keeping navigation labels accessible', async () => {
    const user = userEvent.setup();
    renderShell();

    // The collapse button belongs at the bottom of the sidebar.
    const toggle = within(document.getElementById('studio-sidebar') as HTMLElement)
      .getByRole('button', { name: 'Collapse sidebar' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'studio-sidebar');
    // Visible text supplies the accessible name. A separate aria-label could prevent
    // voice-control users from activating it by its visible label (WCAG 2.5.3).
    expect(toggle).not.toHaveAttribute('aria-label');

    await user.click(toggle);

    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    // Show the product tooltip immediately on focus instead of waiting for a native title.
    expect(expand).not.toHaveAttribute('title');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Expand sidebar');
    // Hide the label visually while preserving its accessible name.
    const sidebar = document.getElementById('studio-sidebar');
    const posts = within(sidebar as HTMLElement)
      .getByRole('link', { name: 'Posts' });
    expect(posts).toBeInTheDocument();
    expect(posts).not.toHaveAttribute('title');

    await user.hover(posts);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Posts');

    posts.focus();
    expect(screen.getByRole('tooltip')).toHaveTextContent('Posts');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('remembers the collapsed sidebar across mounts', async () => {
    const user = userEvent.setup();
    const first = renderShell();
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    first.unmount();

    renderShell();
    expect(screen.getByRole('button', { name: 'Expand sidebar' }))
      .toBeInTheDocument();
  });

  it('traps focus in the mobile navigation and restores it after Escape', async () => {
    const user = userEvent.setup();
    renderShell();
    const openButton = screen.getByRole('button', {
      name: 'Open navigation',
    });

    await user.click(openButton);
    const dialog = screen.getByRole('dialog', {
      name: 'Studio navigation',
    });
    expect(within(dialog).getByRole('button', {
      name: 'Close navigation',
    })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', {
      name: 'Studio navigation',
    })).not.toBeInTheDocument();
    expect(openButton).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });
});

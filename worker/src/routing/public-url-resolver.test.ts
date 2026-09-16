import { describe, expect, it } from 'vitest';
import {
  materializeRoutingSettingsDefaults,
  type RoutingSettings,
} from '../../../contracts/routing-settings';
import {
  pagePathToPublicUrl,
  resolveCategoryPublicRoute,
  resolvePagePublicRoute,
  resolvePageNavigationUrl,
  resolvePostPublicRoute,
  resolveTagPublicRoute,
} from './public-url-resolver';

function settings(
  override: Partial<RoutingSettings['permalinks']> = {},
): RoutingSettings {
  const defaults = materializeRoutingSettingsDefaults();
  return {
    ...defaults,
    permalinks: { ...defaults.permalinks, ...override },
  };
}

describe('Studio public URL resolver', () => {
  it('matches canonical directory routes for content and taxonomies', () => {
    const routing = settings();
    expect(resolvePostPublicRoute({
      settings: routing,
      timezone: 'UTC',
      post: {
        slug: 'hello.world',
        public_id: 42,
        published_at_iso: '2026-08-01T00:00:00Z',
        created_at_iso: '2026-07-31T00:00:00Z',
      },
    }).url).toBe('/posts/hello.world/');
    expect(resolveCategoryPublicRoute({
      settings: routing,
      category: { slug: 'News' },
    }).url).toBe('/categories/News/');
    expect(resolveTagPublicRoute({
      settings: routing,
      tag: { slug: 'release' },
    }).url).toBe('/tags/release/');
  });

  it('inserts root-to-leaf Page paths at the permalink slug position', () => {
    const routing = settings({ pages: '/docs/:slug/' });
    expect(resolvePagePublicRoute({
      settings: routing,
      page: { slug: 'about', path: 'about', parent: null },
    })).toEqual({
      path: '/docs/about/',
      url: '/docs/about/',
      referencePath: 'docs/about',
    });
    expect(resolvePagePublicRoute({
      settings: routing,
      page: {
        slug: 'install',
        path: 'guides/install',
        parent: { id: '1'.repeat(32), title: 'Guides', slug: 'guides' },
      },
    })).toEqual({
      path: '/docs/guides/install/',
      url: '/docs/guides/install/',
      referencePath: 'docs/guides/install',
    });
  });

  it('links the configured Front Page Page to the emitted root route', () => {
    const routing = {
      ...settings({ pages: '/docs/:slug/' }),
      front_page: { type: 'page' as const, page_id: '1'.repeat(32) },
      post_index: { enabled: true, path: '/blog/', paginate: true },
    };
    expect(resolvePageNavigationUrl({
      settings: routing,
      page: {
        id: '1'.repeat(32),
        slug: 'home',
        path: 'home',
        parent: null,
      },
    })).toBe('/');
  });

  it('matches html-extension and index Page URL semantics', () => {
    const routing = settings({ output_style: 'html-extension' });
    expect(resolvePostPublicRoute({
      settings: routing,
      timezone: 'UTC',
      post: {
        slug: 'release',
        public_id: 7,
        published_at_iso: null,
        created_at_iso: '2026-08-01T00:00:00Z',
      },
    }).url).toBe('/posts/release');
    expect(pagePathToPublicUrl('/index/', 'html-extension')).toBe('/');
    expect(pagePathToPublicUrl('/docs/index/', 'html-extension'))
      .toBe('/docs/');
  });

  it('uses site timezone for post date tokens including fixed offsets', () => {
    const routing = settings({
      posts: '/posts/:year/:month/:day/:public_id/:slug/',
    });
    const post = {
      slug: 'new-year',
      public_id: 13261,
      published_at_iso: '2025-12-31T15:30:00Z',
      created_at_iso: '2025-12-31T15:30:00Z',
    };
    expect(resolvePostPublicRoute({
      settings: routing,
      timezone: '+09:00',
      post,
    }).url).toBe('/posts/2026/01/01/13261/new-year/');
    expect(resolvePostPublicRoute({
      settings: routing,
      timezone: 'America/Los_Angeles',
      post: { ...post, published_at_iso: '2026-01-01T07:30:00Z' },
    }).url).toBe('/posts/2025/12/31/13261/new-year/');
  });

});

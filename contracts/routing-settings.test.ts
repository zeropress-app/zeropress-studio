import { describe, expect, it } from 'vitest';
import {
  materializeRoutingSettingsDefaults,
  routingSettingsInputSchema,
  routingSettingsSchema,
  updateRoutingSettingsRequestSchema,
} from './routing-settings';

describe('routing settings contract', () => {
  it('materializes the Build Core defaults as a complete document', () => {
    expect(routingSettingsSchema.parse(
      materializeRoutingSettingsDefaults(),
    )).toEqual({
      permalinks: {
        output_style: 'directory',
        posts: '/posts/:slug/',
        pages: '/:slug/',
        categories: '/categories/:slug/',
        tags: '/tags/:slug/',
      },
      front_page: { type: 'theme_index' },
      post_index: { enabled: true, path: '/', paginate: true },
    });
  });

  it('canonicalizes authored route boundaries without changing case', () => {
    const parsed = routingSettingsInputSchema.parse({
      permalinks: {
        output_style: 'html-extension',
        posts: ' /BLOG.HTML/:year/:slug ',
        pages: '/page/:slug',
        categories: '/categories/:slug/',
        tags: '/tags/:slug',
      },
      front_page: { type: 'theme_index' },
      post_index: { enabled: true, path: '/news', paginate: false },
    });
    expect(parsed.permalinks.posts).toBe('/BLOG.HTML/:year/:slug/');
    expect(parsed.permalinks.pages).toBe('/page/:slug/');
    expect(parsed.post_index.path).toBe('/news/');
  });

  it('rejects unsafe patterns, invalid tokens, and lowercase literal html', () => {
    const defaults = materializeRoutingSettingsDefaults();
    for (const posts of [
      '/posts/:unknown/',
      '/posts/prefix-:slug/',
      '/posts/archive.html/',
      '/posts//:slug/',
      '/posts/%2e/:slug/',
      '/posts/:year/',
    ]) {
      expect(routingSettingsInputSchema.safeParse({
        ...defaults,
        permalinks: { ...defaults.permalinks, posts },
      }).success).toBe(false);
    }
    expect(routingSettingsInputSchema.safeParse({
      ...defaults,
      post_index: { ...defaults.post_index, path: '/post/:slug/' },
    }).success).toBe(false);
  });

  it('rejects a selected Front Page that collides with the root Post index', () => {
    const defaults = materializeRoutingSettingsDefaults();
    const request = updateRoutingSettingsRequestSchema.safeParse({
      settings: {
        ...defaults,
        front_page: { type: 'page', page_id: '1'.repeat(32) },
      },
      expected_revision: '0'.repeat(32),
    });
    expect(request.success).toBe(false);

    expect(routingSettingsSchema.safeParse({
      ...defaults,
      front_page: { type: 'page', page_id: '1'.repeat(32) },
      post_index: { enabled: false, path: '/', paginate: true },
    }).success).toBe(true);

    expect(routingSettingsSchema.safeParse({
      ...defaults,
      front_page: {
        type: 'standalone_html',
        html: '<!doctype html><title>Home</title>',
      },
    }).success).toBe(false);
  });

  it('preserves a nonblank standalone Front Page document verbatim', () => {
    const defaults = materializeRoutingSettingsDefaults();
    const html = '  <!doctype html>\n<title>Standalone</title>\n';
    const parsed = routingSettingsInputSchema.parse({
      ...defaults,
      front_page: { type: 'standalone_html', html },
      post_index: { ...defaults.post_index, path: '/blog/' },
    });
    expect(parsed.front_page).toEqual({ type: 'standalone_html', html });
    expect(routingSettingsInputSchema.safeParse({
      ...defaults,
      front_page: { type: 'standalone_html', html: ' \n\t ' },
      post_index: { ...defaults.post_index, path: '/blog/' },
    }).success).toBe(false);
    expect(routingSettingsInputSchema.safeParse({
      ...defaults,
      front_page: {
        type: 'standalone_html',
        html,
        legacy: true,
      },
      post_index: { ...defaults.post_index, path: '/blog/' },
    }).success).toBe(false);
  });

  it('requires complete closed Studio control-plane objects', () => {
    const defaults = materializeRoutingSettingsDefaults();
    expect(routingSettingsInputSchema.safeParse({
      ...defaults,
      unexpected: true,
    }).success).toBe(false);
    expect(routingSettingsInputSchema.safeParse({
      permalinks: defaults.permalinks,
      front_page: defaults.front_page,
    }).success).toBe(false);
    expect(routingSettingsInputSchema.safeParse({
      ...defaults,
      front_page: { type: 'theme_index', html: '<h1>Unexpected</h1>' },
    }).success).toBe(false);
  });
});

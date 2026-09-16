import { describe, expect, it, vi } from 'vitest';
import { validatePreviewData } from '@zeropress/preview-data-validator';
import { materializeRoutingSettingsDefaults } from '../../../contracts/routing-settings';
import { StudioOperationalError } from '../lib/operational-error';
import {
  buildPreviewDataV07,
  generatePreviewDataExport,
  PREVIEW_DATA_GENERATOR,
  PREVIEW_DATA_SCHEMA_URL,
} from './projection';

const GENERATED_AT = new Date('2026-08-01T06:00:00.456Z');

function defaultRoutingDocument() {
  return {
    settings: materializeRoutingSettingsDefaults(),
    revision: '0'.repeat(32),
    updated_at_iso: null,
  };
}

function defaultSettingsSnapshot() {
  return {
    general: {
      settings: {
        title: 'ZeroPress',
        description: '',
        url: '',
        locale: 'en-US',
        timezone: 'UTC',
      },
      revision: '0'.repeat(32),
      updated_at_iso: null,
    },
    output: {
      settings: {
        expose_generator: true,
        search: { enabled: true },
        feed: { enabled: true },
        archive: { enabled: true },
        posts_per_page: 10,
        date_style: 'medium' as const,
        time_style: 'none' as const,
        footer: { attribution: true },
        robots: { allow_indexing: false },
      },
      revision: '0'.repeat(32),
      updated_at_iso: null,
    },
    routing: defaultRoutingDocument(),
  };
}

function emptySettingsDb() {
  const all = vi.fn().mockResolvedValue({
    success: true,
    results: [],
    meta: {},
  });
  const bind = vi.fn().mockReturnValue({ all });
  const first = vi.fn().mockResolvedValue(null);
  const prepare = vi.fn().mockReturnValue({ bind, all, first });
  const batch = vi.fn().mockImplementation(async (
    statements: unknown[],
  ) => statements.map(() => ({ success: true, results: [], meta: {} })));
  return {
    db: { prepare, batch } as unknown as D1Database,
    prepare,
    bind,
    all,
    first,
    batch,
  };
}

function emptyEdgeDb() {
  const first = vi.fn().mockResolvedValue(null);
  const prepare = vi.fn().mockReturnValue({ first });
  return {
    edgeDb: { prepare } as unknown as D1Database,
    prepare,
    first,
  };
}

describe('Preview Data v0.7 projection', () => {
  it('projects an enabled Newsletter CTA and omits disabled drafts', () => {
    const enabled = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        ...defaultSettingsSnapshot(),
        newsletter: {
          settings: {
            enabled: true,
            title: 'Product notes',
            description: '',
            button_label: 'Subscribe',
            signup_url: 'https://example.com/signup?source=site',
            embed_url: '',
          },
          revision: '1'.repeat(32),
          updated_at_iso: '2026-08-01T00:00:00.000Z',
        },
      },
    });
    expect(enabled.site.newsletter).toEqual({
      enabled: true,
      title: 'Product notes',
      button_label: 'Subscribe',
      signup_url: 'https://example.com/signup?source=site',
    });
    expect(validatePreviewData(enabled).ok).toBe(true);

    const disabled = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        ...defaultSettingsSnapshot(),
        newsletter: {
          settings: {
            enabled: false,
            title: 'Preserved draft',
            description: 'Not published yet.',
            button_label: 'Join',
            signup_url: 'https://example.com/signup',
            embed_url: '',
          },
          revision: '2'.repeat(32),
          updated_at_iso: '2026-08-01T00:00:00.000Z',
        },
      },
    });
    expect(disabled.site).not.toHaveProperty('newsletter');
  });

  it('projects safe defaults from one settings snapshot query', async () => {
    const database = emptySettingsDb();
    const result = await generatePreviewDataExport({
      db: database.db,
      edgeDb: emptyEdgeDb().edgeDb,
      generatedAt: GENERATED_AT,
    });

    expect(database.prepare).toHaveBeenCalledTimes(13);
    expect(database.all).toHaveBeenCalledTimes(5);
    expect(database.batch).toHaveBeenCalledTimes(3);
    expect(result.validation).toEqual({
      status: 'valid',
      contract_version: '0.7',
      warnings: [],
    });
    expect(result.preview_data).toEqual({
      $schema: PREVIEW_DATA_SCHEMA_URL,
      version: '0.7',
      generator: PREVIEW_DATA_GENERATOR,
      generated_at: '2026-08-01T06:00:00Z',
      site: {
        title: 'ZeroPress',
        description: '',
        url: '',
        media_origin: '',
        locale: 'en-US',
        posts_per_page: 10,
        date_style: 'medium',
        time_style: 'none',
        timezone: 'UTC',
        robots: { allow_indexing: false },
      },
      content: {
        authors: [],
        posts: [],
        pages: [],
        categories: [],
        tags: [],
      },
    });
    expect(validatePreviewData(result.preview_data).ok).toBe(true);
    expect(String(database.prepare.mock.calls[0]?.[0])).not.toContain(
      'FROM authors',
    );
  });

  it('projects Footer overrides and standalone Front Page HTML canonically', () => {
    const html = '  <!doctype html>\n<html><title>Standalone</title></html>\n';
    const settings = defaultSettingsSnapshot();
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        ...settings,
        output: {
          ...settings.output,
          settings: {
            ...settings.output.settings,
            footer: {
              copyright_text: '© 2026 Example',
              attribution: false,
            },
          },
        },
        routing: {
          ...settings.routing,
          settings: {
            ...settings.routing.settings,
            front_page: { type: 'standalone_html', html },
            post_index: {
              ...settings.routing.settings.post_index,
              path: '/blog/',
            },
          },
        },
      },
    });

    expect(previewData.site.front_page).toEqual({
      type: 'standalone_html',
      html,
    });
    expect(previewData.site.footer).toEqual({
      copyright_text: '© 2026 Example',
      attribution: false,
    });
    expect(Object.keys(previewData.site)).toEqual([
      'title',
      'description',
      'url',
      'media_origin',
      'locale',
      'posts_per_page',
      'date_style',
      'time_style',
      'timezone',
      'robots',
      'front_page',
      'post_index',
      'footer',
    ]);
    expect(validatePreviewData(previewData).ok).toBe(true);

    const defaultAttribution = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        ...settings,
        output: {
          ...settings.output,
          settings: {
            ...settings.output.settings,
            footer: {
              copyright_text: '© 2026 Example',
              attribution: true,
            },
          },
        },
      },
    });
    expect(defaultAttribution.site.footer).toEqual({
      copyright_text: '© 2026 Example',
    });
    expect(validatePreviewData(defaultAttribution).ok).toBe(true);
  });

  it('projects authored favicon and logo Media without internal identities', () => {
    const iconId = '1'.repeat(32);
    const darkIconId = '2'.repeat(32);
    const logoId = '3'.repeat(32);
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: defaultSettingsSnapshot(),
      branding: {
        settings: {
          favicon: {
            icon_media_id: iconId,
            icon_dark_media_id: darkIconId,
            apple_touch_icon_media_id: null,
          },
          logo: { media_id: logoId, alt: 'ZeroPress mark' },
        },
        selected_assets: {
          icon: {
            id: iconId,
            filename: 'favicon.png',
            mime_type: 'image/png',
            location: {
              type: 'external',
              url: 'https://assets.example/favicon.png',
            },
            format: 'png',
            preview_url: 'https://assets.example/favicon.png',
          },
          icon_dark: {
            id: darkIconId,
            filename: 'favicon-dark.svg',
            mime_type: 'image/svg+xml',
            location: { type: 'r2', key: 'uploads/2026/08/favicon-dark.svg' },
            format: 'svg',
            preview_url: 'https://media.example/uploads/2026/08/favicon-dark.svg',
          },
          apple_touch_icon: null,
          logo: {
            id: logoId,
            filename: 'logo.webp',
            mime_type: 'image/webp',
            location: {
              type: 'external',
              url: 'https://assets.example/logo.webp',
            },
            format: 'other_image',
            preview_url: 'https://assets.example/logo.webp',
          },
        },
        revision: '4'.repeat(32),
        updated_at_iso: '2026-08-03T12:00:00.000Z',
      },
    });

    expect(previewData.site.favicon).toEqual({
      icon_dark: '/uploads/2026/08/favicon-dark.svg',
      png: 'https://assets.example/favicon.png',
    });
    expect(previewData.site.logo).toEqual({
      src: 'https://assets.example/logo.webp',
      alt: 'ZeroPress mark',
    });
    expect(JSON.stringify(previewData)).not.toContain(iconId);
    expect(JSON.stringify(previewData)).not.toContain(logoId);
    expect(validatePreviewData(previewData).ok).toBe(true);
  });

  it('projects only enabled non-blank Custom Code without changing raw source', () => {
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: defaultSettingsSnapshot(),
      customCode: {
        settings: {
          custom_css: {
            enabled: true,
            content: '  :root { --brand: #2463eb; }\n',
          },
          custom_html: {
            head_end: { enabled: true, content: '   \n' },
            body_end: {
              enabled: true,
              content: '  <script>window.ready = true;</script>\n',
            },
          },
        },
        revision: '9'.repeat(32),
        updated_at_iso: GENERATED_AT.toISOString(),
      },
    });

    expect(previewData.custom_css).toEqual({
      content: '  :root { --brand: #2463eb; }\n',
    });
    expect(previewData.custom_html).toEqual({
      body_end: '  <script>window.ready = true;</script>\n',
    });
    expect(previewData.custom_html).not.toHaveProperty('head_end');
    expect(Object.keys(previewData).at(-2)).toBe('custom_css');
    expect(Object.keys(previewData).at(-1)).toBe('custom_html');
    expect(validatePreviewData(previewData).ok).toBe(true);
  });

  it('includes deterministic theme-facing Widget areas without internal state', () => {
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        general: {
          settings: {
            title: 'ZeroPress',
            description: '',
            url: '',
            locale: 'en-US',
            timezone: 'UTC',
          },
          revision: '0'.repeat(32),
          updated_at_iso: null,
        },
        output: {
          settings: {
            expose_generator: true,
            search: { enabled: true },
            feed: { enabled: true },
            archive: { enabled: true },
            posts_per_page: 10,
            date_style: 'medium',
            time_style: 'none',
            footer: { attribution: true },
            robots: { allow_indexing: false },
          },
          revision: '0'.repeat(32),
          updated_at_iso: null,
        },
        routing: defaultRoutingDocument(),
      },
      widgets: {
        sidebar: {
          name: 'Sidebar Widgets',
          items: [{
            type: 'search',
            title: '',
            settings: {
              placeholder: 'Search...',
              button_label: 'Search',
            },
          }],
        },
        footer: { name: 'Footer Widgets', items: [] },
      },
    });
    expect(previewData.widgets).toEqual({
      footer: { name: 'Footer Widgets', items: [] },
      sidebar: {
        name: 'Sidebar Widgets',
        items: [{
          type: 'search',
          title: '',
          settings: {
            button_label: 'Search',
            placeholder: 'Search...',
          },
        }],
      },
    });
    expect(validatePreviewData(previewData).ok).toBe(true);
  });

  it('projects Media settings, deterministic metadata, and Post/Page featured images', () => {
    const alpha = {
      id: '1'.repeat(32),
      kind: 'image' as const,
      filename: 'alpha.jpg',
      mime_type: 'image/jpeg',
      location: { type: 'r2' as const, key: 'uploads/alpha.jpg' },
      width: 1200,
      height: 630,
      alt: '',
    };
    const hero = {
      id: '2'.repeat(32),
      kind: 'image' as const,
      filename: 'hero.jpg',
      mime_type: 'image/jpeg',
      location: { type: 'r2' as const, key: 'uploads/hero.jpg' },
      width: 1600,
      height: 900,
      alt: 'Hero',
    };
    const settings = defaultSettingsSnapshot();
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        ...settings,
        media: {
          settings: {
            media_origin: 'https://media.example',
            media_delivery_mode: 'media_domain',
          },
          revision: '9'.repeat(32),
          updated_at_iso: GENERATED_AT.toISOString(),
        },
      },
      posts: [{
        id: '3'.repeat(32),
        public_id: 100_000_000_001,
        title: 'Featured Post',
        slug: 'featured-post',
        content: '# Featured Post\n\n[PDF](/__zeropress_media__/imported/manual.pdf)',
        document_type: 'markdown',
        excerpt: '',
        status: 'published',
        author: { id: 'Owner', display_name: 'Owner' },
        categories: [],
        tags: [],
        discoverability: 'default',
        allow_comments: false,
        featured_image: hero,
        published_at_iso: '2026-08-01T00:00:00.000Z',
        revision: '4'.repeat(32),
        created_at_iso: '2026-08-01T00:00:00.000Z',
        updated_at_iso: '2026-08-01T00:00:00.000Z',
      }],
      pages: [{
        id: '5'.repeat(32),
        public_id: 100_000_000_002,
        parent: null,
        title: 'Featured Page',
        slug: 'featured-page',
        path: 'featured-page',
        content: '# Featured Page',
        document_type: 'markdown',
        excerpt: '',
        status: 'published',
        discoverability: 'default',
        allow_comments: false,
        featured_image: alpha,
        revision: '6'.repeat(32),
        created_at_iso: '2026-08-01T00:00:00.000Z',
        updated_at_iso: '2026-08-01T00:00:00.000Z',
      }],
    });

    expect(previewData.site).toMatchObject({
      media_origin: 'https://media.example',
      media_delivery_mode: 'media_domain',
    });
    expect(previewData.content.media).toEqual([{
      src: '/uploads/alpha.jpg',
      width: 1200,
      height: 630,
    }, {
      src: '/uploads/hero.jpg',
      width: 1600,
      height: 900,
      alt: 'Hero',
    }]);
    expect(previewData.content.posts[0]?.featured_image)
      .toBe('/uploads/hero.jpg');
    expect(previewData.content.posts[0]?.excerpt).toBe('');
    expect(previewData.content.posts[0]?.content)
      .toContain('https://media.example/imported/manual.pdf');
    expect(JSON.stringify(previewData)).not.toContain('/__zeropress_media__/');
    expect(previewData.content.pages[0]?.featured_image)
      .toBe('/uploads/alpha.jpg');
    expect(previewData.content.pages[0]?.excerpt).toBe('');
    expect(validatePreviewData(previewData).ok).toBe(true);
  });

  it('projects managed body and structured Media root-relative when media_origin is empty', () => {
    const managedImage = {
      id: '2'.repeat(32),
      kind: 'image' as const,
      filename: 'managed.png',
      mime_type: 'image/png',
      location: {
        type: 'r2' as const,
        key: 'uploads/2026/08/managed.png',
      },
      width: 1600,
      height: 900,
      alt: 'Managed image',
    };
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: defaultSettingsSnapshot(),
      posts: [{
        id: '3'.repeat(32),
        public_id: 100_000_000_001,
        title: 'Managed asset',
        slug: 'managed-asset',
        content: '<a href="/__zeropress_media__/uploads/2026/08/manual.pdf">PDF</a>',
        document_type: 'html',
        excerpt: '',
        status: 'published',
        author: { id: 'Owner', display_name: 'Owner' },
        categories: [],
        tags: [],
        discoverability: 'default',
        allow_comments: false,
        featured_image: managedImage,
        published_at_iso: '2026-08-01T00:00:00.000Z',
        revision: '4'.repeat(32),
        created_at_iso: '2026-08-01T00:00:00.000Z',
        updated_at_iso: '2026-08-01T00:00:00.000Z',
      }],
    });

    expect(previewData.site.media_origin).toBe('');
    expect(previewData.content.posts[0]?.content)
      .toContain('href="/uploads/2026/08/manual.pdf"');
    expect(previewData.content.posts[0]?.featured_image)
      .toBe('/uploads/2026/08/managed.png');
    expect(previewData.content.media).toEqual([{
      src: '/uploads/2026/08/managed.png',
      width: 1600,
      height: 900,
      alt: 'Managed image',
    }]);
    expect(JSON.stringify(previewData)).not.toContain('/__zeropress_media__/');
    expect(validatePreviewData(previewData).ok).toBe(true);
  });

  it('deduplicates referenced Media after resolving root-relative sources', () => {
    const externalImage = {
      id: '1'.repeat(32),
      kind: 'image' as const,
      filename: 'external-shared.jpg',
      mime_type: 'image/jpeg',
      location: {
        type: 'external' as const,
        url: 'https://media.example/uploads/shared.jpg',
      },
      width: 1200,
      height: 630,
      alt: 'External',
    };
    const managedImage = {
      id: '2'.repeat(32),
      kind: 'image' as const,
      filename: 'managed-shared.jpg',
      mime_type: 'image/jpeg',
      location: { type: 'r2' as const, key: 'uploads/shared.jpg' },
      width: 1600,
      height: 900,
      alt: 'Managed',
    };
    const settings = defaultSettingsSnapshot();
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        ...settings,
        media: {
          settings: {
            media_origin: 'https://media.example',
            media_delivery_mode: 'media_domain',
          },
          revision: '3'.repeat(32),
          updated_at_iso: GENERATED_AT.toISOString(),
        },
      },
      posts: [{
        id: '4'.repeat(32),
        public_id: 100_000_000_001,
        title: 'External feature',
        slug: 'external-feature',
        content: '',
        document_type: 'markdown',
        excerpt: '',
        status: 'published',
        author: { id: 'Owner', display_name: 'Owner' },
        categories: [],
        tags: [],
        discoverability: 'default',
        allow_comments: false,
        featured_image: externalImage,
        published_at_iso: '2026-08-01T00:00:00.000Z',
        revision: '5'.repeat(32),
        created_at_iso: '2026-08-01T00:00:00.000Z',
        updated_at_iso: '2026-08-01T00:00:00.000Z',
      }],
      pages: [{
        id: '6'.repeat(32),
        public_id: 100_000_000_001,
        parent: null,
        title: 'Managed feature',
        slug: 'managed-feature',
        path: 'managed-feature',
        content: '',
        document_type: 'markdown',
        excerpt: '',
        status: 'published',
        discoverability: 'default',
        allow_comments: false,
        featured_image: managedImage,
        revision: '7'.repeat(32),
        created_at_iso: '2026-08-01T00:00:00.000Z',
        updated_at_iso: '2026-08-01T00:00:00.000Z',
      }],
    });

    expect(previewData.content.media).toEqual([{
      src: '/uploads/shared.jpg',
      width: 1600,
      height: 900,
      alt: 'Managed',
    }]);
    expect(validatePreviewData(previewData).ok).toBe(true);
  });

  it('projects effective ZeroPress settings and target-bound Post/Page tokens', () => {
    const postPublicId = 100_000_000_001;
    const pagePublicId = 100_000_000_002;
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: defaultSettingsSnapshot(),
      commentSettings: {
        enabled: true,
        provider: 'zeropress',
        api_base_url: 'https://edge.example.com/api',
        per_page: 50,
        order: 'desc',
        threading: { enabled: true, max_depth: 2 },
        moderation: { require_approval: true },
        auth: {
          enabled: true,
          provider: 'supabase',
          project_url: 'https://project.supabase.co',
          publishable_key:
            'sb_publishable_example-key-with-enough-length',
        },
      },
      commentTokens: new Map([
        [`post:${postPublicId}`, 'post-request-token'],
        [`page:${pagePublicId}`, 'page-request-token'],
      ]),
      posts: [{
        id: 'a'.repeat(32),
        public_id: postPublicId,
        title: 'Comments Post',
        slug: 'comments-post',
        content: '# Comments Post',
        document_type: 'markdown',
        excerpt: 'Comments Post.',
        status: 'published',
        author: { id: 'Site-Owner', display_name: 'Site Owner' },
        categories: [],
        tags: [],
        discoverability: 'default',
        allow_comments: true,
        featured_image: null,
        published_at_iso: '2026-08-01T00:00:00.000Z',
        revision: 'b'.repeat(32),
        created_at_iso: '2026-08-01T00:00:00.000Z',
        updated_at_iso: '2026-08-01T00:00:00.000Z',
      }],
      pages: [{
        id: 'c'.repeat(32),
        public_id: pagePublicId,
        parent: null,
        title: 'Comments Page',
        slug: 'comments-page',
        path: 'comments-page',
        content: '# Comments Page',
        document_type: 'markdown',
        excerpt: '',
        status: 'published',
        discoverability: 'default',
        allow_comments: true,
        featured_image: null,
        revision: 'd'.repeat(32),
        created_at_iso: '2026-08-01T00:00:00.000Z',
        updated_at_iso: '2026-08-01T00:00:00.000Z',
      }],
    });
    expect(previewData.site.comments).toEqual({
      enabled: true,
      api_base_url: 'https://edge.example.com/api',
      provider: 'zeropress',
      per_page: 50,
      order: 'desc',
      threading: { enabled: true, max_depth: 2 },
    });
    expect(previewData.site.comments).not.toHaveProperty('auth');
    expect(previewData.content.posts[0]).toMatchObject({
      allow_comments: true,
      comments: { request_token: 'post-request-token' },
    });
    expect(previewData.content.pages[0]).toMatchObject({
      public_id: pagePublicId,
      allow_comments: true,
      comments: { request_token: 'page-request-token' },
    });
    expect(validatePreviewData(previewData).ok).toBe(true);
  });

  it('projects global tags in locale-independent name then slug order', () => {
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        general: {
          settings: {
            title: 'ZeroPress',
            description: '',
            url: '',
            locale: 'en-US',
            timezone: 'UTC',
          },
          revision: '0'.repeat(32),
          updated_at_iso: null,
        },
        output: {
          settings: {
            expose_generator: true,
            search: { enabled: true },
            feed: { enabled: true },
            archive: { enabled: true },
            posts_per_page: 10,
            date_style: 'medium',
            time_style: 'none',
            footer: { attribution: true },
            robots: { allow_indexing: false },
          },
          revision: '0'.repeat(32),
          updated_at_iso: null,
        },
        routing: defaultRoutingDocument(),
      },
      taxonomies: {
        categories: [{
          id: '1'.repeat(32),
          taxonomy: 'category',
          name: 'Alpha',
          slug: 'alpha',
          description: '',
          revision: '2'.repeat(32),
          created_at_iso: '2026-08-01T00:00:00.000Z',
          updated_at_iso: '2026-08-01T00:00:00.000Z',
        }],
        tags: [
          {
            id: '3'.repeat(32),
            taxonomy: 'tag',
            name: 'apple',
            slug: 'apple',
            description: '',
            revision: '4'.repeat(32),
            created_at_iso: '2026-08-01T00:00:00.000Z',
            updated_at_iso: '2026-08-01T00:00:00.000Z',
          },
          {
            id: '5'.repeat(32),
            taxonomy: 'tag',
            name: 'Alpha',
            slug: 'beta-slug',
            description: '',
            revision: '6'.repeat(32),
            created_at_iso: '2026-08-01T00:00:00.000Z',
            updated_at_iso: '2026-08-01T00:00:00.000Z',
          },
          {
            id: '7'.repeat(32),
            taxonomy: 'tag',
            name: 'Zulu',
            slug: 'zulu',
            description: '',
            revision: '8'.repeat(32),
            created_at_iso: '2026-08-01T00:00:00.000Z',
            updated_at_iso: '2026-08-01T00:00:00.000Z',
          },
          {
            id: '9'.repeat(32),
            taxonomy: 'tag',
            name: 'Alpha',
            slug: 'alpha-slug',
            description: 'First Alpha tag.',
            revision: 'a'.repeat(32),
            created_at_iso: '2026-08-01T00:00:00.000Z',
            updated_at_iso: '2026-08-01T00:00:00.000Z',
          },
        ],
      },
    });
    expect(previewData.content.categories).toEqual([{
      name: 'Alpha',
      slug: 'alpha',
    }]);
    expect(previewData.content.tags).toEqual([
      {
        name: 'Alpha',
        slug: 'alpha-slug',
        description: 'First Alpha tag.',
      },
      { name: 'Alpha', slug: 'beta-slug' },
      { name: 'Zulu', slug: 'zulu' },
      { name: 'apple', slug: 'apple' },
    ]);
    expect(validatePreviewData(previewData).ok).toBe(true);
  });

  it('projects only referenced Authors and preserves ordered Post tags', () => {
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        general: {
          settings: {
            title: 'ZeroPress',
            description: '',
            url: '',
            locale: 'en-US',
            timezone: 'UTC',
          },
          revision: '0'.repeat(32),
          updated_at_iso: null,
        },
        output: {
          settings: {
            expose_generator: true,
            search: { enabled: true },
            feed: { enabled: true },
            archive: { enabled: true },
            posts_per_page: 10,
            date_style: 'medium',
            time_style: 'none',
            footer: { attribution: true },
            robots: { allow_indexing: false },
          },
          revision: '0'.repeat(32),
          updated_at_iso: null,
        },
        routing: defaultRoutingDocument(),
      },
      posts: [{
        id: 'a'.repeat(32),
        public_id: 100_000_000_001,
        title: 'First Post',
        slug: 'first-post',
        content: '# First Post',
        document_type: 'markdown',
        excerpt: 'A first Post.',
        status: 'published',
        author: {
          id: 'Studio-Owner',
          display_name: 'Studio Owner',
        },
        categories: [{
          id: 'b'.repeat(32),
          name: 'News',
          slug: 'news',
        }],
        tags: [{
          id: 'c'.repeat(32),
          name: 'Second',
          slug: 'second',
        }, {
          id: 'd'.repeat(32),
          name: 'First',
          slug: 'first',
        }],
        discoverability: 'default',
        allow_comments: true,
        featured_image: null,
        published_at_iso: '2026-08-01T03:00:00.000Z',
        revision: 'e'.repeat(32),
        created_at_iso: '2026-08-01T02:00:00.000Z',
        updated_at_iso: '2026-08-01T04:00:00.000Z',
      }],
      authors: [{
        id: 'Studio-Owner',
        displayName: 'Studio Owner',
        avatarLocation: {
          type: 'r2',
          key: 'uploads/2026/08/studio-owner.png',
        },
        avatarMedia: {
          id: 'f'.repeat(32),
          kind: 'image',
          filename: 'studio-owner.png',
          mime_type: 'image/png',
          location: {
            type: 'r2',
            key: 'uploads/2026/08/studio-owner.png',
          },
          width: 256,
          height: 256,
          alt: '',
        },
      }],
    });
    expect(previewData.content.authors).toEqual([{
      id: 'Studio-Owner',
      display_name: 'Studio Owner',
      avatar: '/uploads/2026/08/studio-owner.png',
    }]);
    expect(previewData.content.posts).toEqual([{
      public_id: 100_000_000_001,
      title: 'First Post',
      slug: 'first-post',
      content: '# First Post',
      document_type: 'markdown',
      excerpt: 'A first Post.',
      published_at_iso: '2026-08-01T03:00:00.000Z',
      updated_at_iso: '2026-08-01T04:00:00.000Z',
      author_id: 'Studio-Owner',
      status: 'published',
      allow_comments: true,
      category_slugs: ['news'],
      tag_slugs: ['second', 'first'],
    }]);
    expect(previewData.content.media).toEqual([{
      src: '/uploads/2026/08/studio-owner.png',
      width: 256,
      height: 256,
    }]);
    expect(validatePreviewData(previewData).ok).toBe(true);
  });

  it('projects root and nested Pages with canonical optional fields', () => {
    const common = {
      content: '# Page',
      document_type: 'markdown' as const,
      status: 'published' as const,
      featured_image: null,
      revision: 'e'.repeat(32),
      created_at_iso: '2026-08-01T02:00:00.000Z',
      updated_at_iso: '2026-08-01T04:00:00.000Z',
    };
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        general: {
          settings: {
            title: 'ZeroPress',
            description: '',
            url: '',
            locale: 'en-US',
            timezone: 'UTC',
          },
          revision: '0'.repeat(32),
          updated_at_iso: null,
        },
        output: {
          settings: {
            expose_generator: true,
            search: { enabled: true },
            feed: { enabled: true },
            archive: { enabled: true },
            posts_per_page: 10,
            date_style: 'medium',
            time_style: 'none',
            footer: { attribution: true },
            robots: { allow_indexing: false },
          },
          revision: '0'.repeat(32),
          updated_at_iso: null,
        },
        routing: {
          ...defaultRoutingDocument(),
          settings: {
            ...materializeRoutingSettingsDefaults(),
            permalinks: {
              ...materializeRoutingSettingsDefaults().permalinks,
              pages: '/knowledge/:slug/',
            },
          },
        },
      },
      posts: [{
        id: 'f'.repeat(32),
        public_id: 100_000_000_001,
        title: 'Post with the same numeric ID',
        slug: 'same-numeric-id',
        content: '# Post',
        document_type: 'markdown',
        excerpt: '',
        status: 'draft',
        author: { id: 'Owner', display_name: 'Owner' },
        categories: [],
        tags: [],
        discoverability: 'default',
        allow_comments: false,
        featured_image: null,
        published_at_iso: null,
        revision: 'a'.repeat(32),
        created_at_iso: '2026-08-01T02:00:00.000Z',
        updated_at_iso: '2026-08-01T04:00:00.000Z',
      }],
      pages: [{
        ...common,
        id: '7'.repeat(32),
        public_id: 100_000_000_003,
        parent: null,
        title: 'Unpublished',
        slug: 'unpublished',
        path: 'unpublished',
        excerpt: '',
        discoverability: 'default',
        allow_comments: false,
        status: 'draft',
      }, {
        ...common,
        id: '1'.repeat(32),
        public_id: 100_000_000_001,
        parent: null,
        title: 'Docs',
        slug: 'docs',
        path: 'docs',
        excerpt: '',
        discoverability: 'default',
        allow_comments: false,
      }, {
        ...common,
        id: '2'.repeat(32),
        public_id: 100_000_000_002,
        parent: {
          id: '1'.repeat(32),
          title: 'Docs',
          slug: 'docs',
        },
        title: 'Guide',
        slug: 'guide',
        path: 'docs/guide',
        excerpt: 'Start here.',
        discoverability: 'noindex',
        allow_comments: true,
      }],
      menus: [{
        menu_id: 'primary',
        name: 'Primary Menu',
        enabled: true,
        items: [{
          id: '3'.repeat(32),
          title: 'Guide',
          link: { kind: 'page', reference_id: '2'.repeat(32) },
          target: '_self',
          children: [],
        }],
        revision: '4'.repeat(32),
        created_at_iso: '2026-08-01T02:00:00.000Z',
        updated_at_iso: '2026-08-01T04:00:00.000Z',
      }],
    });

    expect(previewData.content.posts).toEqual([]);
    expect(previewData.content.authors).toEqual([]);
    expect(previewData.content.pages).toEqual([{
      public_id: 100_000_000_001,
      title: 'Docs',
      slug: 'docs',
      content: '# Page',
      document_type: 'markdown',
      excerpt: '',
      updated_at_iso: '2026-08-01T04:00:00.000Z',
      status: 'published',
    }, {
      public_id: 100_000_000_002,
      title: 'Guide',
      slug: 'guide',
      path: 'knowledge/docs/guide',
      content: '# Page',
      document_type: 'markdown',
      excerpt: 'Start here.',
      updated_at_iso: '2026-08-01T04:00:00.000Z',
      status: 'published',
      discoverability: 'noindex',
      allow_comments: true,
    }]);
    expect(previewData.menus).toEqual({
      primary: {
        name: 'Primary Menu',
        items: [{
          title: 'Guide',
          url: '/knowledge/docs/guide/',
          target: '_self',
          children: [],
        }],
      },
    });
    expect(previewData.site.permalinks).toEqual({
      pages: '/knowledge/:slug/',
    });
    expect(validatePreviewData(previewData).ok).toBe(true);
  });

  it('omits default optional policies and emits only non-default states', () => {
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        general: {
          settings: {
            title: 'Example Site',
            description: 'A publication.',
            url: 'https://example.com',
            locale: 'ko-KR',
            timezone: 'Asia/Seoul',
          },
          revision: '1'.repeat(32),
          updated_at_iso: '2026-08-01T05:00:00.000Z',
        },
        output: {
          settings: {
            expose_generator: false,
            search: { enabled: false },
            feed: { enabled: true },
            archive: { enabled: false },
            posts_per_page: 25,
            date_style: 'full',
            time_style: 'short',
            footer: { attribution: true },
            robots: { allow_indexing: true },
          },
          revision: '2'.repeat(32),
          updated_at_iso: '2026-08-01T05:01:00.000Z',
        },
        routing: defaultRoutingDocument(),
      },
    });

    expect(previewData.site).toEqual({
      title: 'Example Site',
      description: 'A publication.',
      url: 'https://example.com',
      media_origin: '',
      expose_generator: false,
      search: { enabled: false },
      archive: { enabled: false },
      locale: 'ko-KR',
      posts_per_page: 25,
      date_style: 'full',
      time_style: 'short',
      timezone: 'Asia/Seoul',
    });
    expect(previewData.site).not.toHaveProperty('feed');
    expect(previewData.site).not.toHaveProperty('robots');
    expect(Object.keys(previewData)).toEqual([
      '$schema',
      'version',
      'generator',
      'generated_at',
      'site',
      'content',
    ]);
    expect(Object.keys(previewData.site)).toEqual([
      'title',
      'description',
      'url',
      'media_origin',
      'expose_generator',
      'search',
      'archive',
      'locale',
      'posts_per_page',
      'date_style',
      'time_style',
      'timezone',
    ]);
    expect(validatePreviewData(previewData).ok).toBe(true);
  });

  it('canonicalizes html-extension permalink overrides and omits default patterns', () => {
    const routing = materializeRoutingSettingsDefaults();
    routing.permalinks = {
      ...routing.permalinks,
      output_style: 'html-extension',
      posts: '/post/:public_id/',
      pages: '/:slug',
      categories: '/categories/:slug',
      tags: '/tags/:slug',
    };
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        ...defaultSettingsSnapshot(),
        routing: {
          settings: routing,
          revision: '1'.repeat(32),
          updated_at_iso: GENERATED_AT.toISOString(),
        },
      },
    });

    expect(previewData.site.permalinks).toEqual({
      output_style: 'html-extension',
      posts: '/post/:public_id',
    });
    expect(validatePreviewData(previewData).ok).toBe(true);
  });

  it('projects non-default routing and resolves Front Page and Menu URLs together', () => {
    const routing = materializeRoutingSettingsDefaults();
    const previewData = buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        general: {
          settings: {
            title: 'Example',
            description: '',
            url: '',
            locale: 'en-US',
            timezone: '+09:00',
          },
          revision: '0'.repeat(32),
          updated_at_iso: null,
        },
        output: {
          settings: {
            expose_generator: true,
            search: { enabled: true },
            feed: { enabled: true },
            archive: { enabled: true },
            posts_per_page: 10,
            date_style: 'medium',
            time_style: 'none',
            footer: { attribution: true },
            robots: { allow_indexing: false },
          },
          revision: '0'.repeat(32),
          updated_at_iso: null,
        },
        routing: {
          settings: {
            permalinks: {
              output_style: 'html-extension',
              posts: '/journal/:year/:public_id/',
              pages: '/docs/:slug/',
              categories: '/topics/:slug/',
              tags: '/labels/:slug/',
            },
            front_page: { type: 'page', page_id: '1'.repeat(32) },
            post_index: { enabled: true, path: '/journal/', paginate: true },
          },
          revision: '8'.repeat(32),
          updated_at_iso: GENERATED_AT.toISOString(),
        },
      },
      posts: [{
        id: '2'.repeat(32),
        public_id: 100_000_000_001,
        title: 'New Year',
        slug: 'new-year',
        content: '',
        document_type: 'markdown',
        excerpt: '',
        status: 'published',
        author: { id: 'Owner', display_name: 'Owner' },
        categories: [],
        tags: [],
        discoverability: 'default',
        allow_comments: false,
        featured_image: null,
        published_at_iso: '2025-12-31T15:30:00Z',
        revision: '3'.repeat(32),
        created_at_iso: '2025-12-31T15:30:00Z',
        updated_at_iso: '2026-01-01T00:30:00Z',
      }],
      pages: [{
        id: '1'.repeat(32),
        public_id: 100_000_000_001,
        parent: null,
        title: 'Home',
        slug: 'home',
        path: 'home',
        content: '',
        document_type: 'markdown',
        excerpt: '',
        status: 'published',
        discoverability: 'default',
        allow_comments: false,
        featured_image: null,
        revision: '4'.repeat(32),
        created_at_iso: '2026-01-01T00:00:00Z',
        updated_at_iso: '2026-01-01T00:00:00Z',
      }],
      taxonomies: {
        categories: [{
          id: '5'.repeat(32),
          taxonomy: 'category',
          name: 'News',
          slug: 'news',
          description: '',
          revision: '6'.repeat(32),
          created_at_iso: '2026-01-01T00:00:00Z',
          updated_at_iso: '2026-01-01T00:00:00Z',
        }],
        tags: [],
      },
      menus: [{
        menu_id: 'primary',
        name: 'Primary',
        enabled: true,
        items: [{
          id: '7'.repeat(32),
          title: 'Post',
          link: { kind: 'post', reference_id: '2'.repeat(32) },
          target: '_self',
          children: [],
        }, {
          id: '8'.repeat(32),
          title: 'Home Page',
          link: { kind: 'page', reference_id: '1'.repeat(32) },
          target: '_self',
          children: [],
        }, {
          id: '9'.repeat(32),
          title: 'News',
          link: { kind: 'category', reference_id: '5'.repeat(32) },
          target: '_self',
          children: [],
        }, {
          id: 'a'.repeat(32),
          title: 'Archive',
          link: { kind: 'custom', url: '/archive/' },
          target: '_self',
          children: [],
        }],
        revision: 'b'.repeat(32),
        created_at_iso: '2026-01-01T00:00:00Z',
        updated_at_iso: '2026-01-01T00:00:00Z',
      }],
    });
    expect(previewData.site.permalinks).toEqual({
      output_style: 'html-extension',
      posts: '/journal/:year/:public_id',
      pages: '/docs/:slug',
      categories: '/topics/:slug',
      tags: '/labels/:slug',
    });
    expect(previewData.site.front_page).toEqual({
      type: 'page',
      page_path: 'docs/home',
    });
    expect(previewData.site.post_index).toEqual({ path: '/journal/' });
    expect(previewData.menus?.primary?.items.map((item) => item.url)).toEqual([
      '/journal/2026/100000000001',
      '/',
      '/topics/news',
      '/archive/',
    ]);
    expect(validatePreviewData(previewData).ok).toBe(true);
    expect(routing.front_page.type).toBe('theme_index');
  });

  it('fails closed when the selected Front Page is no longer published', () => {
    const routing = materializeRoutingSettingsDefaults();
    expect(() => buildPreviewDataV07({
      generatedAt: GENERATED_AT,
      settings: {
        general: {
          settings: {
            title: 'Example', description: '', url: '', locale: 'en-US', timezone: 'UTC',
          },
          revision: '0'.repeat(32),
          updated_at_iso: null,
        },
        output: {
          settings: {
            expose_generator: true,
            search: { enabled: true },
            feed: { enabled: true },
            archive: { enabled: true },
            posts_per_page: 10,
            date_style: 'medium',
            time_style: 'none',
            footer: { attribution: true },
            robots: { allow_indexing: false },
          },
          revision: '0'.repeat(32),
          updated_at_iso: null,
        },
        routing: {
          settings: {
            ...routing,
            front_page: { type: 'page', page_id: 'f'.repeat(32) },
            post_index: { ...routing.post_index, path: '/blog/' },
          },
          revision: '1'.repeat(32),
          updated_at_iso: GENERATED_AT.toISOString(),
        },
      },
    })).toThrowError(expect.objectContaining({
      code: 'SITE_ROUTING_SETTINGS_DATA_INVALID',
    }));
  });

  it('reports a settings query outage without exposing settings', async () => {
    const cause = new Error('D1 unavailable');
    const db = {
      prepare: vi.fn().mockReturnValue({
        first: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue({
          success: true,
          results: [],
          meta: {},
        }),
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockRejectedValue(cause),
        }),
      }),
      batch: vi.fn().mockImplementation(async (
        statements: unknown[],
      ) => statements.map(() => ({ success: true, results: [], meta: {} }))),
    } as unknown as D1Database;

    await expect(generatePreviewDataExport({
      db,
      edgeDb: emptyEdgeDb().edgeDb,
      generatedAt: GENERATED_AT,
    })).rejects.toMatchObject({
      code: 'PREVIEW_DATA_SETTINGS_DATABASE_QUERY_FAILED',
      originalCause: cause,
      operationalMetadata: {
        resource: 'DB',
        action: 'read_preview_data_settings',
      },
    } satisfies Partial<StudioOperationalError>);
  });

  it('fails closed when the authoritative validator rejects the projection', async () => {
    const database = emptySettingsDb();
    await expect(generatePreviewDataExport({
      db: database.db,
      edgeDb: emptyEdgeDb().edgeDb,
      generatedAt: GENERATED_AT,
      validate: () => ({
        ok: false,
        errors: [{
          code: 'INVALID_TEST_PROJECTION',
          path: 'site',
          message: 'Rejected for test.',
          severity: 'error',
        }],
        warnings: [],
      }),
    })).rejects.toMatchObject({
      code: 'PREVIEW_DATA_PROJECTION_INVALID',
      operationalMetadata: {
        component: 'preview-data-validator',
        action: 'validate_preview_data_projection',
        contractVersion: '0.7',
        issueCount: 1,
        firstIssueCode: 'INVALID_TEST_PROJECTION',
        firstIssuePath: 'site',
      },
    } satisfies Partial<StudioOperationalError>);
  });
});

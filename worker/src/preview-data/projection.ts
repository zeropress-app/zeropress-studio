import {
  canonicalizePreviewDataKeyOrder,
  PREVIEW_DATA_VERSION,
  validatePreviewData,
  type PreviewDataV07,
  type PreviewDataValidationResult,
  type PreviewWidgetAreaData,
} from '@zeropress/preview-data-validator';
import type { PreviewDataExportDocument } from '../../../contracts/preview-data';
import type { CommentSettings } from '../../../contracts/comment-settings';
import type { Post } from '../../../contracts/posts';
import type { Page } from '../../../contracts/pages';
import {
  materializeManagedMediaReferences,
  previewMediaSource,
  type MediaReference,
} from '../../../contracts/media';
import { STUDIO_PREVIEW_DATA_GENERATOR } from '../../../contracts/studio-version';
import type { GeneralSettingsDocument } from '../settings/general-settings-repository';
import {
  GENERAL_SETTINGS_READ_KEYS,
  materializeGeneralSettingsDocument,
} from '../settings/general-settings-repository';
import type { OutputSettingsDocument } from '../settings/output-settings-repository';
import {
  materializeOutputSettingsDocument,
  OUTPUT_SETTINGS_READ_KEYS,
} from '../settings/output-settings-repository';
import {
  materializeRoutingSettingsDocument,
  ROUTING_SETTINGS_READ_KEYS,
} from '../settings/routing-settings-repository';
import {
  ROUTING_SETTINGS_DEFAULTS,
  type RoutingSettings,
  type RoutingSettingsDocument,
} from '../../../contracts/routing-settings';
import { readStoredSettings } from '../settings/revisioned-settings-repository';
import { StudioOperationalError } from '../lib/operational-error';
import {
  listPreviewTaxonomies,
  type PreviewTaxonomies,
} from '../taxonomies/taxonomy-repository';
import { listPreviewPosts } from '../posts/post-repository';
import { listPreviewPages } from '../pages/page-repository';
import {
  listPreviewMenus,
  resolvePreviewMenus,
} from '../menus/menu-repository';
import type { Menu } from '../../../contracts/menus';
import { listPreviewWidgets } from '../widgets/widget-repository';
import { resolvePagePublicRoute } from '../routing/public-url-resolver';
import { readCommentSettings } from '../settings/comment-settings-repository';
import {
  commentTargetKey,
  createCommentRequestTokens,
} from '../comments/request-token';
import type { MediaSettingsDocument } from '../settings/media-settings-repository';
import {
  materializeMediaSettingsDocument,
  MEDIA_SETTINGS_READ_KEYS,
} from '../settings/media-settings-repository';
import type { SiteBrandingDocument } from '../../../contracts/branding-settings';
import {
  projectSiteBranding,
  readSiteBranding,
} from '../settings/branding-settings-repository';
import type { CustomCodeSettingsDocument } from '../../../contracts/custom-code-settings';
import { readCustomCodeSettings } from '../settings/custom-code-settings-repository';
import type { NewsletterSettingsDocument } from '../../../contracts/newsletter-settings';
import {
  materializeNewsletterSettingsDocument,
  NEWSLETTER_SETTINGS_READ_KEYS,
} from '../settings/newsletter-settings-repository';
import {
  listPreviewAuthors,
  type PreviewAuthorRecord,
} from '../authors/author-repository';

export const PREVIEW_DATA_SCHEMA_URL =
  'https://schemas.zeropress.dev/preview-data/v0.7/schema.json';
export const PREVIEW_DATA_GENERATOR = STUDIO_PREVIEW_DATA_GENERATOR;

const PREVIEW_DATA_SETTINGS_READ_KEYS = [
  ...new Set([
    ...GENERAL_SETTINGS_READ_KEYS,
    ...OUTPUT_SETTINGS_READ_KEYS,
    ...ROUTING_SETTINGS_READ_KEYS,
    ...MEDIA_SETTINGS_READ_KEYS,
    ...NEWSLETTER_SETTINGS_READ_KEYS,
  ]),
] as const;

function compareLexically(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareTaxonomyTermsByNameThenSlug(
  left: PreviewTaxonomies['tags'][number],
  right: PreviewTaxonomies['tags'][number],
): number {
  return compareLexically(left.name, right.name)
    || compareLexically(left.slug, right.slug);
}

export type PreviewDataSettingsSnapshot = {
  general: GeneralSettingsDocument;
  output: OutputSettingsDocument;
  routing: RoutingSettingsDocument;
  media: MediaSettingsDocument;
  newsletter: NewsletterSettingsDocument;
};

type PreviewPostRecord = Omit<Post, 'editor_mode' | 'editor_profile'>;
type PreviewPageRecord = Omit<Page, 'editor_mode' | 'editor_profile'>;

function projectManagedMediaText(value: string, mediaOrigin: string): string {
  return materializeManagedMediaReferences(value, mediaOrigin);
}

function projectImageSource(media: MediaReference): string {
  return previewMediaSource(media.location);
}

function projectedMediaIdentity(source: string, mediaOrigin: string): string {
  return source.startsWith('/') && mediaOrigin
    ? `${mediaOrigin.replace(/\/+$/u, '')}${source}`
    : source;
}

function projectReferencedMedia(
  references: readonly MediaReference[],
  mediaOrigin: string,
): Array<{
  src: string;
  width: number;
  height: number;
  alt?: string;
}> {
  const candidates = references.map((reference) => {
    const src = projectImageSource(reference);
    return {
      reference,
      src,
      identity: projectedMediaIdentity(src, mediaOrigin),
    };
  }).sort((left, right) => (
    left.identity < right.identity ? -1 : left.identity > right.identity ? 1
      : left.src < right.src ? -1 : left.src > right.src ? 1
        : left.reference.id < right.reference.id ? -1
          : left.reference.id > right.reference.id ? 1 : 0
  ));
  const mediaByIdentity = new Map<string, {
    src: string;
    width: number;
    height: number;
    alt?: string;
  }>();
  for (const candidate of candidates) {
    if (mediaByIdentity.has(candidate.identity)) continue;
    mediaByIdentity.set(candidate.identity, {
      src: candidate.src,
      width: candidate.reference.width,
      height: candidate.reference.height,
      ...(candidate.reference.alt ? { alt: candidate.reference.alt } : {}),
    });
  }
  return [...mediaByIdentity.values()];
}

function formatIsoUtcSeconds(value: Date): string {
  const time = value.getTime();
  if (!Number.isFinite(time)) {
    throw new TypeError('Preview Data generation time must be valid.');
  }
  return value.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

export async function readPreviewDataSettings(input: {
  db: D1Database;
}): Promise<PreviewDataSettingsSnapshot> {
  try {
    const rows = await readStoredSettings({
      db: input.db,
      keys: PREVIEW_DATA_SETTINGS_READ_KEYS,
    });
    return {
      general: materializeGeneralSettingsDocument(rows),
      output: materializeOutputSettingsDocument(rows),
      routing: materializeRoutingSettingsDocument(rows),
      media: materializeMediaSettingsDocument(rows),
      newsletter: materializeNewsletterSettingsDocument(rows),
    };
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError(
      'PREVIEW_DATA_SETTINGS_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'read_preview_data_settings',
        },
      },
    );
  }
}

function projectPermalinks(settings: RoutingSettings) {
  const outputStyle = settings.permalinks.output_style;
  const canonicalizePattern = (value: string) => {
    const withoutTrailingSlash = value.replace(/\/+$/u, '');
    return outputStyle === 'directory'
      ? `${withoutTrailingSlash}/`
      : withoutTrailingSlash;
  };
  const posts = canonicalizePattern(settings.permalinks.posts);
  const pages = canonicalizePattern(settings.permalinks.pages);
  const categories = canonicalizePattern(settings.permalinks.categories);
  const tags = canonicalizePattern(settings.permalinks.tags);
  const projected = {
    ...(outputStyle
      === ROUTING_SETTINGS_DEFAULTS.permalinks.output_style
      ? {}
      : { output_style: outputStyle }),
    ...(posts === canonicalizePattern(ROUTING_SETTINGS_DEFAULTS.permalinks.posts)
      ? {}
      : { posts }),
    ...(pages === canonicalizePattern(ROUTING_SETTINGS_DEFAULTS.permalinks.pages)
      ? {}
      : { pages }),
    ...(categories
      === canonicalizePattern(ROUTING_SETTINGS_DEFAULTS.permalinks.categories)
      ? {}
      : { categories }),
    ...(tags === canonicalizePattern(ROUTING_SETTINGS_DEFAULTS.permalinks.tags)
      ? {}
      : { tags }),
  };
  return Object.keys(projected).length === 0 ? undefined : projected;
}

function projectPostIndex(settings: RoutingSettings) {
  const projected = {
    ...(settings.post_index.enabled
      === ROUTING_SETTINGS_DEFAULTS.post_index.enabled
      ? {}
      : { enabled: settings.post_index.enabled }),
    ...(settings.post_index.path === ROUTING_SETTINGS_DEFAULTS.post_index.path
      ? {}
      : { path: settings.post_index.path }),
    ...(settings.post_index.paginate
      === ROUTING_SETTINGS_DEFAULTS.post_index.paginate
      ? {}
      : { paginate: settings.post_index.paginate }),
  };
  return Object.keys(projected).length === 0 ? undefined : projected;
}

function projectFrontPage(input: {
  settings: RoutingSettings;
  pages: PreviewPageRecord[];
}) {
  const frontPage = input.settings.front_page;
  if (frontPage.type === 'theme_index') return undefined;
  if (frontPage.type === 'standalone_html') {
    return {
      type: 'standalone_html' as const,
      html: frontPage.html,
    };
  }
  const page = input.pages.find((candidate) => (
    candidate.id === frontPage.page_id
    && candidate.status === 'published'
  ));
  if (!page) {
    throw new StudioOperationalError('SITE_ROUTING_SETTINGS_DATA_INVALID', {
      metadata: {
        resource: 'DB',
        action: 'resolve_preview_front_page',
      },
    });
  }
  return {
    type: 'page' as const,
    page_path: resolvePagePublicRoute({
      settings: input.settings,
      page,
    }).referencePath,
  };
}

export function projectCustomCode(
  document: CustomCodeSettingsDocument,
): {
  custom_css?: { content: string };
  custom_html?: { head_end?: string; body_end?: string };
} {
  const settings = document.settings;
  const headEnd = settings.custom_html.head_end;
  const bodyEnd = settings.custom_html.body_end;
  const customHtml = {
    ...(headEnd.enabled && /\S/u.test(headEnd.content)
      ? { head_end: headEnd.content }
      : {}),
    ...(bodyEnd.enabled && /\S/u.test(bodyEnd.content)
      ? { body_end: bodyEnd.content }
      : {}),
  };
  return {
    ...(settings.custom_css.enabled && /\S/u.test(settings.custom_css.content)
      ? { custom_css: { content: settings.custom_css.content } }
      : {}),
    ...(Object.keys(customHtml).length > 0 ? { custom_html: customHtml } : {}),
  };
}

export function buildPreviewDataV07(input: {
  settings: Omit<PreviewDataSettingsSnapshot, 'media' | 'newsletter'> & {
    media?: MediaSettingsDocument;
    newsletter?: NewsletterSettingsDocument;
  };
  taxonomies?: PreviewTaxonomies;
  posts?: PreviewPostRecord[];
  authors?: PreviewAuthorRecord[];
  pages?: PreviewPageRecord[];
  menus?: Menu[];
  widgets?: Record<string, PreviewWidgetAreaData>;
  branding?: SiteBrandingDocument;
  customCode?: CustomCodeSettingsDocument;
  commentSettings?: CommentSettings;
  commentTokens?: ReadonlyMap<string, string>;
  generatedAt?: Date;
}): PreviewDataV07 {
  const general = input.settings.general.settings;
  const output = input.settings.output.settings;
  const routing = input.settings.routing.settings;
  const mediaSettings = input.settings.media?.settings ?? {
    media_origin: '',
    media_delivery_mode: 'none' as const,
  };
  const newsletterSettings = input.settings.newsletter?.settings;
  const projectedNewsletter = newsletterSettings?.enabled
    ? {
        enabled: true,
        ...(newsletterSettings.title
          ? { title: newsletterSettings.title }
          : {}),
        ...(newsletterSettings.description
          ? { description: newsletterSettings.description }
          : {}),
        ...(newsletterSettings.button_label
          ? { button_label: newsletterSettings.button_label }
          : {}),
        ...(newsletterSettings.signup_url
          ? { signup_url: newsletterSettings.signup_url }
          : {}),
        ...(newsletterSettings.embed_url
          ? { embed_url: newsletterSettings.embed_url }
          : {}),
      }
    : undefined;
  const branding = input.branding ? projectSiteBranding(input.branding) : {};
  const customCode = input.customCode ? projectCustomCode(input.customCode) : {};
  const taxonomies = input.taxonomies ?? { categories: [], tags: [] };
  const posts = (input.posts ?? []).filter(
    (post): post is Post & { status: 'published' } => post.status === 'published',
  );
  const pages = (input.pages ?? []).filter(
    (page): page is Page & { status: 'published' } => page.status === 'published',
  );
  const menus = resolvePreviewMenus({
    menus: input.menus ?? [],
    posts,
    pages,
    taxonomies,
    routing,
    timezone: general.timezone,
  });
  const widgets = input.widgets ?? {};
  const permalinks = projectPermalinks(routing);
  const frontPage = projectFrontPage({ settings: routing, pages });
  const postIndex = projectPostIndex(routing);
  const footer = {
    ...(output.footer.copyright_text
      ? { copyright_text: output.footer.copyright_text }
      : {}),
    ...(output.footer.attribution ? {} : { attribution: false }),
  };
  const commentSettings = input.commentSettings;
  const projectedComments = commentSettings?.api_base_url
    ? {
        enabled: commentSettings.enabled,
        api_base_url: commentSettings.api_base_url,
        provider: 'zeropress' as const,
        per_page: commentSettings.per_page,
        order: commentSettings.order,
        threading: { ...commentSettings.threading },
      }
    : undefined;
  const authorRecords = new Map(
    (input.authors ?? []).map((author) => [author.id, author]),
  );
  const referencedAuthors = new Map<string, {
    id: string;
    display_name: string;
    avatar?: string;
  }>();
  for (const post of posts) {
    const record = authorRecords.get(post.author.id);
    referencedAuthors.set(post.author.id, {
      id: post.author.id,
      display_name: record?.displayName ?? post.author.display_name,
      ...(record?.avatarLocation
        ? { avatar: previewMediaSource(record.avatarLocation) }
        : {}),
    });
  }
  const previewMedia = projectReferencedMedia([
    ...posts.flatMap((post) => (
      post.featured_image ? [post.featured_image] : []
    )),
    ...pages.flatMap((page) => (
      page.featured_image ? [page.featured_image] : []
    )),
    ...[...referencedAuthors.keys()].flatMap((authorId) => {
      const avatar = authorRecords.get(authorId)?.avatarMedia;
      return avatar ? [avatar] : [];
    }),
  ], mediaSettings.media_origin);
  const previewData: PreviewDataV07 = {
    $schema: PREVIEW_DATA_SCHEMA_URL,
    version: PREVIEW_DATA_VERSION,
    generator: PREVIEW_DATA_GENERATOR,
    generated_at: formatIsoUtcSeconds(input.generatedAt ?? new Date()),
    site: {
      title: general.title,
      description: general.description,
      url: general.url,
      media_origin: mediaSettings.media_origin,
      ...(mediaSettings.media_delivery_mode === 'none'
        ? {}
        : { media_delivery_mode: mediaSettings.media_delivery_mode }),
      ...branding,
      ...(output.expose_generator
        ? {}
        : { expose_generator: false }),
      ...(output.search.enabled
        ? {}
        : { search: { enabled: false } }),
      ...(output.feed.enabled
        ? {}
        : { feed: { enabled: false } }),
      ...(output.archive.enabled
        ? {}
        : { archive: { enabled: false } }),
      ...(projectedComments ? { comments: projectedComments } : {}),
      ...(projectedNewsletter ? { newsletter: projectedNewsletter } : {}),
      ...(permalinks ? { permalinks } : {}),
      ...(frontPage ? { front_page: frontPage } : {}),
      ...(postIndex ? { post_index: postIndex } : {}),
      ...(Object.keys(footer).length > 0 ? { footer } : {}),
      locale: general.locale,
      posts_per_page: output.posts_per_page,
      date_style: output.date_style,
      time_style: output.time_style,
      timezone: general.timezone,
      ...(output.robots.allow_indexing
        ? {}
        : { robots: { allow_indexing: false } }),
    },
    content: {
      authors: [...referencedAuthors.values()].sort((left, right) => (
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      )),
      posts: posts.map((post) => ({
        public_id: post.public_id,
        title: post.title,
        slug: post.slug,
        content: projectManagedMediaText(post.content, mediaSettings.media_origin),
        document_type: post.document_type,
        excerpt: projectManagedMediaText(
          post.excerpt,
          mediaSettings.media_origin,
        ),
        published_at_iso: post.published_at_iso ?? post.created_at_iso,
        updated_at_iso: post.updated_at_iso,
        author_id: post.author.id,
        status: post.status,
        ...(post.featured_image
          ? {
              featured_image: projectImageSource(post.featured_image),
            }
          : {}),
        ...(post.discoverability === 'default'
          ? {}
          : { discoverability: post.discoverability }),
        ...(post.allow_comments ? { allow_comments: true } : {}),
        ...(input.commentTokens?.get(commentTargetKey('post', post.public_id))
          ? {
              comments: {
                request_token: input.commentTokens.get(
                  commentTargetKey('post', post.public_id),
                )!,
              },
            }
          : {}),
        category_slugs: post.categories.map((category) => category.slug),
        tag_slugs: post.tags.map((tag) => tag.slug),
      })),
      pages: pages.map((page) => {
        const route = resolvePagePublicRoute({ settings: routing, page });
        return {
          public_id: page.public_id,
          title: page.title,
          slug: page.slug,
          ...(page.parent === null ? {} : { path: route.referencePath }),
          content: projectManagedMediaText(
            page.content,
            mediaSettings.media_origin,
          ),
          document_type: page.document_type,
          excerpt: projectManagedMediaText(
            page.excerpt,
            mediaSettings.media_origin,
          ),
          updated_at_iso: page.updated_at_iso,
          status: page.status,
          ...(page.featured_image
            ? {
                featured_image: projectImageSource(page.featured_image),
              }
            : {}),
          ...(page.discoverability === 'default'
            ? {}
            : { discoverability: page.discoverability }),
          ...(page.allow_comments ? { allow_comments: true } : {}),
          ...(input.commentTokens?.get(commentTargetKey('page', page.public_id))
            ? {
                comments: {
                  request_token: input.commentTokens.get(
                    commentTargetKey('page', page.public_id),
                  )!,
                },
              }
            : {}),
        };
      }),
      categories: taxonomies.categories.map((category) => ({
        name: category.name,
        slug: category.slug,
        ...(category.description
          ? { description: category.description }
          : {}),
      })),
      tags: [...taxonomies.tags]
        .sort(compareTaxonomyTermsByNameThenSlug)
        .map((tag) => ({
          name: tag.name,
          slug: tag.slug,
          ...(tag.description ? { description: tag.description } : {}),
        })),
      ...(previewMedia.length > 0
        ? {
            media: previewMedia,
          }
        : {}),
    },
    ...(Object.keys(menus).length > 0 ? { menus } : {}),
    ...(Object.keys(widgets).length > 0 ? { widgets } : {}),
    ...customCode,
  };
  return canonicalizePreviewDataKeyOrder(previewData);
}

function projectionInvalid(
  validation: PreviewDataValidationResult,
): StudioOperationalError {
  const firstIssue = validation.errors[0] ?? validation.warnings[0];
  return new StudioOperationalError('PREVIEW_DATA_PROJECTION_INVALID', {
    metadata: {
      component: 'preview-data-validator',
      action: 'validate_preview_data_projection',
      contractVersion: PREVIEW_DATA_VERSION,
      issueCount: validation.errors.length + validation.warnings.length,
      ...(firstIssue
        ? {
            firstIssueCode: firstIssue.code,
            firstIssuePath: firstIssue.path,
          }
        : {}),
    },
  });
}

export async function generatePreviewDataExport(input: {
  db: D1Database;
  edgeDb?: D1Database;
  generatedAt?: Date;
  validate?: (value: unknown) => PreviewDataValidationResult;
}): Promise<PreviewDataExportDocument> {
  const [settings, taxonomies, posts, authors, pages, menus, widgets, branding, customCode, commentDocument] = await Promise.all([
    readPreviewDataSettings({ db: input.db }),
    listPreviewTaxonomies({ db: input.db }),
    listPreviewPosts({ db: input.db }),
    listPreviewAuthors({ db: input.db }),
    listPreviewPages({ db: input.db }),
    listPreviewMenus({ db: input.db }),
    listPreviewWidgets({ db: input.db }),
    readSiteBranding({ db: input.db }),
    readCustomCodeSettings({ db: input.db }),
    input.edgeDb
      ? readCommentSettings({ edgeDb: input.edgeDb })
      : Promise.resolve(null),
  ]);
  const commentTargets = commentDocument?.settings.api_base_url
    && commentDocument.settings.enabled
    ? [
        ...posts.filter((post) => post.allow_comments).map((post) => ({
          targetType: 'post' as const,
          publicId: post.public_id,
        })),
        ...pages.filter((page) => page.allow_comments).map((page) => ({
          targetType: 'page' as const,
          publicId: page.public_id,
        })),
      ]
    : [];
  const commentTokens = commentTargets.length > 0 && input.edgeDb
    ? await createCommentRequestTokens({
        edgeDb: input.edgeDb,
        targets: commentTargets,
      })
    : new Map<string, string>();
  const previewData = buildPreviewDataV07({
    settings,
    taxonomies,
    posts,
    authors,
    pages,
    menus,
    widgets,
    branding,
    customCode,
    ...(commentDocument
      ? { commentSettings: commentDocument.settings, commentTokens }
      : {}),
    generatedAt: input.generatedAt,
  });
  const validation = (input.validate ?? validatePreviewData)(previewData);
  if (
    !validation.ok
    || validation.errors.length > 0
    || validation.warnings.some((issue) => issue.severity !== 'warning')
  ) {
    throw projectionInvalid(validation);
  }
  return {
    preview_data: previewData,
    validation: {
      status: 'valid',
      contract_version: PREVIEW_DATA_VERSION,
      warnings: validation.warnings.map((warning) => ({
        code: warning.code,
        path: warning.path,
        message: warning.message,
        severity: 'warning',
      })),
    },
  };
}

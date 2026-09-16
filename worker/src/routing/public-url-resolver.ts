import { normalizeStoredSlug } from '@zeropress/slug-policy';
import type { Page } from '../../../contracts/pages';
import type { Post } from '../../../contracts/posts';
import type { RoutingSettings } from '../../../contracts/routing-settings';

export type PermalinkTaxonomy = { slug: string };
export type PublicRoute = {
  path: string;
  url: string;
};
export type PagePublicRoute = PublicRoute & {
  referencePath: string;
};

export function normalizeRoutePath(routePath: string): string {
  if (!routePath || routePath === '/') return '/';
  let decoded = routePath;
  try {
    decoded = decodeURI(routePath);
  } catch {
    // Canonical Studio routing settings never contain malformed escapes.
  }
  const normalized = decoded.replace(/^\/+|\/+$/gu, '');
  return normalized === '' ? '/' : `/${normalized}/`;
}

export function routePathToPublicUrl(
  routePath: string,
  outputStyle: RoutingSettings['permalinks']['output_style'],
): string {
  const normalized = normalizeRoutePath(routePath);
  if (normalized === '/') return '/';
  return outputStyle === 'html-extension'
    ? normalized.replace(/\/$/u, '')
    : normalized;
}

export function pagePathToPublicUrl(
  routePath: string,
  outputStyle: RoutingSettings['permalinks']['output_style'],
): string {
  const normalized = normalizeRoutePath(routePath);
  if (outputStyle !== 'html-extension') {
    return routePathToPublicUrl(normalized, outputStyle);
  }
  const withoutTrailingSlash = normalized.replace(/\/$/u, '');
  if (withoutTrailingSlash === '/index') return '/';
  if (withoutTrailingSlash.endsWith('/index')) {
    return `${withoutTrailingSlash.slice(0, -'/index'.length)}/`;
  }
  return withoutTrailingSlash;
}

function fixedOffsetDateParts(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number } | null {
  const match = /^([+-])(\d{2}):(\d{2})$/u.exec(timezone);
  if (!match) return null;
  const direction = match[1] === '-' ? -1 : 1;
  const offsetMinutes = direction
    * (Number(match[2]) * 60 + Number(match[3]));
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function zonedDateParts(
  value: string,
  timezone: string,
): { year: number; month: number; day: number } {
  const date = new Date(value);
  const fixed = fixedOffsetDateParts(date, timezone);
  if (fixed) return fixed;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value)
      || date.getUTCFullYear(),
    month: Number(parts.find((part) => part.type === 'month')?.value)
      || date.getUTCMonth() + 1,
    day: Number(parts.find((part) => part.type === 'day')?.value)
      || date.getUTCDate(),
  };
}

function applyPattern(
  pattern: string,
  values: Readonly<Record<string, string>>,
): string {
  const segments = pattern.replace(/^\/+|\/+$/gu, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.startsWith(':')
      ? values[segment.slice(1)] ?? ''
      : segment);
  return `/${segments.join('/')}/`;
}

function buildRoute(
  path: string,
  settings: RoutingSettings,
): PublicRoute {
  const normalized = normalizeRoutePath(path);
  return {
    path: normalized,
    url: routePathToPublicUrl(
      normalized,
      settings.permalinks.output_style,
    ),
  };
}

export function resolvePostPublicRoute(input: {
  settings: RoutingSettings;
  timezone: string;
  post: Pick<
    Post,
    'slug' | 'public_id' | 'published_at_iso' | 'created_at_iso'
  >;
}): PublicRoute {
  const date = zonedDateParts(
    input.post.published_at_iso ?? input.post.created_at_iso,
    input.timezone,
  );
  return buildRoute(applyPattern(input.settings.permalinks.posts, {
    slug: normalizeStoredSlug(input.post.slug),
    public_id: String(input.post.public_id),
    year: String(date.year),
    month: String(date.month).padStart(2, '0'),
    day: String(date.day).padStart(2, '0'),
  }), input.settings);
}

export function resolvePagePublicRoute(input: {
  settings: RoutingSettings;
  page: Pick<Page, 'slug' | 'path' | 'parent'>;
}): PagePublicRoute {
  const routePath = applyPattern(input.settings.permalinks.pages, {
    slug: input.page.parent === null
      ? normalizeStoredSlug(input.page.slug)
      : input.page.path,
  });
  const path = normalizeRoutePath(routePath);
  return {
    path,
    url: pagePathToPublicUrl(
      path,
      input.settings.permalinks.output_style,
    ),
    referencePath: path.replace(/^\/+|\/+$/gu, '').normalize('NFC'),
  };
}

export function resolvePageNavigationUrl(input: {
  settings: RoutingSettings;
  page: Pick<Page, 'id' | 'slug' | 'path' | 'parent'>;
}): string {
  if (
    input.settings.front_page.type === 'page'
    && input.settings.front_page.page_id === input.page.id
  ) return '/';
  return resolvePagePublicRoute(input).url;
}

function resolveTaxonomyPublicRoute(input: {
  settings: RoutingSettings;
  taxonomy: PermalinkTaxonomy;
  kind: 'categories' | 'tags';
}): PublicRoute {
  return buildRoute(applyPattern(
    input.settings.permalinks[input.kind],
    { slug: normalizeStoredSlug(input.taxonomy.slug) },
  ), input.settings);
}

export function resolveCategoryPublicRoute(input: {
  settings: RoutingSettings;
  category: PermalinkTaxonomy;
}): PublicRoute {
  return resolveTaxonomyPublicRoute({
    settings: input.settings,
    taxonomy: input.category,
    kind: 'categories',
  });
}

export function resolveTagPublicRoute(input: {
  settings: RoutingSettings;
  tag: PermalinkTaxonomy;
}): PublicRoute {
  return resolveTaxonomyPublicRoute({
    settings: input.settings,
    taxonomy: input.tag,
    kind: 'tags',
  });
}

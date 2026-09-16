import { validateSlugSegment } from '@zeropress/slug-policy';
import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  pageEffectivePathSchema,
  pageIdSchema,
  pageTitleSchema,
} from './pages';
import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from './settings-revision';

export const ROUTING_SETTINGS_INITIAL_REVISION = SETTINGS_INITIAL_REVISION;
export const ROUTING_PAGE_OPTIONS_MAX_ITEMS = 100;
export const ROUTING_SETTINGS_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export const PERMALINK_OUTPUT_STYLES = [
  'directory',
  'html-extension',
] as const;

export const ROUTING_SETTINGS_DEFAULTS = Object.freeze({
  permalinks: Object.freeze({
    output_style: 'directory' as const,
    posts: '/posts/:slug/',
    pages: '/:slug/',
    categories: '/categories/:slug/',
    tags: '/tags/:slug/',
  }),
  front_page: Object.freeze({ type: 'theme_index' as const }),
  post_index: Object.freeze({
    enabled: true,
    path: '/',
    paginate: true,
  }),
});

export const ROUTING_SETTINGS_FIELDS = [
  'permalinks',
  'front_page',
  'post_index',
] as const;

type PermalinkField = 'posts' | 'pages' | 'categories' | 'tags';

const ALLOWED_TOKENS: Readonly<Record<PermalinkField, ReadonlySet<string>>> = {
  posts: new Set(['slug', 'public_id', 'year', 'month', 'day']),
  pages: new Set(['slug']),
  categories: new Set(['slug']),
  tags: new Set(['slug']),
};

function hasUnsafeRouteCharacter(value: string): boolean {
  return value.includes('\\')
    || value.includes('?')
    || value.includes('#')
    || value.includes('%')
    || /[\s\u0000-\u001F\u007F]/u.test(value);
}

function canonicalizePermalinkPattern(
  value: string,
  field: PermalinkField,
): string | null {
  const normalizedInput = value.trim().normalize('NFC');
  if (
    normalizedInput === ''
    || !normalizedInput.startsWith('/')
    || hasUnsafeRouteCharacter(normalizedInput)
    || normalizedInput.endsWith('.html')
    || normalizedInput.includes('.html/')
    || normalizedInput.includes('//')
  ) return null;

  const body = normalizedInput.replace(/^\/+|\/+$/gu, '');
  if (body === '') return null;
  const segments = body.split('/');
  const usedTokens = new Set<string>();
  for (const segment of segments) {
    if (segment === '') return null;
    if (segment.includes(':')) {
      if (
        !segment.startsWith(':')
        || segment.length === 1
        || segment.slice(1).includes(':')
      ) return null;
      const token = segment.slice(1);
      if (!ALLOWED_TOKENS[field].has(token)) return null;
      usedTokens.add(token);
      continue;
    }
    const validation = validateSlugSegment(segment);
    if (!validation.ok || validation.normalized !== segment) return null;
  }
  if (
    field === 'posts'
      ? !usedTokens.has('slug') && !usedTokens.has('public_id')
      : !usedTokens.has('slug')
  ) return null;
  return `/${segments.join('/')}/`;
}

function canonicalizePostIndexPath(value: string): string | null {
  const normalizedInput = value.trim().normalize('NFC');
  if (
    normalizedInput === ''
    || !normalizedInput.startsWith('/')
    || hasUnsafeRouteCharacter(normalizedInput)
    || normalizedInput.endsWith('.html')
    || normalizedInput.includes('.html/')
    || normalizedInput.includes('//')
  ) return null;
  if (normalizedInput === '/') return '/';
  const body = normalizedInput.replace(/^\/+|\/+$/gu, '');
  if (body === '') return '/';
  const segments = body.split('/');
  for (const segment of segments) {
    if (segment === '' || segment.includes(':')) return null;
    const validation = validateSlugSegment(segment);
    if (!validation.ok || validation.normalized !== segment) return null;
  }
  return `/${segments.join('/')}/`;
}

function permalinkPatternInputSchema(field: PermalinkField) {
  return z.string()
    .transform((value, context) => {
      const canonical = canonicalizePermalinkPattern(value, field);
      if (canonical === null) {
        context.addIssue({
          code: 'custom',
          message: `Invalid ${field} permalink pattern.`,
        });
        return z.NEVER;
      }
      return canonical;
    });
}

function permalinkPatternSchema(field: PermalinkField) {
  return z.string()
    .min(1)
    .refine((value) => canonicalizePermalinkPattern(value, field) === value);
}

const postIndexPathInputSchema = z.string()
  .transform((value, context) => {
    const canonical = canonicalizePostIndexPath(value);
    if (canonical === null) {
      context.addIssue({
        code: 'custom',
        message: 'Invalid Post index path.',
      });
      return z.NEVER;
    }
    return canonical;
  });

const postIndexPathSchema = z.string()
  .min(1)
  .refine((value) => canonicalizePostIndexPath(value) === value);

const permalinkInputSchema = z.object({
  output_style: z.enum(PERMALINK_OUTPUT_STYLES),
  posts: permalinkPatternInputSchema('posts'),
  pages: permalinkPatternInputSchema('pages'),
  categories: permalinkPatternInputSchema('categories'),
  tags: permalinkPatternInputSchema('tags'),
}).strict();

const permalinkSchema = z.object({
  output_style: z.enum(PERMALINK_OUTPUT_STYLES),
  posts: permalinkPatternSchema('posts'),
  pages: permalinkPatternSchema('pages'),
  categories: permalinkPatternSchema('categories'),
  tags: permalinkPatternSchema('tags'),
}).strict();

export const routingFrontPageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('theme_index') }).strict(),
  z.object({
    type: z.literal('page'),
    page_id: pageIdSchema,
  }).strict(),
  z.object({
    type: z.literal('standalone_html'),
    html: z.string().min(1).refine((value) => /\S/u.test(value)),
  }).strict(),
]);

const postIndexInputSchema = z.object({
  enabled: z.boolean(),
  path: postIndexPathInputSchema,
  paginate: z.boolean(),
}).strict();

const postIndexSchema = z.object({
  enabled: z.boolean(),
  path: postIndexPathSchema,
  paginate: z.boolean(),
}).strict();

function rejectRootRouteCollision(
  value: {
    front_page:
      | { type: 'theme_index' }
      | { type: 'page'; page_id: string }
      | { type: 'standalone_html'; html: string };
    post_index: { enabled: boolean; path: string; paginate: boolean };
  },
  context: z.RefinementCtx,
): void {
  if (
    value.front_page.type !== 'theme_index'
    && value.post_index.enabled
    && value.post_index.path === '/'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['post_index', 'path'],
      message: 'The Front Page and enabled Post index cannot both use /.',
    });
  }
}

export const routingSettingsInputSchema = z.object({
  permalinks: permalinkInputSchema,
  front_page: routingFrontPageSchema,
  post_index: postIndexInputSchema,
}).strict().superRefine(rejectRootRouteCollision);

export const routingSettingsSchema = z.object({
  permalinks: permalinkSchema,
  front_page: routingFrontPageSchema,
  post_index: postIndexSchema,
}).strict().superRefine(rejectRootRouteCollision);

export type RoutingSettings = z.infer<typeof routingSettingsSchema>;

export function materializeRoutingSettingsDefaults(): RoutingSettings {
  return {
    permalinks: { ...ROUTING_SETTINGS_DEFAULTS.permalinks },
    front_page: { ...ROUTING_SETTINGS_DEFAULTS.front_page },
    post_index: { ...ROUTING_SETTINGS_DEFAULTS.post_index },
  };
}

export const updateRoutingSettingsRequestSchema = z.object({
  settings: routingSettingsInputSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

export const routingSettingsDocumentSchema = z.object({
  settings: routingSettingsSchema,
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const routingSettingsSuccessSchema = z.object({
  success: z.literal(true),
  data: routingSettingsDocumentSchema,
}).strict();

export const routingSettingsFieldSchema = z.enum(ROUTING_SETTINGS_FIELDS);

const routingSettingsMissingFieldsSchema = z.array(routingSettingsFieldSchema)
  .min(1)
  .max(ROUTING_SETTINGS_FIELDS.length)
  .refine((fields) => new Set(fields).size === fields.length, {
    message: 'Expected unique missing routing-setting groups',
  });

export const routingSettingsRecoveryPlanSchema = z.object({
  expected_revision: settingsRevisionSchema,
  missing_fields: routingSettingsMissingFieldsSchema,
  proposed_settings: routingSettingsSchema,
}).strict();

export const routingSettingsIncompleteResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.literal('SITE_ROUTING_SETTINGS_INCOMPLETE'),
    recovery: routingSettingsRecoveryPlanSchema,
  }).strict(),
}).strict();

export const repairRoutingSettingsRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
  missing_fields: routingSettingsMissingFieldsSchema,
}).strict();

export const routingSettingsResponseSchema = z.union([
  routingSettingsSuccessSchema,
  routingSettingsIncompleteResponseSchema,
  apiErrorSchema,
]);

export const routingPageOptionsQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  selected_page_id: pageIdSchema.optional(),
}).strict();

export const routingPageOptionSchema = z.object({
  id: pageIdSchema,
  title: pageTitleSchema,
  path: pageEffectivePathSchema,
}).strict();

export const routingPageOptionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(routingPageOptionSchema)
      .max(ROUTING_PAGE_OPTIONS_MAX_ITEMS),
  }).strict(),
}).strict();

export const routingPageOptionsResponseSchema = z.union([
  routingPageOptionsSuccessSchema,
  apiErrorSchema,
]);

export type RoutingSettingsDocument = z.infer<
  typeof routingSettingsDocumentSchema
>;
export type RoutingSettingsField = z.infer<typeof routingSettingsFieldSchema>;
export type RoutingSettingsRecoveryPlan = z.infer<
  typeof routingSettingsRecoveryPlanSchema
>;
export type RepairRoutingSettingsRequest = z.infer<
  typeof repairRoutingSettingsRequestSchema
>;
export type UpdateRoutingSettingsRequest = z.infer<
  typeof updateRoutingSettingsRequestSchema
>;
export type RoutingSettingsResponse = z.infer<
  typeof routingSettingsResponseSchema
>;
export type RoutingPageOption = z.infer<typeof routingPageOptionSchema>;
export type RoutingPageOptionsResponse = z.infer<
  typeof routingPageOptionsResponseSchema
>;

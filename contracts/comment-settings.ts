import { z } from 'zod';
import { apiErrorSchema } from './api';
import { settingsRevisionSchema } from './settings-revision';

export const COMMENT_SETTINGS_LIMITS = {
  apiBaseUrlCodePoints: 2_048,
  supabaseProjectUrlCodePoints: 2_048,
  perPageMinimum: 1,
  perPageMaximum: 100,
  threadDepthMinimum: 2,
  threadDepthMaximum: 10,
} as const;

export const SUPABASE_PUBLISHABLE_KEY_PATTERN =
  /^sb_publishable_[A-Za-z0-9._-]{16,512}$/u;

export const COMMENT_SETTINGS_DEFAULTS = {
  enabled: true,
  provider: 'zeropress',
  api_base_url: null,
  per_page: 50,
  order: 'desc',
  threading: {
    enabled: true,
    max_depth: 2,
  },
  moderation: {
    require_approval: true,
  },
  auth: {
    enabled: false,
    provider: 'supabase',
    project_url: null,
    publishable_key: null,
  },
} as const;

function codePointLength(value: string): number {
  return [...value].length;
}

function hasUnsafeUrlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return character === '\\'
      || /\s/u.test(character)
      || code <= 31
      || code === 127;
  });
}

/**
 * Normalize the Preview Data v0.7 comments API-base URL contract.
 * Root-relative paths remain root-relative; absolute URLs retain their path.
 */
export function normalizeCommentApiBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (
    value.length === 0
    || value.trim() !== value
    || codePointLength(value) > COMMENT_SETTINGS_LIMITS.apiBaseUrlCodePoints
    || hasUnsafeUrlCharacter(value)
    || value.startsWith('//')
    || /%(?![0-9A-Fa-f]{2})/u.test(value)
    || /(?:^|\/)\.{1,2}(?:\/|$|[?#])/u.test(value)
  ) {
    return null;
  }

  const rootRelative = value.startsWith('/');
  let parsed: URL;
  try {
    parsed = rootRelative
      ? new URL(value, 'https://zeropress.invalid')
      : new URL(value);
  } catch {
    return null;
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    return null;
  }

  const pathname = parsed.pathname === '/'
    ? '/'
    : parsed.pathname.replace(/\/+$/u, '');
  if (rootRelative) return pathname;
  return pathname === '/'
    ? parsed.origin
    : `${parsed.origin}${pathname}`;
}

/**
 * Normalize the public Supabase project origin consumed by ZeroPress Edge.
 * HTTPS is mandatory except for explicit loopback development origins.
 */
export function normalizeSupabaseProjectUrl(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || codePointLength(value)
      > COMMENT_SETTINGS_LIMITS.supabaseProjectUrlCodePoints
    || hasUnsafeUrlCharacter(value)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const loopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]';
  if (
    (parsed.protocol !== 'https:'
      && !(parsed.protocol === 'http:' && loopback))
    || parsed.hostname === ''
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    return null;
  }

  return parsed.origin;
}

/** Normalize the public key accepted by the Edge Supabase auth runtime. */
export function normalizeSupabasePublishableKey(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || !SUPABASE_PUBLISHABLE_KEY_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

const apiBaseUrlInputSchema = z.string().transform((value, context) => {
  const normalized = normalizeCommentApiBaseUrl(value);
  if (normalized === null) {
    context.addIssue({
      code: 'custom',
      message: 'Expected an absolute HTTP(S) or single-slash root-relative URL',
    });
    return z.NEVER;
  }
  return normalized;
});

const canonicalApiBaseUrlSchema = z.string().superRefine((value, context) => {
  if (normalizeCommentApiBaseUrl(value) !== value) {
    context.addIssue({
      code: 'custom',
      message: 'Expected a canonical comments API base URL',
    });
  }
});

const nullableSupabaseProjectUrlInputSchema = z.union([
  z.string().transform((value, context) => {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const normalized = normalizeSupabaseProjectUrl(trimmed);
    if (normalized === null) {
      context.addIssue({
        code: 'custom',
        message: 'Expected a safe Supabase project origin',
      });
      return z.NEVER;
    }
    return normalized;
  }),
  z.null(),
]);

const nullableSupabasePublishableKeyInputSchema = z.union([
  z.string().transform((value, context) => {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const normalized = normalizeSupabasePublishableKey(trimmed);
    if (normalized === null) {
      context.addIssue({
        code: 'custom',
        message: 'Expected a Supabase sb_publishable_ key',
      });
      return z.NEVER;
    }
    return normalized;
  }),
  z.null(),
]);

const canonicalSupabaseProjectUrlSchema = z.string().superRefine(
  (value, context) => {
    if (normalizeSupabaseProjectUrl(value) !== value) {
      context.addIssue({
        code: 'custom',
        message: 'Expected a canonical Supabase project origin',
      });
    }
  },
);

const canonicalSupabasePublishableKeySchema = z.string().superRefine(
  (value, context) => {
    if (normalizeSupabasePublishableKey(value) !== value) {
      context.addIssue({
        code: 'custom',
        message: 'Expected a canonical Supabase publishable key',
      });
    }
  },
);

function validateSupabaseAuthPair(
  value: {
    enabled: boolean;
    project_url: string | null;
    publishable_key: string | null;
  },
  context: z.RefinementCtx,
) {
  const hasProjectUrl = value.project_url !== null;
  const hasPublishableKey = value.publishable_key !== null;
  if (hasProjectUrl !== hasPublishableKey) {
    context.addIssue({
      code: 'custom',
      message: 'Supabase project URL and publishable key must be configured together',
      path: hasProjectUrl ? ['publishable_key'] : ['project_url'],
    });
  }
  if (value.enabled && (!hasProjectUrl || !hasPublishableKey)) {
    context.addIssue({
      code: 'custom',
      message: 'Enabled Supabase authentication requires its public configuration',
      path: ['enabled'],
    });
  }
}

const supabaseAuthInputSchema = z.object({
  enabled: z.boolean(),
  provider: z.literal('supabase'),
  project_url: nullableSupabaseProjectUrlInputSchema,
  publishable_key: nullableSupabasePublishableKeyInputSchema,
}).strict().superRefine(validateSupabaseAuthPair);

const supabaseAuthSchema = z.object({
  enabled: z.boolean(),
  provider: z.literal('supabase'),
  project_url: z.union([canonicalSupabaseProjectUrlSchema, z.null()]),
  publishable_key: z.union([
    canonicalSupabasePublishableKeySchema,
    z.null(),
  ]),
}).strict().superRefine(validateSupabaseAuthPair);

const threadingInputSchema = z.object({
  enabled: z.boolean(),
  max_depth: z.number().int()
    .min(COMMENT_SETTINGS_LIMITS.threadDepthMinimum)
    .max(COMMENT_SETTINGS_LIMITS.threadDepthMaximum),
}).strict();

const commentSettingsFields = {
  enabled: z.boolean(),
  provider: z.literal('zeropress'),
  per_page: z.number().int()
    .min(COMMENT_SETTINGS_LIMITS.perPageMinimum)
    .max(COMMENT_SETTINGS_LIMITS.perPageMaximum),
  order: z.enum(['asc', 'desc']),
  threading: threadingInputSchema,
  moderation: z.object({
    require_approval: z.boolean(),
  }).strict(),
} as const;

export const commentSettingsInputSchema = z.object({
  ...commentSettingsFields,
  api_base_url: z.union([apiBaseUrlInputSchema, z.null()]),
  auth: supabaseAuthInputSchema,
}).strict();

export const commentSettingsSchema = z.object({
  ...commentSettingsFields,
  api_base_url: z.union([canonicalApiBaseUrlSchema, z.null()]),
  auth: supabaseAuthSchema,
}).strict();

/** Compare canonical comment settings by value, independent of key order. */
export function areCommentSettingsEqual(
  left: CommentSettings,
  right: CommentSettings,
): boolean {
  return left.enabled === right.enabled
    && left.provider === right.provider
    && left.api_base_url === right.api_base_url
    && left.per_page === right.per_page
    && left.order === right.order
    && left.threading.enabled === right.threading.enabled
    && left.threading.max_depth === right.threading.max_depth
    && left.moderation.require_approval
      === right.moderation.require_approval
    && left.auth.enabled === right.auth.enabled
    && left.auth.provider === right.auth.provider
    && left.auth.project_url === right.auth.project_url
    && left.auth.publishable_key === right.auth.publishable_key;
}

export const updateCommentSettingsRequestSchema = z.object({
  settings: commentSettingsInputSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

export const commentSettingsDocumentSchema = z.object({
  settings: commentSettingsSchema,
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const commentSettingsSuccessSchema = z.object({
  success: z.literal(true),
  data: commentSettingsDocumentSchema,
}).strict();

export const commentSettingsResponseSchema = z.union([
  commentSettingsSuccessSchema,
  apiErrorSchema,
]);

export const commentRequestSecurityStatusSchema = z.enum([
  'missing',
  'valid',
  'invalid',
]);

const commentRequestSecurityCurrentKeySchema = z.object({
  kid: z.string().regex(/^k_[A-Za-z0-9_-]{22}$/u),
  created_at_iso: z.iso.datetime({ offset: true }),
}).strict();

const commentRequestSecurityPreviousKeysSchema = z.object({
  total_count: z.number().int().nonnegative(),
  active_count: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.active_count > value.total_count) {
    context.addIssue({
      code: 'custom',
      message: 'Active previous keys cannot exceed the total count.',
      path: ['active_count'],
    });
  }
});

export const commentRequestSecurityResourceSchema = z.object({
  status: commentRequestSecurityStatusSchema,
  revision: settingsRevisionSchema,
  current_key: commentRequestSecurityCurrentKeySchema.nullable(),
  previous_keys: commentRequestSecurityPreviousKeysSchema,
}).strict().superRefine((value, context) => {
  if (value.status === 'valid' && value.current_key === null) {
    context.addIssue({
      code: 'custom',
      message: 'Valid request security requires a current key.',
      path: ['current_key'],
    });
  }
  if (
    value.status !== 'valid'
    && (
      value.current_key !== null
      || value.previous_keys.total_count !== 0
      || value.previous_keys.active_count !== 0
    )
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Unavailable request security cannot expose key metadata.',
    });
  }
});

export const commentRequestSecuritySuccessSchema = z.object({
  success: z.literal(true),
  data: commentRequestSecurityResourceSchema,
}).strict();

export const commentRequestSecurityResponseSchema = z.union([
  commentRequestSecuritySuccessSchema,
  apiErrorSchema,
]);

export const commentRequestSecurityMutationRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
}).strict();

export type CommentSettings = z.infer<typeof commentSettingsSchema>;
export type CommentSettingsDocument = z.infer<
  typeof commentSettingsDocumentSchema
>;
export type CommentSettingsResponse = z.infer<
  typeof commentSettingsResponseSchema
>;
export type UpdateCommentSettingsRequest = z.input<
  typeof updateCommentSettingsRequestSchema
>;
export type NormalizedUpdateCommentSettingsRequest = z.output<
  typeof updateCommentSettingsRequestSchema
>;
export type CommentRequestSecurityStatus = z.infer<
  typeof commentRequestSecurityStatusSchema
>;
export type CommentRequestSecurityResource = z.infer<
  typeof commentRequestSecurityResourceSchema
>;
export type CommentRequestSecurityResponse = z.infer<
  typeof commentRequestSecurityResponseSchema
>;
export type CommentRequestSecurityMutationRequest = z.infer<
  typeof commentRequestSecurityMutationRequestSchema
>;

import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  authorDisplayNameSchema,
  authorIdSchema,
} from './author-identity';
import { contentPublicIdSchema } from './content-public-id';
import { mediaOriginSchema } from './media-settings';
import { mediaAiGenerationSchema } from './media-ai-generation';
import { settingsRevisionSchema } from './settings-revision';

export const MEDIA_EXTERNAL_URL_MAX_CODE_POINTS = 2_048;
export const MEDIA_STORAGE_KEY_MAX_CODE_POINTS = 1_024;
export const MEDIA_FILENAME_MAX_CODE_POINTS = 255;
export const MEDIA_MIME_TYPE_MAX_CODE_POINTS = 255;
export const MEDIA_ALT_MAX_CODE_POINTS = 1_000;
export const MEDIA_DIMENSION_MAX = 100_000;
export const MEDIA_DEFAULT_PAGE_SIZE = 50;
export const MEDIA_MAX_PAGE_SIZE = 100;
export const MEDIA_REFERENCES_DEFAULT_PAGE_SIZE = 20;
export const MEDIA_REFERENCES_MAX_PAGE_SIZE = 50;
export const MEDIA_COLLECTION_NAME_MAX_CODE_POINTS = 100;
export const MEDIA_COLLECTION_MAX_ITEMS = 500;
export const MEDIA_BULK_MOVE_MAX_ITEMS = 100;
export const MEDIA_BULK_OPERATION_MAX_ITEMS = 50;
export const MANAGED_MEDIA_REFERENCE_PREFIX = '/__zeropress_media__/';
export const DELETABLE_R2_MEDIA_STORAGE_PREFIXES = [
  'uploads/',
  'imported/',
] as const;
export const R2_MEDIA_PREVIEW_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
] as const;

export const mediaKinds = [
  'image',
  'video',
  'audio',
  'document',
  'archive',
  'other',
] as const;
export const mediaListKinds = ['all', ...mediaKinds] as const;
export const mediaListPurposes = [
  'all',
  'featured_image',
  'branding_favicon',
  'branding_logo',
  'author_avatar',
] as const;
export const mediaBrandingSlots = [
  'favicon',
  'favicon_dark',
  'apple_touch_icon',
  'logo',
] as const;

export const mediaIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const privateMediaPreviewUrlSchema = z.string().regex(
  /^\/api\/media\/[0-9a-f]{32}\/preview\?revision=[0-9a-f]{32}$/u,
);
export const mediaCollectionIdSchema = mediaIdSchema;
export const mediaKindSchema = z.enum(mediaKinds);
export const mediaListKindSchema = z.enum(mediaListKinds);
export const mediaListPurposeSchema = z.enum(mediaListPurposes);

function codePointLength(value: string): number {
  return [...value].length;
}

function hasUnsafeDotPathSegment(pathname: string): boolean {
  return pathname.split('/').some((segment) => {
    if (segment === '') return false;
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === '.' || decoded === '..';
    } catch {
      return true;
    }
  });
}

export function normalizeExternalMediaUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized === ''
    || codePointLength(normalized) > MEDIA_EXTERNAL_URL_MAX_CODE_POINTS
    || /[\s\\\p{Cc}]/u.test(normalized)
    || /%(?![0-9A-Fa-f]{2})/u.test(normalized)
    || !/^https?:\/\//iu.test(normalized)
  ) return null;
  const authoritySuffix = normalized.slice(normalized.indexOf('://') + 3);
  const pathStart = authoritySuffix.indexOf('/');
  const rawPath = pathStart < 0
    ? '/'
    : authoritySuffix.slice(pathStart).split(/[?#]/u, 1)[0];
  if (hasUnsafeDotPathSegment(rawPath)) return null;
  try {
    const parsed = new URL(normalized);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.hostname === ''
      || parsed.pathname === '/'
      || hasUnsafeDotPathSegment(parsed.pathname)
    ) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function normalizeMediaStorageKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized === ''
    || codePointLength(normalized) > MEDIA_STORAGE_KEY_MAX_CODE_POINTS
    || normalized.startsWith('/')
    || normalized.endsWith('/')
    || normalized.includes('//')
    || /[\s\\?#\p{Cc}]/u.test(normalized)
    || /%(?![0-9A-Fa-f]{2})/u.test(normalized)
    || hasUnsafeDotPathSegment(`/${normalized}`)
  ) return null;
  return normalized;
}

export function normalizeMediaFilename(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized === ''
    || codePointLength(normalized) > MEDIA_FILENAME_MAX_CODE_POINTS
    || /[/\\\p{Cc}]/u.test(normalized)
  ) return null;
  return normalized;
}

export function normalizeMediaMimeType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === ''
    || codePointLength(normalized) > MEDIA_MIME_TYPE_MAX_CODE_POINTS
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)
  ) return null;
  return normalized;
}

function normalizedString(
  normalize: (value: unknown) => string | null,
  message: string,
) {
  return z.string().transform((value, context) => {
    const normalized = normalize(value);
    if (normalized === null) {
      context.addIssue({ code: 'custom', message });
      return z.NEVER;
    }
    return normalized;
  });
}

function canonicalString(
  normalize: (value: unknown) => string | null,
  message: string,
) {
  return z.string().superRefine((value, context) => {
    if (normalize(value) !== value) {
      context.addIssue({ code: 'custom', message });
    }
  });
}

const externalUrlMessage = 'Expected a canonical credential-free absolute HTTP(S) media URL with a non-root path';
const storageKeyMessage = 'Expected a canonical relative R2 object key without unsafe path segments';
const filenameMessage = 'Expected a trimmed filename without path separators or control characters';
const mimeTypeMessage = 'Expected a canonical lowercase MIME type without parameters';

export const externalMediaUrlInputSchema = normalizedString(
  normalizeExternalMediaUrl,
  externalUrlMessage,
);
export const externalMediaUrlSchema = canonicalString(
  normalizeExternalMediaUrl,
  externalUrlMessage,
);
export const mediaStorageKeyInputSchema = normalizedString(
  normalizeMediaStorageKey,
  storageKeyMessage,
);
export const mediaStorageKeySchema = canonicalString(
  normalizeMediaStorageKey,
  storageKeyMessage,
);

export function isDeletableR2MediaStorageKey(
  value: unknown,
): value is string {
  return typeof value === 'string'
    && normalizeMediaStorageKey(value) === value
    && DELETABLE_R2_MEDIA_STORAGE_PREFIXES.some((prefix) => (
      value.startsWith(prefix)
    ));
}
export const mediaFilenameInputSchema = normalizedString(
  normalizeMediaFilename,
  filenameMessage,
);
export const mediaFilenameSchema = canonicalString(
  normalizeMediaFilename,
  filenameMessage,
);
export const mediaMimeTypeInputSchema = normalizedString(
  normalizeMediaMimeType,
  mimeTypeMessage,
);
export const mediaMimeTypeSchema = canonicalString(
  normalizeMediaMimeType,
  mimeTypeMessage,
);
export const mediaDimensionSchema = z.number().int().min(1)
  .max(MEDIA_DIMENSION_MAX);
export const mediaSizeBytesSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const mediaDurationMsSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export const mediaAltInputSchema = z.string().trim()
  .refine((value) => codePointLength(value) <= MEDIA_ALT_MAX_CODE_POINTS);
export const mediaAltSchema = z.string()
  .refine((value) => value === value.trim())
  .refine((value) => codePointLength(value) <= MEDIA_ALT_MAX_CODE_POINTS);

export function normalizeMediaCollectionName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().normalize('NFC');
  if (
    normalized === ''
    || codePointLength(normalized) > MEDIA_COLLECTION_NAME_MAX_CODE_POINTS
    || /\p{Cc}/u.test(normalized)
  ) return null;
  return normalized;
}

const collectionNameMessage =
  'Expected a trimmed NFC Media collection name without control characters';
export const mediaCollectionNameInputSchema = normalizedString(
  normalizeMediaCollectionName,
  collectionNameMessage,
);
export const mediaCollectionNameSchema = canonicalString(
  normalizeMediaCollectionName,
  collectionNameMessage,
);

export const externalMediaLocationInputSchema = z.object({
  type: z.literal('external'),
  url: externalMediaUrlInputSchema,
}).strict();
export const externalMediaLocationSchema = z.object({
  type: z.literal('external'),
  url: externalMediaUrlSchema,
}).strict();
export const r2MediaLocationInputSchema = z.object({
  type: z.literal('r2'),
  key: mediaStorageKeyInputSchema,
}).strict();
export const r2MediaLocationSchema = z.object({
  type: z.literal('r2'),
  key: mediaStorageKeySchema,
}).strict();
export const mediaLocationInputSchema = z.discriminatedUnion('type', [
  externalMediaLocationInputSchema,
  r2MediaLocationInputSchema,
]);
export const mediaLocationSchema = z.discriminatedUnion('type', [
  externalMediaLocationSchema,
  r2MediaLocationSchema,
]);

const mediaMetadataFields = {
  kind: mediaKindSchema,
  filename: mediaFilenameSchema,
  mime_type: mediaMimeTypeSchema,
  size_bytes: mediaSizeBytesSchema.nullable(),
  width: mediaDimensionSchema.nullable(),
  height: mediaDimensionSchema.nullable(),
  duration_ms: mediaDurationMsSchema.nullable(),
  alt: mediaAltSchema,
};

function validateMediaMetadata(
  value: {
    kind: (typeof mediaKinds)[number];
    mime_type: string;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    alt: string;
  },
  context: z.core.$RefinementCtx,
) {
  if ((value.width === null) !== (value.height === null)) {
    context.addIssue({
      code: 'custom',
      path: ['width'],
      message: 'Media width and height must both be present or both be null.',
    });
  }
  const expectedPrefix = value.kind === 'image'
    ? 'image/'
    : value.kind === 'video'
      ? 'video/'
      : value.kind === 'audio'
        ? 'audio/'
        : null;
  if (expectedPrefix && !value.mime_type.startsWith(expectedPrefix)) {
    context.addIssue({
      code: 'custom',
      path: ['mime_type'],
      message: `The MIME type must match the ${value.kind} kind.`,
    });
  }
  if (!['image', 'video'].includes(value.kind) && value.width !== null) {
    context.addIssue({
      code: 'custom',
      path: ['width'],
      message: 'Only image and video media may have dimensions.',
    });
  }
  if (!['audio', 'video'].includes(value.kind) && value.duration_ms !== null) {
    context.addIssue({
      code: 'custom',
      path: ['duration_ms'],
      message: 'Only audio and video media may have a duration.',
    });
  }
  if (value.kind !== 'image' && value.alt !== '') {
    context.addIssue({
      code: 'custom',
      path: ['alt'],
      message: 'Only image media may have alternative text.',
    });
  }
}

export const mediaReferenceSchema = z.object({
  id: mediaIdSchema,
  kind: z.literal('image'),
  filename: mediaFilenameSchema,
  mime_type: mediaMimeTypeSchema.refine((value) => value.startsWith('image/')),
  location: mediaLocationSchema,
  width: mediaDimensionSchema,
  height: mediaDimensionSchema,
  alt: mediaAltSchema,
}).strict();

export const mediaAssetSchema = z.object({
  ...mediaMetadataFields,
  location: mediaLocationSchema,
}).strict().superRefine(validateMediaMetadata);

export const mediaUsageSchema = z.object({
  posts: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  authors: z.number().int().nonnegative(),
  branding: z.number().int().nonnegative(),
}).strict();

const mediaContentUsageReferenceFields = {
  id: mediaIdSchema,
  public_id: contentPublicIdSchema,
  title: z.string().trim().min(1).max(200),
};

export const mediaUsageReferenceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('post'),
    ...mediaContentUsageReferenceFields,
  }).strict(),
  z.object({
    type: z.literal('page'),
    ...mediaContentUsageReferenceFields,
  }).strict(),
  z.object({
    type: z.literal('author'),
    id: authorIdSchema,
    display_name: authorDisplayNameSchema,
  }).strict(),
  z.object({
    type: z.literal('branding'),
    slot: z.enum(mediaBrandingSlots),
  }).strict(),
]);

export const mediaReferenceListQuerySchema = z.object({
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  per_page: z.coerce.number().int().positive()
    .max(MEDIA_REFERENCES_MAX_PAGE_SIZE)
    .default(MEDIA_REFERENCES_DEFAULT_PAGE_SIZE),
}).strict();

export const mediaCollectionSummarySchema = z.object({
  id: mediaCollectionIdSchema,
  name: mediaCollectionNameSchema,
}).strict();

export const mediaCollectionSchema = z.object({
  ...mediaCollectionSummarySchema.shape,
  media_count: z.number().int().nonnegative(),
  revision: settingsRevisionSchema,
  created_at_iso: z.iso.datetime({ offset: true }),
  updated_at_iso: z.iso.datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.created_at_iso) > Date.parse(value.updated_at_iso)) {
    context.addIssue({
      code: 'custom',
      message: 'Media collection timestamps are invalid.',
    });
  }
});

export const mediaSchema = z.object({
  id: mediaIdSchema,
  ...mediaMetadataFields,
  location: mediaLocationSchema,
  collection: mediaCollectionSummarySchema.nullable(),
  usage: mediaUsageSchema,
  revision: settingsRevisionSchema,
  created_at_iso: z.iso.datetime({ offset: true }),
  updated_at_iso: z.iso.datetime({ offset: true }),
}).strict().superRefine((value, context) => {
  validateMediaMetadata(value, context);
  if (Date.parse(value.created_at_iso) > Date.parse(value.updated_at_iso)) {
    context.addIssue({ code: 'custom', message: 'Media timestamps are invalid.' });
  }
});

export const mediaListQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  kind: mediaListKindSchema.default('all'),
  purpose: mediaListPurposeSchema.default('all'),
  collection: z.union([
    z.literal('all'),
    z.literal('unfiled'),
    mediaCollectionIdSchema,
  ]).default('all'),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  per_page: z.coerce.number().int().positive()
    .max(MEDIA_MAX_PAGE_SIZE)
    .default(MEDIA_DEFAULT_PAGE_SIZE),
}).strict();

const mediaPaginationSchema = z.object({
  page: z.number().int().positive(),
  per_page: z.number().int().positive().max(MEDIA_MAX_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
}).strict();

export const mediaDeliverySchema = z.object({
  media_origin: mediaOriginSchema,
  r2_preview_available: z.boolean(),
}).strict();

export const mediaListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(mediaSchema).max(MEDIA_MAX_PAGE_SIZE),
    pagination: mediaPaginationSchema,
    delivery: mediaDeliverySchema,
  }).strict(),
}).strict();

export const mediaListResponseSchema = z.union([
  mediaListSuccessSchema,
  apiErrorSchema,
]);

export const mediaReferenceListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    media_id: mediaIdSchema,
    items: z.array(mediaUsageReferenceSchema)
      .max(MEDIA_REFERENCES_MAX_PAGE_SIZE),
    pagination: z.object({
      page: z.number().int().positive(),
      per_page: z.number().int().positive()
        .max(MEDIA_REFERENCES_MAX_PAGE_SIZE),
      total: z.number().int().nonnegative(),
      total_pages: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
}).strict();

export const mediaReferenceListResponseSchema = z.union([
  mediaReferenceListSuccessSchema,
  apiErrorSchema,
]);

export const mediaInformationSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    media_id: mediaIdSchema,
    generation: mediaAiGenerationSchema.nullable(),
    references: z.object({
      items: z.array(mediaUsageReferenceSchema)
        .max(MEDIA_REFERENCES_MAX_PAGE_SIZE),
      pagination: z.object({
        page: z.number().int().positive(),
        per_page: z.number().int().positive()
          .max(MEDIA_REFERENCES_MAX_PAGE_SIZE),
        total: z.number().int().nonnegative(),
        total_pages: z.number().int().nonnegative(),
      }).strict(),
    }).strict(),
  }).strict(),
}).strict();

export const mediaInformationResponseSchema = z.union([
  mediaInformationSuccessSchema,
  apiErrorSchema,
]);

export const mediaCollectionListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(mediaCollectionSchema).max(MEDIA_COLLECTION_MAX_ITEMS),
    total_media_count: z.number().int().nonnegative(),
    unfiled_media_count: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export const mediaCollectionListResponseSchema = z.union([
  mediaCollectionListSuccessSchema,
  apiErrorSchema,
]);

export const createMediaCollectionRequestSchema = z.object({
  name: mediaCollectionNameInputSchema,
}).strict();

export const updateMediaCollectionRequestSchema = z.object({
  name: mediaCollectionNameInputSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

export const mediaCollectionMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: mediaCollectionSchema,
}).strict();
export const mediaCollectionMutationResponseSchema = z.union([
  mediaCollectionMutationSuccessSchema,
  apiErrorSchema,
]);

export const deleteMediaCollectionRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
}).strict();

export const mediaCollectionDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('media_collection_deleted'),
    id: mediaCollectionIdSchema,
  }).strict(),
}).strict();
export const mediaCollectionDeleteResponseSchema = z.union([
  mediaCollectionDeleteSuccessSchema,
  apiErrorSchema,
]);

export const bulkMoveMediaRequestSchema = z.object({
  target_collection_id: mediaCollectionIdSchema.nullable(),
  items: z.array(z.object({
    id: mediaIdSchema,
    expected_revision: settingsRevisionSchema,
  }).strict()).min(1).max(MEDIA_BULK_MOVE_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    if (seen.has(item.id)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'id'],
        message: 'Media IDs in a bulk move must be unique.',
      });
    }
    seen.add(item.id);
  }
});

export const bulkMoveMediaSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('media_moved'),
    target_collection_id: mediaCollectionIdSchema.nullable(),
    moved_count: z.number().int().nonnegative()
      .max(MEDIA_BULK_MOVE_MAX_ITEMS),
    unchanged_count: z.number().int().nonnegative()
      .max(MEDIA_BULK_MOVE_MAX_ITEMS),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (
    value.data.moved_count + value.data.unchanged_count
      > MEDIA_BULK_MOVE_MAX_ITEMS
  ) {
    context.addIssue({
      code: 'custom',
      path: ['data', 'moved_count'],
      message: 'Bulk move counts exceed the request limit.',
    });
  }
});
export const bulkMoveMediaResponseSchema = z.union([
  bulkMoveMediaSuccessSchema,
  apiErrorSchema,
]);

const bulkMediaIdentitySchema = z.object({
  id: mediaIdSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

function requireUniqueBulkMediaIds(
  items: Array<{ id: string }>,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (seen.has(item.id)) {
      context.addIssue({
        code: 'custom',
        path: ['items', index, 'id'],
        message: 'Media IDs in a bulk operation must be unique.',
      });
    }
    seen.add(item.id);
  }
}

export const bulkUpdateMediaMetadataRequestSchema = z.object({
  operation: z.literal('update_metadata'),
  items: z.array(bulkMediaIdentitySchema.extend({
    filename: mediaFilenameInputSchema,
    alt: mediaAltInputSchema,
  }).strict()).min(1).max(MEDIA_BULK_OPERATION_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  requireUniqueBulkMediaIds(value.items, context);
});

export const bulkDeleteMediaRequestSchema = z.object({
  operation: z.literal('delete'),
  items: z.array(bulkMediaIdentitySchema)
    .min(1)
    .max(MEDIA_BULK_OPERATION_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  requireUniqueBulkMediaIds(value.items, context);
});

export const bulkMediaOperationRequestSchema = z.union([
  bulkUpdateMediaMetadataRequestSchema,
  bulkDeleteMediaRequestSchema,
]);

export const bulkMediaOperationResultSchema = z.union([
  z.object({
    id: mediaIdSchema,
    outcome: z.enum(['updated', 'unchanged']),
    revision: settingsRevisionSchema,
  }).strict(),
  z.object({
    id: mediaIdSchema,
    outcome: z.literal('updated'),
    object_cleanup: z.enum(['not_applicable', 'pending']),
  }).strict(),
  z.object({
    id: mediaIdSchema,
    outcome: z.literal('conflict'),
  }).strict(),
  z.object({
    id: mediaIdSchema,
    outcome: z.literal('skipped'),
    reason: z.enum([
      'not_found',
      'in_use',
      'alt_not_applicable',
      'managed_storage_unavailable',
    ]),
  }).strict(),
]);

export const bulkMediaOperationSummarySchema = z.object({
  requested: z.number().int().positive()
    .max(MEDIA_BULK_OPERATION_MAX_ITEMS),
  updated: z.number().int().nonnegative()
    .max(MEDIA_BULK_OPERATION_MAX_ITEMS),
  unchanged: z.number().int().nonnegative()
    .max(MEDIA_BULK_OPERATION_MAX_ITEMS),
  conflict: z.number().int().nonnegative()
    .max(MEDIA_BULK_OPERATION_MAX_ITEMS),
  skipped: z.number().int().nonnegative()
    .max(MEDIA_BULK_OPERATION_MAX_ITEMS),
  queued_objects: z.number().int().nonnegative()
    .max(MEDIA_BULK_OPERATION_MAX_ITEMS),
}).strict().superRefine((value, context) => {
  if (
    value.updated + value.unchanged + value.conflict + value.skipped
      !== value.requested
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Bulk Media summary counts must equal requested items.',
    });
  }
});

export const bulkMediaOperationDataSchema = z.object({
  operation: z.enum(['update_metadata', 'delete']),
  results: z.array(bulkMediaOperationResultSchema)
    .min(1)
    .max(MEDIA_BULK_OPERATION_MAX_ITEMS),
  summary: bulkMediaOperationSummarySchema,
}).strict().superRefine((value, context) => {
  if (value.results.length !== value.summary.requested) {
    context.addIssue({
      code: 'custom',
      message: 'Bulk Media results must match the requested count.',
    });
  }
  const counts = { updated: 0, unchanged: 0, conflict: 0, skipped: 0 };
  let queuedObjects = 0;
  for (const result of value.results) {
    counts[result.outcome] += 1;
    if ('object_cleanup' in result && result.object_cleanup === 'pending') {
      queuedObjects += 1;
    }
  }
  for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
    if (counts[key] !== value.summary[key]) {
      context.addIssue({
        code: 'custom',
        path: ['summary', key],
        message: 'Bulk Media summary does not match its results.',
      });
    }
  }
  if (queuedObjects !== value.summary.queued_objects) {
    context.addIssue({
      code: 'custom',
      path: ['summary', 'queued_objects'],
      message: 'Queued object count does not match bulk Media results.',
    });
  }
  if (
    value.operation === 'update_metadata'
    && value.results.some((result) => 'object_cleanup' in result)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Metadata updates cannot report object cleanup.',
    });
  }
});

export const bulkMediaOperationSuccessSchema = z.object({
  success: z.literal(true),
  data: bulkMediaOperationDataSchema,
}).strict();
export const bulkMediaOperationResponseSchema = z.union([
  bulkMediaOperationSuccessSchema,
  apiErrorSchema,
]);

const authoredMediaInputFields = {
  kind: mediaKindSchema,
  filename: mediaFilenameInputSchema,
  mime_type: mediaMimeTypeInputSchema,
  size_bytes: mediaSizeBytesSchema.nullable(),
  width: mediaDimensionSchema.nullable(),
  height: mediaDimensionSchema.nullable(),
  duration_ms: mediaDurationMsSchema.nullable(),
  alt: mediaAltInputSchema,
};

export const createMediaRequestSchema = z.object({
  ...authoredMediaInputFields,
  location: externalMediaLocationInputSchema,
}).strict().superRefine(validateMediaMetadata);
export const updateMediaRequestSchema = z.object({
  ...authoredMediaInputFields,
  location: mediaLocationInputSchema,
  expected_revision: settingsRevisionSchema,
}).strict().superRefine(validateMediaMetadata);

export const mediaMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: mediaSchema,
}).strict();
export const mediaMutationResponseSchema = z.union([
  mediaMutationSuccessSchema,
  apiErrorSchema,
]);

export const deleteMediaRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
}).strict();

export const mediaDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('media_deleted'),
    id: mediaIdSchema,
    object_cleanup: z.enum(['not_applicable', 'completed', 'pending']),
  }).strict(),
}).strict();
export const mediaDeleteResponseSchema = z.union([
  mediaDeleteSuccessSchema,
  apiErrorSchema,
]);

export function mediaLocationIdentity(location: MediaLocation): string {
  return location.type === 'external'
    ? `external:${location.url}`
    : `r2:${location.key}`;
}

export function mediaLocationLabel(location: MediaLocation): string {
  return location.type === 'external' ? location.url : location.key;
}

export function mediaReferenceFromMedia(media: Media): MediaReference | null {
  const parsed = mediaReferenceSchema.safeParse({
    id: media.id,
    kind: media.kind,
    filename: media.filename,
    mime_type: media.mime_type,
    location: media.location,
    width: media.width,
    height: media.height,
    alt: media.alt,
  });
  return parsed.success ? parsed.data : null;
}

export function isR2MediaPreviewImageMimeType(
  value: string,
): value is (typeof R2_MEDIA_PREVIEW_IMAGE_MIME_TYPES)[number] {
  return (R2_MEDIA_PREVIEW_IMAGE_MIME_TYPES as readonly string[])
    .includes(value);
}

/**
 * Native uploads/ SVG objects are the only R2 SVGs whose bytes Studio has
 * passed through the fixed ZeroPress sanitizer profile. WXR imported/ objects
 * and arbitrary R2 metadata remain outside that trust boundary.
 */
export function isR2MediaPreviewSafeImage(
  mimeType: string,
  storageKey: string,
): boolean {
  return isR2MediaPreviewImageMimeType(mimeType)
    || (
      mimeType === 'image/svg+xml'
      && /^uploads\/.+\.svg$/u.test(storageKey)
    );
}

export function createManagedMediaReference(storageKey: string): string {
  return `${MANAGED_MEDIA_REFERENCE_PREFIX}${mediaStorageKeySchema.parse(storageKey)}`;
}

export function previewMediaSource(location: MediaLocation): string {
  return location.type === 'external' ? location.url : `/${location.key}`;
}

export function materializeManagedMediaReferences(
  value: string,
  mediaOrigin: string,
): string {
  if (!value.includes(MANAGED_MEDIA_REFERENCE_PREFIX)) return value;
  const publicPrefix = mediaOrigin
    ? `${mediaOrigin.replace(/\/+$/u, '')}/`
    : '/';
  return value.split(MANAGED_MEDIA_REFERENCE_PREFIX)
    .join(publicPrefix);
}

export type MediaLocation = z.infer<typeof mediaLocationSchema>;
export type MediaKind = z.infer<typeof mediaKindSchema>;
export type MediaDelivery = z.infer<typeof mediaDeliverySchema>;
export type MediaAsset = z.infer<typeof mediaAssetSchema>;
export type MediaReference = z.infer<typeof mediaReferenceSchema>;
export type MediaCollectionSummary = z.infer<
  typeof mediaCollectionSummarySchema
>;
export type MediaCollection = z.infer<typeof mediaCollectionSchema>;
export type Media = z.infer<typeof mediaSchema>;
export type MediaListQuery = z.infer<typeof mediaListQuerySchema>;
export type MediaUsageReference = z.infer<typeof mediaUsageReferenceSchema>;
export type MediaReferenceListQuery = z.infer<
  typeof mediaReferenceListQuerySchema
>;
export type CreateMediaCollectionRequest = z.output<
  typeof createMediaCollectionRequestSchema
>;
export type UpdateMediaCollectionRequest = z.output<
  typeof updateMediaCollectionRequestSchema
>;
export type BulkMoveMediaRequest = z.infer<typeof bulkMoveMediaRequestSchema>;
export type BulkMediaOperationRequest = z.infer<
  typeof bulkMediaOperationRequestSchema
>;
export type BulkMediaOperationResult = z.infer<
  typeof bulkMediaOperationResultSchema
>;
export type BulkMediaOperationData = z.infer<
  typeof bulkMediaOperationDataSchema
>;
export type CreateMediaRequest = z.output<typeof createMediaRequestSchema>;
export type UpdateMediaRequest = z.output<typeof updateMediaRequestSchema>;
export type MediaListResponse = z.infer<typeof mediaListResponseSchema>;
export type MediaReferenceListResponse = z.infer<
  typeof mediaReferenceListResponseSchema
>;
export type MediaInformationResponse = z.infer<
  typeof mediaInformationResponseSchema
>;
export type MediaCollectionListResponse = z.infer<
  typeof mediaCollectionListResponseSchema
>;
export type MediaCollectionMutationResponse = z.infer<
  typeof mediaCollectionMutationResponseSchema
>;
export type MediaCollectionDeleteResponse = z.infer<
  typeof mediaCollectionDeleteResponseSchema
>;
export type BulkMoveMediaResponse = z.infer<typeof bulkMoveMediaResponseSchema>;
export type BulkMediaOperationResponse = z.infer<
  typeof bulkMediaOperationResponseSchema
>;
export type MediaMutationResponse = z.infer<typeof mediaMutationResponseSchema>;
export type MediaDeleteResponse = z.infer<typeof mediaDeleteResponseSchema>;

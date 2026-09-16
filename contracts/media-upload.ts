import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  mediaAltInputSchema,
  mediaAltSchema,
  mediaDimensionSchema,
  mediaIdSchema,
  mediaKindSchema,
  mediaMutationSuccessSchema,
  normalizeMediaFilename,
  type MediaKind,
} from './media';

export const MANAGED_MEDIA_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;
export const MANAGED_MEDIA_SVG_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
export const MANAGED_MEDIA_UPLOAD_INTENT_TTL_SECONDS = 15 * 60;
export const MANAGED_MEDIA_UPLOAD_QUEUE_LIMIT = 10;
export const MANAGED_MEDIA_UPLOAD_CONCURRENCY = 2;
export const MANAGED_MEDIA_IMAGE_DIMENSION_MAX = 32_768;
export const MANAGED_MEDIA_IMAGE_PIXEL_MAX = 100_000_000;

export type ManagedMediaSignature =
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'avif'
  | 'mp4'
  | 'quicktime'
  | 'webm'
  | 'mp3'
  | 'aac'
  | 'ogg'
  | 'wav'
  | 'flac'
  | 'pdf'
  | 'text'
  | 'zip'
  | 'tar'
  | 'gzip'
  | 'seven_zip';

export type ManagedMediaFileDescriptor = {
  extension: string;
  kind: Exclude<MediaKind, 'other'>;
  mime_type: string;
  signature: ManagedMediaSignature;
  disposition: 'inline' | 'attachment';
};

const MANAGED_MEDIA_FILE_TYPES = {
  jpg: ['image', 'image/jpeg', 'jpeg', 'inline'],
  jpeg: ['image', 'image/jpeg', 'jpeg', 'inline'],
  png: ['image', 'image/png', 'png', 'inline'],
  gif: ['image', 'image/gif', 'gif', 'inline'],
  webp: ['image', 'image/webp', 'webp', 'inline'],
  avif: ['image', 'image/avif', 'avif', 'inline'],
  svg: ['image', 'image/svg+xml', 'text', 'inline'],
  mp4: ['video', 'video/mp4', 'mp4', 'inline'],
  webm: ['video', 'video/webm', 'webm', 'inline'],
  mov: ['video', 'video/quicktime', 'quicktime', 'inline'],
  m4v: ['video', 'video/x-m4v', 'mp4', 'inline'],
  mp3: ['audio', 'audio/mpeg', 'mp3', 'inline'],
  m4a: ['audio', 'audio/mp4', 'mp4', 'inline'],
  aac: ['audio', 'audio/aac', 'aac', 'inline'],
  ogg: ['audio', 'audio/ogg', 'ogg', 'inline'],
  wav: ['audio', 'audio/wav', 'wav', 'inline'],
  flac: ['audio', 'audio/flac', 'flac', 'inline'],
  pdf: ['document', 'application/pdf', 'pdf', 'attachment'],
  txt: ['document', 'text/plain', 'text', 'attachment'],
  csv: ['document', 'text/csv', 'text', 'attachment'],
  md: ['document', 'text/markdown', 'text', 'attachment'],
  markdown: ['document', 'text/markdown', 'text', 'attachment'],
  docx: [
    'document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'zip',
    'attachment',
  ],
  xlsx: [
    'document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'zip',
    'attachment',
  ],
  pptx: [
    'document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'zip',
    'attachment',
  ],
  odt: ['document', 'application/vnd.oasis.opendocument.text', 'zip', 'attachment'],
  ods: ['document', 'application/vnd.oasis.opendocument.spreadsheet', 'zip', 'attachment'],
  odp: ['document', 'application/vnd.oasis.opendocument.presentation', 'zip', 'attachment'],
  zip: ['archive', 'application/zip', 'zip', 'attachment'],
  tar: ['archive', 'application/x-tar', 'tar', 'attachment'],
  gz: ['archive', 'application/gzip', 'gzip', 'attachment'],
  tgz: ['archive', 'application/gzip', 'gzip', 'attachment'],
  '7z': ['archive', 'application/x-7z-compressed', 'seven_zip', 'attachment'],
} as const satisfies Record<
  string,
  readonly [
    Exclude<MediaKind, 'other'>,
    string,
    ManagedMediaSignature,
    'inline' | 'attachment',
  ]
>;

export const managedMediaUploadExtensions = Object.freeze(
  Object.keys(MANAGED_MEDIA_FILE_TYPES),
);

export function resolveManagedMediaFileDescriptor(
  filename: string,
): ManagedMediaFileDescriptor | null {
  const normalized = normalizeMediaFilename(filename);
  if (!normalized) return null;
  const dot = normalized.lastIndexOf('.');
  if (dot <= 0 || dot === normalized.length - 1) return null;
  const sourceExtension = normalized.slice(dot + 1).toLowerCase();
  const descriptor = MANAGED_MEDIA_FILE_TYPES[
    sourceExtension as keyof typeof MANAGED_MEDIA_FILE_TYPES
  ];
  if (!descriptor) return null;
  const [kind, mimeType, signature, disposition] = descriptor;
  return {
    extension: sourceExtension === 'jpeg' ? 'jpg' : sourceExtension,
    kind,
    mime_type: mimeType,
    signature,
    disposition,
  };
}

function validateUploadMetadata(
  value: {
    filename: string;
    size_bytes: number;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
    alt: string;
  },
  context: z.core.$RefinementCtx,
) {
  const descriptor = resolveManagedMediaFileDescriptor(value.filename);
  if (!descriptor) {
    context.addIssue({
      code: 'custom',
      path: ['filename'],
      message: 'The filename extension is not allowed for managed uploads.',
    });
    return;
  }
  if ((value.width === null) !== (value.height === null)) {
    context.addIssue({
      code: 'custom',
      path: ['width'],
      message: 'Media width and height must both be present or both be null.',
    });
  }
  if (descriptor.kind === 'image') {
    if (value.width === null || value.height === null) {
      context.addIssue({
        code: 'custom',
        path: ['width'],
        message: 'Managed images require browser-decoded dimensions.',
      });
    } else if (
      value.width > MANAGED_MEDIA_IMAGE_DIMENSION_MAX
      || value.height > MANAGED_MEDIA_IMAGE_DIMENSION_MAX
      || value.width * value.height > MANAGED_MEDIA_IMAGE_PIXEL_MAX
    ) {
      context.addIssue({
        code: 'custom',
        path: ['width'],
        message: 'Managed image dimensions exceed the supported limit.',
      });
    }
  } else if (descriptor.kind !== 'video' && value.width !== null) {
    context.addIssue({
      code: 'custom',
      path: ['width'],
      message: 'Only image and video uploads may have dimensions.',
    });
  }
  if (
    descriptor.kind !== 'audio'
    && descriptor.kind !== 'video'
    && value.duration_ms !== null
  ) {
    context.addIssue({
      code: 'custom',
      path: ['duration_ms'],
      message: 'Only audio and video uploads may have a duration.',
    });
  }
  if (descriptor.kind !== 'image' && value.alt !== '') {
    context.addIssue({
      code: 'custom',
      path: ['alt'],
      message: 'Only image uploads may have alternative text.',
    });
  }
  if (
    descriptor.mime_type === 'image/svg+xml'
    && value.size_bytes > MANAGED_MEDIA_SVG_UPLOAD_MAX_BYTES
  ) {
    context.addIssue({
      code: 'custom',
      path: ['size_bytes'],
      message: 'Managed SVG source must not exceed the sanitizer input limit.',
    });
  }
}

export const createManagedMediaUploadRequestSchema = z.object({
  filename: z.string().transform((value, context) => {
    const normalized = normalizeMediaFilename(value);
    if (!normalized) {
      context.addIssue({ code: 'custom', message: 'Invalid upload filename.' });
      return z.NEVER;
    }
    return normalized;
  }),
  size_bytes: z.number().int().min(1).max(MANAGED_MEDIA_UPLOAD_MAX_BYTES),
  width: mediaDimensionSchema.nullable(),
  height: mediaDimensionSchema.nullable(),
  duration_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  alt: mediaAltInputSchema,
}).strict().superRefine(validateUploadMetadata);

const managedUploadFileSchema = z.object({
  filename: z.string().refine((value) => normalizeMediaFilename(value) === value),
  kind: mediaKindSchema.exclude(['other']),
  mime_type: z.string(),
  size_bytes: z.number().int().min(1).max(MANAGED_MEDIA_UPLOAD_MAX_BYTES),
  width: mediaDimensionSchema.nullable(),
  height: mediaDimensionSchema.nullable(),
  duration_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  alt: mediaAltSchema,
}).strict();

export const managedMediaUploadPolicySuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    available: z.boolean(),
    unavailable_reason: z.enum(['binding_missing', 'shared_development']).nullable(),
    max_bytes: z.literal(MANAGED_MEDIA_UPLOAD_MAX_BYTES),
    max_svg_bytes: z.literal(MANAGED_MEDIA_SVG_UPLOAD_MAX_BYTES),
    max_files: z.literal(MANAGED_MEDIA_UPLOAD_QUEUE_LIMIT),
    concurrency: z.literal(MANAGED_MEDIA_UPLOAD_CONCURRENCY),
    accepted_extensions: z.array(z.string()).min(1),
  }).strict(),
}).strict();

export const managedMediaUploadPolicyResponseSchema = z.union([
  managedMediaUploadPolicySuccessSchema,
  apiErrorSchema,
]);

export const managedMediaUploadIntentSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    upload_id: mediaIdSchema,
    expires_at_iso: z.iso.datetime({ offset: true }),
    file: managedUploadFileSchema,
  }).strict(),
}).strict();

export const managedMediaUploadIntentResponseSchema = z.union([
  managedMediaUploadIntentSuccessSchema,
  apiErrorSchema,
]);

export const managedMediaUploadResponseSchema = z.union([
  mediaMutationSuccessSchema,
  apiErrorSchema,
]);

export const managedMediaUploadCancelSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('upload_cancelled'),
    upload_id: mediaIdSchema,
  }).strict(),
}).strict();

export const managedMediaUploadCancelResponseSchema = z.union([
  managedMediaUploadCancelSuccessSchema,
  apiErrorSchema,
]);

export type CreateManagedMediaUploadRequest = z.output<
  typeof createManagedMediaUploadRequestSchema
>;
export type ManagedMediaUploadPolicyResponse = z.infer<
  typeof managedMediaUploadPolicyResponseSchema
>;
export type ManagedMediaUploadIntentResponse = z.infer<
  typeof managedMediaUploadIntentResponseSchema
>;
export type ManagedMediaUploadResponse = z.infer<
  typeof managedMediaUploadResponseSchema
>;
export type ManagedMediaUploadCancelResponse = z.infer<
  typeof managedMediaUploadCancelResponseSchema
>;

export function managedMediaUploadAcceptValue(): string {
  return managedMediaUploadExtensions.map((extension) => `.${extension}`).join(',');
}

export function isManagedImageMetadataWithinPolicy(input: {
  width: number;
  height: number;
}): boolean {
  return input.width >= 1
    && input.height >= 1
    && input.width <= MANAGED_MEDIA_IMAGE_DIMENSION_MAX
    && input.height <= MANAGED_MEDIA_IMAGE_DIMENSION_MAX
    && input.width * input.height <= MANAGED_MEDIA_IMAGE_PIXEL_MAX;
}

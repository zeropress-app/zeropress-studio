import { z } from 'zod';
import { apiErrorSchema } from './api';
import { normalizeSiteOrigin } from './general-settings';
import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from './settings-revision';

export const MEDIA_SETTINGS_INITIAL_REVISION = SETTINGS_INITIAL_REVISION;
export const MEDIA_DELIVERY_MODES = ['none', 'media_domain'] as const;

function normalizedOrigin(value: string, context: z.RefinementCtx): string {
  const normalized = normalizeSiteOrigin(value);
  if (normalized === null) {
    context.addIssue({
      code: 'custom',
      message: 'Expected an empty string or a canonical HTTP(S) origin',
    });
    return z.NEVER;
  }
  return normalized;
}

function canonicalOrigin(value: string, context: z.RefinementCtx): void {
  if (normalizeSiteOrigin(value) !== value) {
    context.addIssue({
      code: 'custom',
      message: 'Expected an empty string or a canonical HTTP(S) origin',
    });
  }
}

const mediaSettingsInputFields = z.object({
  media_origin: z.string().transform(normalizedOrigin),
  media_delivery_mode: z.enum(MEDIA_DELIVERY_MODES),
}).strict();

export const mediaOriginSchema = z.string().superRefine(canonicalOrigin);

const mediaSettingsFields = z.object({
  media_origin: mediaOriginSchema,
  media_delivery_mode: z.enum(MEDIA_DELIVERY_MODES),
}).strict();

function requireMediaOrigin(
  value: { media_origin: string; media_delivery_mode: string },
  context: z.RefinementCtx,
) {
  if (value.media_delivery_mode === 'media_domain' && value.media_origin === '') {
    context.addIssue({
      code: 'custom',
      path: ['media_origin'],
      message: 'media_origin is required for media_domain delivery',
    });
  }
}

export const mediaSettingsInputSchema = mediaSettingsInputFields
  .superRefine(requireMediaOrigin);
export const mediaSettingsSchema = mediaSettingsFields
  .superRefine(requireMediaOrigin);

export type MediaSettings = z.infer<typeof mediaSettingsSchema>;

export const MEDIA_SETTINGS_DEFAULTS: Readonly<MediaSettings> = Object.freeze({
  media_origin: '',
  media_delivery_mode: 'none',
});

export function materializeMediaSettingsDefaults(): MediaSettings {
  return { ...MEDIA_SETTINGS_DEFAULTS };
}

export const updateMediaSettingsRequestSchema = z.object({
  settings: mediaSettingsInputSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

export const mediaSettingsDocumentSchema = z.object({
  settings: mediaSettingsSchema,
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const mediaSettingsSuccessSchema = z.object({
  success: z.literal(true),
  data: mediaSettingsDocumentSchema,
}).strict();

export const mediaSettingsResponseSchema = z.union([
  mediaSettingsSuccessSchema,
  apiErrorSchema,
]);

export type UpdateMediaSettingsRequest = z.input<
  typeof updateMediaSettingsRequestSchema
>;
export type MediaSettingsSuccess = z.infer<typeof mediaSettingsSuccessSchema>;
export type MediaSettingsResponse = z.infer<typeof mediaSettingsResponseSchema>;

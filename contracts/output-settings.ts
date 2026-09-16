import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from './settings-revision';

export const OUTPUT_SETTINGS_INITIAL_REVISION = SETTINGS_INITIAL_REVISION;

export const PREVIEW_DATETIME_STYLES = [
  'none',
  'short',
  'medium',
  'long',
  'full',
] as const;

const featureStateSchema = z.object({
  enabled: z.boolean(),
}).strict();

const robotsSettingsSchema = z.object({
  allow_indexing: z.boolean(),
}).strict();

const footerInputSchema = z.object({
  copyright_text: z.string().optional(),
  attribution: z.boolean(),
}).strict().transform((value) => {
  const copyrightText = value.copyright_text?.trim() ?? '';
  return {
    ...(copyrightText ? { copyright_text: copyrightText } : {}),
    attribution: value.attribution,
  };
});

const footerSchema = z.object({
  copyright_text: z.string()
    .min(1)
    .refine((value) => value.trim() === value)
    .optional(),
  attribution: z.boolean(),
}).strict();

export const outputSettingsSchema = z.object({
  expose_generator: z.boolean(),
  search: featureStateSchema,
  feed: featureStateSchema,
  archive: featureStateSchema,
  posts_per_page: z.number().int().min(1),
  date_style: z.enum(PREVIEW_DATETIME_STYLES),
  time_style: z.enum(PREVIEW_DATETIME_STYLES),
  footer: footerSchema,
  robots: robotsSettingsSchema,
}).strict();

export const outputSettingsInputSchema = z.object({
  expose_generator: z.boolean(),
  search: featureStateSchema,
  feed: featureStateSchema,
  archive: featureStateSchema,
  posts_per_page: z.number().int().min(1),
  date_style: z.enum(PREVIEW_DATETIME_STYLES),
  time_style: z.enum(PREVIEW_DATETIME_STYLES),
  footer: footerInputSchema,
  robots: robotsSettingsSchema,
}).strict();

export type OutputSettings = z.infer<typeof outputSettingsSchema>;

export const OUTPUT_SETTINGS_DEFAULTS: Readonly<OutputSettings> = Object.freeze({
  expose_generator: true,
  search: Object.freeze({ enabled: true }),
  feed: Object.freeze({ enabled: true }),
  archive: Object.freeze({ enabled: true }),
  posts_per_page: 10,
  date_style: 'medium',
  time_style: 'none',
  footer: Object.freeze({ attribution: true }),
  robots: Object.freeze({ allow_indexing: false }),
});

export function materializeOutputSettingsDefaults(): OutputSettings {
  return {
    expose_generator: OUTPUT_SETTINGS_DEFAULTS.expose_generator,
    search: { ...OUTPUT_SETTINGS_DEFAULTS.search },
    feed: { ...OUTPUT_SETTINGS_DEFAULTS.feed },
    archive: { ...OUTPUT_SETTINGS_DEFAULTS.archive },
    posts_per_page: OUTPUT_SETTINGS_DEFAULTS.posts_per_page,
    date_style: OUTPUT_SETTINGS_DEFAULTS.date_style,
    time_style: OUTPUT_SETTINGS_DEFAULTS.time_style,
    footer: { ...OUTPUT_SETTINGS_DEFAULTS.footer },
    robots: { ...OUTPUT_SETTINGS_DEFAULTS.robots },
  };
}

export const updateOutputSettingsRequestSchema = z.object({
  settings: outputSettingsInputSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

export const outputSettingsDocumentSchema = z.object({
  settings: outputSettingsSchema,
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const outputSettingsSuccessSchema = z.object({
  success: z.literal(true),
  data: outputSettingsDocumentSchema,
}).strict();

export const outputSettingsResponseSchema = z.union([
  outputSettingsSuccessSchema,
  apiErrorSchema,
]);

export type UpdateOutputSettingsRequest = z.infer<
  typeof updateOutputSettingsRequestSchema
>;
export type OutputSettingsSuccess = z.infer<
  typeof outputSettingsSuccessSchema
>;
export type OutputSettingsResponse = z.infer<
  typeof outputSettingsResponseSchema
>;

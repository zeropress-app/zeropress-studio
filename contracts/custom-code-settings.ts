import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from './settings-revision';

export const CUSTOM_CODE_SETTINGS_INITIAL_REVISION = SETTINGS_INITIAL_REVISION;
export const CUSTOM_HTML_SLOT_MAX_CODE_POINTS = 65_536;
export const CUSTOM_CODE_SETTINGS_BODY_LIMIT_BYTES = 1024 * 1024;

function codePointLength(value: string): number {
  return [...value].length;
}

const sourceSchema = z.string();
const htmlSourceSchema = sourceSchema.refine(
  (value) => codePointLength(value) <= CUSTOM_HTML_SLOT_MAX_CODE_POINTS,
  `Custom HTML slots may contain at most ${CUSTOM_HTML_SLOT_MAX_CODE_POINTS} Unicode code points.`,
);

const customCssSettingsSchema = z.object({
  enabled: z.boolean(),
  content: sourceSchema,
}).strict();

const customHtmlSlotSettingsSchema = z.object({
  enabled: z.boolean(),
  content: htmlSourceSchema,
}).strict();

const customHtmlSettingsSchema = z.object({
  head_end: customHtmlSlotSettingsSchema,
  body_end: customHtmlSlotSettingsSchema,
}).strict();

export const customCodeSettingsSchema = z.object({
  custom_css: customCssSettingsSchema,
  custom_html: customHtmlSettingsSchema,
}).strict();

export type CustomCodeSettings = z.infer<typeof customCodeSettingsSchema>;

export const CUSTOM_CODE_SETTINGS_DEFAULTS: Readonly<CustomCodeSettings> =
  Object.freeze({
    custom_css: Object.freeze({ enabled: false, content: '' }),
    custom_html: Object.freeze({
      head_end: Object.freeze({ enabled: false, content: '' }),
      body_end: Object.freeze({ enabled: false, content: '' }),
    }),
  });

export function materializeCustomCodeSettingsDefaults(): CustomCodeSettings {
  return {
    custom_css: { ...CUSTOM_CODE_SETTINGS_DEFAULTS.custom_css },
    custom_html: {
      head_end: { ...CUSTOM_CODE_SETTINGS_DEFAULTS.custom_html.head_end },
      body_end: { ...CUSTOM_CODE_SETTINGS_DEFAULTS.custom_html.body_end },
    },
  };
}

export const customCodeSettingsDocumentSchema = z.object({
  settings: customCodeSettingsSchema,
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const updateCustomCodeSettingsRequestSchema = z.object({
  settings: customCodeSettingsSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

export const customCodeSettingsSuccessSchema = z.object({
  success: z.literal(true),
  data: customCodeSettingsDocumentSchema,
}).strict();

export const customCodeSettingsResponseSchema = z.union([
  customCodeSettingsSuccessSchema,
  apiErrorSchema,
]);

export type CustomCodeSettingsDocument = z.infer<
  typeof customCodeSettingsDocumentSchema
>;
export type CustomCodeSettingsResponse = z.infer<
  typeof customCodeSettingsResponseSchema
>;
export type UpdateCustomCodeSettingsRequest = z.infer<
  typeof updateCustomCodeSettingsRequestSchema
>;

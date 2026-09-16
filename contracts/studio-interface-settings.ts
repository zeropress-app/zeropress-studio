import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from './settings-revision';

/**
 * Locales whose complete client message catalog ships with this Studio build.
 *
 * This registry is deliberately a code contract: D1 may enable only a subset
 * of these values, but it cannot make a locale available before its resources
 * are part of the deployed bundle.
 */
export const SUPPORTED_INTERFACE_LOCALES = ['en', 'ko'] as const;
export const FALLBACK_INTERFACE_LOCALE = 'en' as const;
export const STUDIO_INTERFACE_SETTINGS_INITIAL_REVISION =
  SETTINGS_INITIAL_REVISION;

export const interfaceLocaleSchema = z.enum(
  SUPPORTED_INTERFACE_LOCALES,
);

const enabledInterfaceLocalesSchema = z.array(interfaceLocaleSchema)
  .min(1)
  .max(SUPPORTED_INTERFACE_LOCALES.length)
  .superRefine((locales, context) => {
    if (new Set(locales).size !== locales.length) {
      context.addIssue({
        code: 'custom',
        message: 'Expected unique enabled interface locales',
      });
    }
  })
  .transform((locales) => SUPPORTED_INTERFACE_LOCALES.filter(
    (locale) => locales.includes(locale),
  ));

export const studioInterfaceSettingsSchema = z.object({
  default_locale: interfaceLocaleSchema,
  enabled_locales: enabledInterfaceLocalesSchema,
}).strict().superRefine((settings, context) => {
  if (!settings.enabled_locales.includes(settings.default_locale)) {
    context.addIssue({
      code: 'custom',
      path: ['default_locale'],
      message: 'Default interface locale must be enabled',
    });
  }
});

export const studioInterfaceSettingsDocumentSchema = z.object({
  settings: studioInterfaceSettingsSchema,
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const updateStudioInterfaceSettingsRequestSchema = z.object({
  settings: studioInterfaceSettingsSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

export const studioInterfaceSettingsSuccessSchema = z.object({
  success: z.literal(true),
  data: studioInterfaceSettingsDocumentSchema,
}).strict();

export const studioInterfaceSettingsResponseSchema = z.union([
  studioInterfaceSettingsSuccessSchema,
  apiErrorSchema,
]);

export const publicInterfaceConfigSuccessSchema = z.object({
  success: z.literal(true),
  data: studioInterfaceSettingsSchema,
}).strict();

export const publicInterfaceConfigResponseSchema = z.union([
  publicInterfaceConfigSuccessSchema,
  apiErrorSchema,
]);

export type InterfaceLocale = z.infer<typeof interfaceLocaleSchema>;
export type StudioInterfaceSettings = z.output<
  typeof studioInterfaceSettingsSchema
>;
export type StudioInterfaceSettingsDocument = z.infer<
  typeof studioInterfaceSettingsDocumentSchema
>;
export type UpdateStudioInterfaceSettingsRequest = z.input<
  typeof updateStudioInterfaceSettingsRequestSchema
>;
export type StudioInterfaceSettingsResponse = z.infer<
  typeof studioInterfaceSettingsResponseSchema
>;
export type PublicInterfaceConfigResponse = z.infer<
  typeof publicInterfaceConfigResponseSchema
>;

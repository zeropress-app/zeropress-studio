import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  externalMediaUrlSchema,
  mediaBrandingSlots,
  mediaFilenameSchema,
  mediaIdSchema,
  mediaLocationSchema,
  mediaMimeTypeSchema,
  privateMediaPreviewUrlSchema,
} from './media';
import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from './settings-revision';

export const BRANDING_SETTINGS_INITIAL_REVISION = SETTINGS_INITIAL_REVISION;
export const SITE_LOGO_ALT_MAX_CODE_POINTS = 500;
export const siteBrandingSlots = mediaBrandingSlots;

function codePointLength(value: string): number {
  return [...value].length;
}

const logoAltInputSchema = z.string().trim().refine(
  (value) => codePointLength(value) <= SITE_LOGO_ALT_MAX_CODE_POINTS,
);
const logoAltSchema = z.string()
  .refine((value) => value === value.trim())
  .refine((value) => codePointLength(value) <= SITE_LOGO_ALT_MAX_CODE_POINTS);

const faviconSelectionSchema = z.object({
  icon_media_id: mediaIdSchema.nullable(),
  icon_dark_media_id: mediaIdSchema.nullable(),
  apple_touch_icon_media_id: mediaIdSchema.nullable(),
}).strict();

function validateLogoSelection(
  value: { media_id: string | null; alt: string },
  context: z.RefinementCtx,
) {
  if (value.media_id === null && value.alt !== '') {
    context.addIssue({
      code: 'custom',
      path: ['alt'],
      message: 'Logo alternative text requires a selected logo.',
    });
  }
}

const logoSelectionInputSchema = z.object({
  media_id: mediaIdSchema.nullable(),
  alt: logoAltInputSchema,
}).strict().superRefine(validateLogoSelection);
const logoSelectionSchema = z.object({
  media_id: mediaIdSchema.nullable(),
  alt: logoAltSchema,
}).strict().superRefine(validateLogoSelection);

export const siteBrandingSettingsInputSchema = z.object({
  favicon: faviconSelectionSchema,
  logo: logoSelectionInputSchema,
}).strict();

export const siteBrandingSettingsSchema = z.object({
  favicon: faviconSelectionSchema,
  logo: logoSelectionSchema,
}).strict();

export type SiteBrandingSettings = z.infer<typeof siteBrandingSettingsSchema>;

export const SITE_BRANDING_SETTINGS_DEFAULTS: Readonly<SiteBrandingSettings> =
  Object.freeze({
    favicon: Object.freeze({
      icon_media_id: null,
      icon_dark_media_id: null,
      apple_touch_icon_media_id: null,
    }),
    logo: Object.freeze({ media_id: null, alt: '' }),
  });

export function materializeSiteBrandingSettingsDefaults(): SiteBrandingSettings {
  return {
    favicon: { ...SITE_BRANDING_SETTINGS_DEFAULTS.favicon },
    logo: { ...SITE_BRANDING_SETTINGS_DEFAULTS.logo },
  };
}

export const brandingMediaFormatSchema = z.enum([
  'ico',
  'png',
  'svg',
  'other_image',
]);

export const brandingMediaAssetSchema = z.object({
  id: mediaIdSchema,
  filename: mediaFilenameSchema,
  mime_type: mediaMimeTypeSchema.refine((value) => value.startsWith('image/')),
  location: mediaLocationSchema,
  format: brandingMediaFormatSchema,
  preview_url: z.union([
    externalMediaUrlSchema,
    privateMediaPreviewUrlSchema,
  ]).nullable(),
}).strict();

const selectedBrandingAssetsSchema = z.object({
  icon: brandingMediaAssetSchema.nullable(),
  icon_dark: brandingMediaAssetSchema.nullable(),
  apple_touch_icon: brandingMediaAssetSchema.nullable(),
  logo: brandingMediaAssetSchema.nullable(),
}).strict();

export const siteBrandingDocumentSchema = z.object({
  settings: siteBrandingSettingsSchema,
  selected_assets: selectedBrandingAssetsSchema,
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict().superRefine((value, context) => {
  const identities = [
    [value.settings.favicon.icon_media_id, 'icon'] as const,
    [value.settings.favicon.icon_dark_media_id, 'icon_dark'] as const,
    [
      value.settings.favicon.apple_touch_icon_media_id,
      'apple_touch_icon',
    ] as const,
    [value.settings.logo.media_id, 'logo'] as const,
  ];
  for (const [selectedId, assetKey] of identities) {
    const assetId = value.selected_assets[assetKey]?.id ?? null;
    if (selectedId !== assetId) {
      context.addIssue({
        code: 'custom',
        path: ['selected_assets', assetKey],
        message: 'Selected branding asset does not match its stored identity.',
      });
    }
  }
});

export const updateSiteBrandingRequestSchema = z.object({
  settings: siteBrandingSettingsInputSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

export const siteBrandingSuccessSchema = z.object({
  success: z.literal(true),
  data: siteBrandingDocumentSchema,
}).strict();

export const siteBrandingResponseSchema = z.union([
  siteBrandingSuccessSchema,
  apiErrorSchema,
]);

export type BrandingMediaFormat = z.infer<typeof brandingMediaFormatSchema>;
export type BrandingMediaAsset = z.infer<typeof brandingMediaAssetSchema>;
export type SiteBrandingDocument = z.infer<typeof siteBrandingDocumentSchema>;
export type SiteBrandingResponse = z.infer<typeof siteBrandingResponseSchema>;
export type UpdateSiteBrandingRequest = z.input<
  typeof updateSiteBrandingRequestSchema
>;

import { describe, expect, it } from 'vitest';
import {
  brandingMediaAssetSchema,
  materializeSiteBrandingSettingsDefaults,
  siteBrandingSettingsInputSchema,
  updateSiteBrandingRequestSchema,
} from './branding-settings';

const MEDIA_ID = '1'.repeat(32);

describe('Site Branding contracts', () => {
  it('materializes an automatic favicon and theme-controlled logo by default', () => {
    expect(materializeSiteBrandingSettingsDefaults()).toEqual({
      favicon: {
        icon_media_id: null,
        icon_dark_media_id: null,
        apple_touch_icon_media_id: null,
      },
      logo: { media_id: null, alt: '' },
    });
  });

  it('normalizes logo alt text and rejects alt without a logo', () => {
    expect(siteBrandingSettingsInputSchema.parse({
      favicon: {
        icon_media_id: MEDIA_ID,
        icon_dark_media_id: null,
        apple_touch_icon_media_id: null,
      },
      logo: { media_id: MEDIA_ID, alt: '  Example Site  ' },
    }).logo.alt).toBe('Example Site');
    expect(siteBrandingSettingsInputSchema.safeParse({
      ...materializeSiteBrandingSettingsDefaults(),
      logo: { media_id: null, alt: 'Example Site' },
    }).success).toBe(false);
    expect(siteBrandingSettingsInputSchema.safeParse({
      ...materializeSiteBrandingSettingsDefaults(),
      logo: { media_id: MEDIA_ID, alt: '🙂'.repeat(500) },
    }).success).toBe(true);
    expect(siteBrandingSettingsInputSchema.safeParse({
      ...materializeSiteBrandingSettingsDefaults(),
      logo: { media_id: MEDIA_ID, alt: '🙂'.repeat(501) },
    }).success).toBe(false);
  });

  it('requires a complete closed revision-bound update', () => {
    expect(updateSiteBrandingRequestSchema.safeParse({
      settings: materializeSiteBrandingSettingsDefaults(),
      expected_revision: '0'.repeat(32),
    }).success).toBe(true);
    expect(updateSiteBrandingRequestSchema.safeParse({
      settings: { logo: { media_id: null, alt: '' } },
      expected_revision: '0'.repeat(32),
    }).success).toBe(false);
    expect(updateSiteBrandingRequestSchema.safeParse({
      settings: materializeSiteBrandingSettingsDefaults(),
      expected_revision: '0'.repeat(32),
      legacy_logo_url: '/logo.svg',
    }).success).toBe(false);
  });

  it('accepts public, authenticated private, and unavailable previews', () => {
    const asset = {
      id: MEDIA_ID,
      filename: 'logo.png',
      mime_type: 'image/png',
      location: { type: 'r2', key: 'uploads/2026/08/logo.png' },
      format: 'png',
    } as const;
    expect(brandingMediaAssetSchema.safeParse({
      ...asset,
      preview_url: `/api/media/${MEDIA_ID}/preview?revision=${'2'.repeat(32)}`,
    }).success).toBe(true);
    expect(brandingMediaAssetSchema.safeParse({
      ...asset,
      preview_url: null,
    }).success).toBe(true);
    expect(brandingMediaAssetSchema.safeParse({
      ...asset,
      preview_url: '/uploads/2026/08/logo.png',
    }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  materializeMediaSettingsDefaults,
  mediaSettingsInputSchema,
  mediaSettingsSchema,
} from './media-settings';

describe('Media settings contract', () => {
  it('materializes a transport-neutral default without shared references', () => {
    const first = materializeMediaSettingsDefaults();
    const second = materializeMediaSettingsDefaults();
    expect(first).toEqual({
      media_origin: '',
      media_delivery_mode: 'none',
    });
    expect(first).not.toBe(second);
  });

  it('canonicalizes an origin and requires one for media-domain delivery', () => {
    expect(mediaSettingsInputSchema.parse({
      media_origin: 'https://MEDIA.example:443/',
      media_delivery_mode: 'media_domain',
    })).toEqual({
      media_origin: 'https://media.example',
      media_delivery_mode: 'media_domain',
    });
    expect(mediaSettingsInputSchema.safeParse({
      media_origin: '',
      media_delivery_mode: 'media_domain',
    }).success).toBe(false);
    expect(mediaSettingsSchema.safeParse({
      media_origin: 'https://media.example/',
      media_delivery_mode: 'none',
    }).success).toBe(false);
  });

  it('rejects paths, credentials, and unknown settings', () => {
    for (const media_origin of [
      'https://media.example/imported',
      'https://user:password@media.example',
      'https://media.example?variant=webp',
    ]) {
      expect(mediaSettingsInputSchema.safeParse({
        media_origin,
        media_delivery_mode: 'none',
      }).success, media_origin).toBe(false);
    }
    expect(mediaSettingsInputSchema.safeParse({
      media_origin: '',
      media_delivery_mode: 'none',
      extra: true,
    }).success).toBe(false);
  });
});

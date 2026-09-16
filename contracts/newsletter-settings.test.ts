import { describe, expect, it } from 'vitest';
import {
  materializeNewsletterSettingsDefaults,
  normalizeNewsletterNavigationUrl,
  updateNewsletterSettingsRequestSchema,
} from './newsletter-settings';

describe('Newsletter CTA settings contract', () => {
  it('materializes a disabled editable draft', () => {
    expect(materializeNewsletterSettingsDefaults()).toEqual({
      enabled: false,
      title: '',
      description: '',
      button_label: 'Subscribe',
      signup_url: '',
      embed_url: '',
    });
  });

  it('normalizes text and requires a destination only when enabled', () => {
    expect(updateNewsletterSettingsRequestSchema.parse({
      settings: {
        enabled: true,
        title: '  Updates  ',
        description: '  Monthly notes. ',
        button_label: ' Join ',
        signup_url: 'https://example.com/signup?source=studio#form',
        embed_url: '',
      },
      expected_revision: '0'.repeat(32),
    }).settings).toEqual({
      enabled: true,
      title: 'Updates',
      description: 'Monthly notes.',
      button_label: 'Join',
      signup_url: 'https://example.com/signup?source=studio#form',
      embed_url: '',
    });

    expect(updateNewsletterSettingsRequestSchema.safeParse({
      settings: {
        ...materializeNewsletterSettingsDefaults(),
        enabled: true,
      },
      expected_revision: '0'.repeat(32),
    }).success).toBe(false);
  });

  it('matches Preview Data navigation URL safety', () => {
    expect(normalizeNewsletterNavigationUrl('/newsletter?source=site'))
      .toBe('/newsletter?source=site');
    expect(normalizeNewsletterNavigationUrl('https://example.com/form'))
      .toBe('https://example.com/form');
    for (const unsafe of [
      '//example.com/form',
      '../form',
      '/a/../form',
      '/a/%2e%2e/form',
      'https://user:pass@example.com/form',
      'https:example.com/form',
      'https://example.com/bad path',
      'https://example.com/%',
    ]) {
      expect(normalizeNewsletterNavigationUrl(unsafe)).toBeNull();
    }
  });
});

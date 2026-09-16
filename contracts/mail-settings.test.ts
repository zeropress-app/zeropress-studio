import { describe, expect, it } from 'vitest';
import {
  materializeMailSettingsDefaults,
  testMailConnectionRequestSchema,
  updateMailSettingsRequestSchema,
} from './mail-settings';

describe('mail settings contract', () => {
  it('keeps disabled defaults independent from provider credentials', () => {
    expect(materializeMailSettingsDefaults()).toEqual({
      provider: 'disabled',
      from_email: '',
      from_name: '',
      cloudflare_account_id: '',
    });
  });

  it('normalizes provider settings and uses explicit credential mutations', () => {
    const parsed = updateMailSettingsRequestSchema.parse({
      settings: {
        provider: 'cloudflare',
        from_email: ' Mail@Example.COM ',
        from_name: ' ZeroPress ',
        cloudflare_account_id: 'A'.repeat(32),
      },
      credentials: {
        resend_api_key: { action: 'preserve' },
        cloudflare_api_token: { action: 'replace', value: 'token-value' },
      },
      expected_revision: '0'.repeat(32),
    });
    expect(parsed.settings).toEqual({
      provider: 'cloudflare',
      from_email: 'mail@example.com',
      from_name: 'ZeroPress',
      cloudflare_account_id: 'a'.repeat(32),
    });
  });

  it('requires enabled providers to have sender and provider identifiers', () => {
    expect(updateMailSettingsRequestSchema.safeParse({
      settings: {
        provider: 'resend',
        from_email: '',
        from_name: '',
        cloudflare_account_id: '',
      },
      credentials: {
        resend_api_key: { action: 'preserve' },
        cloudflare_api_token: { action: 'preserve' },
      },
      expected_revision: '0'.repeat(32),
    }).success).toBe(false);
  });

  it('accepts stored-credential and unsaved-credential connection tests', () => {
    expect(testMailConnectionRequestSchema.safeParse({
      provider: 'resend',
    }).success).toBe(true);
    expect(testMailConnectionRequestSchema.safeParse({
      provider: 'cloudflare',
      cloudflare_account_id: 'f'.repeat(32),
      credential: 'new-token',
    }).success).toBe(true);
  });
});

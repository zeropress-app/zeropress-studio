import { describe, expect, it } from 'vitest';
import {
  EDGE_SECURITY_SETTINGS_DEFAULTS,
  edgeSecuritySettingsInputSchema,
  edgeSecuritySettingsSchema,
} from './edge-security-settings';

describe('Edge public request security contract', () => {
  it('accepts the safe Proof-of-Work defaults', () => {
    expect(edgeSecuritySettingsSchema.parse(
      EDGE_SECURITY_SETTINGS_DEFAULTS,
    )).toEqual(EDGE_SECURITY_SETTINGS_DEFAULTS);
  });

  it('normalizes the public sitekey and requires it for Turnstile', () => {
    expect(edgeSecuritySettingsInputSchema.parse({
      ...EDGE_SECURITY_SETTINGS_DEFAULTS,
      comment_write_verification_mode: 'turnstile',
      turnstile_sitekey: ' 0x4AAAAA-test ',
    }).turnstile_sitekey).toBe('0x4AAAAA-test');
    expect(edgeSecuritySettingsInputSchema.safeParse({
      ...EDGE_SECURITY_SETTINGS_DEFAULTS,
      newsletter_subscribe_verification_mode: 'turnstile',
    }).success).toBe(false);
    expect(edgeSecuritySettingsInputSchema.parse({
      ...EDGE_SECURITY_SETTINGS_DEFAULTS,
      turnstile_sitekey: '   ',
    }).turnstile_sitekey).toBeNull();
  });

  it('rejects unknown modes, unbounded values, and extra fields', () => {
    expect(edgeSecuritySettingsInputSchema.safeParse({
      ...EDGE_SECURITY_SETTINGS_DEFAULTS,
      form_submit_verification_mode: 'pow_and_turnstile',
    }).success).toBe(false);
    expect(edgeSecuritySettingsInputSchema.safeParse({
      ...EDGE_SECURITY_SETTINGS_DEFAULTS,
      turnstile_sitekey: 'x'.repeat(257),
    }).success).toBe(false);
    expect(edgeSecuritySettingsInputSchema.safeParse({
      ...EDGE_SECURITY_SETTINGS_DEFAULTS,
      ip_address_retention_days: 0,
    }).success).toBe(false);
    expect(edgeSecuritySettingsInputSchema.safeParse({
      ...EDGE_SECURITY_SETTINGS_DEFAULTS,
      ip_address_retention_days: 366,
    }).success).toBe(false);
    expect(edgeSecuritySettingsInputSchema.safeParse({
      ...EDGE_SECURITY_SETTINGS_DEFAULTS,
      turnstile_secret_key: 'must-never-enter-this-contract',
    }).success).toBe(false);
  });

  it('requires stored sitekeys to already be canonical', () => {
    expect(edgeSecuritySettingsSchema.safeParse({
      ...EDGE_SECURITY_SETTINGS_DEFAULTS,
      turnstile_sitekey: ' 0x4AAAAA-test ',
    }).success).toBe(false);
  });
});

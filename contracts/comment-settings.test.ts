import { describe, expect, it } from 'vitest';
import {
  areCommentSettingsEqual,
  COMMENT_SETTINGS_DEFAULTS,
  commentRequestSecurityMutationRequestSchema,
  commentRequestSecurityResourceSchema,
  commentSettingsInputSchema,
  commentSettingsSchema,
  normalizeCommentApiBaseUrl,
  normalizeSupabaseProjectUrl,
  normalizeSupabasePublishableKey,
} from './comment-settings';

const PUBLISHABLE_KEY =
  'sb_publishable_example-key-with-enough-length';

describe('comment settings contract', () => {
  it('normalizes safe absolute and root-relative API bases', () => {
    expect(normalizeCommentApiBaseUrl('https://edge.example.com/api/'))
      .toBe('https://edge.example.com/api');
    expect(normalizeCommentApiBaseUrl('/edge/api///')).toBe('/edge/api');
    expect(normalizeCommentApiBaseUrl('/')).toBe('/');
    expect(commentSettingsInputSchema.parse({
      ...COMMENT_SETTINGS_DEFAULTS,
      api_base_url: 'https://edge.example.com/api/',
    }).api_base_url).toBe('https://edge.example.com/api');
  });

  it('rejects unsafe, bare-relative, and non-canonical stored URLs', () => {
    for (const value of [
      'edge/api',
      '//edge.example/api',
      'ftp://edge.example/api',
      'https://user@edge.example/api',
      'https://edge.example/api?x=1',
      'https://edge.example/api#x',
      'https://edge.example/../api',
      'https://edge.example/%zz',
      ' https://edge.example/api',
      '/edge\\api',
      '/edge/./api',
    ]) {
      expect(normalizeCommentApiBaseUrl(value)).toBeNull();
    }
    expect(commentSettingsSchema.safeParse({
      ...COMMENT_SETTINGS_DEFAULTS,
      api_base_url: 'https://edge.example/api/',
    }).success).toBe(false);
  });

  it('keeps a fixed ZeroPress provider and bounded runtime values', () => {
    expect(commentSettingsInputSchema.safeParse({
      ...COMMENT_SETTINGS_DEFAULTS,
      provider: 'wordpress',
    }).success).toBe(false);
    expect(commentSettingsInputSchema.safeParse({
      ...COMMENT_SETTINGS_DEFAULTS,
      per_page: 101,
    }).success).toBe(false);
    expect(commentSettingsInputSchema.safeParse({
      ...COMMENT_SETTINGS_DEFAULTS,
      threading: { enabled: true, max_depth: 1 },
    }).success).toBe(false);
    const { moderation: _moderation, ...withoutModeration } =
      COMMENT_SETTINGS_DEFAULTS;
    expect(commentSettingsInputSchema.safeParse(withoutModeration).success)
      .toBe(false);
    expect(commentSettingsInputSchema.safeParse({
      ...COMMENT_SETTINGS_DEFAULTS,
      moderation: { require_approval: false, legacy: true },
    }).success).toBe(false);
    const { auth: _auth, ...withoutAuth } = COMMENT_SETTINGS_DEFAULTS;
    expect(commentSettingsInputSchema.safeParse(withoutAuth).success)
      .toBe(false);
  });

  it('compares canonical settings by value rather than property order', () => {
    const canonical = commentSettingsSchema.parse(COMMENT_SETTINGS_DEFAULTS);
    const reordered: typeof canonical = {
      auth: { ...canonical.auth },
      api_base_url: canonical.api_base_url,
      moderation: { ...canonical.moderation },
      threading: { ...canonical.threading },
      order: canonical.order,
      per_page: canonical.per_page,
      provider: canonical.provider,
      enabled: canonical.enabled,
    };
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(canonical));
    expect(areCommentSettingsEqual(reordered, canonical)).toBe(true);
    expect(areCommentSettingsEqual({
      ...reordered,
      auth: { ...reordered.auth, enabled: true },
    }, canonical)).toBe(false);
  });

  it('normalizes a complete public Supabase configuration', () => {
    expect(normalizeSupabaseProjectUrl('https://Example.Supabase.co/'))
      .toBe('https://example.supabase.co');
    expect(normalizeSupabaseProjectUrl('http://localhost:54321/'))
      .toBe('http://localhost:54321');
    expect(normalizeSupabasePublishableKey(PUBLISHABLE_KEY))
      .toBe(PUBLISHABLE_KEY);

    const parsed = commentSettingsInputSchema.parse({
      ...COMMENT_SETTINGS_DEFAULTS,
      auth: {
        enabled: true,
        provider: 'supabase',
        project_url: ' https://Example.Supabase.co/ ',
        publishable_key: ` ${PUBLISHABLE_KEY} `,
      },
    });
    expect(parsed.auth).toEqual({
      enabled: true,
      provider: 'supabase',
      project_url: 'https://example.supabase.co',
      publishable_key: PUBLISHABLE_KEY,
    });
  });

  it('requires a safe public Supabase pair only when configured or enabled', () => {
    expect(commentSettingsInputSchema.safeParse({
      ...COMMENT_SETTINGS_DEFAULTS,
      auth: {
        enabled: false,
        provider: 'supabase',
        project_url: 'https://project.supabase.co',
        publishable_key: PUBLISHABLE_KEY,
      },
    }).success).toBe(true);

    for (const auth of [
      {
        enabled: true,
        provider: 'supabase',
        project_url: null,
        publishable_key: null,
      },
      {
        enabled: false,
        provider: 'supabase',
        project_url: 'https://project.supabase.co',
        publishable_key: null,
      },
      {
        enabled: false,
        provider: 'supabase',
        project_url: null,
        publishable_key: PUBLISHABLE_KEY,
      },
      {
        enabled: false,
        provider: 'wordpress',
        project_url: null,
        publishable_key: null,
      },
      {
        enabled: false,
        provider: 'supabase',
        project_url: null,
        publishable_key: null,
        mode: 'optional',
      },
    ]) {
      expect(commentSettingsInputSchema.safeParse({
        ...COMMENT_SETTINGS_DEFAULTS,
        auth,
      }).success).toBe(false);
    }

    for (const projectUrl of [
      'http://example.supabase.co',
      'https://user@example.supabase.co',
      'https://example.supabase.co/auth/v1',
      'https://example.supabase.co?x=1',
      'https://example.supabase.co#x',
      '//example.supabase.co',
      'https://example.supabase.co\\path',
    ]) {
      expect(normalizeSupabaseProjectUrl(projectUrl)).toBeNull();
    }
    for (const key of [
      'sb_secret_example-key-with-enough-length',
      'service-role-key',
      'eyJhbGciOiJIUzI1NiJ9.payload.signature',
      'sb_publishable_short',
    ]) {
      expect(normalizeSupabasePublishableKey(key)).toBeNull();
    }

    expect(commentSettingsSchema.safeParse({
      ...COMMENT_SETTINGS_DEFAULTS,
      auth: {
        enabled: false,
        provider: 'supabase',
        project_url: 'https://example.supabase.co/',
        publishable_key: PUBLISHABLE_KEY,
      },
    }).success).toBe(false);
  });

  it('keeps Comment Request Security metadata closed and secret-free', () => {
    const valid = {
      status: 'valid',
      revision: 'a'.repeat(32),
      current_key: {
        kid: 'k_AAAAAAAAAAAAAAAAAAAAAA',
        created_at_iso: '2026-08-05T01:02:03Z',
      },
      previous_keys: { total_count: 2, active_count: 1 },
    };
    expect(commentRequestSecurityResourceSchema.parse(valid)).toEqual(valid);
    expect(commentRequestSecurityResourceSchema.safeParse({
      ...valid,
      secret: 'must-not-be-exposed',
    }).success).toBe(false);
    expect(commentRequestSecurityResourceSchema.safeParse({
      ...valid,
      status: 'invalid',
    }).success).toBe(false);
    expect(commentRequestSecurityResourceSchema.safeParse({
      ...valid,
      previous_keys: { total_count: 1, active_count: 2 },
    }).success).toBe(false);
  });

  it('requires an exact revision for request-security mutations', () => {
    expect(commentRequestSecurityMutationRequestSchema.safeParse({
      expected_revision: 'b'.repeat(32),
    }).success).toBe(true);
    expect(commentRequestSecurityMutationRequestSchema.safeParse({
      expected_revision: 'b'.repeat(31),
    }).success).toBe(false);
    expect(commentRequestSecurityMutationRequestSchema.safeParse({
      expected_revision: 'b'.repeat(32),
      action: 'reset',
    }).success).toBe(false);
  });
});

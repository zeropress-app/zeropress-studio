import { describe, expect, it } from 'vitest';
import {
  materializeOutputSettingsDefaults,
  outputSettingsSchema,
  PREVIEW_DATETIME_STYLES,
  updateOutputSettingsRequestSchema,
} from './output-settings';

describe('output settings contract', () => {
  it('materializes safe Preview Data v0.7-compatible defaults', () => {
    expect(materializeOutputSettingsDefaults()).toEqual({
      expose_generator: true,
      search: { enabled: true },
      feed: { enabled: true },
      archive: { enabled: true },
      posts_per_page: 10,
      date_style: 'medium',
      time_style: 'none',
      footer: { attribution: true },
      robots: { allow_indexing: false },
    });
    expect(outputSettingsSchema.safeParse(
      materializeOutputSettingsDefaults(),
    ).success).toBe(true);
  });

  it('accepts every Preview Data datetime style', () => {
    for (const dateStyle of PREVIEW_DATETIME_STYLES) {
      for (const timeStyle of PREVIEW_DATETIME_STYLES) {
        expect(outputSettingsSchema.safeParse({
          ...materializeOutputSettingsDefaults(),
          date_style: dateStyle,
          time_style: timeStyle,
        }).success).toBe(true);
      }
    }
  });

  it('requires an integer of at least one without imposing a Studio-only maximum', () => {
    const defaults = materializeOutputSettingsDefaults();
    expect(outputSettingsSchema.safeParse({
      ...defaults,
      posts_per_page: 1,
    }).success).toBe(true);
    expect(outputSettingsSchema.safeParse({
      ...defaults,
      posts_per_page: 10_000,
    }).success).toBe(true);
    expect(outputSettingsSchema.safeParse({
      ...defaults,
      posts_per_page: 0,
    }).success).toBe(false);
    expect(outputSettingsSchema.safeParse({
      ...defaults,
      posts_per_page: 1.5,
    }).success).toBe(false);
  });

  it('requires complete closed feature, Footer, and robots objects', () => {
    const defaults = materializeOutputSettingsDefaults();
    expect(outputSettingsSchema.safeParse({
      ...defaults,
      search: {},
    }).success).toBe(false);
    expect(outputSettingsSchema.safeParse({
      ...defaults,
      feed: { enabled: true, legacy: false },
    }).success).toBe(false);
    expect(outputSettingsSchema.safeParse({
      ...defaults,
      footer: { attribution: true, legacy: false },
    }).success).toBe(false);
    expect(outputSettingsSchema.safeParse({
      ...defaults,
      robots: { allow_indexing: true, extra: true },
    }).success).toBe(false);
    expect(outputSettingsSchema.safeParse({
      ...defaults,
      site_search: true,
    }).success).toBe(false);
  });

  it('normalizes authored Footer text while keeping stored documents canonical', () => {
    const base = {
      settings: {
        ...materializeOutputSettingsDefaults(),
        footer: {
          copyright_text: '  © 2026 Example  ',
          attribution: false,
        },
      },
      expected_revision: '0'.repeat(32),
    };
    expect(updateOutputSettingsRequestSchema.parse(base).settings.footer)
      .toEqual({ copyright_text: '© 2026 Example', attribution: false });
    expect(updateOutputSettingsRequestSchema.parse({
      ...base,
      settings: {
        ...base.settings,
        footer: { copyright_text: '   ', attribution: true },
      },
    }).settings.footer).toEqual({ attribution: true });
    expect(outputSettingsSchema.safeParse(base.settings).success).toBe(false);
    expect(outputSettingsSchema.safeParse({
      ...base.settings,
      footer: { copyright_text: '', attribution: true },
    }).success).toBe(false);
  });

  it('requires the complete settings document and a valid revision', () => {
    const base = {
      settings: materializeOutputSettingsDefaults(),
      expected_revision: '0'.repeat(32),
    };
    expect(updateOutputSettingsRequestSchema.safeParse(base).success)
      .toBe(true);
    const { archive: _archive, ...incomplete } = base.settings;
    expect(updateOutputSettingsRequestSchema.safeParse({
      ...base,
      settings: incomplete,
    }).success).toBe(false);
    expect(updateOutputSettingsRequestSchema.safeParse({
      ...base,
      expected_revision: 'invalid',
    }).success).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CUSTOM_CODE_SETTINGS_BODY_LIMIT_BYTES,
  CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
  CUSTOM_HTML_SLOT_MAX_CODE_POINTS,
  customCodeSettingsDocumentSchema,
  customCodeSettingsSchema,
  materializeCustomCodeSettingsDefaults,
  updateCustomCodeSettingsRequestSchema,
} from './custom-code-settings';

describe('Custom Code settings contract', () => {
  it('materializes one complete disabled draft document', () => {
    const settings = materializeCustomCodeSettingsDefaults();
    expect(settings).toEqual({
      custom_css: { enabled: false, content: '' },
      custom_html: {
        head_end: { enabled: false, content: '' },
        body_end: { enabled: false, content: '' },
      },
    });
    expect(customCodeSettingsDocumentSchema.safeParse({
      settings,
      revision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    }).success).toBe(true);
    expect(CUSTOM_CODE_SETTINGS_BODY_LIMIT_BYTES).toBe(1024 * 1024);
  });

  it('preserves raw source and permits enabled blank drafts', () => {
    const settings = {
      custom_css: { enabled: true, content: '  body { color: red; }\n' },
      custom_html: {
        head_end: { enabled: true, content: '' },
        body_end: { enabled: false, content: '  <script></script>\n' },
      },
    };
    const parsed = customCodeSettingsSchema.parse(settings);
    expect(parsed).toEqual(settings);
    expect(parsed.custom_css.content.startsWith('  ')).toBe(true);
  });

  it('enforces each Custom HTML slot by Unicode code point', () => {
    const valid = materializeCustomCodeSettingsDefaults();
    valid.custom_html.head_end.content = '😀'.repeat(
      CUSTOM_HTML_SLOT_MAX_CODE_POINTS,
    );
    expect(customCodeSettingsSchema.safeParse(valid).success).toBe(true);

    valid.custom_html.head_end.content += 'x';
    expect(customCodeSettingsSchema.safeParse(valid).success).toBe(false);
  });

  it('requires a complete closed revision-bound update', () => {
    const request = {
      settings: materializeCustomCodeSettingsDefaults(),
      expected_revision: CUSTOM_CODE_SETTINGS_INITIAL_REVISION,
    };
    expect(updateCustomCodeSettingsRequestSchema.safeParse(request).success)
      .toBe(true);
    expect(updateCustomCodeSettingsRequestSchema.safeParse({
      ...request,
      settings: { custom_css: request.settings.custom_css },
    }).success).toBe(false);
    expect(updateCustomCodeSettingsRequestSchema.safeParse({
      ...request,
      unexpected: true,
    }).success).toBe(false);
  });
});

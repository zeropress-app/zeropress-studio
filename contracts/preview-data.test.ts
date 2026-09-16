import { describe, expect, it } from 'vitest';
import packageJson from '../package.json';
import {
  previewDataExportDocumentSchema,
  previewDataResponseSchema,
  previewDataSummaryResponseSchema,
  previewDataSummarySchema,
  previewDataV07Schema,
} from './preview-data';
import {
  STUDIO_PREVIEW_DATA_GENERATOR,
  STUDIO_VERSION,
} from './studio-version';

const validPreviewData = {
  $schema: 'https://schemas.zeropress.dev/preview-data/v0.7/schema.json',
  version: '0.7',
  generator: STUDIO_PREVIEW_DATA_GENERATOR,
  generated_at: '2026-08-01T06:00:00Z',
  site: {
    title: 'ZeroPress',
    description: '',
    url: '',
    media_origin: '',
    locale: 'en-US',
    posts_per_page: 10,
    date_style: 'medium',
    time_style: 'none',
    timezone: 'UTC',
    robots: { allow_indexing: false },
  },
  content: {
    authors: [],
    posts: [],
    pages: [],
    categories: [],
    tags: [],
  },
} as const;

describe('Preview Data export contract', () => {
  it('uses the package SemVer with the stable Studio product name', () => {
    expect(STUDIO_VERSION).toBe(packageJson.version);
    expect(STUDIO_PREVIEW_DATA_GENERATOR).toBe(
      `zeropress-studio v${packageJson.version}`,
    );
  });

  it('accepts a valid v0.7 projection and strict validation metadata', () => {
    expect(previewDataExportDocumentSchema.safeParse({
      preview_data: validPreviewData,
      validation: {
        status: 'valid',
        contract_version: '0.7',
        warnings: [],
      },
    }).success).toBe(true);
  });

  it('rejects invalid Preview Data versions and payloads', () => {
    expect(previewDataV07Schema.safeParse({
      ...validPreviewData,
      version: '0.6',
    }).success).toBe(false);
    expect(previewDataV07Schema.safeParse({
      ...validPreviewData,
      site: { ...validPreviewData.site, unknown: true },
    }).success).toBe(false);
  });

  it('rejects malformed envelopes and non-warning validation issues', () => {
    expect(previewDataResponseSchema.safeParse({
      success: true,
      data: {
        preview_data: validPreviewData,
        validation: {
          status: 'valid',
          contract_version: '0.7',
          warnings: [{
            code: 'INVALID',
            path: 'site',
            message: 'Invalid.',
            severity: 'error',
          }],
        },
      },
    }).success).toBe(false);
    expect(previewDataResponseSchema.safeParse({
      success: true,
      data: {
        preview_data: validPreviewData,
        validation: {
          status: 'valid',
          contract_version: '0.7',
          warnings: [],
        },
        extra: true,
      },
    }).success).toBe(false);
  });

  it('accepts only strict, non-negative safe export summary counts', () => {
    const summary = {
      authors: 1,
      posts: 274,
      pages: 1,
      categories: 4,
      tags: 667,
      menus: 2,
    };
    expect(previewDataSummarySchema.safeParse(summary).success).toBe(true);
    expect(previewDataSummaryResponseSchema.safeParse({
      success: true,
      data: summary,
    }).success).toBe(true);
    expect(previewDataSummarySchema.safeParse({
      ...summary,
      posts: -1,
    }).success).toBe(false);
    expect(previewDataSummarySchema.safeParse({
      ...summary,
      extra: 1,
    }).success).toBe(false);
  });
});

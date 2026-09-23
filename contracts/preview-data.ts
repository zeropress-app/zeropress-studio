import {
  PREVIEW_DATA_VERSION,
  validatePreviewData,
  type PreviewDataV07,
} from '@zeropress/preview-data-validator';
import { z } from 'zod';
import { apiErrorSchema } from './api';

function isPreviewDataV07(value: unknown): value is PreviewDataV07 {
  try {
    return validatePreviewData(value).ok;
  } catch {
    return false;
  }
}

export const previewDataV07Schema = z.custom<PreviewDataV07>(
  isPreviewDataV07,
  'Expected valid ZeroPress Preview Data v0.7.',
);

export const previewDataWarningSchema = z.object({
  code: z.string().min(1),
  path: z.string(),
  message: z.string().min(1),
  severity: z.literal('warning'),
}).strict();

export const previewDataExportDocumentSchema = z.object({
  preview_data: previewDataV07Schema,
  validation: z.object({
    status: z.literal('valid'),
    contract_version: z.literal(PREVIEW_DATA_VERSION),
    warnings: z.array(previewDataWarningSchema),
  }).strict(),
}).strict();

export const preparedPreviewDataSchema = previewDataExportDocumentSchema.extend({
  data_hash: z.string().regex(/^[a-f\d]{64}$/u),
});

const previewDataCountSchema = z.number().int().nonnegative().safe();

export const previewDataSummarySchema = z.object({
  authors: previewDataCountSchema,
  posts: previewDataCountSchema,
  pages: previewDataCountSchema,
  categories: previewDataCountSchema,
  tags: previewDataCountSchema,
  menus: previewDataCountSchema,
}).strict();

export const previewDataSummarySuccessSchema = z.object({
  success: z.literal(true),
  data: previewDataSummarySchema,
}).strict();

export const previewDataSummaryResponseSchema = z.union([
  previewDataSummarySuccessSchema,
  apiErrorSchema,
]);

export const previewDataSuccessSchema = z.object({
  success: z.literal(true),
  data: preparedPreviewDataSchema,
}).strict();

export const previewDataResponseSchema = z.union([
  previewDataSuccessSchema,
  apiErrorSchema,
]);

export type PreviewDataExportDocument = z.infer<
  typeof previewDataExportDocumentSchema
>;
export type PreparedPreviewData = z.infer<typeof preparedPreviewDataSchema>;
export type PreviewDataSummary = z.infer<typeof previewDataSummarySchema>;
export type PreviewDataSummarySuccess = z.infer<
  typeof previewDataSummarySuccessSchema
>;
export type PreviewDataSummaryResponse = z.infer<
  typeof previewDataSummaryResponseSchema
>;
export type PreviewDataSuccess = z.infer<typeof previewDataSuccessSchema>;
export type PreviewDataResponse = z.infer<typeof previewDataResponseSchema>;

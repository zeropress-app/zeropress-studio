import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  contentRevisionListSchema,
  contentRevisionSummarySchema,
} from './content-revisions';
import { contentSnapshotSha256Schema } from './content-snapshots';
import { pageContentSnapshotSchema } from './page-autosaves';
import { pageMutationSuccessSchema } from './pages';

export const pageRevisionDocumentSchema = contentRevisionSummarySchema.extend({
  snapshot: pageContentSnapshotSchema,
  snapshot_sha256: contentSnapshotSha256Schema,
}).strict();

export const pageRevisionListSuccessSchema = z.object({
  success: z.literal(true),
  data: contentRevisionListSchema,
}).strict();

export const pageRevisionListResponseSchema = z.union([
  pageRevisionListSuccessSchema,
  apiErrorSchema,
]);

export const pageRevisionDetailSuccessSchema = z.object({
  success: z.literal(true),
  data: pageRevisionDocumentSchema,
}).strict();

export const pageRevisionDetailResponseSchema = z.union([
  pageRevisionDetailSuccessSchema,
  apiErrorSchema,
]);

export const pageRevisionRestoreResponseSchema = z.union([
  pageMutationSuccessSchema,
  apiErrorSchema,
]);

export type PageRevisionDocument = z.infer<
  typeof pageRevisionDocumentSchema
>;
export type PageRevisionListResponse = z.infer<
  typeof pageRevisionListResponseSchema
>;
export type PageRevisionDetailResponse = z.infer<
  typeof pageRevisionDetailResponseSchema
>;
export type PageRevisionRestoreResponse = z.infer<
  typeof pageRevisionRestoreResponseSchema
>;

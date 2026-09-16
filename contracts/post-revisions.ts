import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  contentRevisionListSchema,
  contentRevisionSummarySchema,
} from './content-revisions';
import { contentSnapshotSha256Schema } from './content-snapshots';
import { postContentSnapshotSchema } from './post-autosaves';
import { postMutationSuccessSchema } from './posts';

export const postRevisionDocumentSchema = contentRevisionSummarySchema.extend({
  snapshot: postContentSnapshotSchema,
  snapshot_sha256: contentSnapshotSha256Schema,
}).strict();

export const postRevisionListSuccessSchema = z.object({
  success: z.literal(true),
  data: contentRevisionListSchema,
}).strict();

export const postRevisionListResponseSchema = z.union([
  postRevisionListSuccessSchema,
  apiErrorSchema,
]);

export const postRevisionDetailSuccessSchema = z.object({
  success: z.literal(true),
  data: postRevisionDocumentSchema,
}).strict();

export const postRevisionDetailResponseSchema = z.union([
  postRevisionDetailSuccessSchema,
  apiErrorSchema,
]);

export const postRevisionRestoreResponseSchema = z.union([
  postMutationSuccessSchema,
  apiErrorSchema,
]);

export type PostRevisionDocument = z.infer<
  typeof postRevisionDocumentSchema
>;
export type PostRevisionListResponse = z.infer<
  typeof postRevisionListResponseSchema
>;
export type PostRevisionDetailResponse = z.infer<
  typeof postRevisionDetailResponseSchema
>;
export type PostRevisionRestoreResponse = z.infer<
  typeof postRevisionRestoreResponseSchema
>;

import { z } from 'zod';

export const ZEROPRESS_NATIVE_PUBLIC_ID_BASE = 100_000_000_000;

export const contentTypeSchema = z.enum(['post', 'page']);

export const contentPublicIdSchema = z.number().int().positive().max(
  Number.MAX_SAFE_INTEGER,
);

export type ContentType = z.infer<typeof contentTypeSchema>;

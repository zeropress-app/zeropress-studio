import { z } from 'zod';

export const AUTHOR_ID_MAX_LENGTH = 512;
export const AUTHOR_DISPLAY_NAME_MAX_LENGTH = 200;

export const authorIdSchema = z.string()
  .min(1)
  .max(AUTHOR_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const authorDisplayNameInputSchema = z.string()
  .trim()
  .min(1)
  .max(AUTHOR_DISPLAY_NAME_MAX_LENGTH);

export const authorDisplayNameSchema = z.string()
  .min(1)
  .max(AUTHOR_DISPLAY_NAME_MAX_LENGTH)
  .refine((value) => value === value.trim());

export const publicAuthorIdentitySchema = z.object({
  id: authorIdSchema,
  display_name: authorDisplayNameSchema,
}).strict();

export type PublicAuthorIdentity = z.infer<typeof publicAuthorIdentitySchema>;

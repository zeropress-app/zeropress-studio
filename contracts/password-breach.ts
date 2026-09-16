import { z } from 'zod';
import { apiErrorSchema } from './api';
import { PASSWORD_MAX_LENGTH } from './password-policy';

export const passwordBreachCheckRequestSchema = z.object({
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
}).strict();

export const passwordBreachStatusSchema = z.enum([
  'clear',
  'hit',
  'unavailable',
]);

export const passwordBreachSourceSchema = z.enum(['offline', 'hibp']);

export const passwordBreachAssessmentSchema = z.object({
  status: passwordBreachStatusSchema,
  source: passwordBreachSourceSchema,
}).strict();

export const passwordBreachCheckSuccessSchema = z.object({
  success: z.literal(true),
  data: passwordBreachAssessmentSchema,
}).strict();

export const passwordBreachCheckResponseSchema = z.union([
  passwordBreachCheckSuccessSchema,
  apiErrorSchema,
]);

export type PasswordBreachAssessment = z.infer<
  typeof passwordBreachAssessmentSchema
>;
export type PasswordBreachCheckResponse = z.infer<
  typeof passwordBreachCheckResponseSchema
>;

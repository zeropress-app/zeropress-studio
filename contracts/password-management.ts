import { z } from 'zod';
import { apiErrorSchema } from './api';
import { mfaManagementTokenSchema } from './mfa-management';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './password-policy';

export const changePasswordRequestSchema = z.object({
  management_token: mfaManagementTokenSchema,
  new_password: z.string()
    .min(PASSWORD_MIN_LENGTH)
    .max(PASSWORD_MAX_LENGTH),
}).strict();

export const changePasswordSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('password_changed'),
    revoked_sessions: z.number().int().positive().max(5),
    current_session_ended: z.literal(true),
  }).strict(),
}).strict();

export const changePasswordResponseSchema = z.union([
  changePasswordSuccessSchema,
  apiErrorSchema,
]);

export type ChangePasswordRequest = z.infer<
  typeof changePasswordRequestSchema
>;
export type ChangePasswordResponse = z.infer<
  typeof changePasswordResponseSchema
>;

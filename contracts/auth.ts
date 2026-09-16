import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  mfaContinuationTokenSchema,
  mfaEnrollmentProofSchema,
  mfaEnrollmentSetupResponseSchema as sharedMfaEnrollmentSetupResponseSchema,
  totpCodeSchema,
} from './mfa';

export const loginRequestSchema = z.object({
  email: z.email().trim().max(254),
  password: z.string().min(1).max(1024),
}).strict();

export const loginStatusSchema = z.enum([
  'mfa_required',
  'mfa_enrollment_required',
]);

export const loginMfaMethodSchema = z.enum([
  'webauthn',
  'totp',
]);

export const loginSuccessSchema = z.object({
  success: z.literal(true),
  data: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('mfa_required'),
      continuation_token: mfaContinuationTokenSchema,
      expires_at_iso: z.iso.datetime({ offset: true }),
      available_methods: z.array(loginMfaMethodSchema)
        .min(1)
        .max(2)
        .refine(
          (methods) => new Set(methods).size === methods.length
            && methods.includes('totp'),
        ),
      preferred_method: loginMfaMethodSchema,
    }).strict().refine(
      (data) => data.available_methods.includes(data.preferred_method),
    ),
    z.object({
      status: z.literal('mfa_enrollment_required'),
      continuation_token: mfaContinuationTokenSchema,
      expires_at_iso: z.iso.datetime({ offset: true }),
    }).strict(),
  ]),
}).strict();

export const loginResponseSchema = z.union([loginSuccessSchema, apiErrorSchema]);

export const mfaVerifyRequestSchema = z.discriminatedUnion('method', [
  z.object({
    continuation_token: mfaContinuationTokenSchema,
    method: z.literal('totp'),
    code: totpCodeSchema,
  }).strict(),
]);

export const authenticatedSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('authenticated'),
  }).strict(),
}).strict();

export const mfaVerifyResponseSchema = z.union([
  authenticatedSuccessSchema,
  apiErrorSchema,
]);

export const mfaEnrollmentSetupRequestSchema = z.object({
  continuation_token: mfaContinuationTokenSchema,
}).strict();

export const mfaEnrollmentSetupResponseSchema =
  sharedMfaEnrollmentSetupResponseSchema;

export const mfaEnrollmentCompleteRequestSchema = z.object({
  continuation_token: mfaContinuationTokenSchema,
  mfa: mfaEnrollmentProofSchema,
}).strict();

export const mfaEnrollmentCompleteResponseSchema = z.union([
  authenticatedSuccessSchema,
  apiErrorSchema,
]);

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginStatus = z.infer<typeof loginStatusSchema>;
export type LoginMfaMethod = z.infer<typeof loginMfaMethodSchema>;
export type LoginSuccess = z.infer<typeof loginSuccessSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type MfaVerifyRequest = z.infer<typeof mfaVerifyRequestSchema>;
export type MfaVerifyResponse = z.infer<typeof mfaVerifyResponseSchema>;
export type AuthenticatedSuccess = z.infer<
  typeof authenticatedSuccessSchema
>;
export type MfaEnrollmentSetupRequest = z.infer<
  typeof mfaEnrollmentSetupRequestSchema
>;
export type MfaEnrollmentSetupResponse = z.infer<
  typeof mfaEnrollmentSetupResponseSchema
>;
export type MfaEnrollmentCompleteRequest = z.infer<
  typeof mfaEnrollmentCompleteRequestSchema
>;
export type MfaEnrollmentCompleteResponse = z.infer<
  typeof mfaEnrollmentCompleteResponseSchema
>;

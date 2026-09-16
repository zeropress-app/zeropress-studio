import { z } from 'zod';
import { apiErrorSchema } from './api';

export const TOTP_CODE_LENGTH = 6;

export const totpCodeSchema = z.string().regex(/^[0-9]{6}$/u);

export const mfaContinuationTokenSchema = z.string()
  .min(32)
  .max(8192);
export const mfaEnrollmentTokenSchema = z.string()
  .min(32)
  .max(16_384);

export const mfaEnrollmentSetupDataSchema = z.object({
  method: z.literal('totp'),
  secret: z.string().regex(/^[A-Z2-7]{32}$/u),
  otpauth_uri: z.url().startsWith('otpauth://totp/'),
  enrollment_token: mfaEnrollmentTokenSchema,
  expires_at_iso: z.iso.datetime({ offset: true }),
}).strict();

export const mfaEnrollmentSetupSuccessSchema = z.object({
  success: z.literal(true),
  data: mfaEnrollmentSetupDataSchema,
}).strict();

export const mfaEnrollmentSetupResponseSchema = z.union([
  mfaEnrollmentSetupSuccessSchema,
  apiErrorSchema,
]);

export const mfaEnrollmentProofSchema = z.object({
  enrollment_token: mfaEnrollmentTokenSchema,
  totp_code: totpCodeSchema,
}).strict();

export type MfaEnrollmentSetupData = z.infer<
  typeof mfaEnrollmentSetupDataSchema
>;
export type MfaEnrollmentSetupSuccess = z.infer<
  typeof mfaEnrollmentSetupSuccessSchema
>;
export type MfaEnrollmentSetupResponse = z.infer<
  typeof mfaEnrollmentSetupResponseSchema
>;
export type MfaEnrollmentProof = z.infer<typeof mfaEnrollmentProofSchema>;

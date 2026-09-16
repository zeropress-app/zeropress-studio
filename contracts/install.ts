import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './password-policy';
import {
  mfaEnrollmentProofSchema,
  mfaEnrollmentSetupResponseSchema,
} from './mfa';
import { interfaceLocaleSchema } from './studio-interface-settings';

export const installAccessSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    state: z.literal('authorized'),
  }).strict(),
}).strict();

export const installAccessResponseSchema = z.union([
  installAccessSuccessSchema,
  apiErrorSchema,
]);

export const installRequestSchema = z.object({
  admin_name: z.string().trim().min(2).max(100),
  admin_email: z.string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(254)),
  admin_password: z.string()
    .min(PASSWORD_MIN_LENGTH)
    .max(PASSWORD_MAX_LENGTH),
  interface_locale: interfaceLocaleSchema,
  mfa: mfaEnrollmentProofSchema,
}).strict();

export const installMfaSetupRequestSchema = z.object({
  admin_email: z.string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(254)),
}).strict();

export const installMfaSetupResponseSchema =
  mfaEnrollmentSetupResponseSchema;

export const installSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('installed'),
    schema_version: z.number().int().positive(),
    edge_database: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('installed'),
        integration_mode: z.literal('enabled'),
      }).strict(),
      z.object({
        status: z.literal('skipped_nonempty'),
        integration_mode: z.literal('disabled'),
      }).strict(),
    ]),
  }).strict(),
}).strict();

export const installResponseSchema = z.union([
  installSuccessSchema,
  apiErrorSchema,
]);

export type InstallRequest = z.infer<typeof installRequestSchema>;
export type InstallAccessResponse = z.infer<
  typeof installAccessResponseSchema
>;
export type InstallMfaSetupRequest = z.infer<
  typeof installMfaSetupRequestSchema
>;
export type InstallMfaSetupResponse = z.infer<
  typeof installMfaSetupResponseSchema
>;
export type InstallSuccess = z.infer<typeof installSuccessSchema>;
export type InstallResponse = z.infer<typeof installResponseSchema>;

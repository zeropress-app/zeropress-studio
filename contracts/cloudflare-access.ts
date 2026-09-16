import { z } from 'zod';
import { apiErrorSchema } from './api';
import { settingsRevisionSchema } from './settings-revision';

export const CLOUDFLARE_ACCESS_ASSERTION_HEADER = 'Cf-Access-Jwt-Assertion';
export const CLOUDFLARE_ACCESS_RECOVERY_CONFIRMATION =
  'DISABLE CLOUDFLARE ACCESS';

export const cloudflareAccessAudienceSchema = z.string()
  .regex(/^[0-9a-f]{64}$/u);

export const cloudflareAccessIssuerSchema = z.string()
  .min(1)
  .max(512)
  .regex(
    /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u,
  );

export const cloudflareAccessOriginSchema = z.string()
  .min(1)
  .max(2048)
  .superRefine((value, context) => {
    try {
      const url = new URL(value);
      if (
        url.protocol !== 'https:'
        || url.origin !== value
        || url.username !== ''
        || url.password !== ''
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Expected one canonical HTTPS origin',
        });
      }
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'Expected one canonical HTTPS origin',
      });
    }
  });

export const cloudflareAccessRequirementSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('disabled'),
    issuer: z.null(),
    audience: z.null(),
    bound_origin: z.null(),
    verified_at_iso: z.null(),
  }).strict(),
  z.object({
    mode: z.literal('required'),
    issuer: cloudflareAccessIssuerSchema,
    audience: cloudflareAccessAudienceSchema,
    bound_origin: cloudflareAccessOriginSchema,
    verified_at_iso: z.iso.datetime({ offset: true }),
  }).strict(),
]);

export const detectedCloudflareAccessSchema = z.object({
  issuer: cloudflareAccessIssuerSchema,
  team_domain: z.string().min(1).max(253),
  audience: cloudflareAccessAudienceSchema,
  identity_email: z.email().max(320).nullable(),
}).strict();

export const cloudflareAccessSettingsDocumentSchema = z.object({
  settings: cloudflareAccessRequirementSchema,
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
  detection_state: z.enum([
    'not_detected',
    'verified',
    'invalid',
    'unavailable',
  ]),
  detected: detectedCloudflareAccessSchema.nullable(),
}).strict();

export const cloudflareAccessSettingsSuccessSchema = z.object({
  success: z.literal(true),
  data: cloudflareAccessSettingsDocumentSchema,
}).strict();

export const cloudflareAccessSettingsResponseSchema = z.union([
  cloudflareAccessSettingsSuccessSchema,
  apiErrorSchema,
]);

export const updateCloudflareAccessSettingsRequestSchema = z.object({
  mode: z.enum(['disabled', 'required']),
  expected_revision: settingsRevisionSchema,
}).strict();

export const cloudflareAccessRecoveryStatusSchema = z.object({
  state: z.enum(['disabled', 'required', 'unavailable']),
  disable_available: z.boolean(),
  confirmation: z.literal(CLOUDFLARE_ACCESS_RECOVERY_CONFIRMATION),
}).strict();

export const cloudflareAccessRecoveryRequestSchema = z.object({
  confirmation: z.literal(CLOUDFLARE_ACCESS_RECOVERY_CONFIRMATION),
}).strict();

export const cloudflareAccessRecoverySuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('disable_cloudflare_access'),
    status: z.literal('completed'),
  }).strict(),
}).strict();

export const cloudflareAccessRecoveryResponseSchema = z.union([
  cloudflareAccessRecoverySuccessSchema,
  apiErrorSchema,
]);

export type CloudflareAccessRequirement = z.infer<
  typeof cloudflareAccessRequirementSchema
>;
export type DetectedCloudflareAccess = z.infer<
  typeof detectedCloudflareAccessSchema
>;
export type CloudflareAccessSettingsDocument = z.infer<
  typeof cloudflareAccessSettingsDocumentSchema
>;
export type CloudflareAccessSettingsResponse = z.infer<
  typeof cloudflareAccessSettingsResponseSchema
>;
export type UpdateCloudflareAccessSettingsRequest = z.infer<
  typeof updateCloudflareAccessSettingsRequestSchema
>;
export type CloudflareAccessRecoveryStatus = z.infer<
  typeof cloudflareAccessRecoveryStatusSchema
>;
export type CloudflareAccessRecoveryRequest = z.infer<
  typeof cloudflareAccessRecoveryRequestSchema
>;
export type CloudflareAccessRecoveryResponse = z.infer<
  typeof cloudflareAccessRecoveryResponseSchema
>;

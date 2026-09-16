import { z } from 'zod';
import { apiErrorSchema } from './api';
import { settingsRevisionSchema } from './settings-revision';

export const EDGE_SECURITY_SETTINGS_LIMITS = {
  turnstileSitekeyCodePoints: 256,
  ipRetentionDaysMinimum: 1,
  ipRetentionDaysMaximum: 365,
} as const;

export const EDGE_WRITE_VERIFICATION_MODES = [
  'pow',
  'turnstile',
] as const;

export const edgeWriteVerificationModeSchema = z.enum(
  EDGE_WRITE_VERIFICATION_MODES,
);

export type EdgeWriteVerificationMode = z.infer<
  typeof edgeWriteVerificationModeSchema
>;

export const EDGE_SECURITY_SETTINGS_DEFAULTS = {
  comment_write_verification_mode: 'pow',
  newsletter_subscribe_verification_mode: 'pow',
  form_submit_verification_mode: 'pow',
  turnstile_sitekey: null,
  ip_address_retention_days: 30,
} as const;

function codePointLength(value: string): number {
  return [...value].length;
}

const turnstileSitekeyInputSchema = z.union([
  z.string().transform((value, context) => {
    const normalized = value.trim();
    if (
      normalized !== ''
      && codePointLength(normalized)
        > EDGE_SECURITY_SETTINGS_LIMITS.turnstileSitekeyCodePoints
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Turnstile sitekey is too long',
      });
      return z.NEVER;
    }
    return normalized === '' ? null : normalized;
  }),
  z.null(),
]);

const canonicalTurnstileSitekeySchema = z.union([
  z.string().superRefine((value, context) => {
    if (
      value === ''
      || value.trim() !== value
      || codePointLength(value)
        > EDGE_SECURITY_SETTINGS_LIMITS.turnstileSitekeyCodePoints
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Expected a canonical Turnstile sitekey',
      });
    }
  }),
  z.null(),
]);

const edgeSecuritySettingsFields = {
  comment_write_verification_mode: edgeWriteVerificationModeSchema,
  newsletter_subscribe_verification_mode: edgeWriteVerificationModeSchema,
  form_submit_verification_mode: edgeWriteVerificationModeSchema,
} as const;

const ipAddressRetentionDaysSchema = z.number().int()
  .min(EDGE_SECURITY_SETTINGS_LIMITS.ipRetentionDaysMinimum)
  .max(EDGE_SECURITY_SETTINGS_LIMITS.ipRetentionDaysMaximum);

function requireTurnstileSitekey(
  value: {
    comment_write_verification_mode: EdgeWriteVerificationMode;
    newsletter_subscribe_verification_mode: EdgeWriteVerificationMode;
    form_submit_verification_mode: EdgeWriteVerificationMode;
    turnstile_sitekey: string | null;
  },
  context: z.RefinementCtx,
) {
  if (
    value.turnstile_sitekey === null
    && (
      value.comment_write_verification_mode === 'turnstile'
      || value.newsletter_subscribe_verification_mode === 'turnstile'
      || value.form_submit_verification_mode === 'turnstile'
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['turnstile_sitekey'],
      message: 'Turnstile mode requires a public sitekey',
    });
  }
}

export const edgeSecuritySettingsInputSchema = z.object({
  ...edgeSecuritySettingsFields,
  turnstile_sitekey: turnstileSitekeyInputSchema,
  ip_address_retention_days: ipAddressRetentionDaysSchema,
}).strict().superRefine(requireTurnstileSitekey);

export const edgeSecuritySettingsSchema = z.object({
  ...edgeSecuritySettingsFields,
  turnstile_sitekey: canonicalTurnstileSitekeySchema,
  ip_address_retention_days: ipAddressRetentionDaysSchema,
}).strict().superRefine(requireTurnstileSitekey);

export const updateEdgeSecuritySettingsRequestSchema = z.object({
  settings: edgeSecuritySettingsInputSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

export const edgeSecuritySettingsDocumentSchema = z.object({
  settings: edgeSecuritySettingsSchema,
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }),
}).strict();

export const edgeSecuritySettingsSuccessSchema = z.object({
  success: z.literal(true),
  data: edgeSecuritySettingsDocumentSchema,
}).strict();

export const edgeSecuritySettingsResponseSchema = z.union([
  edgeSecuritySettingsSuccessSchema,
  apiErrorSchema,
]);

export type EdgeSecuritySettings = z.infer<
  typeof edgeSecuritySettingsSchema
>;
export type EdgeSecuritySettingsDocument = z.infer<
  typeof edgeSecuritySettingsDocumentSchema
>;
export type EdgeSecuritySettingsResponse = z.infer<
  typeof edgeSecuritySettingsResponseSchema
>;
export type UpdateEdgeSecuritySettingsRequest = z.input<
  typeof updateEdgeSecuritySettingsRequestSchema
>;
export type NormalizedUpdateEdgeSecuritySettingsRequest = z.output<
  typeof updateEdgeSecuritySettingsRequestSchema
>;

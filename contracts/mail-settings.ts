import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from './settings-revision';

export const MAIL_SETTINGS_INITIAL_REVISION = SETTINGS_INITIAL_REVISION;
export const MAIL_PROVIDERS = ['disabled', 'resend', 'cloudflare'] as const;
export const MAIL_SETTINGS_LIMITS = {
  fromNameCodePoints: 100,
  credentialCodePoints: 4_096,
} as const;

export const MAIL_SETTINGS_DEFAULTS = Object.freeze({
  provider: 'disabled' as const,
  from_email: '',
  from_name: '',
  cloudflare_account_id: '',
});

function codePointLength(value: string): number {
  return [...value].length;
}

export function normalizeMailFromEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return normalized;
  return z.email().max(254).safeParse(normalized).success
    ? normalized
    : null;
}

export function normalizeMailFromName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return codePointLength(normalized) <= MAIL_SETTINGS_LIMITS.fromNameCodePoints
    && !/[\p{Cc}]/u.test(normalized)
    ? normalized
    : null;
}

export function normalizeCloudflareAccountId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === '' || /^[0-9a-f]{32}$/u.test(normalized)
    ? normalized
    : null;
}

const mailSettingsInputSchema = z.object({
  provider: z.enum(MAIL_PROVIDERS),
  from_email: z.string(),
  from_name: z.string(),
  cloudflare_account_id: z.string(),
}).strict().transform((value, context) => {
  const fromEmail = normalizeMailFromEmail(value.from_email);
  const fromName = normalizeMailFromName(value.from_name);
  const accountId = normalizeCloudflareAccountId(value.cloudflare_account_id);
  if (
    fromEmail === null
    || fromName === null
    || accountId === null
    || (value.provider !== 'disabled' && fromEmail === '')
    || (value.provider === 'cloudflare' && accountId === '')
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Expected canonical mail delivery settings',
    });
    return z.NEVER;
  }
  return {
    provider: value.provider,
    from_email: fromEmail,
    from_name: fromName,
    cloudflare_account_id: accountId,
  };
});

export const mailSettingsSchema = z.object({
  provider: z.enum(MAIL_PROVIDERS),
  from_email: z.string(),
  from_name: z.string(),
  cloudflare_account_id: z.string(),
}).strict().superRefine((value, context) => {
  const parsed = mailSettingsInputSchema.safeParse(value);
  if (!parsed.success || JSON.stringify(parsed.data) !== JSON.stringify(value)) {
    context.addIssue({ code: 'custom', message: 'Expected canonical mail delivery settings' });
  }
});

const credentialValueSchema = z.string()
  .min(1)
  .max(MAIL_SETTINGS_LIMITS.credentialCodePoints)
  .refine((value) => value.trim() === value && !/[\s\p{Cc}]/u.test(value));

export const mailCredentialActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preserve') }).strict(),
  z.object({ action: z.literal('remove') }).strict(),
  z.object({
    action: z.literal('replace'),
    value: credentialValueSchema,
  }).strict(),
]);

export const mailCredentialStatusSchema = z.object({
  resend_api_key_configured: z.boolean(),
  cloudflare_api_token_configured: z.boolean(),
}).strict();

export const mailSettingsDocumentSchema = z.object({
  settings: mailSettingsSchema,
  credentials: mailCredentialStatusSchema,
  configured: z.boolean(),
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const updateMailSettingsRequestSchema = z.object({
  settings: mailSettingsInputSchema,
  credentials: z.object({
    resend_api_key: mailCredentialActionSchema,
    cloudflare_api_token: mailCredentialActionSchema,
  }).strict(),
  expected_revision: settingsRevisionSchema,
}).strict();

export const mailSettingsSuccessSchema = z.object({
  success: z.literal(true),
  data: mailSettingsDocumentSchema,
}).strict();

export const mailSettingsResponseSchema = z.union([
  mailSettingsSuccessSchema,
  apiErrorSchema,
]);

export const testMailConnectionRequestSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('resend'),
    credential: credentialValueSchema.optional(),
  }).strict(),
  z.object({
    provider: z.literal('cloudflare'),
    cloudflare_account_id: z.string()
      .transform((value, context) => {
        const normalized = normalizeCloudflareAccountId(value);
        if (!normalized) {
          context.addIssue({ code: 'custom', message: 'Expected a Cloudflare account ID' });
          return z.NEVER;
        }
        return normalized;
      }),
    credential: credentialValueSchema.optional(),
  }).strict(),
]);

export const testMailConnectionSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('credential_verified'),
    provider: z.enum(['resend', 'cloudflare']),
  }).strict(),
}).strict();

export const testMailConnectionResponseSchema = z.union([
  testMailConnectionSuccessSchema,
  apiErrorSchema,
]);

export const sendTestMailRequestSchema = z.object({
  recipient: z.string().trim().toLowerCase().pipe(z.email().max(254)),
}).strict();

export const sendTestMailSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('accepted'),
    provider: z.enum(['resend', 'cloudflare']),
  }).strict(),
}).strict();

export const sendTestMailResponseSchema = z.union([
  sendTestMailSuccessSchema,
  apiErrorSchema,
]);

export type MailProvider = (typeof MAIL_PROVIDERS)[number];
export type MailSettings = z.infer<typeof mailSettingsSchema>;
export type MailSettingsDocument = z.infer<typeof mailSettingsDocumentSchema>;
export type UpdateMailSettingsRequest = z.input<
  typeof updateMailSettingsRequestSchema
>;
export type MailSettingsResponse = z.infer<typeof mailSettingsResponseSchema>;
export type TestMailConnectionRequest = z.input<
  typeof testMailConnectionRequestSchema
>;
export type TestMailConnectionResponse = z.infer<
  typeof testMailConnectionResponseSchema
>;
export type SendTestMailRequest = z.input<typeof sendTestMailRequestSchema>;
export type SendTestMailResponse = z.infer<typeof sendTestMailResponseSchema>;

export function materializeMailSettingsDefaults(): MailSettings {
  return { ...MAIL_SETTINGS_DEFAULTS };
}

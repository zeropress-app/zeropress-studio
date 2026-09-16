import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from './settings-revision';

export const GENERAL_SETTINGS_INITIAL_REVISION = SETTINGS_INITIAL_REVISION;
export const GENERAL_SETTINGS_LIMITS = {
  titleCodePoints: 200,
  descriptionCodePoints: 1_000,
  urlCodePoints: 2_048,
  localeCodePoints: 64,
  timezoneCodePoints: 128,
} as const;

export const GENERAL_SETTINGS_DEFAULTS = {
  title: 'ZeroPress',
  description: '',
  url: '',
  locale: 'en-US',
  timezone: 'UTC',
} as const;

export const GENERAL_SETTINGS_FIELDS = [
  'title',
  'description',
  'url',
  'locale',
  'timezone',
] as const;

function codePointLength(value: string): number {
  return [...value].length;
}

export function normalizeSiteTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0
    && codePointLength(normalized) <= GENERAL_SETTINGS_LIMITS.titleCodePoints
    ? normalized
    : null;
}

export function normalizeSiteDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return codePointLength(normalized)
    <= GENERAL_SETTINGS_LIMITS.descriptionCodePoints
    ? normalized
    : null;
}

export function normalizeSiteOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value === '') return value;
  if (
    codePointLength(value) > GENERAL_SETTINGS_LIMITS.urlCodePoints
    || value.trim() !== value
    || /[\s\\\p{Cc}]/u.test(value)
    || /%(?![0-9A-Fa-f]{2})/u.test(value)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || !/^https?:\/\/[^/?#]+\/?$/iu.test(value)
  ) {
    return null;
  }
  return parsed.origin;
}

export function normalizeSiteLocale(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value.length === 0
    || codePointLength(value) > GENERAL_SETTINGS_LIMITS.localeCodePoints
  ) {
    return null;
  }
  try {
    const canonical = Intl.getCanonicalLocales(value);
    return canonical.length === 1 ? canonical[0] ?? null : null;
  } catch {
    return null;
  }
}

export function normalizeSiteTimezone(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.trim() !== value
    || value.length === 0
    || codePointLength(value) > GENERAL_SETTINGS_LIMITS.timezoneCodePoints
  ) {
    return null;
  }
  if (value === 'UTC') return value;

  const offset = /^([+-])(\d{2}):(\d{2})$/u.exec(value);
  if (offset) {
    const hours = Number(offset[2]);
    const minutes = Number(offset[3]);
    if (
      hours > 14
      || minutes > 59
      || (hours === 14 && minutes !== 0)
    ) {
      return null;
    }
    return hours === 0 && minutes === 0 ? 'UTC' : value;
  }

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function normalizedString(
  normalize: (value: unknown) => string | null,
  message: string,
) {
  return z.string().transform((value, context) => {
    const normalized = normalize(value);
    if (normalized === null) {
      context.addIssue({ code: 'custom', message });
      return z.NEVER;
    }
    return normalized;
  });
}

function canonicalString(
  normalize: (value: unknown) => string | null,
  message: string,
) {
  return z.string().superRefine((value, context) => {
    if (normalize(value) !== value) {
      context.addIssue({ code: 'custom', message });
    }
  });
}

const titleMessage = 'Expected a non-empty site title of at most 200 Unicode code points';
const descriptionMessage = 'Expected a site description of at most 1000 Unicode code points';
const originMessage = 'Expected an empty string or a canonical HTTP(S) origin';
const localeMessage = 'Expected a canonicalizable BCP 47 locale';
const timezoneMessage = 'Expected UTC, an IANA time zone, or a fixed offset within +/-14:00';

export const generalSettingsInputSchema = z.object({
  title: normalizedString(normalizeSiteTitle, titleMessage),
  description: normalizedString(
    normalizeSiteDescription,
    descriptionMessage,
  ),
  url: normalizedString(normalizeSiteOrigin, originMessage),
  locale: normalizedString(normalizeSiteLocale, localeMessage),
  timezone: normalizedString(normalizeSiteTimezone, timezoneMessage),
}).strict();

export const generalSettingsSchema = z.object({
  title: canonicalString(normalizeSiteTitle, titleMessage),
  description: canonicalString(
    normalizeSiteDescription,
    descriptionMessage,
  ),
  url: canonicalString(normalizeSiteOrigin, originMessage),
  locale: canonicalString(normalizeSiteLocale, localeMessage),
  timezone: canonicalString(normalizeSiteTimezone, timezoneMessage),
}).strict();

export const generalSettingsRevisionSchema = settingsRevisionSchema;

export const updateGeneralSettingsRequestSchema = z.object({
  settings: generalSettingsInputSchema,
  expected_revision: generalSettingsRevisionSchema,
}).strict();

export const generalSettingsDocumentSchema = z.object({
  settings: generalSettingsSchema,
  revision: generalSettingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const generalSettingsSuccessSchema = z.object({
  success: z.literal(true),
  data: generalSettingsDocumentSchema,
}).strict();

export const generalSettingsFieldSchema = z.enum(GENERAL_SETTINGS_FIELDS);

const generalSettingsMissingFieldsSchema = z.array(generalSettingsFieldSchema)
  .min(1)
  .max(GENERAL_SETTINGS_FIELDS.length)
  .refine((fields) => new Set(fields).size === fields.length, {
    message: 'Expected unique missing General Settings fields',
  });

export const generalSettingsRecoveryPlanSchema = z.object({
  expected_revision: generalSettingsRevisionSchema,
  missing_fields: generalSettingsMissingFieldsSchema,
  proposed_settings: generalSettingsSchema,
}).strict();

export const generalSettingsIncompleteResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.literal('SITE_SETTINGS_INCOMPLETE'),
    recovery: generalSettingsRecoveryPlanSchema,
  }).strict(),
}).strict();

export const repairGeneralSettingsRequestSchema = z.object({
  expected_revision: generalSettingsRevisionSchema,
  missing_fields: generalSettingsMissingFieldsSchema,
}).strict();

export const generalSettingsResponseSchema = z.union([
  generalSettingsSuccessSchema,
  generalSettingsIncompleteResponseSchema,
  apiErrorSchema,
]);

export type GeneralSettings = z.infer<typeof generalSettingsSchema>;
export type GeneralSettingsField = z.infer<
  typeof generalSettingsFieldSchema
>;
export type GeneralSettingsRecoveryPlan = z.infer<
  typeof generalSettingsRecoveryPlanSchema
>;
export type RepairGeneralSettingsRequest = z.infer<
  typeof repairGeneralSettingsRequestSchema
>;
export type UpdateGeneralSettingsRequest = z.input<
  typeof updateGeneralSettingsRequestSchema
>;
export type NormalizedUpdateGeneralSettingsRequest = z.output<
  typeof updateGeneralSettingsRequestSchema
>;
export type GeneralSettingsSuccess = z.infer<
  typeof generalSettingsSuccessSchema
>;
export type GeneralSettingsResponse = z.infer<
  typeof generalSettingsResponseSchema
>;

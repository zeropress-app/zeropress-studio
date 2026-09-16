import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from './settings-revision';

export const NEWSLETTER_SETTINGS_INITIAL_REVISION = SETTINGS_INITIAL_REVISION;

export const NEWSLETTER_SETTINGS_LIMITS = {
  titleCodePoints: 200,
  descriptionCodePoints: 2_000,
  buttonLabelCodePoints: 200,
  urlCodePoints: 2_048,
} as const;

export const NEWSLETTER_SETTINGS_DEFAULTS = Object.freeze({
  enabled: false,
  title: '',
  description: '',
  button_label: 'Subscribe',
  signup_url: '',
  embed_url: '',
});

const UNSAFE_URL_CHARACTERS = /[\s\\\p{Cc}]/u;
const MALFORMED_PERCENT = /%(?![0-9A-Fa-f]{2})/u;

function codePointLength(value: string): number {
  return [...value].length;
}

function normalizeBoundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return codePointLength(normalized) <= maximum ? normalized : null;
}

function hasDotPathSegment(pathname: string): boolean {
  for (const segment of pathname.split('/')) {
    try {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..') return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Preview Data v0.7 navigation URL normalization. Empty draft values remain empty. */
export function normalizeNewsletterNavigationUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value === '') return value;
  if (
    value.trim() !== value
    || codePointLength(value) > NEWSLETTER_SETTINGS_LIMITS.urlCodePoints
    || UNSAFE_URL_CHARACTERS.test(value)
    || MALFORMED_PERCENT.test(value)
  ) {
    return null;
  }

  const pathname = value.split(/[?#]/u, 1)[0] ?? '';
  if (value.startsWith('/')) {
    return value.startsWith('//') || hasDotPathSegment(pathname)
      ? null
      : value;
  }
  if (value.startsWith('./') || value.startsWith('../')) return null;
  if (!/^https?:\/\//iu.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || !parsed.hostname
    || parsed.username
    || parsed.password
  ) {
    return null;
  }
  const authoredPath = value.match(
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(?<path>[^?#]*)/u,
  )?.groups?.path ?? '/';
  return hasDotPathSegment(authoredPath) ? null : value;
}

export function normalizeNewsletterSettings(value: unknown) {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!raw || typeof raw.enabled !== 'boolean') return null;
  const title = normalizeBoundedText(
    raw.title,
    NEWSLETTER_SETTINGS_LIMITS.titleCodePoints,
  );
  const description = normalizeBoundedText(
    raw.description,
    NEWSLETTER_SETTINGS_LIMITS.descriptionCodePoints,
  );
  const buttonLabel = normalizeBoundedText(
    raw.button_label,
    NEWSLETTER_SETTINGS_LIMITS.buttonLabelCodePoints,
  );
  const signupUrl = normalizeNewsletterNavigationUrl(raw.signup_url);
  const embedUrl = normalizeNewsletterNavigationUrl(raw.embed_url);
  if (
    title === null
    || description === null
    || buttonLabel === null
    || signupUrl === null
    || embedUrl === null
    || (raw.enabled && !signupUrl && !embedUrl)
  ) {
    return null;
  }
  return {
    enabled: raw.enabled,
    title,
    description,
    button_label: buttonLabel,
    signup_url: signupUrl,
    embed_url: embedUrl,
  };
}

const newsletterSettingsInputSchema = z.object({
  enabled: z.boolean(),
  title: z.string(),
  description: z.string(),
  button_label: z.string(),
  signup_url: z.string(),
  embed_url: z.string(),
}).strict().transform((value, context) => {
  const normalized = normalizeNewsletterSettings(value);
  if (!normalized) {
    context.addIssue({
      code: 'custom',
      message: 'Expected canonical Preview Data v0.7 newsletter CTA settings',
    });
    return z.NEVER;
  }
  return normalized;
});

export const newsletterSettingsSchema = z.object({
  enabled: z.boolean(),
  title: z.string(),
  description: z.string(),
  button_label: z.string(),
  signup_url: z.string(),
  embed_url: z.string(),
}).strict().superRefine((value, context) => {
  const normalized = normalizeNewsletterSettings(value);
  if (!normalized || JSON.stringify(normalized) !== JSON.stringify(value)) {
    context.addIssue({
      code: 'custom',
      message: 'Expected canonical Preview Data v0.7 newsletter CTA settings',
    });
  }
});

export type NewsletterSettings = z.infer<typeof newsletterSettingsSchema>;

export function materializeNewsletterSettingsDefaults(): NewsletterSettings {
  return { ...NEWSLETTER_SETTINGS_DEFAULTS };
}

export const updateNewsletterSettingsRequestSchema = z.object({
  settings: newsletterSettingsInputSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

export const newsletterSettingsDocumentSchema = z.object({
  settings: newsletterSettingsSchema,
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const newsletterSettingsSuccessSchema = z.object({
  success: z.literal(true),
  data: newsletterSettingsDocumentSchema,
}).strict();

export const newsletterSettingsResponseSchema = z.union([
  newsletterSettingsSuccessSchema,
  apiErrorSchema,
]);

export type NewsletterSettingsDocument = z.infer<
  typeof newsletterSettingsDocumentSchema
>;
export type NewsletterSettingsResponse = z.infer<
  typeof newsletterSettingsResponseSchema
>;
export type UpdateNewsletterSettingsRequest = z.input<
  typeof updateNewsletterSettingsRequestSchema
>;

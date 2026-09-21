import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  SETTINGS_INITIAL_REVISION,
  settingsRevisionSchema,
} from './settings-revision';

export const ANALYTICS_INITIAL_REVISION = SETTINGS_INITIAL_REVISION;
export const ANALYTICS_DEFAULTS = {
  enabled: false,
  account_id: '',
  site_tag: '',
} as const;
const accountId = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:[0-9a-f]{32})?$/u);
const siteTag = z
  .string()
  .trim()
  .max(128)
  .regex(/^[A-Za-z0-9_-]*$/u);
const token = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\s\p{Cc}]+$/u);

export const analyticsSettingsSchema = z
  .object({
    enabled: z.boolean(),
    account_id: accountId,
    site_tag: siteTag,
  })
  .strict()
  .refine(
    (value) => !value.enabled || Boolean(value.account_id && value.site_tag),
  );
export const analyticsCredentialActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preserve') }).strict(),
  z.object({ action: z.literal('remove') }).strict(),
  z.object({ action: z.literal('replace'), value: token }).strict(),
]);
export const analyticsSettingsDocumentSchema = z
  .object({
    settings: analyticsSettingsSchema,
    token_configured: z.boolean(),
    configured: z.boolean(),
    revision: settingsRevisionSchema,
    updated_at_iso: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export const updateAnalyticsSettingsSchema = z
  .object({
    settings: analyticsSettingsSchema,
    credential: analyticsCredentialActionSchema,
    expected_revision: settingsRevisionSchema,
  })
  .strict();
export const testAnalyticsConnectionSchema = z
  .object({
    account_id: accountId.refine(Boolean),
    site_tag: siteTag.refine(Boolean),
    credential: token.optional(),
  })
  .strict();
export const analyticsPeriodSchema = z.enum([
  '30m',
  '6h',
  '12h',
  '24h',
  '3d',
  '7d',
  '14d',
  '21d',
  '30d',
]);
export const ANALYTICS_DEFAULT_PERIOD: AnalyticsPeriod = '24h';
const metric = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const analyticsMetricsSchema = z
  .object({ pageviews: metric, visits: metric })
  .strict();
export const analyticsSummarySchema = z
  .object({
    period: analyticsPeriodSchema,
    hostname: z.string().min(1),
    timezone: z.string().min(1),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    generated_at_iso: z.iso.datetime({ offset: true }),
    total: analyticsMetricsSchema,
    daily: z
      .array(analyticsMetricsSchema.extend({ date: z.iso.date() }))
      // A rolling 30-day range can intersect 32 local dates across a DST change.
      .max(32),
    top_paths: z
      .array(analyticsMetricsSchema.extend({ value: z.string().min(1) }))
      .max(10),
    top_referrers: z
      .array(analyticsMetricsSchema.extend({ value: z.string() }))
      .max(10),
  })
  .strict();
export const analyticsSettingsResponseSchema = z.union([
  z
    .object({ success: z.literal(true), data: analyticsSettingsDocumentSchema })
    .strict(),
  apiErrorSchema,
]);
export const analyticsSummaryResponseSchema = z.union([
  z.object({ success: z.literal(true), data: analyticsSummarySchema }).strict(),
  apiErrorSchema,
]);
export const analyticsConnectionResponseSchema = z.union([
  z
    .object({
      success: z.literal(true),
      data: z.object({ status: z.enum(['data_found', 'no_data']) }).strict(),
    })
    .strict(),
  apiErrorSchema,
]);
export type AnalyticsSettings = z.infer<typeof analyticsSettingsSchema>;
export type AnalyticsSettingsDocument = z.infer<
  typeof analyticsSettingsDocumentSchema
>;
export type UpdateAnalyticsSettings = z.infer<
  typeof updateAnalyticsSettingsSchema
>;
export type TestAnalyticsConnection = z.infer<
  typeof testAnalyticsConnectionSchema
>;
export type AnalyticsPeriod = z.infer<typeof analyticsPeriodSchema>;
export type AnalyticsMetrics = z.infer<typeof analyticsMetricsSchema>;
export type AnalyticsSummary = z.infer<typeof analyticsSummarySchema>;

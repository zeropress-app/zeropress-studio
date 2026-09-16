import { z } from 'zod';
import { apiErrorSchema } from './api';

export const NEWSLETTER_DEFAULT_PAGE_SIZE = 20;
export const NEWSLETTER_MAX_PAGE_SIZE = 100;
export const NEWSLETTER_MAX_FIELDS = 50;
export const NEWSLETTER_MAX_OPTIONS = 50;
export const NEWSLETTER_MAX_OPTION_LENGTH = 120;

const KEYCAP_EMOJI_PATTERN = /[0-9#*]\uFE0F?\u20E3/gu;
const EMOJI_PATTERN = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Regional_Indicator}]/gu;
const EMOJI_FORMAT_PATTERN = /[\u200D\uFE0E\uFE0F]/gu;
const CONTROL_CHARACTERS_EXCEPT_LF_AND_TAB = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const EDGE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const newsletterIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const newsletterStatusSchema = z.enum(['active', 'archived']);
export const newsletterSubscriptionStatusSchema = z.enum([
  'pending',
  'subscribed',
  'unsubscribed',
]);
export const newsletterConfirmationStatusSchema = z.enum([
  'not_sent',
  'sent',
  'failed',
]);
export const newsletterDeliveryTypeSchema = z.enum([
  'confirmation',
  'post_notification',
]);
export const newsletterDeliveryStatusSchema = z.enum([
  'queued',
  'sent',
  'failed',
  'skipped',
]);
export const newsletterDeliveryProviderSchema = z.enum([
  'resend',
  'cloudflare',
]);
export const newsletterFieldTypeSchema = z.enum([
  'text',
  'textarea',
  'number',
  'url',
  'boolean',
  'select',
  'radio',
  'checkbox',
]);
export const newsletterFieldStatusSchema = z.enum(['active', 'disabled']);
export const newsletterSuppressionReasonSchema = z.enum([
  'bounce',
  'complaint',
  'manual',
  'invalid',
]);

const timestampSchema = z.iso.datetime({ offset: true });
const nullableTimestampSchema = timestampSchema.nullable();
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine(
  (value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime())
      && date.toISOString().slice(0, 10) === value;
  },
  { message: 'Expected a calendar date.' },
);

export function normalizeEdgeNewsletterSingleLine(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(KEYCAP_EMOJI_PATTERN, '')
    .replace(EMOJI_PATTERN, '')
    .replace(EMOJI_FORMAT_PATTERN, '')
    .replace(CONTROL_CHARACTERS_EXCEPT_LF_AND_TAB, '')
    .replace(/[\t\n]+/gu, ' ')
    .trim();
}

const edgeEmailSchema = z.string().trim().superRefine((value, context) => {
  if (normalizeEdgeNewsletterSingleLine(value) !== value) {
    context.addIssue({
      code: 'custom',
      message: 'Email contains unsupported characters.',
    });
  }
}).transform((value) => value.toLowerCase()).pipe(
  z.string().min(1).max(254).regex(EDGE_EMAIL_PATTERN),
);

const pageSchema = z.coerce.number().int().positive().max(1_000_000)
  .default(1);
const perPageSchema = z.coerce.number().int().positive()
  .max(NEWSLETTER_MAX_PAGE_SIZE)
  .default(NEWSLETTER_DEFAULT_PAGE_SIZE);

export const newsletterPaginationSchema = z.object({
  page: z.number().int().positive(),
  per_page: z.number().int().positive().max(NEWSLETTER_MAX_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
}).strict();

export const newsletterSummarySchema = z.object({
  id: newsletterIdSchema,
  slug: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  description: z.string().max(2_000).nullable(),
  status: newsletterStatusSchema,
  fields_count: z.number().int().nonnegative(),
  subscriptions_count: z.number().int().nonnegative(),
  pending_count: z.number().int().nonnegative(),
  subscribed_count: z.number().int().nonnegative(),
  unsubscribed_count: z.number().int().nonnegative(),
  created_at_iso: timestampSchema,
  updated_at_iso: timestampSchema,
}).strict();

export const newsletterRuntimeSchema = z.object({
  confirmation_enabled: z.boolean(),
  mail_configured: z.boolean(),
  ready: z.boolean(),
  updated_at_iso: timestampSchema,
}).strict().superRefine((value, context) => {
  if (value.ready !== (value.confirmation_enabled && value.mail_configured)) {
    context.addIssue({
      code: 'custom',
      path: ['ready'],
      message: 'Newsletter runtime readiness is inconsistent.',
    });
  }
});

export const newsletterRuntimeSuccessSchema = z.object({
  success: z.literal(true),
  data: newsletterRuntimeSchema,
}).strict();

export const newsletterRuntimeResponseSchema = z.union([
  newsletterRuntimeSuccessSchema,
  apiErrorSchema,
]);

export const updateNewsletterRuntimeRequestSchema = z.object({
  confirmation_enabled: z.boolean(),
  expected_updated_at_iso: timestampSchema,
}).strict();

export const newsletterListQuerySchema = z.object({
  status: z.enum(['all', ...newsletterStatusSchema.options]).default('all'),
  search: z.string().trim().max(200).default(''),
  page: pageSchema,
  per_page: perPageSchema,
}).strict();

export const newsletterListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(newsletterSummarySchema).max(NEWSLETTER_MAX_PAGE_SIZE),
    pagination: newsletterPaginationSchema,
  }).strict(),
}).strict();

export const newsletterListResponseSchema = z.union([
  newsletterListSuccessSchema,
  apiErrorSchema,
]);

export const newsletterDetailSuccessSchema = z.object({
  success: z.literal(true),
  data: newsletterSummarySchema,
}).strict();

export const newsletterDetailResponseSchema = z.union([
  newsletterDetailSuccessSchema,
  apiErrorSchema,
]);

export const updateNewsletterRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2_000).nullable().optional(),
  status: newsletterStatusSchema.optional(),
  expected_updated_at_iso: timestampSchema,
}).strict().superRefine((value, context) => {
  if (
    value.title === undefined
    && value.description === undefined
    && value.status === undefined
  ) {
    context.addIssue({
      code: 'custom',
      message: 'At least one newsletter field must be changed.',
    });
  }
});

export const newsletterOptionSchema = z.object({
  value: z.string().transform(normalizeEdgeNewsletterSingleLine).pipe(
    z.string().min(1).max(NEWSLETTER_MAX_OPTION_LENGTH),
  ),
  label: z.string().trim().min(1).max(NEWSLETTER_MAX_OPTION_LENGTH),
}).strict();

export const newsletterFieldInputSchema = z.object({
  id: newsletterIdSchema.optional(),
  field_key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  label: z.string().trim().min(1).max(200),
  type: newsletterFieldTypeSchema,
  required: z.boolean(),
  options: z.array(newsletterOptionSchema).max(NEWSLETTER_MAX_OPTIONS),
  sort_order: z.number().int().min(0).max(100_000),
  status: newsletterFieldStatusSchema,
}).strict().superRefine((field, context) => {
  const usesOptions = field.type === 'select'
    || field.type === 'radio'
    || field.type === 'checkbox';
  if (usesOptions && field.options.length === 0) {
    context.addIssue({ code: 'custom', path: ['options'], message: 'Options are required.' });
  }
  if (!usesOptions && field.options.length > 0) {
    context.addIssue({ code: 'custom', path: ['options'], message: 'Options are not allowed.' });
  }
  const values = new Set<string>();
  field.options.forEach((option, index) => {
    if (values.has(option.value)) {
      context.addIssue({
        code: 'custom',
        path: ['options', index, 'value'],
        message: 'Option values must be unique.',
      });
    }
    values.add(option.value);
  });
});

export const newsletterFieldSchema = newsletterFieldInputSchema.safeExtend({
  id: newsletterIdSchema,
  newsletter_id: newsletterIdSchema,
  created_at_iso: timestampSchema,
  updated_at_iso: timestampSchema,
});

export const newsletterFieldsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(newsletterFieldSchema).max(NEWSLETTER_MAX_FIELDS),
    newsletter_updated_at_iso: timestampSchema,
  }).strict(),
}).strict();

export const newsletterFieldsResponseSchema = z.union([
  newsletterFieldsSuccessSchema,
  apiErrorSchema,
]);

export const replaceNewsletterFieldsRequestSchema = z.object({
  fields: z.array(newsletterFieldInputSchema).max(NEWSLETTER_MAX_FIELDS),
  expected_updated_at_iso: timestampSchema,
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const keys = new Set<string>();
  value.fields.forEach((field, index) => {
    if (field.id && ids.has(field.id)) {
      context.addIssue({ code: 'custom', path: ['fields', index, 'id'], message: 'Field IDs must be unique.' });
    }
    if (keys.has(field.field_key)) {
      context.addIssue({ code: 'custom', path: ['fields', index, 'field_key'], message: 'Field keys must be unique.' });
    }
    if (field.id) ids.add(field.id);
    keys.add(field.field_key);
  });
});

export const newsletterSubscriptionSchema = z.object({
  id: newsletterIdSchema,
  newsletter_id: newsletterIdSchema,
  email: edgeEmailSchema,
  status: newsletterSubscriptionStatusSchema,
  confirmation_status: newsletterConfirmationStatusSchema,
  confirm_sent_at_iso: nullableTimestampSchema,
  confirmed_at_iso: nullableTimestampSchema,
  subscribed_at_iso: nullableTimestampSchema,
  unsubscribed_at_iso: nullableTimestampSchema,
  source_url: z.string().url().nullable(),
  country_code: z.string().regex(/^[A-Z]{2}$/u).nullable(),
  created_at_iso: timestampSchema,
  updated_at_iso: timestampSchema,
}).strict();

export const newsletterFieldValueSchema = z.object({
  field_id: newsletterIdSchema,
  field_key: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  type: newsletterFieldTypeSchema,
  value: z.string(),
}).strict();

export const newsletterSubscriptionDetailSchema = newsletterSubscriptionSchema.extend({
  values: z.array(newsletterFieldValueSchema).max(NEWSLETTER_MAX_FIELDS),
});

export const newsletterSubscriptionsQuerySchema = z.object({
  status: z.enum(['all', ...newsletterSubscriptionStatusSchema.options])
    .default('all'),
  search: z.string().trim().toLowerCase().max(254).default(''),
  page: pageSchema,
  per_page: perPageSchema,
}).strict();

export const exportNewsletterSubscriptionsQuerySchema = z.object({
  status: z.enum(['all', ...newsletterSubscriptionStatusSchema.options])
    .default('all'),
  from: isoDateSchema.optional(),
  to: isoDateSchema.refine((value) => !value.startsWith('9999-')).optional(),
}).strict().superRefine((value, context) => {
  if (value.from && value.to && value.from > value.to) {
    context.addIssue({
      code: 'custom',
      path: ['to'],
      message: 'End date must not precede start date.',
    });
  }
});

export const newsletterSubscriptionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(newsletterSubscriptionSchema)
      .max(NEWSLETTER_MAX_PAGE_SIZE),
    pagination: newsletterPaginationSchema,
  }).strict(),
}).strict();

export const newsletterSubscriptionsResponseSchema = z.union([
  newsletterSubscriptionsSuccessSchema,
  apiErrorSchema,
]);

export const newsletterDeliverySchema = z.object({
  id: newsletterIdSchema,
  newsletter_id: newsletterIdSchema,
  subscription_id: newsletterIdSchema,
  email: edgeEmailSchema,
  delivery_type: newsletterDeliveryTypeSchema,
  content_id: newsletterIdSchema.nullable(),
  subject: z.string().min(1).max(998).nullable(),
  provider: newsletterDeliveryProviderSchema.nullable(),
  status: newsletterDeliveryStatusSchema,
  attempt_count: z.number().int().nonnegative(),
  failure_code: z.string().min(1).max(100).nullable(),
  queued_at_iso: timestampSchema,
  last_attempt_at_iso: nullableTimestampSchema,
  sent_at_iso: nullableTimestampSchema,
  created_at_iso: timestampSchema,
  updated_at_iso: timestampSchema,
}).strict();

export const newsletterDeliveriesQuerySchema = z.object({
  status: z.enum(['all', ...newsletterDeliveryStatusSchema.options])
    .default('all'),
  type: z.enum(['all', ...newsletterDeliveryTypeSchema.options])
    .default('all'),
  content_id: newsletterIdSchema.optional(),
  search: z.string().trim().toLowerCase().max(254).default(''),
  page: pageSchema,
  per_page: perPageSchema,
}).strict();

export const newsletterDeliveriesSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(newsletterDeliverySchema).max(NEWSLETTER_MAX_PAGE_SIZE),
    pagination: newsletterPaginationSchema,
  }).strict(),
}).strict();

export const newsletterDeliveriesResponseSchema = z.union([
  newsletterDeliveriesSuccessSchema,
  apiErrorSchema,
]);

export const newsletterSubscriptionDetailSuccessSchema = z.object({
  success: z.literal(true),
  data: newsletterSubscriptionDetailSchema,
}).strict();

export const newsletterSubscriptionDetailResponseSchema = z.union([
  newsletterSubscriptionDetailSuccessSchema,
  apiErrorSchema,
]);

export const newsletterSubscriptionMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: newsletterSubscriptionSchema,
}).strict();

export const newsletterSubscriptionMutationResponseSchema = z.union([
  newsletterSubscriptionMutationSuccessSchema,
  apiErrorSchema,
]);

export const newsletterSubscriptionDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    deleted: z.literal(true),
    subscriber_deleted: z.boolean(),
  }).strict(),
}).strict();

export const newsletterSubscriptionDeleteResponseSchema = z.union([
  newsletterSubscriptionDeleteSuccessSchema,
  apiErrorSchema,
]);

export const newsletterSuppressionSchema = z.object({
  id: newsletterIdSchema,
  email: edgeEmailSchema,
  reason: newsletterSuppressionReasonSchema,
  source: z.string().min(1).max(100),
  note: z.string().max(1_000).nullable(),
  created_at_iso: timestampSchema,
}).strict();

export const newsletterSuppressionsQuerySchema = z.object({
  reason: z.enum(['all', ...newsletterSuppressionReasonSchema.options])
    .default('all'),
  search: z.string().trim().toLowerCase().max(254).default(''),
  page: pageSchema,
  per_page: perPageSchema,
}).strict();

export const newsletterSuppressionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(newsletterSuppressionSchema).max(NEWSLETTER_MAX_PAGE_SIZE),
    pagination: newsletterPaginationSchema,
  }).strict(),
}).strict();

export const newsletterSuppressionsResponseSchema = z.union([
  newsletterSuppressionsSuccessSchema,
  apiErrorSchema,
]);

export const createNewsletterSuppressionRequestSchema = z.object({
  email: edgeEmailSchema,
  note: z.string().trim().max(1_000).nullable(),
}).strict();

export const newsletterSuppressionMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    suppression: newsletterSuppressionSchema,
    created: z.boolean(),
    unsubscribed_count: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const newsletterSuppressionMutationResponseSchema = z.union([
  newsletterSuppressionMutationSuccessSchema,
  apiErrorSchema,
]);

export const newsletterSuppressionDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({ deleted: z.literal(true) }).strict(),
}).strict();

export const newsletterSuppressionDeleteResponseSchema = z.union([
  newsletterSuppressionDeleteSuccessSchema,
  apiErrorSchema,
]);

export type NewsletterListQuery = z.infer<typeof newsletterListQuerySchema>;
export type NewsletterSummary = z.infer<typeof newsletterSummarySchema>;
export type NewsletterRuntime = z.infer<typeof newsletterRuntimeSchema>;
export type UpdateNewsletterRuntimeRequest = z.infer<
  typeof updateNewsletterRuntimeRequestSchema
>;
export type UpdateNewsletterRequest = z.infer<
  typeof updateNewsletterRequestSchema
>;
export type NewsletterFieldInput = z.infer<
  typeof newsletterFieldInputSchema
>;
export type NewsletterField = z.infer<typeof newsletterFieldSchema>;
export type ReplaceNewsletterFieldsRequest = z.infer<
  typeof replaceNewsletterFieldsRequestSchema
>;
export type NewsletterSubscriptionsQuery = z.infer<
  typeof newsletterSubscriptionsQuerySchema
>;
export type NewsletterDeliveriesQuery = z.infer<
  typeof newsletterDeliveriesQuerySchema
>;
export type NewsletterDelivery = z.infer<typeof newsletterDeliverySchema>;
export type ExportNewsletterSubscriptionsQuery = z.infer<
  typeof exportNewsletterSubscriptionsQuerySchema
>;
export type NewsletterSubscription = z.infer<
  typeof newsletterSubscriptionSchema
>;
export type NewsletterSubscriptionDetail = z.infer<
  typeof newsletterSubscriptionDetailSchema
>;
export type NewsletterSuppressionsQuery = z.infer<
  typeof newsletterSuppressionsQuerySchema
>;
export type NewsletterSuppression = z.infer<
  typeof newsletterSuppressionSchema
>;
export type CreateNewsletterSuppressionRequest = z.infer<
  typeof createNewsletterSuppressionRequestSchema
>;
export type NewsletterListResponse = z.infer<
  typeof newsletterListResponseSchema
>;
export type NewsletterDetailResponse = z.infer<
  typeof newsletterDetailResponseSchema
>;
export type NewsletterFieldsResponse = z.infer<
  typeof newsletterFieldsResponseSchema
>;
export type NewsletterRuntimeResponse = z.infer<
  typeof newsletterRuntimeResponseSchema
>;
export type NewsletterSubscriptionsResponse = z.infer<
  typeof newsletterSubscriptionsResponseSchema
>;
export type NewsletterDeliveriesResponse = z.infer<
  typeof newsletterDeliveriesResponseSchema
>;
export type NewsletterSubscriptionDetailResponse = z.infer<
  typeof newsletterSubscriptionDetailResponseSchema
>;
export type NewsletterSubscriptionMutationResponse = z.infer<
  typeof newsletterSubscriptionMutationResponseSchema
>;
export type NewsletterSubscriptionDeleteResponse = z.infer<
  typeof newsletterSubscriptionDeleteResponseSchema
>;
export type NewsletterSuppressionsResponse = z.infer<
  typeof newsletterSuppressionsResponseSchema
>;
export type NewsletterSuppressionMutationResponse = z.infer<
  typeof newsletterSuppressionMutationResponseSchema
>;
export type NewsletterSuppressionDeleteResponse = z.infer<
  typeof newsletterSuppressionDeleteResponseSchema
>;

import { z } from 'zod';
import { apiErrorSchema } from './api';
import { userIdSchema } from './users';

export const FORM_DEFAULT_PAGE_SIZE = 20;
export const FORM_MAX_PAGE_SIZE = 100;
export const FORM_MAX_FIELDS = 50;
export const FORM_MAX_OPTIONS = 50;
export const FORM_MAX_OPTION_LENGTH = 120;
export const FORM_NOTIFICATION_RECIPIENT_DEFAULT_PAGE_SIZE = 20;
export const FORM_NOTIFICATION_RECIPIENT_MAX_PAGE_SIZE = 50;

const KEYCAP_EMOJI_PATTERN = /[0-9#*]\uFE0F?\u20E3/gu;
const EMOJI_PATTERN = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Regional_Indicator}]/gu;
const EMOJI_FORMAT_PATTERN = /[\u200D\uFE0E\uFE0F]/gu;
const CONTROL_CHARACTERS_EXCEPT_LF_AND_TAB = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

export const formIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const formSlugSchema = z.string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u);
export const formStatusSchema = z.enum([
  'draft',
  'active',
  'disabled',
  'archived',
]);
export const formFieldTypeSchema = z.enum([
  'text',
  'textarea',
  'email',
  'number',
  'date',
  'select',
  'radio',
  'checkbox',
  'phone',
]);
export const formFieldStatusSchema = z.enum(['active', 'disabled']);
export const formSubmissionStatusSchema = z.enum([
  'unread',
  'read',
  'archived',
  'spam',
]);

const timestampSchema = z.iso.datetime({ offset: true });
const nullableTimestampSchema = timestampSchema.nullable();
const pageSchema = z.coerce.number().int().positive().max(1_000_000)
  .default(1);
const perPageSchema = z.coerce.number().int().positive()
  .max(FORM_MAX_PAGE_SIZE)
  .default(FORM_DEFAULT_PAGE_SIZE);
const nullableTrimmedString = (maximum: number) => z.string()
  .trim()
  .max(maximum)
  .nullable();

export function normalizeEdgeFormSingleLine(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(KEYCAP_EMOJI_PATTERN, '')
    .replace(EMOJI_PATTERN, '')
    .replace(EMOJI_FORMAT_PATTERN, '')
    .replace(CONTROL_CHARACTERS_EXCEPT_LF_AND_TAB, '')
    .replace(/[\t\n]+/gu, ' ')
    .trim();
}

export const formPaginationSchema = z.object({
  page: z.number().int().positive(),
  per_page: z.number().int().positive().max(FORM_MAX_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
}).strict();

export const formStatusCountsSchema = z.object({
  all: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  archived: z.number().int().nonnegative(),
  spam: z.number().int().nonnegative(),
}).strict();

export const formSummarySchema = z.object({
  id: formIdSchema,
  slug: formSlugSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(2_000).nullable(),
  status: formStatusSchema,
  submit_label: z.string().min(1).max(80),
  success_message: z.string().max(2_000).nullable(),
  fields_count: z.number().int().nonnegative(),
  submissions_count: z.number().int().nonnegative(),
  unread_count: z.number().int().nonnegative(),
  last_submitted_at_iso: nullableTimestampSchema,
  created_at_iso: timestampSchema,
  updated_at_iso: timestampSchema,
}).strict();

export const formListQuerySchema = z.object({
  status: z.enum(['all', ...formStatusSchema.options]).default('all'),
  search: z.string().trim().max(200).default(''),
  page: pageSchema,
  per_page: perPageSchema,
}).strict();

export const formListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(formSummarySchema).max(FORM_MAX_PAGE_SIZE),
    pagination: formPaginationSchema,
  }).strict(),
}).strict();
export const formListResponseSchema = z.union([
  formListSuccessSchema,
  apiErrorSchema,
]);

export const formDetailSuccessSchema = z.object({
  success: z.literal(true),
  data: formSummarySchema,
}).strict();
export const formDetailResponseSchema = z.union([
  formDetailSuccessSchema,
  apiErrorSchema,
]);

export const createFormRequestSchema = z.object({
  slug: formSlugSchema,
  title: z.string().trim().min(1).max(200),
  description: nullableTrimmedString(2_000).default(null),
  status: formStatusSchema.default('draft'),
  submit_label: z.string().trim().min(1).max(80).default('Submit'),
  success_message: nullableTrimmedString(2_000).default(null),
}).strict();

export const updateFormRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: nullableTrimmedString(2_000).optional(),
  status: formStatusSchema.optional(),
  submit_label: z.string().trim().min(1).max(80).optional(),
  success_message: nullableTrimmedString(2_000).optional(),
  expected_updated_at_iso: timestampSchema,
}).strict().superRefine((value, context) => {
  if (
    value.title === undefined
    && value.description === undefined
    && value.status === undefined
    && value.submit_label === undefined
    && value.success_message === undefined
  ) {
    context.addIssue({
      code: 'custom',
      message: 'At least one form field must be changed.',
    });
  }
});

export const formNotificationRecipientCandidateQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
  page: pageSchema,
  per_page: z.coerce.number().int().positive()
    .max(FORM_NOTIFICATION_RECIPIENT_MAX_PAGE_SIZE)
    .default(FORM_NOTIFICATION_RECIPIENT_DEFAULT_PAGE_SIZE),
}).strict();

export const formNotificationRecipientIdentitySchema = z.object({
  id: userIdSchema,
  name: z.string().trim().min(2).max(100),
  email: z.email().max(254),
}).strict();

export const formNotificationRecipientSchema = z.discriminatedUnion('state', [
  formNotificationRecipientIdentitySchema.extend({
    state: z.literal('available'),
  }),
  z.object({
    state: z.literal('unavailable'),
    id: userIdSchema,
    name: z.string().trim().min(2).max(100).nullable(),
    email: z.email().max(254).nullable(),
  }).strict(),
]);

export const formNotificationRecipientCandidatesSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(formNotificationRecipientIdentitySchema)
      .max(FORM_NOTIFICATION_RECIPIENT_MAX_PAGE_SIZE),
    pagination: formPaginationSchema.extend({
      per_page: z.number().int().positive()
        .max(FORM_NOTIFICATION_RECIPIENT_MAX_PAGE_SIZE),
    }),
  }).strict(),
}).strict();
export const formNotificationRecipientCandidatesResponseSchema = z.union([
  formNotificationRecipientCandidatesSuccessSchema,
  apiErrorSchema,
]);

export const formNotificationSettingsSchema = z.object({
  recipient: formNotificationRecipientSchema.nullable(),
  mail_configured: z.boolean(),
  form_updated_at_iso: timestampSchema,
}).strict();

export const formNotificationSettingsSuccessSchema = z.object({
  success: z.literal(true),
  data: formNotificationSettingsSchema,
}).strict();
export const formNotificationSettingsResponseSchema = z.union([
  formNotificationSettingsSuccessSchema,
  apiErrorSchema,
]);

export const updateFormNotificationSettingsRequestSchema = z.object({
  recipient_user_id: userIdSchema.nullable(),
  expected_updated_at_iso: timestampSchema,
}).strict();

export const deleteFormRequestSchema = z.object({
  expected_updated_at_iso: timestampSchema,
}).strict();

export const formOptionSchema = z.object({
  value: z.string().transform(normalizeEdgeFormSingleLine).pipe(
    z.string().min(1).max(FORM_MAX_OPTION_LENGTH),
  ),
  label: z.string().trim().min(1).max(FORM_MAX_OPTION_LENGTH),
}).strict();

export const formFieldInputSchema = z.object({
  id: formIdSchema.optional(),
  field_key: z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  label: z.string().trim().min(1).max(200),
  type: formFieldTypeSchema,
  required: z.boolean(),
  placeholder: nullableTrimmedString(200),
  help_text: nullableTrimmedString(1_000),
  options: z.array(formOptionSchema).max(FORM_MAX_OPTIONS),
  sort_order: z.number().int().min(0).max(100_000),
  status: formFieldStatusSchema,
}).strict().superRefine((field, context) => {
  const usesOptions = field.type === 'select'
    || field.type === 'radio'
    || field.type === 'checkbox';
  if (usesOptions && field.options.length === 0) {
    context.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'Options are required.',
    });
  }
  if (!usesOptions && field.options.length > 0) {
    context.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'Options are not allowed.',
    });
  }
  const optionValues = new Set<string>();
  field.options.forEach((option, index) => {
    if (optionValues.has(option.value)) {
      context.addIssue({
        code: 'custom',
        path: ['options', index, 'value'],
        message: 'Option values must be unique.',
      });
    }
    optionValues.add(option.value);
  });
});

export const formFieldSchema = formFieldInputSchema.safeExtend({
  id: formIdSchema,
  form_id: formIdSchema,
  created_at_iso: timestampSchema,
  updated_at_iso: timestampSchema,
});

export const replaceFormFieldsRequestSchema = z.object({
  fields: z.array(formFieldInputSchema).max(FORM_MAX_FIELDS),
  expected_updated_at_iso: timestampSchema,
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const keys = new Set<string>();
  value.fields.forEach((field, index) => {
    if (field.id && ids.has(field.id)) {
      context.addIssue({
        code: 'custom',
        path: ['fields', index, 'id'],
        message: 'Field IDs must be unique.',
      });
    }
    if (keys.has(field.field_key)) {
      context.addIssue({
        code: 'custom',
        path: ['fields', index, 'field_key'],
        message: 'Field keys must be unique.',
      });
    }
    if (field.id) ids.add(field.id);
    keys.add(field.field_key);
  });
});

export const formFieldsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(formFieldSchema).max(FORM_MAX_FIELDS),
    form_updated_at_iso: timestampSchema,
  }).strict(),
}).strict();
export const formFieldsResponseSchema = z.union([
  formFieldsSuccessSchema,
  apiErrorSchema,
]);

export const formSubmissionSchema = z.object({
  id: formIdSchema,
  form_id: formIdSchema,
  status: formSubmissionStatusSchema,
  summary: z.string().max(1_000).nullable(),
  submitter_email: z.email().max(254).nullable(),
  submitter_name: z.string().max(200).nullable(),
  source_url: z.url().nullable(),
  country_code: z.string().regex(/^[A-Z]{2}$/u).nullable(),
  submitted_at_iso: timestampSchema,
  read_at_iso: nullableTimestampSchema,
  archived_at_iso: nullableTimestampSchema,
  created_at_iso: timestampSchema,
  updated_at_iso: timestampSchema,
}).strict();

export const formSubmissionValueSchema = z.object({
  field_id: formIdSchema.nullable(),
  field_key: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  type: formFieldTypeSchema,
  value: z.string(),
}).strict();

export const formSubmissionDetailSchema = formSubmissionSchema.extend({
  values: z.array(formSubmissionValueSchema).max(FORM_MAX_FIELDS),
});

export const formSubmissionsQuerySchema = z.object({
  status: z.enum(['all', ...formSubmissionStatusSchema.options])
    .default('all'),
  page: pageSchema,
  per_page: perPageSchema,
}).strict();

export const formSubmissionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(formSubmissionSchema).max(FORM_MAX_PAGE_SIZE),
    pagination: formPaginationSchema,
    status_counts: formStatusCountsSchema,
  }).strict(),
}).strict();
export const formSubmissionsResponseSchema = z.union([
  formSubmissionsSuccessSchema,
  apiErrorSchema,
]);

export const formSubmissionDetailSuccessSchema = z.object({
  success: z.literal(true),
  data: formSubmissionDetailSchema,
}).strict();
export const formSubmissionDetailResponseSchema = z.union([
  formSubmissionDetailSuccessSchema,
  apiErrorSchema,
]);

export const updateFormSubmissionRequestSchema = z.object({
  status: formSubmissionStatusSchema,
  expected_updated_at_iso: timestampSchema,
}).strict();

export const formSubmissionMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: formSubmissionSchema,
}).strict();
export const formSubmissionMutationResponseSchema = z.union([
  formSubmissionMutationSuccessSchema,
  apiErrorSchema,
]);

export const deleteFormSubmissionRequestSchema = z.object({
  expected_updated_at_iso: timestampSchema,
}).strict();
export const formDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({ deleted: z.literal(true) }).strict(),
}).strict();
export const formDeleteResponseSchema = z.union([
  formDeleteSuccessSchema,
  apiErrorSchema,
]);

export type FormSummary = z.infer<typeof formSummarySchema>;
export type FormListQuery = z.infer<typeof formListQuerySchema>;
export type CreateFormRequest = z.infer<typeof createFormRequestSchema>;
export type UpdateFormRequest = z.infer<typeof updateFormRequestSchema>;
export type FormField = z.infer<typeof formFieldSchema>;
export type FormFieldInput = z.infer<typeof formFieldInputSchema>;
export type ReplaceFormFieldsRequest = z.infer<typeof replaceFormFieldsRequestSchema>;
export type FormSubmission = z.infer<typeof formSubmissionSchema>;
export type FormSubmissionDetail = z.infer<typeof formSubmissionDetailSchema>;
export type FormSubmissionsQuery = z.infer<typeof formSubmissionsQuerySchema>;
export type FormSubmissionStatus = z.infer<typeof formSubmissionStatusSchema>;
export type FormNotificationRecipientCandidateQuery = z.infer<
  typeof formNotificationRecipientCandidateQuerySchema
>;
export type FormNotificationRecipientIdentity = z.infer<
  typeof formNotificationRecipientIdentitySchema
>;
export type FormNotificationSettings = z.infer<
  typeof formNotificationSettingsSchema
>;
export type UpdateFormNotificationSettingsRequest = z.infer<
  typeof updateFormNotificationSettingsRequestSchema
>;

import { describe, expect, it } from 'vitest';
import {
  createNewsletterSuppressionRequestSchema,
  exportNewsletterSubscriptionsQuerySchema,
  newsletterDeliveriesQuerySchema,
  newsletterDeliverySchema,
  newsletterFieldInputSchema,
  newsletterListQuerySchema,
  newsletterRuntimeSchema,
  replaceNewsletterFieldsRequestSchema,
} from './newsletters';

describe('Newsletter management contracts', () => {
  it('materializes bounded list-query defaults and rejects unknown keys', () => {
    expect(newsletterListQuerySchema.parse({})).toEqual({
      status: 'all',
      search: '',
      page: 1,
      per_page: 20,
    });
    expect(newsletterListQuerySchema.safeParse({ extra: true }).success)
      .toBe(false);
    expect(newsletterListQuerySchema.safeParse({ per_page: 101 }).success)
      .toBe(false);
  });

  it('keeps option-bearing field rules and replacement identity closed', () => {
    const base = {
      field_key: 'topics',
      label: 'Topics',
      type: 'checkbox' as const,
      required: false,
      options: [{ value: 'platform', label: 'Platform' }],
      sort_order: 0,
      status: 'active' as const,
    };
    expect(newsletterFieldInputSchema.safeParse(base).success).toBe(true);
    expect(newsletterFieldInputSchema.safeParse({
      ...base,
      type: 'text',
    }).success).toBe(false);
    expect(newsletterFieldInputSchema.safeParse({
      ...base,
      options: [
        { value: 'same', label: 'First' },
        { value: 'same', label: 'Second' },
      ],
    }).success).toBe(false);
    expect(replaceNewsletterFieldsRequestSchema.safeParse({
      fields: [base, { ...base, label: 'Duplicate key' }],
      expected_updated_at_iso: '2026-08-04T00:00:00Z',
    }).success).toBe(false);
  });

  it('requires runtime readiness to reflect both switches', () => {
    expect(newsletterRuntimeSchema.safeParse({
      confirmation_enabled: true,
      mail_configured: true,
      ready: true,
      updated_at_iso: '2026-08-04T00:00:00Z',
    }).success).toBe(true);
    expect(newsletterRuntimeSchema.safeParse({
      confirmation_enabled: true,
      mail_configured: false,
      ready: true,
      updated_at_iso: '2026-08-04T00:00:00Z',
    }).success).toBe(false);
  });

  it('normalizes suppression email while rejecting Edge-unsupported input', () => {
    expect(createNewsletterSuppressionRequestSchema.parse({
      email: ' Reader@Example.COM ',
      note: null,
    }).email).toBe('reader@example.com');
    expect(createNewsletterSuppressionRequestSchema.safeParse({
      email: 'reader😀@example.com',
      note: null,
    }).success).toBe(false);
  });

  it('validates inclusive export dates and a closed status filter', () => {
    expect(exportNewsletterSubscriptionsQuerySchema.parse({})).toEqual({
      status: 'all',
    });
    expect(exportNewsletterSubscriptionsQuerySchema.safeParse({
      status: 'subscribed',
      from: '2026-08-01',
      to: '2026-08-04',
    }).success).toBe(true);
    expect(exportNewsletterSubscriptionsQuerySchema.safeParse({
      from: '2026-08-04',
      to: '2026-08-01',
    }).success).toBe(false);
    expect(exportNewsletterSubscriptionsQuerySchema.safeParse({
      from: '2026-02-30',
    }).success).toBe(false);
  });

  it('keeps delivery-ledger filters and rows closed', () => {
    expect(newsletterDeliveriesQuerySchema.parse({})).toEqual({
      status: 'all',
      type: 'all',
      search: '',
      page: 1,
      per_page: 20,
    });
    expect(newsletterDeliveriesQuerySchema.safeParse({
      status: 'unknown',
    }).success).toBe(false);
    expect(newsletterDeliveriesQuerySchema.safeParse({
      content_id: 'a'.repeat(32),
    }).success).toBe(true);
    expect(newsletterDeliveriesQuerySchema.safeParse({
      content_id: 'not-a-post-id',
    }).success).toBe(false);
    expect(newsletterDeliveriesQuerySchema.safeParse({
      extra: true,
    }).success).toBe(false);

    const delivery = {
      id: '1234567890abcdef1234567890abcdef',
      newsletter_id: '2234567890abcdef1234567890abcdef',
      subscription_id: '3234567890abcdef1234567890abcdef',
      email: 'reader@example.com',
      delivery_type: 'confirmation' as const,
      content_id: null,
      subject: 'Confirm your subscription',
      provider: 'resend' as const,
      status: 'sent' as const,
      attempt_count: 1,
      failure_code: null,
      queued_at_iso: '2026-09-03T00:00:00Z',
      last_attempt_at_iso: '2026-09-03T00:00:01Z',
      sent_at_iso: '2026-09-03T00:00:02Z',
      created_at_iso: '2026-09-03T00:00:00Z',
      updated_at_iso: '2026-09-03T00:00:02Z',
    };
    expect(newsletterDeliverySchema.safeParse(delivery).success).toBe(true);
    expect(newsletterDeliverySchema.safeParse({
      ...delivery,
      recipient_name: 'Not part of the contract',
    }).success).toBe(false);
  });
});

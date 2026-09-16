import { describe, expect, it } from 'vitest';
import { dashboardSummarySchema } from './dashboard';

const base = {
  generated_at_iso: '2026-08-04T00:00:00.000Z',
  content: {
    posts: {
      access: { scope: 'all' as const },
      total: 3,
      draft: 1,
      published: 2,
      trash: 0,
    },
    pages: null,
    media: { total: 2, managed: 1, external: 1 },
  },
  mail: { configured: true },
  content_search_index: { state: 'ready' as const },
  edge: {
    status: 'available' as const,
    pending_target_events: 0,
    comments: { pending: 1, enabled: true, api_configured: true },
    forms: { unread_submissions: 1 },
    newsletters: null,
  },
};

describe('Dashboard summary contract', () => {
  it('accepts a bounded capability-filtered summary', () => {
    expect(dashboardSummarySchema.parse(base)).toEqual(base);
    expect(dashboardSummarySchema.safeParse({
      ...base,
      edge: { status: 'unavailable', pending_target_events: 2 },
    }).success).toBe(true);
    expect(dashboardSummarySchema.safeParse({
      ...base,
      edge: { status: 'disabled', pending_target_events: 0 },
    }).success).toBe(true);
    expect(dashboardSummarySchema.safeParse({
      ...base,
      edge: { status: 'projection_pending', pending_target_events: 2 },
    }).success).toBe(true);
    expect(dashboardSummarySchema.safeParse({
      ...base,
      edge: {
        ...base.edge,
        status: 'reconciliation_required',
        pending_target_events: 0,
      },
    }).success).toBe(true);
    expect(dashboardSummarySchema.safeParse({
      ...base,
      edge: {
        ...base.edge,
        status: 'reconciliation_required',
        pending_target_events: 1,
      },
    }).success).toBe(false);
  });

  it('rejects inconsistent content aggregate counts and readiness', () => {
    expect(dashboardSummarySchema.safeParse({
      ...base,
      content: {
        ...base.content,
        posts: {
          access: { scope: 'all' },
          total: 4,
          draft: 1,
          published: 2,
          trash: 0,
        },
      },
    }).success).toBe(false);
    expect(dashboardSummarySchema.safeParse({
      ...base,
      edge: {
        ...base.edge,
        newsletters: {
          pending_confirmations: 1,
          confirmation_enabled: false,
          confirmation_ready: true,
        },
      },
    }).success).toBe(false);
  });

  it('rejects unknown fields in nested Edge summaries', () => {
    expect(dashboardSummarySchema.safeParse({
      ...base,
      edge: {
        ...base.edge,
        comments: { ...base.edge.comments, unexpected: true },
      },
    }).success).toBe(false);
  });
});

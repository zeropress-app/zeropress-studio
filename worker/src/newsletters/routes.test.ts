import { describe, expect, it, vi } from 'vitest';
import type { NewsletterSummary } from '../../../contracts/newsletters';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createNewsletterRoutes as createNewsletterRoutesImpl } from './routes';

function createNewsletterRoutes(
  dependencies: Parameters<typeof createNewsletterRoutesImpl>[0],
) {
  return createNewsletterRoutesImpl({
    ...dependencies,
    readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
    inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
      state: 'ready', reason: 'ready', currentSchemaVersion: 3,
    }),
  });
}

const LIST_ID = '1'.repeat(32);
const POST_ID = '7'.repeat(32);
const CSRF_TOKEN = 'c'.repeat(43);
const NOW = new Date('2026-08-04T00:00:00.000Z');
const newsletter = {
  id: LIST_ID,
  slug: 'default',
  title: 'Newsletter',
  description: null,
  status: 'active',
  fields_count: 0,
  subscriptions_count: 0,
  pending_count: 0,
  subscribed_count: 0,
  unsubscribed_count: 0,
  created_at_iso: '2026-08-01T00:00:00.000Z',
  updated_at_iso: '2026-08-01T00:00:00.000Z',
} as const satisfies NewsletterSummary;

function session(role: 'admin' | 'editor' = 'admin'): ResolvedSession {
  return {
    user: {
      id: '2'.repeat(32),
      email: 'owner@example.com',
      name: 'Owner',
      roles: [role],
    },
    session: { id: '3'.repeat(32) },
    csrfToken: CSRF_TOKEN,
    authRevision: '4'.repeat(32),
    mfaVerifiedAtIso: NOW.toISOString(),
  } as ResolvedSession;
}

function env(): Env {
  return {
    DB: {} as D1Database,
    EDGE_DB: {} as D1Database,
    EDGE_KV: {} as KVNamespace,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: { limit: vi.fn() },
  };
}

function mutation(path: string, method: 'PATCH' | 'PUT', body: unknown) {
  return new Request(`https://studio.local${path}`, {
    method,
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

describe('Newsletter management routes', () => {
  it('allows administrators to list Newsletter runtime data and denies editors', async () => {
    const list = vi.fn().mockResolvedValue({
      items: [newsletter],
      pagination: { page: 1, per_page: 20, total: 1, total_pages: 1 },
    });
    const routes = createNewsletterRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      list,
    });
    const response = await routes.fetch(new Request(
      'https://studio.local/?status=all&page=1&per_page=20',
    ), env());
    expect(response.status).toBe(200);
    expect(list).toHaveBeenCalledWith({
      edgeDb: expect.anything(),
      query: { status: 'all', search: '', page: 1, per_page: 20 },
    });

    const denied = createNewsletterRoutes({
      resolveSession: vi.fn().mockResolvedValue(session('editor')),
      list,
    });
    expect((await denied.fetch(new Request('https://studio.local/'), env()))
      .status).toBe(403);
  });

  it('requires same-origin CSRF before updating and invalidates the exact public cache', async () => {
    const update = vi.fn().mockResolvedValue({
      kind: 'completed',
      value: { ...newsletter, title: 'Product updates' },
    });
    const invalidateCache = vi.fn().mockResolvedValue(undefined);
    const routes = createNewsletterRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      update,
      invalidateCache,
      now: () => NOW,
    });
    const body = {
      title: 'Product updates',
      expected_updated_at_iso: newsletter.updated_at_iso,
    };
    const response = await routes.fetch(
      mutation(`/${LIST_ID}`, 'PATCH', body),
      env(),
    );
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      edgeDb: expect.anything(),
      id: LIST_ID,
      update: body,
      now: NOW,
    });
    expect(invalidateCache).toHaveBeenCalledWith({
      edgeKv: expect.anything(),
      slug: 'default',
    });

    const crossOrigin = mutation(`/${LIST_ID}`, 'PATCH', body);
    crossOrigin.headers.set('Origin', 'https://attacker.example');
    expect((await routes.fetch(crossOrigin, env())).status).toBe(403);
    expect(update).toHaveBeenCalledOnce();
  });

  it('maps runtime mail gating and optimistic revision conflicts', async () => {
    const updateRuntime = vi.fn()
      .mockResolvedValueOnce({ kind: 'mail_not_configured' })
      .mockResolvedValueOnce({ kind: 'revision_conflict' });
    const routes = createNewsletterRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      readMailSettings: vi.fn().mockResolvedValue({ configured: false }),
      updateRuntime,
    });
    const request = () => mutation('/runtime', 'PUT', {
      confirmation_enabled: true,
      expected_updated_at_iso: newsletter.updated_at_iso,
    });
    const unavailable = await routes.fetch(request(), env());
    expect(unavailable.status).toBe(409);
    await expect(unavailable.json()).resolves.toEqual({
      success: false,
      error: { code: 'NEWSLETTER_MAIL_NOT_CONFIGURED' },
    });
    const conflict = await routes.fetch(request(), env());
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      success: false,
      error: { code: 'NEWSLETTER_REVISION_CONFLICT' },
    });
  });

  it('exports a bounded CSV with private caching disabled', async () => {
    const exportSubscriptions = vi.fn().mockResolvedValue({
      newsletter,
      chunks: [new TextEncoder().encode('\uFEFF"email"\r\n')],
      rowCount: 0,
      byteCount: 12,
      truncated: false,
      truncationReason: null,
      rowLimit: 400,
      byteLimit: 2 * 1024 * 1024,
    });
    const routes = createNewsletterRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      exportSubscriptions,
      now: () => NOW,
    });
    const response = await routes.fetch(new Request(
      `https://studio.local/${LIST_ID}/subscriptions/export.csv?status=all`,
    ), env());
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="newsletter-default-2026-08-04.csv"',
    );
    expect(response.headers.get('X-Export-Truncated')).toBe('false');
    // Body text decoding consumes the UTF-8 BOM emitted for spreadsheet
    // interoperability.
    expect(await response.text()).toBe('"email"\r\n');
  });

  it('lists strict delivery history for the selected Newsletter', async () => {
    const listDeliveries = vi.fn().mockResolvedValue({
      items: [{
        id: '5'.repeat(32),
        newsletter_id: LIST_ID,
        subscription_id: '6'.repeat(32),
        email: 'reader@example.com',
        delivery_type: 'confirmation',
        content_id: null,
        subject: 'Confirm your subscription',
        provider: 'resend',
        status: 'sent',
        attempt_count: 1,
        failure_code: null,
        queued_at_iso: NOW.toISOString(),
        last_attempt_at_iso: NOW.toISOString(),
        sent_at_iso: NOW.toISOString(),
        created_at_iso: NOW.toISOString(),
        updated_at_iso: NOW.toISOString(),
      }],
      pagination: { page: 1, per_page: 20, total: 1, total_pages: 1 },
    });
    const routes = createNewsletterRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      listDeliveries,
    });
    const response = await routes.fetch(new Request(
      `https://studio.local/${LIST_ID}/deliveries?status=sent&type=confirmation&content_id=${POST_ID}&search=reader%40&page=1&per_page=20`,
    ), env());

    expect(response.status).toBe(200);
    expect(listDeliveries).toHaveBeenCalledWith({
      edgeDb: expect.anything(),
      newsletterId: LIST_ID,
      query: {
        status: 'sent',
        type: 'confirmation',
        content_id: POST_ID,
        search: 'reader@',
        page: 1,
        per_page: 20,
      },
    });

    const deniedListDeliveries = vi.fn();
    const denied = createNewsletterRoutes({
      resolveSession: vi.fn().mockResolvedValue(session('editor')),
      listDeliveries: deniedListDeliveries,
    });
    expect((await denied.fetch(new Request(
      `https://studio.local/${LIST_ID}/deliveries?content_id=${POST_ID}`,
    ), env())).status).toBe(403);
    expect(deniedListDeliveries).not.toHaveBeenCalled();
  });

  it('does not query Newsletter runtime while Edge integration is disabled', async () => {
    const list = vi.fn();
    const routes = createNewsletterRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(session()),
      readEdgeIntegrationMode: vi.fn().mockResolvedValue('disabled'),
      list,
    });
    const response = await routes.fetch(
      new Request('https://studio.local/'), env(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_INTEGRATION_DISABLED' },
    });
    expect(list).not.toHaveBeenCalled();
  });
});

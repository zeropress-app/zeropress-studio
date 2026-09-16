import { describe, expect, it, vi } from 'vitest';
import type { FormSummary } from '../../../contracts/forms';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createFormRoutes as createFormRoutesImpl } from './routes';

function createFormRoutes(
  dependencies: Parameters<typeof createFormRoutesImpl>[0],
) {
  return createFormRoutesImpl({
    ...dependencies,
    readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
    inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
      state: 'ready', reason: 'ready', currentSchemaVersion: 3,
    }),
  });
}

const FORM_ID = '1'.repeat(32);
const SUBMISSION_ID = '2'.repeat(32);
const CSRF_TOKEN = 'c'.repeat(43);
const NOW = new Date('2026-08-04T00:00:00.000Z');
const form = {
  id: FORM_ID,
  slug: 'contact',
  title: 'Contact',
  description: null,
  status: 'active',
  submit_label: 'Send',
  success_message: null,
  fields_count: 1,
  submissions_count: 0,
  unread_count: 0,
  last_submitted_at_iso: null,
  created_at_iso: '2026-08-01T00:00:00.000Z',
  updated_at_iso: '2026-08-01T00:00:00.000Z',
} as const satisfies FormSummary;

function session(role: 'admin' | 'editor' | 'author' = 'admin'): ResolvedSession {
  return {
    user: { id: '3'.repeat(32), email: 'owner@example.com', name: 'Owner', roles: [role] },
    session: { id: '4'.repeat(32) },
    csrfToken: CSRF_TOKEN,
    authRevision: '5'.repeat(32),
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

function mutation(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown) {
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

describe('Form management routes', () => {
  it('allows editors to list Forms while denying authors', async () => {
    const list = vi.fn().mockResolvedValue({
      items: [form],
      pagination: { page: 1, per_page: 20, total: 1, total_pages: 1 },
    });
    const allowed = createFormRoutes({
      resolveSession: vi.fn().mockResolvedValue(session('editor')),
      list,
    });
    expect((await allowed.fetch(new Request(
      'https://studio.local/?status=all&page=1&per_page=20',
    ), env())).status).toBe(200);
    const denied = createFormRoutes({
      resolveSession: vi.fn().mockResolvedValue(session('author')),
      list,
    });
    expect((await denied.fetch(new Request('https://studio.local/'), env())).status).toBe(403);
  });

  it('requires same-origin CSRF and invalidates the current v2 public Form cache', async () => {
    const update = vi.fn().mockResolvedValue({
      kind: 'completed', value: { ...form, title: 'Contact us' },
    });
    const invalidateCache = vi.fn().mockResolvedValue(undefined);
    const routes = createFormRoutes({
      resolveSession: vi.fn().mockResolvedValue(session('editor')),
      update,
      invalidateCache,
      now: () => NOW,
    });
    const body = {
      title: 'Contact us',
      expected_updated_at_iso: form.updated_at_iso,
    };
    const response = await routes.fetch(mutation(`/${FORM_ID}`, 'PATCH', body), env());
    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ edgeDb: expect.anything(), id: FORM_ID, update: body, now: NOW });
    expect(invalidateCache).toHaveBeenCalledWith({ edgeKv: expect.anything(), slug: 'contact' });
    const crossOrigin = mutation(`/${FORM_ID}`, 'PATCH', body);
    crossOrigin.headers.set('Origin', 'https://attacker.example');
    expect((await routes.fetch(crossOrigin, env())).status).toBe(403);
  });

  it('maps protected Form deletion and unavailable notification recipients', async () => {
    const remove = vi.fn().mockResolvedValue({ kind: 'has_submissions' });
    const updateNotificationSettings = vi.fn()
      .mockResolvedValue({ kind: 'recipient_unavailable' });
    const routes = createFormRoutes({
      resolveSession: vi.fn().mockResolvedValue(session()),
      remove,
      updateNotificationSettings,
      readMailSettings: vi.fn().mockResolvedValue({ configured: false }),
    });
    const deletion = await routes.fetch(mutation(`/${FORM_ID}`, 'DELETE', {
      expected_updated_at_iso: form.updated_at_iso,
    }), env());
    expect(deletion.status).toBe(409);
    await expect(deletion.json()).resolves.toEqual({
      success: false, error: { code: 'FORM_HAS_SUBMISSIONS' },
    });
    const notification = await routes.fetch(mutation(
      `/${FORM_ID}/notification-settings`,
      'PUT',
      {
      recipient_user_id: '9'.repeat(32),
      expected_updated_at_iso: form.updated_at_iso,
      },
    ), env());
    expect(notification.status).toBe(409);
    await expect(notification.json()).resolves.toEqual({
      success: false,
      error: { code: 'FORM_NOTIFICATION_RECIPIENT_NOT_AVAILABLE' },
    });
  });

  it('updates a target-scoped submission with optimistic concurrency', async () => {
    const updated = {
      id: SUBMISSION_ID,
      form_id: FORM_ID,
      status: 'read',
      summary: 'Hello',
      submitter_email: null,
      submitter_name: null,
      source_url: null,
      country_code: null,
      submitted_at_iso: '2026-08-01T00:00:00.000Z',
      read_at_iso: NOW.toISOString(),
      archived_at_iso: null,
      created_at_iso: '2026-08-01T00:00:00.000Z',
      updated_at_iso: NOW.toISOString(),
    } as const;
    const updateSubmission = vi.fn().mockResolvedValue({ kind: 'completed', value: updated });
    const routes = createFormRoutes({
      resolveSession: vi.fn().mockResolvedValue(session('editor')),
      updateSubmission,
      now: () => NOW,
    });
    const response = await routes.fetch(mutation(
      `/${FORM_ID}/submissions/${SUBMISSION_ID}`,
      'PATCH',
      { status: 'read', expected_updated_at_iso: form.updated_at_iso },
    ), env());
    expect(response.status).toBe(200);
    expect(updateSubmission).toHaveBeenCalledWith({
      edgeDb: expect.anything(),
      formId: FORM_ID,
      submissionId: SUBMISSION_ID,
      status: 'read',
      expectedUpdatedAtIso: form.updated_at_iso,
      now: NOW,
    });
  });

  it('does not query Forms runtime while Edge integration is disabled', async () => {
    const list = vi.fn();
    const routes = createFormRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(session('editor')),
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

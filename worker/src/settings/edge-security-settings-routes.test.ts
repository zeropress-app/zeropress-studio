import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import {
  createEdgeSecuritySettingsRoutes as createEdgeSecuritySettingsRoutesImpl,
} from './edge-security-settings-routes';

function createEdgeSecuritySettingsRoutes(
  dependencies: Parameters<typeof createEdgeSecuritySettingsRoutesImpl>[0],
) {
  return createEdgeSecuritySettingsRoutesImpl({
    ...dependencies,
    readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
    inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
      state: 'ready', reason: 'ready', currentSchemaVersion: 3,
    }),
  });
}

const NOW = new Date('2026-08-05T03:00:00.000Z');
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const REVISION = '1'.repeat(32);
const administratorSession = {
  user: {
    id: '2'.repeat(32),
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: { id: '3'.repeat(32) },
  csrfToken: CSRF_TOKEN,
  authRevision: '4'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;
const document = {
  settings: {
    comment_write_verification_mode: 'pow' as const,
    newsletter_subscribe_verification_mode: 'pow' as const,
    form_submit_verification_mode: 'pow' as const,
    turnstile_sitekey: null,
    ip_address_retention_days: 30,
  },
  revision: REVISION,
  updated_at_iso: '2026-08-05T01:00:00Z',
};

function env(includeEdgeDb = true): Env {
  return {
    DB: {} as D1Database,
    ...(includeEdgeDb ? { EDGE_DB: {} as D1Database } : {}),
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

function mutationRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://studio.local/', {
    method: 'PUT',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF_TOKEN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('Edge public request security routes', () => {
  it('allows only a settings manager to read the runtime policy', async () => {
    const readSettings = vi.fn().mockResolvedValue(document);
    const routes = createEdgeSecuritySettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      readSettings,
    });
    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(response.status).toBe(200);
    expect(readSettings).toHaveBeenCalledWith({ edgeDb: expect.anything() });

    const editorRoutes = createEdgeSecuritySettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
      readSettings,
    });
    expect((await editorRoutes.fetch(
      new Request('https://studio.local/'),
      env(),
    )).status).toBe(403);
  });

  it('writes one complete normalized policy with revision and CSRF guards', async () => {
    const settings = {
      comment_write_verification_mode: 'turnstile' as const,
      newsletter_subscribe_verification_mode: 'pow' as const,
      form_submit_verification_mode: 'pow' as const,
      turnstile_sitekey: '0x4AAAAA-test',
      ip_address_retention_days: 45,
    };
    const nextDocument = {
      settings,
      revision: '5'.repeat(32),
      updated_at_iso: '2026-08-05T03:00:00Z',
    };
    const updateSettings = vi.fn().mockResolvedValue({
      kind: 'completed',
      document: nextDocument,
    });
    const routes = createEdgeSecuritySettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
      now: () => NOW,
    });
    const response = await routes.fetch(mutationRequest({
      settings: {
        ...settings,
        turnstile_sitekey: ' 0x4AAAAA-test ',
      },
      expected_revision: REVISION,
    }), env());
    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      edgeDb: expect.anything(),
      settings,
      expectedRevision: REVISION,
      now: NOW,
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: nextDocument,
    });
  });

  it('rejects missing sitekeys, cross-origin requests, and invalid CSRF', async () => {
    const updateSettings = vi.fn();
    const routes = createEdgeSecuritySettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
    });
    const invalidBody = {
      settings: {
        ...document.settings,
        comment_write_verification_mode: 'turnstile',
      },
      expected_revision: REVISION,
    };
    expect((await routes.fetch(mutationRequest(invalidBody), env())).status)
      .toBe(400);

    const validBody = {
      settings: document.settings,
      expected_revision: REVISION,
    };
    expect((await routes.fetch(mutationRequest(validBody, {
      Origin: 'https://other.example',
    }), env())).status).toBe(403);
    expect((await routes.fetch(mutationRequest(validBody, {
      'X-ZeroPress-CSRF': 'wrong-token',
    }), env())).status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('does not read Edge Security while integration is disabled', async () => {
    const readSettings = vi.fn();
    const routes = createEdgeSecuritySettingsRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      readEdgeIntegrationMode: vi.fn().mockResolvedValue('disabled'),
      readSettings,
    });
    const response = await routes.fetch(
      new Request('https://studio.local/'), env(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_INTEGRATION_DISABLED' },
    });
    expect(readSettings).not.toHaveBeenCalled();
  });
});

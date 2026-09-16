import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createCloudflareAccessRoutes } from './routes';

const NOW = new Date('2026-08-28T03:00:00.000Z');
const USER_ID = '1'.repeat(32);
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const REVISION = '2'.repeat(32);
const identity = {
  issuer: 'https://zeropress.cloudflareaccess.com',
  team_domain: 'zeropress',
  audience: 'a'.repeat(64),
  identity_email: 'owner@example.com',
};
const administratorSession = {
  user: {
    id: USER_ID,
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: { id: '3'.repeat(32) },
  csrfToken: CSRF_TOKEN,
  authRevision: '4'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;
const disabledDocument = {
  settings: {
    mode: 'disabled' as const,
    issuer: null,
    audience: null,
    bound_origin: null,
    verified_at_iso: null,
  },
  revision: REVISION,
  updated_at_iso: NOW.toISOString(),
};

function env(): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

describe('Cloudflare Access settings routes', () => {
  it('requires settings.manage before inspecting Access', async () => {
    const readSettings = vi.fn();
    const routes = createCloudflareAccessRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
      readSettings,
    });
    expect((await routes.fetch(
      new Request('https://studio.example.com/'),
      env(),
    )).status).toBe(403);
    expect(readSettings).not.toHaveBeenCalled();
  });

  it('reports verified Access without exposing the assertion', async () => {
    const verifyAssertion = vi.fn().mockResolvedValue({
      state: 'verified', identity,
    });
    const routes = createCloudflareAccessRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      readSettings: vi.fn().mockResolvedValue(disabledDocument),
      verifyAssertion,
    });
    const response = await routes.fetch(new Request(
      'https://studio.example.com/',
      { headers: { 'Cf-Access-Jwt-Assertion': 'signed-token' } },
    ), env());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      data: {
        ...disabledDocument,
        detection_state: 'verified',
        detected: identity,
      },
    });
    expect(JSON.stringify(body)).not.toContain('signed-token');
  });

  it('keeps the normal administrator settings endpoint read-only', async () => {
    const readSettings = vi.fn();
    const routes = createCloudflareAccessRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      readSettings,
    });
    const response = await routes.fetch(new Request(
      'https://studio.example.com/', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'required',
          expected_revision: REVISION,
        }),
      },
    ), env());
    expect(response.status).toBe(404);
    expect(readSettings).not.toHaveBeenCalled();
  });
});

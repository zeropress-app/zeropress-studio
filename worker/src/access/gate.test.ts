import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env, StudioHonoEnvironment } from '../types';
import { resetSystemIncidentDeduplicationForTests } from '../system/system-incident';
import { createCloudflareAccessGate } from './gate';

const required = {
  settings: {
    mode: 'required' as const,
    issuer: 'https://zeropress.cloudflareaccess.com',
    audience: 'a'.repeat(64),
    bound_origin: 'https://studio.example.com',
    verified_at_iso: '2026-08-28T00:00:00.000Z',
  },
  revision: '1'.repeat(32),
  updated_at_iso: '2026-08-28T00:00:00.000Z',
};

function createTestApp(input: {
  siteMode?: Env['STUDIO_SITE_MODE'];
  readSettings?: NonNullable<
    Parameters<typeof createCloudflareAccessGate>[0]
  >['readSettings'];
  verifyAssertion?: NonNullable<
    Parameters<typeof createCloudflareAccessGate>[0]
  >['verifyAssertion'];
}) {
  const app = new Hono<StudioHonoEnvironment>();
  app.use('/api/*', createCloudflareAccessGate({
    readSettings: input.readSettings,
    verifyAssertion: input.verifyAssertion,
  }));
  app.get('/api/protected', (c) => c.json({ identity: c.get('cloudflareAccessIdentity') ?? null }));
  app.get('/api/system/status', (c) => c.text('status'));
  app.get('/api/system/install/access', (c) => c.text('install'));
  app.get('/api/system/operations/status', (c) => c.text('operations'));
  const env = {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {} as RateLimit,
    STUDIO_SITE_MODE: input.siteMode ?? 'operational',
  } satisfies Env;
  return { app, env };
}

afterEach(() => {
  resetSystemIncidentDeduplicationForTests();
  vi.restoreAllMocks();
});

describe('Cloudflare Access API gate', () => {
  it('allows backward-compatible disabled settings without verification', async () => {
    const verifyAssertion = vi.fn();
    const { app, env } = createTestApp({
      readSettings: vi.fn().mockResolvedValue({
        settings: {
          mode: 'disabled', issuer: null, audience: null,
          bound_origin: null, verified_at_iso: null,
        },
        revision: '0'.repeat(32),
        updated_at_iso: null,
      }),
      verifyAssertion,
    });
    expect((await app.fetch(
      new Request('https://studio.example.com/api/protected'),
      env,
    )).status).toBe(200);
    expect(verifyAssertion).not.toHaveBeenCalled();
  });

  it('requires one verified assertion and forwards only the derived identity', async () => {
    const identity = {
      issuer: required.settings.issuer,
      team_domain: 'zeropress',
      audience: required.settings.audience,
      identity_email: 'admin@example.com',
    };
    const verifyAssertion = vi.fn().mockResolvedValue({
      state: 'verified', identity,
    });
    const { app, env } = createTestApp({
      readSettings: vi.fn().mockResolvedValue(required),
      verifyAssertion,
    });
    const response = await app.fetch(new Request(
      'https://studio.example.com/api/protected',
      { headers: { 'Cf-Access-Jwt-Assertion': 'signed-token' } },
    ), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ identity });
    expect(verifyAssertion).toHaveBeenCalledWith({
      assertion: 'signed-token',
      origin: 'https://studio.example.com',
      expected: required.settings,
    });
  });

  it('fails closed for missing assertions and verifier outages', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const [verification, status, code] of [
      [{ state: 'missing' }, 403, 'CLOUDFLARE_ACCESS_REQUIRED'],
      [{ state: 'unavailable', cause: new Error('offline') }, 503,
        'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE'],
    ] as const) {
      const { app, env } = createTestApp({
        readSettings: vi.fn().mockResolvedValue(required),
        verifyAssertion: vi.fn().mockResolvedValue(verification),
      });
      const response = await app.fetch(
        new Request('https://studio.example.com/api/protected'),
        env,
      );
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: { code },
      });
    }
    expect(consoleSpy).toHaveBeenCalledTimes(1);
  });

  it('bypasses initial/recovery mode and bootstrap/recovery system paths', async () => {
    const readSettings = vi.fn().mockResolvedValue(required);
    for (const siteMode of ['initial', 'recovery'] as const) {
      const { app, env } = createTestApp({ siteMode, readSettings });
      expect((await app.fetch(
        new Request('https://studio.example.com/api/protected'),
        env,
      )).status).toBe(200);
    }
    const { app, env } = createTestApp({ readSettings });
    expect((await app.fetch(
      new Request('https://studio.example.com/api/system/status'),
      env,
    )).status).toBe(200);
    expect((await app.fetch(
      new Request('https://studio.example.com/api/system/install/access'),
      env,
    )).status).toBe(200);
    expect((await app.fetch(
      new Request('https://studio.example.com/api/system/operations/status'),
      env,
    )).status).toBe(200);
    expect(readSettings).not.toHaveBeenCalled();
  });
});

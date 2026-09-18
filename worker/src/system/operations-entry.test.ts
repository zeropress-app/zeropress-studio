import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  systemStatusResponseSchema,
  type OperationsSetupConfiguration,
  type SystemStatusResponse,
} from '../../../contracts/system';
import { createApp } from '../index';
import type { ResolvedSession } from '../auth/session-repository';
import { StudioOperationalError } from '../lib/operational-error';
import { createFakeD1 } from '../test-helpers/fake-d1';
import type { Env } from '../types';
import { resetSystemIncidentDeduplicationForTests } from './system-incident';

const allowedIp = '203.0.113.10';
const operationsToken = 'test-operations-token-never-expose-000000';
const authSecret = 'test-auth-secret-never-expose-00000000000';
const administratorSession = {
  user: { id: '1'.repeat(32), email: 'owner@example.com', name: 'Owner', roles: ['admin'] },
} as ResolvedSession;

afterEach(() => {
  resetSystemIncidentDeduplicationForTests();
  vi.restoreAllMocks();
});

const cases: {
  name: string;
  overrides?: Partial<Env>;
  headers?: Record<string, string | undefined>;
  requestOrigin?: string;
  state: 'available' | 'not_found' | 'setup_required';
  configuration?: OperationsSetupConfiguration;
}[] = [
  { name: 'configured and allowed', state: 'available' },
  {
    name: 'Quick Tunnel visitor cannot use the local relay IP allowlist',
    requestOrigin: 'https://studio-test.trycloudflare.com',
    overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: '127.0.0.1,::1' },
    headers: { 'CF-Connecting-IP': allowedIp, 'X-Forwarded-For': '127.0.0.1' },
    state: 'not_found',
  },
  {
    name: 'a localhost Host cannot substitute for an allowed client IP',
    requestOrigin: 'http://localhost:5173',
    overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: '127.0.0.1' },
    headers: { 'CF-Connecting-IP': undefined, 'X-Forwarded-For': '127.0.0.1' },
    state: 'not_found',
  },
  {
    name: 'only site mode and auth secret configured',
    overrides: {
      STUDIO_OPERATIONS_ALLOWED_IPS: undefined,
      STUDIO_OPERATIONS_TOKEN: undefined,
    },
    state: 'setup_required',
    configuration: { allowed_ips: 'missing', token: 'missing', client_ip: allowedIp },
  },
  {
    name: 'token alone cannot enable Operations',
    overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: undefined },
    state: 'setup_required',
    configuration: { allowed_ips: 'missing', token: 'valid', client_ip: allowedIp },
  },
  {
    name: 'empty allowlist',
    overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: '' },
    state: 'setup_required',
    configuration: { allowed_ips: 'invalid', token: 'valid', client_ip: allowedIp },
  },
  {
    name: 'invalid allowlist',
    overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: 'not-an-ip' },
    state: 'setup_required',
    configuration: { allowed_ips: 'invalid', token: 'valid', client_ip: allowedIp },
  },
  {
    name: 'missing Operations token',
    overrides: { STUDIO_OPERATIONS_TOKEN: undefined },
    state: 'setup_required',
    configuration: { allowed_ips: 'valid', token: 'missing' },
  },
  {
    name: 'normalizes the requesting IPv6 instead of a forwarded address',
    overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: undefined },
    headers: { 'CF-Connecting-IP': '2001:0DB8:0:0::1', 'X-Forwarded-For': allowedIp },
    state: 'setup_required',
    configuration: { allowed_ips: 'missing', token: 'valid', client_ip: '2001:db8::1' },
  },
  ...[undefined, '', 'not-an-ip'].map((header) => ({
    name: `does not guess a missing or malformed requester IP (${header === undefined ? 'unset' : header.length})`,
    overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: undefined },
    headers: { 'CF-Connecting-IP': header, 'X-Forwarded-For': allowedIp },
    state: 'setup_required' as const,
    configuration: { allowed_ips: 'missing' as const, token: 'valid' as const, client_ip: null },
  })),
  ...[
    { requestOrigin: 'http://localhost:5173', clientIp: '127.0.0.1' },
    { requestOrigin: 'http://127.0.0.1:5173', clientIp: '127.0.0.1' },
    { requestOrigin: 'http://[::1]:5173', clientIp: '::1' },
  ].map(({ requestOrigin, clientIp }) => ({
    name: `uses the loopback IP supplied by the development server (${requestOrigin})`,
    requestOrigin,
    overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: undefined },
    headers: { 'CF-Connecting-IP': clientIp },
    state: 'setup_required' as const,
    configuration: { allowed_ips: 'missing' as const, token: 'valid' as const, client_ip: clientIp },
  })),
  {
    name: 'does not disclose an invalid configured list containing other operators',
    overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: '192.0.2.55,not-an-ip' },
    state: 'setup_required',
    configuration: { allowed_ips: 'invalid', token: 'valid', client_ip: allowedIp },
  },
  {
    name: 'invalid Operations token',
    overrides: { STUDIO_OPERATIONS_TOKEN: 'too-short' },
    state: 'setup_required',
    configuration: { allowed_ips: 'valid', token: 'invalid' },
  },
  {
    name: 'outside the allowlist despite a forwarded allowed IP',
    headers: {
      'CF-Connecting-IP': '198.51.100.20',
      'X-Forwarded-For': allowedIp,
    },
    state: 'not_found',
  },
  {
    name: 'cross-origin request',
    headers: { Origin: 'https://other.example.com' },
    state: 'not_found',
  },
  ...[undefined, '', 'too-short', operationsToken].map((token) => ({
    name: `denied IP takes precedence over token state (${token === undefined ? 'unset' : token.length})`,
    overrides: { STUDIO_OPERATIONS_TOKEN: token },
    headers: { 'CF-Connecting-IP': '198.51.100.20' },
    state: 'not_found' as const,
  })),
  ...[undefined, '', 'not-an-ip', allowedIp].map((allowlist) => ({
    name: `cross-origin hides setup (${allowlist === undefined ? 'unset' : allowlist.length})`,
    overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: allowlist, STUDIO_OPERATIONS_TOKEN: undefined },
    headers: { Origin: 'https://other.example.com' },
    state: 'not_found' as const,
  })),
  {
    name: 'missing trusted client IP cannot discover token setup',
    overrides: { STUDIO_OPERATIONS_TOKEN: undefined },
    headers: { 'CF-Connecting-IP': '', 'X-Forwarded-For': allowedIp },
    state: 'not_found',
  },
  {
    name: 'same-origin request',
    headers: { Origin: 'https://studio.example.com' },
    state: 'available',
  },
  {
    name: 'operational discovery before administrator sign-in',
    overrides: { STUDIO_SITE_MODE: 'operational' },
    state: 'available',
  },
];

describe('public Operations entry discovery', () => {
  it.each(cases)('$name returns only $state without consuming authentication attempts', async ({
    overrides, headers, state, configuration, requestOrigin = 'https://studio.example.com',
  }) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const db = createFakeD1({ tables: [] });
    const limit = vi.fn();
    const resolveSession = vi.fn();
    const app = createApp({ resolveSession });
    const env: Env = {
      DB: db.database,
      KV: {} as KVNamespace,
      AUTH_ROUTE_RATE_LIMITER: { limit },
      STUDIO_SITE_MODE: 'initial',
      STUDIO_AUTH_SECRET: authSecret,
      STUDIO_OPERATIONS_ALLOWED_IPS: allowedIp,
      STUDIO_OPERATIONS_TOKEN: operationsToken,
      ...overrides,
    };
    const requestHeaders = new Headers();
    for (const [name, value] of Object.entries({ 'CF-Connecting-IP': allowedIp, ...headers })) {
      if (value !== undefined) requestHeaders.set(name, value);
    }
    const response = await app.fetch(new Request(
      `${requestOrigin}/api/system/status`,
      { headers: requestHeaders },
    ), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const raw = await response.text();
    const parsed = systemStatusResponseSchema.parse(JSON.parse(raw));
    expect(parsed.data.operations).toEqual(configuration ? { state, configuration } : { state });
    for (const privateValue of [operationsToken, authSecret, 'not-an-ip', '192.0.2.55']) {
      expect(raw).not.toContain(privateValue);
    }
    if (!configuration || configuration.allowed_ips === 'valid' || configuration.client_ip === null) {
      expect(raw).not.toContain(allowedIp);
    }
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(allowedIp);
    if (configuration && configuration.allowed_ips !== 'valid' && configuration.client_ip) {
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(configuration.client_ip);
    }
    expect(resolveSession).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
    // Only the normal system lifecycle catalog inspection is performed.
    expect(db.getPrepareCallCount()).toBe(1);

    if (state !== 'available') {
      // Discovery and the protected API must agree, even with a formatted bearer.
      const protectedHeaders = new Headers(requestHeaders);
      protectedHeaders.set('Authorization', `Bearer ${operationsToken}`);
      const protectedResponse = await app.fetch(new Request(
        `${requestOrigin}/api/system/operations/status`,
        { headers: protectedHeaders },
      ), env);
      expect(protectedResponse.status).toBe(
        state === 'not_found' || configuration?.allowed_ips === 'missing' ? 404 : 503,
      );
      expect(db.getPrepareCallCount()).toBe(1);
      expect(resolveSession).not.toHaveBeenCalled();
      expect(limit).not.toHaveBeenCalled();
    }
  });

  it('does not treat public availability as token authentication', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const env: Env = {
      DB: createFakeD1().database,
      KV: {} as KVNamespace,
      AUTH_ROUTE_RATE_LIMITER: { limit },
      STUDIO_SITE_MODE: 'maintenance',
      STUDIO_AUTH_SECRET: authSecret,
      STUDIO_OPERATIONS_ALLOWED_IPS: allowedIp,
      STUDIO_OPERATIONS_TOKEN: operationsToken,
    };
    const app = createApp();
    const headers = { 'CF-Connecting-IP': allowedIp };
    const publicResponse = await app.fetch(new Request(
      'https://studio.example.com/api/system/status', { headers },
    ), env);
    expect((await publicResponse.json() as { data: { operations: unknown } })
      .data.operations).toEqual({ state: 'available' });
    expect(limit).not.toHaveBeenCalled();

    const protectedResponse = await app.fetch(new Request(
      'https://studio.example.com/api/system/operations/status', { headers },
    ), env);
    expect(protectedResponse.status).toBe(401);
    await expect(protectedResponse.json()).resolves.toEqual({
      success: false, error: { code: 'INVALID_OPERATIONS_TOKEN' },
    });
    expect(limit).toHaveBeenCalledOnce();
  });
});

const setupConfigurations: { name: string; overrides: Partial<Env> }[] = [
  {
    name: 'missing Operations variables',
    overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: undefined, STUDIO_OPERATIONS_TOKEN: undefined },
  },
  { name: 'empty allowlist', overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: '' } },
  { name: 'invalid allowlist', overrides: { STUDIO_OPERATIONS_ALLOWED_IPS: 'not-an-ip' } },
  { name: 'missing token', overrides: { STUDIO_OPERATIONS_TOKEN: undefined } },
  { name: 'invalid token', overrides: { STUDIO_OPERATIONS_TOKEN: 'too-short' } },
];

function operationalEnvironment(overrides: Partial<Env> = {}): Env {
  return {
    DB: createFakeD1().database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: { limit: vi.fn() },
    STUDIO_SITE_MODE: 'operational',
    STUDIO_AUTH_SECRET: authSecret,
    STUDIO_OPERATIONS_ALLOWED_IPS: allowedIp,
    STUDIO_OPERATIONS_TOKEN: operationsToken,
    ...overrides,
  };
}

function entryRequest(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://studio.example.com${path}`, {
    headers: {
      'CF-Connecting-IP': allowedIp,
      Cookie: '__Host-zp_session=session-cookie',
      Authorization: `Bearer ${operationsToken}`,
      ...headers,
    },
  });
}

describe.each(setupConfigurations)('operational setup visibility: $name', ({ overrides }) => {
  it.each([
    { name: 'administrator', roles: ['admin'], authorized: true },
    { name: 'editor', roles: ['editor'], authorized: false },
    { name: 'author', roles: ['author'], authorized: false },
    { name: 'missing or expired session', roles: null, authorized: false },
  ])('checks the $name session before disclosing configuration', async ({ roles, authorized }) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const resolveSession = vi.fn().mockResolvedValue(roles ? {
      ...administratorSession,
      user: { ...administratorSession.user, roles },
    } : null);
    const app = createApp({ resolveSession });
    const env = operationalEnvironment(overrides);
    const response = await app.fetch(entryRequest('/api/system/status'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const { data } = systemStatusResponseSchema.parse(await response.json());
    expect(data.access.state).toBe('operational');
    expect(data.operations).toEqual(authorized
      ? { state: 'setup_required', configuration: expect.any(Object) }
      : { state: 'not_found' });
    expect(resolveSession).toHaveBeenCalledWith({
      db: env.DB, cookieValue: 'session-cookie',
    });

    const protectedResponse = await app.fetch(entryRequest('/api/system/operations/status'), env);
    const reportsConfigurationError = authorized && env.STUDIO_OPERATIONS_ALLOWED_IPS !== undefined;
    expect(protectedResponse.status).toBe(reportsConfigurationError ? 503 : 404);
    expect(await protectedResponse.json()).toEqual({
      success: false,
      error: { code: reportsConfigurationError ? 'OPERATIONS_CONFIGURATION_ERROR' : 'NOT_FOUND' },
    });
    expect(env.AUTH_ROUTE_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });
});

describe('Operations setup session boundary', () => {
  it.each(['initial', 'maintenance', 'recovery', undefined, 'invalid'])(
    'allows setup without consulting Studio sessions in site mode %s', async (mode) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const resolveSession = vi.fn();
      const env = operationalEnvironment({
        STUDIO_SITE_MODE: mode,
        STUDIO_OPERATIONS_ALLOWED_IPS: undefined,
        STUDIO_OPERATIONS_TOKEN: undefined,
      });
      const response = await createApp({ resolveSession }).fetch(entryRequest('/api/system/status'), env);
      const { data } = systemStatusResponseSchema.parse(await response.json());
      expect(data.operations).toEqual({
        state: 'setup_required',
        configuration: { allowed_ips: 'missing', token: 'missing', client_ip: allowedIp },
      });
      expect(resolveSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    { 'CF-Connecting-IP': '198.51.100.20' },
    { Origin: 'https://other.example.com' },
  ] as Record<string, string>[])('enforces the IP and Origin boundary before administrator access', async (headers) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const resolveSession = vi.fn().mockResolvedValue(administratorSession);
    const env = operationalEnvironment({ STUDIO_OPERATIONS_TOKEN: undefined });
    const app = createApp({ resolveSession });
    const response = await app.fetch(entryRequest('/api/system/status', headers), env);
    expect((await response.json() as SystemStatusResponse).data.operations)
      .toEqual({ state: 'not_found' });
    const protectedResponse = await app.fetch(entryRequest('/api/system/operations/status', headers), env);
    expect(protectedResponse.status).toBe(404);
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it('keeps operational setup private when database state blocks Studio access', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = operationalEnvironment({
      DB: createFakeD1({ tables: [] }).database,
      STUDIO_OPERATIONS_ALLOWED_IPS: undefined,
    });
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(entryRequest('/api/system/status'), env);
    const { data } = systemStatusResponseSchema.parse(await response.json());
    expect(data.access).toEqual({ state: 'blocked', reason: 'DATABASE_UNINSTALLED' });
    expect(data.operations).toEqual({ state: 'not_found' });
    expect(resolveSession).toHaveBeenCalledOnce();
  });

  it.each([
    new StudioOperationalError('AUTH_SESSION_DATABASE_QUERY_FAILED'),
    new Error('session lookup failed'),
  ])('keeps public status available when session verification fails', async (error) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = operationalEnvironment({ STUDIO_OPERATIONS_ALLOWED_IPS: undefined });
    const resolveSession = vi.fn().mockRejectedValue(error);
    const app = createApp({ resolveSession });
    const response = await app.fetch(entryRequest('/api/system/status'), env);
    expect(response.status).toBe(200);
    expect((await response.json() as SystemStatusResponse).data.operations)
      .toEqual({ state: 'not_found' });
    const protectedResponse = await app.fetch(entryRequest('/api/system/operations/status'), env);
    expect(protectedResponse.status).toBe(404);
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({
      $zeropress: expect.objectContaining({
        code: error instanceof StudioOperationalError ? error.code : 'UNHANDLED_STUDIO_API_ERROR',
        pathname: '/api/system/status',
      }),
    }));
  });
});

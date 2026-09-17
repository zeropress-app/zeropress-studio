import { withAuthRateLimits } from './test-helpers/auth-database';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STUDIO_VERSION } from '../../contracts/studio-version';
import type { CredentialResult } from './auth/authenticate';
import type { CredentialsAuthenticator } from './auth/routes';
import { checkPasswordBreach } from './auth/password-breach-service';
import { createTotpCode } from './auth/mfa-crypto';
import { createApp } from './index';
import { StudioOperationalError } from './lib/operational-error';
import type {
  InstallDatabase,
  InstallPasswordHasher,
} from './system/routes';
import type { PrepareInitialEdgeSetup } from './system/initial-edge-setup';
import { resetSystemIncidentDeduplicationForTests } from './system/system-incident';
import {
  createFakeD1,
  READY_SCHEMA_STATE,
} from './test-helpers/fake-d1';
import type { Env } from './types';
import { STUDIO_SCHEMA_VERSION } from './system/schema-version';

const userId = '0123456789abcdef0123456789abcdef';
const authRevision = 'fedcba9876543210fedcba9876543210';
const authSecret = 'test-auth-secret-value-with-at-least-32-characters';
const installToken = 'installer-token-value-000000000000';
const placeholderMfaProof = {
  enrollment_token: 'x'.repeat(32),
  totp_code: '123456',
};

async function sha1Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

afterEach(() => {
  resetSystemIncidentDeduplicationForTests();
  vi.restoreAllMocks();
});

function createEnv(
  rateLimitSuccess = true,
  overrides: Partial<Env> = {},
): Env {
  const kvStore = new Map<string, string>();
  const environment: Env = {
    DB: createFakeD1().database,
    KV: {
      get: vi.fn(async (key: string) => kvStore.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { kvStore.set(key, value); }),
    } as unknown as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: rateLimitSuccess }),
    },
    STUDIO_SITE_MODE: 'operational',
    STUDIO_AUTH_SECRET: authSecret,
    ...overrides,
  };
  if (environment.STUDIO_SITE_MODE === 'operational') {
    environment.DB = withAuthRateLimits(environment.DB);
  }
  return environment;
}

function createAuthenticator(result: CredentialResult): CredentialsAuthenticator {
  return vi.fn().mockResolvedValue(result) as CredentialsAuthenticator;
}

function installedEdgeSetup() {
  return vi.fn<PrepareInitialEdgeSetup>().mockResolvedValue({
    status: 'installed',
  });
}

function successfulCredential(
  status: 'mfa_required' | 'mfa_enrollment_required',
): CredentialResult {
  return {
    kind: 'success',
    status,
    userId,
    authRevision,
  };
}

function requestBody(overrides?: Record<string, unknown>) {
  return new Request('http://studio.local/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
    body: JSON.stringify({
      email: 'Admin@Example.com',
      password: 'password',
      ...overrides,
    }),
  });
}

function installRequestBody(input: {
  token?: string;
  body?: Record<string, unknown>;
  contentType?: string;
} = {}) {
  const body = input.body ?? {
    admin_name: '  Studio Owner  ',
    admin_email: '  OWNER@Example.COM ',
    admin_password: 'harbor lantern canyon marble circuit',
    mfa: placeholderMfaProof,
  };
  return new Request('http://studio.local/api/system/install', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.token ?? installToken}`,
      'CF-Connecting-IP': '203.0.113.10',
      'Content-Type': input.contentType ?? 'application/json',
    },
    body: JSON.stringify({ interface_locale: 'en', ...body }),
  });
}

function installAccessRequest(input: {
  token?: string;
  origin?: string;
} = {}) {
  return new Request('http://studio.local/api/system/install/access', {
    headers: {
      Authorization: `Bearer ${input.token ?? installToken}`,
      'CF-Connecting-IP': '203.0.113.10',
      ...(input.origin ? { Origin: input.origin } : {}),
    },
  });
}

async function prepareInstallBody(input: {
  app: ReturnType<typeof createApp>;
  environment: Env;
}) {
  const setupResponse = await input.app.fetch(
    new Request('http://studio.local/api/system/install/mfa/setup', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${installToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        admin_email: 'owner@example.com',
      }),
    }),
    input.environment,
  );
  expect(setupResponse.status).toBe(200);
  const setup = await setupResponse.json() as {
    success: true;
    data: {
      secret: string;
      enrollment_token: string;
    };
  };
  return {
    admin_name: '  Studio Owner  ',
    admin_email: '  OWNER@Example.COM ',
    admin_password: 'harbor lantern canyon marble circuit',
    interface_locale: 'en',
    mfa: {
      enrollment_token: setup.data.enrollment_token,
      totp_code: await createTotpCode({ secret: setup.data.secret }),
    },
  };
}

describe('client IP security boundary', () => {
  it.each([
    '/api/auth/login',
    '/api/auth/mfa/verify',
    '/api/auth/mfa/enrollment/setup',
    '/api/auth/mfa/enrollment/complete',
    '/api/auth/passkey/options',
    '/api/auth/passkey/verify',
    '/api/auth/password/check',
    '/api/auth/mfa/webauthn/options',
    '/api/auth/mfa/webauthn/verify',
    '/api/auth/account-setup/inspect',
  ])('stops %s before authentication work when the client IP is unavailable', async (path) => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const authenticate = vi.fn();
    const environment = createEnv();
    const reserveBudgets = vi.spyOn(environment.DB, 'batch');
    const app = createApp({ authenticate });

    for (const cloudflareIp of [undefined, '', 'invalid-client-ip']) {
      const response = await app.fetch(new Request(`https://studio.example${path}`, {
        method: 'POST',
        headers: {
          Origin: 'https://studio.example',
          'Content-Type': 'application/json',
          'X-Forwarded-For': '203.0.113.99',
          ...(cloudflareIp === undefined ? {} : { 'CF-Connecting-IP': cloudflareIp }),
        },
        body: '{}',
      }), environment);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: { code: 'SYSTEM_NOT_AVAILABLE' },
      });
    }

    expect(environment.AUTH_ROUTE_RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(reserveBudgets).not.toHaveBeenCalled();
    expect(authenticate).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(3);
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio client IP is unavailable',
      $zeropress: {
        code: 'CLIENT_IP_NOT_AVAILABLE',
        component: 'request',
        action: 'resolve_client_ip',
        method: 'POST',
        pathname: path,
        guidance: expect.any(String),
      },
    });
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain('invalid-client-ip');
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain('203.0.113.99');
  });

  it('stops invalid installation-token attempts without trusting a forwarded IP', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const installDatabase = vi.fn();
    const environment = createEnv(true, {
      DB: createFakeD1({ tables: [] }).database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    });
    const request = installRequestBody({ token: 'wrong-install-token-value-0000000000' });
    request.headers.delete('CF-Connecting-IP');
    request.headers.set('X-Forwarded-For', '127.0.0.1');

    const response = await createApp({ installDatabase }).fetch(request, environment);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'SYSTEM_NOT_AVAILABLE' },
    });
    expect(installDatabase).not.toHaveBeenCalled();
    expect(environment.AUTH_ROUTE_RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(expect.objectContaining({
      $zeropress: expect.objectContaining({ code: 'CLIENT_IP_NOT_AVAILABLE' }),
    }));
  });
});

describe('GET /api/users', () => {
  it('mounts the canonical user-list path without a trailing slash', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/users'),
      createEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('GET /api/dashboard/summary', () => {
  it('mounts the authenticated no-store operational overview', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/dashboard/summary'),
      createEnv(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('GET /api/authors', () => {
  it('mounts the capability-protected Author endpoint', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/authors'),
      createEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('GET /api/taxonomies/categories', () => {
  it('mounts the capability-protected Taxonomy endpoint', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/taxonomies/categories'),
      createEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('GET /api/posts', () => {
  it('mounts the capability-protected Post endpoint', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/posts'),
      createEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('GET /api/pages', () => {
  it('mounts the capability-protected Page endpoint', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/pages'),
      createEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('GET /__zeropress_media__/*', () => {
  it('mounts reserved authored Media references behind the normal session boundary', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const getReferencePreview = vi.fn();
    const response = await createApp({
      resolveSession,
      media: { getReferencePreview },
    }).fetch(
      new Request(
        'http://studio.local/__zeropress_media__/uploads/2026/08/image.jpg',
      ),
      createEnv(),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
    expect(getReferencePreview).not.toHaveBeenCalled();
  });
});

describe('GET /api/settings/general', () => {
  it('mounts the capability-protected General Settings endpoint', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/settings/general'),
      createEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('GET /api/settings/output', () => {
  it('mounts the capability-protected output settings endpoint', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/settings/output'),
      createEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('GET /api/settings/newsletter', () => {
  it('mounts the capability-protected Newsletter settings endpoint', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/settings/newsletter'),
      createEnv(),
    );
    expect(response.status).toBe(401);
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('GET /api/newsletters', () => {
  it('mounts the capability-protected Edge Newsletter management endpoint', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/newsletters'),
      createEnv(),
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('GET /api/settings/mail', () => {
  it('mounts the capability-protected mail settings endpoint', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/settings/mail'),
      createEnv(),
    );
    expect(response.status).toBe(401);
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('GET /api/settings/branding', () => {
  it('mounts the capability-protected Site Branding endpoint', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/settings/branding'),
      createEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('GET /api/preview-data', () => {
  it('mounts the capability-protected Preview Data export endpoint', async () => {
    const resolveSession = vi.fn().mockResolvedValue(null);
    const response = await createApp({ resolveSession }).fetch(
      new Request('http://studio.local/api/preview-data'),
      createEnv(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });
    expect(resolveSession).toHaveBeenCalledOnce();
  });
});

describe('POST /api/auth/login', () => {
  it.each(['mfa_required', 'mfa_enrollment_required'] as const)(
    'returns the %s state only with a short-lived continuation',
    async (status) => {
    const authenticate = createAuthenticator(successfulCredential(status));
    const response = await createApp({ authenticate }).fetch(requestBody(), createEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        status,
        continuation_token: expect.any(String),
        expires_at_iso: expect.any(String),
      },
    });
    expect(authenticate).toHaveBeenCalledWith(expect.objectContaining({
      email: 'admin@example.com',
      password: 'password',
    }));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    },
  );

  it('returns one generic response for invalid credentials', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const response = await createApp({
      authenticate: createAuthenticator({ kind: 'invalid_credentials' }),
    }).fetch(requestBody(), createEnv());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: 'INVALID_CREDENTIALS',
      },
    });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON, extra fields, and non-JSON content', async () => {
    const app = createApp({
      authenticate: createAuthenticator(
        successfulCredential('mfa_required'),
      ),
    });
    const malformed = new Request('http://studio.local/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
      body: '{',
    });

    expect((await app.fetch(malformed, createEnv())).status).toBe(400);
    expect((await app.fetch(requestBody({ api_host: 'https://api.example.com' }), createEnv())).status).toBe(400);
    expect((await app.fetch(new Request('http://studio.local/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'CF-Connecting-IP': '203.0.113.10' },
      body: 'email=admin@example.com',
    }), createEnv())).status).toBe(415);
  });

  it('uses the shared Cloudflare rate limiter before authentication', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const authenticate = createAuthenticator(
      successfulCredential('mfa_required'),
    );
    const response = await createApp({ authenticate }).fetch(requestBody(), createEnv(false));

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(authenticate).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('records unclassified request failures without misleading operator guidance', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const authenticate = vi.fn().mockRejectedValue(new TypeError('Unexpected implementation failure'));

    const response = await createApp({
      authenticate: authenticate as CredentialsAuthenticator,
    }).fetch(requestBody(), createEnv());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
      },
    });
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Unhandled Studio API error',
      $zeropress: {
        code: 'UNHANDLED_STUDIO_API_ERROR',
        method: 'POST',
        pathname: '/api/auth/login',
        errorType: 'TypeError',
      },
    });
  });

  it('records classified request failures once with their catalog guidance', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const authenticate = vi.fn().mockRejectedValue(
      new StudioOperationalError('AUTH_DATABASE_QUERY_FAILED', {
        cause: new Error('D1_ERROR: no such table: users'),
        metadata: {
          resource: 'DB',
          action: 'authenticate_credentials',
        },
      }),
    );

    const response = await createApp({
      authenticate: authenticate as CredentialsAuthenticator,
    }).fetch(requestBody(), createEnv());

    expect(response.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio authentication database query failed',
      $zeropress: {
        code: 'AUTH_DATABASE_QUERY_FAILED',
        resource: 'DB',
        action: 'authenticate_credentials',
        method: 'POST',
        pathname: '/api/auth/login',
        errorType: 'Error',
        guidance: 'Verify the DB binding targets the Studio database. If the database is uninstalled, set STUDIO_SITE_MODE to initial and complete installation; otherwise verify its schema lifecycle state.',
      },
    });
  });

  it('classifies native rate limiter failures separately from rejected requests', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const env = createEnv();
    vi.mocked(env.AUTH_ROUTE_RATE_LIMITER.limit).mockRejectedValue(
      new Error('Rate Limiting service unavailable'),
    );
    const authenticate = createAuthenticator(
      successfulCredential('mfa_required'),
    );

    const response = await createApp({ authenticate }).fetch(requestBody(), env);

    expect(response.status).toBe(500);
    expect(authenticate).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Authentication route rate limiter is unavailable',
      $zeropress: {
        code: 'AUTH_ROUTE_RATE_LIMITER_NOT_AVAILABLE',
        resource: 'AUTH_ROUTE_RATE_LIMITER',
        action: 'limit_login_route',
        method: 'POST',
        pathname: '/api/auth/login',
        errorType: 'Error',
        guidance: 'Verify the AUTH_ROUTE_RATE_LIMITER binding and Cloudflare Rate Limiting service status, then retry.',
      },
    });
  });

  it('classifies D1 rate-limit storage failures separately from authentication', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const env = createEnv();
    env.DB.batch = vi.fn().mockRejectedValue(new Error('D1 service unavailable'));
    const authenticate = createAuthenticator(
      successfulCredential('mfa_required'),
    );

    const response = await createApp({ authenticate }).fetch(requestBody(), env);

    expect(response.status).toBe(503);
    expect(authenticate).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Authentication rate-limit storage is unavailable',
      $zeropress: {
        code: 'AUTH_RATE_LIMIT_STORE_NOT_AVAILABLE',
        resource: 'DB',
        action: 'consume_login_rate_limit',
        method: 'POST',
        pathname: '/api/auth/login',
        errorType: 'Error',
        guidance: 'Verify the DB binding targets the Studio database, the auth_rate_limits table exists, and Cloudflare D1 is available, then retry.',
      },
    });
  });
});

describe('GET /api/system/install/access', () => {
  it('authorizes an initial uninstalled installer without consuming the invalid-attempt limiter', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const environment = createEnv(true, {
      DB: fakeD1.database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    });

    const response = await createApp().fetch(
      installAccessRequest(),
      environment,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { state: 'authorized' },
    });
    expect(environment.AUTH_ROUTE_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });

  it('rate-limits an invalid token under the isolated install-attempt key', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const environment = createEnv(true, {
      DB: fakeD1.database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    });

    const response = await createApp().fetch(
      installAccessRequest({
        token: 'wrong-install-token-value-0000000000',
      }),
      environment,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'INVALID_INSTALL_TOKEN' },
    });
    expect(environment.AUTH_ROUTE_RATE_LIMITER.limit).toHaveBeenCalledWith({
      key: 'install:203.0.113.10',
    });
  });

  it('rejects a cross-origin access check before reading D1', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const environment = createEnv(true, {
      DB: fakeD1.database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    });

    const response = await createApp().fetch(
      installAccessRequest({ origin: 'https://attacker.example' }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(fakeD1.getPrepareCallCount()).toBe(0);
    expect(environment.AUTH_ROUTE_RATE_LIMITER.limit).not.toHaveBeenCalled();
  });
});

describe('POST /api/system/install', () => {
  it('installs an empty database and leaves activation to the operator', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const hashInstallPassword = vi.fn<InstallPasswordHasher>()
      .mockResolvedValue('$argon2id$installation-hash');
    const installDatabase = vi.fn<InstallDatabase>(async (input) => {
      fakeD1.setTables([
        'roles',
        'sessions',
        'site_settings',
        'studio_settings',
        'user_mfa_factors',
        'user_roles',
        'users',
        'zeropress_schema_state',
      ]);
      fakeD1.setSchemaState(READY_SCHEMA_STATE);
      expect(input).toMatchObject({
        db: fakeD1.database,
        edgeIntegrationMode: 'enabled',
        administrator: {
          admin_name: 'Administrator',
          admin_email: 'owner@example.com',
        },
        passwordHash: '$argon2id$installation-hash',
        interfaceLocale: 'en',
        mfa: {
          encryptedTotpSecret: {
            ciphertext: expect.any(String),
            iv: expect.any(String),
          },
          lastUsedStep: expect.any(Number),
        },
      });
      expect(input).not.toHaveProperty('admin_password');
    });
    const consoleSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const env = createEnv(true, {
      DB: fakeD1.database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    });

    const app = createApp({
      installDatabase,
      hashInstallPassword,
      prepareInitialEdgeSetup: installedEdgeSetup(),
    });
    const preparedBody = await prepareInstallBody({
      app,
      environment: env,
    });
    preparedBody.admin_name = 'Administrator';
    preparedBody.admin_password = 'studio.local-lantern-canyon-marble';
    const response = await app.fetch(
      installRequestBody({ body: preparedBody }),
      env,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'installed',
        schema_version: STUDIO_SCHEMA_VERSION,
        edge_database: {
          status: 'installed',
          integration_mode: 'enabled',
        },
      },
    });
    expect(hashInstallPassword).toHaveBeenCalledOnce();
    expect(hashInstallPassword).toHaveBeenCalledWith(
      'studio.local-lantern-canyon-marble',
    );
    expect(installDatabase).toHaveBeenCalledOnce();
    expect(env.AUTH_ROUTE_RATE_LIMITER.limit).not.toHaveBeenCalled();
    expect(env.STUDIO_SITE_MODE).toBe('initial');
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio database installation completed',
      $zeropress: {
        code: 'DATABASE_INSTALL_COMPLETED',
        resource: 'DB',
        action: 'install_database',
        schema_version: STUDIO_SCHEMA_VERSION,
        edge_database_status: 'installed',
        edge_integration_mode: 'enabled',
        guidance: 'Remove STUDIO_INSTALL_TOKEN, set STUDIO_SITE_MODE to operational, and redeploy the Worker configuration.',
      },
    });
  });

  it('preserves a non-empty Edge database and installs Studio with integration disabled', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const installDatabase = vi.fn<InstallDatabase>(async () => {
      fakeD1.setTables(['users', 'zeropress_schema_state']);
      fakeD1.setSchemaState(READY_SCHEMA_STATE);
    });
    const prepareInitialEdgeSetup = vi.fn<PrepareInitialEdgeSetup>()
      .mockResolvedValue({
        status: 'skipped_nonempty',
        existingState: 'ready',
      });
    const consoleSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const environment = createEnv(true, {
      DB: fakeD1.database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    });
    const app = createApp({
      installDatabase,
      prepareInitialEdgeSetup,
      hashInstallPassword: vi.fn<InstallPasswordHasher>()
        .mockResolvedValue('$argon2id$installation-hash'),
    });
    const preparedBody = await prepareInstallBody({ app, environment });

    const response = await app.fetch(
      installRequestBody({ body: preparedBody }),
      environment,
    );

    expect(response.status).toBe(201);
    expect(installDatabase).toHaveBeenCalledWith(expect.objectContaining({
      edgeIntegrationMode: 'disabled',
    }));
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        edge_database: {
          status: 'skipped_nonempty',
          integration_mode: 'disabled',
        },
      },
    });
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio database installation completed',
      $zeropress: expect.objectContaining({
        code: 'DATABASE_INSTALL_COMPLETED',
        edge_database_status: 'skipped_nonempty',
        edge_integration_mode: 'disabled',
        existing_edge_database_state: 'ready',
      }),
    });
  });

  it('fails before the Studio write when required Edge resources are unavailable', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const installDatabase = vi.fn<InstallDatabase>();
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const environment = createEnv(true, {
      DB: fakeD1.database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    });
    const app = createApp({
      installDatabase,
      hashInstallPassword: vi.fn<InstallPasswordHasher>()
        .mockResolvedValue('$argon2id$installation-hash'),
    });
    const preparedBody = await prepareInstallBody({ app, environment });

    const response = await app.fetch(
      installRequestBody({ body: preparedBody }),
      environment,
    );

    expect(response.status).toBe(500);
    expect(installDatabase).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Initial Edge database setup failed',
      $zeropress: {
        code: 'INITIAL_EDGE_SETUP_FAILED',
        resource: 'EDGE_DB',
        related_resource: 'EDGE_KV',
        action: 'prepare_initial_edge_database',
        reason: 'edge_db_binding_missing',
        method: 'POST',
        pathname: '/api/system/install',
        errorType: 'Error',
        guidance: 'Verify the EDGE_DB and EDGE_KV bindings and Cloudflare D1 availability. Studio DB remains uninstalled; retry initial installation after correcting the Edge resource.',
      },
    });
  });

  it('rejects an invalid token without hashing, writing, or logging', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const hashInstallPassword = vi.fn<InstallPasswordHasher>();
    const installDatabase = vi.fn<InstallDatabase>();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const infoSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    const response = await createApp({
      installDatabase,
      hashInstallPassword,
    }).fetch(
      installRequestBody({ token: 'wrong-token' }),
      createEnv(true, {
        DB: fakeD1.database,
        STUDIO_SITE_MODE: 'initial',
        STUDIO_INSTALL_TOKEN: installToken,
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'INVALID_INSTALL_TOKEN' },
    });
    expect(hashInstallPassword).not.toHaveBeenCalled();
    expect(installDatabase).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('rejects non-initial mode before reading D1 or the install token', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const env = createEnv(true, {
      DB: fakeD1.database,
      STUDIO_SITE_MODE: 'operational',
    });
    let tokenReads = 0;
    Object.defineProperty(env, 'STUDIO_INSTALL_TOKEN', {
      configurable: true,
      get() {
        tokenReads += 1;
        return installToken;
      },
    });

    const response = await createApp().fetch(installRequestBody(), env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'INSTALLATION_NOT_AVAILABLE' },
    });
    expect(fakeD1.getPrepareCallCount()).toBe(0);
    expect(tokenReads).toBe(0);
  });

  it('inspects and reports a retained install token after installation', async () => {
    const env = createEnv(true, {
      DB: createFakeD1().database,
      STUDIO_SITE_MODE: 'initial',
    });
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    let tokenReads = 0;
    Object.defineProperty(env, 'STUDIO_INSTALL_TOKEN', {
      configurable: true,
      get() {
        tokenReads += 1;
        return installToken;
      },
    });

    const response = await createApp().fetch(installRequestBody(), env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'INSTALLATION_ALREADY_COMPLETED' },
    });
    expect(tokenReads).toBe(1);
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio install token remains configured after installation',
      $zeropress: {
        code: 'INSTALL_TOKEN_STILL_CONFIGURED',
        component: 'worker_configuration',
        action: 'enforce_install_token_lifecycle',
        guidance: 'Delete the STUDIO_INSTALL_TOKEN Worker secret binding instead of replacing it with a blank value, then redeploy the Worker configuration. Keep the token only while installing an uninstalled Studio database in initial mode.',
      },
    });
  });

  it('rate-limits invalid install authentication before parsing or hashing data', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const hashInstallPassword = vi.fn<InstallPasswordHasher>();
    const installDatabase = vi.fn<InstallDatabase>();
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const response = await createApp({
      installDatabase,
      hashInstallPassword,
    }).fetch(
      installRequestBody({ token: 'wrong-token-value-000000000000000' }),
      createEnv(false, {
        DB: fakeD1.database,
        STUDIO_SITE_MODE: 'initial',
        STUDIO_INSTALL_TOKEN: installToken,
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(hashInstallPassword).not.toHaveBeenCalled();
    expect(installDatabase).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('rejects malformed install data before hashing or writing', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const hashInstallPassword = vi.fn<InstallPasswordHasher>();
    const installDatabase = vi.fn<InstallDatabase>();
    const env = createEnv(true, {
      DB: fakeD1.database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    });

    const response = await createApp({
      installDatabase,
      hashInstallPassword,
    }).fetch(installRequestBody({
      body: {
        admin_name: 'Owner',
        admin_email: 'owner@example.com',
        admin_password: 'too-short',
        install_token: 'must-not-be-accepted-in-json',
      },
    }), env);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(hashInstallPassword).not.toHaveBeenCalled();
    expect(installDatabase).not.toHaveBeenCalled();
  });

  it('allows the same-origin password check before Studio is installed', async () => {
    const environment = createEnv(true, {
      DB: createFakeD1({ tables: [] }).database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    });
    const response = await createApp().fetch(new Request(
      'http://studio.local/api/auth/password/check',
      {
        method: 'POST',
        headers: {
          Origin: 'http://studio.local',
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '203.0.113.10',
        },
        body: JSON.stringify({
          password: 'harbor lantern canyon marble circuit',
        }),
      },
    ), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { status: 'clear', source: 'offline' },
    });
  });

  it.each([
    {
      label: 'offline common password',
      body: {
        admin_name: 'Studio Owner',
        admin_email: 'owner@example.com',
        admin_password: 'correct horse battery staple',
      },
    },
    {
      label: 'administrator context password',
      body: {
        admin_name: 'Studio Owner',
        admin_email: 'owner@example.com',
        admin_password: 'owner-lantern-canyon-marble',
      },
    },
  ])('rejects $label before hashing or D1 write', async ({ body }) => {
    const fakeD1 = createFakeD1({ tables: [] });
    const hashInstallPassword = vi.fn<InstallPasswordHasher>();
    const installDatabase = vi.fn<InstallDatabase>();
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const infoSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    const response = await createApp({
      installDatabase,
      hashInstallPassword,
    }).fetch(
      installRequestBody({
        body: { ...body, mfa: placeholderMfaProof },
      }),
      createEnv(true, {
        DB: fakeD1.database,
        STUDIO_SITE_MODE: 'initial',
        STUDIO_INSTALL_TOKEN: installToken,
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'WEAK_ADMIN_PASSWORD' },
    });
    expect(hashInstallPassword).not.toHaveBeenCalled();
    expect(installDatabase).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('rejects a deployed HIBP hit before hashing or D1 write', async () => {
    const password = 'breach range install regression password';
    const digest = await sha1Hex(password);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      `${digest.slice(5)}:42`,
      { status: 200 },
    )));
    const hashInstallPassword = vi.fn<InstallPasswordHasher>();
    const installDatabase = vi.fn<InstallDatabase>();

    const response = await createApp({
      installDatabase,
      hashInstallPassword,
      checkPasswordBreach: (input) => checkPasswordBreach({
        ...input,
        hibpEnabled: true,
      }),
    }).fetch(installRequestBody({
      body: {
        admin_name: 'Owner',
        admin_email: 'owner@example.com',
        admin_password: password,
        mfa: placeholderMfaProof,
      },
    }), createEnv(true, {
      DB: createFakeD1({ tables: [] }).database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'WEAK_ADMIN_PASSWORD' },
    });
    expect(hashInstallPassword).not.toHaveBeenCalled();
    expect(installDatabase).not.toHaveBeenCalled();
  });

  it('classifies an install batch failure and keeps the public response generic', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const installDatabase = vi.fn<InstallDatabase>()
      .mockRejectedValue(new Error('D1 service unavailable'));
    const environment = createEnv(true, {
      DB: fakeD1.database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    });
    const app = createApp({
      installDatabase,
      hashInstallPassword: vi.fn<InstallPasswordHasher>()
        .mockResolvedValue('$argon2id$installation-hash'),
      prepareInitialEdgeSetup: installedEdgeSetup(),
    });
    const preparedBody = await prepareInstallBody({
      app,
      environment,
    });
    const response = await app.fetch(
      installRequestBody({ body: preparedBody }),
      environment,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR' },
    });
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio database installation failed',
      $zeropress: {
        code: 'DATABASE_INSTALL_FAILED',
        resource: 'DB',
        action: 'install_database',
        target_schema_version: STUDIO_SCHEMA_VERSION,
        edge_database_status: 'installed',
        edge_integration_mode: 'enabled',
        method: 'POST',
        pathname: '/api/system/install',
        errorType: 'Error',
        guidance: 'Check the DB binding and D1 availability. Confirm system status is still uninstalled before retrying; restore a backup if any unexpected schema remains.',
      },
    });
  });

  it('treats a concurrent successful installer as an expected conflict', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const installDatabase = vi.fn<InstallDatabase>(async () => {
      fakeD1.setTables(['users', 'zeropress_schema_state']);
      fakeD1.setSchemaState(READY_SCHEMA_STATE);
      throw new Error('table already exists');
    });
    const environment = createEnv(true, {
      DB: fakeD1.database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    });
    const app = createApp({
      installDatabase,
      hashInstallPassword: vi.fn<InstallPasswordHasher>()
        .mockResolvedValue('$argon2id$installation-hash'),
      prepareInitialEdgeSetup: installedEdgeSetup(),
    });
    const preparedBody = await prepareInstallBody({
      app,
      environment,
    });
    const response = await app.fetch(
      installRequestBody({ body: preparedBody }),
      environment,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'INSTALLATION_ALREADY_COMPLETED' },
    });
    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio install token remains configured after installation',
      $zeropress: {
        code: 'INSTALL_TOKEN_STILL_CONFIGURED',
        component: 'worker_configuration',
        action: 'enforce_install_token_lifecycle',
        guidance: 'Delete the STUDIO_INSTALL_TOKEN Worker secret binding instead of replacing it with a blank value, then redeploy the Worker configuration. Keep the token only while installing an uninstalled Studio database in initial mode.',
      },
    });
  });

  it('blocks activation when the completed batch cannot be verified', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const environment = createEnv(true, {
      DB: fakeD1.database,
      STUDIO_SITE_MODE: 'initial',
      STUDIO_INSTALL_TOKEN: installToken,
    });
    const app = createApp({
      installDatabase: vi.fn<InstallDatabase>().mockResolvedValue(undefined),
      hashInstallPassword: vi.fn<InstallPasswordHasher>()
        .mockResolvedValue('$argon2id$installation-hash'),
      prepareInitialEdgeSetup: installedEdgeSetup(),
    });
    const preparedBody = await prepareInstallBody({
      app,
      environment,
    });
    const response = await app.fetch(
      installRequestBody({ body: preparedBody }),
      environment,
    );

    expect(response.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio database installation verification failed',
      $zeropress: {
        code: 'DATABASE_INSTALL_VERIFICATION_FAILED',
        resource: 'DB',
        action: 'verify_database_installation',
        target_schema_version: STUDIO_SCHEMA_VERSION,
        method: 'POST',
        pathname: '/api/system/install',
        guidance: 'Do not enable operational mode. Inspect system status and restore the D1 database from a known-good backup before retrying.',
      },
    });
  });
});

describe('system bootstrap and API gate', () => {
  it('exposes read-only installation readiness without exposing the install token', async () => {
    const fakeD1 = createFakeD1({ tables: [] });
    const response = await createApp().fetch(
      new Request('http://studio.local/api/system/status'),
      createEnv(true, {
        DB: fakeD1.database,
        STUDIO_SITE_MODE: 'initial',
        STUDIO_INSTALL_TOKEN:
          'do-not-return-this-token-value-0000000000',
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    const rawBody = await response.text();
    expect(rawBody).not.toContain('do-not-return-this-token');
    expect(JSON.parse(rawBody)).toEqual({
      success: true,
      data: {
        studio_version: STUDIO_VERSION,
        site_mode: 'initial',
        database: {
          state: 'uninstalled',
          target_schema_version: STUDIO_SCHEMA_VERSION,
        },
        access: {
          state: 'installation',
        },
        installation_configuration: {
          site_mode: 'initial',
          auth_secret: 'valid',
          install_token: 'valid',
        },
        operations: {
          state: 'setup_required',
          configuration: { allowed_ips: 'missing', token: 'missing', client_ip: null },
        },
      },
    });
    expect(fakeD1.getPrepareCallCount()).toBe(1);
  });

  it('inspects D1 on the status endpoint even during maintenance', async () => {
    const fakeD1 = createFakeD1();
    const response = await createApp().fetch(
      new Request('http://studio.local/api/system/status'),
      createEnv(true, {
        DB: fakeD1.database,
        STUDIO_SITE_MODE: 'maintenance',
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        site_mode: 'maintenance',
        database: { state: 'ready' },
        access: { state: 'maintenance' },
      },
    });
    expect(fakeD1.getPrepareCallCount()).toBe(2);
  });

  it.each([
    ['missing mode', undefined, 'SYSTEM_CONFIGURATION_ERROR'],
    ['invalid mode', ' operational ', 'SYSTEM_CONFIGURATION_ERROR'],
    ['maintenance', 'maintenance', 'SITE_MAINTENANCE'],
    ['recovery', 'recovery', 'SITE_RECOVERY'],
  ] as const)('blocks %s without querying D1', async (_label, mode, code) => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const fakeD1 = createFakeD1();
    const response = await createApp().fetch(
      requestBody(),
      createEnv(true, {
        DB: fakeD1.database,
        STUDIO_SITE_MODE: mode,
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code },
    });
    expect(fakeD1.getPrepareCallCount()).toBe(0);
    if (mode === 'maintenance' || mode === 'recovery') {
      expect(consoleSpy).not.toHaveBeenCalled();
    }
  });

  it('distinguishes installation, retained-token failure, and activation gates', async () => {
    const uninstalledResponse = await createApp().fetch(
      requestBody(),
      createEnv(true, {
        DB: createFakeD1({ tables: [] }).database,
        STUDIO_SITE_MODE: 'initial',
        STUDIO_INSTALL_TOKEN: installToken,
      }),
    );
    const retainedTokenResponse = await createApp().fetch(
      requestBody(),
      createEnv(true, {
        DB: createFakeD1().database,
        STUDIO_SITE_MODE: 'initial',
        STUDIO_INSTALL_TOKEN:
          'ignored-after-install-value-000000000000',
      }),
    );
    const activationResponse = await createApp().fetch(
      requestBody(),
      createEnv(true, {
        DB: createFakeD1().database,
        STUDIO_SITE_MODE: 'initial',
        STUDIO_INSTALL_TOKEN: undefined,
      }),
    );

    expect(uninstalledResponse.status).toBe(503);
    await expect(uninstalledResponse.json()).resolves.toEqual({
      success: false,
      error: { code: 'INSTALLATION_REQUIRED' },
    });
    expect(retainedTokenResponse.status).toBe(503);
    await expect(retainedTokenResponse.json()).resolves.toEqual({
      success: false,
      error: { code: 'SYSTEM_CONFIGURATION_ERROR' },
    });
    expect(activationResponse.status).toBe(503);
    await expect(activationResponse.json()).resolves.toEqual({
      success: false,
      error: { code: 'SITE_ACTIVATION_REQUIRED' },
    });
  });

  it('keeps configuration failures public-safe while logging stable guidance', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const fakeD1 = createFakeD1();
    const response = await createApp().fetch(
      new Request('http://studio.local/api/system/status'),
      createEnv(true, {
        DB: fakeD1.database,
        STUDIO_SITE_MODE: undefined,
        STUDIO_INSTALL_TOKEN:
          'sensitive-install-token-value-00000000000',
      }),
    );

    const rawBody = await response.text();
    expect(response.status).toBe(200);
    expect(rawBody).not.toContain('sensitive-install-token');
    expect(rawBody).not.toContain('users');
    expect(JSON.parse(rawBody)).toMatchObject({
      success: true,
      data: {
        site_mode: null,
        access: {
          state: 'blocked',
          reason: 'SITE_MODE_MISSING',
        },
      },
    });
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio site mode configuration is invalid',
      $zeropress: {
        code: 'SITE_MODE_CONFIGURATION_INVALID',
        component: 'worker_configuration',
        action: 'resolve_site_mode',
        reason: 'missing',
        guidance: 'Set STUDIO_SITE_MODE to exactly one of initial, operational, maintenance, or recovery, then redeploy the Worker configuration.',
      },
    });
  });
});

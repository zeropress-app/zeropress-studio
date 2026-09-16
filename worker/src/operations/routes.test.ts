import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp as createStudioApp } from '../index';
import { resetSystemIncidentDeduplicationForTests } from '../system/system-incident';
import {
  createFakeD1,
  READY_SCHEMA_STATE,
} from '../test-helpers/fake-d1';
import type { Env } from '../types';
import { STUDIO_SCHEMA_VERSION } from '../system/schema-version';
import {
  createDatabaseRestorePlan,
  createSchemaFingerprint,
  createManifestSha256,
  createStatementChainSha256,
  inspectDatabaseBackupArtifact,
  serializeDatabaseBackupArtifact,
  type DatabaseBackupManifest,
} from '../../../contracts/database-backup';
import { readEdgeIntegrationSettings } from '../settings/edge-services-repository';
import { createTotpCode } from '../auth/mfa-crypto';
import { CONTENT_SEARCH_REBUILD_CONFIRMATION } from '../../../contracts/content-search-index';
import type { ResolvedSession } from '../auth/session-repository';

const operationsToken = 'operations-token-value-000000000000';
const allowedIp = '203.0.113.10';
const administratorId = '0123456789abcdef0123456789abcdef';
const administratorSession = {
  user: {
    id: administratorId,
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: { id: 'session-id' },
  csrfToken: 'csrf-token',
  authRevision: 'auth-revision',
  mfaVerifiedAtIso: '2026-08-29T00:00:00.000Z',
} as ResolvedSession;

type CreateAppDependencies = NonNullable<
  Parameters<typeof createStudioApp>[0]
>;

function createApp(dependencies: CreateAppDependencies = {}) {
  return createStudioApp({
    ...dependencies,
    resolveSession: dependencies.resolveSession
      ?? vi.fn().mockResolvedValue(administratorSession),
    operations: {
      materializeEdgeServices: async ({ env, stored }) => {
        const document = stored ?? await readEdgeIntegrationSettings({
          db: env.DB,
        });
        return {
          ...document,
          effective_state: document.settings.mode === 'enabled'
            ? 'ready' as const
            : 'disabled' as const,
          pending_target_events: 0,
        };
      },
      inspectEdgeIntegration: async () => ({ state: 'ready' as const }),
      inspectEdgeDatabase: async ({ edgeDb }) => ({
        state: edgeDb ? 'ready' as const : 'unavailable' as const,
        current_schema_version: edgeDb ? 1 : null,
        target_schema_version: 1 as const,
        operation_id: null,
        next_upgrade_steps: [],
        install_available: false,
        adopt_available: false,
        upgrade_available: false,
      }),
      ...dependencies.operations,
    },
  });
}

async function databaseBackupArtifact(
  database: 'studio' | 'edge' = 'studio',
) {
  const schemaSql = 'CREATE TABLE example (id INTEGER PRIMARY KEY)';
  const statements = [
    'PRAGMA defer_foreign_keys = TRUE',
    'DELETE FROM "example"',
    'INSERT INTO "example" ("id") VALUES (1)',
  ];
  const manifest: DatabaseBackupManifest = {
    format: 'zeropress-studio-sql-backup',
    format_version: 1,
    database,
    mode: 'data_only',
    exported_at_iso: '2026-08-03T00:00:00.000Z',
    schema_fingerprint: await createSchemaFingerprint([{
      type: 'table',
      name: 'example',
      table_name: 'example',
      sql: schemaSql,
    }]),
    studio_schema_version: database === 'studio' ? STUDIO_SCHEMA_VERSION : null,
    schema_objects: [{
      type: 'table',
      name: 'example',
      table_name: 'example',
    }],
    tables: [{ name: 'example', row_count: 1 }],
  };
  return serializeDatabaseBackupArtifact({
    manifest,
    statements,
    footer: {
      manifest_sha256: await createManifestSha256(manifest),
      statement_count: statements.length,
      statement_chain_sha256: await createStatementChainSha256(statements),
    },
  });
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: createFakeD1().database,
    EDGE_DB: createFakeD1().database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    STUDIO_SITE_MODE: 'operational',
    STUDIO_AUTH_SECRET: 'test-auth-secret-value-with-at-least-32-characters',
    STUDIO_OPERATIONS_ALLOWED_IPS: allowedIp,
    STUDIO_OPERATIONS_TOKEN: operationsToken,
    ...overrides,
  };
}

function request(path: string, input: {
  method?: 'GET' | 'POST' | 'PUT';
  token?: string;
  ip?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
} = {}) {
  const method = input.method ?? 'GET';
  return new Request(`http://studio.local${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${input.token ?? operationsToken}`,
      'CF-Connecting-IP': input.ip ?? allowedIp,
      ...(method === 'POST' || method === 'PUT'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...input.headers,
    },
    body: method === 'POST' || method === 'PUT'
      ? JSON.stringify(input.body ?? {
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
          confirmation: 'CLEAR SITE CONTENT',
        })
      : undefined,
  });
}

afterEach(() => {
  resetSystemIncidentDeduplicationForTests();
  vi.restoreAllMocks();
});

describe('Maintenance and Recovery routes', () => {
  it('requires an administrator Studio session in operational mode', async () => {
    const anonymous = await createApp({
      resolveSession: vi.fn().mockResolvedValue(null),
    }).fetch(
      request('/api/system/operations/status'),
      env(),
    );
    expect(anonymous.status).toBe(401);
    await expect(anonymous.json()).resolves.toEqual({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    });

    const editor = await createApp({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
    }).fetch(
      request('/api/system/operations/status'),
      env(),
    );
    expect(editor.status).toBe(403);
    await expect(editor.json()).resolves.toEqual({
      success: false,
      error: { code: 'FORBIDDEN' },
    });
  });

  it('keeps maintenance access independent from a Studio session', async () => {
    const response = await createApp({
      resolveSession: vi.fn().mockResolvedValue(null),
    }).fetch(
      request('/api/system/operations/status'),
      env({ STUDIO_SITE_MODE: 'maintenance' }),
    );
    expect(response.status).toBe(200);
  });

  it('manages Cloudflare Access only through the unlocked operational boundary', async () => {
    const now = new Date('2026-09-02T03:00:00.000Z');
    const identity = {
      issuer: 'https://zeropress.cloudflareaccess.com',
      team_domain: 'zeropress',
      audience: 'a'.repeat(64),
      identity_email: 'owner@example.com',
    };
    const disabledDocument = {
      settings: {
        mode: 'disabled' as const,
        issuer: null,
        audience: null,
        bound_origin: null,
        verified_at_iso: null,
      },
      revision: '1'.repeat(32),
      updated_at_iso: null,
    };
    const requiredDocument = {
      settings: {
        mode: 'required' as const,
        issuer: identity.issuer,
        audience: identity.audience,
        bound_origin: 'https://studio.example.com',
        verified_at_iso: now.toISOString(),
      },
      revision: '2'.repeat(32),
      updated_at_iso: now.toISOString(),
    };
    const readSettings = vi.fn().mockResolvedValue(disabledDocument);
    const updateSettings = vi.fn().mockResolvedValue({
      kind: 'completed',
      document: requiredDocument,
    });
    const verifyAssertion = vi.fn().mockResolvedValue({
      state: 'verified',
      identity,
    });
    const app = createApp({
      operations: {
        readCloudflareAccessSettings: readSettings,
        updateCloudflareAccessSettings: updateSettings,
        verifyCloudflareAccessAssertion: verifyAssertion,
        now: () => now,
        createSettingsRevision: () => requiredDocument.revision,
      },
    });

    const readResponse = await app.fetch(request(
      '/api/system/operations/cloudflare-access',
      { headers: { 'Cf-Access-Jwt-Assertion': 'signed-token' } },
    ), env());
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toEqual({
      success: true,
      data: {
        ...disabledDocument,
        detection_state: 'verified',
        detected: identity,
      },
    });

    const updateResponse = await app.fetch(new Request(
      'https://studio.example.com/api/system/operations/cloudflare-access',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${operationsToken}`,
          'CF-Connecting-IP': allowedIp,
          'Cf-Access-Jwt-Assertion': 'signed-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'required',
          expected_revision: disabledDocument.revision,
        }),
      },
    ), env());
    expect(updateResponse.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      db: expect.anything(),
      settings: requiredDocument.settings,
      expectedRevision: disabledDocument.revision,
      updatedBy: administratorId,
      now,
      createRevision: expect.any(Function),
    });
    expect(verifyAssertion).toHaveBeenCalledTimes(2);
  });

  it('does not expose Cloudflare Access management before token verification', async () => {
    const readSettings = vi.fn();
    const response = await createApp({
      operations: { readCloudflareAccessSettings: readSettings },
    }).fetch(new Request(
      'http://studio.local/api/system/operations/cloudflare-access',
      { headers: { 'CF-Connecting-IP': allowedIp } },
    ), env());

    expect(response.status).toBe(401);
    expect(readSettings).not.toHaveBeenCalled();
  });

  it('preserves the Access assertion requirement on the Operations settings route', async () => {
    const response = await createApp({
      operations: {
        readCloudflareAccessSettings: vi.fn().mockResolvedValue({
          settings: {
            mode: 'required',
            issuer: 'https://zeropress.cloudflareaccess.com',
            audience: 'a'.repeat(64),
            bound_origin: 'http://studio.local',
            verified_at_iso: '2026-09-02T03:00:00.000Z',
          },
          revision: '1'.repeat(32),
          updated_at_iso: '2026-09-02T03:00:00.000Z',
        }),
        verifyCloudflareAccessAssertion: vi.fn().mockResolvedValue({
          state: 'missing',
        }),
      },
    }).fetch(request(
      '/api/system/operations/cloudflare-access',
    ), env());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'CLOUDFLARE_ACCESS_REQUIRED' },
    });
  });

  it('looks absent when the feature is disabled without reading D1', async () => {
    const fakeD1 = createFakeD1();
    const response = await createApp().fetch(
      request('/api/system/operations/status'),
      env({
        DB: fakeD1.database,
        STUDIO_OPERATIONS_ALLOWED_IPS: undefined,
      }),
    );

    expect(response.status).toBe(404);
    expect(fakeD1.getPrepareCallCount()).toBe(0);
  });

  it('does not trust X-Forwarded-For when Cloudflare IP is not allowed', async () => {
    const response = await createApp().fetch(
      request('/api/system/operations/status', {
        ip: '198.51.100.20',
        headers: { 'X-Forwarded-For': allowedIp },
      }),
      env(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
  });

  it('returns fixed resolved secret states without exposing their values', async () => {
    const environment = env({ STUDIO_SITE_MODE: 'maintenance' });

    const response = await createApp().fetch(
      request('/api/system/operations/status'),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: expect.objectContaining({
        site_mode: 'maintenance',
        current_ip: allowedIp,
        allowed_ips: [allowedIp],
        actions: {
          clear_site_content: {
            available: true,
            requires_maintenance: false,
            confirmation: 'CLEAR SITE CONTENT',
          },
          reset_studio: {
            available: true,
            requires_maintenance: true,
            confirmation: 'RESET STUDIO',
          },
          uninstall_studio: {
            available: true,
            requires_maintenance: true,
            confirmation: 'UNINSTALL STUDIO',
          },
          recover_administrator: {
            available: false,
            requires_maintenance: false,
            confirmation: 'RECOVER ADMINISTRATOR',
          },
        },
        database_upgrade: {
          state: 'up_to_date',
          current_schema_version: STUDIO_SCHEMA_VERSION,
          target_schema_version: STUDIO_SCHEMA_VERSION,
          available: false,
          operation_id: null,
          steps: [],
          confirmation: 'UPGRADE STUDIO DATABASE',
        },
        environment: expect.arrayContaining([
          {
            name: 'STUDIO_INSTALL_TOKEN',
            exposure: 'presence',
            expected_storage: 'worker_secret',
            state: 'missing',
          },
          {
            name: 'STUDIO_OPERATIONS_TOKEN',
            exposure: 'presence',
            expected_storage: 'worker_secret',
            state: 'valid',
          },
          {
            name: 'STUDIO_AUTH_SECRET',
            exposure: 'presence',
            expected_storage: 'worker_secret',
            state: 'valid',
          },
        ]),
      }),
    });
  });

  it('distinguishes a post-install token that must be removed from an invalid auth secret', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await createApp().fetch(
      request('/api/system/operations/status'),
      env({
        STUDIO_SITE_MODE: 'maintenance',
        STUDIO_INSTALL_TOKEN: '한'.repeat(32),
        STUDIO_AUTH_SECRET: '',
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: expect.objectContaining({
        environment: expect.arrayContaining([
          {
            name: 'STUDIO_INSTALL_TOKEN',
            exposure: 'presence',
            expected_storage: 'worker_secret',
            state: 'must_be_removed',
          },
          {
            name: 'STUDIO_AUTH_SECRET',
            exposure: 'presence',
            expected_storage: 'worker_secret',
            state: 'invalid',
          },
        ]),
      }),
    });
  });

  it('keeps Edge-backed clear and reset unavailable when EDGE_DB is not bound without blocking Studio uninstall', async () => {
    const response = await createApp({
      operations: {
        materializeEdgeServices: async () => ({
          settings: { mode: 'enabled' },
          effective_state: 'unavailable',
          unavailable_reason: 'edge_db_binding_missing',
          pending_target_events: 0,
          revision: 'e'.repeat(32),
          updated_at_iso: '2026-08-01T00:00:00.000Z',
        }),
      },
    }).fetch(
      request('/api/system/operations/status'),
      env({ STUDIO_SITE_MODE: 'maintenance', EDGE_DB: undefined }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: expect.objectContaining({
        bindings: expect.objectContaining({
          EDGE_DB: { bound: false },
        }),
        actions: expect.objectContaining({
          clear_site_content: expect.objectContaining({ available: false }),
          reset_studio: expect.objectContaining({ available: false }),
          uninstall_studio: expect.objectContaining({ available: true }),
        }),
      }),
    });
  });

  it('keeps destructive recovery available for an enabled target mismatch', async () => {
    const response = await createApp({
      operations: {
        materializeEdgeServices: async () => ({
          settings: { mode: 'enabled' },
          effective_state: 'reconciliation_required',
          unavailable_reason: 'target_mismatch',
          pending_target_events: 0,
          revision: 'e'.repeat(32),
          updated_at_iso: '2026-08-01T00:00:00.000Z',
        }),
      },
    }).fetch(
      request('/api/system/operations/status'),
      env({ STUDIO_SITE_MODE: 'maintenance' }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        edge_integration: {
          mode: 'enabled',
          document: { effective_state: 'reconciliation_required' },
        },
        actions: {
          clear_site_content: { available: true },
          reset_studio: { available: true },
        },
      },
    });
  });

  it('reports upgrade unavailability without querying a missing lifecycle table', async () => {
    const emptyDatabase = createFakeD1({ tables: [], schemaState: null });
    const response = await createApp().fetch(
      request('/api/system/operations/status'),
      env({
        DB: emptyDatabase.database,
        STUDIO_SITE_MODE: 'maintenance',
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        database: { state: 'uninstalled' },
        database_upgrade: {
          state: 'unavailable',
          reason: 'database_uninstalled',
          current_schema_version: null,
        },
        edge_integration: { mode: 'disabled' },
      },
    });
  });

  it('keeps Edge lifecycle mutations unavailable until the Studio database is ready', async () => {
    const emptyDatabase = createFakeD1({ tables: [], schemaState: null });
    const inspectEdgeDatabase = vi.fn().mockResolvedValue({
      state: 'uninstalled',
      current_schema_version: null,
      target_schema_version: 1,
      operation_id: null,
      next_upgrade_steps: [],
      install_available: true,
      adopt_available: false,
      upgrade_available: false,
    });
    const response = await createApp({
      operations: { inspectEdgeDatabase },
    }).fetch(request('/api/system/operations/status'), env({
      DB: emptyDatabase.database,
      STUDIO_SITE_MODE: 'maintenance',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        database: { state: 'uninstalled' },
        edge_database: {
          state: 'uninstalled',
          install_available: false,
          adopt_available: false,
          upgrade_available: false,
        },
      },
    });
  });

  it('offers only the Edge upgrade and Edge backup in operational mode', async () => {
    const nextStep = {
      id: 'edge_schema_1_to_2',
      from_version: 1,
      to_version: 2,
      sha256: 'a'.repeat(64),
      statement_count: 3,
    };
    const inspectEdgeDatabase = vi.fn().mockResolvedValue({
      state: 'upgrade_required',
      current_schema_version: 1,
      target_schema_version: 2,
      operation_id: null,
      next_upgrade_steps: [nextStep],
      install_available: false,
      adopt_available: false,
      upgrade_available: true,
    });
    const response = await createApp({
      operations: { inspectEdgeDatabase },
    }).fetch(request('/api/system/operations/status'), env({
      STUDIO_SITE_MODE: 'operational',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        edge_database: {
          state: 'upgrade_required',
          install_available: false,
          adopt_available: false,
          upgrade_available: true,
        },
        database_transfer: {
          requires_administrator_credentials: true,
          databases: {
            studio: {
              export_available: false,
              restore_available: false,
            },
            edge: {
              export_available: true,
              restore_available: false,
            },
          },
        },
      },
    });
    expect(inspectEdgeDatabase).toHaveBeenCalledWith({
      edgeDb: expect.anything(),
      siteMode: 'operational',
    });
  });

  it('keeps lifecycle operations unavailable for a database newer than the code', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sourceSchemaVersion = STUDIO_SCHEMA_VERSION + 1;
    const response = await createApp().fetch(
      request('/api/system/operations/status'),
      env({
        STUDIO_SITE_MODE: 'maintenance',
        DB: createFakeD1({
          schemaState: {
            ...READY_SCHEMA_STATE,
            schema_version: sourceSchemaVersion,
          },
        }).database,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        database: {
          state: 'newer_than_code',
          schema_version: sourceSchemaVersion,
          target_schema_version: STUDIO_SCHEMA_VERSION,
        },
        database_transfer: {
          requires_administrator_credentials: false,
          databases: {
            studio: {
              export_available: false,
              restore_available: false,
            },
            edge: {
              export_available: false,
              restore_available: false,
            },
          },
        },
        database_upgrade: {
          state: 'unavailable',
          available: false,
        },
        edge_integration: { mode: 'disabled' },
      },
    });
  });

  it('rate limits only tokenless, malformed, or non-matching operations credentials', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const environment = env({
      STUDIO_SITE_MODE: 'maintenance',
      AUTH_ROUTE_RATE_LIMITER: { limit },
    });
    const application = createApp();

    const tokenlessResponse = await application.fetch(request(
      '/api/system/operations/status',
      { headers: { Authorization: '' } },
    ), environment);
    expect(tokenlessResponse.status).toBe(401);

    const malformedResponse = await application.fetch(request(
      '/api/system/operations/status',
      { token: 'too-short' },
    ), environment);
    expect(malformedResponse.status).toBe(401);

    const nonMatchingResponse = await application.fetch(request(
      '/api/system/operations/status',
      { token: 'x'.repeat(32) },
    ), environment);
    expect(nonMatchingResponse.status).toBe(401);

    const verifiedResponse = await application.fetch(request(
      '/api/system/operations/status',
    ), environment);
    expect(verifiedResponse.status).toBe(200);

    expect(limit).toHaveBeenCalledTimes(3);
    expect(limit).toHaveBeenNthCalledWith(1, {
      key: `operations:${allowedIp}`,
    });
    expect(limit).toHaveBeenNthCalledWith(2, {
      key: `operations:${allowedIp}`,
    });
    expect(limit).toHaveBeenNthCalledWith(3, {
      key: `operations:${allowedIp}`,
    });
  });

  it('allows a verified operations token when the failed-attempt bucket is exhausted', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const environment = env({
      STUDIO_SITE_MODE: 'maintenance',
      AUTH_ROUTE_RATE_LIMITER: { limit },
    });
    const application = createApp();

    const rejectedResponse = await application.fetch(request(
      '/api/system/operations/status',
      { headers: { Authorization: '' } },
    ), environment);
    expect(rejectedResponse.status).toBe(429);
    expect(rejectedResponse.headers.get('Retry-After')).toBe('60');

    const verifiedResponse = await application.fetch(request(
      '/api/system/operations/status',
    ), environment);
    expect(verifiedResponse.status).toBe(200);
    expect(limit).toHaveBeenCalledOnce();
  });

  it('starts a reviewed schema upgrade with administrator verification and advances later steps without another account query', async () => {
    const descriptor = {
      id: '001_example',
      from_version: 1,
      to_version: 2,
      sha256: 'a'.repeat(64),
      statement_count: 1,
    };
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: true,
      administratorId,
      administratorEmail: 'admin-canonical@local.host',
    });
    const startSchemaUpgrade = vi.fn().mockResolvedValue({
      operation: 'upgrade_studio_database',
      status: 'started',
      operation_id: '1'.repeat(32),
      current_schema_version: 1,
      target_schema_version: 2,
      next_step: descriptor,
    });
    const applySchemaUpgradeStep = vi.fn().mockResolvedValue({
      operation: 'upgrade_studio_database',
      status: 'completed',
      operation_id: null,
      applied_step: descriptor,
      current_schema_version: 2,
      target_schema_version: 2,
      next_step: null,
    });
    const readSchemaUpgradeInitiator = vi.fn().mockResolvedValue({
      userId: administratorId,
      userEmail: 'admin-canonical@local.host',
    });
    const app = createApp({
      authorizeOperationsAdministrator,
      startSchemaUpgrade,
      applySchemaUpgradeStep,
      operations: { readSchemaUpgradeInitiator },
    });
    const environment = env({ STUDIO_SITE_MODE: 'maintenance' });

    const started = await app.fetch(request(
      '/api/system/operations/database-upgrade/start',
      {
        method: 'POST',
        body: {
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
          backup_acknowledged: true,
          confirmation: 'UPGRADE STUDIO DATABASE',
        },
      },
    ), environment);
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toMatchObject({
      success: true,
      data: { status: 'started', next_step: descriptor },
    });
    expect(authorizeOperationsAdministrator).toHaveBeenCalledOnce();
    expect(startSchemaUpgrade).toHaveBeenCalledWith(expect.objectContaining({
      db: environment.DB,
      request: expect.objectContaining({ backup_acknowledged: true }),
    }));

    const completed = await app.fetch(request(
      '/api/system/operations/database-upgrade/step',
      {
        method: 'POST',
        body: {
          operation_id: '1'.repeat(32),
          step_id: descriptor.id,
          confirmation: 'UPGRADE STUDIO DATABASE',
        },
      },
    ), environment);
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({
      success: true,
      data: { status: 'completed', current_schema_version: 2 },
    });
    expect(authorizeOperationsAdministrator).toHaveBeenCalledOnce();
    expect(readSchemaUpgradeInitiator).toHaveBeenCalledWith({
      db: environment.DB,
      operationId: '1'.repeat(32),
    });
    expect(applySchemaUpgradeStep).toHaveBeenCalledWith({
      db: environment.DB,
      request: {
        operation_id: '1'.repeat(32),
        step_id: descriptor.id,
        confirmation: 'UPGRADE STUDIO DATABASE',
      },
    });
  });

  it('installs Edge DB only through the maintenance boundary and administrator reconfirmation', async () => {
    const installEdgeDatabase = vi.fn().mockResolvedValue(undefined);
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: true,
      administratorId,
      administratorEmail: 'admin-canonical@local.host',
    });
    const app = createApp({
      authorizeOperationsAdministrator,
      operations: { installEdgeDatabase },
    });
    const body = {
      administrator_email: 'owner@example.com',
      administrator_password: 'administrator-password',
      empty_database_acknowledged: true,
      public_edge_writes_disabled: true,
      confirmation: 'INSTALL EDGE DATABASE',
    };

    const blocked = await app.fetch(request(
      '/api/system/operations/edge-database/install',
      { method: 'POST', body },
    ), env({ STUDIO_SITE_MODE: 'operational' }));
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toEqual({
      success: false,
      error: { code: 'OPERATIONS_MAINTENANCE_REQUIRED' },
    });
    expect(installEdgeDatabase).not.toHaveBeenCalled();

    const emptyStudioDatabase = createFakeD1({
      tables: [],
      schemaState: null,
    });
    const studioNotReady = await app.fetch(request(
      '/api/system/operations/edge-database/install',
      { method: 'POST', body },
    ), env({
      DB: emptyStudioDatabase.database,
      STUDIO_SITE_MODE: 'maintenance',
    }));
    expect(studioNotReady.status).toBe(409);
    await expect(studioNotReady.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_DATABASE_STUDIO_NOT_READY' },
    });
    expect(authorizeOperationsAdministrator).not.toHaveBeenCalled();
    expect(installEdgeDatabase).not.toHaveBeenCalled();

    const environment = env({ STUDIO_SITE_MODE: 'maintenance' });
    const installed = await app.fetch(request(
      '/api/system/operations/edge-database/install',
      { method: 'POST', body },
    ), environment);
    expect(installed.status).toBe(200);
    await expect(installed.json()).resolves.toMatchObject({
      success: true,
      data: {
        operation: 'install_edge_database',
        status: 'completed',
        current_schema_version: 1,
        target_schema_version: 1,
      },
    });
    expect(authorizeOperationsAdministrator).toHaveBeenCalledWith({
      db: environment.DB,
      email: 'owner@example.com',
      password: 'administrator-password',
    });
    expect(installEdgeDatabase).toHaveBeenCalledWith({
      edgeDb: environment.EDGE_DB,
    });
  });

  it('runs a resumable Edge DB upgrade through the operational Operations boundary', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(
      () => undefined,
    );
    const operationId = '9'.repeat(32);
    const nextStep = {
      id: 'edge_schema_1_to_2',
      from_version: 1,
      to_version: 2,
      sha256: 'a'.repeat(64),
      statement_count: 3,
    };
    const startEdgeDatabaseUpgrade = vi.fn().mockResolvedValue({
      operationId,
      currentVersion: 1,
      targetVersion: 2,
      nextStep,
    });
    const applyEdgeDatabaseUpgrade = vi.fn().mockResolvedValue({
      completed: true,
      currentVersion: 2,
      targetVersion: 2,
      nextStep: null,
    });
    const readEdgeDatabaseUpgradeInitiator = vi.fn().mockResolvedValue({
      userId: administratorId,
      userEmail: 'admin-canonical@local.host',
    });
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: true,
      administratorId,
      administratorEmail: 'admin-canonical@local.host',
    });
    const application = createApp({
      authorizeOperationsAdministrator,
      operations: {
        startEdgeDatabaseUpgrade,
        applyEdgeDatabaseUpgrade,
        readEdgeDatabaseUpgradeInitiator,
      },
    });
    const environment = env({ STUDIO_SITE_MODE: 'operational' });
    const started = await application.fetch(request(
      '/api/system/operations/edge-database/upgrade/start',
      {
        method: 'POST',
        body: {
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
          backup_acknowledged: true,
          public_edge_writes_disabled: true,
          confirmation: 'UPGRADE EDGE DATABASE',
        },
      },
    ), environment);

    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toMatchObject({
      success: true,
      data: {
        operation: 'upgrade_edge_database',
        status: 'started',
        operation_id: operationId,
        next_step: nextStep,
      },
    });
    expect(startEdgeDatabaseUpgrade).toHaveBeenCalledWith({
      edgeDb: environment.EDGE_DB,
      initiator: {
        userId: administratorId,
        userEmail: 'admin-canonical@local.host',
      },
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.objectContaining({
      $zeropress: expect.objectContaining({
        code: 'EDGE_DATABASE_UPGRADE_STARTED',
        operation_id: operationId,
      }),
    }));

    const stepped = await application.fetch(request(
      '/api/system/operations/edge-database/upgrade/step',
      {
        method: 'POST',
        body: {
          operation_id: operationId,
          step_id: nextStep.id,
          confirmation: 'UPGRADE EDGE DATABASE',
        },
      },
    ), environment);

    expect(stepped.status).toBe(200);
    await expect(stepped.json()).resolves.toMatchObject({
      success: true,
      data: {
        operation: 'upgrade_edge_database',
        status: 'completed',
        current_schema_version: 2,
      },
    });
    expect(applyEdgeDatabaseUpgrade).toHaveBeenCalledWith({
      edgeDb: environment.EDGE_DB,
      operationId,
      stepId: nextStep.id,
    });
  });

  it('changes the Studio Edge integration mode through the operations boundary without reading Edge when disabling', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const inspectEdgeIntegration = vi.fn();
    const updateEdgeIntegration = vi.fn().mockResolvedValue({
      kind: 'completed',
      document: {
        settings: { mode: 'disabled' },
        revision: 'f'.repeat(32),
        updated_at_iso: '2026-08-12T00:00:00.000Z',
      },
    });
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: true,
      administratorId,
      administratorEmail: 'admin-canonical@local.host',
    });
    const environment = env();
    const response = await createApp({
      authorizeOperationsAdministrator,
      operations: { inspectEdgeIntegration, updateEdgeIntegration },
    }).fetch(request('/api/system/operations/edge-integration', {
      method: 'POST',
      body: {
        mode: 'disabled',
        administrator_email: 'owner@example.com',
        administrator_password: 'administrator-password',
        expected_revision: 'e'.repeat(32),
        confirmation: 'DISABLE EDGE INTEGRATION',
      },
    }), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        settings: { mode: 'disabled' },
        effective_state: 'disabled',
        pending_target_events: 0,
        revision: 'f'.repeat(32),
        updated_at_iso: '2026-08-12T00:00:00.000Z',
      },
    });
    expect(inspectEdgeIntegration).not.toHaveBeenCalled();
    expect(updateEdgeIntegration).toHaveBeenCalledWith({
      db: environment.DB,
      mode: 'disabled',
      expectedRevision: 'e'.repeat(32),
      updatedBy: administratorId,
    });
  });

  it('keeps integration disabled when activation requires Edge installation', async () => {
    const updateEdgeIntegration = vi.fn();
    const inspectEdgeIntegration = vi.fn().mockResolvedValue({
      state: 'unavailable',
      reason: 'database_uninstalled',
    });
    const response = await createApp({
      authorizeOperationsAdministrator: vi.fn().mockResolvedValue({
        authorized: true,
        administratorId,
        administratorEmail: 'admin-canonical@local.host',
      }),
      operations: { inspectEdgeIntegration, updateEdgeIntegration },
    }).fetch(request('/api/system/operations/edge-integration', {
      method: 'POST',
      body: {
        mode: 'enabled',
        administrator_email: 'owner@example.com',
        administrator_password: 'administrator-password',
        expected_revision: 'e'.repeat(32),
        confirmation: 'ENABLE EDGE INTEGRATION',
      },
    }), env({
      DB: createFakeD1({ edgeIntegrationMode: 'disabled' }).database,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_DATABASE_INSTALL_REQUIRED' },
    });
    expect(updateEdgeIntegration).not.toHaveBeenCalled();
  });

  it('previews and uninstalls only a ready Edge database while integration is disabled', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const inspectEdgeDatabase = vi.fn().mockResolvedValue({
      state: 'ready',
      current_schema_version: 1,
      target_schema_version: 1,
      operation_id: null,
      next_upgrade_steps: [],
      install_available: false,
      adopt_available: false,
      upgrade_available: false,
    });
    const deletedRows = {
      'EDGE_DB.comments': 12,
      'EDGE_DB.edge_comment_targets': 3,
      'EDGE_DB.zeropress_edge_schema_state': 1,
    };
    const inspectEdgeUninstall = vi.fn().mockResolvedValue({ deletedRows });
    const uninstallEdgeDatabase = vi.fn().mockResolvedValue({ deletedRows });
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: true,
      administratorId,
      administratorEmail: 'admin-canonical@local.host',
    });
    const application = createApp({
      authorizeOperationsAdministrator,
      operations: {
        inspectEdgeDatabase,
        inspectEdgeUninstall,
        uninstallEdgeDatabase,
      },
    });
    const environment = env({
      DB: createFakeD1({ edgeIntegrationMode: 'disabled' }).database,
      STUDIO_SITE_MODE: 'maintenance',
    });
    const body = {
      administrator_email: 'owner@example.com',
      administrator_password: 'administrator-password',
      backup_acknowledged: true,
      public_edge_writes_disabled: true,
      pending_mail_acknowledged: true,
      confirmation: 'UNINSTALL EDGE DATABASE',
    };

    const preview = await application.fetch(request(
      '/api/system/operations/edge-database/uninstall/preview',
      { method: 'POST', body },
    ), environment);
    expect(preview.status).toBe(200);
    await expect(preview.json()).resolves.toEqual({
      success: true,
      data: {
        operation: 'uninstall_edge_database',
        expected_effects: { deleted_rows: deletedRows },
      },
    });

    const completed = await application.fetch(request(
      '/api/system/operations/edge-database/uninstall',
      { method: 'POST', body },
    ), environment);
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toEqual({
      success: true,
      data: {
        operation: 'uninstall_edge_database',
        status: 'completed',
        effects: { deleted_rows: deletedRows },
      },
    });
    expect(inspectEdgeUninstall).toHaveBeenCalledWith({
      edgeDb: environment.EDGE_DB,
    });
    expect(uninstallEdgeDatabase).toHaveBeenCalledWith({
      edgeDb: environment.EDGE_DB,
    });
    expect(authorizeOperationsAdministrator).toHaveBeenCalledTimes(2);
  });

  it('refuses Edge database uninstall before parsing credentials while integration is enabled', async () => {
    const inspectEdgeDatabase = vi.fn();
    const inspectEdgeUninstall = vi.fn();
    const authorizeOperationsAdministrator = vi.fn();
    const response = await createApp({
      authorizeOperationsAdministrator,
      operations: { inspectEdgeDatabase, inspectEdgeUninstall },
    }).fetch(request(
      '/api/system/operations/edge-database/uninstall/preview',
      {
        method: 'POST',
        body: {
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
          backup_acknowledged: true,
          public_edge_writes_disabled: true,
          pending_mail_acknowledged: true,
          confirmation: 'UNINSTALL EDGE DATABASE',
        },
      },
    ), env({ STUDIO_SITE_MODE: 'maintenance' }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_INTEGRATION_MUST_BE_DISABLED' },
    });
    expect(inspectEdgeDatabase).not.toHaveBeenCalled();
    expect(inspectEdgeUninstall).not.toHaveBeenCalled();
    expect(authorizeOperationsAdministrator).not.toHaveBeenCalled();
  });

  it('starts target reconciliation only after lifecycle and safety acknowledgements', async () => {
    const inspectEdgeDatabase = vi.fn().mockResolvedValue({
      state: 'ready',
      current_schema_version: 1,
      target_schema_version: 1,
      operation_id: null,
      next_upgrade_steps: [],
      install_available: false,
      adopt_available: false,
      upgrade_available: false,
    });
    const startEdgeReconciliation = vi.fn().mockResolvedValue({
      state: 'in_progress',
      operation_id: '9'.repeat(32),
      phase: 'drain_outbox',
      processed_posts: 0,
      processed_pages: 0,
      scanned_edge_targets: 0,
      orphan_targets: 0,
      orphan_comments: 0,
      available: true,
    });
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: true,
      administratorId,
      administratorEmail: 'admin-canonical@local.host',
    });
    const environment = env({ STUDIO_SITE_MODE: 'maintenance' });
    const response = await createApp({
      authorizeOperationsAdministrator,
      operations: {
        inspectEdgeDatabase,
        startEdgeReconciliation,
      },
    }).fetch(request(
      '/api/system/operations/edge-target-reconciliation/start',
      {
        method: 'POST',
        body: {
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
          backup_acknowledged: true,
          public_edge_writes_disabled: true,
          confirmation: 'RECONCILE EDGE TARGETS',
        },
      },
    ), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        operation: 'reconcile_edge_comment_targets',
        status: 'started',
        reconciliation: {
          operation_id: '9'.repeat(32),
          phase: 'drain_outbox',
        },
      },
    });
    expect(inspectEdgeDatabase).toHaveBeenCalledWith({
      edgeDb: environment.EDGE_DB,
      siteMode: 'maintenance',
    });
    expect(startEdgeReconciliation).toHaveBeenCalledWith({
      db: environment.DB,
      initiator: {
        userId: administratorId,
        userEmail: 'admin-canonical@local.host',
      },
    });
  });

  it('starts and resumes the checkpointed content-search rebuild', async () => {
    const active = {
      state: 'in_progress' as const,
      reason: 'manual_rebuild' as const,
      phase: 'posts' as const,
      operation_id: 'c'.repeat(32),
      post_public_id_cursor: 0,
      page_public_id_cursor: 0,
      processed_posts: 0,
      processed_pages: 0,
      total_posts: 8,
      total_pages: 2,
      available: true,
    };
    const complete = {
      ...active,
      state: 'ready' as const,
      reason: null,
      phase: null,
      operation_id: null,
      post_public_id_cursor: 8,
      page_public_id_cursor: 2,
      processed_posts: 8,
      processed_pages: 2,
    };
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: true,
      administratorId,
      administratorEmail: 'admin-canonical@local.host',
    });
    const startContentSearchIndexRebuild = vi.fn().mockResolvedValue(active);
    const applyContentSearchIndexRebuildStep = vi.fn()
      .mockResolvedValue(complete);
    const readContentSearchRebuildInitiator = vi.fn().mockResolvedValue({
      userId: administratorId,
      userEmail: 'admin-canonical@local.host',
    });
    const application = createApp({
      authorizeOperationsAdministrator,
      operations: {
        startContentSearchIndexRebuild,
        applyContentSearchIndexRebuildStep,
        readContentSearchRebuildInitiator,
      },
    });
    const environment = env({ STUDIO_SITE_MODE: 'maintenance' });
    const started = await application.fetch(request(
      '/api/system/operations/content-search-index/rebuild/start',
      {
        method: 'POST',
        body: {
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
          confirmation: CONTENT_SEARCH_REBUILD_CONFIRMATION,
        },
      },
    ), environment);
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toMatchObject({
      success: true,
      data: {
        operation: 'rebuild_content_search_index',
        status: 'started',
        content_search_index: active,
      },
    });
    expect(startContentSearchIndexRebuild).toHaveBeenCalledWith({
      db: environment.DB,
      initiator: {
        userId: administratorId,
        userEmail: 'admin-canonical@local.host',
      },
    });

    const stepRequest = {
      operation_id: active.operation_id,
      expected_phase: active.phase,
      expected_post_public_id_cursor: 0,
      expected_page_public_id_cursor: 0,
    };
    const stepped = await application.fetch(request(
      '/api/system/operations/content-search-index/rebuild/step',
      { method: 'POST', body: stepRequest },
    ), environment);
    expect(stepped.status).toBe(200);
    await expect(stepped.json()).resolves.toMatchObject({
      success: true,
      data: {
        operation: 'rebuild_content_search_index',
        status: 'completed',
        content_search_index: complete,
      },
    });
    expect(readContentSearchRebuildInitiator).toHaveBeenCalledWith({
      db: environment.DB,
      operationId: active.operation_id,
    });
    expect(applyContentSearchIndexRebuildStep).toHaveBeenCalledWith({
      db: environment.DB,
      request: stepRequest,
    });
  });

  it('exports a ready Studio DB after maintenance administrator verification', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(
      () => undefined,
    );
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: true,
      administratorId,
      administratorEmail: 'admin-canonical@local.host',
    });
    const exportDatabaseBackup = vi.fn().mockResolvedValue({
      sql: '-- reviewed backup\n',
      filename: 'zeropress-studio-structure_and_data.sql',
      manifest: {
        tables: [{ name: 'users', row_count: 1 }],
      },
    });
    const environment = env({
      STUDIO_SITE_MODE: 'maintenance',
      DB: createFakeD1().database,
    });
    const response = await createApp({
      authorizeOperationsAdministrator,
      exportDatabaseBackup,
    }).fetch(request('/api/system/operations/database-backup', {
      method: 'POST',
      body: {
        database: 'studio',
        mode: 'structure_and_data',
        administrator_email: 'owner@example.com',
        administrator_password: 'administrator-password',
      },
    }), environment);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/sql');
    expect(response.headers.get('Content-Disposition')).toContain(
      'zeropress-studio-structure_and_data.sql',
    );
    await expect(response.text()).resolves.toBe('-- reviewed backup\n');
    expect(authorizeOperationsAdministrator).toHaveBeenCalledWith({
      db: environment.DB,
      email: 'owner@example.com',
      password: 'administrator-password',
    });
    expect(exportDatabaseBackup).toHaveBeenCalledWith({
      db: environment.DB,
      database: 'studio',
      mode: 'structure_and_data',
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.objectContaining({
      $zeropress: expect.objectContaining({
        code: 'DATABASE_BACKUP_EXPORT_COMPLETED',
        initiated_by_user_id: administratorId,
        initiated_by_user_email: 'admin-canonical@local.host',
      }),
    }));
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(
      'owner@example.com',
    );
  });

  it('exports only Edge DB in operational mode after administrator verification', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: true,
      administratorId,
      administratorEmail: 'admin-canonical@local.host',
    });
    const exportDatabaseBackup = vi.fn().mockResolvedValue({
      sql: '-- reviewed Edge backup\n',
      filename: 'zeropress-edge-structure_and_data.sql',
      manifest: {
        tables: [{ name: 'comments', row_count: 1 }],
      },
    });
    const application = createApp({
      authorizeOperationsAdministrator,
      exportDatabaseBackup,
    });
    const environment = env({ STUDIO_SITE_MODE: 'operational' });
    const edgeBackup = await application.fetch(request(
      '/api/system/operations/database-backup',
      {
        method: 'POST',
        body: {
          database: 'edge',
          mode: 'structure_and_data',
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
        },
      },
    ), environment);

    expect(edgeBackup.status).toBe(200);
    await expect(edgeBackup.text()).resolves.toBe('-- reviewed Edge backup\n');
    expect(exportDatabaseBackup).toHaveBeenCalledWith({
      db: environment.EDGE_DB,
      database: 'edge',
      mode: 'structure_and_data',
    });

    const studioBackup = await application.fetch(request(
      '/api/system/operations/database-backup',
      {
        method: 'POST',
        body: {
          database: 'studio',
          mode: 'structure_and_data',
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
        },
      },
    ), environment);
    expect(studioBackup.status).toBe(409);
    await expect(studioBackup.json()).resolves.toEqual({
      success: false,
      error: { code: 'DATABASE_BACKUP_NOT_AVAILABLE' },
    });
    expect(exportDatabaseBackup).toHaveBeenCalledOnce();
    expect(authorizeOperationsAdministrator).toHaveBeenCalledOnce();
  });

  it('rejects an unavailable operational Edge backup before administrator verification', async () => {
    const authorizeOperationsAdministrator = vi.fn();
    const exportDatabaseBackup = vi.fn();
    const response = await createApp({
      authorizeOperationsAdministrator,
      exportDatabaseBackup,
      operations: {
        inspectEdgeDatabase: vi.fn().mockResolvedValue({
          state: 'unavailable',
          current_schema_version: null,
          target_schema_version: 1,
          operation_id: null,
          next_upgrade_steps: [],
          install_available: false,
          adopt_available: false,
          upgrade_available: false,
        }),
      },
    }).fetch(request('/api/system/operations/database-backup', {
      method: 'POST',
      body: {
        database: 'edge',
        mode: 'structure_and_data',
        administrator_email: 'owner@example.com',
        administrator_password: 'administrator-password',
      },
    }), env({ STUDIO_SITE_MODE: 'operational' }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'DATABASE_BACKUP_NOT_AVAILABLE' },
    });
    expect(authorizeOperationsAdministrator).not.toHaveBeenCalled();
    expect(exportDatabaseBackup).not.toHaveBeenCalled();
  });

  it('uses the out-of-band recovery boundary without querying administrator credentials', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(
      () => undefined,
    );
    const authorizeOperationsAdministrator = vi.fn();
    const exportDatabaseBackup = vi.fn().mockResolvedValue({
      sql: '-- recovery backup\n',
      filename: 'zeropress-edge-data_only.sql',
      manifest: { tables: [{ name: 'comments', row_count: 2 }] },
    });
    const environment = env({ STUDIO_SITE_MODE: 'recovery' });
    const response = await createApp({
      authorizeOperationsAdministrator,
      exportDatabaseBackup,
    }).fetch(request('/api/system/operations/database-backup', {
      method: 'POST',
      body: { database: 'edge', mode: 'data_only' },
    }), environment);

    expect(response.status).toBe(200);
    expect(authorizeOperationsAdministrator).not.toHaveBeenCalled();
    expect(exportDatabaseBackup).toHaveBeenCalledWith({
      db: environment.EDGE_DB,
      database: 'edge',
      mode: 'data_only',
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.objectContaining({
      $zeropress: expect.objectContaining({
        code: 'DATABASE_BACKUP_EXPORT_COMPLETED',
      }),
    }));
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(
      'initiated_by_user_',
    );
  });

  it('starts a preflighted, confirmed, journaled restore', async () => {
    const sql = await databaseBackupArtifact();
    const plan = await createDatabaseRestorePlan(
      await inspectDatabaseBackupArtifact(sql),
    );
    const startDatabaseRestore = vi.fn().mockImplementation(async (input) => {
      input.beforeBatch?.();
      return {
        database: 'studio',
        mode: 'data_only',
        restoreId: 'a'.repeat(32),
        expectedChunkCount: 1,
      };
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(
      () => undefined,
    );
    const response = await createApp({
      authorizeOperationsAdministrator: vi.fn().mockResolvedValue({
        authorized: true,
        administratorId,
        administratorEmail: 'admin-canonical@local.host',
      }),
      startDatabaseRestore,
    }).fetch(request('/api/system/operations/database-restore/start', {
      method: 'POST',
      body: {
        database: 'studio',
        manifest: plan.manifest,
        manifest_sha256: plan.footer.manifest_sha256,
        artifact_digest: plan.artifactDigest,
        artifact_statement_count: plan.footer.statement_count,
        expected_chunk_count: plan.chunkCount,
        table_statements: plan.tableStatements,
        secondary_statements: plan.secondaryStatements,
        confirmation: 'RESTORE DATABASE',
        administrator_email: 'owner@example.com',
        administrator_password: 'administrator-password',
      },
    }), env({ STUDIO_SITE_MODE: 'maintenance' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        operation: 'restore_database',
        database: 'studio',
        mode: 'data_only',
        status: 'started',
        restore_id: 'a'.repeat(32),
      },
    });
    expect(startDatabaseRestore).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('rejects malformed restore start requests without an operation event', async () => {
    const startDatabaseRestore = vi.fn();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(
      () => undefined,
    );
    const response = await createApp({
      authorizeOperationsAdministrator: vi.fn().mockResolvedValue({
        authorized: true,
        administratorId,
        administratorEmail: 'admin-canonical@local.host',
      }),
      startDatabaseRestore,
    }).fetch(request('/api/system/operations/database-restore/start', {
      method: 'POST',
      body: {
        database: 'studio',
        confirmation: 'RESTORE DATABASE',
        administrator_email: 'owner@example.com',
        administrator_password: 'administrator-password',
      },
    }), env({ STUDIO_SITE_MODE: 'maintenance' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(startDatabaseRestore).not.toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('does not start an Edge restore during a forward-only Edge upgrade', async () => {
    const sql = await databaseBackupArtifact('edge');
    const plan = await createDatabaseRestorePlan(
      await inspectDatabaseBackupArtifact(sql),
    );
    const startDatabaseRestore = vi.fn();
    const inspectEdgeDatabase = vi.fn().mockResolvedValue({
      state: 'in_progress',
      current_schema_version: 1,
      target_schema_version: 2,
      operation_id: 'a'.repeat(32),
      next_upgrade_steps: [],
      install_available: false,
      adopt_available: false,
      upgrade_available: true,
    });
    const response = await createApp({
      authorizeOperationsAdministrator: vi.fn().mockResolvedValue({
        authorized: true,
        administratorId,
        administratorEmail: 'admin-canonical@local.host',
      }),
      startDatabaseRestore,
      operations: { inspectEdgeDatabase },
    }).fetch(request('/api/system/operations/database-restore/start', {
      method: 'POST',
      body: {
        database: 'edge',
        manifest: plan.manifest,
        manifest_sha256: plan.footer.manifest_sha256,
        artifact_digest: plan.artifactDigest,
        artifact_statement_count: plan.footer.statement_count,
        expected_chunk_count: plan.chunkCount,
        table_statements: plan.tableStatements,
        secondary_statements: plan.secondaryStatements,
        confirmation: 'RESTORE DATABASE',
        administrator_email: 'owner@example.com',
        administrator_password: 'administrator-password',
      },
    }), env({ STUDIO_SITE_MODE: 'maintenance' }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'DATABASE_RESTORE_STATE_CONFLICT' },
    });
    expect(startDatabaseRestore).not.toHaveBeenCalled();
  });

  it('delegates ordered restore chunks and finalization through the recovery boundary', async () => {
    const restoreId = 'c'.repeat(32);
    const artifactDigest = 'd'.repeat(64);
    const limit = vi.fn().mockResolvedValue({ success: false });
    const applyDatabaseRestoreChunk = vi.fn().mockResolvedValue({
      database: 'studio',
      restoreId,
      acceptedChunk: 0,
      nextChunk: 1,
      replayed: false,
    });
    const finalizeDatabaseRestore = vi.fn().mockResolvedValue({
      database: 'studio',
      mode: 'data_only',
      restoredTables: [{ name: 'example', row_count: 1 }],
      restoredStatementCount: 3,
      schemaFingerprint: 'e'.repeat(64),
    });
    const application = createApp({
      applyDatabaseRestoreChunk,
      finalizeDatabaseRestore,
    });
    const environment = env({
      STUDIO_SITE_MODE: 'recovery',
      AUTH_ROUTE_RATE_LIMITER: { limit },
    });

    const chunkResponse = await application.fetch(request(
      '/api/system/operations/database-restore/chunk',
      {
        method: 'POST',
        body: {
          database: 'studio',
          restore_id: restoreId,
          artifact_digest: artifactDigest,
          chunk_index: 0,
          table: 'example',
          columns: ['id'],
          rows: [[1]],
        },
      },
    ), environment);
    expect(chunkResponse.status).toBe(200);
    expect(applyDatabaseRestoreChunk).toHaveBeenCalledOnce();

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(
      () => undefined,
    );
    const finalizeResponse = await application.fetch(request(
      '/api/system/operations/database-restore/finalize',
      {
        method: 'POST',
        body: {
          database: 'studio',
          restore_id: restoreId,
          artifact_digest: artifactDigest,
          expected_chunk_count: 1,
          secondary_statements: [],
        },
      },
    ), environment);
    expect(finalizeResponse.status).toBe(200);
    expect(finalizeDatabaseRestore).toHaveBeenCalledOnce();
    expect(limit).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it('previews the exact uninstall effects after administrator verification', async () => {
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: true,
      administratorId,
      administratorEmail: 'admin-canonical@local.host',
    });
    const inspectUninstallStudio = vi.fn().mockResolvedValue({
      deletedRows: {
        site_settings: 1,
        user_roles: 0,
        roles: 2,
        users: 100,
        zeropress_schema_state: 1,
      },
    });
    const environment = env({ STUDIO_SITE_MODE: 'maintenance' });
    const response = await createApp({
      authorizeOperationsAdministrator,
      inspectUninstallStudio,
    }).fetch(
      request('/api/system/operations/uninstall-studio/preview', {
        method: 'POST',
        body: {
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
          confirmation: 'UNINSTALL STUDIO',
        },
      }),
      environment,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        operation: 'uninstall_studio',
        expected_effects: {
          deleted_rows: {
            site_settings: 1,
            user_roles: 0,
            roles: 2,
            users: 100,
            zeropress_schema_state: 1,
          },
        },
      },
    });
    expect(authorizeOperationsAdministrator).toHaveBeenCalledWith({
      db: environment.DB,
      email: 'owner@example.com',
      password: 'administrator-password',
    });
    expect(inspectUninstallStudio).toHaveBeenCalledWith(environment.DB);
    expect(
      authorizeOperationsAdministrator.mock.invocationCallOrder[0],
    ).toBeLessThan(inspectUninstallStudio.mock.invocationCallOrder[0] ?? 0);
  });

  it('rejects invalid administrator credentials before uninstall inspection', async () => {
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: false,
    });
    const inspectUninstallStudio = vi.fn();
    const response = await createApp({
      authorizeOperationsAdministrator,
      inspectUninstallStudio,
    }).fetch(
      request('/api/system/operations/uninstall-studio/preview', {
        method: 'POST',
        body: {
          administrator_email: 'owner@example.com',
          administrator_password: 'wrong-password',
          confirmation: 'UNINSTALL STUDIO',
        },
      }),
      env({ STUDIO_SITE_MODE: 'maintenance' }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'INVALID_OPERATIONS_CREDENTIALS' },
    });
    expect(inspectUninstallStudio).not.toHaveBeenCalled();
  });

  it('requires maintenance before inspecting the uninstall preview', async () => {
    const inspectUninstallStudio = vi.fn();
    const response = await createApp({
      inspectUninstallStudio,
    }).fetch(
      request('/api/system/operations/uninstall-studio/preview', {
        method: 'POST',
        body: {
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
          confirmation: 'UNINSTALL STUDIO',
        },
      }),
      env({ STUDIO_SITE_MODE: 'operational' }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'OPERATIONS_MAINTENANCE_REQUIRED' },
    });
    expect(inspectUninstallStudio).not.toHaveBeenCalled();
  });

  it('classifies uninstall preview inspection failures', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const response = await createApp({
      authorizeOperationsAdministrator: vi.fn().mockResolvedValue({
        authorized: true,
        administratorId,
        administratorEmail: 'admin-canonical@local.host',
      }),
      inspectUninstallStudio: vi.fn().mockRejectedValue(
        new Error('Unexpected table set'),
      ),
    }).fetch(
      request('/api/system/operations/uninstall-studio/preview', {
        method: 'POST',
        body: {
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
          confirmation: 'UNINSTALL STUDIO',
        },
      }),
      env({ STUDIO_SITE_MODE: 'maintenance' }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'INTERNAL_ERROR' },
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith({
      message: 'Studio uninstall preview failed',
      $zeropress: {
        code: 'STUDIO_UNINSTALL_PREVIEW_FAILED',
        resource: 'DB',
        action: 'preview_uninstall_studio',
        method: 'POST',
        pathname: '/api/system/operations/uninstall-studio/preview',
        errorType: 'Error',
        initiated_by_user_id: administratorId,
        initiated_by_user_email: 'admin-canonical@local.host',
        guidance: expect.any(String),
      },
    });
  });

  it('rejects an invalid operations token without administrator or operation calls', async () => {
    const authorizeOperationsAdministrator = vi.fn();
    const clearSiteContent = vi.fn();
    const response = await createApp({
      authorizeOperationsAdministrator,
      clearSiteContent,
    }).fetch(
      request('/api/system/operations/clear-content', {
        method: 'POST',
        token: 'wrong-token',
      }),
      env(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'INVALID_OPERATIONS_TOKEN' },
    });
    expect(authorizeOperationsAdministrator).not.toHaveBeenCalled();
    expect(clearSiteContent).not.toHaveBeenCalled();
  });

  it('clears content in operational mode after exact confirmation and admin re-verification', async () => {
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: true,
      administratorId,
      administratorEmail: 'admin-canonical@local.host',
    });
    const clearSiteContent = vi.fn().mockResolvedValue({
      deletedRows: { posts: 2, pages: 1, menus: 1 },
      insertedRows: {},
      updatedRows: {},
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await createApp({
      authorizeOperationsAdministrator,
      clearSiteContent,
    }).fetch(
      request('/api/system/operations/clear-content', {
        method: 'POST',
      }),
      env(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        operation: 'clear_site_content',
        status: 'completed',
        effects: {
          deleted_rows: { posts: 2, pages: 1, menus: 1 },
          inserted_rows: {},
          updated_rows: {},
        },
        resources: { studio: 'completed', edge: 'completed' },
      },
    });
    expect(authorizeOperationsAdministrator).toHaveBeenCalledWith({
      db: expect.anything(),
      email: 'owner@example.com',
      password: 'administrator-password',
    });
    expect(clearSiteContent).toHaveBeenCalledWith({
      db: expect.anything(),
      edgeDb: expect.anything(),
      administratorId,
    });
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio site content clearing completed',
      $zeropress: {
        code: 'CLEAR_SITE_CONTENT_COMPLETED',
        resource: 'DB',
        related_resource: 'EDGE_DB',
        action: 'clear_site_content',
        affected_table_count: 3,
        effects: {
          deleted_rows: { posts: 2, pages: 1, menus: 1 },
          inserted_rows: {},
          updated_rows: {},
        },
        initiated_by_user_id: administratorId,
        initiated_by_user_email: 'admin-canonical@local.host',
        guidance: expect.any(String),
      },
    });
  });

  it('keeps Clear and Reset Studio-only when Edge integration is disabled', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const authorizeOperationsAdministrator = vi.fn().mockResolvedValue({
      authorized: true,
      administratorId,
      administratorEmail: 'admin-canonical@local.host',
    });
    const clearSiteContent = vi.fn();
    const resetStudio = vi.fn();
    const clearStudioContent = vi.fn().mockResolvedValue({
      deletedRows: { posts: 2 }, insertedRows: {}, updatedRows: {},
    });
    const resetStudioDatabase = vi.fn().mockResolvedValue({
      deletedRows: { posts: 2, studio_settings: 8 },
      insertedRows: { roles: 3 },
      updatedRows: {},
    });
    const application = createApp({
      authorizeOperationsAdministrator,
      clearSiteContent,
      clearStudioContent,
      resetStudio,
      resetStudioDatabase,
    });
    const disabledDb = () => createFakeD1({
      edgeIntegrationMode: 'disabled',
    }).database;

    const clearResponse = await application.fetch(
      request('/api/system/operations/clear-content', { method: 'POST' }),
      env({ DB: disabledDb(), EDGE_DB: undefined }),
    );
    expect(clearResponse.status).toBe(200);
    await expect(clearResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        operation: 'clear_site_content',
        resources: { studio: 'completed', edge: 'skipped_disabled' },
      },
    });
    expect(clearStudioContent).toHaveBeenCalledWith({
      db: expect.anything(), mediaBucket: undefined, administratorId,
    });
    expect(clearSiteContent).not.toHaveBeenCalled();

    const resetResponse = await application.fetch(
      request('/api/system/operations/reset-studio', {
        method: 'POST',
        body: {
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
          confirmation: 'RESET STUDIO',
        },
      }),
      env({
        DB: disabledDb(),
        EDGE_DB: undefined,
        STUDIO_SITE_MODE: 'maintenance',
      }),
    );
    expect(resetResponse.status).toBe(200);
    await expect(resetResponse.json()).resolves.toMatchObject({
      success: true,
      data: {
        operation: 'reset_studio',
        resources: { studio: 'completed', edge: 'skipped_disabled' },
      },
    });
    expect(resetStudioDatabase).toHaveBeenCalledWith({
      db: expect.anything(), mediaBucket: undefined, administratorId,
    });
    expect(resetStudio).not.toHaveBeenCalled();
  });

  it('blocks Edge-backed clear before credentials or mutation when the enabled Edge database is not ready', async () => {
    const authorizeOperationsAdministrator = vi.fn();
    const clearSiteContent = vi.fn();
    const response = await createApp({
      authorizeOperationsAdministrator,
      clearSiteContent,
      operations: {
        inspectEdgeDatabase: vi.fn().mockResolvedValue({
          state: 'uninstalled',
          current_schema_version: null,
          target_schema_version: 1,
          operation_id: null,
          next_upgrade_steps: [],
          install_available: false,
          adopt_available: false,
          upgrade_available: false,
        }),
      },
    }).fetch(request('/api/system/operations/clear-content', {
      method: 'POST',
    }), env());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_DATABASE_INSTALL_REQUIRED' },
    });
    expect(authorizeOperationsAdministrator).not.toHaveBeenCalled();
    expect(clearSiteContent).not.toHaveBeenCalled();
  });

  it('retries an Edge-first reset when the previous partial result left target mismatch', async () => {
    const inspectEdgeIntegration = vi.fn().mockResolvedValue({
      state: 'reconciliation_required',
    });
    const resetStudio = vi.fn().mockResolvedValue({
      deletedRows: { pages: 9 },
      insertedRows: { roles: 3, user_roles: 1 },
      updatedRows: { users: 1 },
    });
    const response = await createApp({
      authorizeOperationsAdministrator: vi.fn().mockResolvedValue({
        authorized: true,
        administratorId,
        administratorEmail: 'admin-canonical@local.host',
      }),
      resetStudio,
      operations: { inspectEdgeIntegration },
    }).fetch(request('/api/system/operations/reset-studio', {
      method: 'POST',
      body: {
        administrator_email: 'owner@example.com',
        administrator_password: 'administrator-password',
        confirmation: 'RESET STUDIO',
      },
    }), env({ STUDIO_SITE_MODE: 'maintenance' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        operation: 'reset_studio',
        status: 'completed',
        resources: { studio: 'completed', edge: 'completed' },
      },
    });
    expect(inspectEdgeIntegration).not.toHaveBeenCalled();
    expect(resetStudio).toHaveBeenCalledOnce();
  });

  it('requires maintenance before parsing credentials for reset and uninstall', async () => {
    const authorizeOperationsAdministrator = vi.fn();
    const resetStudio = vi.fn();
    const uninstallStudioDatabase = vi.fn();
    const app = createApp({
      authorizeOperationsAdministrator,
      resetStudio,
      uninstallStudioDatabase,
    });

    for (const [path, confirmation] of [
      ['/api/system/operations/reset-studio', 'RESET STUDIO'],
      ['/api/system/operations/uninstall-studio', 'UNINSTALL STUDIO'],
    ]) {
      const response = await app.fetch(
        request(path, {
          method: 'POST',
          body: {
            administrator_email: 'owner@example.com',
            administrator_password: 'administrator-password',
            confirmation,
          },
        }),
        env({ STUDIO_SITE_MODE: 'operational' }),
      );
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: { code: 'OPERATIONS_MAINTENANCE_REQUIRED' },
      });
    }

    expect(authorizeOperationsAdministrator).not.toHaveBeenCalled();
    expect(resetStudio).not.toHaveBeenCalled();
    expect(uninstallStudioDatabase).not.toHaveBeenCalled();
  });

  it('passes the verified current administrator to the maintenance reset', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const resetStudio = vi.fn().mockResolvedValue({
      deletedRows: { users: 3, posts: 5 },
      insertedRows: {
        roles: 1,
        site_settings: 1,
        user_roles: 1,
      },
      updatedRows: { users: 1 },
    });
    const response = await createApp({
      authorizeOperationsAdministrator: vi.fn().mockResolvedValue({
        authorized: true,
        administratorId,
        administratorEmail: 'admin-canonical@local.host',
      }),
      resetStudio,
    }).fetch(
      request('/api/system/operations/reset-studio', {
        method: 'POST',
        body: {
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
          confirmation: 'RESET STUDIO',
        },
      }),
      env({ STUDIO_SITE_MODE: 'maintenance' }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        operation: 'reset_studio',
        status: 'completed',
        effects: {
          deleted_rows: { users: 3, posts: 5 },
          inserted_rows: {
            roles: 1,
            site_settings: 1,
            user_roles: 1,
          },
          updated_rows: { users: 1 },
        },
        resources: { studio: 'completed', edge: 'completed' },
      },
    });
    expect(resetStudio).toHaveBeenCalledWith({
      db: expect.anything(),
      edgeDb: expect.anything(),
      administratorId,
    });
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio reset completed',
      $zeropress: {
        code: 'STUDIO_RESET_COMPLETED',
        resource: 'DB',
        related_resource: 'EDGE_DB',
        action: 'reset_studio',
        affected_table_count: 5,
        effects: {
          deleted_rows: { users: 3, posts: 5 },
          inserted_rows: {
            roles: 1,
            site_settings: 1,
            user_roles: 1,
          },
          updated_rows: { users: 1 },
        },
        initiated_by_user_id: administratorId,
        initiated_by_user_email: 'admin-canonical@local.host',
        guidance: expect.any(String),
      },
    });
  });

  it('keeps uninstall Studio-DB-only when EDGE_DB is not bound', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const uninstallStudioDatabase = vi.fn().mockResolvedValue({
      deletedRows: { users: 1, zeropress_schema_state: 1 },
      insertedRows: {},
      updatedRows: {},
    });
    const environment = env({
      STUDIO_SITE_MODE: 'maintenance',
      EDGE_DB: undefined,
    });
    const response = await createApp({
      authorizeOperationsAdministrator: vi.fn().mockResolvedValue({
        authorized: true,
        administratorId,
        administratorEmail: 'admin-canonical@local.host',
      }),
      uninstallStudioDatabase,
    }).fetch(
      request('/api/system/operations/uninstall-studio', {
        method: 'POST',
        body: {
          administrator_email: 'owner@example.com',
          administrator_password: 'administrator-password',
          confirmation: 'UNINSTALL STUDIO',
        },
      }),
      environment,
    );

    expect(response.status).toBe(200);
    expect(uninstallStudioDatabase).toHaveBeenCalledWith(environment.DB);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { operation: 'uninstall_studio', status: 'completed' },
    });
    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio uninstall completed',
      $zeropress: {
        code: 'STUDIO_UNINSTALL_COMPLETED',
        resource: 'DB',
        action: 'uninstall_studio',
        affected_table_count: 2,
        effects: {
          deleted_rows: { users: 1, zeropress_schema_state: 1 },
          inserted_rows: {},
          updated_rows: {},
        },
        initiated_by_user_id: administratorId,
        initiated_by_user_email: 'admin-canonical@local.host',
        guidance: expect.any(String),
      },
    });
  });

  it('does not emit an operation event for rejected administrator credentials', async () => {
    const consoleInfoSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const clearSiteContent = vi.fn();
    const response = await createApp({
      authorizeOperationsAdministrator: vi.fn().mockResolvedValue({
        authorized: false,
      }),
      clearSiteContent,
    }).fetch(
      request('/api/system/operations/clear-content', {
        method: 'POST',
      }),
      env(),
    );

    expect(response.status).toBe(401);
    expect(clearSiteContent).not.toHaveBeenCalled();
    expect(consoleInfoSpy).not.toHaveBeenCalled();
  });

  it('records a started event and one classified failure without credentials', async () => {
    const consoleInfoSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const response = await createApp({
      authorizeOperationsAdministrator: vi.fn().mockResolvedValue({
        authorized: true,
        administratorId,
        administratorEmail: 'admin-canonical@local.host',
      }),
      clearSiteContent: vi.fn().mockRejectedValue(
        new Error('D1 batch unavailable'),
      ),
    }).fetch(
      request('/api/system/operations/clear-content', {
        method: 'POST',
      }),
      env(),
    );

    expect(response.status).toBe(500);
    expect(consoleInfoSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    expect(consoleErrorSpy).toHaveBeenCalledWith({
      message: 'Studio site content clearing failed',
      $zeropress: {
        code: 'CLEAR_SITE_CONTENT_FAILED',
        resource: 'DB',
        related_resource: 'EDGE_DB',
        action: 'clear_site_content',
        method: 'POST',
        pathname: '/api/system/operations/clear-content',
        errorType: 'Error',
        initiated_by_user_id: administratorId,
        initiated_by_user_email: 'admin-canonical@local.host',
        guidance: expect.any(String),
      },
    });
    expect(JSON.stringify([
      ...consoleInfoSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ])).not.toContain('administrator-password');
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(
      'owner@example.com',
    );
  });

  it('exposes administrator recovery without account credentials', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listRecoverableAdministrators = vi.fn().mockResolvedValue([
      {
        id: administratorId,
        email: 'owner@example.com',
        name: 'Studio Owner',
        status: 'inactive',
        mfa_configured: true,
      },
    ]);
    const environment = env({
      STUDIO_SITE_MODE: 'recovery',
      DB: createFakeD1().database,
    });
    const response = await createApp({
      listRecoverableAdministrators,
    }).fetch(
      request('/api/system/operations/administrator-recovery'),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        mode: 'existing_administrator',
        administrators: [
          {
            id: administratorId,
            email: 'owner@example.com',
            name: 'Studio Owner',
            status: 'inactive',
            mfa_configured: true,
          },
        ],
        confirmation: 'RECOVER ADMINISTRATOR',
      },
    });
    expect(listRecoverableAdministrators).toHaveBeenCalledWith(
      expect.anything(),
    );
  });

  it('repairs the Cloudflare Access requirement only through recovery mode', async () => {
    const consoleInfoSpy = vi.spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const readCloudflareAccessSettings = vi.fn().mockResolvedValue({
      settings: {
        mode: 'required',
        issuer: 'https://zeropress.cloudflareaccess.com',
        audience: 'a'.repeat(64),
        bound_origin: 'https://studio.example.com',
        verified_at_iso: '2026-08-28T00:00:00.000Z',
      },
      revision: '1'.repeat(32),
      updated_at_iso: '2026-08-28T00:00:00.000Z',
    });
    const recoverCloudflareAccessDisabled = vi.fn().mockResolvedValue({
      settings: {
        mode: 'disabled', issuer: null, audience: null,
        bound_origin: null, verified_at_iso: null,
      },
      revision: '2'.repeat(32),
      updated_at_iso: '2026-08-28T00:01:00.000Z',
    });
    const environment = env({ STUDIO_SITE_MODE: 'recovery' });
    const application = createApp({
      operations: {
        readCloudflareAccessSettings,
        recoverCloudflareAccessDisabled,
      },
    });

    const status = await application.fetch(
      request('/api/system/operations/status'),
      environment,
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      success: true,
      data: {
        cloudflare_access: {
          state: 'required',
          disable_available: true,
          confirmation: 'DISABLE CLOUDFLARE ACCESS',
        },
      },
    });

    const completed = await application.fetch(request(
      '/api/system/operations/cloudflare-access/disable',
      {
        method: 'POST',
        body: { confirmation: 'DISABLE CLOUDFLARE ACCESS' },
      },
    ), environment);
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toEqual({
      success: true,
      data: {
        operation: 'disable_cloudflare_access',
        status: 'completed',
      },
    });
    expect(recoverCloudflareAccessDisabled).toHaveBeenCalledWith({
      db: environment.DB,
    });
    expect(consoleInfoSpy).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Cloudflare Access requirement recovery completed',
      $zeropress: expect.objectContaining({
        code: 'CLOUDFLARE_ACCESS_RECOVERY_COMPLETED',
        action: 'disable_cloudflare_access_requirement',
      }),
    }));

    const rejected = await application.fetch(request(
      '/api/system/operations/cloudflare-access/disable',
      {
        method: 'POST',
        body: { confirmation: 'DISABLE CLOUDFLARE ACCESS' },
      },
    ), env({ STUDIO_SITE_MODE: 'operational' }));
    expect(rejected.status).toBe(409);
    await expect(rejected.json()).resolves.toEqual({
      success: false,
      error: { code: 'CLOUDFLARE_ACCESS_RECOVERY_NOT_AVAILABLE' },
    });
    expect(recoverCloudflareAccessDisabled).toHaveBeenCalledOnce();
  });

  it('advertises the isolated bootstrap flow only when no administrator remains', async () => {
    const listRecoverableAdministrators = vi.fn().mockResolvedValue([]);
    const inspectRecoveryAdministratorBootstrapAvailability = vi.fn()
      .mockResolvedValue('available');
    const environment = env({ STUDIO_SITE_MODE: 'recovery' });
    const response = await createApp({
      listRecoverableAdministrators,
      inspectRecoveryAdministratorBootstrapAvailability,
    }).fetch(
      request('/api/system/operations/administrator-recovery'),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        mode: 'bootstrap_administrator',
        administrators: [],
        confirmation: 'CREATE RECOVERY ADMINISTRATOR',
      },
    });
    expect(inspectRecoveryAdministratorBootstrapAvailability)
      .toHaveBeenCalledWith({ db: environment.DB });
  });

  it('rotates a selected administrator password and optionally removes MFA', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listRecoverableAdministrators = vi.fn().mockResolvedValue([
      {
        id: administratorId,
        email: 'owner@example.com',
        name: 'Studio Owner',
        status: 'active',
        mfa_configured: true,
      },
    ]);
    const hashRecoveryPassword = vi.fn().mockResolvedValue(
      '$argon2id$recovered-password-hash',
    );
    const recoverAdministratorAccess = vi.fn().mockResolvedValue(true);
    const authorizeOperationsAdministrator = vi.fn();
    const consoleSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const environment = env({
      STUDIO_SITE_MODE: 'recovery',
      DB: createFakeD1().database,
    });
    const response = await createApp({
      listRecoverableAdministrators,
      hashRecoveryPassword,
      recoverAdministratorAccess,
      authorizeOperationsAdministrator,
    }).fetch(
      request('/api/system/operations/administrator-recovery', {
        method: 'POST',
        body: {
          administrator_id: administratorId,
          new_password: 'harbor lantern canyon marble circuit',
          reset_mfa: true,
          confirmation: 'RECOVER ADMINISTRATOR',
        },
      }),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        operation: 'recover_administrator',
        status: 'completed',
        mfa_reset: true,
      },
    });
    expect(authorizeOperationsAdministrator).not.toHaveBeenCalled();
    expect(hashRecoveryPassword).toHaveBeenCalledWith(
      'harbor lantern canyon marble circuit',
    );
    expect(recoverAdministratorAccess).toHaveBeenCalledWith({
      db: environment.DB,
      administratorId,
      passwordHash: '$argon2id$recovered-password-hash',
      resetMfa: true,
    });
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(
      'owner@example.com',
    );
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(
      'harbor lantern canyon marble circuit',
    );
  });

  it('creates a new mandatory-MFA administrator only through the zero-admin recovery boundary', async () => {
    const createdAdministratorId = 'fedcba9876543210fedcba9876543210';
    const listRecoverableAdministrators = vi.fn().mockResolvedValue([]);
    const inspectRecoveryAdministratorBootstrapAvailability = vi.fn()
      .mockResolvedValue('available');
    const hashRecoveryPassword = vi.fn().mockResolvedValue(
      '$argon2id$recovery-bootstrap-password',
    );
    const bootstrapRecoveryAdministrator = vi.fn().mockResolvedValue({
      state: 'created',
      administratorId: createdAdministratorId,
    });
    const consoleSpy = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    const environment = env({ STUDIO_SITE_MODE: 'recovery' });
    const app = createApp({
      listRecoverableAdministrators,
      inspectRecoveryAdministratorBootstrapAvailability,
      hashRecoveryPassword,
      bootstrapRecoveryAdministrator,
    });

    const setupResponse = await app.fetch(request(
      '/api/system/operations/administrator-recovery/bootstrap/mfa/setup',
      {
        method: 'POST',
        body: { administrator_email: 'new-owner@example.com' },
      },
    ), environment);
    expect(setupResponse.status).toBe(200);
    const setup = await setupResponse.json() as {
      success: true;
      data: {
        secret: string;
        enrollment_token: string;
      };
    };
    const totpCode = await createTotpCode({ secret: setup.data.secret });

    const response = await app.fetch(request(
      '/api/system/operations/administrator-recovery/bootstrap',
      {
        method: 'POST',
        body: {
          administrator_name: 'Recovery Owner',
          administrator_email: 'new-owner@example.com',
          new_password: 'harbor lantern canyon marble circuit',
          backup_acknowledged: true,
          mfa: {
            enrollment_token: setup.data.enrollment_token,
            totp_code: totpCode,
          },
          confirmation: 'CREATE RECOVERY ADMINISTRATOR',
        },
      },
    ), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        operation: 'bootstrap_recovery_administrator',
        status: 'completed',
        mfa_enrolled: true,
      },
    });
    expect(listRecoverableAdministrators).toHaveBeenCalledTimes(2);
    expect(inspectRecoveryAdministratorBootstrapAvailability)
      .toHaveBeenCalledTimes(2);
    expect(hashRecoveryPassword).toHaveBeenCalledWith(
      'harbor lantern canyon marble circuit',
    );
    expect(bootstrapRecoveryAdministrator).toHaveBeenCalledWith({
      db: environment.DB,
      administratorName: 'Recovery Owner',
      administratorEmail: 'new-owner@example.com',
      passwordHash: '$argon2id$recovery-bootstrap-password',
      encryptedTotpSecret: {
        ciphertext: expect.any(String),
        iv: expect.any(String),
      },
      lastUsedStep: expect.any(Number),
    });
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    expect(consoleSpy).toHaveBeenLastCalledWith({
      message: 'Administrator access recovery completed',
      $zeropress: {
        code: 'ADMINISTRATOR_RECOVERY_COMPLETED',
        resource: 'DB',
        action: 'bootstrap_recovery_administrator',
        created_user_id: createdAdministratorId,
        administrator_count_before: 0,
        mfa_enrolled: true,
        guidance: expect.any(String),
      },
    });
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(
      'new-owner@example.com',
    );
  });

  it('rejects recovery administrator bootstrap as soon as an administrator exists', async () => {
    const inspectRecoveryAdministratorBootstrapAvailability = vi.fn();
    const response = await createApp({
      listRecoverableAdministrators: vi.fn().mockResolvedValue([{
        id: administratorId,
        email: 'owner@example.com',
        name: 'Studio Owner',
        status: 'active',
        mfa_configured: true,
      }]),
      inspectRecoveryAdministratorBootstrapAvailability,
    }).fetch(request(
      '/api/system/operations/administrator-recovery/bootstrap/mfa/setup',
      {
        method: 'POST',
        body: { administrator_email: 'new-owner@example.com' },
      },
    ), env({ STUDIO_SITE_MODE: 'recovery' }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE' },
    });
    expect(inspectRecoveryAdministratorBootstrapAvailability)
      .not.toHaveBeenCalled();
  });

  it('rejects recovery outside recovery mode before account lookup or hashing', async () => {
    const listRecoverableAdministrators = vi.fn();
    const hashRecoveryPassword = vi.fn();
    const recoverAdministratorAccess = vi.fn();
    const response = await createApp({
      listRecoverableAdministrators,
      hashRecoveryPassword,
      recoverAdministratorAccess,
    }).fetch(
      request('/api/system/operations/administrator-recovery', {
        method: 'POST',
        body: {
          administrator_id: administratorId,
          new_password: 'harbor lantern canyon marble circuit',
          reset_mfa: true,
          confirmation: 'RECOVER ADMINISTRATOR',
        },
      }),
      env({ STUDIO_SITE_MODE: 'maintenance' }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE' },
    });
    expect(listRecoverableAdministrators).not.toHaveBeenCalled();
    expect(hashRecoveryPassword).not.toHaveBeenCalled();
    expect(recoverAdministratorAccess).not.toHaveBeenCalled();
  });

  it('returns the recovery-specific unavailable code for an incompatible database state', async () => {
    const listRecoverableAdministrators = vi.fn();
    const response = await createApp({
      listRecoverableAdministrators,
    }).fetch(
      request('/api/system/operations/administrator-recovery'),
      env({
        STUDIO_SITE_MODE: 'recovery',
        DB: createFakeD1({ tables: [] }).database,
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE' },
    });
    expect(listRecoverableAdministrators).not.toHaveBeenCalled();
  });
});

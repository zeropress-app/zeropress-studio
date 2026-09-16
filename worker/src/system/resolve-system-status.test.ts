import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseStatus } from '../../../contracts/system';
import { STUDIO_VERSION } from '../../../contracts/studio-version';
import type { Env } from '../types';
import {
  createFakeD1,
  READY_SCHEMA_STATE,
} from '../test-helpers/fake-d1';
import {
  deriveSystemAccess,
  resolveSystemStatus,
} from './resolve-system-status';
import { resetSystemIncidentDeduplicationForTests } from './system-incident';
import { STUDIO_SCHEMA_VERSION } from './schema-version';

const installToken = 'installer-token-value-000000000000';

afterEach(() => {
  resetSystemIncidentDeduplicationForTests();
  vi.restoreAllMocks();
});

function env(input: {
  mode?: string;
  token?: string;
  db?: D1Database;
}): Env {
  return {
    DB: input.db ?? createFakeD1().database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    STUDIO_SITE_MODE: input.mode,
    STUDIO_INSTALL_TOKEN: input.token,
    STUDIO_AUTH_SECRET: 'test-auth-secret-value-with-at-least-32-characters',
  };
}

describe('system access resolution', () => {
  it('requires a valid install token only for an initial, uninstalled database', async () => {
    const database = createFakeD1({ tables: [] }).database;

    await expect(resolveSystemStatus(env({
      mode: 'initial',
      token: installToken,
      db: database,
    }))).resolves.toMatchObject({
      access: { state: 'installation' },
      installation_configuration: {
        site_mode: 'initial',
        auth_secret: 'valid',
        install_token: 'valid',
      },
    });

    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    await expect(resolveSystemStatus(env({
      mode: 'initial',
      token: '   ',
      db: createFakeD1({ tables: [] }).database,
    }))).resolves.toMatchObject({
      access: {
        state: 'blocked',
        reason: 'INSTALL_TOKEN_NOT_CONFIGURED',
      },
      installation_configuration: {
        site_mode: 'initial',
        auth_secret: 'valid',
        install_token: 'invalid',
      },
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Studio install token is not configured',
    }));

    await expect(resolveSystemStatus({
      ...env({
        mode: 'initial',
        token: undefined,
        db: createFakeD1({ tables: [] }).database,
      }),
      STUDIO_AUTH_SECRET: undefined,
    })).resolves.toMatchObject({
      access: {
        state: 'blocked',
        reason: 'AUTH_SECRET_NOT_CONFIGURED',
      },
      installation_configuration: {
        site_mode: 'initial',
        auth_secret: 'missing',
        install_token: 'missing',
      },
    });

    await expect(resolveSystemStatus(env({
      mode: 'initial',
      token: undefined,
    }))).resolves.toMatchObject({
      access: { state: 'activation_required' },
      installation_configuration: null,
    });
  });

  it('fails closed when any install-token binding remains after installation', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    for (const token of [installToken, '', '한'.repeat(32)]) {
      await expect(resolveSystemStatus(env({
        mode: 'operational',
        token,
      }))).resolves.toMatchObject({
        database: { state: 'ready' },
        access: {
          state: 'blocked',
          reason: 'INSTALL_TOKEN_STILL_CONFIGURED',
        },
      });
    }

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
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(installToken);

    await expect(resolveSystemStatus(env({
      mode: 'operational',
      token: undefined,
    }))).resolves.toMatchObject({
      access: { state: 'operational' },
    });

    await resolveSystemStatus(env({ mode: 'operational', token: installToken }));
    expect(consoleSpy).toHaveBeenCalledTimes(2);
  });

  it('reports an operational uninstalled database as an installation requirement', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const database = createFakeD1({ tables: [] }).database;

    await expect(resolveSystemStatus(env({
      mode: 'operational',
      db: database,
    }))).resolves.toMatchObject({
      database: { state: 'uninstalled' },
      access: {
        state: 'blocked',
        reason: 'DATABASE_UNINSTALLED',
      },
    });

    expect(consoleSpy).toHaveBeenCalledWith({
      message: 'Studio database is not installed',
      $zeropress: {
        code: 'DATABASE_UNINSTALLED',
        resource: 'DB',
        action: 'resolve_system_access',
        guidance: 'Set STUDIO_SITE_MODE to initial, configure a STUDIO_INSTALL_TOKEN containing 32–256 printable ASCII characters without spaces, and redeploy the Worker configuration. Complete installation, remove STUDIO_INSTALL_TOKEN, then set STUDIO_SITE_MODE to operational and redeploy again.',
      },
    });

    await resolveSystemStatus(env({ mode: 'operational', db: database }));
    expect(consoleSpy).toHaveBeenCalledOnce();

    await resolveSystemStatus(env({
      mode: 'initial',
      token: installToken,
      db: database,
    }));
    expect(consoleSpy).toHaveBeenCalledOnce();

    await resolveSystemStatus(env({ mode: 'operational', db: database }));
    expect(consoleSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['upgrade_required', 'DATABASE_UPGRADE_REQUIRED'],
    ['newer_than_code', 'DATABASE_NEWER_THAN_CODE'],
    ['unsupported', 'DATABASE_UNSUPPORTED'],
    ['update_in_progress', 'DATABASE_SCHEMA_STATE_INVALID'],
    ['recovery_required', 'DATABASE_SCHEMA_STATE_INVALID'],
  ] as const)('maps %s to a stable blocked reason', (state, reason) => {
    const database = {
      state,
      schema_version: state === 'recovery_required' ? null : 1,
      target_schema_version: 2,
    } as DatabaseStatus;

    expect(deriveSystemAccess({
      siteMode: { state: 'valid', mode: 'operational' },
      database,
      installTokenState: 'missing',
      authSecretConfigured: true,
    })).toEqual({
      state: 'blocked',
      reason,
    });
  });

  it('keeps recovery mode available even when authentication configuration or D1 needs operator attention', async () => {
    await expect(resolveSystemStatus({
      ...env({ mode: 'recovery' }),
      STUDIO_AUTH_SECRET: undefined,
    })).resolves.toMatchObject({
      site_mode: 'recovery',
      access: { state: 'recovery' },
    });
  });

  it('blocks normal access when the database schema is newer than the code', async () => {
    const consoleSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const sourceSchemaVersion = STUDIO_SCHEMA_VERSION + 1;

    await expect(resolveSystemStatus(env({
      mode: 'operational',
      db: createFakeD1({
        schemaState: {
          ...READY_SCHEMA_STATE,
          schema_version: sourceSchemaVersion,
        },
      }).database,
    }))).resolves.toMatchObject({
      studio_version: STUDIO_VERSION,
      database: {
        state: 'newer_than_code',
        schema_version: sourceSchemaVersion,
        target_schema_version: STUDIO_SCHEMA_VERSION,
      },
      access: { state: 'blocked', reason: 'DATABASE_NEWER_THAN_CODE' },
    });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('deduplicates a repeated database incident and records it again after recovery', async () => {
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const unavailable = env({
      mode: 'operational',
      db: createFakeD1({
        tableQueryError: new Error('D1 service unavailable'),
      }).database,
    });

    await resolveSystemStatus(unavailable);
    await resolveSystemStatus(unavailable);
    expect(consoleSpy).toHaveBeenCalledOnce();

    await resolveSystemStatus(env({ mode: 'operational' }));
    await resolveSystemStatus(unavailable);
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    expect(consoleSpy.mock.calls[1]?.[0]).toEqual({
      message: 'Studio database status query failed',
      $zeropress: {
        code: 'DATABASE_STATUS_QUERY_FAILED',
        resource: 'DB',
        action: 'inspect_database_status',
        errorType: 'Error',
        guidance: 'Verify the DB binding targets the Studio database and check Cloudflare D1 availability, then retry.',
      },
    });
  });
});

import type {
  DatabaseStatus,
  SystemAccess,
  SystemStatusData,
} from '../../../contracts/system';
import { STUDIO_VERSION } from '../../../contracts/studio-version';
import {
  resolveStudioWorkerSecretState,
  type StudioWorkerSecretState,
} from '../../../contracts/worker-secret';
import type { Env } from '../types';
import { inspectDatabaseStatus } from './database-status';
import {
  resolveSiteMode,
  type SiteModeResolution,
} from './site-mode';
import { synchronizeSystemIncident } from './system-incident';

export function synchronizeSiteModeIncident(
  resolution: SiteModeResolution,
): void {
  synchronizeSystemIncident(
    'site_mode',
    resolution.state === 'invalid'
      ? {
          code: 'SITE_MODE_CONFIGURATION_INVALID',
          fingerprint: resolution.reason,
          metadata: {
            component: 'worker_configuration',
            action: 'resolve_site_mode',
            reason: resolution.reason === 'SITE_MODE_MISSING' ? 'missing' : 'invalid',
          },
        }
      : null,
  );
}

export function deriveSystemAccess(input: {
  siteMode: SiteModeResolution;
  database: DatabaseStatus;
  installTokenState: StudioWorkerSecretState;
  authSecretConfigured: boolean;
}): SystemAccess {
  const {
    siteMode,
    database,
    installTokenState,
    authSecretConfigured,
  } = input;

  if (siteMode.state === 'invalid') {
    return {
      state: 'blocked',
      reason: siteMode.reason,
    };
  }

  if (
    database.state === 'ready'
    && installTokenState !== 'missing'
  ) {
    return {
      state: 'blocked',
      reason: 'INSTALL_TOKEN_STILL_CONFIGURED',
    };
  }

  if (siteMode.mode === 'maintenance') {
    return { state: 'maintenance' };
  }
  if (siteMode.mode === 'recovery') {
    return { state: 'recovery' };
  }

  if (database.state === 'unmanaged') {
    return { state: 'blocked', reason: 'DATABASE_UNMANAGED' };
  }
  if (database.state === 'unavailable') {
    return { state: 'blocked', reason: 'DATABASE_UNAVAILABLE' };
  }
  if (
    database.state === 'recovery_required'
    || database.state === 'update_in_progress'
  ) {
    return { state: 'blocked', reason: 'DATABASE_SCHEMA_STATE_INVALID' };
  }
  if (database.state === 'upgrade_required') {
    return { state: 'blocked', reason: 'DATABASE_UPGRADE_REQUIRED' };
  }
  if (database.state === 'newer_than_code') {
    return { state: 'blocked', reason: 'DATABASE_NEWER_THAN_CODE' };
  }
  if (database.state === 'unsupported') {
    return { state: 'blocked', reason: 'DATABASE_UNSUPPORTED' };
  }

  if (!authSecretConfigured) {
    return { state: 'blocked', reason: 'AUTH_SECRET_NOT_CONFIGURED' };
  }

  if (database.state === 'uninstalled') {
    if (siteMode.mode === 'initial') {
      return installTokenState === 'valid'
        ? { state: 'installation' }
        : { state: 'blocked', reason: 'INSTALL_TOKEN_NOT_CONFIGURED' };
    }
    return { state: 'blocked', reason: 'DATABASE_UNINSTALLED' };
  }

  return siteMode.mode === 'initial'
    ? { state: 'activation_required' }
    : { state: 'operational' };
}

function synchronizeAuthSecretIncident(input: {
  siteMode: SiteModeResolution;
  configured: boolean;
}): void {
  const required = input.siteMode.state === 'valid'
    && input.siteMode.mode !== 'maintenance'
    && input.siteMode.mode !== 'recovery';
  synchronizeSystemIncident(
    'auth_secret',
    required && !input.configured
      ? {
          code: 'AUTH_SECRET_NOT_CONFIGURED',
          metadata: {
            component: 'worker_configuration',
            action: 'resolve_auth_secret',
          },
        }
      : null,
  );
}

function synchronizeInstallTokenIncident(input: {
  siteMode: SiteModeResolution;
  database: DatabaseStatus;
  installTokenState: StudioWorkerSecretState;
}): void {
  const needsToken = input.siteMode.state === 'valid'
    && input.siteMode.mode === 'initial'
    && input.database.state === 'uninstalled'
    && input.installTokenState !== 'valid';
  const databaseInstallationEstablished = input.database.state !== 'uninstalled'
    && input.database.state !== 'unmanaged'
    && input.database.state !== 'unavailable';
  const tokenStillConfigured = databaseInstallationEstablished
    && input.installTokenState !== 'missing';

  synchronizeSystemIncident(
    'install_token',
    tokenStillConfigured
      ? {
          code: 'INSTALL_TOKEN_STILL_CONFIGURED',
          metadata: {
            component: 'worker_configuration',
            action: 'enforce_install_token_lifecycle',
          },
        }
      : needsToken
      ? {
          code: 'INSTALL_TOKEN_NOT_CONFIGURED',
          metadata: {
            component: 'worker_configuration',
            action: 'authorize_initial_installation',
          },
        }
      : null,
  );
}

function synchronizeDatabaseInstallationIncident(input: {
  siteMode: SiteModeResolution;
  database: DatabaseStatus;
}): void {
  const installationRequired = input.siteMode.state === 'valid'
    && input.siteMode.mode === 'operational'
    && input.database.state === 'uninstalled';

  synchronizeSystemIncident(
    'database_installation',
    installationRequired
      ? {
          code: 'DATABASE_UNINSTALLED',
          metadata: {
            resource: 'DB',
            action: 'resolve_system_access',
          },
        }
      : null,
  );
}

export async function resolveSystemStatus(
  env: Env,
  knownSiteMode?: SiteModeResolution,
): Promise<SystemStatusData> {
  const siteMode = knownSiteMode ?? resolveSiteMode(env.STUDIO_SITE_MODE);
  synchronizeSiteModeIncident(siteMode);

  const databaseInspection = await inspectDatabaseStatus(env.DB);
  synchronizeSystemIncident('database', databaseInspection.incident);
  synchronizeDatabaseInstallationIncident({
    siteMode,
    database: databaseInspection.status,
  });

  const installTokenState = resolveStudioWorkerSecretState(
    env.STUDIO_INSTALL_TOKEN,
  );
  synchronizeInstallTokenIncident({
    siteMode,
    database: databaseInspection.status,
    installTokenState,
  });
  const authSecretState = resolveStudioWorkerSecretState(
    env.STUDIO_AUTH_SECRET,
  );
  const authSecretConfigured = authSecretState === 'valid';
  synchronizeAuthSecretIncident({
    siteMode,
    configured: authSecretConfigured,
  });

  return {
    studio_version: STUDIO_VERSION,
    site_mode: siteMode.state === 'valid' ? siteMode.mode : null,
    database: databaseInspection.status,
    access: deriveSystemAccess({
      siteMode,
      database: databaseInspection.status,
      installTokenState,
      authSecretConfigured,
    }),
    installation_configuration:
      siteMode.state === 'valid'
      && siteMode.mode === 'initial'
      && databaseInspection.status.state === 'uninstalled'
        ? {
            site_mode: 'initial',
            auth_secret: authSecretState,
            install_token: installTokenState,
          }
        : null,
  };
}

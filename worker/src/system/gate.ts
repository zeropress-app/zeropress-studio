import type { MiddlewareHandler } from 'hono';
import type { ApiErrorCode } from '../../../contracts/api';
import { errorResponse } from '../lib/http';
import type { StudioHonoEnvironment } from '../types';
import { resolveSystemStatus, synchronizeSiteModeIncident } from './resolve-system-status';
import { resolveSiteMode } from './site-mode';
import { synchronizeSystemIncident } from './system-incident';

const SYSTEM_STATUS_PATH = '/api/system/status';
const SYSTEM_INSTALL_ACCESS_PATH = '/api/system/install/access';
const SYSTEM_INSTALL_PATH = '/api/system/install';
const SYSTEM_INSTALL_MFA_SETUP_PATH = '/api/system/install/mfa/setup';
const SYSTEM_OPERATIONS_PATH = '/api/system/operations';
const PASSWORD_BREACH_CHECK_PATH = '/api/auth/password/check';

function gateErrorCode(
  access: Exclude<
    Awaited<ReturnType<typeof resolveSystemStatus>>['access'],
    { state: 'operational' }
  >,
): ApiErrorCode {
  if (access.state === 'installation') {
    return 'INSTALLATION_REQUIRED';
  }
  if (access.state === 'activation_required') {
    return 'SITE_ACTIVATION_REQUIRED';
  }
  if (access.state === 'maintenance') {
    return 'SITE_MAINTENANCE';
  }
  if (access.state === 'recovery') {
    return 'SITE_RECOVERY';
  }
  if (
    access.reason === 'SITE_MODE_MISSING'
    || access.reason === 'SITE_MODE_INVALID'
    || access.reason === 'INSTALL_TOKEN_STILL_CONFIGURED'
  ) {
    return 'SYSTEM_CONFIGURATION_ERROR';
  }
  if (access.reason === 'DATABASE_UPGRADE_REQUIRED') {
    return 'DATABASE_UPGRADE_REQUIRED';
  }
  return 'SYSTEM_NOT_AVAILABLE';
}

export function createSystemGate(): MiddlewareHandler<StudioHonoEnvironment> {
  return async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (c.req.method === 'GET' && pathname === SYSTEM_STATUS_PATH) {
      await next();
      return;
    }
    if (
      (c.req.method === 'GET' && pathname === SYSTEM_INSTALL_ACCESS_PATH)
      || (
        c.req.method === 'POST'
        && (
          pathname === SYSTEM_INSTALL_PATH
          || pathname === SYSTEM_INSTALL_MFA_SETUP_PATH
        )
      )
    ) {
      await next();
      return;
    }
    if (
      c.req.method === 'POST'
      && pathname === PASSWORD_BREACH_CHECK_PATH
    ) {
      await next();
      return;
    }
    if (
      pathname === SYSTEM_OPERATIONS_PATH
      || pathname.startsWith(`${SYSTEM_OPERATIONS_PATH}/`)
    ) {
      await next();
      return;
    }

    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    synchronizeSiteModeIncident(siteMode);

    if (siteMode.state === 'invalid') {
      synchronizeSystemIncident('install_token', null);
      return errorResponse(c, 503, 'SYSTEM_CONFIGURATION_ERROR');
    }

    if (siteMode.mode === 'maintenance') {
      synchronizeSystemIncident('install_token', null);
      return errorResponse(c, 503, 'SITE_MAINTENANCE');
    }
    if (siteMode.mode === 'recovery') {
      synchronizeSystemIncident('install_token', null);
      return errorResponse(c, 503, 'SITE_RECOVERY');
    }

    const systemStatus = await resolveSystemStatus(c.env, siteMode);
    c.set('systemStatus', systemStatus);

    if (systemStatus.access.state !== 'operational') {
      return errorResponse(
        c,
        503,
        gateErrorCode(systemStatus.access),
      );
    }

    await next();
  };
}

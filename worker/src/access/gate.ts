import type { MiddlewareHandler } from 'hono';
import { CLOUDFLARE_ACCESS_ASSERTION_HEADER } from '../../../contracts/cloudflare-access';
import { errorResponse } from '../lib/http';
import { StudioOperationalError } from '../lib/operational-error';
import { resolveSiteMode } from '../system/site-mode';
import { synchronizeSystemIncident } from '../system/system-incident';
import type { StudioHonoEnvironment } from '../types';
import {
  verifyCloudflareAccessAssertion,
  type VerifyCloudflareAccessAssertion,
} from './assertion-verifier';
import {
  readCloudflareAccessSettings,
  type StoredCloudflareAccessDocument,
} from './settings-repository';

export type CloudflareAccessGateDependencies = {
  readSettings?: (input: {
    db: D1Database;
  }) => Promise<StoredCloudflareAccessDocument>;
  verifyAssertion?: VerifyCloudflareAccessAssertion;
};

const SYSTEM_STATUS_PATH = '/api/system/status';
const SYSTEM_INSTALL_PATH = '/api/system/install';
const SYSTEM_OPERATIONS_PATH = '/api/system/operations';

function settingsIncident(error: unknown) {
  if (error instanceof StudioOperationalError) {
    return {
      code: error.code,
      cause: error.originalCause,
      metadata: error.operationalMetadata,
    } as const;
  }
  return {
    code: 'CLOUDFLARE_ACCESS_SETTINGS_DATABASE_QUERY_FAILED' as const,
    cause: error,
    metadata: {
      resource: 'DB',
      action: 'read_cloudflare_access_settings',
    },
  };
}

export function createCloudflareAccessGate(
  dependencies: CloudflareAccessGateDependencies = {},
): MiddlewareHandler<StudioHonoEnvironment> {
  const readSettings = dependencies.readSettings ?? readCloudflareAccessSettings;
  const verifyAssertion = dependencies.verifyAssertion
    ?? verifyCloudflareAccessAssertion;

  return async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (
      pathname === SYSTEM_STATUS_PATH
      || pathname === SYSTEM_INSTALL_PATH
      || pathname.startsWith(`${SYSTEM_INSTALL_PATH}/`)
      || pathname === SYSTEM_OPERATIONS_PATH
      || pathname.startsWith(`${SYSTEM_OPERATIONS_PATH}/`)
    ) {
      await next();
      return;
    }
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (
      siteMode.state === 'invalid'
      || siteMode.mode === 'initial'
      || siteMode.mode === 'recovery'
    ) {
      synchronizeSystemIncident('cloudflare_access', null);
      await next();
      return;
    }

    let document: StoredCloudflareAccessDocument;
    try {
      document = await readSettings({ db: c.env.DB });
    } catch (error) {
      synchronizeSystemIncident(
        'cloudflare_access',
        settingsIncident(error),
      );
      return errorResponse(
        c,
        503,
        'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE',
      );
    }

    if (document.settings.mode === 'disabled') {
      synchronizeSystemIncident('cloudflare_access', null);
      await next();
      return;
    }

    const verification = await verifyAssertion({
      assertion: c.req.header(CLOUDFLARE_ACCESS_ASSERTION_HEADER),
      origin: new URL(c.req.url).origin,
      expected: document.settings,
    });
    if (verification.state === 'unavailable') {
      synchronizeSystemIncident('cloudflare_access', {
        code: 'CLOUDFLARE_ACCESS_VERIFICATION_FAILED',
        cause: verification.cause,
        metadata: {
          component: 'cloudflare_access',
          action: 'verify_cloudflare_access_assertion',
        },
      });
      return errorResponse(
        c,
        503,
        'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE',
      );
    }
    synchronizeSystemIncident('cloudflare_access', null);
    if (verification.state !== 'verified') {
      return errorResponse(c, 403, 'CLOUDFLARE_ACCESS_REQUIRED');
    }

    c.set('cloudflareAccessIdentity', verification.identity);
    await next();
  };
}

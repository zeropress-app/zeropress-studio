import type { Context } from 'hono';
import { hasStudioCapability } from '../../../contracts/authorization';
import { readSessionCookie } from '../auth/session-http';
import {
  resolveUserSession,
  type ResolveUserSession,
} from '../auth/session-repository';
import { normalizeIpAddress, resolveTrustedClientIp } from '../lib/client-ip';
import {
  logOperationalFailure,
  logStudioOperationalError,
  StudioOperationalError,
} from '../lib/operational-error';
import type { Env, StudioHonoEnvironment } from '../types';
import type { OperationsSetupConfiguration } from '../../../contracts/system';
import {
  isValidStudioWorkerSecret,
  resolveStudioWorkerSecretState,
  STUDIO_WORKER_SECRET_MIN_LENGTH,
  type StudioWorkerSecretState,
} from '../../../contracts/worker-secret';
import {
  synchronizeSystemIncident,
  type SystemIncident,
} from '../system/system-incident';

export type OperationsConfiguration =
  | { state: 'disabled'; tokenState: StudioWorkerSecretState }
  | {
      state: 'invalid';
      allowedIps: string[] | null;
      tokenState: StudioWorkerSecretState;
      reason:
        | 'allowed_ips_empty'
        | 'allowed_ip_invalid'
        | 'token_missing'
        | 'token_too_short'
        | 'token_invalid';
    }
  | {
      state: 'ready';
      allowedIps: string[];
      token: string;
    };

function parseAllowedIps(value: string | undefined):
  | { ok: true; ips: string[] }
  | { ok: false; reason: 'allowed_ips_empty' | 'allowed_ip_invalid' } {
  if (value === undefined || value.trim().length === 0) {
    return { ok: false, reason: 'allowed_ips_empty' };
  }

  const normalized = new Set<string>();
  for (const entry of value.split(',')) {
    const ip = normalizeIpAddress(entry);
    if (!ip) {
      return { ok: false, reason: 'allowed_ip_invalid' };
    }
    normalized.add(ip);
  }

  return { ok: true, ips: [...normalized] };
}

export function resolveOperationsConfiguration(
  env: Env,
): OperationsConfiguration {
  const token = env.STUDIO_OPERATIONS_TOKEN;
  const tokenState = resolveStudioWorkerSecretState(token);
  if (env.STUDIO_OPERATIONS_ALLOWED_IPS === undefined) {
    return { state: 'disabled', tokenState };
  }

  const allowedIps = parseAllowedIps(env.STUDIO_OPERATIONS_ALLOWED_IPS);
  if (!allowedIps.ok) {
    return {
      state: 'invalid', reason: allowedIps.reason, allowedIps: null, tokenState,
    };
  }

  const invalid = { state: 'invalid', allowedIps: allowedIps.ips, tokenState } as const;
  if (token === undefined || token.length === 0) {
    return { ...invalid, reason: 'token_missing' };
  }
  if (token.length < STUDIO_WORKER_SECRET_MIN_LENGTH) {
    return { ...invalid, reason: 'token_too_short' };
  }
  if (!isValidStudioWorkerSecret(token)) {
    return { ...invalid, reason: 'token_invalid' };
  }

  return {
    state: 'ready',
    allowedIps: allowedIps.ips,
    token,
  };
}

export function isOperationsIpAllowed(
  configuration: { allowedIps: readonly string[] | null },
  clientIp: string | null,
): clientIp is string {
  return clientIp !== null && configuration.allowedIps?.includes(clientIp) === true;
}

export type OperationsRequestBoundary =
  | { state: 'not_found' }
  | { state: 'setup_required'; setup: OperationsSetupConfiguration }
  | {
      state: 'available';
      configuration: Extract<OperationsConfiguration, { state: 'ready' }>;
      clientIp: string;
    };

function resolveOperationsConfigurationBoundary(
  request: Request,
  configuration: OperationsConfiguration,
): OperationsRequestBoundary {
  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== new URL(request.url).origin) {
    return { state: 'not_found' };
  }
  const clientIp = resolveTrustedClientIp(request);
  if (configuration.state === 'disabled') {
    return {
      state: 'setup_required',
      setup: {
        allowed_ips: 'missing', token: configuration.tokenState, client_ip: clientIp,
      },
    };
  }
  if (configuration.state === 'invalid' && configuration.allowedIps === null) {
    return {
      state: 'setup_required',
      setup: {
        allowed_ips: 'invalid', token: configuration.tokenState, client_ip: clientIp,
      },
    };
  }

  // A valid allowlist always takes precedence over token setup diagnostics.
  // Never disclose token configuration to a requester outside that boundary.
  if (!isOperationsIpAllowed({ allowedIps: configuration.allowedIps }, clientIp)) {
    return { state: 'not_found' };
  }
  if (configuration.state === 'invalid') {
    return {
      state: 'setup_required',
      setup: {
        allowed_ips: 'valid',
        token: configuration.tokenState === 'missing' ? 'missing' : 'invalid',
      },
    };
  }
  return { state: 'available', configuration, clientIp };
}

/** Entry discovery never verifies or consumes an Operations token. */
export async function resolveOperationsRequestBoundary(input: {
  context: Context<StudioHonoEnvironment>;
  configuration: OperationsConfiguration;
  resolveSession?: ResolveUserSession;
}): Promise<OperationsRequestBoundary> {
  const { context, configuration } = input;
  const boundary = resolveOperationsConfigurationBoundary(context.req.raw, configuration);
  if (boundary.state !== 'setup_required' || context.env.STUDIO_SITE_MODE !== 'operational') {
    return boundary;
  }

  try {
    const session = await (input.resolveSession ?? resolveUserSession)({
      db: context.env.DB,
      cookieValue: readSessionCookie(context),
    });
    if (session && hasStudioCapability(session.user.roles, 'settings.manage')) {
      return boundary;
    }
  } catch (error) {
    // A broken session store must not expose setup or interrupt public status.
    const metadata = { method: context.req.method, pathname: context.req.path };
    if (error instanceof StudioOperationalError) {
      logStudioOperationalError(error, metadata);
    } else {
      logOperationalFailure('UNHANDLED_STUDIO_API_ERROR', { cause: error, metadata });
    }
  }
  return { state: 'not_found' };
}

function configurationIncident(
  configuration: OperationsConfiguration,
): SystemIncident | null {
  if (configuration.state !== 'invalid') {
    return null;
  }

  return {
    code: 'OPERATIONS_CONFIGURATION_INVALID',
    fingerprint: configuration.reason,
    metadata: {
      component: 'worker_configuration',
      action: 'resolve_operations_access',
      reason: configuration.reason,
    },
  };
}

export function synchronizeOperationsConfigurationIncident(
  configuration: OperationsConfiguration,
): void {
  synchronizeSystemIncident(
    'operations_configuration',
    configurationIncident(configuration),
  );
}

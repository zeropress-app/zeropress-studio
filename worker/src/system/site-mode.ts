import type { StudioSiteMode } from '../../../contracts/system';
import { isValidStudioWorkerSecret } from '../../../contracts/worker-secret';

export type SiteModeResolution =
  | { state: 'valid'; mode: StudioSiteMode }
  | { state: 'invalid'; reason: 'SITE_MODE_MISSING' | 'SITE_MODE_INVALID' };

export function resolveSiteMode(value: string | undefined): SiteModeResolution {
  if (value === undefined) {
    return { state: 'invalid', reason: 'SITE_MODE_MISSING' };
  }

  if (
    value === 'initial'
    || value === 'operational'
    || value === 'maintenance'
    || value === 'recovery'
  ) {
    return { state: 'valid', mode: value };
  }

  return { state: 'invalid', reason: 'SITE_MODE_INVALID' };
}

export function hasConfiguredInstallToken(
  value: string | undefined,
): value is string {
  return isValidStudioWorkerSecret(value);
}

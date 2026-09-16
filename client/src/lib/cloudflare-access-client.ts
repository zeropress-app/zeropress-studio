import {
  cloudflareAccessSettingsResponseSchema,
  type CloudflareAccessSettingsResponse,
} from '../../../contracts/cloudflare-access';
import { studioFetch } from './studio-fetch';

const CLOUDFLARE_ACCESS_TIMEOUT_MS = 15_000;

export type CloudflareAccessClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class CloudflareAccessClientError extends Error {
  constructor(public readonly code: CloudflareAccessClientErrorCode) {
    super(code);
    this.name = 'CloudflareAccessClientError';
  }
}

async function requestJson(input: {
  signal?: AbortSignal;
}): Promise<CloudflareAccessSettingsResponse> {
  const timeout = new AbortController();
  const timeoutId = window.setTimeout(
    () => timeout.abort(),
    CLOUDFLARE_ACCESS_TIMEOUT_MS,
  );
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeout.signal])
    : timeout.signal;
  try {
    const response = await studioFetch('/api/settings/access', {
      headers: {
        Accept: 'application/json',
      },
      signal,
    });
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new CloudflareAccessClientError('INVALID_RESPONSE');
    }
    const parsed = cloudflareAccessSettingsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new CloudflareAccessClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof CloudflareAccessClientError) throw error;
    if (timeout.signal.aborted) {
      throw new CloudflareAccessClientError('TIMEOUT');
    }
    throw new CloudflareAccessClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function requestCloudflareAccessSettings(
  signal?: AbortSignal,
): Promise<CloudflareAccessSettingsResponse> {
  return requestJson({ signal });
}

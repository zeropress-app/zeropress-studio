import {
  siteBrandingResponseSchema,
  type SiteBrandingResponse,
  type UpdateSiteBrandingRequest,
} from '../../../contracts/branding-settings';

const SITE_BRANDING_TIMEOUT_MS = 15_000;

export type SiteBrandingClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class SiteBrandingClientError extends Error {
  constructor(public readonly code: SiteBrandingClientErrorCode) {
    super(code);
    this.name = 'SiteBrandingClientError';
  }
}

async function requestJson<T>(input: {
  path: string;
  method?: 'GET' | 'PUT';
  body?: UpdateSiteBrandingRequest;
  csrfToken?: string;
  signal?: AbortSignal;
  parse: (value: unknown) => { success: boolean; data?: T };
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    SITE_BRANDING_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await studioFetch(input.path, {
      method: input.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
        ...(input.csrfToken ? { 'X-ZeroPress-CSRF': input.csrfToken } : {}),
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new SiteBrandingClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(value);
    if (!parsed.success || parsed.data === undefined) {
      throw new SiteBrandingClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof SiteBrandingClientError) throw error;
    if (controller.signal.aborted) {
      throw new SiteBrandingClientError('TIMEOUT');
    }
    throw new SiteBrandingClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestSiteBranding(
  signal?: AbortSignal,
): Promise<SiteBrandingResponse> {
  return requestJson({
    path: '/api/settings/branding',
    signal,
    parse: (value) => siteBrandingResponseSchema.safeParse(value),
  });
}

export function requestUpdateSiteBranding(
  csrfToken: string,
  body: UpdateSiteBrandingRequest,
): Promise<SiteBrandingResponse> {
  return requestJson({
    path: '/api/settings/branding',
    method: 'PUT',
    body,
    csrfToken,
    parse: (value) => siteBrandingResponseSchema.safeParse(value),
  });
}
import { studioFetch } from './studio-fetch';

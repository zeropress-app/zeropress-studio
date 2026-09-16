import {
  edgeSecuritySettingsResponseSchema,
  type EdgeSecuritySettingsResponse,
  type UpdateEdgeSecuritySettingsRequest,
} from '../../../contracts/edge-security-settings';

const EDGE_SECURITY_SETTINGS_TIMEOUT_MS = 15_000;

export type EdgeSecuritySettingsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class EdgeSecuritySettingsClientError extends Error {
  constructor(public readonly code: EdgeSecuritySettingsClientErrorCode) {
    super(code);
    this.name = 'EdgeSecuritySettingsClientError';
  }
}

async function requestEdgeSecuritySettingsApi(input: {
  method: 'GET' | 'PUT';
  body?: UpdateEdgeSecuritySettingsRequest;
  csrfToken?: string;
  signal?: AbortSignal;
}): Promise<EdgeSecuritySettingsResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    EDGE_SECURITY_SETTINGS_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await studioFetch('/api/settings/edge-security', {
      method: input.method,
      headers: {
        Accept: 'application/json',
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
        ...(input.csrfToken
          ? { 'X-ZeroPress-CSRF': input.csrfToken }
          : {}),
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      throw new EdgeSecuritySettingsClientError('INVALID_RESPONSE');
    }
    const parsed = edgeSecuritySettingsResponseSchema.safeParse(rawResponse);
    if (!parsed.success) {
      throw new EdgeSecuritySettingsClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof EdgeSecuritySettingsClientError) throw error;
    if (controller.signal.aborted) {
      throw new EdgeSecuritySettingsClientError('TIMEOUT');
    }
    throw new EdgeSecuritySettingsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestEdgeSecuritySettings(
  signal?: AbortSignal,
): Promise<EdgeSecuritySettingsResponse> {
  return requestEdgeSecuritySettingsApi({ method: 'GET', signal });
}

export function requestUpdateEdgeSecuritySettings(
  csrfToken: string,
  request: UpdateEdgeSecuritySettingsRequest,
): Promise<EdgeSecuritySettingsResponse> {
  return requestEdgeSecuritySettingsApi({
    method: 'PUT',
    body: request,
    csrfToken,
  });
}
import { studioFetch } from './studio-fetch';

import {
  edgeUrlSettingsResponseSchema,
  type EdgeUrlSettingsResponse,
  type UpdateEdgeUrlSettingsRequest,
} from '../../../contracts/edge-url';

const EDGE_URL_SETTINGS_TIMEOUT_MS = 15_000;

export type EdgeUrlSettingsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class EdgeUrlSettingsClientError extends Error {
  constructor(public readonly code: EdgeUrlSettingsClientErrorCode) {
    super(code);
    this.name = 'EdgeUrlSettingsClientError';
  }
}

async function requestApi(input: {
  method: 'GET' | 'PUT';
  body?: UpdateEdgeUrlSettingsRequest;
  csrfToken?: string;
  signal?: AbortSignal;
}): Promise<EdgeUrlSettingsResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    EDGE_URL_SETTINGS_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await studioFetch('/api/settings/edge-url', {
      method: input.method,
      headers: {
        Accept: 'application/json',
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
        ...(input.csrfToken ? { 'X-ZeroPress-CSRF': input.csrfToken } : {}),
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new EdgeUrlSettingsClientError('INVALID_RESPONSE');
    }
    const parsed = edgeUrlSettingsResponseSchema.safeParse(raw);
    if (!parsed.success) throw new EdgeUrlSettingsClientError('INVALID_RESPONSE');
    return parsed.data;
  } catch (error) {
    if (error instanceof EdgeUrlSettingsClientError) throw error;
    if (controller.signal.aborted) {
      throw new EdgeUrlSettingsClientError('TIMEOUT');
    }
    throw new EdgeUrlSettingsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestEdgeUrlSettings(
  signal?: AbortSignal,
): Promise<EdgeUrlSettingsResponse> {
  return requestApi({ method: 'GET', signal });
}

export function requestUpdateEdgeUrlSettings(
  csrfToken: string,
  request: UpdateEdgeUrlSettingsRequest,
): Promise<EdgeUrlSettingsResponse> {
  return requestApi({ method: 'PUT', body: request, csrfToken });
}
import { studioFetch } from './studio-fetch';

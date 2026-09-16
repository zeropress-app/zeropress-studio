import {
  mediaSettingsResponseSchema,
  type MediaSettingsResponse,
  type UpdateMediaSettingsRequest,
} from '../../../contracts/media-settings';

const MEDIA_SETTINGS_TIMEOUT_MS = 15_000;

export type MediaSettingsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class MediaSettingsClientError extends Error {
  constructor(public readonly code: MediaSettingsClientErrorCode) {
    super(code);
    this.name = 'MediaSettingsClientError';
  }
}

async function requestApi(input: {
  method: 'GET' | 'PUT';
  body?: UpdateMediaSettingsRequest;
  csrfToken?: string;
  signal?: AbortSignal;
}): Promise<MediaSettingsResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    MEDIA_SETTINGS_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await studioFetch('/api/settings/media', {
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
      throw new MediaSettingsClientError('INVALID_RESPONSE');
    }
    const parsed = mediaSettingsResponseSchema.safeParse(raw);
    if (!parsed.success) throw new MediaSettingsClientError('INVALID_RESPONSE');
    return parsed.data;
  } catch (error) {
    if (error instanceof MediaSettingsClientError) throw error;
    if (controller.signal.aborted) {
      throw new MediaSettingsClientError('TIMEOUT');
    }
    throw new MediaSettingsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestMediaSettings(
  signal?: AbortSignal,
): Promise<MediaSettingsResponse> {
  return requestApi({ method: 'GET', signal });
}

export function requestUpdateMediaSettings(
  csrfToken: string,
  request: UpdateMediaSettingsRequest,
): Promise<MediaSettingsResponse> {
  return requestApi({ method: 'PUT', body: request, csrfToken });
}
import { studioFetch } from './studio-fetch';

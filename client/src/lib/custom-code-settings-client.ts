import {
  customCodeSettingsResponseSchema,
  type CustomCodeSettingsResponse,
  type UpdateCustomCodeSettingsRequest,
} from '../../../contracts/custom-code-settings';

const CUSTOM_CODE_SETTINGS_TIMEOUT_MS = 15_000;

export type CustomCodeSettingsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class CustomCodeSettingsClientError extends Error {
  constructor(public readonly code: CustomCodeSettingsClientErrorCode) {
    super(code);
    this.name = 'CustomCodeSettingsClientError';
  }
}

async function requestCustomCodeSettingsApi(input: {
  method: 'GET' | 'PUT';
  body?: UpdateCustomCodeSettingsRequest;
  csrfToken?: string;
  signal?: AbortSignal;
}): Promise<CustomCodeSettingsResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    CUSTOM_CODE_SETTINGS_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await studioFetch('/api/settings/custom-code', {
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
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new CustomCodeSettingsClientError('INVALID_RESPONSE');
    }
    const parsed = customCodeSettingsResponseSchema.safeParse(value);
    if (!parsed.success) {
      throw new CustomCodeSettingsClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof CustomCodeSettingsClientError) throw error;
    if (controller.signal.aborted) {
      throw new CustomCodeSettingsClientError('TIMEOUT');
    }
    throw new CustomCodeSettingsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestCustomCodeSettings(
  signal?: AbortSignal,
): Promise<CustomCodeSettingsResponse> {
  return requestCustomCodeSettingsApi({ method: 'GET', signal });
}

export function requestUpdateCustomCodeSettings(
  csrfToken: string,
  body: UpdateCustomCodeSettingsRequest,
): Promise<CustomCodeSettingsResponse> {
  return requestCustomCodeSettingsApi({
    method: 'PUT',
    body,
    csrfToken,
  });
}
import { studioFetch } from './studio-fetch';

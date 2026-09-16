import {
  generalSettingsResponseSchema,
  type GeneralSettingsResponse,
  type RepairGeneralSettingsRequest,
  type UpdateGeneralSettingsRequest,
} from '../../../contracts/general-settings';

const GENERAL_SETTINGS_TIMEOUT_MS = 15_000;

export type GeneralSettingsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class GeneralSettingsClientError extends Error {
  constructor(public readonly code: GeneralSettingsClientErrorCode) {
    super(code);
    this.name = 'GeneralSettingsClientError';
  }
}

async function requestGeneralSettingsApi(input: {
  method: 'GET' | 'PUT' | 'POST';
  path?: string;
  body?: UpdateGeneralSettingsRequest | RepairGeneralSettingsRequest;
  csrfToken?: string;
  signal?: AbortSignal;
}): Promise<GeneralSettingsResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    GENERAL_SETTINGS_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) {
    controller.abort();
  } else {
    input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  try {
    const response = await studioFetch(
      `/api/settings/general${input.path ?? ''}`,
      {
      method: input.method,
      headers: {
        Accept: 'application/json',
        ...(input.body
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(input.csrfToken
          ? { 'X-ZeroPress-CSRF': input.csrfToken }
          : {}),
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      credentials: 'same-origin',
      signal: controller.signal,
      },
    );
    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      throw new GeneralSettingsClientError('INVALID_RESPONSE');
    }
    const parsed = generalSettingsResponseSchema.safeParse(rawResponse);
    if (!parsed.success) {
      throw new GeneralSettingsClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof GeneralSettingsClientError) throw error;
    if (controller.signal.aborted) {
      throw new GeneralSettingsClientError('TIMEOUT');
    }
    throw new GeneralSettingsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestGeneralSettings(
  signal?: AbortSignal,
): Promise<GeneralSettingsResponse> {
  return requestGeneralSettingsApi({ method: 'GET', signal });
}

export function requestUpdateGeneralSettings(
  csrfToken: string,
  request: UpdateGeneralSettingsRequest,
  signal?: AbortSignal,
): Promise<GeneralSettingsResponse> {
  return requestGeneralSettingsApi({
    method: 'PUT',
    body: request,
    csrfToken,
    signal,
  });
}

export function requestRepairGeneralSettings(
  csrfToken: string,
  request: RepairGeneralSettingsRequest,
): Promise<GeneralSettingsResponse> {
  return requestGeneralSettingsApi({
    method: 'POST',
    path: '/repair',
    body: request,
    csrfToken,
  });
}
import { studioFetch } from './studio-fetch';

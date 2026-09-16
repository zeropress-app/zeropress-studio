import {
  outputSettingsResponseSchema,
  type OutputSettingsResponse,
  type UpdateOutputSettingsRequest,
} from '../../../contracts/output-settings';

const OUTPUT_SETTINGS_TIMEOUT_MS = 15_000;

export type OutputSettingsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class OutputSettingsClientError extends Error {
  constructor(public readonly code: OutputSettingsClientErrorCode) {
    super(code);
    this.name = 'OutputSettingsClientError';
  }
}

async function requestOutputSettingsApi(input: {
  method: 'GET' | 'PUT';
  body?: UpdateOutputSettingsRequest;
  csrfToken?: string;
  signal?: AbortSignal;
}): Promise<OutputSettingsResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    OUTPUT_SETTINGS_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) {
    controller.abort();
  } else {
    input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  try {
    const response = await studioFetch('/api/settings/output', {
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
    });
    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      throw new OutputSettingsClientError('INVALID_RESPONSE');
    }
    const parsed = outputSettingsResponseSchema.safeParse(rawResponse);
    if (!parsed.success) {
      throw new OutputSettingsClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof OutputSettingsClientError) throw error;
    if (controller.signal.aborted) {
      throw new OutputSettingsClientError('TIMEOUT');
    }
    throw new OutputSettingsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestOutputSettings(
  signal?: AbortSignal,
): Promise<OutputSettingsResponse> {
  return requestOutputSettingsApi({ method: 'GET', signal });
}

export function requestUpdateOutputSettings(
  csrfToken: string,
  request: UpdateOutputSettingsRequest,
): Promise<OutputSettingsResponse> {
  return requestOutputSettingsApi({
    method: 'PUT',
    body: request,
    csrfToken,
  });
}
import { studioFetch } from './studio-fetch';

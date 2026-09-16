import {
  systemStatusResponseSchema,
  type SystemStatusResponse,
} from '../../../contracts/system';
import { studioFetch } from './studio-fetch';

const SYSTEM_STATUS_TIMEOUT_MS = 10_000;

export type SystemClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class SystemClientError extends Error {
  constructor(public readonly code: SystemClientErrorCode) {
    super(code);
    this.name = 'SystemClientError';
  }
}

export async function requestSystemStatus(
  externalSignal?: AbortSignal,
): Promise<SystemStatusResponse> {
  const timeoutController = new AbortController();
  const timeoutId = window.setTimeout(
    () => timeoutController.abort(),
    SYSTEM_STATUS_TIMEOUT_MS,
  );
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await studioFetch('/api/system/status', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      credentials: 'same-origin',
      signal,
    });

    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      throw new SystemClientError('INVALID_RESPONSE');
    }

    const parsed = systemStatusResponseSchema.safeParse(rawResponse);
    if (!parsed.success) {
      throw new SystemClientError('INVALID_RESPONSE');
    }

    return parsed.data;
  } catch (error) {
    if (error instanceof SystemClientError) {
      throw error;
    }
    if (timeoutController.signal.aborted) {
      throw new SystemClientError('TIMEOUT');
    }
    throw new SystemClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

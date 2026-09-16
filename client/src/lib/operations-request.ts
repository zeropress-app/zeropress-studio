import { isValidStudioWorkerSecret } from '../../../contracts/worker-secret';

/**
 * Shared transport for Maintenance & Recovery requests.
 *
 * Each request function imports its contract schema and passes it as `parse`.
 * Public system status determines availability; do not probe protected APIs
 * without a token to infer whether they are available.
 */

export const OPERATIONS_TIMEOUT_MS = 30_000;

export type OperationsClientErrorCode =
  | 'INVALID_TOKEN_FORMAT'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class OperationsClientError extends Error {
  constructor(public readonly code: OperationsClientErrorCode) {
    super(code);
    this.name = 'OperationsClientError';
  }
}

export function assertValidOperationsToken(token: string | undefined): void {
  if (token !== undefined && !isValidStudioWorkerSecret(token)) {
    throw new OperationsClientError('INVALID_TOKEN_FORMAT');
  }
}

export async function requestOperationsApi<T>(input: {
  path: string;
  token?: string;
  method: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  timeoutMs?: number;
  externalSignal?: AbortSignal;
  parse: (value: unknown) => { success: true; data: T } | { success: false };
}): Promise<T> {
  assertValidOperationsToken(input.token);
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? OPERATIONS_TIMEOUT_MS,
  );
  const signal = input.externalSignal
    ? AbortSignal.any([input.externalSignal, controller.signal])
    : controller.signal;

  try {
    const response = await studioFetch(input.path, {
      method: input.method,
      headers: {
        Accept: 'application/json',
        ...(input.token === undefined
          ? {}
          : { Authorization: `Bearer ${input.token}` }),
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      credentials: 'same-origin',
      signal,
    });

    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      throw new OperationsClientError('INVALID_RESPONSE');
    }

    const parsed = input.parse(rawResponse);
    if (!parsed.success) {
      throw new OperationsClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof OperationsClientError) throw error;
    if (controller.signal.aborted) {
      throw new OperationsClientError('TIMEOUT');
    }
    throw new OperationsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
  }
}
import { studioFetch } from './studio-fetch';

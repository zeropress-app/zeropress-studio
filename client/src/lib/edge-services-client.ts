import {
  drainEdgeProjectionsResponseSchema,
  edgeServicesResponseSchema,
  type EdgeServicesDocument,
  type EdgeIntegrationSettings,
} from '../../../contracts/edge-services';
import type { ApiErrorResponse } from '../../../contracts/api';

const EDGE_SERVICES_TIMEOUT_MS = 15_000;

export type EdgeServicesClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class EdgeServicesClientError extends Error {
  constructor(public readonly code: EdgeServicesClientErrorCode) {
    super(code);
    this.name = 'EdgeServicesClientError';
  }
}

async function requestJson(input: {
  path: string;
  method: 'GET' | 'PUT' | 'POST';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    EDGE_SERVICES_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await studioFetch(input.path, {
      method: input.method,
      headers: {
        Accept: 'application/json',
        ...(input.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...(input.csrfToken
          ? { 'X-ZeroPress-CSRF': input.csrfToken }
          : {}),
      },
      body: input.body === undefined
        ? undefined
        : JSON.stringify(input.body),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    try {
      return await response.json();
    } catch {
      throw new EdgeServicesClientError('INVALID_RESPONSE');
    }
  } catch (error) {
    if (error instanceof EdgeServicesClientError) throw error;
    if (controller.signal.aborted) {
      throw new EdgeServicesClientError('TIMEOUT');
    }
    throw new EdgeServicesClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function requestEdgeServices(
  signal?: AbortSignal,
): Promise<{ success: true; data: EdgeServicesDocument } | ApiErrorResponse> {
  const parsed = edgeServicesResponseSchema.safeParse(await requestJson({
    path: '/api/settings/edge-services', method: 'GET', signal,
  }));
  if (!parsed.success) throw new EdgeServicesClientError('INVALID_RESPONSE');
  return parsed.data;
}

export async function requestUpdateEdgeServices(input: {
  csrfToken: string;
  settings: EdgeIntegrationSettings;
  expectedRevision: string;
}): Promise<{ success: true; data: EdgeServicesDocument } | ApiErrorResponse> {
  const parsed = edgeServicesResponseSchema.safeParse(await requestJson({
    path: '/api/settings/edge-services',
    method: 'PUT',
    csrfToken: input.csrfToken,
    body: {
      settings: input.settings,
      expected_revision: input.expectedRevision,
    },
  }));
  if (!parsed.success) throw new EdgeServicesClientError('INVALID_RESPONSE');
  return parsed.data;
}

export async function requestDrainEdgeProjections(input: {
  csrfToken: string;
}): Promise<
  | { success: true; data: { processed_events: number; remaining_events: number } }
  | ApiErrorResponse
> {
  const parsed = drainEdgeProjectionsResponseSchema.safeParse(await requestJson({
    path: '/api/settings/edge-services/projections/drain',
    method: 'POST',
    csrfToken: input.csrfToken,
    body: {},
  }));
  if (!parsed.success) throw new EdgeServicesClientError('INVALID_RESPONSE');
  return parsed.data;
}
import { studioFetch } from './studio-fetch';

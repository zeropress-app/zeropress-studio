import {
  routingPageOptionsResponseSchema,
  routingSettingsResponseSchema,
  type RepairRoutingSettingsRequest,
  type RoutingPageOptionsResponse,
  type RoutingSettingsResponse,
  type UpdateRoutingSettingsRequest,
} from '../../../contracts/routing-settings';

const ROUTING_SETTINGS_TIMEOUT_MS = 15_000;

export type RoutingSettingsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class RoutingSettingsClientError extends Error {
  constructor(public readonly code: RoutingSettingsClientErrorCode) {
    super(code);
    this.name = 'RoutingSettingsClientError';
  }
}

async function requestJson<T>(input: {
  url: string;
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } };
  method?: 'GET' | 'PUT' | 'POST';
  body?: UpdateRoutingSettingsRequest | RepairRoutingSettingsRequest;
  csrfToken?: string;
  signal?: AbortSignal;
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    ROUTING_SETTINGS_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const response = await studioFetch(input.url, {
      method: input.method ?? 'GET',
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
      throw new RoutingSettingsClientError('INVALID_RESPONSE');
    }
    const parsed = input.schema.safeParse(rawResponse);
    if (!parsed.success) {
      throw new RoutingSettingsClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof RoutingSettingsClientError) throw error;
    if (controller.signal.aborted) {
      throw new RoutingSettingsClientError('TIMEOUT');
    }
    throw new RoutingSettingsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestRoutingSettings(
  signal?: AbortSignal,
): Promise<RoutingSettingsResponse> {
  return requestJson({
    url: '/api/settings/routing',
    schema: routingSettingsResponseSchema,
    signal,
  });
}

export function requestRoutingPageOptions(input: {
  search?: string;
  selectedPageId?: string;
  signal?: AbortSignal;
} = {}): Promise<RoutingPageOptionsResponse> {
  const query = new URLSearchParams();
  if (input.search) query.set('search', input.search);
  if (input.selectedPageId) {
    query.set('selected_page_id', input.selectedPageId);
  }
  return requestJson({
    url: `/api/settings/routing/page-options${query.size > 0 ? `?${query}` : ''}`,
    schema: routingPageOptionsResponseSchema,
    signal: input.signal,
  });
}

export function requestUpdateRoutingSettings(
  csrfToken: string,
  request: UpdateRoutingSettingsRequest,
): Promise<RoutingSettingsResponse> {
  return requestJson({
    url: '/api/settings/routing',
    method: 'PUT',
    body: request,
    csrfToken,
    schema: routingSettingsResponseSchema,
  });
}

export function requestRepairRoutingSettings(
  csrfToken: string,
  request: RepairRoutingSettingsRequest,
): Promise<RoutingSettingsResponse> {
  return requestJson({
    url: '/api/settings/routing/repair',
    method: 'POST',
    body: request,
    csrfToken,
    schema: routingSettingsResponseSchema,
  });
}
import { studioFetch } from './studio-fetch';

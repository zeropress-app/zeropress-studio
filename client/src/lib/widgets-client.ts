import {
  widgetAreaDeleteResponseSchema,
  widgetAreaListResponseSchema,
  widgetAreaMutationResponseSchema,
  widgetAuthorOptionsResponseSchema,
  type CreateWidgetAreaRequest,
  type DeleteWidgetAreaRequest,
  type SaveWidgetAreaRequest,
  type WidgetAreaDeleteResponse,
  type WidgetAreaListResponse,
  type WidgetAreaMutationResponse,
  type WidgetAuthorOptionsResponse,
} from '../../../contracts/widgets';

const WIDGETS_TIMEOUT_MS = 20_000;

export type WidgetsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class WidgetsClientError extends Error {
  constructor(public readonly code: WidgetsClientErrorCode) {
    super(code);
    this.name = 'WidgetsClientError';
  }
}

async function requestWidgetsApi<T>(input: {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  parse: (value: unknown) => { success: true; data: T } | { success: false };
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    WIDGETS_TIMEOUT_MS,
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
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new WidgetsClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(value);
    if (!parsed.success) throw new WidgetsClientError('INVALID_RESPONSE');
    return parsed.data;
  } catch (error) {
    if (error instanceof WidgetsClientError) throw error;
    if (controller.signal.aborted) throw new WidgetsClientError('TIMEOUT');
    throw new WidgetsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestWidgetAreas(
  signal?: AbortSignal,
): Promise<WidgetAreaListResponse> {
  return requestWidgetsApi<WidgetAreaListResponse>({
    path: '/api/widgets',
    method: 'GET',
    signal,
    parse(value) {
      const parsed = widgetAreaListResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestWidgetAuthorOptions(
  search = '',
  signal?: AbortSignal,
): Promise<WidgetAuthorOptionsResponse> {
  const params = new URLSearchParams({ search });
  return requestWidgetsApi<WidgetAuthorOptionsResponse>({
    path: `/api/widgets/author-options?${params.toString()}`,
    method: 'GET',
    signal,
    parse(value) {
      const parsed = widgetAuthorOptionsResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestCreateWidgetArea(
  csrfToken: string,
  request: CreateWidgetAreaRequest,
): Promise<WidgetAreaMutationResponse> {
  return requestWidgetsApi<WidgetAreaMutationResponse>({
    path: '/api/widgets',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = widgetAreaMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestSaveWidgetArea(
  csrfToken: string,
  widgetAreaId: string,
  request: SaveWidgetAreaRequest,
): Promise<WidgetAreaMutationResponse> {
  return requestWidgetsApi<WidgetAreaMutationResponse>({
    path: `/api/widgets/${encodeURIComponent(widgetAreaId)}`,
    method: 'PUT',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = widgetAreaMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestDeleteWidgetArea(
  csrfToken: string,
  widgetAreaId: string,
  request: DeleteWidgetAreaRequest,
): Promise<WidgetAreaDeleteResponse> {
  return requestWidgetsApi<WidgetAreaDeleteResponse>({
    path: `/api/widgets/${encodeURIComponent(widgetAreaId)}`,
    method: 'DELETE',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = widgetAreaDeleteResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}
import { studioFetch } from './studio-fetch';

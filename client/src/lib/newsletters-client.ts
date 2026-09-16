import {
  exportNewsletterSubscriptionsQuerySchema,
  newsletterDeliveriesResponseSchema,
  newsletterDetailResponseSchema,
  newsletterFieldsResponseSchema,
  newsletterListResponseSchema,
  newsletterRuntimeResponseSchema,
  newsletterSubscriptionDeleteResponseSchema,
  newsletterSubscriptionDetailResponseSchema,
  newsletterSubscriptionMutationResponseSchema,
  newsletterSubscriptionsResponseSchema,
  newsletterSuppressionDeleteResponseSchema,
  newsletterSuppressionMutationResponseSchema,
  newsletterSuppressionsResponseSchema,
  type CreateNewsletterSuppressionRequest,
  type ExportNewsletterSubscriptionsQuery,
  type NewsletterDetailResponse,
  type NewsletterDeliveriesQuery,
  type NewsletterDeliveriesResponse,
  type NewsletterFieldsResponse,
  type NewsletterListQuery,
  type NewsletterListResponse,
  type NewsletterRuntimeResponse,
  type NewsletterSubscriptionDeleteResponse,
  type NewsletterSubscriptionDetailResponse,
  type NewsletterSubscriptionMutationResponse,
  type NewsletterSubscriptionsQuery,
  type NewsletterSubscriptionsResponse,
  type NewsletterSuppressionDeleteResponse,
  type NewsletterSuppressionMutationResponse,
  type NewsletterSuppressionsQuery,
  type NewsletterSuppressionsResponse,
  type ReplaceNewsletterFieldsRequest,
  type UpdateNewsletterRequest,
  type UpdateNewsletterRuntimeRequest,
} from '../../../contracts/newsletters';
import {
  apiErrorSchema,
  type ApiErrorResponse,
} from '../../../contracts/api';

const NEWSLETTERS_TIMEOUT_MS = 30_000;

export type NewslettersClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class NewslettersClientError extends Error {
  constructor(public readonly code: NewslettersClientErrorCode) {
    super(code);
    this.name = 'NewslettersClientError';
  }
}

async function requestApi<T>(input: {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  parse: (value: unknown) => { success: boolean; data?: T };
}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    NEWSLETTERS_TIMEOUT_MS,
  );
  const abort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await studioFetch(input.path, {
      method: input.method ?? 'GET',
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
      throw new NewslettersClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(value);
    if (!parsed.success) throw new NewslettersClientError('INVALID_RESPONSE');
    return parsed.data as T;
  } catch (error) {
    if (error instanceof NewslettersClientError) throw error;
    if (controller.signal.aborted) throw new NewslettersClientError('TIMEOUT');
    throw new NewslettersClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  }
}

function queryString(values: Record<string, unknown>): string {
  return new URLSearchParams(
    Object.entries(values).flatMap(([key, value]) => (
      typeof value === 'string' || typeof value === 'number'
        ? [[key, String(value)]]
        : []
    )),
  ).toString();
}

function schemaParser<T>(schema: {
  safeParse(value: unknown): { success: boolean; data?: T };
}) {
  return (value: unknown) => schema.safeParse(value);
}

function safeDownloadFilename(value: string | null): string {
  const match = value?.match(/filename="([A-Za-z0-9._-]+)"/u);
  return match?.[1] ?? `newsletter-subscribers-${new Date()
    .toISOString().slice(0, 10)}.csv`;
}

export type NewsletterExportDownload = {
  blob: Blob;
  filename: string;
  row_count: number;
  truncated: boolean;
  truncation_reason: 'row_limit' | 'byte_limit' | null;
};

export async function requestNewsletterSubscriptionsExport(
  id: string,
  query: ExportNewsletterSubscriptionsQuery,
  signal?: AbortSignal,
): Promise<NewsletterExportDownload | ApiErrorResponse> {
  const parsedQuery = exportNewsletterSubscriptionsQuerySchema.parse(query);
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    NEWSLETTERS_TIMEOUT_MS,
  );
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await studioFetch(
      `/api/newsletters/${encodeURIComponent(id)}/subscriptions/export.csv?${queryString(parsedQuery)}`,
      {
        headers: { Accept: 'text/csv, application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new NewslettersClientError('INVALID_RESPONSE');
      }
      const error = apiErrorSchema.safeParse(value);
      if (!error.success) throw new NewslettersClientError('INVALID_RESPONSE');
      return error.data;
    }
    if (!response.headers.get('Content-Type')?.startsWith('text/csv')) {
      throw new NewslettersClientError('INVALID_RESPONSE');
    }
    const rowCount = Number(response.headers.get('X-Export-Row-Count'));
    const truncatedValue = response.headers.get('X-Export-Truncated');
    const reasonValue = response.headers.get('X-Export-Truncation-Reason');
    if (
      !Number.isSafeInteger(rowCount)
      || rowCount < 0
      || (truncatedValue !== 'true' && truncatedValue !== 'false')
      || !['none', 'row_limit', 'byte_limit'].includes(reasonValue ?? '')
    ) throw new NewslettersClientError('INVALID_RESPONSE');
    return {
      blob: await response.blob(),
      filename: safeDownloadFilename(
        response.headers.get('Content-Disposition'),
      ),
      row_count: rowCount,
      truncated: truncatedValue === 'true',
      truncation_reason: reasonValue === 'none'
        ? null
        : reasonValue as 'row_limit' | 'byte_limit',
    };
  } catch (error) {
    if (error instanceof NewslettersClientError) throw error;
    if (controller.signal.aborted) throw new NewslettersClientError('TIMEOUT');
    throw new NewslettersClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export function requestNewsletters(
  query: NewsletterListQuery,
  signal?: AbortSignal,
): Promise<NewsletterListResponse> {
  return requestApi({
    path: `/api/newsletters?${queryString(query)}`,
    signal,
    parse: schemaParser(newsletterListResponseSchema),
  });
}

export function requestNewsletter(
  id: string,
  signal?: AbortSignal,
): Promise<NewsletterDetailResponse> {
  return requestApi({
    path: `/api/newsletters/${encodeURIComponent(id)}`,
    signal,
    parse: schemaParser(newsletterDetailResponseSchema),
  });
}

export function requestUpdateNewsletter(
  csrfToken: string,
  id: string,
  request: UpdateNewsletterRequest,
): Promise<NewsletterDetailResponse> {
  return requestApi({
    path: `/api/newsletters/${encodeURIComponent(id)}`,
    method: 'PATCH',
    csrfToken,
    body: request,
    parse: schemaParser(newsletterDetailResponseSchema),
  });
}

export function requestNewsletterRuntime(
  signal?: AbortSignal,
): Promise<NewsletterRuntimeResponse> {
  return requestApi({
    path: '/api/newsletters/runtime',
    signal,
    parse: schemaParser(newsletterRuntimeResponseSchema),
  });
}

export function requestUpdateNewsletterRuntime(
  csrfToken: string,
  request: UpdateNewsletterRuntimeRequest,
): Promise<NewsletterRuntimeResponse> {
  return requestApi({
    path: '/api/newsletters/runtime',
    method: 'PUT',
    csrfToken,
    body: request,
    parse: schemaParser(newsletterRuntimeResponseSchema),
  });
}

export function requestNewsletterFields(
  id: string,
  signal?: AbortSignal,
): Promise<NewsletterFieldsResponse> {
  return requestApi({
    path: `/api/newsletters/${encodeURIComponent(id)}/fields`,
    signal,
    parse: schemaParser(newsletterFieldsResponseSchema),
  });
}

export function requestReplaceNewsletterFields(
  csrfToken: string,
  id: string,
  request: ReplaceNewsletterFieldsRequest,
): Promise<NewsletterFieldsResponse> {
  return requestApi({
    path: `/api/newsletters/${encodeURIComponent(id)}/fields`,
    method: 'PUT',
    csrfToken,
    body: request,
    parse: schemaParser(newsletterFieldsResponseSchema),
  });
}

export function requestNewsletterSubscriptions(
  id: string,
  query: NewsletterSubscriptionsQuery,
  signal?: AbortSignal,
): Promise<NewsletterSubscriptionsResponse> {
  return requestApi({
    path: `/api/newsletters/${encodeURIComponent(id)}/subscriptions?${queryString(query)}`,
    signal,
    parse: schemaParser(newsletterSubscriptionsResponseSchema),
  });
}

export function requestNewsletterDeliveries(
  id: string,
  query: NewsletterDeliveriesQuery,
  signal?: AbortSignal,
): Promise<NewsletterDeliveriesResponse> {
  return requestApi({
    path: `/api/newsletters/${encodeURIComponent(id)}/deliveries?${queryString(query)}`,
    signal,
    parse: schemaParser(newsletterDeliveriesResponseSchema),
  });
}

export function requestNewsletterSubscription(
  id: string,
  subscriptionId: string,
  signal?: AbortSignal,
): Promise<NewsletterSubscriptionDetailResponse> {
  return requestApi({
    path: `/api/newsletters/${encodeURIComponent(id)}/subscriptions/${encodeURIComponent(subscriptionId)}`,
    signal,
    parse: schemaParser(newsletterSubscriptionDetailResponseSchema),
  });
}

export function requestUnsubscribeNewsletterSubscription(
  csrfToken: string,
  id: string,
  subscriptionId: string,
): Promise<NewsletterSubscriptionMutationResponse> {
  return requestApi({
    path: `/api/newsletters/${encodeURIComponent(id)}/subscriptions/${encodeURIComponent(subscriptionId)}/unsubscribe`,
    method: 'POST',
    csrfToken,
    parse: schemaParser(newsletterSubscriptionMutationResponseSchema),
  });
}

export function requestDeleteNewsletterSubscription(
  csrfToken: string,
  id: string,
  subscriptionId: string,
): Promise<NewsletterSubscriptionDeleteResponse> {
  return requestApi({
    path: `/api/newsletters/${encodeURIComponent(id)}/subscriptions/${encodeURIComponent(subscriptionId)}`,
    method: 'DELETE',
    csrfToken,
    parse: schemaParser(newsletterSubscriptionDeleteResponseSchema),
  });
}

export function requestNewsletterSuppressions(
  query: NewsletterSuppressionsQuery,
  signal?: AbortSignal,
): Promise<NewsletterSuppressionsResponse> {
  return requestApi({
    path: `/api/newsletters/suppressions?${queryString(query)}`,
    signal,
    parse: schemaParser(newsletterSuppressionsResponseSchema),
  });
}

export function requestCreateNewsletterSuppression(
  csrfToken: string,
  request: CreateNewsletterSuppressionRequest,
): Promise<NewsletterSuppressionMutationResponse> {
  return requestApi({
    path: '/api/newsletters/suppressions',
    method: 'POST',
    csrfToken,
    body: request,
    parse: schemaParser(newsletterSuppressionMutationResponseSchema),
  });
}

export function requestDeleteNewsletterSuppression(
  csrfToken: string,
  id: string,
): Promise<NewsletterSuppressionDeleteResponse> {
  return requestApi({
    path: `/api/newsletters/suppressions/${encodeURIComponent(id)}`,
    method: 'DELETE',
    csrfToken,
    parse: schemaParser(newsletterSuppressionDeleteResponseSchema),
  });
}
import { studioFetch } from './studio-fetch';

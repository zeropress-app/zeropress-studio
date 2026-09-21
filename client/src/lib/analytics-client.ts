import {
  analyticsSettingsResponseSchema,
  analyticsSummaryResponseSchema,
  analyticsConnectionResponseSchema,
  type AnalyticsPeriod,
  type UpdateAnalyticsSettings,
  type TestAnalyticsConnection,
} from '../../../contracts/analytics';
import { studioFetch } from './studio-fetch';

const REQUEST_TIMEOUT_MS = 35_000;

export type AnalyticsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class AnalyticsClientError extends Error {
  constructor(public readonly code: AnalyticsClientErrorCode) {
    super(code);
    this.name = 'AnalyticsClientError';
  }
}

async function request<T>(input: {
  path: string;
  method: 'GET' | 'PUT' | 'POST';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  parse: (value: unknown) => T | null;
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );
  const abort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await studioFetch(input.path, {
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
    const value = input.parse(await response.json().catch(() => null));
    if (!value) throw new AnalyticsClientError('INVALID_RESPONSE');
    return value;
  } catch (error) {
    if (error instanceof AnalyticsClientError) throw error;
    if (controller.signal.aborted) {
      throw new AnalyticsClientError('TIMEOUT');
    }
    throw new AnalyticsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abort);
  }
}

export function requestAnalyticsSettings(signal?: AbortSignal) {
  return request({
    path: '/api/settings/analytics',
    method: 'GET',
    signal,
    parse: (value) => {
      const result = analyticsSettingsResponseSchema.safeParse(value);
      return result.success ? result.data : null;
    },
  });
}
export function requestUpdateAnalyticsSettings(
  csrfToken: string,
  body: UpdateAnalyticsSettings,
) {
  return request({
    path: '/api/settings/analytics',
    method: 'PUT',
    body,
    csrfToken,
    parse: (value) => {
      const result = analyticsSettingsResponseSchema.safeParse(value);
      return result.success ? result.data : null;
    },
  });
}
export function requestTestAnalyticsConnection(
  csrfToken: string,
  body: TestAnalyticsConnection,
  signal?: AbortSignal,
) {
  return request({
    path: '/api/settings/analytics/test-connection',
    method: 'POST',
    body,
    csrfToken,
    signal,
    parse: (value) => {
      const result = analyticsConnectionResponseSchema.safeParse(value);
      return result.success ? result.data : null;
    },
  });
}
export function requestAnalyticsSummary(
  period: AnalyticsPeriod,
  signal?: AbortSignal,
) {
  return request({
    path: `/api/analytics/summary?period=${period}`,
    method: 'GET',
    signal,
    parse: (value) => {
      const result = analyticsSummaryResponseSchema.safeParse(value);
      return result.success ? result.data : null;
    },
  });
}
export function analyticsErrorKey(code: string) {
  switch (code) {
    case 'ANALYTICS_NOT_CONFIGURED':
      return 'notConfigured';
    case 'ANALYTICS_SITE_NOT_CONFIGURED':
      return 'siteMissing';
    case 'ANALYTICS_CREDENTIAL_NOT_CONFIGURED':
      return 'tokenMissing';
    case 'ANALYTICS_AUTHENTICATION_FAILED':
      return 'authentication';
    case 'ANALYTICS_QUERY_LIMITED':
      return 'limited';
    case 'ANALYTICS_UNAVAILABLE':
      return 'unavailable';
    case 'ANALYTICS_RESPONSE_INVALID':
    case 'INVALID_RESPONSE':
      return 'invalid';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'TIMEOUT':
      return 'timeout';
    case 'NETWORK_ERROR':
      return 'network';
    default:
      return 'unexpected';
  }
}

import {
  publishingSettingsResponseSchema,
  publishingStatusResponseSchema,
  publishingResultResponseSchema,
  publishingConnectionResponseSchema,
  type UpdatePublishingSettings,
  type TestPublishingConnection,
} from '../../../contracts/publishing';
import { studioFetch } from './studio-fetch';

const REQUEST_TIMEOUT_MS = 90_000;

export type PublishingClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class PublishingClientError extends Error {
  constructor(public readonly code: PublishingClientErrorCode) {
    super(code);
    this.name = 'PublishingClientError';
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
    if (!value) throw new PublishingClientError('INVALID_RESPONSE');
    return value;
  } catch (error) {
    if (error instanceof PublishingClientError) throw error;
    if (controller.signal.aborted) {
      throw new PublishingClientError('TIMEOUT');
    }
    throw new PublishingClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abort);
  }
}

export function requestPublishingSettings(signal?: AbortSignal) {
  return request({
    path: '/api/settings/publishing',
    method: 'GET',
    signal,
    parse: (value) => {
      const result = publishingSettingsResponseSchema.safeParse(value);
      return result.success ? result.data : null;
    },
  });
}
export function requestUpdatePublishingSettings(
  csrfToken: string,
  body: UpdatePublishingSettings,
) {
  return request({
    path: '/api/settings/publishing',
    method: 'PUT',
    body,
    csrfToken,
    parse: (value) => {
      const result = publishingSettingsResponseSchema.safeParse(value);
      return result.success ? result.data : null;
    },
  });
}
export function requestTestPublishingConnection(
  csrfToken: string,
  body: TestPublishingConnection,
  signal?: AbortSignal,
) {
  return request({
    path: '/api/settings/publishing/test-connection',
    method: 'POST',
    body,
    csrfToken,
    signal,
    parse: (value) => {
      const result = publishingConnectionResponseSchema.safeParse(value);
      return result.success ? result.data : null;
    },
  });
}
export function requestPublishingStatus(signal?: AbortSignal) {
  return request({
    path: '/api/publishing/status',
    method: 'GET',
    signal,
    parse: (value) => {
      const result = publishingStatusResponseSchema.safeParse(value);
      return result.success ? result.data : null;
    },
  });
}
export function requestPublish(csrfToken: string, revision: string) {
  return request({
    path: '/api/publishing',
    method: 'POST',
    body: { expected_revision: revision },
    csrfToken,
    parse: (value) => {
      const result = publishingResultResponseSchema.safeParse(value);
      return result.success ? result.data : null;
    },
  });
}
export function publishingErrorKey(code: string) {
  switch (code) {
    case 'PUBLISHING_NOT_CONFIGURED':
      return 'notConfigured';
    case 'PUBLISHING_CREDENTIAL_NOT_CONFIGURED':
      return 'tokenMissing';
    case 'PUBLISHING_URL_INVALID':
      return 'urlInvalid';
    case 'PUBLISHING_URL_AMBIGUOUS':
      return 'urlAmbiguous';
    case 'PUBLISHING_AUTHENTICATION_FAILED':
      return 'authentication';
    case 'PUBLISHING_PERMISSION_DENIED':
      return 'permission';
    case 'PUBLISHING_TARGET_NOT_FOUND':
      return 'notFound';
    case 'PUBLISHING_TARGET_INVALID':
      return 'targetInvalid';
    case 'PUBLISHING_BRANCH_RESTRICTED':
      return 'branchRestricted';
    case 'PUBLISHING_CONFLICT':
      return 'conflict';
    case 'SETTINGS_REVISION_CONFLICT':
      return 'settingsConflict';
    case 'PUBLISHING_RATE_LIMITED':
      return 'limited';
    case 'PUBLISHING_UNAVAILABLE':
      return 'unavailable';
    case 'PUBLISHING_RESPONSE_INVALID':
    case 'INVALID_RESPONSE':
      return 'invalid';
    case 'PUBLISHING_RESULT_UNKNOWN':
      return 'unknown';
    case 'FORBIDDEN':
      return 'forbidden';
    case 'TIMEOUT':
      return 'timeout';
    case 'NETWORK_ERROR':
      return 'network';
    case 'EDGE_INTEGRATION_DISABLED':
    case 'EDGE_INTEGRATION_UNAVAILABLE':
    case 'EDGE_RECONCILIATION_REQUIRED':
    case 'EDGE_TARGET_PROJECTION_PENDING':
      return 'edge';
    default:
      return 'unexpected';
  }
}

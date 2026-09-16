import {
  commentRequestSecurityResponseSchema,
  commentSettingsResponseSchema,
  type CommentRequestSecurityMutationRequest,
  type CommentRequestSecurityResponse,
  type CommentSettingsResponse,
  type UpdateCommentSettingsRequest,
} from '../../../contracts/comment-settings';

const COMMENT_SETTINGS_TIMEOUT_MS = 15_000;

export type CommentSettingsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class CommentSettingsClientError extends Error {
  constructor(public readonly code: CommentSettingsClientErrorCode) {
    super(code);
    this.name = 'CommentSettingsClientError';
  }
}

async function requestCommentSettingsApi(input: {
  path?: string;
  method: 'GET' | 'PUT' | 'POST';
  body?: UpdateCommentSettingsRequest | CommentRequestSecurityMutationRequest;
  csrfToken?: string;
  signal?: AbortSignal;
}): Promise<
  CommentSettingsResponse
  | CommentRequestSecurityResponse
> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    COMMENT_SETTINGS_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await studioFetch(
      `/api/settings/comments${input.path ?? ''}`,
      {
        method: input.method,
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
      },
    );
    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      throw new CommentSettingsClientError('INVALID_RESPONSE');
    }
    const schema = input.path?.startsWith('/request-security')
      ? commentRequestSecurityResponseSchema
      : commentSettingsResponseSchema;
    const parsed = schema.safeParse(rawResponse);
    if (!parsed.success) {
      throw new CommentSettingsClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof CommentSettingsClientError) throw error;
    if (controller.signal.aborted) {
      throw new CommentSettingsClientError('TIMEOUT');
    }
    throw new CommentSettingsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function requestCommentSettings(
  signal?: AbortSignal,
): Promise<CommentSettingsResponse> {
  return await requestCommentSettingsApi({
    method: 'GET',
    signal,
  }) as CommentSettingsResponse;
}

export async function requestUpdateCommentSettings(
  csrfToken: string,
  request: UpdateCommentSettingsRequest,
): Promise<CommentSettingsResponse> {
  return await requestCommentSettingsApi({
    method: 'PUT',
    body: request,
    csrfToken,
  }) as CommentSettingsResponse;
}

export async function requestCommentRequestSecurity(
  signal?: AbortSignal,
): Promise<CommentRequestSecurityResponse> {
  return await requestCommentSettingsApi({
    path: '/request-security',
    method: 'GET',
    signal,
  }) as CommentRequestSecurityResponse;
}

export async function requestRotateCommentRequestSecurity(
  csrfToken: string,
  request: CommentRequestSecurityMutationRequest,
): Promise<CommentRequestSecurityResponse> {
  return await requestCommentSettingsApi({
    path: '/request-security/rotate',
    method: 'POST',
    body: request,
    csrfToken,
  }) as CommentRequestSecurityResponse;
}

export async function requestResetCommentRequestSecurity(
  csrfToken: string,
  request: CommentRequestSecurityMutationRequest,
): Promise<CommentRequestSecurityResponse> {
  return await requestCommentSettingsApi({
    path: '/request-security/reset',
    method: 'POST',
    body: request,
    csrfToken,
  }) as CommentRequestSecurityResponse;
}
import { studioFetch } from './studio-fetch';

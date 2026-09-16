import {
  commentBulkModerationRequestSchema,
  commentBulkModerationResponseSchema,
  commentDeleteResponseSchema,
  commentListResponseSchema,
  commentMutationResponseSchema,
  commentTargetOptionsResponseSchema,
  createStudioCommentRequestSchema,
  updateCommentRequestSchema,
  type CommentBulkModerationRequest,
  type CommentBulkModerationResponse,
  type CommentDeleteResponse,
  type CommentListQuery,
  type CommentListResponse,
  type CommentMutationResponse,
  type CommentTargetOptionsQuery,
  type CommentTargetOptionsResponse,
  type CreateStudioCommentRequest,
  type DeleteCommentRequest,
  type UpdateCommentRequest,
} from '../../../contracts/comments';

const COMMENTS_TIMEOUT_MS = 30_000;

export type CommentsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class CommentsClientError extends Error {
  constructor(public readonly code: CommentsClientErrorCode) {
    super(code);
    this.name = 'CommentsClientError';
  }
}

async function requestCommentsApi<T>(input: {
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
    COMMENTS_TIMEOUT_MS,
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
      throw new CommentsClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(value);
    if (!parsed.success) throw new CommentsClientError('INVALID_RESPONSE');
    return parsed.data;
  } catch (error) {
    if (error instanceof CommentsClientError) throw error;
    if (controller.signal.aborted) throw new CommentsClientError('TIMEOUT');
    throw new CommentsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

function parsed<T>(result: { success: boolean; data?: T }) {
  return result.success
    ? { success: true as const, data: result.data as T }
    : { success: false as const };
}

export function requestComments(
  query: CommentListQuery,
  signal?: AbortSignal,
): Promise<CommentListResponse> {
  const parameters = new URLSearchParams({
    search: query.search,
    status: query.status,
    target_type: query.target_type,
    page: String(query.page),
    per_page: String(query.per_page),
  });
  if (query.target_public_id !== undefined) {
    parameters.set('target_public_id', String(query.target_public_id));
  }
  return requestCommentsApi<CommentListResponse>({
    path: `/api/comments?${parameters.toString()}`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(commentListResponseSchema.safeParse(value));
    },
  });
}

export function requestCommentTargets(
  query: CommentTargetOptionsQuery,
  signal?: AbortSignal,
): Promise<CommentTargetOptionsResponse> {
  const parameters = new URLSearchParams({
    target_type: query.target_type,
    search: query.search,
  });
  return requestCommentsApi<CommentTargetOptionsResponse>({
    path: `/api/comments/targets?${parameters.toString()}`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(commentTargetOptionsResponseSchema.safeParse(value));
    },
  });
}

export function requestCreateStudioComment(
  csrfToken: string,
  request: CreateStudioCommentRequest,
): Promise<CommentMutationResponse> {
  return requestCommentsApi<CommentMutationResponse>({
    path: '/api/comments',
    method: 'POST',
    body: createStudioCommentRequestSchema.parse(request),
    csrfToken,
    parse(value) {
      return parsed(commentMutationResponseSchema.safeParse(value));
    },
  });
}

export function requestUpdateComment(
  csrfToken: string,
  commentId: string,
  request: UpdateCommentRequest,
): Promise<CommentMutationResponse> {
  return requestCommentsApi<CommentMutationResponse>({
    path: `/api/comments/${encodeURIComponent(commentId)}`,
    method: 'PUT',
    body: updateCommentRequestSchema.parse(request),
    csrfToken,
    parse(value) {
      return parsed(commentMutationResponseSchema.safeParse(value));
    },
  });
}

export function requestDeleteComment(
  csrfToken: string,
  commentId: string,
  request: DeleteCommentRequest,
): Promise<CommentDeleteResponse> {
  return requestCommentsApi<CommentDeleteResponse>({
    path: `/api/comments/${encodeURIComponent(commentId)}`,
    method: 'DELETE',
    body: request,
    csrfToken,
    parse(value) {
      return parsed(commentDeleteResponseSchema.safeParse(value));
    },
  });
}

export function requestBulkCommentModeration(
  csrfToken: string,
  request: CommentBulkModerationRequest,
): Promise<CommentBulkModerationResponse> {
  return requestCommentsApi<CommentBulkModerationResponse>({
    path: '/api/comments/bulk-moderation',
    method: 'POST',
    body: commentBulkModerationRequestSchema.parse(request),
    csrfToken,
    parse(value) {
      return parsed(commentBulkModerationResponseSchema.safeParse(value));
    },
  });
}
import { studioFetch } from './studio-fetch';

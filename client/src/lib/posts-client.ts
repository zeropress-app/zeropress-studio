import {
  postAutosaveDeleteResponseSchema,
  postAutosaveMutationResponseSchema,
  postAutosavePromotionResponseSchema,
  postAutosaveReadResponseSchema,
  type PostAutosaveDeleteResponse,
  type PostAutosaveMutationResponse,
  type PostAutosavePromotionRequest,
  type PostAutosavePromotionResponse,
  type PostAutosaveReadResponse,
  type PutPostAutosaveRequest,
} from '../../../contracts/post-autosaves';
import type { ContentAutosaveDeleteRequest } from '../../../contracts/content-snapshots';
import type { RestoreContentRevisionRequest } from '../../../contracts/content-revisions';
import {
  aiExcerptResponseSchema,
  type AiExcerptRequest,
  type AiExcerptResponse,
} from '../../../contracts/ai-excerpt';
import {
  aiPostDraftResponseSchema,
  type AiPostDraftRequest,
  type AiPostDraftResponse,
} from '../../../contracts/ai-post-draft';
import {
  aiPostEditResponseSchema,
  type AiPostEditRequest,
  type AiPostEditResponse,
} from '../../../contracts/ai-post-edit';
import {
  postRevisionDetailResponseSchema,
  postRevisionListResponseSchema,
  postRevisionRestoreResponseSchema,
  type PostRevisionDetailResponse,
  type PostRevisionListResponse,
  type PostRevisionRestoreResponse,
} from '../../../contracts/post-revisions';
import {
  postDeleteResponseSchema,
  postBulkLifecycleResponseSchema,
  postDetailResponseSchema,
  postEditorOptionsResponseSchema,
  postListResponseSchema,
  postMutationResponseSchema,
  postNewsletterNotificationResponseSchema,
  type CreatePostRequest,
  type DeletePostRequest,
  type PostDeleteResponse,
  type PostBulkLifecycleRequest,
  type PostBulkLifecycleResponse,
  type PostDetailResponse,
  type PostEditorOptionKind,
  type PostEditorOptionsResponse,
  type PostListQuery,
  type PostListResponse,
  type PostMutationResponse,
  type PostNewsletterNotificationRequest,
  type PostNewsletterNotificationResponse,
  type UpdatePostRequest,
} from '../../../contracts/posts';

const POSTS_TIMEOUT_MS = 30_000;
const POSTS_AI_TIMEOUT_MS = 60_000;
const POSTS_AI_DRAFT_TIMEOUT_MS = 75_000;
const POSTS_AI_EDIT_TIMEOUT_MS = 75_000;

export type PostsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class PostsClientError extends Error {
  constructor(public readonly code: PostsClientErrorCode) {
    super(code);
    this.name = 'PostsClientError';
  }
}

async function requestPostsApi<T>(input: {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  parse: (value: unknown) => { success: true; data: T } | { success: false };
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? POSTS_TIMEOUT_MS,
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
      throw new PostsClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(value);
    if (!parsed.success) throw new PostsClientError('INVALID_RESPONSE');
    return parsed.data;
  } catch (error) {
    if (error instanceof PostsClientError) throw error;
    if (controller.signal.aborted) throw new PostsClientError('TIMEOUT');
    throw new PostsClientError('NETWORK_ERROR');
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

export function requestPosts(
  query: PostListQuery,
  signal?: AbortSignal,
): Promise<PostListResponse> {
  const params = new URLSearchParams({
    search: query.search,
    status: query.status,
    page: String(query.page),
    per_page: String(query.per_page),
  });
  if (query.author_id) params.set('author_id', query.author_id);
  return requestPostsApi<PostListResponse>({
    path: `/api/posts?${params.toString()}`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(postListResponseSchema.safeParse(value));
    },
  });
}

export function requestPost(
  postId: string,
  signal?: AbortSignal,
): Promise<PostDetailResponse> {
  return requestPostsApi<PostDetailResponse>({
    path: `/api/posts/${encodeURIComponent(postId)}`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(postDetailResponseSchema.safeParse(value));
    },
  });
}

export function requestGeneratePostExcerpt(
  csrfToken: string,
  request: AiExcerptRequest,
  signal?: AbortSignal,
): Promise<AiExcerptResponse> {
  return requestPostsApi<AiExcerptResponse>({
    path: '/api/posts/ai/excerpt',
    method: 'POST',
    csrfToken,
    body: request,
    signal,
    timeoutMs: POSTS_AI_TIMEOUT_MS,
    parse(value) {
      return parsed(aiExcerptResponseSchema.safeParse(value));
    },
  });
}

export function requestGeneratePostDraft(
  csrfToken: string,
  request: AiPostDraftRequest,
  signal?: AbortSignal,
): Promise<AiPostDraftResponse> {
  return requestPostsApi<AiPostDraftResponse>({
    path: '/api/posts/ai/draft',
    method: 'POST',
    csrfToken,
    body: request,
    signal,
    timeoutMs: POSTS_AI_DRAFT_TIMEOUT_MS,
    parse(value) {
      return parsed(aiPostDraftResponseSchema.safeParse(value));
    },
  });
}

export function requestGeneratePostEdit(
  csrfToken: string,
  postId: string,
  request: AiPostEditRequest,
  signal?: AbortSignal,
): Promise<AiPostEditResponse> {
  return requestPostsApi<AiPostEditResponse>({
    path: `/api/posts/${encodeURIComponent(postId)}/ai/edit`,
    method: 'POST',
    csrfToken,
    body: request,
    signal,
    timeoutMs: POSTS_AI_EDIT_TIMEOUT_MS,
    parse(value) {
      return parsed(aiPostEditResponseSchema.safeParse(value));
    },
  });
}

export function requestPostEditorOptions(
  kind: PostEditorOptionKind,
  search = '',
  signal?: AbortSignal,
): Promise<PostEditorOptionsResponse> {
  const params = new URLSearchParams({ kind, search });
  return requestPostsApi<PostEditorOptionsResponse>({
    path: `/api/posts/options?${params.toString()}`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(postEditorOptionsResponseSchema.safeParse(value));
    },
  });
}

export function requestPostAutosave(
  locator: { draft_id: string } | { target_id: string },
  signal?: AbortSignal,
): Promise<PostAutosaveReadResponse> {
  const params = new URLSearchParams(locator);
  return requestPostsApi<PostAutosaveReadResponse>({
    path: `/api/posts/autosave?${params.toString()}`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(postAutosaveReadResponseSchema.safeParse(value));
    },
  });
}

export function requestRecentPostAutosave(
  signal?: AbortSignal,
): Promise<PostAutosaveReadResponse> {
  return requestPostsApi<PostAutosaveReadResponse>({
    path: '/api/posts/autosave/recent',
    method: 'GET',
    signal,
    parse(value) {
      return parsed(postAutosaveReadResponseSchema.safeParse(value));
    },
  });
}

export function requestPutPostAutosave(
  csrfToken: string,
  request: PutPostAutosaveRequest,
): Promise<PostAutosaveMutationResponse> {
  return requestPostsApi<PostAutosaveMutationResponse>({
    path: '/api/posts/autosave',
    method: 'PUT',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(postAutosaveMutationResponseSchema.safeParse(value));
    },
  });
}

export function requestDeletePostAutosave(
  csrfToken: string,
  request: ContentAutosaveDeleteRequest,
): Promise<PostAutosaveDeleteResponse> {
  return requestPostsApi<PostAutosaveDeleteResponse>({
    path: '/api/posts/autosave',
    method: 'DELETE',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(postAutosaveDeleteResponseSchema.safeParse(value));
    },
  });
}

export function requestPromotePostAutosave(
  csrfToken: string,
  request: PostAutosavePromotionRequest,
): Promise<PostAutosavePromotionResponse> {
  return requestPostsApi<PostAutosavePromotionResponse>({
    path: '/api/posts/autosave/promote',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(postAutosavePromotionResponseSchema.safeParse(value));
    },
  });
}

export function requestPostRevisions(
  postId: string,
  signal?: AbortSignal,
): Promise<PostRevisionListResponse> {
  return requestPostsApi<PostRevisionListResponse>({
    path: `/api/posts/${encodeURIComponent(postId)}/revisions`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(postRevisionListResponseSchema.safeParse(value));
    },
  });
}

export function requestPostRevision(
  postId: string,
  revisionId: string,
  signal?: AbortSignal,
): Promise<PostRevisionDetailResponse> {
  return requestPostsApi<PostRevisionDetailResponse>({
    path: `/api/posts/${encodeURIComponent(postId)}/revisions/${encodeURIComponent(revisionId)}`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(postRevisionDetailResponseSchema.safeParse(value));
    },
  });
}

export function requestRestorePostRevision(
  csrfToken: string,
  postId: string,
  revisionId: string,
  request: RestoreContentRevisionRequest,
): Promise<PostRevisionRestoreResponse> {
  return requestPostsApi<PostRevisionRestoreResponse>({
    path: `/api/posts/${encodeURIComponent(postId)}/revisions/${encodeURIComponent(revisionId)}/restore`,
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(postRevisionRestoreResponseSchema.safeParse(value));
    },
  });
}

export function requestCreatePost(
  csrfToken: string,
  request: CreatePostRequest,
): Promise<PostMutationResponse> {
  return requestPostsApi<PostMutationResponse>({
    path: '/api/posts',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(postMutationResponseSchema.safeParse(value));
    },
  });
}

export function requestUpdatePost(
  csrfToken: string,
  postId: string,
  request: UpdatePostRequest,
): Promise<PostMutationResponse> {
  return requestPostsApi<PostMutationResponse>({
    path: `/api/posts/${encodeURIComponent(postId)}`,
    method: 'PUT',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(postMutationResponseSchema.safeParse(value));
    },
  });
}

export function requestDeletePost(
  csrfToken: string,
  postId: string,
  request: DeletePostRequest,
): Promise<PostDeleteResponse> {
  return requestPostsApi<PostDeleteResponse>({
    path: `/api/posts/${encodeURIComponent(postId)}`,
    method: 'DELETE',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(postDeleteResponseSchema.safeParse(value));
    },
  });
}

export function requestPostBulkLifecycle(
  csrfToken: string,
  request: PostBulkLifecycleRequest,
): Promise<PostBulkLifecycleResponse> {
  return requestPostsApi<PostBulkLifecycleResponse>({
    path: '/api/posts/bulk-lifecycle',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(postBulkLifecycleResponseSchema.safeParse(value));
    },
  });
}

export function requestPostNewsletterNotification(
  csrfToken: string,
  postId: string,
  request: PostNewsletterNotificationRequest,
): Promise<PostNewsletterNotificationResponse> {
  return requestPostsApi<PostNewsletterNotificationResponse>({
    path: `/api/posts/${encodeURIComponent(postId)}/newsletter-notification`,
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(postNewsletterNotificationResponseSchema.safeParse(value));
    },
  });
}
import { studioFetch } from './studio-fetch';

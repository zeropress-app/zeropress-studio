import {
  pageAutosaveDeleteResponseSchema,
  pageAutosaveMutationResponseSchema,
  pageAutosavePromotionResponseSchema,
  pageAutosaveReadResponseSchema,
  type PageAutosaveDeleteResponse,
  type PageAutosaveMutationResponse,
  type PageAutosavePromotionRequest,
  type PageAutosavePromotionResponse,
  type PageAutosaveReadResponse,
  type PutPageAutosaveRequest,
} from '../../../contracts/page-autosaves';
import type { ContentAutosaveDeleteRequest } from '../../../contracts/content-snapshots';
import type { RestoreContentRevisionRequest } from '../../../contracts/content-revisions';
import {
  aiExcerptResponseSchema,
  type AiExcerptRequest,
  type AiExcerptResponse,
} from '../../../contracts/ai-excerpt';
import {
  aiPageDraftResponseSchema,
  type AiPageDraftRequest,
  type AiPageDraftResponse,
} from '../../../contracts/ai-page-draft';
import {
  pageRevisionDetailResponseSchema,
  pageRevisionListResponseSchema,
  pageRevisionRestoreResponseSchema,
  type PageRevisionDetailResponse,
  type PageRevisionListResponse,
  type PageRevisionRestoreResponse,
} from '../../../contracts/page-revisions';
import {
  pageDeleteResponseSchema,
  pageBulkLifecycleResponseSchema,
  pageDetailResponseSchema,
  pageListResponseSchema,
  pageMutationResponseSchema,
  pageParentOptionsResponseSchema,
  type CreatePageRequest,
  type DeletePageRequest,
  type PageDeleteResponse,
  type PageBulkLifecycleRequest,
  type PageBulkLifecycleResponse,
  type PageDetailResponse,
  type PageListQuery,
  type PageListResponse,
  type PageMutationResponse,
  type PageParentOptionsResponse,
  type UpdatePageRequest,
} from '../../../contracts/pages';

const PAGES_TIMEOUT_MS = 30_000;
const PAGES_AI_TIMEOUT_MS = 60_000;
const PAGES_AI_DRAFT_TIMEOUT_MS = 75_000;

export type PagesClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class PagesClientError extends Error {
  constructor(public readonly code: PagesClientErrorCode) {
    super(code);
    this.name = 'PagesClientError';
  }
}

async function requestPagesApi<T>(input: {
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
    input.timeoutMs ?? PAGES_TIMEOUT_MS,
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
      throw new PagesClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(value);
    if (!parsed.success) throw new PagesClientError('INVALID_RESPONSE');
    return parsed.data;
  } catch (error) {
    if (error instanceof PagesClientError) throw error;
    if (controller.signal.aborted) throw new PagesClientError('TIMEOUT');
    throw new PagesClientError('NETWORK_ERROR');
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

export function requestPages(
  query: PageListQuery,
  signal?: AbortSignal,
): Promise<PageListResponse> {
  const params = new URLSearchParams({
    search: query.search,
    status: query.status,
    page: String(query.page),
    per_page: String(query.per_page),
  });
  return requestPagesApi<PageListResponse>({
    path: `/api/pages?${params.toString()}`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(pageListResponseSchema.safeParse(value));
    },
  });
}

export function requestPage(
  pageId: string,
  signal?: AbortSignal,
): Promise<PageDetailResponse> {
  return requestPagesApi<PageDetailResponse>({
    path: `/api/pages/${encodeURIComponent(pageId)}`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(pageDetailResponseSchema.safeParse(value));
    },
  });
}

export function requestGeneratePageExcerpt(
  csrfToken: string,
  request: AiExcerptRequest,
  signal?: AbortSignal,
): Promise<AiExcerptResponse> {
  return requestPagesApi<AiExcerptResponse>({
    path: '/api/pages/ai/excerpt',
    method: 'POST',
    csrfToken,
    body: request,
    signal,
    timeoutMs: PAGES_AI_TIMEOUT_MS,
    parse(value) {
      return parsed(aiExcerptResponseSchema.safeParse(value));
    },
  });
}

export function requestGeneratePageDraft(
  csrfToken: string,
  request: AiPageDraftRequest,
  signal?: AbortSignal,
): Promise<AiPageDraftResponse> {
  return requestPagesApi<AiPageDraftResponse>({
    path: '/api/pages/ai/draft',
    method: 'POST',
    csrfToken,
    body: request,
    signal,
    timeoutMs: PAGES_AI_DRAFT_TIMEOUT_MS,
    parse(value) {
      return parsed(aiPageDraftResponseSchema.safeParse(value));
    },
  });
}

export function requestPageParentOptions(
  search = '',
  currentPageId?: string,
  signal?: AbortSignal,
): Promise<PageParentOptionsResponse> {
  const params = new URLSearchParams({ search });
  if (currentPageId) params.set('current_page_id', currentPageId);
  return requestPagesApi<PageParentOptionsResponse>({
    path: `/api/pages/parent-options?${params.toString()}`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(pageParentOptionsResponseSchema.safeParse(value));
    },
  });
}

export function requestPageAutosave(
  locator: { draft_id: string } | { target_id: string },
  signal?: AbortSignal,
): Promise<PageAutosaveReadResponse> {
  const params = new URLSearchParams(locator);
  return requestPagesApi<PageAutosaveReadResponse>({
    path: `/api/pages/autosave?${params.toString()}`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(pageAutosaveReadResponseSchema.safeParse(value));
    },
  });
}

export function requestRecentPageAutosave(
  signal?: AbortSignal,
): Promise<PageAutosaveReadResponse> {
  return requestPagesApi<PageAutosaveReadResponse>({
    path: '/api/pages/autosave/recent',
    method: 'GET',
    signal,
    parse(value) {
      return parsed(pageAutosaveReadResponseSchema.safeParse(value));
    },
  });
}

export function requestPutPageAutosave(
  csrfToken: string,
  request: PutPageAutosaveRequest,
): Promise<PageAutosaveMutationResponse> {
  return requestPagesApi<PageAutosaveMutationResponse>({
    path: '/api/pages/autosave',
    method: 'PUT',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(pageAutosaveMutationResponseSchema.safeParse(value));
    },
  });
}

export function requestDeletePageAutosave(
  csrfToken: string,
  request: ContentAutosaveDeleteRequest,
): Promise<PageAutosaveDeleteResponse> {
  return requestPagesApi<PageAutosaveDeleteResponse>({
    path: '/api/pages/autosave',
    method: 'DELETE',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(pageAutosaveDeleteResponseSchema.safeParse(value));
    },
  });
}

export function requestPromotePageAutosave(
  csrfToken: string,
  request: PageAutosavePromotionRequest,
): Promise<PageAutosavePromotionResponse> {
  return requestPagesApi<PageAutosavePromotionResponse>({
    path: '/api/pages/autosave/promote',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(pageAutosavePromotionResponseSchema.safeParse(value));
    },
  });
}

export function requestPageRevisions(
  pageId: string,
  signal?: AbortSignal,
): Promise<PageRevisionListResponse> {
  return requestPagesApi<PageRevisionListResponse>({
    path: `/api/pages/${encodeURIComponent(pageId)}/revisions`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(pageRevisionListResponseSchema.safeParse(value));
    },
  });
}

export function requestPageRevision(
  pageId: string,
  revisionId: string,
  signal?: AbortSignal,
): Promise<PageRevisionDetailResponse> {
  return requestPagesApi<PageRevisionDetailResponse>({
    path: `/api/pages/${encodeURIComponent(pageId)}/revisions/${encodeURIComponent(revisionId)}`,
    method: 'GET',
    signal,
    parse(value) {
      return parsed(pageRevisionDetailResponseSchema.safeParse(value));
    },
  });
}

export function requestRestorePageRevision(
  csrfToken: string,
  pageId: string,
  revisionId: string,
  request: RestoreContentRevisionRequest,
): Promise<PageRevisionRestoreResponse> {
  return requestPagesApi<PageRevisionRestoreResponse>({
    path: `/api/pages/${encodeURIComponent(pageId)}/revisions/${encodeURIComponent(revisionId)}/restore`,
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(pageRevisionRestoreResponseSchema.safeParse(value));
    },
  });
}

export function requestCreatePage(
  csrfToken: string,
  request: CreatePageRequest,
): Promise<PageMutationResponse> {
  return requestPagesApi<PageMutationResponse>({
    path: '/api/pages',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(pageMutationResponseSchema.safeParse(value));
    },
  });
}

export function requestUpdatePage(
  csrfToken: string,
  pageId: string,
  request: UpdatePageRequest,
): Promise<PageMutationResponse> {
  return requestPagesApi<PageMutationResponse>({
    path: `/api/pages/${encodeURIComponent(pageId)}`,
    method: 'PUT',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(pageMutationResponseSchema.safeParse(value));
    },
  });
}

export function requestDeletePage(
  csrfToken: string,
  pageId: string,
  request: DeletePageRequest,
): Promise<PageDeleteResponse> {
  return requestPagesApi<PageDeleteResponse>({
    path: `/api/pages/${encodeURIComponent(pageId)}`,
    method: 'DELETE',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(pageDeleteResponseSchema.safeParse(value));
    },
  });
}

export function requestPageBulkLifecycle(
  csrfToken: string,
  request: PageBulkLifecycleRequest,
): Promise<PageBulkLifecycleResponse> {
  return requestPagesApi<PageBulkLifecycleResponse>({
    path: '/api/pages/bulk-lifecycle',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      return parsed(pageBulkLifecycleResponseSchema.safeParse(value));
    },
  });
}
import { studioFetch } from './studio-fetch';

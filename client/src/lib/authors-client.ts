import {
  authorDeleteResponseSchema,
  authorListResponseSchema,
  authorMutationResponseSchema,
  authorUserOptionsResponseSchema,
  type AuthorDeleteResponse,
  type AuthorListQuery,
  type AuthorListResponse,
  type AuthorMutationResponse,
  type AuthorUserOptionsResponse,
  type CreateAuthorRequest,
  type DeleteAuthorRequest,
  type UpdateAuthorRequest,
} from '../../../contracts/authors';

const AUTHORS_TIMEOUT_MS = 15_000;

export type AuthorsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class AuthorsClientError extends Error {
  constructor(public readonly code: AuthorsClientErrorCode) {
    super(code);
    this.name = 'AuthorsClientError';
  }
}

async function requestAuthorsApi<T>(input: {
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
    AUTHORS_TIMEOUT_MS,
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
      throw new AuthorsClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(value);
    if (!parsed.success) throw new AuthorsClientError('INVALID_RESPONSE');
    return parsed.data;
  } catch (error) {
    if (error instanceof AuthorsClientError) throw error;
    if (controller.signal.aborted) throw new AuthorsClientError('TIMEOUT');
    throw new AuthorsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestAuthors(
  query: AuthorListQuery,
  signal?: AbortSignal,
): Promise<AuthorListResponse> {
  const params = new URLSearchParams({
    search: query.search,
    linked: query.linked,
    page: String(query.page),
    per_page: String(query.per_page),
  });
  return requestAuthorsApi<AuthorListResponse>({
    path: `/api/authors?${params.toString()}`,
    method: 'GET',
    signal,
    parse(value) {
      const parsed = authorListResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestAuthorUserOptions(
  signal?: AbortSignal,
): Promise<AuthorUserOptionsResponse> {
  return requestAuthorsApi<AuthorUserOptionsResponse>({
    path: '/api/authors/user-options',
    method: 'GET',
    signal,
    parse(value) {
      const parsed = authorUserOptionsResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestCreateAuthor(
  csrfToken: string,
  request: CreateAuthorRequest,
): Promise<AuthorMutationResponse> {
  return requestAuthorsApi<AuthorMutationResponse>({
    path: '/api/authors',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = authorMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestUpdateAuthor(
  csrfToken: string,
  authorId: string,
  request: UpdateAuthorRequest,
): Promise<AuthorMutationResponse> {
  return requestAuthorsApi<AuthorMutationResponse>({
    path: `/api/authors/${encodeURIComponent(authorId)}`,
    method: 'PUT',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = authorMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestDeleteAuthor(
  csrfToken: string,
  authorId: string,
  request: DeleteAuthorRequest,
): Promise<AuthorDeleteResponse> {
  return requestAuthorsApi<AuthorDeleteResponse>({
    path: `/api/authors/${encodeURIComponent(authorId)}`,
    method: 'DELETE',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = authorDeleteResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}
import { studioFetch } from './studio-fetch';

import {
  taxonomyDeleteResponseSchema,
  taxonomyListResponseSchema,
  taxonomyMutationResponseSchema,
  type CreateTaxonomyTermRequest,
  type DeleteTaxonomyTermRequest,
  type TaxonomyDeleteResponse,
  type TaxonomyKind,
  type TaxonomyListQuery,
  type TaxonomyListResponse,
  type TaxonomyMutationResponse,
  type UpdateTaxonomyTermRequest,
} from '../../../contracts/taxonomies';

const TAXONOMIES_TIMEOUT_MS = 15_000;

export type TaxonomiesClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class TaxonomiesClientError extends Error {
  constructor(public readonly code: TaxonomiesClientErrorCode) {
    super(code);
    this.name = 'TaxonomiesClientError';
  }
}

function pathFor(taxonomy: TaxonomyKind): 'categories' | 'tags' {
  return taxonomy === 'category' ? 'categories' : 'tags';
}

async function requestTaxonomiesApi<T>(input: {
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
    TAXONOMIES_TIMEOUT_MS,
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
      throw new TaxonomiesClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(value);
    if (!parsed.success) throw new TaxonomiesClientError('INVALID_RESPONSE');
    return parsed.data;
  } catch (error) {
    if (error instanceof TaxonomiesClientError) throw error;
    if (controller.signal.aborted) {
      throw new TaxonomiesClientError('TIMEOUT');
    }
    throw new TaxonomiesClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestTaxonomyTerms(
  taxonomy: TaxonomyKind,
  query: TaxonomyListQuery,
  signal?: AbortSignal,
): Promise<TaxonomyListResponse> {
  const params = new URLSearchParams({
    search: query.search,
    page: String(query.page),
    per_page: String(query.per_page),
  });
  return requestTaxonomiesApi<TaxonomyListResponse>({
    path: `/api/taxonomies/${pathFor(taxonomy)}?${params.toString()}`,
    method: 'GET',
    signal,
    parse(value) {
      const parsed = taxonomyListResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestCreateTaxonomyTerm(
  csrfToken: string,
  taxonomy: TaxonomyKind,
  request: CreateTaxonomyTermRequest,
): Promise<TaxonomyMutationResponse> {
  return requestTaxonomiesApi<TaxonomyMutationResponse>({
    path: `/api/taxonomies/${pathFor(taxonomy)}`,
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = taxonomyMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestUpdateTaxonomyTerm(
  csrfToken: string,
  taxonomy: TaxonomyKind,
  termId: string,
  request: UpdateTaxonomyTermRequest,
): Promise<TaxonomyMutationResponse> {
  return requestTaxonomiesApi<TaxonomyMutationResponse>({
    path: `/api/taxonomies/${pathFor(taxonomy)}/${encodeURIComponent(termId)}`,
    method: 'PUT',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = taxonomyMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestDeleteTaxonomyTerm(
  csrfToken: string,
  taxonomy: TaxonomyKind,
  termId: string,
  request: DeleteTaxonomyTermRequest,
): Promise<TaxonomyDeleteResponse> {
  return requestTaxonomiesApi<TaxonomyDeleteResponse>({
    path: `/api/taxonomies/${pathFor(taxonomy)}/${encodeURIComponent(termId)}`,
    method: 'DELETE',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = taxonomyDeleteResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}
import { studioFetch } from './studio-fetch';

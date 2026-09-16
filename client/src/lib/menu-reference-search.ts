import type { ApiErrorCode } from '../../../contracts/api';
import type { MenuReferenceKind, MenuReferenceSummary } from '../../../contracts/menus';
import { PagesClientError, requestPages } from './pages-client';
import { PostsClientError, requestPosts } from './posts-client';
import { requestTaxonomyTerms, TaxonomiesClientError } from './taxonomies-client';

export const MENU_REFERENCE_PAGE_SIZE = 20;

export type MenuReferenceSearchQuery = {
  kind: MenuReferenceKind;
  search: string;
  page: number;
  status: 'published' | 'draft';
};

export type MenuReferenceChoice = {
  reference: MenuReferenceSummary;
  status: 'published' | 'draft' | null;
};

export type MenuReferenceSearchResult = {
  items: MenuReferenceChoice[];
  pagination: { page: number; per_page: number; total: number; total_pages: number };
};

export class MenuReferenceSearchError extends Error {
  constructor(public readonly code: ApiErrorCode | 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE') {
    super(code);
    this.name = 'MenuReferenceSearchError';
  }
}

/** Reuse the existing authenticated list/search contracts, never a select-options catalog. */
export async function requestMenuReferenceSearch(
  query: MenuReferenceSearchQuery,
  signal?: AbortSignal,
): Promise<MenuReferenceSearchResult> {
  const listQuery = {
    search: query.search,
    page: query.page,
    per_page: MENU_REFERENCE_PAGE_SIZE,
  };
  try {
    let result: MenuReferenceSearchResult;
    if (query.kind === 'post') {
      const response = await requestPosts({ ...listQuery, status: query.status }, signal);
      if (!response.success) throw new MenuReferenceSearchError(response.error.code);
      // Never silently filter a paginated response or offer a trashed reference.
      if (response.data.items.some((item) => item.status !== query.status)) {
        throw new MenuReferenceSearchError('INVALID_RESPONSE');
      }
      result = {
        items: response.data.items.map((item) => ({
          reference: { kind: 'post', reference_id: item.id, title: item.title, detail: item.slug },
          status: query.status,
        })),
        pagination: response.data.pagination,
      };
    } else if (query.kind === 'page') {
      const response = await requestPages({ ...listQuery, status: query.status }, signal);
      if (!response.success) throw new MenuReferenceSearchError(response.error.code);
      if (response.data.items.some((item) => item.status !== query.status)) {
        throw new MenuReferenceSearchError('INVALID_RESPONSE');
      }
      result = {
        items: response.data.items.map((item) => ({
          reference: { kind: 'page', reference_id: item.id, title: item.title, detail: `/${item.path}/` },
          status: query.status,
        })),
        pagination: response.data.pagination,
      };
    } else {
      const kind = query.kind;
      const response = await requestTaxonomyTerms(kind, listQuery, signal);
      if (!response.success) throw new MenuReferenceSearchError(response.error.code);
      if (response.data.items.some((item) => item.taxonomy !== kind)) {
        throw new MenuReferenceSearchError('INVALID_RESPONSE');
      }
      result = {
        items: response.data.items.map((item) => ({
          reference: { kind, reference_id: item.id, title: item.name, detail: item.slug },
          status: null,
        })),
        pagination: response.data.pagination,
      };
    }
    if (result.pagination.page !== query.page
      || result.pagination.per_page !== MENU_REFERENCE_PAGE_SIZE) {
      throw new MenuReferenceSearchError('INVALID_RESPONSE');
    }
    return result;
  } catch (cause) {
    if (cause instanceof MenuReferenceSearchError) throw cause;
    if (cause instanceof PostsClientError || cause instanceof PagesClientError
      || cause instanceof TaxonomiesClientError) {
      throw new MenuReferenceSearchError(cause.code);
    }
    throw new MenuReferenceSearchError('NETWORK_ERROR');
  }
}

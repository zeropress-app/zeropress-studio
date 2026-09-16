import {
  menuDeleteResponseSchema,
  menuListResponseSchema,
  menuMutationResponseSchema,
  menuReferenceKey,
  menuReferencesResponseSchema,
  menuSaveResponseSchema,
  type CreateMenuRequest,
  type DeleteMenuRequest,
  type MenuDeleteResponse,
  type MenuListResponse,
  type MenuMutationResponse,
  type MenuReferencesResponse,
  type MenuSaveResponse,
  type SaveMenuRequest,
  type ResolveMenuReferencesRequest,
} from '../../../contracts/menus';

const MENUS_TIMEOUT_MS = 20_000;

export type MenusClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class MenusClientError extends Error {
  constructor(public readonly code: MenusClientErrorCode) {
    super(code);
    this.name = 'MenusClientError';
  }
}

async function requestMenusApi<T>(input: {
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
    MENUS_TIMEOUT_MS,
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
      throw new MenusClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(value);
    if (!parsed.success) throw new MenusClientError('INVALID_RESPONSE');
    return parsed.data;
  } catch (error) {
    if (error instanceof MenusClientError) throw error;
    if (controller.signal.aborted) throw new MenusClientError('TIMEOUT');
    throw new MenusClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestMenus(signal?: AbortSignal): Promise<MenuListResponse> {
  return requestMenusApi<MenuListResponse>({
    path: '/api/menus',
    method: 'GET',
    signal,
    parse(value) {
      const parsed = menuListResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestMenuReferences(
  csrfToken: string,
  request: ResolveMenuReferencesRequest,
  signal?: AbortSignal,
): Promise<MenuReferencesResponse> {
  const requestedKeys = new Set(request.references.map(menuReferenceKey));
  return requestMenusApi<MenuReferencesResponse>({
    path: '/api/menus/link-references',
    method: 'POST',
    csrfToken,
    body: request,
    signal,
    parse(value) {
      const parsed = menuReferencesResponseSchema.safeParse(value);
      if (parsed.success && parsed.data.success) {
        const items = parsed.data.data.items;
        if (items.length !== requestedKeys.size
          || items.some((item) => !requestedKeys.has(menuReferenceKey(item)))) {
          return { success: false as const };
        }
      }
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestCreateMenu(
  csrfToken: string,
  request: CreateMenuRequest,
): Promise<MenuMutationResponse> {
  return requestMenusApi<MenuMutationResponse>({
    path: '/api/menus',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = menuMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestSaveMenu(
  csrfToken: string,
  menuId: string,
  request: SaveMenuRequest,
): Promise<MenuSaveResponse> {
  return requestMenusApi<MenuSaveResponse>({
    path: `/api/menus/${encodeURIComponent(menuId)}`,
    method: 'PUT',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = menuSaveResponseSchema.safeParse(value);
      if (parsed.success && parsed.data.success
        && !parsed.data.data.items.some((menu) => menu.menu_id === menuId)) {
        return { success: false as const };
      }
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestDeleteMenu(
  csrfToken: string,
  menuId: string,
  request: DeleteMenuRequest,
): Promise<MenuDeleteResponse> {
  return requestMenusApi<MenuDeleteResponse>({
    path: `/api/menus/${encodeURIComponent(menuId)}`,
    method: 'DELETE',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = menuDeleteResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}
import { studioFetch } from './studio-fetch';

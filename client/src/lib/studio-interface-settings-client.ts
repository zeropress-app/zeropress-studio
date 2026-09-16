import {
  publicInterfaceConfigResponseSchema,
  studioInterfaceSettingsResponseSchema,
  type PublicInterfaceConfigResponse,
  type StudioInterfaceSettingsResponse,
  type UpdateStudioInterfaceSettingsRequest,
} from '../../../contracts/studio-interface-settings';

const INTERFACE_SETTINGS_TIMEOUT_MS = 15_000;

export type StudioInterfaceSettingsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class StudioInterfaceSettingsClientError extends Error {
  constructor(public readonly code: StudioInterfaceSettingsClientErrorCode) {
    super(code);
    this.name = 'StudioInterfaceSettingsClientError';
  }
}

async function requestJson<T>(input: {
  path: string;
  method?: 'GET' | 'PUT';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  parse: (value: unknown) => { success: true; data: T } | { success: false };
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    INTERFACE_SETTINGS_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await studioFetch(input.path, {
      method: input.method ?? 'GET',
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
    });
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new StudioInterfaceSettingsClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(raw);
    if (!parsed.success) {
      throw new StudioInterfaceSettingsClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof StudioInterfaceSettingsClientError) throw error;
    if (controller.signal.aborted) {
      throw new StudioInterfaceSettingsClientError('TIMEOUT');
    }
    throw new StudioInterfaceSettingsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestPublicInterfaceConfig(
  signal?: AbortSignal,
): Promise<PublicInterfaceConfigResponse> {
  return requestJson<PublicInterfaceConfigResponse>({
    path: '/api/system/interface-config',
    signal,
    parse(value) {
      const parsed = publicInterfaceConfigResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestStudioInterfaceSettings(
  signal?: AbortSignal,
): Promise<StudioInterfaceSettingsResponse> {
  return requestJson<StudioInterfaceSettingsResponse>({
    path: '/api/settings/interface',
    signal,
    parse(value) {
      const parsed = studioInterfaceSettingsResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestUpdateStudioInterfaceSettings(
  csrfToken: string,
  request: UpdateStudioInterfaceSettingsRequest,
): Promise<StudioInterfaceSettingsResponse> {
  return requestJson<StudioInterfaceSettingsResponse>({
    path: '/api/settings/interface',
    method: 'PUT',
    body: request,
    csrfToken,
    parse(value) {
      const parsed = studioInterfaceSettingsResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}
import { studioFetch } from './studio-fetch';

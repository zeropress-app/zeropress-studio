import {
  currentSessionResponseSchema,
  logoutResponseSchema,
  revokeOtherSessionsResponseSchema,
  revokeSessionResponseSchema,
  sessionListResponseSchema,
  type CurrentSessionResponse,
  type LogoutResponse,
  type RevokeOtherSessionsResponse,
  type RevokeSessionResponse,
  type SessionListResponse,
} from '../../../contracts/session';

const SESSION_TIMEOUT_MS = 15_000;

export type SessionClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class SessionClientError extends Error {
  constructor(
    public readonly code: SessionClientErrorCode,
  ) {
    super(code);
    this.name = 'SessionClientError';
  }
}

async function requestSessionApi<T>(input: {
  path: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  parse: (value: unknown) => { success: true; data: T } | { success: false };
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    SESSION_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) {
    controller.abort();
  } else {
    input.signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  try {
    const response = await studioFetch(input.path, {
      method: input.method,
      headers: {
        Accept: 'application/json',
        ...input.headers,
      },
      body: input.body,
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      throw new SessionClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(rawResponse);
    if (!parsed.success) {
      throw new SessionClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof SessionClientError) throw error;
    if (controller.signal.aborted) {
      throw new SessionClientError('TIMEOUT');
    }
    throw new SessionClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestCurrentSession(
  signal?: AbortSignal,
): Promise<CurrentSessionResponse> {
  return requestSessionApi<CurrentSessionResponse>({
    path: '/api/auth/session',
    method: 'GET',
    signal,
    parse(value) {
      const parsed = currentSessionResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestLogout(
  csrfToken: string,
): Promise<LogoutResponse> {
  return requestSessionApi<LogoutResponse>({
    path: '/api/auth/logout',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': csrfToken,
    },
    body: '{}',
    parse(value) {
      const parsed = logoutResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestSessionList(
  signal?: AbortSignal,
): Promise<SessionListResponse> {
  return requestSessionApi<SessionListResponse>({
    path: '/api/auth/sessions',
    method: 'GET',
    signal,
    parse(value) {
      const parsed = sessionListResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestRevokeSession(
  csrfToken: string,
  sessionId: string,
): Promise<RevokeSessionResponse> {
  return requestSessionApi<RevokeSessionResponse>({
    path: '/api/auth/sessions/revoke',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': csrfToken,
    },
    body: JSON.stringify({ session_id: sessionId }),
    parse(value) {
      const parsed = revokeSessionResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestRevokeOtherSessions(
  csrfToken: string,
): Promise<RevokeOtherSessionsResponse> {
  return requestSessionApi<RevokeOtherSessionsResponse>({
    path: '/api/auth/sessions/revoke-others',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': csrfToken,
    },
    body: '{}',
    parse(value) {
      const parsed = revokeOtherSessionsResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}
import { studioFetch } from './studio-fetch';

import {
  completeUserSetupResponseSchema,
  destructiveUserMutationResponseSchema,
  inspectUserSetupResponseSchema,
  userDeletionImpactResponseSchema,
  prepareUserSetupResponseSchema,
  userSetupIssuedResponseSchema,
  userListResponseSchema,
  userMutationResponseSchema,
  type CancelUserInvitationRequest,
  type CompleteUserSetupRequest,
  type CompleteUserSetupResponse,
  type CreateUserInvitationRequest,
  type DeleteUserAccountRequest,
  type DestructiveUserMutationResponse,
  type InspectUserDeletionImpactRequest,
  type InspectUserSetupRequest,
  type InspectUserSetupResponse,
  type PrepareUserSetupRequest,
  type PrepareUserSetupResponse,
  type ReissueUserInvitationRequest,
  type ResetUserAccessRequest,
  type UpdateUserNameRequest,
  type UpdateUserRoleRequest,
  type UpdateUserStatusRequest,
  type UserListQuery,
  type UserSetupIssuedResponse,
  type UserListResponse,
  type UserDeletionImpactResponse,
  type UserMutationResponse,
} from '../../../contracts/users';

const USERS_TIMEOUT_MS = 15_000;

export type UsersClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class UsersClientError extends Error {
  constructor(public readonly code: UsersClientErrorCode) {
    super(code);
    this.name = 'UsersClientError';
  }
}

async function requestUsersApi<T>(input: {
  path: string;
  method: 'GET' | 'POST';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  parse: (value: unknown) => { success: true; data: T } | { success: false };
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    USERS_TIMEOUT_MS,
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
        ...(input.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...(input.csrfToken
          ? { 'X-ZeroPress-CSRF': input.csrfToken }
          : {}),
      },
      body: input.body === undefined
        ? undefined
        : JSON.stringify(input.body),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      throw new UsersClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(rawResponse);
    if (!parsed.success) {
      throw new UsersClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof UsersClientError) throw error;
    if (controller.signal.aborted) {
      throw new UsersClientError('TIMEOUT');
    }
    throw new UsersClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestUsers(
  query: UserListQuery,
  signal?: AbortSignal,
): Promise<UserListResponse> {
  const search = new URLSearchParams({
    search: query.search,
    role: query.role,
    status: query.status,
    page: String(query.page),
    per_page: String(query.per_page),
  });
  return requestUsersApi<UserListResponse>({
    path: `/api/users?${search.toString()}`,
    method: 'GET',
    signal,
    parse(value) {
      const parsed = userListResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestCreateUserInvitation(
  csrfToken: string,
  request: CreateUserInvitationRequest,
): Promise<UserSetupIssuedResponse> {
  return requestUsersApi<UserSetupIssuedResponse>({
    path: '/api/users/invitations',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = userSetupIssuedResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestReissueUserInvitation(
  csrfToken: string,
  request: ReissueUserInvitationRequest,
): Promise<UserSetupIssuedResponse> {
  return requestUsersApi<UserSetupIssuedResponse>({
    path: '/api/users/invitations/reissue',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = userSetupIssuedResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestUpdateUserRole(
  csrfToken: string,
  request: UpdateUserRoleRequest,
): Promise<UserMutationResponse> {
  return requestUsersApi<UserMutationResponse>({
    path: '/api/users/role',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = userMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestUpdateUserName(
  csrfToken: string,
  request: UpdateUserNameRequest,
): Promise<UserMutationResponse> {
  return requestUsersApi<UserMutationResponse>({
    path: '/api/users/name',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = userMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestResetUserAccess(
  csrfToken: string,
  request: ResetUserAccessRequest,
): Promise<UserSetupIssuedResponse> {
  return requestUsersApi<UserSetupIssuedResponse>({
    path: '/api/users/access-recovery',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = userSetupIssuedResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestUpdateUserStatus(
  csrfToken: string,
  request: UpdateUserStatusRequest,
): Promise<UserMutationResponse> {
  return requestUsersApi<UserMutationResponse>({
    path: '/api/users/status',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = userMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestUserDeletionImpact(
  csrfToken: string,
  request: InspectUserDeletionImpactRequest,
): Promise<UserDeletionImpactResponse> {
  return requestUsersApi<UserDeletionImpactResponse>({
    path: '/api/users/deletion-impact',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = userDeletionImpactResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestCancelUserInvitation(
  csrfToken: string,
  request: CancelUserInvitationRequest,
): Promise<DestructiveUserMutationResponse> {
  return requestUsersApi<DestructiveUserMutationResponse>({
    path: '/api/users/invitations/cancel',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = destructiveUserMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestDeleteUserAccount(
  csrfToken: string,
  request: DeleteUserAccountRequest,
): Promise<DestructiveUserMutationResponse> {
  return requestUsersApi<DestructiveUserMutationResponse>({
    path: '/api/users/delete',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = destructiveUserMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestInspectUserSetup(
  request: InspectUserSetupRequest,
  signal?: AbortSignal,
): Promise<InspectUserSetupResponse> {
  return requestUsersApi<InspectUserSetupResponse>({
    path: '/api/auth/account-setup/inspect',
    method: 'POST',
    body: request,
    signal,
    parse(value) {
      const parsed = inspectUserSetupResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestPrepareUserSetup(
  request: PrepareUserSetupRequest,
): Promise<PrepareUserSetupResponse> {
  return requestUsersApi<PrepareUserSetupResponse>({
    path: '/api/auth/account-setup/setup',
    method: 'POST',
    body: request,
    parse(value) {
      const parsed = prepareUserSetupResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestCompleteUserSetup(
  request: CompleteUserSetupRequest,
): Promise<CompleteUserSetupResponse> {
  return requestUsersApi<CompleteUserSetupResponse>({
    path: '/api/auth/account-setup/complete',
    method: 'POST',
    body: request,
    parse(value) {
      const parsed = completeUserSetupResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}
import { studioFetch } from './studio-fetch';

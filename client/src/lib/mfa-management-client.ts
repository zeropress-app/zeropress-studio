import {
  authorizeMfaManagementResponseSchema,
  mfaManagementStatusResponseSchema,
  mfaManagementTotpCompleteResponseSchema,
  mfaManagementTotpSetupResponseSchema,
  mfaManagementWebAuthnRegistrationCompleteResponseSchema,
  mfaManagementWebAuthnRegistrationOptionsResponseSchema,
  mfaManagementWebAuthnRemoveResponseSchema,
  mfaManagementWebAuthnRenameResponseSchema,
  mfaManagementWebAuthnStepUpOptionsResponseSchema,
  mfaManagementWebAuthnStepUpVerifyResponseSchema,
  type AuthorizeMfaManagementRequest,
  type AuthorizeMfaManagementResponse,
  type MfaManagementStatusResponse,
  type MfaManagementTotpCompleteRequest,
  type MfaManagementTotpCompleteResponse,
  type MfaManagementTotpSetupResponse,
  type MfaManagementWebAuthnRegistrationCompleteRequest,
  type MfaManagementWebAuthnRegistrationCompleteResponse,
  type MfaManagementWebAuthnRegistrationOptionsResponse,
  type MfaManagementWebAuthnRemoveRequest,
  type MfaManagementWebAuthnRemoveResponse,
  type MfaManagementWebAuthnRenameRequest,
  type MfaManagementWebAuthnRenameResponse,
  type MfaManagementWebAuthnStepUpOptionsRequest,
  type MfaManagementWebAuthnStepUpOptionsResponse,
  type MfaManagementWebAuthnStepUpVerifyRequest,
  type MfaManagementWebAuthnStepUpVerifyResponse,
} from '../../../contracts/mfa-management';
import {
  changePasswordResponseSchema,
  type ChangePasswordRequest,
  type ChangePasswordResponse,
} from '../../../contracts/password-management';

const MFA_MANAGEMENT_TIMEOUT_MS = 15_000;

export type MfaManagementClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class MfaManagementClientError extends Error {
  constructor(
    public readonly code: MfaManagementClientErrorCode,
  ) {
    super(code);
    this.name = 'MfaManagementClientError';
  }
}

async function requestMfaManagementApi<T>(input: {
  path: string;
  method: 'GET' | 'POST';
  csrfToken?: string;
  body?: unknown;
  signal?: AbortSignal;
  parse: (value: unknown) => { success: true; data: T } | { success: false };
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    MFA_MANAGEMENT_TIMEOUT_MS,
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
      throw new MfaManagementClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(rawResponse);
    if (!parsed.success) {
      throw new MfaManagementClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof MfaManagementClientError) throw error;
    if (controller.signal.aborted) {
      throw new MfaManagementClientError('TIMEOUT');
    }
    throw new MfaManagementClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestMfaManagementStatus(
  signal?: AbortSignal,
): Promise<MfaManagementStatusResponse> {
  return requestMfaManagementApi<MfaManagementStatusResponse>({
    path: '/api/auth/mfa/management/status',
    method: 'GET',
    signal,
    parse(value) {
      const parsed = mfaManagementStatusResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestMfaManagementAuthorization(
  csrfToken: string,
  request: AuthorizeMfaManagementRequest,
): Promise<AuthorizeMfaManagementResponse> {
  return requestMfaManagementApi<AuthorizeMfaManagementResponse>({
    path: '/api/auth/mfa/management/authorize',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = authorizeMfaManagementResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestChangePassword(
  csrfToken: string,
  request: ChangePasswordRequest,
): Promise<ChangePasswordResponse> {
  return requestMfaManagementApi<ChangePasswordResponse>({
    path: '/api/auth/mfa/management/password/complete',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = changePasswordResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestManagedTotpSetup(
  csrfToken: string,
  managementToken: string,
): Promise<MfaManagementTotpSetupResponse> {
  return requestMfaManagementApi<MfaManagementTotpSetupResponse>({
    path: '/api/auth/mfa/management/totp/setup',
    method: 'POST',
    csrfToken,
    body: { management_token: managementToken },
    parse(value) {
      const parsed = mfaManagementTotpSetupResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestManagedTotpComplete(
  csrfToken: string,
  request: MfaManagementTotpCompleteRequest,
): Promise<MfaManagementTotpCompleteResponse> {
  return requestMfaManagementApi<MfaManagementTotpCompleteResponse>({
    path: '/api/auth/mfa/management/totp/complete',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = mfaManagementTotpCompleteResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestMfaManagementWebAuthnStepUpOptions(
  csrfToken: string,
  request: MfaManagementWebAuthnStepUpOptionsRequest,
): Promise<MfaManagementWebAuthnStepUpOptionsResponse> {
  return requestMfaManagementApi<MfaManagementWebAuthnStepUpOptionsResponse>({
    path: '/api/auth/mfa/management/webauthn/step-up/options',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed =
        mfaManagementWebAuthnStepUpOptionsResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestMfaManagementWebAuthnStepUpVerification(
  csrfToken: string,
  request: MfaManagementWebAuthnStepUpVerifyRequest,
): Promise<MfaManagementWebAuthnStepUpVerifyResponse> {
  return requestMfaManagementApi<MfaManagementWebAuthnStepUpVerifyResponse>({
    path: '/api/auth/mfa/management/webauthn/step-up/verify',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed =
        mfaManagementWebAuthnStepUpVerifyResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestManagedWebAuthnRegistrationOptions(
  csrfToken: string,
  managementToken: string,
): Promise<MfaManagementWebAuthnRegistrationOptionsResponse> {
  return requestMfaManagementApi<
    MfaManagementWebAuthnRegistrationOptionsResponse
  >({
    path: '/api/auth/mfa/management/webauthn/registration/options',
    method: 'POST',
    csrfToken,
    body: { management_token: managementToken },
    parse(value) {
      const parsed =
        mfaManagementWebAuthnRegistrationOptionsResponseSchema.safeParse(
          value,
        );
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestManagedWebAuthnRegistrationComplete(
  csrfToken: string,
  request: MfaManagementWebAuthnRegistrationCompleteRequest,
): Promise<MfaManagementWebAuthnRegistrationCompleteResponse> {
  return requestMfaManagementApi<
    MfaManagementWebAuthnRegistrationCompleteResponse
  >({
    path: '/api/auth/mfa/management/webauthn/registration/complete',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed =
        mfaManagementWebAuthnRegistrationCompleteResponseSchema.safeParse(
          value,
        );
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestManagedWebAuthnRename(
  csrfToken: string,
  request: MfaManagementWebAuthnRenameRequest,
): Promise<MfaManagementWebAuthnRenameResponse> {
  return requestMfaManagementApi<MfaManagementWebAuthnRenameResponse>({
    path: '/api/auth/mfa/management/webauthn/rename',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = mfaManagementWebAuthnRenameResponseSchema.safeParse(
        value,
      );
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestManagedWebAuthnRemove(
  csrfToken: string,
  request: MfaManagementWebAuthnRemoveRequest,
): Promise<MfaManagementWebAuthnRemoveResponse> {
  return requestMfaManagementApi<MfaManagementWebAuthnRemoveResponse>({
    path: '/api/auth/mfa/management/webauthn/remove',
    method: 'POST',
    csrfToken,
    body: request,
    parse(value) {
      const parsed = mfaManagementWebAuthnRemoveResponseSchema.safeParse(
        value,
      );
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}
import { studioFetch } from './studio-fetch';

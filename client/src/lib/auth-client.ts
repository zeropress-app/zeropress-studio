import {
  loginResponseSchema,
  mfaEnrollmentCompleteResponseSchema,
  mfaEnrollmentSetupResponseSchema,
  mfaVerifyResponseSchema,
  type LoginRequest,
  type LoginResponse,
  type MfaEnrollmentCompleteRequest,
  type MfaEnrollmentCompleteResponse,
  type MfaEnrollmentSetupRequest,
  type MfaEnrollmentSetupResponse,
  type MfaVerifyRequest,
  type MfaVerifyResponse,
} from '../../../contracts/auth';
import {
  passkeySignInOptionsResponseSchema,
  passkeySignInVerifyResponseSchema,
  webAuthnLoginOptionsResponseSchema,
  webAuthnLoginVerifyResponseSchema,
  type PasskeySignInOptionsRequest,
  type PasskeySignInOptionsResponse,
  type PasskeySignInVerifyRequest,
  type PasskeySignInVerifyResponse,
  type WebAuthnLoginOptionsRequest,
  type WebAuthnLoginOptionsResponse,
  type WebAuthnLoginVerifyRequest,
  type WebAuthnLoginVerifyResponse,
} from '../../../contracts/webauthn';

const AUTH_TIMEOUT_MS = 15_000;

export class LoginClientError extends Error {
  constructor(
    public readonly code: LoginClientErrorCode,
  ) {
    super(code);
    this.name = 'LoginClientError';
  }
}

export type LoginClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

async function requestAuthApi<T>(input: {
  path: string;
  body: unknown;
  parse: (value: unknown) => { success: true; data: T } | { success: false };
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    AUTH_TIMEOUT_MS,
  );

  try {
    const response = await studioFetch(input.path, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input.body),
      credentials: 'same-origin',
      signal: controller.signal,
    });

    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      throw new LoginClientError('INVALID_RESPONSE');
    }

    const parsed = input.parse(rawResponse);
    if (!parsed.success) {
      throw new LoginClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof LoginClientError) throw error;
    if (controller.signal.aborted) {
      throw new LoginClientError('TIMEOUT');
    }
    throw new LoginClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function requestLogin(
  credentials: LoginRequest,
): Promise<LoginResponse> {
  return requestAuthApi<LoginResponse>({
    path: '/api/auth/login',
    body: credentials,
    parse(value) {
      const parsed = loginResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestMfaVerification(
  request: MfaVerifyRequest,
): Promise<MfaVerifyResponse> {
  return requestAuthApi<MfaVerifyResponse>({
    path: '/api/auth/mfa/verify',
    body: request,
    parse(value) {
      const parsed = mfaVerifyResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestWebAuthnLoginOptions(
  request: WebAuthnLoginOptionsRequest,
): Promise<WebAuthnLoginOptionsResponse> {
  return requestAuthApi<WebAuthnLoginOptionsResponse>({
    path: '/api/auth/mfa/webauthn/options',
    body: request,
    parse(value) {
      const parsed = webAuthnLoginOptionsResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestWebAuthnLoginVerification(
  request: WebAuthnLoginVerifyRequest,
): Promise<WebAuthnLoginVerifyResponse> {
  return requestAuthApi<WebAuthnLoginVerifyResponse>({
    path: '/api/auth/mfa/webauthn/verify',
    body: request,
    parse(value) {
      const parsed = webAuthnLoginVerifyResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestPasskeySignInOptions(
  request: PasskeySignInOptionsRequest,
): Promise<PasskeySignInOptionsResponse> {
  return requestAuthApi<PasskeySignInOptionsResponse>({
    path: '/api/auth/passkey/options',
    body: request,
    parse(value) {
      const parsed = passkeySignInOptionsResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestPasskeySignInVerification(
  request: PasskeySignInVerifyRequest,
): Promise<PasskeySignInVerifyResponse> {
  return requestAuthApi<PasskeySignInVerifyResponse>({
    path: '/api/auth/passkey/verify',
    body: request,
    parse(value) {
      const parsed = passkeySignInVerifyResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestMfaEnrollmentSetup(
  request: MfaEnrollmentSetupRequest,
): Promise<MfaEnrollmentSetupResponse> {
  return requestAuthApi<MfaEnrollmentSetupResponse>({
    path: '/api/auth/mfa/enrollment/setup',
    body: request,
    parse(value) {
      const parsed = mfaEnrollmentSetupResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestMfaEnrollmentComplete(
  request: MfaEnrollmentCompleteRequest,
): Promise<MfaEnrollmentCompleteResponse> {
  return requestAuthApi<MfaEnrollmentCompleteResponse>({
    path: '/api/auth/mfa/enrollment/complete',
    body: request,
    parse(value) {
      const parsed = mfaEnrollmentCompleteResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}
import { studioFetch } from './studio-fetch';

import {
  installAccessResponseSchema,
  installMfaSetupResponseSchema,
  installResponseSchema,
  type InstallAccessResponse,
  type InstallMfaSetupResponse,
  type InstallRequest,
  type InstallResponse,
} from '../../../contracts/install';
import { isValidStudioWorkerSecret } from '../../../contracts/worker-secret';

const INSTALL_TIMEOUT_MS = 30_000;

export type InstallClientErrorCode =
  | 'INVALID_TOKEN_FORMAT'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class InstallClientError extends Error {
  constructor(public readonly code: InstallClientErrorCode) {
    super(code);
    this.name = 'InstallClientError';
  }
}

async function parseInstallResponse<T>(input: {
  path: string;
  token: string;
  method: 'GET' | 'POST';
  body?: unknown;
  parse: (value: unknown) => { success: true; data: T } | { success: false };
}): Promise<T> {
  if (!isValidStudioWorkerSecret(input.token)) {
    throw new InstallClientError('INVALID_TOKEN_FORMAT');
  }
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    INSTALL_TIMEOUT_MS,
  );
  try {
    const response = await studioFetch(input.path, {
      method: input.method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.token}`,
        ...(input.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
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
      throw new InstallClientError('INVALID_RESPONSE');
    }
    const parsed = input.parse(rawResponse);
    if (!parsed.success) {
      throw new InstallClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof InstallClientError) throw error;
    if (controller.signal.aborted) {
      throw new InstallClientError('TIMEOUT');
    }
    throw new InstallClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function requestInstallAccess(
  token: string,
): Promise<InstallAccessResponse> {
  return parseInstallResponse<InstallAccessResponse>({
    path: '/api/system/install/access',
    token,
    method: 'GET',
    parse(value) {
      const parsed = installAccessResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestInstallMfaSetup(input: {
  token: string;
  adminEmail: string;
}): Promise<InstallMfaSetupResponse> {
  return parseInstallResponse<InstallMfaSetupResponse>({
    path: '/api/system/install/mfa/setup',
    token: input.token,
    method: 'POST',
    body: { admin_email: input.adminEmail },
    parse(value) {
      const parsed = installMfaSetupResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export async function requestInstall(input: {
  token: string;
  administrator: InstallRequest;
}): Promise<InstallResponse> {
  return parseInstallResponse<InstallResponse>({
    path: '/api/system/install',
    token: input.token,
    method: 'POST',
    body: input.administrator,
    parse(value) {
      const parsed = installResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}
import { studioFetch } from './studio-fetch';

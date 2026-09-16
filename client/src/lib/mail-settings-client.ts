import {
  mailSettingsResponseSchema,
  sendTestMailResponseSchema,
  testMailConnectionResponseSchema,
  type MailSettingsResponse,
  type SendTestMailRequest,
  type SendTestMailResponse,
  type TestMailConnectionRequest,
  type TestMailConnectionResponse,
  type UpdateMailSettingsRequest,
} from '../../../contracts/mail-settings';

const REQUEST_TIMEOUT_MS = 15_000;

export type MailSettingsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class MailSettingsClientError extends Error {
  constructor(public readonly code: MailSettingsClientErrorCode) {
    super(code);
    this.name = 'MailSettingsClientError';
  }
}

async function request<T>(input: {
  path: string;
  method: 'GET' | 'PUT' | 'POST';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  parse: (value: unknown) => T | null;
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await studioFetch(`/api/settings/mail${input.path}`, {
      method: input.method,
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
    const value = input.parse(await response.json().catch(() => null));
    if (!value) throw new MailSettingsClientError('INVALID_RESPONSE');
    return value;
  } catch (error) {
    if (error instanceof MailSettingsClientError) throw error;
    if (controller.signal.aborted) {
      throw new MailSettingsClientError('TIMEOUT');
    }
    throw new MailSettingsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abort);
  }
}

function parseSettings(value: unknown): MailSettingsResponse | null {
  const parsed = mailSettingsResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function requestMailSettings(signal?: AbortSignal) {
  return request({
    path: '',
    method: 'GET',
    signal,
    parse: parseSettings,
  });
}

export function requestUpdateMailSettings(
  csrfToken: string,
  body: UpdateMailSettingsRequest,
) {
  return request({
    path: '',
    method: 'PUT',
    body,
    csrfToken,
    parse: parseSettings,
  });
}

export function requestTestMailConnection(
  csrfToken: string,
  body: TestMailConnectionRequest,
): Promise<TestMailConnectionResponse> {
  return request({
    path: '/test-connection',
    method: 'POST',
    body,
    csrfToken,
    parse(value) {
      const parsed = testMailConnectionResponseSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
  });
}

export function requestSendTestMail(
  csrfToken: string,
  body: SendTestMailRequest,
): Promise<SendTestMailResponse> {
  return request({
    path: '/send-test',
    method: 'POST',
    body,
    csrfToken,
    parse(value) {
      const parsed = sendTestMailResponseSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
  });
}
import { studioFetch } from './studio-fetch';

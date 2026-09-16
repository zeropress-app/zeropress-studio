import { StudioOperationalError } from '../lib/operational-error';

const PROVIDER_TIMEOUT_MS = 10_000;
const PROVIDER_RESPONSE_LIMIT = 64 * 1024;

export type ActiveMailProvider = 'resend' | 'cloudflare';
export type MailProviderFailureKind =
  | 'authentication_failed'
  | 'request_rejected'
  | 'unavailable'
  | 'invalid_response';

export class MailProviderFailure extends Error {
  constructor(
    readonly kind: MailProviderFailureKind,
    readonly operationalError?: StudioOperationalError,
  ) {
    super(kind);
    this.name = 'MailProviderFailure';
  }
}

type FetchImplementation = typeof fetch;

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > PROVIDER_RESPONSE_LIMIT) {
        await reader.cancel();
        throw new RangeError('Mail provider response exceeded 64 KiB.');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function providerFetch(input: {
  provider: ActiveMailProvider;
  action: 'verify_credential' | 'send_mail';
  url: string;
  init: RequestInit;
  fetchImplementation?: FetchImplementation;
}): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const response = await (input.fetchImplementation ?? fetch)(input.url, {
      ...input.init,
      redirect: 'manual',
      signal: controller.signal,
    });
    let text: string;
    try {
      text = await readBoundedText(response);
    } catch (error) {
      throw new MailProviderFailure(
        'invalid_response',
        new StudioOperationalError('MAIL_PROVIDER_RESPONSE_INVALID', {
          cause: error,
          metadata: {
            service: input.provider,
            action: input.action,
            status: response.status,
            reason: 'response_too_large',
          },
        }),
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new MailProviderFailure('authentication_failed');
    }
    if (response.status >= 500 || response.status === 429) {
      throw new MailProviderFailure(
        'unavailable',
        new StudioOperationalError('MAIL_PROVIDER_REQUEST_FAILED', {
          metadata: {
            service: input.provider,
            action: input.action,
            status: response.status,
            reason: response.status === 429 ? 'rate_limited' : 'service_error',
          },
        }),
      );
    }
    if (!response.ok) {
      throw new MailProviderFailure('request_rejected');
    }
    return { response, text };
  } catch (error) {
    if (error instanceof MailProviderFailure) throw error;
    throw new MailProviderFailure(
      'unavailable',
      new StudioOperationalError('MAIL_PROVIDER_REQUEST_FAILED', {
        cause: error,
        metadata: {
          service: input.provider,
          action: input.action,
          reason: controller.signal.aborted ? 'timeout' : 'request_failed',
        },
      }),
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseProviderJson(input: {
  provider: ActiveMailProvider;
  action: 'verify_credential' | 'send_mail';
  text: string;
}): unknown {
  try {
    return JSON.parse(input.text) as unknown;
  } catch (error) {
    throw new MailProviderFailure(
      'invalid_response',
      new StudioOperationalError('MAIL_PROVIDER_RESPONSE_INVALID', {
        cause: error,
        metadata: {
          service: input.provider,
          action: input.action,
          reason: 'malformed_json',
        },
      }),
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function verifyMailProviderCredential(input: {
  provider: ActiveMailProvider;
  credential: string;
  fetchImplementation?: FetchImplementation;
}): Promise<void> {
  if (input.provider === 'resend') {
    const result = await providerFetch({
      provider: input.provider,
      action: 'verify_credential',
      url: 'https://api.resend.com/domains?limit=1',
      init: {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${input.credential}`,
        },
      },
      fetchImplementation: input.fetchImplementation,
    });
    const payload = parseProviderJson({
      provider: input.provider,
      action: 'verify_credential',
      text: result.text,
    });
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new MailProviderFailure(
        'invalid_response',
        new StudioOperationalError('MAIL_PROVIDER_RESPONSE_INVALID', {
          metadata: {
            service: input.provider,
            action: 'verify_credential',
            reason: 'unexpected_payload',
          },
        }),
      );
    }
    return;
  }

  const result = await providerFetch({
    provider: input.provider,
    action: 'verify_credential',
    url: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
    init: {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.credential}`,
      },
    },
    fetchImplementation: input.fetchImplementation,
  });
  const payload = parseProviderJson({
    provider: input.provider,
    action: 'verify_credential',
    text: result.text,
  });
  if (
    !isRecord(payload)
    || payload.success !== true
    || !isRecord(payload.result)
    || payload.result.status !== 'active'
  ) {
    throw new MailProviderFailure('authentication_failed');
  }
}

function formatResendFrom(email: string, name: string): string {
  return name
    ? `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" <${email}>`
    : email;
}

export async function sendMail(input: {
  provider: ActiveMailProvider;
  credential: string;
  cloudflareAccountId: string;
  fromEmail: string;
  fromName: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
  fetchImplementation?: FetchImplementation;
}): Promise<void> {
  if (input.provider === 'resend') {
    const result = await providerFetch({
      provider: input.provider,
      action: 'send_mail',
      url: 'https://api.resend.com/emails',
      init: {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${input.credential}`,
          'Content-Type': 'application/json',
          ...(input.idempotencyKey
            ? { 'Idempotency-Key': input.idempotencyKey }
            : {}),
        },
        body: JSON.stringify({
          from: formatResendFrom(input.fromEmail, input.fromName),
          to: [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
        }),
      },
      fetchImplementation: input.fetchImplementation,
    });
    const payload = parseProviderJson({
      provider: input.provider,
      action: 'send_mail',
      text: result.text,
    });
    if (!isRecord(payload) || typeof payload.id !== 'string' || !payload.id) {
      throw new MailProviderFailure(
        'invalid_response',
        new StudioOperationalError('MAIL_PROVIDER_RESPONSE_INVALID', {
          metadata: {
            service: input.provider,
            action: 'send_mail',
            reason: 'unexpected_payload',
          },
        }),
      );
    }
    return;
  }

  const result = await providerFetch({
    provider: input.provider,
    action: 'send_mail',
    url: `https://api.cloudflare.com/client/v4/accounts/${input.cloudflareAccountId}/email/sending/send`,
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${input.credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: {
          address: input.fromEmail,
          ...(input.fromName ? { name: input.fromName } : {}),
        },
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    },
    fetchImplementation: input.fetchImplementation,
  });
  const payload = parseProviderJson({
    provider: input.provider,
    action: 'send_mail',
    text: result.text,
  });
  if (!isRecord(payload) || payload.success !== true) {
    throw new MailProviderFailure('request_rejected');
  }
}

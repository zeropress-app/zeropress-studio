import {
  newsletterSettingsResponseSchema,
  type NewsletterSettingsResponse,
  type UpdateNewsletterSettingsRequest,
} from '../../../contracts/newsletter-settings';

const REQUEST_TIMEOUT_MS = 15_000;

export type NewsletterSettingsClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class NewsletterSettingsClientError extends Error {
  constructor(public readonly code: NewsletterSettingsClientErrorCode) {
    super(code);
    this.name = 'NewsletterSettingsClientError';
  }
}

async function request(input: {
  method: 'GET' | 'PUT';
  body?: UpdateNewsletterSettingsRequest;
  csrfToken?: string;
  signal?: AbortSignal;
}): Promise<NewsletterSettingsResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await studioFetch('/api/settings/newsletter', {
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
    const parsed = newsletterSettingsResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new NewsletterSettingsClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof NewsletterSettingsClientError) throw error;
    if (controller.signal.aborted) {
      throw new NewsletterSettingsClientError('TIMEOUT');
    }
    throw new NewsletterSettingsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abort);
  }
}

export function requestNewsletterSettings(signal?: AbortSignal) {
  return request({ method: 'GET', signal });
}

export function requestUpdateNewsletterSettings(
  csrfToken: string,
  body: UpdateNewsletterSettingsRequest,
) {
  return request({ method: 'PUT', body, csrfToken });
}
import { studioFetch } from './studio-fetch';

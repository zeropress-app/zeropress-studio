import {
  contentSearchIndexRebuildMutationResponseSchema,
  contentSearchIndexStatusResponseSchema,
  type ContentSearchIndexRebuildStepRequest,
} from '../../../contracts/content-search-index';
import { studioFetch } from './studio-fetch';

export class ContentSearchIndexClientError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ContentSearchIndexClientError';
  }
}

async function request(input: {
  path: string;
  csrfToken?: string;
  body?: unknown;
  signal?: AbortSignal;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  const abort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await studioFetch(`/api/content-search-index${input.path}`, {
      method: input.body === undefined ? 'GET' : 'POST',
      headers: {
        Accept: 'application/json',
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(input.csrfToken ? { 'X-ZeroPress-CSRF': input.csrfToken } : {}),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: controller.signal,
    });
    try {
      return await response.json();
    } catch {
      throw new ContentSearchIndexClientError('INVALID_RESPONSE');
    }
  } catch (error) {
    if (error instanceof ContentSearchIndexClientError) throw error;
    throw new ContentSearchIndexClientError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  }
}

export async function requestContentSearchIndex(signal?: AbortSignal) {
  const parsed = contentSearchIndexStatusResponseSchema.safeParse(
    await request({ path: '', signal }),
  );
  if (!parsed.success) throw new ContentSearchIndexClientError('INVALID_RESPONSE');
  if (!parsed.data.success) throw new ContentSearchIndexClientError(parsed.data.error.code);
  return parsed.data.data;
}

export async function requestContentSearchIndexRebuild(input: {
  csrfToken: string;
  step?: ContentSearchIndexRebuildStepRequest;
  signal?: AbortSignal;
}) {
  const parsed = contentSearchIndexRebuildMutationResponseSchema.safeParse(await request({
    path: input.step ? '/rebuild/step' : '/rebuild/start',
    csrfToken: input.csrfToken,
    body: input.step ?? {},
    signal: input.signal,
  }));
  if (!parsed.success) throw new ContentSearchIndexClientError('INVALID_RESPONSE');
  if (!parsed.data.success) throw new ContentSearchIndexClientError(parsed.data.error.code);
  return parsed.data.data.content_search_index;
}

import {
  previewDataResponseSchema,
  previewDataSummaryResponseSchema,
  type PreviewDataResponse,
  type PreviewDataSummaryResponse,
} from '../../../contracts/preview-data';
import type { ZodType } from 'zod';
import { studioFetch } from './studio-fetch';

const PREVIEW_DATA_TIMEOUT_MS = 15_000;

export type PreviewDataClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class PreviewDataClientError extends Error {
  constructor(public readonly code: PreviewDataClientErrorCode) {
    super(code);
    this.name = 'PreviewDataClientError';
  }
}

async function requestPreviewDataResource<T>(
  pathname: string,
  schema: ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    PREVIEW_DATA_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  try {
    const response = await studioFetch(pathname, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let rawResponse: unknown;
    try {
      rawResponse = await response.json();
    } catch {
      throw new PreviewDataClientError('INVALID_RESPONSE');
    }
    const parsed = schema.safeParse(rawResponse);
    if (!parsed.success) {
      throw new PreviewDataClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof PreviewDataClientError) throw error;
    if (controller.signal.aborted) {
      throw new PreviewDataClientError('TIMEOUT');
    }
    throw new PreviewDataClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestPreviewData(
  signal?: AbortSignal,
): Promise<PreviewDataResponse> {
  return requestPreviewDataResource(
    '/api/preview-data',
    previewDataResponseSchema,
    signal,
  );
}

export function requestPreviewDataSummary(
  signal?: AbortSignal,
): Promise<PreviewDataSummaryResponse> {
  return requestPreviewDataResource(
    '/api/preview-data/summary',
    previewDataSummaryResponseSchema,
    signal,
  );
}

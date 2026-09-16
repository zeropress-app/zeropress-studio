import {
  WXR_IMPORT_CHUNK_MAX_ROWS,
  WXR_IMPORT_CLIENT_CHUNK_TARGET_BYTES,
  WXR_IMPORT_COMMENT_CHUNK_MAX_ROWS,
  WXR_IMPORT_MENU_CHUNK_MAX_ROWS,
  WXR_IMPORT_POST_CHUNK_MAX_ROWS,
  wxrCoreImportChunkRequestSchema,
  wxrCoreImportChunkResponseSchema,
  wxrImportSettingsFinalizeRequestSchema,
  wxrImportSettingsFinalizeResponseSchema,
  type WxrCoreImportChunkRequest,
  type WxrCoreImportChunkResponse,
  type WxrImportPhase,
  type WxrImportSettingsFinalizeRequest,
  type WxrImportSettingsFinalizeResponse,
} from '../../../contracts/wxr-import';
import type { WxrCoreImportPlan } from '../wxr/wxr-core-parser';

const WXR_IMPORT_TIMEOUT_MS = 60_000;
const encoder = new TextEncoder();

export type WxrImportClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'ROW_TOO_LARGE';

export class WxrImportClientError extends Error {
  constructor(public readonly code: WxrImportClientErrorCode) {
    super(code);
    this.name = 'WxrImportClientError';
  }
}

function parseChunkRequest(value: unknown): WxrCoreImportChunkRequest {
  const parsed = wxrCoreImportChunkRequestSchema.safeParse(value);
  if (!parsed.success) throw new WxrImportClientError('ROW_TOO_LARGE');
  return parsed.data;
}

function requestSize(phase: WxrImportPhase, rows: readonly unknown[]): number {
  return encoder.encode(JSON.stringify({ phase, rows })).byteLength;
}

function chunkPhase(
  phase: WxrImportPhase,
  rows: readonly unknown[],
): WxrCoreImportChunkRequest[] {
  const chunks: WxrCoreImportChunkRequest[] = [];
  let current: unknown[] = [];
  const maximumRows = phase === 'posts'
    ? WXR_IMPORT_POST_CHUNK_MAX_ROWS
    : phase === 'menus'
      ? WXR_IMPORT_MENU_CHUNK_MAX_ROWS
      : phase === 'comments'
        ? WXR_IMPORT_COMMENT_CHUNK_MAX_ROWS
        : WXR_IMPORT_CHUNK_MAX_ROWS;

  for (const row of rows) {
    const candidate = [...current, row];
    const exceedsRowLimit = candidate.length > maximumRows;
    const exceedsByteTarget = requestSize(phase, candidate)
      > WXR_IMPORT_CLIENT_CHUNK_TARGET_BYTES;
    if (current.length > 0 && (exceedsRowLimit || exceedsByteTarget)) {
      chunks.push(parseChunkRequest({ phase, rows: current }));
      current = [row];
    } else {
      current = candidate;
    }
    if (
      current.length === 1
      && requestSize(phase, current) > WXR_IMPORT_CLIENT_CHUNK_TARGET_BYTES
    ) {
      // A single valid content row may exceed the preferred transport target.
      // The Worker applies the separate 8 MiB hard limit.
      parseChunkRequest({ phase, rows: current });
    }
  }
  if (current.length > 0) {
    chunks.push(parseChunkRequest({ phase, rows: current }));
  }
  return chunks;
}

export function createWxrCoreImportChunks(
  plan: WxrCoreImportPlan,
): WxrCoreImportChunkRequest[] {
  const phases: WxrImportPhase[] = [
    'authors',
    'categories',
    'tags',
    'media',
    'posts',
    'pages',
    'menus',
    'comments',
  ];
  return phases.flatMap((phase) => chunkPhase(phase, plan.rows[phase]));
}

export async function requestWxrCoreImportChunk(input: {
  csrfToken: string;
  request: WxrCoreImportChunkRequest;
  signal?: AbortSignal;
}): Promise<WxrCoreImportChunkResponse> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    WXR_IMPORT_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await studioFetch('/api/imports/wxr/core/chunk', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-ZeroPress-CSRF': input.csrfToken,
      },
      body: JSON.stringify(input.request),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new WxrImportClientError('INVALID_RESPONSE');
    }
    const parsed = wxrCoreImportChunkResponseSchema.safeParse(raw);
    if (!parsed.success) throw new WxrImportClientError('INVALID_RESPONSE');
    return parsed.data;
  } catch (error) {
    if (error instanceof WxrImportClientError) throw error;
    if (controller.signal.aborted) throw new WxrImportClientError('TIMEOUT');
    throw new WxrImportClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function requestWxrImportSettingsFinalize(input: {
  csrfToken: string;
  request: WxrImportSettingsFinalizeRequest;
  signal?: AbortSignal;
}): Promise<WxrImportSettingsFinalizeResponse> {
  const request = wxrImportSettingsFinalizeRequestSchema.safeParse(input.request);
  if (!request.success) throw new WxrImportClientError('INVALID_RESPONSE');
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    WXR_IMPORT_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await studioFetch('/api/imports/wxr/settings/finalize', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-ZeroPress-CSRF': input.csrfToken,
      },
      body: JSON.stringify(request.data),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new WxrImportClientError('INVALID_RESPONSE');
    }
    const parsed = wxrImportSettingsFinalizeResponseSchema.safeParse(raw);
    if (!parsed.success) throw new WxrImportClientError('INVALID_RESPONSE');
    return parsed.data;
  } catch (error) {
    if (error instanceof WxrImportClientError) throw error;
    if (controller.signal.aborted) throw new WxrImportClientError('TIMEOUT');
    throw new WxrImportClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}
import { studioFetch } from './studio-fetch';

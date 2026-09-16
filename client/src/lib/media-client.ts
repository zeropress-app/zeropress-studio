import {
  generateAiImageResponseSchema,
  type GenerateAiImageRequest,
  type GenerateAiImageResponse,
} from '../../../contracts/ai-image';
import {
  bulkMediaOperationResponseSchema,
  bulkMoveMediaResponseSchema,
  mediaCollectionDeleteResponseSchema,
  mediaCollectionListResponseSchema,
  mediaCollectionMutationResponseSchema,
  mediaDeleteResponseSchema,
  mediaInformationResponseSchema,
  mediaListResponseSchema,
  mediaMutationResponseSchema,
  mediaReferenceListResponseSchema,
  type BulkMediaOperationRequest,
  type BulkMediaOperationResponse,
  type BulkMoveMediaRequest,
  type BulkMoveMediaResponse,
  type CreateMediaCollectionRequest,
  type CreateMediaRequest,
  type MediaCollectionDeleteResponse,
  type MediaCollectionListResponse,
  type MediaCollectionMutationResponse,
  type MediaDeleteResponse,
  type MediaListQuery,
  type MediaListResponse,
  type MediaInformationResponse,
  type MediaMutationResponse,
  type MediaReferenceListQuery,
  type MediaReferenceListResponse,
  type UpdateMediaCollectionRequest,
  type UpdateMediaRequest,
} from '../../../contracts/media';
import {
  managedMediaUploadCancelResponseSchema,
  managedMediaUploadIntentResponseSchema,
  managedMediaUploadPolicyResponseSchema,
  managedMediaUploadResponseSchema,
  type CreateManagedMediaUploadRequest,
  type ManagedMediaUploadCancelResponse,
  type ManagedMediaUploadIntentResponse,
  type ManagedMediaUploadPolicyResponse,
  type ManagedMediaUploadResponse,
} from '../../../contracts/media-upload';
import { apiErrorSchema, type ApiErrorCode } from '../../../contracts/api';

const MEDIA_TIMEOUT_MS = 15_000;
const AI_IMAGE_TIMEOUT_MS = 105_000;

export type MediaClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE';

export class MediaClientError extends Error {
  constructor(public readonly code: MediaClientErrorCode) {
    super(code);
    this.name = 'MediaClientError';
  }
}

async function mediaFetch<T>(input: {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  parse: (value: unknown) => T;
}): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? MEDIA_TIMEOUT_MS,
  );
  const abortFromCaller = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const response = await studioFetch(input.path, {
      method: input.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(input.csrfToken ? { 'X-ZeroPress-CSRF': input.csrfToken } : {}),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new MediaClientError('INVALID_RESPONSE');
    }
    return input.parse(raw);
  } catch (error) {
    if (error instanceof MediaClientError) throw error;
    if (controller.signal.aborted) throw new MediaClientError('TIMEOUT');
    throw new MediaClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    input.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function requestGenerateAiImage(
  csrfToken: string,
  request: GenerateAiImageRequest,
  signal?: AbortSignal,
): Promise<GenerateAiImageResponse> {
  return mediaFetch({
    path: '/api/media/ai/images',
    method: 'POST',
    body: request,
    csrfToken,
    signal,
    timeoutMs: AI_IMAGE_TIMEOUT_MS,
    parse: parseWith(generateAiImageResponseSchema),
  });
}

function parseWith<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }) {
  return (value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new MediaClientError('INVALID_RESPONSE');
    return parsed.data;
  };
}

export function requestMediaList(
  query: MediaListQuery,
  signal?: AbortSignal,
): Promise<MediaListResponse> {
  const params = new URLSearchParams({
    search: query.search,
    kind: query.kind,
    purpose: query.purpose,
    collection: query.collection,
    page: String(query.page),
    per_page: String(query.per_page),
  });
  return mediaFetch({
    path: `/api/media?${params}`,
    signal,
    parse: parseWith(mediaListResponseSchema),
  });
}

export function requestMediaReferences(
  id: string,
  query: MediaReferenceListQuery,
  signal?: AbortSignal,
): Promise<MediaReferenceListResponse> {
  const params = new URLSearchParams({
    page: String(query.page),
    per_page: String(query.per_page),
  });
  return mediaFetch({
    path: `/api/media/${encodeURIComponent(id)}/references?${params}`,
    signal,
    parse: parseWith(mediaReferenceListResponseSchema),
  });
}

export function requestMediaInformation(
  id: string,
  query: MediaReferenceListQuery,
  signal?: AbortSignal,
): Promise<MediaInformationResponse> {
  const params = new URLSearchParams({
    page: String(query.page),
    per_page: String(query.per_page),
  });
  return mediaFetch({
    path: `/api/media/${encodeURIComponent(id)}/information?${params}`,
    signal,
    parse: parseWith(mediaInformationResponseSchema),
  });
}

export function requestMediaCollections(
  signal?: AbortSignal,
): Promise<MediaCollectionListResponse> {
  return mediaFetch({
    path: '/api/media/collections',
    signal,
    parse: parseWith(mediaCollectionListResponseSchema),
  });
}

export function requestCreateMediaCollection(
  csrfToken: string,
  request: CreateMediaCollectionRequest,
): Promise<MediaCollectionMutationResponse> {
  return mediaFetch({
    path: '/api/media/collections',
    method: 'POST',
    body: request,
    csrfToken,
    parse: parseWith(mediaCollectionMutationResponseSchema),
  });
}

export function requestUpdateMediaCollection(
  csrfToken: string,
  id: string,
  request: UpdateMediaCollectionRequest,
): Promise<MediaCollectionMutationResponse> {
  return mediaFetch({
    path: `/api/media/collections/${encodeURIComponent(id)}`,
    method: 'PUT',
    body: request,
    csrfToken,
    parse: parseWith(mediaCollectionMutationResponseSchema),
  });
}

export function requestDeleteMediaCollection(
  csrfToken: string,
  id: string,
  expectedRevision: string,
): Promise<MediaCollectionDeleteResponse> {
  return mediaFetch({
    path: `/api/media/collections/${encodeURIComponent(id)}`,
    method: 'DELETE',
    body: { expected_revision: expectedRevision },
    csrfToken,
    parse: parseWith(mediaCollectionDeleteResponseSchema),
  });
}

export function requestBulkMoveMedia(
  csrfToken: string,
  request: BulkMoveMediaRequest,
): Promise<BulkMoveMediaResponse> {
  return mediaFetch({
    path: '/api/media/collection-moves',
    method: 'POST',
    body: request,
    csrfToken,
    parse: parseWith(bulkMoveMediaResponseSchema),
  });
}

export function requestBulkMediaOperation(
  csrfToken: string,
  request: BulkMediaOperationRequest,
): Promise<BulkMediaOperationResponse> {
  return mediaFetch({
    path: '/api/media/bulk-operations',
    method: 'POST',
    body: request,
    csrfToken,
    parse: parseWith(bulkMediaOperationResponseSchema),
  });
}

export function requestManagedMediaUploadPolicy(
  signal?: AbortSignal,
): Promise<ManagedMediaUploadPolicyResponse> {
  return mediaFetch({
    path: '/api/media/uploads/policy',
    signal,
    parse: parseWith(managedMediaUploadPolicyResponseSchema),
  });
}

export function requestCreateManagedMediaUploadIntent(
  csrfToken: string,
  request: CreateManagedMediaUploadRequest,
  signal?: AbortSignal,
): Promise<ManagedMediaUploadIntentResponse> {
  return mediaFetch({
    path: '/api/media/uploads',
    method: 'POST',
    body: request,
    csrfToken,
    signal,
    parse: parseWith(managedMediaUploadIntentResponseSchema),
  });
}

export function requestCancelManagedMediaUploadIntent(
  csrfToken: string,
  uploadId: string,
): Promise<ManagedMediaUploadCancelResponse> {
  return mediaFetch({
    path: `/api/media/uploads/${encodeURIComponent(uploadId)}`,
    method: 'DELETE',
    csrfToken,
    parse: parseWith(managedMediaUploadCancelResponseSchema),
  });
}

export function uploadManagedMediaFile(input: {
  csrfToken: string;
  uploadId: string;
  file: File;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}): Promise<ManagedMediaUploadResponse> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      request.abort();
      finish(() => reject(new DOMException('Upload aborted.', 'AbortError')));
    };
    request.open(
      'PUT',
      `/api/media/uploads/${encodeURIComponent(input.uploadId)}`,
    );
    request.withCredentials = true;
    request.timeout = 5 * 60 * 1_000;
    request.setRequestHeader('Accept', 'application/json');
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-ZeroPress-CSRF', input.csrfToken);
    request.upload.addEventListener('progress', (event) => {
      input.onProgress?.(
        event.loaded,
        event.lengthComputable ? event.total : input.file.size,
      );
    });
    request.addEventListener('load', () => {
      finish(() => {
        let raw: unknown;
        try {
          raw = JSON.parse(request.responseText) as unknown;
        } catch {
          reject(new MediaClientError('INVALID_RESPONSE'));
          return;
        }
        const parsed = managedMediaUploadResponseSchema.safeParse(raw);
        if (!parsed.success) {
          reject(new MediaClientError('INVALID_RESPONSE'));
          return;
        }
        resolve(parsed.data);
      });
    });
    request.addEventListener('error', () => {
      finish(() => reject(new MediaClientError('NETWORK_ERROR')));
    });
    request.addEventListener('timeout', () => {
      finish(() => reject(new MediaClientError('TIMEOUT')));
    });
    request.addEventListener('abort', () => {
      finish(() => reject(new DOMException('Upload aborted.', 'AbortError')));
    });
    if (input.signal?.aborted) {
      abort();
      return;
    }
    input.signal?.addEventListener('abort', abort, { once: true });
    request.send(input.file);
  });
}

export function requestCreateMedia(
  csrfToken: string,
  request: CreateMediaRequest,
): Promise<MediaMutationResponse> {
  return mediaFetch({
    path: '/api/media',
    method: 'POST',
    body: request,
    csrfToken,
    parse: parseWith(mediaMutationResponseSchema),
  });
}

export function requestUpdateMedia(
  csrfToken: string,
  id: string,
  request: UpdateMediaRequest,
): Promise<MediaMutationResponse> {
  return mediaFetch({
    path: `/api/media/${encodeURIComponent(id)}`,
    method: 'PUT',
    body: request,
    csrfToken,
    parse: parseWith(mediaMutationResponseSchema),
  });
}

export function requestDeleteMedia(
  csrfToken: string,
  id: string,
  expectedRevision: string,
): Promise<MediaDeleteResponse> {
  return mediaFetch({
    path: `/api/media/${encodeURIComponent(id)}`,
    method: 'DELETE',
    body: { expected_revision: expectedRevision },
    csrfToken,
    parse: parseWith(mediaDeleteResponseSchema),
  });
}

export class MediaImageEditorSourceError extends Error {
  constructor(public readonly code: ApiErrorCode | MediaClientErrorCode) {
    super(code);
    this.name = 'MediaImageEditorSourceError';
  }
}

export async function requestMediaImageEditorSource(
  id: string,
  revision: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 30_000);
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    const params = new URLSearchParams({ revision });
    const response = await studioFetch(
      `/api/media/${encodeURIComponent(id)}/editor-source?${params}`,
      {
        credentials: 'same-origin',
        headers: { Accept: 'image/*, application/json' },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(await response.json().catch(() => null));
      throw new MediaImageEditorSourceError(
        parsed.success ? parsed.data.error.code : 'INVALID_RESPONSE',
      );
    }
    const blob = await response.blob();
    if (!blob.type.startsWith('image/') || blob.size < 1) {
      throw new MediaImageEditorSourceError('INVALID_RESPONSE');
    }
    return blob;
  } catch (error) {
    if (error instanceof MediaImageEditorSourceError) throw error;
    if (controller.signal.aborted) {
      throw new MediaImageEditorSourceError('TIMEOUT');
    }
    throw new MediaImageEditorSourceError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
import { studioFetch } from './studio-fetch';

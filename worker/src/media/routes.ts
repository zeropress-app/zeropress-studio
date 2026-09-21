import { recordAudit, auditBulk, beginAudit } from '../audit/service';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { generateAiImageRequestSchema } from '../../../contracts/ai-image';
import {
  bulkMediaOperationRequestSchema,
  bulkMediaOperationSuccessSchema,
  bulkMoveMediaRequestSchema,
  bulkMoveMediaSuccessSchema,
  createMediaCollectionRequestSchema,
  createMediaRequestSchema,
  deleteMediaCollectionRequestSchema,
  deleteMediaRequestSchema,
  isR2MediaPreviewSafeImage,
  MANAGED_MEDIA_REFERENCE_PREFIX,
  mediaCollectionDeleteSuccessSchema,
  mediaCollectionIdSchema,
  mediaCollectionListSuccessSchema,
  mediaCollectionMutationSuccessSchema,
  mediaDeleteSuccessSchema,
  mediaIdSchema,
  mediaInformationSuccessSchema,
  mediaListQuerySchema,
  mediaListSuccessSchema,
  mediaMutationSuccessSchema,
  mediaReferenceListQuerySchema,
  mediaReferenceListSuccessSchema,
  mediaStorageKeySchema,
  updateMediaCollectionRequestSchema,
  updateMediaRequestSchema,
} from '../../../contracts/media';
import { mediaImageEditorSourceQuerySchema } from '../../../contracts/media-image-editor';
import {
  createManagedMediaUploadRequestSchema,
  managedMediaUploadCancelSuccessSchema,
  managedMediaUploadExtensions,
  managedMediaUploadIntentSuccessSchema,
  managedMediaUploadPolicySuccessSchema,
  MANAGED_MEDIA_UPLOAD_CONCURRENCY,
  MANAGED_MEDIA_UPLOAD_MAX_BYTES,
  MANAGED_MEDIA_SVG_UPLOAD_MAX_BYTES,
  MANAGED_MEDIA_UPLOAD_QUEUE_LIMIT,
} from '../../../contracts/media-upload';
import { readJsonBody } from '../auth/auth-route-utils';
import { requireStudioCapability } from '../auth/authorization';
import {
  hasValidCsrfHeader,
  isSameOriginMutation,
} from '../auth/session-http';
import type { ResolveUserSession } from '../auth/session-repository';
import { errorResponse } from '../lib/http';
import { logOperationalFailure } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  handleAiImageRequest,
  type GenerateAiImage,
} from '../ai/image-route';
import { readMediaSettings } from '../settings/media-settings-repository';
import {
  bulkMutateMedia,
  createMedia,
  deleteMedia,
  getR2MediaReferencePreviewDescriptor,
  getMediaInformation,
  getR2MediaImageEditorSource,
  getR2MediaPreviewDescriptor,
  listMedia,
  listMediaReferences,
  type R2MediaPreviewDescriptor,
  updateMedia,
} from './media-repository';
import {
  bulkMoveMedia,
  createMediaCollection,
  deleteMediaCollection,
  listMediaCollections,
  updateMediaCollection,
} from './media-collection-repository';
import {
  cancelManagedMediaUploadIntent,
  createManagedMediaUploadIntent,
} from './media-upload-repository';
import { storeManagedMediaUpload } from './media-upload-service';
import { deleteQueuedMediaObject } from './media-object-cleanup';

const MEDIA_BODY_LIMIT = 128 * 1024;

export type MediaRouteDependencies = {
  resolveSession?: ResolveUserSession;
  listMedia?: typeof listMedia;
  listReferences?: typeof listMediaReferences;
  getInformation?: typeof getMediaInformation;
  listCollections?: typeof listMediaCollections;
  createCollection?: typeof createMediaCollection;
  updateCollection?: typeof updateMediaCollection;
  deleteCollection?: typeof deleteMediaCollection;
  bulkMove?: typeof bulkMoveMedia;
  bulkMutate?: typeof bulkMutateMedia;
  createMedia?: typeof createMedia;
  updateMedia?: typeof updateMedia;
  deleteMedia?: typeof deleteMedia;
  getPreview?: typeof getR2MediaPreviewDescriptor;
  getImageEditorSource?: typeof getR2MediaImageEditorSource;
  getReferencePreview?: typeof getR2MediaReferencePreviewDescriptor;
  readSettings?: typeof readMediaSettings;
  createUploadIntent?: typeof createManagedMediaUploadIntent;
  storeUpload?: typeof storeManagedMediaUpload;
  cancelUploadIntent?: typeof cancelManagedMediaUploadIntent;
  deleteQueuedObject?: typeof deleteQueuedMediaObject;
  generateAiImage?: GenerateAiImage;
  managedUploadsEnabled?: boolean;
  now?: () => Date;
  createId?: () => string;
  createRevision?: () => string;
};

function mutationBodyLimit() {
  return bodyLimit({
    maxSize: MEDIA_BODY_LIMIT,
    onError: (c: Context<StudioHonoEnvironment>) => (
      errorResponse(c, 413, 'PAYLOAD_TOO_LARGE')
    ),
  });
}

function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const comparable = (value: string) => value.trim().replace(/^W\//u, '');
  const expected = comparable(etag);
  return ifNoneMatch.split(',').some((candidate) => {
    const normalized = candidate.trim();
    return normalized === '*' || comparable(normalized) === expected;
  });
}

function resolveManagedStorageAvailability(
  c: Context<StudioHonoEnvironment>,
  managedUploadsEnabled: boolean | undefined,
) {
  if (managedUploadsEnabled === false) {
    return { available: false as const, reason: 'shared_development' as const };
  }
  if (!c.env.MEDIA_BUCKET) {
    return { available: false as const, reason: 'binding_missing' as const };
  }
  return { available: true as const, bucket: c.env.MEDIA_BUCKET };
}

async function streamPrivateR2Preview(input: {
  context: Context<StudioHonoEnvironment>;
  preview: R2MediaPreviewDescriptor;
  availability: ReturnType<typeof resolveManagedStorageAvailability>;
  action?: string;
}): Promise<Response> {
  const { context: c, preview, availability } = input;
  const action = input.action ?? 'read_media_preview_object';
  if (!availability.available) {
    if (availability.reason === 'binding_missing') {
      logOperationalFailure('MEDIA_PREVIEW_R2_BINDING_NOT_CONFIGURED', {
        metadata: {
          resource: 'MEDIA_BUCKET',
          action,
        },
      });
    }
    return errorResponse(c, 503, 'MEDIA_PREVIEW_NOT_AVAILABLE');
  }

  let object: R2ObjectBody | null;
  try {
    object = await availability.bucket.get(preview.storageKey);
  } catch (error) {
    logOperationalFailure('MEDIA_PREVIEW_R2_READ_FAILED', {
      cause: error,
      metadata: {
        resource: 'MEDIA_BUCKET',
        action,
      },
    });
    return errorResponse(c, 503, 'MEDIA_PREVIEW_NOT_AVAILABLE');
  }
  if (!object) return errorResponse(c, 404, 'MEDIA_PREVIEW_NOT_FOUND');

  const headers = new Headers({
    'Cache-Control': 'private, max-age=300',
    'Content-Disposition': 'inline',
    'Content-Type': preview.mimeType,
    'Cross-Origin-Resource-Policy': 'same-origin',
    ETag: object.httpEtag,
    'Last-Modified': object.uploaded.toUTCString(),
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff',
  });
  if (preview.mimeType === 'image/svg+xml') {
    headers.set(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  }
  if (etagMatches(c.req.header('If-None-Match'), object.httpEtag)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

function managedReferenceStorageKey(requestUrl: string): string | null {
  const pathname = new URL(requestUrl).pathname;
  if (!pathname.startsWith(MANAGED_MEDIA_REFERENCE_PREFIX)) return null;
  const parsed = mediaStorageKeySchema.safeParse(
    pathname.slice(MANAGED_MEDIA_REFERENCE_PREFIX.length),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Authenticated Studio rendering for the stable reference stored in authored
 * content. Preview Data materialization remains a separate public contract.
 */
export function createManagedMediaReferenceRoutes(
  dependencies: MediaRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const getPreview = dependencies.getReferencePreview
    ?? getR2MediaReferencePreviewDescriptor;
  const readSettings = dependencies.readSettings ?? readMediaSettings;

  routes.get('/*', async (c) => {
    const storageKey = managedReferenceStorageKey(c.req.url);
    if (!storageKey) return errorResponse(c, 404, 'MEDIA_PREVIEW_NOT_FOUND');
    const session = await requireStudioCapability({
      context: c,
      capability: 'media.read',
      resolveSession: dependencies.resolveSession,
    });
    if (session instanceof Response) return session;

    const [settings, preview] = await Promise.all([
      readSettings({ db: c.env.DB }),
      getPreview({ db: c.env.DB, storageKey }),
    ]);
    if (!preview) return errorResponse(c, 404, 'MEDIA_PREVIEW_NOT_FOUND');

    const mediaOrigin = settings.settings.media_origin;
    if (mediaOrigin !== '') {
      c.header('Cache-Control', 'private, no-store');
      c.header('Vary', 'Cookie');
      return c.redirect(`${mediaOrigin}/${preview.storageKey}`, 302);
    }
    if (!isR2MediaPreviewSafeImage(
      preview.mimeType,
      preview.storageKey,
    )) {
      return errorResponse(c, 404, 'MEDIA_PREVIEW_NOT_FOUND');
    }
    return streamPrivateR2Preview({
      context: c,
      preview,
      availability: resolveManagedStorageAvailability(
        c,
        dependencies.managedUploadsEnabled,
      ),
    });
  });

  return routes;
}

export function createMediaRoutes(
  dependencies: MediaRouteDependencies = {},
) {
  const routes = new Hono<StudioHonoEnvironment>();
  const list = dependencies.listMedia ?? listMedia;
  const listReferences = dependencies.listReferences ?? listMediaReferences;
  const getInformation = dependencies.getInformation ?? getMediaInformation;
  const listCollections = dependencies.listCollections ?? listMediaCollections;
  const createCollection = dependencies.createCollection
    ?? createMediaCollection;
  const updateCollection = dependencies.updateCollection
    ?? updateMediaCollection;
  const removeCollection = dependencies.deleteCollection
    ?? deleteMediaCollection;
  const moveMedia = dependencies.bulkMove ?? bulkMoveMedia;
  const mutateMedia = dependencies.bulkMutate ?? bulkMutateMedia;
  const create = dependencies.createMedia ?? createMedia;
  const update = dependencies.updateMedia ?? updateMedia;
  const remove = dependencies.deleteMedia ?? deleteMedia;
  const getPreview = dependencies.getPreview ?? getR2MediaPreviewDescriptor;
  const getImageEditorSource = dependencies.getImageEditorSource
    ?? getR2MediaImageEditorSource;
  const readSettings = dependencies.readSettings ?? readMediaSettings;
  const createUploadIntent = dependencies.createUploadIntent
    ?? createManagedMediaUploadIntent;
  const storeUpload = dependencies.storeUpload ?? storeManagedMediaUpload;
  const cancelUploadIntent = dependencies.cancelUploadIntent
    ?? cancelManagedMediaUploadIntent;
  const removeQueuedObject = dependencies.deleteQueuedObject
    ?? deleteQueuedMediaObject;
  const currentTime = dependencies.now ?? (() => new Date());

  function requireMediaManager(c: Context<StudioHonoEnvironment>) {
    return requireStudioCapability({
      context: c,
      capability: 'media.manage',
      resolveSession: dependencies.resolveSession,
    });
  }

  function requireMediaReader(c: Context<StudioHonoEnvironment>) {
    return requireStudioCapability({
      context: c,
      capability: 'media.read',
      resolveSession: dependencies.resolveSession,
    });
  }

  async function authorizeMutation(c: Context<StudioHonoEnvironment>) {
    c.header('Vary', 'Origin, Sec-Fetch-Site');
    if (!isSameOriginMutation(c)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    const session = await requireMediaManager(c);
    if (session instanceof Response) return session;
    if (!hasValidCsrfHeader(c, session.csrfToken)) {
      return errorResponse(c, 403, 'CSRF_VALIDATION_FAILED');
    }
    return session;
  }

  function managedStorageAvailability(c: Context<StudioHonoEnvironment>) {
    return resolveManagedStorageAvailability(
      c,
      dependencies.managedUploadsEnabled,
    );
  }

  function uploadUnavailableResponse(
    c: Context<StudioHonoEnvironment>,
    availability: ReturnType<typeof managedStorageAvailability>,
  ) {
    if (!availability.available && availability.reason === 'binding_missing') {
      logOperationalFailure('MEDIA_UPLOAD_R2_BINDING_NOT_CONFIGURED', {
        metadata: {
          resource: 'MEDIA_BUCKET',
          action: 'access_managed_media_storage',
        },
      });
    }
    return errorResponse(c, 503, 'MEDIA_UPLOAD_NOT_AVAILABLE');
  }

  routes.get('/', async (c) => {
    const parsed = mediaListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requireMediaReader(c);
    if (session instanceof Response) return session;
    const [result, settings] = await Promise.all([
      list({ db: c.env.DB, query: parsed.data }),
      readSettings({ db: c.env.DB }),
    ]);
    const availability = managedStorageAvailability(c);
    return c.json(mediaListSuccessSchema.parse({
      success: true,
      data: {
        ...result,
        delivery: {
          media_origin: settings.settings.media_origin,
          r2_preview_available: availability.available,
        },
      },
    }));
  });

  routes.get('/collections', async (c) => {
    const session = await requireMediaReader(c);
    if (session instanceof Response) return session;
    const catalog = await listCollections({ db: c.env.DB });
    return c.json(mediaCollectionListSuccessSchema.parse({
      success: true,
      data: catalog,
    }));
  });

  routes.post('/collections', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = createMediaCollectionRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await createCollection({
      db: c.env.DB,
      authored: parsed.data,
      now: currentTime(),
      createId: dependencies.createId,
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'name_conflict') {
      return errorResponse(c, 409, 'MEDIA_COLLECTION_NAME_CONFLICT');
    }
    if (result.kind === 'limit_reached') {
      return errorResponse(c, 409, 'MEDIA_COLLECTION_LIMIT_REACHED');
    }
    return c.json(mediaCollectionMutationSuccessSchema.parse({
      success: true,
      data: result.collection,
    }), 201);
  });

  routes.put('/collections/:id', mutationBodyLimit(), async (c) => {
    const id = mediaCollectionIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateMediaCollectionRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await updateCollection({
      db: c.env.DB,
      id: id.data,
      authored: parsed.data,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'MEDIA_COLLECTION_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'MEDIA_COLLECTION_REVISION_CONFLICT');
    }
    if (result.kind === 'name_conflict') {
      return errorResponse(c, 409, 'MEDIA_COLLECTION_NAME_CONFLICT');
    }
    return c.json(mediaCollectionMutationSuccessSchema.parse({
      success: true,
      data: result.collection,
    }));
  });

  routes.delete('/collections/:id', mutationBodyLimit(), async (c) => {
    const id = mediaCollectionIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = deleteMediaCollectionRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await removeCollection({
      db: c.env.DB,
      id: id.data,
      expectedRevision: parsed.data.expected_revision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'MEDIA_COLLECTION_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'MEDIA_COLLECTION_REVISION_CONFLICT');
    }
    if (result.kind === 'not_empty') {
      return errorResponse(c, 409, 'MEDIA_COLLECTION_NOT_EMPTY');
    }
    return c.json(mediaCollectionDeleteSuccessSchema.parse({
      success: true,
      data: { status: 'media_collection_deleted', id: id.data },
    }));
  });

  routes.post('/collection-moves', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = bulkMoveMediaRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await moveMedia({
      db: c.env.DB,
      authored: parsed.data,
      now: currentTime(),
    });
    if (result.kind === 'collection_not_found') {
      return errorResponse(c, 404, 'MEDIA_COLLECTION_NOT_FOUND');
    }
    if (result.kind === 'conflict') {
      return errorResponse(c, 409, 'MEDIA_BULK_MOVE_CONFLICT');
    }
    return c.json(bulkMoveMediaSuccessSchema.parse({
      success: true,
      data: {
        status: 'media_moved',
        target_collection_id: parsed.data.target_collection_id,
        moved_count: result.movedCount,
        unchanged_count: result.unchangedCount,
      },
    }));
  });

  routes.post('/bulk-operations', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = bulkMediaOperationRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const availability = managedStorageAvailability(c);
    if (parsed.data.operation === 'delete') {
      beginAudit(c, { action: 'media_delete', target: { type: 'media' } });
    }
    const result = await mutateMedia({
      db: c.env.DB,
      request: parsed.data,
      allowR2ObjectDeletion: availability.available,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (parsed.data.operation === 'delete') auditBulk(c, 'media', result.summary);
    if (availability.available && result.cleanupKeys.length > 0) {
      c.executionCtx.waitUntil(Promise.all(result.cleanupKeys.map((storageKey) => (
        removeQueuedObject({
          db: c.env.DB,
          bucket: availability.bucket,
          storageKey,
          now: currentTime(),
        })
      ))).then(() => undefined));
    }
    const { cleanupKeys: _cleanupKeys, ...data } = result;
    return c.json(bulkMediaOperationSuccessSchema.parse({
      success: true,
      data,
    }));
  });

  routes.get('/uploads/policy', async (c) => {
    const session = await requireMediaManager(c);
    if (session instanceof Response) return session;
    const availability = managedStorageAvailability(c);
    return c.json(managedMediaUploadPolicySuccessSchema.parse({
      success: true,
      data: {
        available: availability.available,
        unavailable_reason: availability.available ? null : availability.reason,
        max_bytes: MANAGED_MEDIA_UPLOAD_MAX_BYTES,
        max_svg_bytes: MANAGED_MEDIA_SVG_UPLOAD_MAX_BYTES,
        max_files: MANAGED_MEDIA_UPLOAD_QUEUE_LIMIT,
        concurrency: MANAGED_MEDIA_UPLOAD_CONCURRENCY,
        accepted_extensions: managedMediaUploadExtensions,
      },
    }));
  });

  routes.post('/ai/images', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = generateAiImageRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const availability = managedStorageAvailability(c);
    if (!availability.available) {
      return uploadUnavailableResponse(c, availability);
    }
    return handleAiImageRequest({
      context: c,
      request: parsed.data,
      userId: session.user.id,
      bucket: availability.bucket,
      now: currentTime(),
      generate: dependencies.generateAiImage,
      createUploadIntent,
      storeUpload,
      createId: dependencies.createId,
      createRevision: dependencies.createRevision,
    });
  });

  routes.get('/:id/references', async (c) => {
    const id = mediaIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const query = mediaReferenceListQuerySchema.safeParse(c.req.query());
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requireMediaManager(c);
    if (session instanceof Response) return session;
    const result = await listReferences({
      db: c.env.DB,
      id: id.data,
      query: query.data,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'MEDIA_NOT_FOUND');
    }
    return c.json(mediaReferenceListSuccessSchema.parse({
      success: true,
      data: {
        media_id: id.data,
        items: result.items,
        pagination: result.pagination,
      },
    }));
  });

  routes.get('/:id/information', async (c) => {
    const id = mediaIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const query = mediaReferenceListQuerySchema.safeParse(c.req.query());
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requireMediaManager(c);
    if (session instanceof Response) return session;
    const result = await getInformation({
      db: c.env.DB,
      id: id.data,
      query: query.data,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'MEDIA_NOT_FOUND');
    }
    return c.json(mediaInformationSuccessSchema.parse({
      success: true,
      data: {
        media_id: id.data,
        generation: result.generation,
        references: {
          items: result.items,
          pagination: result.pagination,
        },
      },
    }));
  });

  routes.get('/:id/preview', async (c) => {
    const id = mediaIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requireMediaReader(c);
    if (session instanceof Response) return session;

    const settings = await readSettings({ db: c.env.DB });
    if (settings.settings.media_origin !== '') {
      return errorResponse(c, 404, 'MEDIA_PREVIEW_NOT_FOUND');
    }
    const preview = await getPreview({ db: c.env.DB, id: id.data });
    if (!preview) {
      return errorResponse(c, 404, 'MEDIA_PREVIEW_NOT_FOUND');
    }
    return streamPrivateR2Preview({
      context: c,
      preview,
      availability: managedStorageAvailability(c),
    });
  });

  routes.get('/:id/editor-source', async (c) => {
    const id = mediaIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const query = mediaImageEditorSourceQuerySchema.safeParse(c.req.query());
    if (!query.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await requireMediaManager(c);
    if (session instanceof Response) return session;
    const result = await getImageEditorSource({
      db: c.env.DB,
      id: id.data,
      expectedRevision: query.data.revision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'MEDIA_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'MEDIA_REVISION_CONFLICT');
    }
    if (result.kind === 'unsupported') {
      return errorResponse(c, 409, 'MEDIA_IMAGE_EDIT_UNSUPPORTED');
    }
    return streamPrivateR2Preview({
      context: c,
      preview: result.preview,
      availability: managedStorageAvailability(c),
      action: 'read_media_image_editor_source_object',
    });
  });

  routes.post('/uploads', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = createManagedMediaUploadRequestSchema.safeParse(body.value);
    if (!parsed.success) {
      const extensionRejected = parsed.error.issues.some(
        (issue) => issue.path[0] === 'filename',
      );
      return errorResponse(
        c,
        400,
        extensionRejected
          ? 'MEDIA_UPLOAD_TYPE_NOT_ALLOWED'
          : 'VALIDATION_ERROR',
      );
    }
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const availability = managedStorageAvailability(c);
    if (!availability.available) {
      return uploadUnavailableResponse(c, availability);
    }
    const result = await createUploadIntent({
      db: c.env.DB,
      userId: session.user.id,
      authored: parsed.data,
      now: currentTime(),
    });
    if (result.kind === 'limit_reached') {
      return errorResponse(c, 409, 'MEDIA_UPLOAD_LIMIT_REACHED');
    }
    return c.json(managedMediaUploadIntentSuccessSchema.parse({
      success: true,
      data: {
        upload_id: result.intent.id,
        expires_at_iso: result.intent.expiresAtIso,
        file: {
          filename: result.intent.filename,
          kind: result.intent.descriptor.kind,
          mime_type: result.intent.descriptor.mime_type,
          size_bytes: result.intent.sizeBytes,
          width: result.intent.width,
          height: result.intent.height,
          duration_ms: result.intent.durationMs,
          alt: result.intent.alt,
        },
      },
    }), 201);
  });

  routes.put('/uploads/:id', async (c) => {
    const uploadId = mediaIdSchema.safeParse(c.req.param('id'));
    if (!uploadId.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const availability = managedStorageAvailability(c);
    if (!availability.available) {
      return uploadUnavailableResponse(c, availability);
    }
    const contentType = c.req.header('Content-Type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/octet-stream') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    const rawLength = c.req.header('Content-Length');
    if (!rawLength || !/^[1-9][0-9]*$/u.test(rawLength)) {
      return errorResponse(c, 400, 'MEDIA_UPLOAD_SIZE_MISMATCH');
    }
    const contentLength = Number(rawLength);
    if (
      !Number.isSafeInteger(contentLength)
      || contentLength > MANAGED_MEDIA_UPLOAD_MAX_BYTES
    ) return errorResponse(c, 413, 'PAYLOAD_TOO_LARGE');
    const requestBody = c.req.raw.body;
    if (!requestBody) {
      return errorResponse(c, 400, 'MEDIA_UPLOAD_SIZE_MISMATCH');
    }
    const result = await storeUpload({
      db: c.env.DB,
      bucket: availability.bucket,
      uploadId: uploadId.data,
      userId: session.user.id,
      body: requestBody,
      contentLength,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'intent_not_found') {
      return errorResponse(c, 404, 'MEDIA_UPLOAD_INTENT_NOT_FOUND');
    }
    if (result.kind === 'intent_expired') {
      return errorResponse(c, 410, 'MEDIA_UPLOAD_INTENT_EXPIRED');
    }
    if (result.kind === 'size_mismatch') {
      return errorResponse(c, 400, 'MEDIA_UPLOAD_SIZE_MISMATCH');
    }
    if (result.kind === 'signature_invalid') {
      return errorResponse(c, 400, 'MEDIA_UPLOAD_SIGNATURE_INVALID');
    }
    if (result.kind === 'svg_sanitization_failed') {
      return errorResponse(c, 400, 'MEDIA_UPLOAD_SVG_SANITIZATION_FAILED');
    }
    if (result.kind === 'source_conflict') {
      return errorResponse(c, 409, 'MEDIA_SOURCE_CONFLICT');
    }
    return c.json(mediaMutationSuccessSchema.parse({
      success: true,
      data: result.media,
    }), 201);
  });

  routes.delete('/uploads/:id', async (c) => {
    const uploadId = mediaIdSchema.safeParse(c.req.param('id'));
    if (!uploadId.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const removed = await cancelUploadIntent({
      db: c.env.DB,
      id: uploadId.data,
      userId: session.user.id,
      now: currentTime(),
    });
    if (!removed) {
      return errorResponse(c, 404, 'MEDIA_UPLOAD_INTENT_NOT_FOUND');
    }
    return c.json(managedMediaUploadCancelSuccessSchema.parse({
      success: true,
      data: { status: 'upload_cancelled', upload_id: uploadId.data },
    }));
  });

  routes.post('/', mutationBodyLimit(), async (c) => {
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = createMediaRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await create({
      db: c.env.DB,
      authored: parsed.data,
      now: currentTime(),
      createId: dependencies.createId,
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'source_conflict') {
      return errorResponse(c, 409, 'MEDIA_SOURCE_CONFLICT');
    }
    return c.json(mediaMutationSuccessSchema.parse({
      success: true,
      data: result.media,
    }), 201);
  });

  routes.put('/:id', mutationBodyLimit(), async (c) => {
    const id = mediaIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = updateMediaRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    const result = await update({
      db: c.env.DB,
      id: id.data,
      authored: parsed.data,
      now: currentTime(),
      createRevision: dependencies.createRevision,
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'MEDIA_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'MEDIA_REVISION_CONFLICT');
    }
    if (result.kind === 'source_conflict') {
      return errorResponse(c, 409, 'MEDIA_SOURCE_CONFLICT');
    }
    if (result.kind === 'in_use') {
      return errorResponse(c, 409, 'MEDIA_IN_USE');
    }
    if (result.kind === 'managed_file_immutable') {
      return errorResponse(c, 409, 'MEDIA_MANAGED_FILE_IMMUTABLE');
    }
    return c.json(mediaMutationSuccessSchema.parse({
      success: true,
      data: result.media,
    }));
  });

  routes.delete('/:id', mutationBodyLimit(), async (c) => {
    const id = mediaIdSchema.safeParse(c.req.param('id'));
    if (!id.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const body = await readJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = deleteMediaRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const session = await authorizeMutation(c);
    if (session instanceof Response) return session;
    beginAudit(c, { action: 'media_delete', target: { type: 'media', id: id.data } });
    const result = await remove({
      db: c.env.DB,
      id: id.data,
      expectedRevision: parsed.data.expected_revision,
      allowR2ObjectDeletion: managedStorageAvailability(c).available,
      now: currentTime(),
    });
    if (result.kind === 'not_found') {
      return errorResponse(c, 404, 'MEDIA_NOT_FOUND');
    }
    if (result.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'MEDIA_REVISION_CONFLICT');
    }
    if (result.kind === 'in_use') {
      return errorResponse(c, 409, 'MEDIA_IN_USE');
    }
    if (result.kind === 'managed_object_unavailable') {
      return uploadUnavailableResponse(c, managedStorageAvailability(c));
    }
    let objectCleanup: 'not_applicable' | 'completed' | 'pending' =
      'not_applicable';
    if (result.cleanupKey) {
      const availability = managedStorageAvailability(c);
      if (!availability.available) {
        return uploadUnavailableResponse(c, availability);
      }
      objectCleanup = await removeQueuedObject({
        db: c.env.DB,
        bucket: availability.bucket,
        storageKey: result.cleanupKey,
        now: currentTime(),
      });
    }
    recordAudit(c, { action: 'media_delete', target: { type: 'media', id: id.data, label: result.filename },
      outcome: objectCleanup === 'pending' ? 'partial' : 'success', metadata: { deleted: 1 } });
    return c.json(mediaDeleteSuccessSchema.parse({
      success: true,
      data: {
        status: 'media_deleted',
        id: id.data,
        object_cleanup: objectCleanup,
      },
    }));
  });

  return routes;
}

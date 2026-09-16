import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import {
  createManagedMediaReferenceRoutes,
  createMediaRoutes,
} from './routes';
import { AiImageProviderError } from '../ai/image-service';
import { OPERATIONAL_LOG_DEFINITIONS } from '../lib/operational-error';

afterEach(() => {
  vi.restoreAllMocks();
});

const NOW = new Date('2026-08-02T06:00:00.000Z');
const USER_ID = '1'.repeat(32);
const MEDIA_ID = '2'.repeat(32);
const REVISION = '3'.repeat(32);
const COLLECTION_ID = '6'.repeat(32);
const COLLECTION_REVISION = '7'.repeat(32);
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const editorSession = {
  user: {
    id: USER_ID,
    email: 'editor@example.com',
    name: 'Editor',
    roles: ['editor'],
  },
  session: { id: '4'.repeat(32) },
  csrfToken: CSRF_TOKEN,
  authRevision: '5'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;

const media = {
  id: MEDIA_ID,
  kind: 'image' as const,
  filename: 'hero.jpg',
  mime_type: 'image/jpeg',
  location: { type: 'external' as const, url: 'https://media.example/uploads/hero.jpg' },
  size_bytes: null,
  width: 1600,
  height: 900,
  duration_ms: null,
  alt: 'Hero',
  collection: null,
  usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
  revision: REVISION,
  created_at_iso: NOW.toISOString(),
  updated_at_iso: NOW.toISOString(),
};

const collection = {
  id: COLLECTION_ID,
  name: 'Photography',
  media_count: 1,
  revision: COLLECTION_REVISION,
  created_at_iso: NOW.toISOString(),
  updated_at_iso: NOW.toISOString(),
};

const authored = {
  kind: 'image' as const,
  filename: 'hero.jpg',
  mime_type: 'image/jpeg',
  location: {
    type: 'external' as const,
    url: 'https://media.example/uploads/hero.jpg',
  },
  size_bytes: null,
  width: 1600,
  height: 900,
  duration_ms: null,
  alt: 'Hero',
};

function env(): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

function envWithBucket(bucket: Partial<R2Bucket> = {}): Env {
  return {
    ...env(),
    MEDIA_BUCKET: bucket as R2Bucket,
  };
}

function mediaSettings(mediaOrigin = '') {
  return {
    settings: {
      media_origin: mediaOrigin,
      media_delivery_mode: 'none' as const,
    },
    revision: '0'.repeat(32),
    updated_at_iso: null,
  };
}

function r2Object(
  bytes: Uint8Array<ArrayBufferLike> = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47,
  ]),
  etag = '"preview-etag"',
): R2ObjectBody {
  return {
    body: new Response(bytes).body!,
    size: bytes.byteLength,
    httpEtag: etag,
    uploaded: NOW,
  } as unknown as R2ObjectBody;
}

function mutationRequest(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`https://studio.local${path}`, {
    method,
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF_TOKEN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('Media routes', () => {
  it('allows Authors to read Media while keeping mutations manager-only', async () => {
    const listMedia = vi.fn().mockResolvedValue({
      items: [media],
      pagination: { page: 1, per_page: 50, total: 1, total_pages: 1 },
    });
    const editorRoutes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listMedia,
      readSettings: vi.fn().mockResolvedValue(mediaSettings(
        'https://media.example',
      )),
    });
    const response = await editorRoutes.fetch(
      new Request('https://studio.local/?search=hero'),
      env(),
    );
    expect(response.status).toBe(200);
    expect(listMedia).toHaveBeenCalledWith({
      db: expect.anything(),
      query: {
        search: 'hero',
        kind: 'all',
        purpose: 'all',
        collection: 'all',
        page: 1,
        per_page: 50,
      },
    });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        delivery: {
          media_origin: 'https://media.example',
          r2_preview_available: false,
        },
      },
    });

    const authorRoutes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...editorSession,
        user: { ...editorSession.user, roles: ['author'] },
      }),
      listMedia,
      readSettings: vi.fn().mockResolvedValue(mediaSettings()),
    });
    expect((await authorRoutes.fetch(
      new Request('https://studio.local/'),
      env(),
    )).status).toBe(200);
    expect((await authorRoutes.fetch(
      mutationRequest('/', 'POST', authored),
      env(),
    )).status).toBe(403);
  });

  it('normalizes authored metadata behind exact same-origin CSRF', async () => {
    const createMedia = vi.fn().mockResolvedValue({ kind: 'completed', media });
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createMedia,
      now: () => NOW,
      createId: () => MEDIA_ID,
      createRevision: () => REVISION,
    });
    const response = await routes.fetch(mutationRequest('/', 'POST', {
      ...authored,
      filename: ' hero.jpg ',
      mime_type: ' IMAGE/JPEG ',
      location: {
        type: 'external',
        url: ' HTTPS://MEDIA.example:443/uploads/hero.jpg ',
      },
      alt: '  Hero  ',
    }), env());
    expect(response.status).toBe(201);
    expect(createMedia).toHaveBeenCalledWith({
      db: expect.anything(),
      authored: {
        ...authored,
      },
      now: NOW,
      createId: expect.any(Function),
      createRevision: expect.any(Function),
    });

    const rejected = await routes.fetch(mutationRequest('/', 'POST', {
      ...authored,
      location: { type: 'external', url: 'https://media.example/other.jpg' },
    }, { Origin: 'https://other.example' }), env());
    expect(rejected.status).toBe(403);
    expect(createMedia).toHaveBeenCalledTimes(1);
  });

  it('lets Media readers inspect collections while keeping collection writes manager-only', async () => {
    const listCollections = vi.fn().mockResolvedValue({
      items: [collection],
      total_media_count: 2,
      unfiled_media_count: 1,
    });
    const authorRoutes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...editorSession,
        user: { ...editorSession.user, roles: ['author'] },
      }),
      listCollections,
    });
    const listed = await authorRoutes.fetch(
      new Request('https://studio.local/collections'),
      env(),
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      success: true,
      data: {
        items: [collection],
        total_media_count: 2,
        unfiled_media_count: 1,
      },
    });
    expect((await authorRoutes.fetch(mutationRequest('/collections', 'POST', {
      name: 'Events',
    }), env())).status).toBe(403);
  });

  it('maps collection lifecycle and atomic bulk-move outcomes', async () => {
    const createCollection = vi.fn()
      .mockResolvedValueOnce({ kind: 'completed', collection })
      .mockResolvedValueOnce({ kind: 'name_conflict' });
    const updateCollection = vi.fn()
      .mockResolvedValueOnce({ kind: 'revision_conflict' })
      .mockResolvedValueOnce({ kind: 'name_conflict' });
    const deleteCollection = vi.fn()
      .mockResolvedValueOnce({ kind: 'not_empty' })
      .mockResolvedValueOnce({ kind: 'completed' });
    const bulkMove = vi.fn()
      .mockResolvedValueOnce({ kind: 'conflict' })
      .mockResolvedValueOnce({
        kind: 'completed',
        movedCount: 1,
        unchangedCount: 1,
      });
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createCollection,
      updateCollection,
      deleteCollection,
      bulkMove,
      now: () => NOW,
      createId: () => COLLECTION_ID,
      createRevision: () => COLLECTION_REVISION,
    });

    const created = await routes.fetch(mutationRequest('/collections', 'POST', {
      name: ' Photography ',
    }), env());
    expect(created.status).toBe(201);
    expect(createCollection).toHaveBeenCalledWith(expect.objectContaining({
      authored: { name: 'Photography' },
    }));
    expect((await routes.fetch(mutationRequest('/collections', 'POST', {
      name: 'Photography',
    }), env())).status).toBe(409);

    const updateBody = {
      name: 'Photography',
      expected_revision: COLLECTION_REVISION,
    };
    expect((await routes.fetch(mutationRequest(
      `/collections/${COLLECTION_ID}`,
      'PUT',
      updateBody,
    ), env())).status).toBe(409);
    const conflict = await routes.fetch(mutationRequest(
      `/collections/${COLLECTION_ID}`,
      'PUT',
      updateBody,
    ), env());
    await expect(conflict.json()).resolves.toEqual({
      success: false,
      error: { code: 'MEDIA_COLLECTION_NAME_CONFLICT' },
    });

    expect((await routes.fetch(mutationRequest(
      `/collections/${COLLECTION_ID}`,
      'DELETE',
      { expected_revision: COLLECTION_REVISION },
    ), env())).status).toBe(409);
    expect((await routes.fetch(mutationRequest(
      `/collections/${COLLECTION_ID}`,
      'DELETE',
      { expected_revision: COLLECTION_REVISION },
    ), env())).status).toBe(200);

    const moveBody = {
      target_collection_id: COLLECTION_ID,
      items: [
        { id: MEDIA_ID, expected_revision: REVISION },
        { id: '8'.repeat(32), expected_revision: '9'.repeat(32) },
      ],
    };
    expect((await routes.fetch(mutationRequest(
      '/collection-moves',
      'POST',
      moveBody,
    ), env())).status).toBe(409);
    const moved = await routes.fetch(mutationRequest(
      '/collection-moves',
      'POST',
      moveBody,
    ), env());
    await expect(moved.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'media_moved',
        target_collection_id: COLLECTION_ID,
        moved_count: 1,
        unchanged_count: 1,
      },
    });
  });

  it('maps source, revision, usage, and missing-resource conflicts', async () => {
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createMedia: vi.fn().mockResolvedValue({ kind: 'source_conflict' }),
      updateMedia: vi.fn().mockResolvedValue({ kind: 'revision_conflict' }),
      deleteMedia: vi.fn()
        .mockResolvedValueOnce({ kind: 'in_use' })
        .mockResolvedValueOnce({ kind: 'not_found' }),
    });
    expect((await routes.fetch(mutationRequest('/', 'POST', {
      ...authored,
    }), env())).status).toBe(409);
    expect((await routes.fetch(mutationRequest(`/${MEDIA_ID}`, 'PUT', {
      ...authored,
      expected_revision: REVISION,
    }), env())).status).toBe(409);

    const inUse = await routes.fetch(mutationRequest(`/${MEDIA_ID}`, 'DELETE', {
      expected_revision: REVISION,
    }), env());
    expect(inUse.status).toBe(409);
    await expect(inUse.json()).resolves.toEqual({
      success: false,
      error: { code: 'MEDIA_IN_USE' },
    });
    expect((await routes.fetch(mutationRequest(`/${MEDIA_ID}`, 'DELETE', {
      expected_revision: REVISION,
    }), env())).status).toBe(404);
  });

  it('authorizes and returns bounded per-row Media bulk outcomes', async () => {
    const bulkMutate = vi.fn().mockResolvedValue({
      operation: 'update_metadata',
      results: [
        { id: MEDIA_ID, outcome: 'updated', revision: '8'.repeat(32) },
      ],
      summary: {
        requested: 1,
        updated: 1,
        unchanged: 0,
        conflict: 0,
        skipped: 0,
        queued_objects: 0,
      },
      cleanupKeys: [],
    });
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      bulkMutate,
      now: () => NOW,
      createRevision: () => '8'.repeat(32),
    });
    const response = await routes.fetch(mutationRequest(
      '/bulk-operations',
      'POST',
      {
        operation: 'update_metadata',
        items: [{
          id: MEDIA_ID,
          expected_revision: REVISION,
          filename: 'renamed.jpg',
          alt: 'Renamed hero',
        }],
      },
    ), env());
    expect(response.status).toBe(200);
    expect(bulkMutate).toHaveBeenCalledWith({
      db: expect.anything(),
      request: {
        operation: 'update_metadata',
        items: [{
          id: MEDIA_ID,
          expected_revision: REVISION,
          filename: 'renamed.jpg',
          alt: 'Renamed hero',
        }],
      },
      allowR2ObjectDeletion: false,
      now: NOW,
      createRevision: expect.any(Function),
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        operation: 'update_metadata',
        results: [
          { id: MEDIA_ID, outcome: 'updated', revision: '8'.repeat(32) },
        ],
        summary: {
          requested: 1,
          updated: 1,
          unchanged: 0,
          conflict: 0,
          skipped: 0,
          queued_objects: 0,
        },
      },
    });

    expect((await routes.fetch(mutationRequest(
      '/bulk-operations',
      'POST',
      {
        operation: 'delete',
        items: [
          { id: MEDIA_ID, expected_revision: REVISION },
          { id: MEDIA_ID, expected_revision: REVISION },
        ],
      },
    ), env())).status).toBe(400);
  });

  it('exposes a manager-only bounded reference list before deletion', async () => {
    const listReferences = vi.fn().mockResolvedValue({
      kind: 'completed',
      items: [{
        type: 'post',
        id: '8'.repeat(32),
        public_id: 100000000001,
        title: 'Referenced Post',
      }],
      pagination: { page: 2, per_page: 20, total: 21, total_pages: 2 },
    });
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listReferences,
    });
    const response = await routes.fetch(new Request(
      `https://studio.local/${MEDIA_ID}/references?page=2&per_page=20`,
    ), env());
    expect(response.status).toBe(200);
    expect(listReferences).toHaveBeenCalledWith({
      db: expect.anything(),
      id: MEDIA_ID,
      query: { page: 2, per_page: 20 },
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        media_id: MEDIA_ID,
        items: [{
          type: 'post',
          id: '8'.repeat(32),
          public_id: 100000000001,
          title: 'Referenced Post',
        }],
        pagination: { page: 2, per_page: 20, total: 21, total_pages: 2 },
      },
    });

    const authorRoutes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...editorSession,
        user: { ...editorSession.user, roles: ['author'] },
      }),
      listReferences,
    });
    expect((await authorRoutes.fetch(new Request(
      `https://studio.local/${MEDIA_ID}/references`,
    ), env())).status).toBe(403);
  });

  it('exposes manager-only AI provenance with the bounded reference list', async () => {
    const generation = {
      version: 1,
      model: '@cf/black-forest-labs/flux-2-klein-4b',
      prompt_version: 'image-v1',
      prompt: 'A quiet library at sunrise',
      aspect_ratio: 'landscape',
      seed: 42,
    } as const;
    const getInformation = vi.fn().mockResolvedValue({
      kind: 'completed',
      generation,
      items: [],
      pagination: { page: 1, per_page: 20, total: 0, total_pages: 0 },
    });
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      getInformation,
    });
    const response = await routes.fetch(new Request(
      `https://studio.local/${MEDIA_ID}/information?page=1&per_page=20`,
    ), env());
    expect(response.status).toBe(200);
    expect(getInformation).toHaveBeenCalledWith({
      db: expect.anything(),
      id: MEDIA_ID,
      query: { page: 1, per_page: 20 },
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        media_id: MEDIA_ID,
        generation,
        references: {
          items: [],
          pagination: { page: 1, per_page: 20, total: 0, total_pages: 0 },
        },
      },
    });

    const authorRoutes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...editorSession,
        user: { ...editorSession.user, roles: ['author'] },
      }),
      getInformation,
    });
    expect((await authorRoutes.fetch(new Request(
      `https://studio.local/${MEDIA_ID}/information`,
    ), env())).status).toBe(403);
  });

  it('reports managed-upload availability and fails closed on a DB/R2 locality mismatch', async () => {
    const available = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
    });
    await expect((await available.fetch(
      new Request('https://studio.local/uploads/policy'),
      envWithBucket(),
    )).json()).resolves.toMatchObject({
      success: true,
      data: {
        available: true,
        unavailable_reason: null,
        max_bytes: 67_108_864,
        max_svg_bytes: 2_097_152,
        max_files: 10,
        concurrency: 2,
      },
    });

    const shared = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      managedUploadsEnabled: false,
    });
    await expect((await shared.fetch(
      new Request('https://studio.local/uploads/policy'),
      envWithBucket(),
    )).json()).resolves.toMatchObject({
      success: true,
      data: {
        available: false,
        unavailable_reason: 'shared_development',
      },
    });
  });

  it('streams an authenticated private raster preview with cache validators', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(r2Object())
      .mockResolvedValueOnce(r2Object());
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      readSettings: vi.fn().mockResolvedValue(mediaSettings()),
      getPreview: vi.fn().mockResolvedValue({
        mediaId: MEDIA_ID,
        mimeType: 'image/png',
        storageKey: `uploads/2026/08/${MEDIA_ID}.png`,
      }),
    });
    const response = await routes.fetch(
      new Request(`https://studio.local/${MEDIA_ID}/preview`),
      envWithBucket({ get } as Partial<R2Bucket>),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(response.headers.get('ETag')).toBe('"preview-etag"');
    expect(response.headers.get('Vary')).toBe('Cookie');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect([...new Uint8Array(await response.arrayBuffer())])
      .toEqual([0x89, 0x50, 0x4e, 0x47]);

    const notModified = await routes.fetch(new Request(
      `https://studio.local/${MEDIA_ID}/preview`,
      { headers: { 'If-None-Match': 'W/"preview-etag"' } },
    ), envWithBucket({ get } as Partial<R2Bucket>));
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe('');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('streams a revision-bound R2 raster source only to Media managers', async () => {
    const storageKey = `uploads/2026/08/${MEDIA_ID}.jpg`;
    const get = vi.fn().mockResolvedValue(r2Object(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    ));
    const getImageEditorSource = vi.fn().mockResolvedValue({
      kind: 'ready',
      preview: {
        mediaId: MEDIA_ID,
        mimeType: 'image/jpeg',
        storageKey,
      },
    });
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      getImageEditorSource,
    });
    const response = await routes.fetch(new Request(
      `https://studio.local/${MEDIA_ID}/editor-source?revision=${REVISION}`,
    ), envWithBucket({ get } as Partial<R2Bucket>));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(getImageEditorSource).toHaveBeenCalledWith({
      db: expect.anything(),
      id: MEDIA_ID,
      expectedRevision: REVISION,
    });
    expect(get).toHaveBeenCalledWith(storageKey);

    const authorSource = vi.fn();
    const authorRoutes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...editorSession,
        user: { ...editorSession.user, roles: ['author'] },
      }),
      getImageEditorSource: authorSource,
    });
    const forbidden = await authorRoutes.fetch(new Request(
      `https://studio.local/${MEDIA_ID}/editor-source?revision=${REVISION}`,
    ), envWithBucket({ get } as Partial<R2Bucket>));
    expect(forbidden.status).toBe(403);
    expect(authorSource).not.toHaveBeenCalled();
  });

  it('keeps unsupported and stale image-edit sources closed', async () => {
    const getImageEditorSource = vi.fn()
      .mockResolvedValueOnce({ kind: 'unsupported' })
      .mockResolvedValueOnce({ kind: 'revision_conflict' });
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      getImageEditorSource,
    });
    const environment = envWithBucket({ get: vi.fn() } as Partial<R2Bucket>);
    const unsupported = await routes.fetch(new Request(
      `https://studio.local/${MEDIA_ID}/editor-source?revision=${REVISION}`,
    ), environment);
    expect(unsupported.status).toBe(409);
    await expect(unsupported.json()).resolves.toEqual({
      success: false,
      error: { code: 'MEDIA_IMAGE_EDIT_UNSUPPORTED' },
    });
    const stale = await routes.fetch(new Request(
      `https://studio.local/${MEDIA_ID}/editor-source?revision=${REVISION}`,
    ), environment);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      success: false,
      error: { code: 'MEDIA_REVISION_CONFLICT' },
    });
  });

  it('serves only repository-approved managed SVG previews with response hardening', async () => {
    const source = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
    );
    const get = vi.fn().mockResolvedValue(r2Object(source));
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      readSettings: vi.fn().mockResolvedValue(mediaSettings()),
      getPreview: vi.fn().mockResolvedValue({
        mediaId: MEDIA_ID,
        mimeType: 'image/svg+xml',
        storageKey: `uploads/2026/08/${MEDIA_ID}.svg`,
      }),
    });
    const response = await routes.fetch(
      new Request(`https://studio.local/${MEDIA_ID}/preview`),
      envWithBucket({ get } as Partial<R2Bucket>),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
    expect(response.headers.get('Cross-Origin-Resource-Policy'))
      .toBe('same-origin');
    expect(response.headers.get('Content-Security-Policy')).toContain(
      "script-src 'none'",
    );
    await expect(response.text()).resolves.toContain('<rect');
  });

  it('does not use private R2 preview when a public Media origin is configured', async () => {
    const getPreview = vi.fn();
    const get = vi.fn();
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      readSettings: vi.fn().mockResolvedValue(mediaSettings(
        'https://media.example',
      )),
      getPreview,
    });
    const response = await routes.fetch(
      new Request(`https://studio.local/${MEDIA_ID}/preview`),
      envWithBucket({ get } as Partial<R2Bucket>),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'MEDIA_PREVIEW_NOT_FOUND' },
    });
    expect(getPreview).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('streams an authenticated reserved body reference without rewriting authored HTML', async () => {
    const storageKey = `uploads/2026/08/${MEDIA_ID}.jpg`;
    const get = vi.fn().mockResolvedValue(r2Object(
      new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    ));
    const getReferencePreview = vi.fn().mockResolvedValue({
      mediaId: MEDIA_ID,
      mimeType: 'image/jpeg',
      storageKey,
    });
    const routes = createManagedMediaReferenceRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      readSettings: vi.fn().mockResolvedValue(mediaSettings()),
      getReferencePreview,
    });
    const response = await routes.fetch(new Request(
      `https://studio.local/__zeropress_media__/${storageKey}`,
    ), envWithBucket({ get } as Partial<R2Bucket>));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/jpeg');
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=300');
    expect(getReferencePreview).toHaveBeenCalledWith({
      db: expect.anything(),
      storageKey,
    });
    expect(get).toHaveBeenCalledWith(storageKey);
    expect([...new Uint8Array(await response.arrayBuffer())])
      .toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  it('redirects reserved body references to the configured public Media origin', async () => {
    const storageKey = `imported/2026/08/${MEDIA_ID}.svg`;
    const get = vi.fn();
    const routes = createManagedMediaReferenceRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      readSettings: vi.fn().mockResolvedValue(mediaSettings(
        'https://media.example',
      )),
      getReferencePreview: vi.fn().mockResolvedValue({
        mediaId: MEDIA_ID,
        mimeType: 'image/svg+xml',
        storageKey,
      }),
    });
    const response = await routes.fetch(new Request(
      `https://studio.local/__zeropress_media__/${storageKey}`,
    ), envWithBucket({ get } as Partial<R2Bucket>));

    expect(response.status).toBe(302);
    expect(response.headers.get('Location'))
      .toBe(`https://media.example/${storageKey}`);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('Vary')).toBe('Cookie');
    expect(get).not.toHaveBeenCalled();
  });

  it('fails malformed, missing, and untrusted private body references closed', async () => {
    const getReferencePreview = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        mediaId: MEDIA_ID,
        mimeType: 'image/svg+xml',
        storageKey: `imported/2026/08/${MEDIA_ID}.svg`,
      });
    const get = vi.fn();
    const routes = createManagedMediaReferenceRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      readSettings: vi.fn().mockResolvedValue(mediaSettings()),
      getReferencePreview,
    });
    const environment = envWithBucket({ get } as Partial<R2Bucket>);

    expect((await routes.fetch(new Request(
      'https://studio.local/__zeropress_media__/../secret.jpg',
    ), environment)).status).toBe(404);
    expect((await routes.fetch(new Request(
      'https://studio.local/__zeropress_media__/uploads/missing.jpg',
    ), environment)).status).toBe(404);
    expect((await routes.fetch(new Request(
      `https://studio.local/__zeropress_media__/imported/2026/08/${MEDIA_ID}.svg`,
    ), environment)).status).toBe(404);
    expect(getReferencePreview).toHaveBeenCalledTimes(2);
    expect(get).not.toHaveBeenCalled();
  });

  it('fails private previews closed on a DB/R2 locality mismatch without reading R2', async () => {
    const get = vi.fn();
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      readSettings: vi.fn().mockResolvedValue(mediaSettings()),
      getPreview: vi.fn().mockResolvedValue({
        mediaId: MEDIA_ID,
        mimeType: 'image/jpeg',
        storageKey: `uploads/2026/08/${MEDIA_ID}.jpg`,
      }),
      managedUploadsEnabled: false,
    });
    const response = await routes.fetch(
      new Request(`https://studio.local/${MEDIA_ID}/preview`),
      envWithBucket({ get } as Partial<R2Bucket>),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'MEDIA_PREVIEW_NOT_AVAILABLE' },
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('treats missing preview objects as expected and catalogs R2 failures', async () => {
    const consoleSpy = vi.spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const get = vi.fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('R2 unavailable'));
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      readSettings: vi.fn().mockResolvedValue(mediaSettings()),
      getPreview: vi.fn().mockResolvedValue({
        mediaId: MEDIA_ID,
        mimeType: 'image/avif',
        storageKey: `imported/2026/${MEDIA_ID}.avif`,
      }),
    });
    const missing = await routes.fetch(
      new Request(`https://studio.local/${MEDIA_ID}/preview`),
      envWithBucket({ get } as Partial<R2Bucket>),
    );
    expect(missing.status).toBe(404);
    expect(consoleSpy).not.toHaveBeenCalled();

    const failed = await routes.fetch(
      new Request(`https://studio.local/${MEDIA_ID}/preview`),
      envWithBucket({ get } as Partial<R2Bucket>),
    );
    expect(failed.status).toBe(503);
    expect(consoleSpy).toHaveBeenCalledWith(expect.objectContaining({
      $zeropress: expect.objectContaining({
        code: 'MEDIA_PREVIEW_R2_READ_FAILED',
        resource: 'MEDIA_BUCKET',
        action: 'read_media_preview_object',
      }),
    }));
    consoleSpy.mockRestore();
  });

  it('prepares and streams a managed upload behind Media CSRF authorization', async () => {
    const createUploadIntent = vi.fn().mockResolvedValue({
      kind: 'completed',
      intent: {
        id: '6'.repeat(32),
        mediaId: MEDIA_ID,
        userId: USER_ID,
        filename: 'hero.png',
        descriptor: {
          extension: 'png',
          kind: 'image',
          mime_type: 'image/png',
          signature: 'png',
          disposition: 'inline',
        },
        storageKey: `uploads/2026/08/${MEDIA_ID}.png`,
        sizeBytes: 8,
        width: 1600,
        height: 900,
        durationMs: null,
        alt: 'Hero',
        createdAtIso: NOW.toISOString(),
        expiresAtIso: '2026-08-02T06:15:00.000Z',
      },
    });
    const storeUpload = vi.fn().mockResolvedValue({
      kind: 'completed',
      media: {
        ...media,
        mime_type: 'image/png',
        location: { type: 'r2', key: `uploads/2026/08/${MEDIA_ID}.png` },
        size_bytes: 8,
      },
    });
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createUploadIntent,
      storeUpload,
      now: () => NOW,
    });
    const prepared = await routes.fetch(mutationRequest('/uploads', 'POST', {
      filename: 'hero.png',
      size_bytes: 8,
      width: 1600,
      height: 900,
      duration_ms: null,
      alt: 'Hero',
    }), envWithBucket());
    expect(prepared.status).toBe(201);
    expect(createUploadIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      authored: expect.objectContaining({ filename: 'hero.png' }),
    }));

    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploaded = await routes.fetch(new Request(
      `https://studio.local/uploads/${'6'.repeat(32)}`,
      {
        method: 'PUT',
        headers: {
          Origin: 'https://studio.local',
          'Content-Type': 'application/octet-stream',
          'Content-Length': '8',
          'X-ZeroPress-CSRF': CSRF_TOKEN,
        },
        body: bytes,
      },
    ), envWithBucket());
    expect(uploaded.status).toBe(201);
    expect(storeUpload).toHaveBeenCalledWith(expect.objectContaining({
      uploadId: '6'.repeat(32),
      userId: USER_ID,
      contentLength: 8,
      bucket: expect.anything(),
    }));
  });

  it('generates one image and materializes it through the managed Media boundary', async () => {
    const generatedBytes = new Uint8Array([1, 2, 3, 4]);
    const generateAiImage = vi.fn().mockResolvedValue({
      bytes: generatedBytes,
      mimeType: 'image/png',
      extension: 'png',
      width: 1024,
      height: 576,
      seed: 42,
    });
    const createUploadIntent = vi.fn().mockResolvedValue({
      kind: 'completed',
      intent: {
        id: '6'.repeat(32),
        mediaId: MEDIA_ID,
        userId: USER_ID,
        filename: 'ai-generated.png',
        descriptor: {
          extension: 'png',
          kind: 'image',
          mime_type: 'image/png',
          signature: 'png',
          disposition: 'inline',
        },
        storageKey: `uploads/2026/08/${MEDIA_ID}.png`,
        sizeBytes: generatedBytes.byteLength,
        width: 1024,
        height: 576,
        durationMs: null,
        alt: 'Quiet library',
        createdAtIso: NOW.toISOString(),
        expiresAtIso: '2026-08-02T06:15:00.000Z',
      },
    });
    const storedMedia = {
      ...media,
      filename: 'ai-generated.png',
      mime_type: 'image/png',
      location: { type: 'r2' as const, key: `uploads/2026/08/${MEDIA_ID}.png` },
      size_bytes: generatedBytes.byteLength,
      width: 1024,
      height: 576,
      alt: 'Quiet library',
    };
    const storeUpload = vi.fn().mockResolvedValue({
      kind: 'completed',
      media: storedMedia,
    });
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      generateAiImage,
      createUploadIntent,
      storeUpload,
      now: () => NOW,
    });
    const environment = {
      ...envWithBucket(),
      AI: { run: vi.fn() } as unknown as Ai,
      AI_REQUEST_RATE_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: true }),
      },
    };
    const response = await routes.fetch(mutationRequest('/ai/images', 'POST', {
      prompt: 'A quiet library at sunrise',
      alt: 'Quiet library',
      aspect_ratio: 'landscape',
      seed: 42,
    }), environment);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        media: storedMedia,
        generation: {
          version: 1,
          model: '@cf/black-forest-labs/flux-2-klein-4b',
          prompt_version: 'image-v1',
          prompt: 'A quiet library at sunrise',
          aspect_ratio: 'landscape',
          seed: 42,
        },
      },
    });
    expect(createUploadIntent).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER_ID,
      enforceQueueLimit: false,
      authored: expect.objectContaining({
        size_bytes: generatedBytes.byteLength,
        width: 1024,
        height: 576,
        alt: 'Quiet library',
      }),
    }));
    expect(storeUpload).toHaveBeenCalledWith(expect.objectContaining({
      bucket: expect.anything(),
      generatedBy: {
        version: 1,
        model: '@cf/black-forest-labs/flux-2-klein-4b',
        prompt_version: 'image-v1',
        prompt: 'A quiet library at sunrise',
        aspect_ratio: 'landscape',
        seed: 42,
      },
    }));
  });

  it('returns a content rejection before creating Media or logging a service failure', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const createUploadIntent = vi.fn();
    const storeUpload = vi.fn();
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      createUploadIntent,
      storeUpload,
      now: () => NOW,
    });
    const response = await routes.fetch(mutationRequest('/ai/images', 'POST', {
      prompt: 'A quiet library at sunrise',
      alt: '',
      aspect_ratio: 'landscape',
    }), {
      ...envWithBucket(),
      AI: { run: vi.fn().mockResolvedValue(Response.json({
        internalCode: 3030,
        name: 'AiError',
        description: 'Your output has been flagged. Please choose another prompt / input image combination',
      }, { status: 400 })) } as unknown as Ai,
      AI_REQUEST_RATE_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: true }),
      },
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AI_IMAGE_CONTENT_REJECTED' },
    });
    expect(createUploadIntent).not.toHaveBeenCalled();
    expect(storeUpload).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('logs numeric provider diagnostics without exposing the prompt or provider text', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      now: () => NOW,
    });
    const response = await routes.fetch(mutationRequest('/ai/images', 'POST', {
      prompt: 'private-prompt-sentinel',
      alt: '',
      aspect_ratio: 'landscape',
    }), {
      ...envWithBucket(),
      AI: { run: vi.fn().mockResolvedValue(Response.json({
        internalCode: 3030,
        name: 'private-provider-name',
        description: 'private-provider-description',
      }, { status: 400 })) } as unknown as Ai,
      AI_REQUEST_RATE_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: true }),
      },
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AI_SERVICE_UNAVAILABLE' },
    });
    expect(errorLog.mock.calls).toEqual([[{
      message: 'Studio AI image generation failed',
      $zeropress: {
        code: 'AI_IMAGE_GENERATION_FAILED',
        resource: 'AI',
        action: 'generate_image',
        target_type: 'media',
        model: '@cf/black-forest-labs/flux-2-klein-4b',
        prompt_version: 'image-v1',
        reason: 'request_failed',
        provider_status: 400,
        provider_code: 3030,
        guidance: OPERATIONAL_LOG_DEFINITIONS.AI_IMAGE_GENERATION_FAILED.guidance,
      },
    }]]);
  });

  it('keeps timeouts on the service-unavailable response path', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      generateAiImage: vi.fn().mockRejectedValue(new AiImageProviderError('timeout')),
      now: () => NOW,
    });
    const response = await routes.fetch(mutationRequest('/ai/images', 'POST', {
      prompt: 'A quiet library at sunrise',
      alt: '',
      aspect_ratio: 'landscape',
    }), {
      ...envWithBucket(),
      AI: { run: vi.fn() } as unknown as Ai,
      AI_REQUEST_RATE_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: true }),
      },
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'AI_SERVICE_UNAVAILABLE' },
    });
    expect(errorLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      $zeropress: expect.objectContaining({
        code: 'AI_IMAGE_GENERATION_FAILED',
        reason: 'timeout',
      }),
    }));
  });

  it('checks manager authorization and local managed storage before AI capacity', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const generateAiImage = vi.fn();
    const request = mutationRequest('/ai/images', 'POST', {
      prompt: 'A quiet library at sunrise',
      alt: '',
      aspect_ratio: 'landscape',
    });
    const authorRoutes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...editorSession,
        user: { ...editorSession.user, roles: ['author'] },
      }),
      generateAiImage,
    });
    expect((await authorRoutes.fetch(request, {
      ...envWithBucket(),
      AI: { run: vi.fn() } as unknown as Ai,
      AI_REQUEST_RATE_LIMITER: { limit },
    })).status).toBe(403);

    const noStorageRoutes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      generateAiImage,
    });
    expect((await noStorageRoutes.fetch(mutationRequest('/ai/images', 'POST', {
      prompt: 'A quiet library at sunrise',
      alt: '',
      aspect_ratio: 'landscape',
    }), {
      ...env(),
      AI: { run: vi.fn() } as unknown as Ai,
      AI_REQUEST_RATE_LIMITER: { limit },
    })).status).toBe(503);
    expect(limit).not.toHaveBeenCalled();
    expect(generateAiImage).not.toHaveBeenCalled();
  });

  it('returns a specific expected rejection when SVG sanitization fails', async () => {
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      storeUpload: vi.fn().mockResolvedValue({
        kind: 'svg_sanitization_failed',
      }),
    });
    const response = await routes.fetch(new Request(
      `https://studio.local/uploads/${'6'.repeat(32)}`,
      {
        method: 'PUT',
        headers: {
          Origin: 'https://studio.local',
          'Content-Type': 'application/octet-stream',
          'Content-Length': '8',
          'X-ZeroPress-CSRF': CSRF_TOKEN,
        },
        body: new Uint8Array(8),
      },
    ), envWithBucket());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'MEDIA_UPLOAD_SVG_SANITIZATION_FAILED' },
    });
  });

  it('returns physical-cleanup state after deleting an imported R2 asset', async () => {
    const deleteQueuedObject = vi.fn().mockResolvedValue('pending');
    const routes = createMediaRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      deleteMedia: vi.fn().mockResolvedValue({
        kind: 'completed',
        cleanupKey: `imported/2026/08/${MEDIA_ID}.png`,
      }),
      deleteQueuedObject,
    });
    const response = await routes.fetch(mutationRequest(
      `/${MEDIA_ID}`,
      'DELETE',
      { expected_revision: REVISION },
    ), envWithBucket());
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        status: 'media_deleted',
        id: MEDIA_ID,
        object_cleanup: 'pending',
      },
    });
    expect(deleteQueuedObject).toHaveBeenCalledWith(expect.objectContaining({
      storageKey: `imported/2026/08/${MEDIA_ID}.png`,
    }));
  });
});

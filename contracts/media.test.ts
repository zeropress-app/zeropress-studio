import { describe, expect, it } from 'vitest';
import {
  bulkMediaOperationDataSchema,
  bulkMediaOperationRequestSchema,
  bulkMoveMediaRequestSchema,
  createMediaCollectionRequestSchema,
  createManagedMediaReference,
  createMediaRequestSchema,
  externalMediaUrlSchema,
  isDeletableR2MediaStorageKey,
  isR2MediaPreviewImageMimeType,
  isR2MediaPreviewSafeImage,
  materializeManagedMediaReferences,
  mediaListQuerySchema,
  mediaListSuccessSchema,
  mediaReferenceListQuerySchema,
  mediaReferenceListSuccessSchema,
  mediaUsageSchema,
  normalizeExternalMediaUrl,
  normalizeMediaCollectionName,
  normalizeMediaStorageKey,
  updateMediaRequestSchema,
} from './media';

const image = {
  kind: 'image' as const,
  filename: 'hero image.jpg',
  mime_type: 'image/jpeg',
  location: {
    type: 'external' as const,
    url: 'https://media.example/uploads/hero%20image.jpg',
  },
  size_bytes: 1234,
  width: 1600,
  height: 900,
  duration_ms: null,
  alt: 'Launch hero',
};

describe('Media contracts', () => {
  it('canonicalizes only absolute external HTTP(S) URLs', () => {
    expect(normalizeExternalMediaUrl(
      ' HTTPS://MEDIA.EXAMPLE:443/uploads/hero%20image.jpg?width=1200#crop ',
    )).toBe('https://media.example/uploads/hero%20image.jpg?width=1200#crop');
    expect(externalMediaUrlSchema.safeParse(
      'https://media.example/uploads/hero.jpg',
    ).success).toBe(true);
    expect(normalizeExternalMediaUrl('/uploads/hero.jpg')).toBeNull();
  });

  it('rejects unsafe external URLs and R2 keys', () => {
    for (const source of [
      '',
      '/',
      '//media.example/hero.jpg',
      'uploads/hero.jpg',
      'ftp://media.example/hero.jpg',
      'https://user:password@media.example/hero.jpg',
      'https://media.example/uploads/../secret.jpg',
      'https://media.example/uploads/bad%2.jpg',
      'https://media.example/uploads/bad path.jpg',
      'https://media.example/uploads\\hero.jpg',
    ]) expect(normalizeExternalMediaUrl(source), source).toBeNull();
    expect(normalizeMediaStorageKey('imported/2026/hero.jpg'))
      .toBe('imported/2026/hero.jpg');
    expect(normalizeMediaStorageKey('/imported/hero.jpg')).toBeNull();
    expect(normalizeMediaStorageKey('imported/../hero.jpg')).toBeNull();
  });

  it('limits physical deletion to canonical Studio R2 namespaces', () => {
    expect(isDeletableR2MediaStorageKey('uploads/2026/08/hero.jpg'))
      .toBe(true);
    expect(isDeletableR2MediaStorageKey('imported/2026/08/hero.jpg'))
      .toBe(true);
    expect(isDeletableR2MediaStorageKey('other/hero.jpg')).toBe(false);
    expect(isDeletableR2MediaStorageKey('imported/../hero.jpg')).toBe(false);
  });

  it('enforces type-specific metadata and an external-only create contract', () => {
    expect(createMediaRequestSchema.parse({
      ...image,
      filename: ' hero image.jpg ',
      mime_type: ' IMAGE/JPEG ',
      location: { type: 'external', url: ` ${image.location.url} ` },
      alt: '  Launch hero  ',
    })).toEqual(image);
    expect(createMediaRequestSchema.safeParse({
      ...image,
      location: { type: 'r2', key: 'imported/hero.jpg' },
    }).success).toBe(false);
    expect(createMediaRequestSchema.safeParse({
      ...image,
      width: null,
    }).success).toBe(false);
    expect(updateMediaRequestSchema.safeParse({
      ...image,
      location: { type: 'r2', key: 'imported/hero.jpg' },
      expected_revision: 'a'.repeat(32),
    }).success).toBe(true);
    expect(createMediaRequestSchema.safeParse({
      ...image,
      kind: 'document',
      mime_type: 'application/pdf',
      width: null,
      height: null,
      alt: 'not valid',
    }).success).toBe(false);
  });

  it('materializes reserved managed references with absolute or root-relative delivery', () => {
    const reference = createManagedMediaReference('imported/2026/hero.jpg');
    expect(reference).toBe('/__zeropress_media__/imported/2026/hero.jpg');
    expect(materializeManagedMediaReferences(
      `<img src="${reference}">`,
      'https://media.example',
    )).toBe('<img src="https://media.example/imported/2026/hero.jpg">');
    expect(materializeManagedMediaReferences(reference, ''))
      .toBe('/imported/2026/hero.jpg');
  });

  it('describes Media-list delivery once and limits private previews to passive raster images', () => {
    expect(mediaListQuerySchema.parse({})).toEqual({
      search: '',
      kind: 'all',
      purpose: 'all',
      collection: 'all',
      page: 1,
      per_page: 50,
    });
    expect(mediaListQuerySchema.parse({ kind: 'document' }).kind)
      .toBe('document');
    expect(mediaListQuerySchema.safeParse({ kind: 'unknown' }).success)
      .toBe(false);
    expect(mediaListSuccessSchema.safeParse({
      success: true,
      data: {
        items: [],
        pagination: {
          page: 1,
          per_page: 50,
          total: 0,
          total_pages: 0,
        },
        delivery: {
          media_origin: 'https://media.example',
          r2_preview_available: false,
        },
      },
    }).success).toBe(true);
    expect(mediaListSuccessSchema.safeParse({
      success: true,
      data: {
        items: [],
        pagination: {
          page: 1,
          per_page: 50,
          total: 0,
          total_pages: 0,
        },
        delivery: {
          media_origin: 'https://media.example/path',
          r2_preview_available: true,
        },
      },
    }).success).toBe(false);
    expect(isR2MediaPreviewImageMimeType('image/avif')).toBe(true);
    expect(isR2MediaPreviewImageMimeType('image/x-icon')).toBe(true);
    expect(isR2MediaPreviewImageMimeType('image/vnd.microsoft.icon')).toBe(true);
    expect(isR2MediaPreviewImageMimeType('image/svg+xml')).toBe(false);
    expect(isR2MediaPreviewSafeImage(
      'image/svg+xml',
      'uploads/2026/08/0123456789abcdef0123456789abcdef.svg',
    )).toBe(true);
    expect(isR2MediaPreviewSafeImage(
      'image/svg+xml',
      'imported/2026/08/logo.svg',
    )).toBe(false);
  });

  it('bounds and discriminates references that must be cleared before deletion', () => {
    expect(mediaReferenceListQuerySchema.parse({})).toEqual({
      page: 1,
      per_page: 20,
    });
    expect(mediaReferenceListQuerySchema.safeParse({ per_page: 51 }).success)
      .toBe(false);
    expect(mediaUsageSchema.safeParse({
      posts: 1,
      pages: 0,
      authors: 0,
      branding: 1,
    }).success).toBe(true);
    expect(mediaUsageSchema.safeParse({
      posts: 1,
      pages: 0,
      authors: 0,
    }).success).toBe(false);
    expect(mediaReferenceListSuccessSchema.safeParse({
      success: true,
      data: {
        media_id: '1'.repeat(32),
        items: [
          {
            type: 'post',
            id: '2'.repeat(32),
            public_id: 100000000001,
            title: 'Referenced Post',
          },
          { type: 'author', id: 'site-owner', display_name: 'Site Owner' },
          { type: 'branding', slot: 'logo' },
        ],
        pagination: { page: 1, per_page: 20, total: 3, total_pages: 1 },
      },
    }).success).toBe(true);
  });

  it('normalizes collection names and bounds revision-bound bulk moves', () => {
    expect(normalizeMediaCollectionName('  Photography  ')).toBe('Photography');
    expect(createMediaCollectionRequestSchema.parse({
      name: '  Photography  ',
    })).toEqual({ name: 'Photography' });
    expect(createMediaCollectionRequestSchema.safeParse({
      name: 'Photography',
      parent_id: null,
    }).success).toBe(false);
    expect(normalizeMediaCollectionName('\u0000Photography')).toBeNull();

    const item = {
      id: '1'.repeat(32),
      expected_revision: '2'.repeat(32),
    };
    expect(bulkMoveMediaRequestSchema.safeParse({
      target_collection_id: null,
      items: [item],
    }).success).toBe(true);
    expect(bulkMoveMediaRequestSchema.safeParse({
      target_collection_id: null,
      items: [item, item],
    }).success).toBe(false);
    expect(bulkMoveMediaRequestSchema.safeParse({
      target_collection_id: null,
      items: Array.from({ length: 101 }, (_, index) => ({
        id: index.toString(16).padStart(32, '0'),
        expected_revision: '2'.repeat(32),
      })),
    }).success).toBe(false);
  });

  it('bounds revision-bound Media metadata edits and deletes with strict outcomes', () => {
    const item = {
      id: '1'.repeat(32),
      expected_revision: '2'.repeat(32),
    };
    expect(bulkMediaOperationRequestSchema.safeParse({
      operation: 'update_metadata',
      items: [{ ...item, filename: 'hero.jpg', alt: 'Hero' }],
    }).success).toBe(true);
    expect(bulkMediaOperationRequestSchema.safeParse({
      operation: 'delete',
      items: [item, item],
    }).success).toBe(false);
    expect(bulkMediaOperationRequestSchema.safeParse({
      operation: 'delete',
      items: Array.from({ length: 51 }, (_, index) => ({
        id: index.toString(16).padStart(32, '0'),
        expected_revision: '2'.repeat(32),
      })),
    }).success).toBe(false);
    expect(bulkMediaOperationDataSchema.safeParse({
      operation: 'delete',
      results: [
        { id: item.id, outcome: 'updated', object_cleanup: 'pending' },
      ],
      summary: {
        requested: 1,
        updated: 1,
        unchanged: 0,
        conflict: 0,
        skipped: 0,
        queued_objects: 1,
      },
    }).success).toBe(true);
    expect(bulkMediaOperationDataSchema.safeParse({
      operation: 'update_metadata',
      results: [
        { id: item.id, outcome: 'updated', object_cleanup: 'pending' },
      ],
      summary: {
        requested: 1,
        updated: 1,
        unchanged: 0,
        conflict: 0,
        skipped: 0,
        queued_objects: 1,
      },
    }).success).toBe(false);
  });
});

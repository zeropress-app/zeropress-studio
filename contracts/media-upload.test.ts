import { describe, expect, it } from 'vitest';
import {
  createManagedMediaUploadRequestSchema,
  managedMediaUploadExtensions,
  MANAGED_MEDIA_SVG_UPLOAD_MAX_BYTES,
  MANAGED_MEDIA_UPLOAD_MAX_BYTES,
  resolveManagedMediaFileDescriptor,
} from './media-upload';

describe('managed Media upload contract', () => {
  it('maps every allowed extension to server-owned kind and MIME metadata', () => {
    expect(managedMediaUploadExtensions).toContain('jpg');
    expect(managedMediaUploadExtensions).toContain('pdf');
    expect(managedMediaUploadExtensions).toContain('zip');
    expect(managedMediaUploadExtensions).toContain('svg');
    expect(resolveManagedMediaFileDescriptor(' Photo.JPEG ')).toEqual({
      extension: 'jpg',
      kind: 'image',
      mime_type: 'image/jpeg',
      signature: 'jpeg',
      disposition: 'inline',
    });
    expect(resolveManagedMediaFileDescriptor('document.pdf')).toMatchObject({
      kind: 'document',
      mime_type: 'application/pdf',
      disposition: 'attachment',
    });
    expect(resolveManagedMediaFileDescriptor('vector.svg')).toEqual({
      extension: 'svg',
      kind: 'image',
      mime_type: 'image/svg+xml',
      signature: 'text',
      disposition: 'inline',
    });
  });

  it('requires bounded browser-decoded image dimensions', () => {
    const base = {
      filename: 'hero.png',
      size_bytes: 1024,
      width: 1920,
      height: 1080,
      duration_ms: null,
      alt: ' Hero ',
    };
    expect(createManagedMediaUploadRequestSchema.parse(base)).toEqual({
      ...base,
      alt: 'Hero',
    });
    expect(createManagedMediaUploadRequestSchema.safeParse({
      ...base,
      width: null,
      height: null,
    }).success).toBe(false);
    expect(createManagedMediaUploadRequestSchema.safeParse({
      ...base,
      width: 20_000,
      height: 20_000,
    }).success).toBe(false);
  });

  it('enforces file size, type-specific metadata, and the bounded SVG policy', () => {
    expect(createManagedMediaUploadRequestSchema.safeParse({
      filename: 'asset.svg',
      size_bytes: 100,
      width: 640,
      height: 480,
      duration_ms: null,
      alt: '',
    }).success).toBe(true);
    expect(createManagedMediaUploadRequestSchema.safeParse({
      filename: 'asset.svg',
      size_bytes: MANAGED_MEDIA_SVG_UPLOAD_MAX_BYTES + 1,
      width: 640,
      height: 480,
      duration_ms: null,
      alt: '',
    }).success).toBe(false);
    expect(createManagedMediaUploadRequestSchema.safeParse({
      filename: 'archive.zip',
      size_bytes: MANAGED_MEDIA_UPLOAD_MAX_BYTES + 1,
      width: null,
      height: null,
      duration_ms: null,
      alt: '',
    }).success).toBe(false);
    expect(createManagedMediaUploadRequestSchema.safeParse({
      filename: 'track.mp3',
      size_bytes: 100,
      width: null,
      height: null,
      duration_ms: 1200,
      alt: 'not allowed',
    }).success).toBe(false);
  });
});

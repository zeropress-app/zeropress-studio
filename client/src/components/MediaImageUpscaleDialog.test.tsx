// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Media, MediaDelivery } from '../../../contracts/media';
import { changeLocale } from '../i18n';
import { MediaImageUpscaleDialog } from './MediaImageUpscaleDialog';

const {
  requestSource,
  inspectSource,
  upscaleImage,
  storeFile,
} = vi.hoisted(() => ({
  requestSource: vi.fn(),
  inspectSource: vi.fn(),
  upscaleImage: vi.fn(),
  storeFile: vi.fn(),
}));

vi.mock('../lib/media-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/media-client')>(),
  requestMediaImageEditorSource: requestSource,
}));

vi.mock('../lib/media-image-upscale-source', () => ({
  inspectMediaImageUpscaleSource: inspectSource,
}));

vi.mock('../lib/media-image-upscale-runtime', () => ({
  upscaleMediaImage: upscaleImage,
}));

vi.mock('../lib/managed-media-upload', () => ({
  storeManagedMediaFile: storeFile,
}));

const sourceMedia: Media = {
  id: '1'.repeat(32),
  kind: 'image',
  filename: 'wallpaper.jpg',
  mime_type: 'image/jpeg',
  location: { type: 'r2', key: 'uploads/2026/08/wallpaper.jpg' },
  size_bytes: 400_000,
  width: 1_920,
  height: 1_080,
  duration_ms: null,
  alt: 'Mountain wallpaper',
  collection: null,
  usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
  revision: '2'.repeat(32),
  created_at_iso: '2026-08-21T00:00:00.000Z',
  updated_at_iso: '2026-08-21T00:00:00.000Z',
};

const savedMedia: Media = {
  ...sourceMedia,
  id: '3'.repeat(32),
  filename: 'wallpaper-upscaled-2x.jpg',
  width: 3_840,
  height: 2_160,
  revision: '4'.repeat(32),
};

const delivery: MediaDelivery = {
  media_origin: '',
  r2_preview_available: true,
};

beforeEach(async () => {
  await changeLocale('en');
  requestSource.mockResolvedValue(new Blob(['source'], { type: 'image/jpeg' }));
  inspectSource.mockResolvedValue({ hasTransparency: false });
  upscaleImage.mockImplementation(async (input: {
    onProgress: (value: unknown) => void;
  }) => {
    input.onProgress({ stage: 'processing', completed: 777, total: 777 });
    return {
      blob: new Blob(['result'], { type: 'image/jpeg' }),
      width: 3_840,
      height: 2_160,
    };
  });
  storeFile.mockResolvedValue({ success: true, data: savedMedia });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn()
      .mockReturnValueOnce('blob:source')
      .mockReturnValueOnce('blob:result'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MediaImageUpscaleDialog', () => {
  it('generates a reviewed 2x comparison before saving a new Media item', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <MediaImageUpscaleDialog
        media={sourceMedia}
        delivery={delivery}
        csrfToken={'c'.repeat(43)}
        onClose={vi.fn()}
        onSaved={onSaved}
        onSessionEnded={vi.fn()}
      />,
    );

    expect(await screen.findByText(/777 inference tiles/iu)).toBeInTheDocument();
    expect(screen.getByRole('option', {
      name: /4× unavailable/iu,
    })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save as new Media' }))
      .not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Generate preview' }));
    await waitFor(() => expect(upscaleImage).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1_920,
        height: 1_080,
        scale: 2,
        outputMimeType: 'image/jpeg',
        quality: 0.9,
        hasTransparency: false,
      }),
    ));
    expect(await screen.findByText('3,840×2,160 · 6 bytes'))
      .toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save as new Media' }));
    await waitFor(() => expect(storeFile).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 3_840,
        height: 2_160,
        alt: 'Mountain wallpaper',
        file: expect.any(File),
      }),
    ));
    const uploadedFile = storeFile.mock.calls[0]![0].file as File;
    expect(uploadedFile.name).toBe('wallpaper-upscaled-2x.jpg');
    expect(uploadedFile.type).toBe('image/jpeg');
    expect(onSaved).toHaveBeenCalledWith(savedMedia, delivery);
  });
});

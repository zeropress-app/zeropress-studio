// @vitest-environment jsdom

import { createRef } from 'react';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from '../i18n';
import * as managedMediaUpload from '../lib/managed-media-upload';
import { ManagedMediaUploadPanel } from './ManagedMediaUploadPanel';

function renderPanel() {
  return render(
    <ManagedMediaUploadPanel
      csrfToken={'c'.repeat(43)}
      maxBytes={64 * 1024 * 1024}
      maxSvgBytes={2 * 1024 * 1024}
      maxFiles={10}
      concurrency={2}
      cancelRef={createRef<HTMLButtonElement>()}
      onClose={vi.fn()}
      onUploaded={vi.fn()}
      onRunningChange={vi.fn()}
      onSessionEnded={vi.fn()}
    />,
  );
}

function imageBitmap(width = 64, height = 64): ImageBitmap {
  return {
    width,
    height,
    close: vi.fn(),
  } as unknown as ImageBitmap;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('ManagedMediaUploadPanel', () => {
  it.each([
    { filename: 'clip.mp4', kind: 'video', width: 640, height: 360 },
    { filename: 'clip.mp3', kind: 'audio', width: null, height: null },
  ])('reads $kind metadata through a local media element before upload', async ({
    filename, kind, width, height,
  }) => {
    const objectUrl = 'blob:studio-media-metadata';
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue(objectUrl);
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const sources: { element: HTMLMediaElement; url: string }[] = [];
    vi.spyOn(HTMLMediaElement.prototype, 'src', 'set').mockImplementation(function (
      this: HTMLMediaElement, url: string,
    ) {
      sources.push({ element: this, url });
      Object.defineProperty(this, 'duration', { value: 1.25 });
      if (this instanceof HTMLVideoElement) {
        Object.defineProperty(this, 'videoWidth', { value: width });
        Object.defineProperty(this, 'videoHeight', { value: height });
      }
      queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
    });
    const upload = vi.spyOn(managedMediaUpload, 'storeManagedMediaFile')
      .mockResolvedValue({ success: false, error: { code: 'MEDIA_UPLOAD_SIGNATURE_INVALID' } });
    const file = new File(['synthetic media bytes'], filename);
    const user = userEvent.setup();
    renderPanel();

    await user.upload(screen.getByLabelText('Choose files'), file);
    await screen.findByText('Ready');
    expect(sources).toHaveLength(1);
    expect(sources[0]!.element).toBeInstanceOf(kind === 'audio' ? HTMLAudioElement : HTMLVideoElement);
    expect(sources[0]!.url).toBe(objectUrl);
    expect(createObjectUrl).toHaveBeenCalledWith(file);
    expect(revokeObjectUrl).toHaveBeenCalledWith(objectUrl);

    await user.click(screen.getByRole('button', { name: 'Upload 1 file' }));
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      file, width, height, durationMs: 1250,
    }));
  });

  it('inspects files added by later chooser events instead of stranding them', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => imageBitmap()));
    const user = userEvent.setup();
    renderPanel();
    const chooser = screen.getByLabelText('Choose files');

    await user.upload(chooser, new File(['first'], 'first.png', {
      type: 'image/png',
    }));
    await waitFor(() => expect(screen.getAllByText('Ready')).toHaveLength(1));

    await user.upload(chooser, new File(['second'], 'second.png', {
      type: 'image/png',
    }));
    await waitFor(() => expect(screen.getAllByText('Ready')).toHaveLength(2));
    expect(screen.getByText('first.png')).toBeInTheDocument();
    expect(screen.getByText('second.png')).toBeInTheDocument();
    expect(screen.queryByText('Inspecting file metadata…')).not.toBeInTheDocument();
  });

  it('falls back to the ordinary image decoder when createImageBitmap rejects SVG', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(
      new DOMException('SVG is not supported by createImageBitmap.'),
    ));
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:studio-svg');
    class TestImage {
      naturalWidth = 128;
      naturalHeight = 96;
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', TestImage);

    const user = userEvent.setup();
    renderPanel();
    await user.upload(
      screen.getByLabelText('Choose files'),
      new File([
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 96"/>',
      ], 'favicon.svg', { type: 'image/svg+xml' }),
    );

    await waitFor(() => expect(screen.getByText('Ready')).toBeInTheDocument());
    expect(screen.getByText(/image\/svg\+xml/u)).toBeInTheDocument();
    expect(screen.queryByText('The browser could not decode this image.'))
      .not.toBeInTheDocument();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:studio-svg');
  });
});

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

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderContentPreview } from './content-preview-client';
import type { ContentPreviewRequest, ContentPreviewResponse } from './content-preview';

const input: ContentPreviewRequest = {
  title: 'Draft', content: '<p>Draft</p>', documentType: 'html', baseUrl: '',
  language: 'en', dark: false,
  labels: {
    linkDetails: 'Link details', address: 'Address', target: 'Opens in',
    newWindow: 'New window (_blank)', sameWindow: 'Current window',
    embedTitle: 'External content', embedUnavailable: 'Not loaded in this preview.',
    missingAddress: 'Address not available', close: 'Close',
  },
};
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: ContentPreviewResponse }) => void) | null = null;
  onerror: ((event: { preventDefault: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
}
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders only the requested snapshot and disposes its worker after success', async () => {
  const result = renderContentPreview(input, new AbortController().signal);
  const worker = FakeWorker.instances[0];
  expect(worker.postMessage).toHaveBeenCalledWith(input);
  worker.onmessage!({ data: { success: true, document: '<p>Rendered</p>' } });
  await expect(result).resolves.toBe('<p>Rendered</p>');
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('terminates work when the preview closes', async () => {
  const controller = new AbortController();
  const result = renderContentPreview(input, controller.signal);
  const rejected = expect(result).rejects.toThrow('Preview unavailable');
  controller.abort();
  await rejected;
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds rendering time and handles worker errors', async () => {
  const timeout = renderContentPreview(input, new AbortController().signal);
  const rejected = expect(timeout).rejects.toThrow('Preview unavailable');
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  const failed = renderContentPreview(input, new AbortController().signal);
  const error = expect(failed).rejects.toThrow('Preview unavailable');
  const preventDefault = vi.fn();
  FakeWorker.instances[1].onerror!({ preventDefault });
  await error;
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(FakeWorker.instances[1].terminate).toHaveBeenCalledOnce();
});

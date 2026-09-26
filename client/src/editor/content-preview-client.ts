import type { ContentPreviewRequest, ContentPreviewResponse } from './content-preview';

/** One disposable worker per snapshot keeps rendering off the editing thread. */
export function renderContentPreview(
  input: ContentPreviewRequest,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Preview cancelled'));
      return;
    }
    const worker = new Worker(new URL('./content-preview.worker.ts', import.meta.url), { type: 'module' });
    const finish = (document?: string) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      worker.terminate();
      if (document === undefined) reject(new Error('Preview unavailable'));
      else resolve(document);
    };
    const cancel = () => finish();
    const timeout = setTimeout(cancel, 15_000);
    signal.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<ContentPreviewResponse>) => {
      finish(event.data.success ? event.data.document : undefined);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish();
    };
    worker.onmessageerror = () => finish();
    try { worker.postMessage(input); } catch { finish(); }
  });
}

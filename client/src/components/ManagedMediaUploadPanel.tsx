import {
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../../contracts/api';
import {
  createManagedMediaUploadRequestSchema,
  isManagedImageMetadataWithinPolicy,
  managedMediaUploadAcceptValue,
  resolveManagedMediaFileDescriptor,
  type ManagedMediaFileDescriptor,
} from '../../../contracts/media-upload';
import { MediaClientError } from '../lib/media-client';
import { storeManagedMediaFile } from '../lib/managed-media-upload';
import { Button, DialogActions, Field } from './primitives';

type UploadStatus =
  | 'inspecting'
  | 'ready'
  | 'preparing'
  | 'uploading'
  | 'completed'
  | 'cancelled'
  | 'error';

type UploadError =
  | 'type_not_allowed'
  | 'too_large'
  | 'svg_too_large'
  | 'image_decode_failed'
  | 'image_dimensions_invalid'
  | 'metadata_invalid'
  | 'cancelled'
  | 'network'
  | 'timeout'
  | 'invalid_response'
  | ApiErrorCode;

type UploadItem = {
  id: string;
  file: File;
  descriptor: ManagedMediaFileDescriptor | null;
  status: UploadStatus;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  alt: string;
  progress: number;
  uploadId: string | null;
  error: UploadError | null;
};

function localId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

async function decodeImageDimensions(file: File): Promise<{
  width: number;
  height: number;
}> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        return { width: bitmap.width, height: bitmap.height };
      } finally {
        bitmap.close();
      }
    } catch {
      // Chromium does not consistently decode SVG through createImageBitmap.
      // Continue with the browser's ordinary image decoder; SVG loaded in an
      // <img> remains in the non-scripted image document context.
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image decoding failed.'));
    };
    image.src = url;
  });
}

async function readOptionalTimedMetadata(
  file: File,
  kind: 'audio' | 'video',
): Promise<{
  width: number | null;
  height: number | null;
  durationMs: number | null;
}> {
  return new Promise((resolve) => {
    const element = kind === 'audio'
      ? document.createElement('audio')
      : document.createElement('video');
    const url = URL.createObjectURL(file);
    let completed = false;
    const timeout = window.setTimeout(finish, 10_000);
    function finish() {
      if (completed) return;
      completed = true;
      window.clearTimeout(timeout);
      URL.revokeObjectURL(url);
      const durationMs = Number.isFinite(element.duration)
        && element.duration >= 0
        ? Math.round(element.duration * 1_000)
        : null;
      const width = element instanceof HTMLVideoElement
        && element.videoWidth > 0
        ? element.videoWidth
        : null;
      const height = element instanceof HTMLVideoElement
        && element.videoHeight > 0
        ? element.videoHeight
        : null;
      resolve({ width, height, durationMs });
    }
    element.preload = 'metadata';
    element.onloadedmetadata = finish;
    element.onerror = finish;
    element.src = url;
  });
}

function humanBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

export function ManagedMediaUploadPanel(input: {
  csrfToken: string;
  maxBytes: number;
  maxSvgBytes: number;
  maxFiles: number;
  concurrency: number;
  cancelRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onUploaded: () => void;
  onRunningChange: (running: boolean) => void;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('media');
  const [items, setItems] = useState<UploadItem[]>([]);
  const [running, setRunning] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  function commit(update: (current: UploadItem[]) => UploadItem[]) {
    // Queue inspection and upload callbacks may finish before React commits a
    // previous state update. Keep one eager authoritative snapshot so a later
    // file-selection event cannot calculate capacity or patch against stale
    // rows.
    const next = update(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  }

  function patchItem(id: string, patch: Partial<UploadItem>) {
    commit((current) => current.map((item) => (
      item.id === id ? { ...item, ...patch } : item
    )));
  }

  async function inspectItem(item: UploadItem) {
    const { id } = item;
    const descriptor = resolveManagedMediaFileDescriptor(item.file.name);
    if (!descriptor) {
      patchItem(id, { status: 'error', error: 'type_not_allowed' });
      return;
    }
    if (item.file.size < 1 || item.file.size > input.maxBytes) {
      patchItem(id, { descriptor, status: 'error', error: 'too_large' });
      return;
    }
    if (
      descriptor.mime_type === 'image/svg+xml'
      && item.file.size > input.maxSvgBytes
    ) {
      patchItem(id, {
        descriptor,
        status: 'error',
        error: 'svg_too_large',
      });
      return;
    }
    let width: number | null = null;
    let height: number | null = null;
    let durationMs: number | null = null;
    if (descriptor.kind === 'image') {
      let dimensions: { width: number; height: number };
      try {
        dimensions = await decodeImageDimensions(item.file);
      } catch {
        patchItem(id, {
          descriptor,
          status: 'error',
          error: 'image_decode_failed',
        });
        return;
      }
      if (!isManagedImageMetadataWithinPolicy(dimensions)) {
        patchItem(id, {
          descriptor,
          status: 'error',
          error: 'image_dimensions_invalid',
        });
        return;
      }
      ({ width, height } = dimensions);
    } else if (descriptor.kind === 'audio' || descriptor.kind === 'video') {
      const timed = await readOptionalTimedMetadata(item.file, descriptor.kind);
      ({ width, height, durationMs } = timed);
    }
    patchItem(id, {
      descriptor,
      status: 'ready',
      width,
      height,
      durationMs,
      error: null,
    });
  }

  function addFiles(files: File[]) {
    if (running || files.length === 0) return;
    const available = Math.max(0, input.maxFiles - itemsRef.current.length);
    const additions = files.slice(0, available).map((file): UploadItem => ({
      id: localId(),
      file,
      descriptor: null,
      status: 'inspecting',
      width: null,
      height: null,
      durationMs: null,
      alt: '',
      progress: 0,
      uploadId: null,
      error: null,
    }));
    commit((current) => [...current, ...additions]);
    // Do not look the additions up through itemsRef here. React may defer the
    // state updater, especially after the first file-selection event, leaving
    // a newly added row permanently in `inspecting`.
    for (const item of additions) void inspectItem(item);
  }

  function onFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    addFiles([...event.target.files ?? []]);
    event.target.value = '';
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    addFiles([...event.dataTransfer.files]);
  }

  function errorMessage(error: UploadError): string {
    if (error === 'type_not_allowed' || error === 'MEDIA_UPLOAD_TYPE_NOT_ALLOWED') {
      return t('upload.errors.typeNotAllowed');
    }
    if (error === 'too_large' || error === 'PAYLOAD_TOO_LARGE') {
      return t('upload.errors.tooLarge');
    }
    if (error === 'svg_too_large') {
      return t('upload.errors.svgTooLarge', {
        max: humanBytes(input.maxSvgBytes),
      });
    }
    if (error === 'image_decode_failed') return t('upload.errors.imageDecode');
    if (error === 'image_dimensions_invalid') return t('upload.errors.imageDimensions');
    if (error === 'metadata_invalid' || error === 'VALIDATION_ERROR') {
      return t('upload.errors.metadata');
    }
    if (error === 'cancelled') return t('upload.errors.cancelled');
    if (error === 'network') return t('errors.network');
    if (error === 'timeout') return t('errors.timeout');
    if (error === 'invalid_response') return t('errors.invalidResponse');
    if (error === 'MEDIA_UPLOAD_NOT_AVAILABLE') return t('upload.errors.unavailable');
    if (error === 'MEDIA_UPLOAD_LIMIT_REACHED') return t('upload.errors.limit');
    if (error === 'MEDIA_UPLOAD_INTENT_NOT_FOUND') return t('upload.errors.notFound');
    if (error === 'MEDIA_UPLOAD_INTENT_EXPIRED') return t('upload.errors.expired');
    if (error === 'MEDIA_UPLOAD_SIZE_MISMATCH') return t('upload.errors.sizeMismatch');
    if (error === 'MEDIA_UPLOAD_SIGNATURE_INVALID') return t('upload.errors.signature');
    if (error === 'MEDIA_UPLOAD_SVG_SANITIZATION_FAILED') {
      return t('upload.errors.svgSanitization');
    }
    if (error === 'MEDIA_SOURCE_CONFLICT') return t('errors.sourceConflict');
    return t('errors.api');
  }

  async function uploadOne(id: string): Promise<boolean> {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item || item.status !== 'ready' || !item.descriptor) return false;
    const authored = createManagedMediaUploadRequestSchema.safeParse({
      filename: item.file.name,
      size_bytes: item.file.size,
      width: item.width,
      height: item.height,
      duration_ms: item.durationMs,
      alt: item.descriptor.kind === 'image' ? item.alt : '',
    });
    if (!authored.success) {
      patchItem(id, { status: 'error', error: 'metadata_invalid' });
      return false;
    }
    const controller = new AbortController();
    controllers.current.set(id, controller);
    patchItem(id, { status: 'preparing', progress: 0, error: null });
    try {
      const uploaded = await storeManagedMediaFile({
        csrfToken: input.csrfToken,
        file: item.file,
        width: authored.data.width,
        height: authored.data.height,
        durationMs: authored.data.duration_ms,
        alt: authored.data.alt,
        signal: controller.signal,
        onStage: (stage) => {
          if (stage.kind === 'preparing') {
            patchItem(id, { status: 'preparing', progress: 0, error: null });
          } else if (stage.kind === 'uploading') {
            patchItem(id, { status: 'uploading', uploadId: stage.uploadId });
          }
        },
        onProgress: (loaded, total) => {
          patchItem(id, {
            progress: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
          });
        },
      });
      if (!uploaded.success) {
        if (uploaded.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return false;
        }
        patchItem(id, { status: 'error', error: uploaded.error.code });
        return false;
      }
      patchItem(id, { status: 'completed', progress: 100, uploadId: null });
      return true;
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        patchItem(id, { status: 'cancelled', error: 'cancelled' });
      } else if (error instanceof MediaClientError) {
        patchItem(id, {
          status: 'error',
          error: error.code === 'NETWORK_ERROR'
            ? 'network'
            : error.code === 'TIMEOUT' ? 'timeout' : 'invalid_response',
        });
      } else {
        patchItem(id, { status: 'error', error: 'invalid_response' });
      }
      return false;
    } finally {
      controllers.current.delete(id);
    }
  }

  async function startUpload() {
    if (running) return;
    const ids = itemsRef.current
      .filter((item) => item.status === 'ready')
      .map((item) => item.id);
    if (ids.length === 0) return;
    setRunning(true);
    input.onRunningChange(true);
    let cursor = 0;
    let completed = 0;
    async function worker() {
      while (cursor < ids.length) {
        const id = ids[cursor];
        cursor += 1;
        if (id && await uploadOne(id)) completed += 1;
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(input.concurrency, ids.length) }, worker),
    );
    setRunning(false);
    input.onRunningChange(false);
    if (completed > 0) {
      input.onUploaded();
    }
    if (completed === ids.length) {
      input.onClose();
    }
  }

  function cancelItem(item: UploadItem) {
    controllers.current.get(item.id)?.abort();
    patchItem(item.id, { status: 'cancelled', error: 'cancelled' });
  }

  const readyCount = items.filter((item) => item.status === 'ready').length;

  return (
    <div className="media-upload">
      <p className="media-upload-description">{t('upload.description', {
        max: humanBytes(input.maxBytes),
        svgMax: humanBytes(input.maxSvgBytes),
        files: input.maxFiles,
        concurrency: input.concurrency,
      })}</p>
      <div
        className="media-upload-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <label>
          <span className="media-upload-choose">{t('upload.choose')}</span>
          <input
            type="file"
            multiple
            accept={managedMediaUploadAcceptValue()}
            disabled={running || items.length >= input.maxFiles}
            onChange={onFilesSelected}
          />
        </label>
        <small className="media-upload-hint">{t('upload.dropHint')}</small>
      </div>
      {items.length > 0 ? (
        <ul className="media-upload-queue" aria-label={t('upload.queueLabel')}>
          {items.map((item) => (
            <li key={item.id}>
              <div className="media-upload-item-heading">
                <strong className="media-upload-item-name">
                  {item.file.name}
                </strong>
                <span className="media-upload-item-size">
                  {humanBytes(item.file.size)}
                </span>
              </div>
              <small className="media-upload-item-detail">{item.descriptor
                ? `${t(`kinds.${item.descriptor.kind}`)} · ${item.descriptor.mime_type}`
                : t('upload.inspecting')}</small>
              {item.descriptor?.kind === 'image' && item.status === 'ready' ? (
                <Field label={t('dialog.alt')}>
                  {(control) => (
                    <input
                      {...control}
                      type="text"
                      maxLength={1000}
                      value={item.alt}
                      onChange={(event) => patchItem(item.id, {
                        alt: event.target.value,
                      })}
                    />
                  )}
                </Field>
              ) : null}
              {item.status === 'uploading' ? (
                <progress value={item.progress} max={100}>{item.progress}%</progress>
              ) : null}
              <div className="media-upload-item-status">
                <span className="media-upload-item-detail">
                  {t(`upload.status.${item.status}`)}
                </span>
                {item.error ? (
                  <small className="media-upload-item-detail" role="alert">
                    {errorMessage(item.error)}
                  </small>
                ) : null}
                {['ready', 'error', 'cancelled'].includes(item.status)
                  && !running ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => commit((current) => (
                        current.filter((candidate) => candidate.id !== item.id)
                      ))}
                    >
                      {t('upload.remove')}
                    </Button>
                  ) : null}
                {['preparing', 'uploading'].includes(item.status) ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => cancelItem(item)}
                  >
                    {t('upload.cancelItem')}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <DialogActions>
        <Button
          ref={input.cancelRef}
          type="button"
          disabled={running}
          onClick={input.onClose}
        >
          {t('dialog.cancel')}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={running || readyCount === 0}
          onClick={() => void startUpload()}
        >
          {running ? t('upload.running') : t('upload.start', { count: readyCount })}
        </Button>
      </DialogActions>
    </div>
  );
}

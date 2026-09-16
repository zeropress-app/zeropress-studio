import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../../contracts/api';
import type { Media, MediaDelivery } from '../../../contracts/media';
import {
  isMediaImageUpscaleDimensioned,
  mediaImageUpscaleTileCount,
  type MediaImageUpscaleScale,
} from '../../../contracts/media-image-upscale';
import {
  MEDIA_IMAGE_EDITOR_MIME_TYPES,
  mediaImageEditorOutputMimeTypeSchema,
  type MediaImageEditorOutputMimeType,
} from '../../../contracts/media-image-editor';
import {
  MediaClientError,
  MediaImageEditorSourceError,
  requestMediaImageEditorSource,
} from '../lib/media-client';
import {
  MediaImageUpscaleError,
  upscaledMediaFilename,
  type MediaImageUpscaleProgress,
} from '../lib/media-image-upscale';
import { inspectMediaImageUpscaleSource } from '../lib/media-image-upscale-source';
import { storeManagedMediaFile } from '../lib/managed-media-upload';
import {
  Button,
  Dialog,
  Field,
  InlineStatus,
  Notice,
} from './primitives';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; code: string }
  | {
      kind: 'ready';
      blob: Blob;
      url: string;
      hasTransparency: boolean;
    };

type ResultState = {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  scale: MediaImageUpscaleScale;
  outputMimeType: MediaImageEditorOutputMimeType;
  quality: number;
};

type RunningState =
  | { kind: 'idle' }
  | { kind: 'upscale'; progress: MediaImageUpscaleProgress }
  | { kind: 'upload'; progress: number };

export function MediaImageUpscaleDialog(input: {
  media: Media;
  delivery: MediaDelivery;
  csrfToken: string;
  onClose: () => void;
  onSaved: (media: Media, delivery: MediaDelivery) => void;
  onSavedAndUse?: (media: Media, delivery: MediaDelivery) => void;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('media');
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [scale, setScale] = useState<MediaImageUpscaleScale>(2);
  const [outputMimeType, setOutputMimeType] = useState<MediaImageEditorOutputMimeType>(
    mediaImageEditorOutputMimeTypeSchema.parse(input.media.mime_type),
  );
  const [quality, setQuality] = useState(90);
  const [result, setResult] = useState<ResultState | null>(null);
  const [running, setRunning] = useState<RunningState>({ kind: 'idle' });
  const [failure, setFailure] = useState<string | null>(null);
  const operationRef = useRef<AbortController | null>(null);
  const width = input.media.width ?? 0;
  const height = input.media.height ?? 0;
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language),
    [i18n.language, i18n.resolvedLanguage],
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    void requestMediaImageEditorSource(
      input.media.id,
      input.media.revision,
      controller.signal,
    ).then(async (blob) => {
      const inspection = await inspectMediaImageUpscaleSource({
        blob,
        expectedWidth: width,
        expectedHeight: height,
      });
      if (!active) return;
      const url = URL.createObjectURL(blob);
      setLoadState({
        kind: 'ready',
        blob,
        url,
        hasTransparency: inspection.hasTransparency,
      });
    }).catch((error) => {
      if (!active || controller.signal.aborted) return;
      setLoadState({
        kind: 'error',
        code: error instanceof MediaImageEditorSourceError
          ? error.code
          : error instanceof MediaImageUpscaleError
            ? error.code
            : 'INVALID_RESPONSE',
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, height, input.media.id, input.media.revision, width]);

  useEffect(() => () => {
    if (loadState.kind === 'ready') URL.revokeObjectURL(loadState.url);
  }, [loadState]);

  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url);
  }, [result]);

  useEffect(() => () => operationRef.current?.abort(), []);

  function discardResult() {
    setResult(null);
    setFailure(null);
  }

  function errorMessage(code: string): string {
    if (code === 'AUTHENTICATION_REQUIRED') return t('imageUpscaler.errors.session');
    if (code === 'MEDIA_REVISION_CONFLICT') return t('imageUpscaler.errors.revision');
    if (code === 'MEDIA_NOT_FOUND') return t('imageUpscaler.errors.notFound');
    if (code === 'MEDIA_IMAGE_EDIT_UNSUPPORTED') return t('imageUpscaler.errors.unsupported');
    if (code === 'MEDIA_PREVIEW_NOT_FOUND') return t('imageUpscaler.errors.objectMissing');
    if (code === 'MEDIA_PREVIEW_NOT_AVAILABLE' || code === 'MEDIA_UPLOAD_NOT_AVAILABLE') {
      return t('imageUpscaler.errors.storageUnavailable');
    }
    if (code === 'WEBGL_UNAVAILABLE') return t('imageUpscaler.errors.webgl');
    if (code === 'MODEL_LOAD_FAILED') return t('imageUpscaler.errors.modelLoad');
    if (code === 'MODEL_INVALID') return t('imageUpscaler.errors.modelInvalid');
    if (code === 'OUTPUT_TOO_LARGE') return t('imageUpscaler.errors.outputTooLarge');
    if (code === 'ALPHA_JPEG_UNSUPPORTED') return t('imageUpscaler.errors.alphaJpeg');
    if (code === 'ENCODE_FAILED') return t('imageUpscaler.errors.encode');
    if (code === 'DECODE_FAILED' || code === 'SOURCE_DIMENSION_MISMATCH') {
      return t('imageUpscaler.errors.decode');
    }
    if (code === 'TIMEOUT') return t('errors.timeout');
    if (code === 'NETWORK_ERROR') return t('errors.network');
    return t('imageUpscaler.errors.inference');
  }

  async function generate() {
    if (running.kind !== 'idle' || loadState.kind !== 'ready') return;
    if (!isMediaImageUpscaleDimensioned(input.media, scale)) {
      setFailure(t('imageUpscaler.errors.outputTooLarge'));
      return;
    }
    const controller = new AbortController();
    operationRef.current = controller;
    setFailure(null);
    discardResult();
    setRunning({ kind: 'upscale', progress: { stage: 'preparing' } });
    try {
      const { upscaleMediaImage } = await import(
        '../lib/media-image-upscale-runtime'
      );
      const next = await upscaleMediaImage({
        blob: loadState.blob,
        width,
        height,
        scale,
        outputMimeType,
        quality: quality / 100,
        hasTransparency: loadState.hasTransparency,
        signal: controller.signal,
        onProgress: (progress) => setRunning({ kind: 'upscale', progress }),
      });
      if (controller.signal.aborted) return;
      setResult({
        ...next,
        url: URL.createObjectURL(next.blob),
        scale,
        outputMimeType,
        quality,
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof MediaImageUpscaleError
        ? error.code
        : 'INFERENCE_FAILED';
      setFailure(errorMessage(code));
      if (import.meta.env.DEV && !(error instanceof MediaImageUpscaleError)) {
        console.error('Media image upscale failed.', error);
      }
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
      setRunning({ kind: 'idle' });
    }
  }

  async function save(useAfterSave: boolean) {
    if (running.kind !== 'idle' || !result) return;
    const controller = new AbortController();
    operationRef.current = controller;
    setFailure(null);
    setRunning({ kind: 'upload', progress: 0 });
    try {
      const file = new File(
        [result.blob],
        upscaledMediaFilename(input.media.filename, result.outputMimeType, result.scale),
        { type: result.outputMimeType },
      );
      const response = await storeManagedMediaFile({
        csrfToken: input.csrfToken,
        file,
        width: result.width,
        height: result.height,
        alt: input.media.alt,
        signal: controller.signal,
        onProgress: (loaded, total) => setRunning({
          kind: 'upload',
          progress: total > 0 ? Math.round((loaded / total) * 100) : 0,
        }),
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure(errorMessage(response.error.code));
        return;
      }
      if (useAfterSave && input.onSavedAndUse) {
        input.onSavedAndUse(response.data, input.delivery);
      } else {
        input.onSaved(response.data, input.delivery);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      const code = error instanceof MediaClientError
        ? error.code
        : error instanceof MediaImageUpscaleError
          ? error.code
          : 'INVALID_RESPONSE';
      setFailure(errorMessage(code as ApiErrorCode | string));
    } finally {
      if (operationRef.current === controller) operationRef.current = null;
      setRunning({ kind: 'idle' });
    }
  }

  function cancelOrClose() {
    if (running.kind !== 'idle') {
      operationRef.current?.abort();
      return;
    }
    input.onClose();
  }

  function progressLabel(): string | null {
    if (running.kind === 'idle') return null;
    if (running.kind === 'upload') {
      return t('imageUpscaler.progress.uploading', { progress: running.progress });
    }
    if (running.progress.stage === 'preparing') {
      return t('imageUpscaler.progress.preparing');
    }
    if (running.progress.stage === 'loading_model') {
      return t('imageUpscaler.progress.loadingModel', {
        progress: Math.round(running.progress.progress * 100),
      });
    }
    if (running.progress.stage === 'processing') {
      return t('imageUpscaler.progress.processing', {
        completed: numberFormatter.format(running.progress.completed),
        total: numberFormatter.format(running.progress.total),
      });
    }
    return t('imageUpscaler.progress.encoding');
  }

  const supports4x = isMediaImageUpscaleDimensioned(input.media, 4);
  const tileCount = mediaImageUpscaleTileCount(width, height);
  const outputWidth = width * scale;
  const outputHeight = height * scale;
  const isRunning = running.kind !== 'idle';
  const status = progressLabel();

  return (
    <Dialog
      open
      size="editor"
      busy={isRunning}
      onClose={cancelOrClose}
      kicker={t('imageUpscaler.kicker')}
      title={t('imageUpscaler.title', { filename: input.media.filename })}
      description={t('imageUpscaler.description')}
      actions={(
        <>
          <Button type="button" onClick={cancelOrClose}>
            {isRunning ? t('imageUpscaler.cancelOperation') : t('dialog.cancel')}
          </Button>
          {result ? (
            <Button type="button" disabled={isRunning} onClick={() => void generate()}>
              {t('imageUpscaler.generateAgain')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              disabled={isRunning || loadState.kind !== 'ready'}
              onClick={() => void generate()}
            >
              {t('imageUpscaler.generate')}
            </Button>
          )}
          {result ? (
            <Button type="button" disabled={isRunning} onClick={() => void save(false)}>
              {t('imageUpscaler.save')}
            </Button>
          ) : null}
          {result && input.onSavedAndUse ? (
            <Button type="button" variant="primary" disabled={isRunning} onClick={() => void save(true)}>
              {t('imageUpscaler.saveAndUse')}
            </Button>
          ) : null}
        </>
      )}
    >
      {loadState.kind === 'loading' ? (
        <InlineStatus>{t('imageUpscaler.loading')}</InlineStatus>
      ) : null}
      {loadState.kind === 'error' ? (
        <Notice
          tone="error"
          actions={(
            <Button type="button" size="sm" onClick={() => setAttempt((value) => value + 1)}>
              {t('retry')}
            </Button>
          )}
        >
          {errorMessage(loadState.code)}
        </Notice>
      ) : null}
      {failure ? <Notice tone="error">{failure}</Notice> : null}
      {status ? <InlineStatus>{status}</InlineStatus> : null}
      {loadState.kind === 'ready' ? (
        <div className="media-image-upscaler">
          <div className="media-image-upscaler-options">
            <Field
              label={t('imageUpscaler.scale')}
              hint={t('imageUpscaler.scaleHint')}
            >
              {(control) => (
                <select
                  {...control}
                  value={scale}
                  disabled={isRunning}
                  onChange={(event) => {
                    setScale(Number(event.target.value) as MediaImageUpscaleScale);
                    discardResult();
                  }}
                >
                  <option value={2}>{t('imageUpscaler.scale2')}</option>
                  <option value={4} disabled={!supports4x}>
                    {supports4x
                      ? t('imageUpscaler.scale4')
                      : t('imageUpscaler.scale4Unavailable')}
                  </option>
                </select>
              )}
            </Field>
            <Field label={t('imageUpscaler.format')}>
              {(control) => (
                <select
                  {...control}
                  value={outputMimeType}
                  disabled={isRunning}
                  onChange={(event) => {
                    setOutputMimeType(event.target.value as MediaImageEditorOutputMimeType);
                    discardResult();
                  }}
                >
                  {MEDIA_IMAGE_EDITOR_MIME_TYPES.map((mimeType) => (
                    <option
                      key={mimeType}
                      value={mimeType}
                      disabled={loadState.hasTransparency && mimeType === 'image/jpeg'}
                    >
                      {mimeType.replace('image/', '').toUpperCase()}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {outputMimeType !== 'image/png' ? (
              <Field label={t('imageUpscaler.quality')}>
                {(control) => (
                  <input
                    {...control}
                    type="number"
                    min={10}
                    max={100}
                    value={quality}
                    disabled={isRunning}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isFinite(next)) {
                        setQuality(Math.max(10, Math.min(100, Math.round(next))));
                      }
                      discardResult();
                    }}
                  />
                )}
              </Field>
            ) : null}
          </div>
          <p className="media-image-upscaler-estimate">
            {t('imageUpscaler.estimate', {
              sourceWidth: numberFormatter.format(width),
              sourceHeight: numberFormatter.format(height),
              outputWidth: numberFormatter.format(outputWidth),
              outputHeight: numberFormatter.format(outputHeight),
              tiles: numberFormatter.format(tileCount),
            })}
          </p>
          <div className="media-image-upscaler-comparison">
            <figure>
              <figcaption>{t('imageUpscaler.original')}</figcaption>
              <img src={loadState.url} alt={input.media.alt} />
            </figure>
            <figure>
              <figcaption>{t('imageUpscaler.result')}</figcaption>
              {result ? (
                <>
                  <img src={result.url} alt={input.media.alt} />
                  <p>{t('imageUpscaler.resultMetadata', {
                    width: numberFormatter.format(result.width),
                    height: numberFormatter.format(result.height),
                    size: numberFormatter.format(result.blob.size),
                  })}</p>
                </>
              ) : (
                <div className="media-image-upscaler-placeholder">
                  {t('imageUpscaler.resultPending')}
                </div>
              )}
            </figure>
          </div>
          <p className="media-image-editor-note">
            {t('imageUpscaler.newMediaNote')}
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}

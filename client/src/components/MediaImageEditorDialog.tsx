import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../../contracts/api';
import type { Media, MediaDelivery } from '../../../contracts/media';
import {
  MEDIA_IMAGE_EDITOR_MAX_DIMENSION,
  mediaImageEditorOutputMimeTypeSchema,
  type MediaImageEditorOutputMimeType,
} from '../../../contracts/media-image-editor';
import {
  MediaClientError,
  MediaImageEditorSourceError,
  requestMediaImageEditorSource,
} from '../lib/media-client';
import {
  MEDIA_IMAGE_DEFAULT_FILTERS,
  MEDIA_IMAGE_FILTER_PRESETS,
  createMediaImageRenderWorkerRequest,
  drawMediaImage,
  editedMediaFilename,
  outputDimensionsForCrop,
  validateMediaImageTransformRecipe,
  type MediaImageFilterPreset,
  type MediaImageTransformRecipe,
} from '../lib/media-image-transform';
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
  | { kind: 'ready'; blob: Blob; url: string };

const FILTER_KEYS = [
  'brightness',
  'contrast',
  'saturation',
  'grayscale',
  'sepia',
  'hueRotate',
  'blur',
  'vignette',
  'sharpen',
] as const;

function initialRecipe(media: Media): MediaImageTransformRecipe {
  const width = media.width ?? 1;
  const height = media.height ?? 1;
  return {
    crop: { x: 0, y: 0, width, height },
    rotation: 0,
    flipHorizontal: false,
    flipVertical: false,
    outputWidth: width,
    outputHeight: height,
    ...MEDIA_IMAGE_DEFAULT_FILTERS,
  };
}

function renderOutput(input: {
  blob: Blob;
  recipe: MediaImageTransformRecipe;
  outputMimeType: MediaImageEditorOutputMimeType;
  quality: number;
  onProgress?: (progress: number) => void;
}): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/media-image-render.worker.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (event: MessageEvent<
      | { type: 'progress'; progress: number }
      | { type: 'result'; success: boolean; blob?: Blob; diagnostic?: string }
    >) => {
      if (event.data.type === 'progress') {
        input.onProgress?.(event.data.progress);
        return;
      }
      worker.terminate();
      if (event.data.success && event.data.blob) resolve(event.data.blob);
      else {
        if (import.meta.env.DEV && event.data.diagnostic) {
          console.error('Media image rendering Worker failed.', event.data.diagnostic);
        }
        reject(new Error('Image rendering failed.'));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('Image rendering failed.'));
    };
    // Functions are not structured-cloneable. Keep the progress callback on
    // the main thread and send only the explicit Worker request contract.
    worker.postMessage(createMediaImageRenderWorkerRequest(input));
  });
}

export function MediaImageEditorDialog(input: {
  media: Media;
  delivery: MediaDelivery;
  csrfToken: string;
  onClose: () => void;
  onSaved: (media: Media, delivery: MediaDelivery) => void;
  onSavedAndUse?: (media: Media, delivery: MediaDelivery) => void;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('media');
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [previewBitmap, setPreviewBitmap] = useState<ImageBitmap | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [recipe, setRecipe] = useState(() => initialRecipe(input.media));
  const [history, setHistory] = useState<MediaImageTransformRecipe[]>([]);
  const [future, setFuture] = useState<MediaImageTransformRecipe[]>([]);
  const [outputMimeType, setOutputMimeType] = useState<MediaImageEditorOutputMimeType>(
    mediaImageEditorOutputMimeTypeSchema.parse(input.media.mime_type),
  );
  const [quality, setQuality] = useState(90);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const cropSurfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const sourceWidth = input.media.width ?? 1;
  const sourceHeight = input.media.height ?? 1;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    void requestMediaImageEditorSource(
      input.media.id,
      input.media.revision,
      controller.signal,
    ).then((blob) => {
      if (!active) return;
      setLoadState({ kind: 'ready', blob, url: URL.createObjectURL(blob) });
    }).catch((error) => {
      if (!active || controller.signal.aborted) return;
      setLoadState({
        kind: 'error',
        code: error instanceof MediaImageEditorSourceError
          ? error.code
          : 'INVALID_RESPONSE',
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, input.media.id, input.media.revision]);

  useEffect(() => () => {
    if (loadState.kind === 'ready') URL.revokeObjectURL(loadState.url);
  }, [loadState]);

  useEffect(() => {
    if (loadState.kind !== 'ready') {
      setPreviewBitmap(null);
      return undefined;
    }
    setPreviewBitmap(null);
    let active = true;
    let bitmap: ImageBitmap | null = null;
    void createImageBitmap(loadState.blob).then((nextBitmap) => {
      if (!active) {
        nextBitmap.close();
        return;
      }
      bitmap = nextBitmap;
      setPreviewBitmap(nextBitmap);
    }).catch(() => setFailure(t('imageEditor.errors.render')));
    return () => {
      active = false;
      bitmap?.close();
    };
  }, [loadState, t]);

  useEffect(() => {
    if (!previewBitmap) return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const fitted = outputDimensionsForCrop({
      cropWidth: recipe.outputWidth,
      cropHeight: recipe.outputHeight,
      rotation: 0,
      maximumWidth: 720,
      maximumHeight: 460,
    });
    canvas.width = fitted.width;
    canvas.height = fitted.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    drawMediaImage({
      context,
      source: previewBitmap,
      recipe,
      targetWidth: fitted.width,
      targetHeight: fitted.height,
      outputMimeType,
    });
  }, [outputMimeType, previewBitmap, recipe]);

  function commit(next: MediaImageTransformRecipe) {
    if (!validateMediaImageTransformRecipe(next, sourceWidth, sourceHeight)) {
      setFailure(t('imageEditor.errors.invalidTransform'));
      return;
    }
    setHistory((current) => [...current.slice(-29), recipe]);
    setFuture([]);
    setRecipe(next);
    setFailure(null);
  }

  function updateCrop(crop: MediaImageTransformRecipe['crop']) {
    const output = outputDimensionsForCrop({
      cropWidth: crop.width,
      cropHeight: crop.height,
      rotation: recipe.rotation,
      maximumWidth: MEDIA_IMAGE_EDITOR_MAX_DIMENSION,
      maximumHeight: MEDIA_IMAGE_EDITOR_MAX_DIMENSION,
    });
    commit({ ...recipe, crop, outputWidth: output.width, outputHeight: output.height });
  }

  function point(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = cropSurfaceRef.current?.getBoundingClientRect();
    if (!bounds) return null;
    return {
      x: Math.max(0, Math.min(sourceWidth, ((event.clientX - bounds.left) / bounds.width) * sourceWidth)),
      y: Math.max(0, Math.min(sourceHeight, ((event.clientY - bounds.top) / bounds.height) * sourceHeight)),
    };
  }

  function beginCrop(event: ReactPointerEvent<HTMLDivElement>) {
    if (running) return;
    const next = point(event);
    if (!next) return;
    dragRef.current = next;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function endCrop(event: ReactPointerEvent<HTMLDivElement>) {
    const start = dragRef.current;
    const end = point(event);
    dragRef.current = null;
    if (!start || !end) return;
    const crop = {
      x: Math.round(Math.min(start.x, end.x)),
      y: Math.round(Math.min(start.y, end.y)),
      width: Math.max(1, Math.round(Math.abs(start.x - end.x))),
      height: Math.max(1, Math.round(Math.abs(start.y - end.y))),
    };
    crop.width = Math.min(crop.width, sourceWidth - crop.x);
    crop.height = Math.min(crop.height, sourceHeight - crop.y);
    updateCrop(crop);
  }

  function applyAspect(ratio: number | null) {
    if (ratio === null) {
      updateCrop({ x: 0, y: 0, width: sourceWidth, height: sourceHeight });
      return;
    }
    let width = sourceWidth;
    let height = Math.round(width / ratio);
    if (height > sourceHeight) {
      height = sourceHeight;
      width = Math.round(height * ratio);
    }
    updateCrop({
      x: Math.round((sourceWidth - width) / 2),
      y: Math.round((sourceHeight - height) / 2),
      width,
      height,
    });
  }

  function rotate() {
    const rotation = ((recipe.rotation + 90) % 360) as 0 | 90 | 180 | 270;
    const output = outputDimensionsForCrop({
      cropWidth: recipe.crop.width,
      cropHeight: recipe.crop.height,
      rotation,
    });
    commit({ ...recipe, rotation, outputWidth: output.width, outputHeight: output.height });
  }

  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setHistory((current) => current.slice(0, -1));
    setFuture((current) => [recipe, ...current].slice(0, 30));
    setRecipe(previous);
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    setFuture((current) => current.slice(1));
    setHistory((current) => [...current, recipe].slice(-30));
    setRecipe(next);
  }

  function applyPreset(preset: MediaImageFilterPreset) {
    const { id: presetId, ...filters } = preset;
    void presetId;
    commit({ ...recipe, ...filters });
  }

  function isPresetActive(preset: MediaImageFilterPreset): boolean {
    return FILTER_KEYS.every((key) => recipe[key] === preset[key]);
  }

  function filterBounds(key: typeof FILTER_KEYS[number]) {
    if (key === 'hueRotate') return { min: -180, max: 180 };
    if (key === 'blur') return { min: 0, max: 20 };
    if (key === 'brightness' || key === 'contrast' || key === 'saturation') {
      return { min: 0, max: 200 };
    }
    return { min: 0, max: 100 };
  }

  function filterValue(key: typeof FILTER_KEYS[number]): string {
    if (key === 'hueRotate') return `${recipe[key]}°`;
    if (key === 'blur') return `${recipe[key]} px`;
    return `${recipe[key]}%`;
  }

  function presetPreviewFilter(preset: MediaImageFilterPreset): string {
    return [
      `brightness(${preset.brightness}%)`,
      `contrast(${preset.contrast}%)`,
      `saturate(${preset.saturation}%)`,
      `grayscale(${preset.grayscale}%)`,
      `sepia(${preset.sepia}%)`,
      `hue-rotate(${preset.hueRotate}deg)`,
      `blur(${preset.blur}px)`,
    ].join(' ');
  }

  function errorMessage(code: string): string {
    if (code === 'AUTHENTICATION_REQUIRED') return t('imageEditor.errors.session');
    if (code === 'MEDIA_REVISION_CONFLICT') return t('imageEditor.errors.revision');
    if (code === 'MEDIA_NOT_FOUND') return t('imageEditor.errors.notFound');
    if (code === 'MEDIA_IMAGE_EDIT_UNSUPPORTED') return t('imageEditor.errors.unsupported');
    if (code === 'MEDIA_PREVIEW_NOT_FOUND') return t('imageEditor.errors.objectMissing');
    if (code === 'MEDIA_PREVIEW_NOT_AVAILABLE' || code === 'MEDIA_UPLOAD_NOT_AVAILABLE') {
      return t('imageEditor.errors.unavailable');
    }
    if (code === 'TIMEOUT') return t('errors.timeout');
    if (code === 'NETWORK_ERROR') return t('errors.network');
    return t('imageEditor.errors.render');
  }

  async function save(useAfterSave: boolean) {
    if (running || loadState.kind !== 'ready') return;
    setRunning(true);
    setProgress(0);
    setFailure(null);
    try {
      const blob = await renderOutput({
        blob: loadState.blob,
        recipe,
        outputMimeType,
        quality: quality / 100,
        onProgress: (value) => setProgress(Math.round(value * 40)),
      });
      setProgress(40);
      const file = new File(
        [blob],
        editedMediaFilename(input.media.filename, outputMimeType),
        { type: outputMimeType },
      );
      const response = await storeManagedMediaFile({
        csrfToken: input.csrfToken,
        file,
        width: recipe.outputWidth,
        height: recipe.outputHeight,
        alt: input.media.alt,
        onProgress: (loaded, total) => setProgress(
          total > 0
            ? Math.min(100, 40 + Math.round((loaded / total) * 60))
            : 40,
        ),
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
      const code = error instanceof MediaClientError
        ? error.code
        : error instanceof MediaImageEditorSourceError
          ? error.code
          : 'INVALID_RESPONSE';
      setFailure(errorMessage(code as ApiErrorCode | string));
    } finally {
      setRunning(false);
    }
  }

  const cropStyle = useMemo(() => ({
    left: `${(recipe.crop.x / sourceWidth) * 100}%`,
    top: `${(recipe.crop.y / sourceHeight) * 100}%`,
    width: `${(recipe.crop.width / sourceWidth) * 100}%`,
    height: `${(recipe.crop.height / sourceHeight) * 100}%`,
  }), [recipe.crop, sourceHeight, sourceWidth]);

  return (
    <Dialog
      open
      size="editor"
      busy={running}
      onClose={input.onClose}
      kicker={t('imageEditor.kicker')}
      title={t('imageEditor.title', { filename: input.media.filename })}
      description={t('imageEditor.description')}
      actions={(
        <>
          <Button type="button" disabled={running} onClick={input.onClose}>{t('dialog.cancel')}</Button>
          <Button type="button" disabled={running || loadState.kind !== 'ready'} onClick={() => void save(false)}>
            {running
              ? t('imageEditor.saving', { progress })
              : t('imageEditor.save')}
          </Button>
          {input.onSavedAndUse ? (
            <Button type="button" variant="primary" disabled={running || loadState.kind !== 'ready'} onClick={() => void save(true)}>
              {running
                ? t('imageEditor.saving', { progress })
                : t('imageEditor.saveAndUse')}
            </Button>
          ) : null}
        </>
      )}
    >
      {loadState.kind === 'loading' ? <InlineStatus>{t('imageEditor.loading')}</InlineStatus> : null}
      {loadState.kind === 'error' ? (
        <Notice
          tone="error"
          actions={<Button type="button" size="sm" onClick={() => setAttempt((value) => value + 1)}>{t('retry')}</Button>}
        >
          {errorMessage(loadState.code)}
        </Notice>
      ) : null}
      {failure ? <Notice tone="error">{failure}</Notice> : null}
      {loadState.kind === 'ready' ? (
        <div className="media-image-editor">
          <div className="media-image-editor-stage">
            <div className="media-image-editor-crop-viewport">
              <div
                ref={cropSurfaceRef}
                className="media-image-editor-crop-surface"
                style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}` }}
                onPointerDown={beginCrop}
                onPointerUp={endCrop}
              >
                <img src={loadState.url} alt="" draggable={false} />
                <span className="media-image-editor-crop-selection" style={cropStyle} />
              </div>
            </div>
            <div className="media-image-editor-output">
              <canvas ref={previewCanvasRef} aria-label={t('imageEditor.preview')} />
            </div>
          </div>
          <div className="media-image-editor-tools">
            <fieldset>
              <legend>{t('imageEditor.crop')}</legend>
              <div className="media-image-editor-button-row">
                <Button type="button" size="sm" onClick={() => applyAspect(null)}>{t('imageEditor.aspect.original')}</Button>
                <Button type="button" size="sm" onClick={() => applyAspect(1)}>{t('imageEditor.aspect.square')}</Button>
                <Button type="button" size="sm" onClick={() => applyAspect(4 / 3)}>4:3</Button>
                <Button type="button" size="sm" onClick={() => applyAspect(16 / 9)}>16:9</Button>
              </div>
              <div className="media-image-editor-grid-fields">
                {(['x', 'y', 'width', 'height'] as const).map((key) => (
                  <Field key={key} label={t(`imageEditor.cropFields.${key}`)}>
                    {(control) => (
                      <input
                        {...control}
                        type="number"
                        min={key === 'width' || key === 'height' ? 1 : 0}
                        max={key === 'x' || key === 'width' ? sourceWidth : sourceHeight}
                        value={recipe.crop[key]}
                        onChange={(event) => updateCrop({
                          ...recipe.crop,
                          [key]: Math.round(Number(event.target.value)),
                        })}
                      />
                    )}
                  </Field>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend>{t('imageEditor.transform')}</legend>
              <div className="media-image-editor-button-row">
                <Button type="button" size="sm" onClick={rotate}>{t('imageEditor.rotate')}</Button>
                <Button type="button" size="sm" onClick={() => commit({ ...recipe, flipHorizontal: !recipe.flipHorizontal })}>{t('imageEditor.flipHorizontal')}</Button>
                <Button type="button" size="sm" onClick={() => commit({ ...recipe, flipVertical: !recipe.flipVertical })}>{t('imageEditor.flipVertical')}</Button>
                <Button type="button" size="sm" disabled={history.length === 0} onClick={undo}>{t('imageEditor.undo')}</Button>
                <Button type="button" size="sm" disabled={future.length === 0} onClick={redo}>{t('imageEditor.redo')}</Button>
              </div>
            </fieldset>
            <fieldset>
              <legend>{t('imageEditor.output')}</legend>
              <div className="media-image-editor-grid-fields">
                <Field label={t('imageEditor.outputWidth')}>
                  {(control) => <input {...control} type="number" min={1} max={MEDIA_IMAGE_EDITOR_MAX_DIMENSION} value={recipe.outputWidth} onChange={(event) => {
                    const outputWidth = Math.round(Number(event.target.value));
                    const ratio = recipe.outputHeight / recipe.outputWidth;
                    commit({ ...recipe, outputWidth, outputHeight: Math.max(1, Math.round(outputWidth * ratio)) });
                  }} />}
                </Field>
                <Field label={t('imageEditor.outputHeight')}>
                  {(control) => <input {...control} type="number" min={1} max={MEDIA_IMAGE_EDITOR_MAX_DIMENSION} value={recipe.outputHeight} onChange={(event) => {
                    const outputHeight = Math.round(Number(event.target.value));
                    const ratio = recipe.outputWidth / recipe.outputHeight;
                    commit({ ...recipe, outputHeight, outputWidth: Math.max(1, Math.round(outputHeight * ratio)) });
                  }} />}
                </Field>
                <Field label={t('imageEditor.format')}>
                  {(control) => (
                    <select {...control} value={outputMimeType} onChange={(event) => setOutputMimeType(mediaImageEditorOutputMimeTypeSchema.parse(event.target.value))}>
                      <option value="image/jpeg">JPEG</option>
                      <option value="image/png">PNG</option>
                      <option value="image/webp">WebP</option>
                    </select>
                  )}
                </Field>
                {outputMimeType !== 'image/png' ? (
                  <Field label={t('imageEditor.quality')}>
                    {(control) => <input {...control} type="number" min={50} max={100} value={quality} onChange={(event) => setQuality(Math.round(Number(event.target.value)))} />}
                  </Field>
                ) : null}
              </div>
            </fieldset>
            <fieldset>
              <legend>{t('imageEditor.filters')}</legend>
              <div className="media-image-editor-preset-grid" aria-label={t('imageEditor.presetsLabel')}>
                {MEDIA_IMAGE_FILTER_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="media-image-editor-preset"
                    aria-pressed={isPresetActive(preset)}
                    disabled={running}
                    onClick={() => applyPreset(preset)}
                  >
                    <span className="media-image-editor-preset-preview" aria-hidden="true">
                      <img
                        src={loadState.url}
                        alt=""
                        draggable={false}
                        style={{ filter: presetPreviewFilter(preset) }}
                      />
                    </span>
                    <span>{t(`imageEditor.presets.${preset.id}`)}</span>
                  </button>
                ))}
              </div>
              <div className="media-image-editor-filter-grid">
                {FILTER_KEYS.map((key) => (
                  <Field key={key} label={t(`imageEditor.filterFields.${key}`)}>
                    {(control) => {
                      const bounds = filterBounds(key);
                      return (
                        <span className="media-image-editor-filter-control">
                          <input
                            {...control}
                            type="range"
                            min={bounds.min}
                            max={bounds.max}
                            value={recipe[key]}
                            onChange={(event) => commit({ ...recipe, [key]: Number(event.target.value) })}
                          />
                          <output htmlFor={control.id}>{filterValue(key)}</output>
                        </span>
                      );
                    }}
                  </Field>
                ))}
              </div>
              <Button type="button" size="sm" variant="ghost" onClick={() => commit({ ...recipe, ...MEDIA_IMAGE_DEFAULT_FILTERS })}>{t('imageEditor.resetFilters')}</Button>
            </fieldset>
            <p className="media-image-editor-note">{t('imageEditor.newMediaNote')}</p>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

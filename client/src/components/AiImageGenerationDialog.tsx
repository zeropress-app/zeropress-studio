import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AI_IMAGE_PROMPT_MAX_CODE_POINTS,
  AI_IMAGE_SEED_MAX,
  generateAiImageRequestSchema,
  type AiImageAspectRatio,
} from '../../../contracts/ai-image';
import {
  MEDIA_ALT_MAX_CODE_POINTS,
  type Media,
  type MediaDelivery,
} from '../../../contracts/media';
import {
  MediaClientError,
  requestGenerateAiImage,
} from '../lib/media-client';
import { resolveMediaPreviewUrl } from '../lib/media-preview';
import { MediaPreview } from './MediaPreview';
import { Button, Dialog, Field, Notice } from './primitives';

type GeneratedResult = {
  media: Media;
  seed: number;
};

export function AiImageGenerationDialog(input: {
  csrfToken: string;
  delivery: MediaDelivery;
  onClose: () => void;
  onGenerated?: (media: Media) => void;
  onUse?: (media: Media, delivery: MediaDelivery) => void;
  useLabel?: string;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('media');
  const closeRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const [prompt, setPrompt] = useState('');
  const [alt, setAlt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<AiImageAspectRatio>('landscape');
  const [seed, setSeed] = useState('');
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [generated, setGenerated] = useState<GeneratedResult | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);

  const promptLength = Array.from(prompt.trim()).length;
  const promptInvalid = promptLength < 1
    || promptLength > AI_IMAGE_PROMPT_MAX_CODE_POINTS;
  const altInvalid = Array.from(alt.trim()).length > MEDIA_ALT_MAX_CODE_POINTS;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const seedNumber = seed.trim() === '' ? undefined : Number(seed);
    const parsed = generateAiImageRequestSchema.safeParse({
      prompt,
      alt,
      aspect_ratio: aspectRatio,
      seed: seedNumber,
    });
    if (!parsed.success) {
      setFailure(t('aiImage.errors.validation'));
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setRunning(true);
    try {
      const response = await requestGenerateAiImage(
        input.csrfToken,
        parsed.data,
        controller.signal,
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        if (response.error.code === 'AI_REQUEST_RATE_LIMITED') {
          setFailure(t('aiImage.errors.rateLimited'));
        } else if (response.error.code === 'AI_IMAGE_CONTENT_REJECTED') {
          setFailure(t('aiImage.errors.contentRejected'));
        } else if (response.error.code === 'AI_IMAGE_RESPONSE_INVALID') {
          setFailure(t('aiImage.errors.invalidOutput'));
        } else if (response.error.code === 'AI_SERVICE_UNAVAILABLE') {
          setFailure(t('aiImage.errors.unavailable'));
        } else if (response.error.code === 'MEDIA_UPLOAD_NOT_AVAILABLE') {
          setFailure(t('aiImage.errors.storageUnavailable'));
        } else if (response.error.code === 'FORBIDDEN') {
          setFailure(t('errors.forbidden'));
        } else {
          setFailure(t('aiImage.errors.api'));
        }
        return;
      }
      const result = {
        media: response.data.media,
        seed: response.data.generation.seed,
      };
      setGenerated(result);
      input.onGenerated?.(result.media);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof MediaClientError && error.code === 'TIMEOUT') {
        setFailure(t('aiImage.errors.timeout'));
      } else if (
        error instanceof MediaClientError
        && error.code === 'NETWORK_ERROR'
      ) {
        setFailure(t('errors.network'));
      } else {
        setFailure(t('errors.invalidResponse'));
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      setRunning(false);
    }
  }

  return (
    <Dialog
      open
      busy={running}
      size="wide"
      onClose={input.onClose}
      initialFocusRef={closeRef}
      kicker={t('aiImage.kicker')}
      title={t('aiImage.title')}
      description={t('aiImage.description')}
      actions={(
        <>
          <Button
            ref={closeRef}
            type="button"
            disabled={running}
            onClick={input.onClose}
          >
            {t('aiImage.close')}
          </Button>
          {generated && input.onUse ? (
            <Button
              type="button"
              variant="primary"
              disabled={running}
              onClick={() => input.onUse?.(generated.media, input.delivery)}
            >
              {input.useLabel ?? t('aiImage.use')}
            </Button>
          ) : null}
        </>
      )}
    >
      <form className="ai-image-form" onSubmit={submit}>
        <Field
          label={t('aiImage.prompt')}
          hint={t('aiImage.promptHint', {
            count: promptLength,
            max: AI_IMAGE_PROMPT_MAX_CODE_POINTS,
          })}
        >
          {(control) => (
            <textarea
              {...control}
              rows={5}
              value={prompt}
              disabled={running}
              aria-invalid={promptLength > AI_IMAGE_PROMPT_MAX_CODE_POINTS}
              onChange={(event) => setPrompt(event.target.value)}
            />
          )}
        </Field>
        <div className="ai-image-options">
          <Field label={t('aiImage.aspectRatio')}>
            {(control) => (
              <select
                {...control}
                value={aspectRatio}
                disabled={running}
                onChange={(event) => setAspectRatio(
                  event.target.value as AiImageAspectRatio,
                )}
              >
                <option value="landscape">{t('aiImage.aspect.landscape')}</option>
                <option value="square">{t('aiImage.aspect.square')}</option>
                <option value="portrait">{t('aiImage.aspect.portrait')}</option>
              </select>
            )}
          </Field>
          <Field label={t('aiImage.seed')} hint={t('aiImage.seedHint')}>
            {(control) => (
              <input
                {...control}
                type="number"
                min={0}
                max={AI_IMAGE_SEED_MAX}
                step={1}
                value={seed}
                disabled={running}
                onChange={(event) => setSeed(event.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label={t('aiImage.alt')} hint={t('aiImage.altHint')}>
          {(control) => (
            <input
              {...control}
              type="text"
              value={alt}
              disabled={running}
              aria-invalid={altInvalid}
              onChange={(event) => setAlt(event.target.value)}
            />
          )}
        </Field>
        {failure ? <Notice tone="error">{failure}</Notice> : null}
        {generated ? (
          <div className="ai-image-result">
            <MediaPreview
              media={generated.media}
              source={resolveMediaPreviewUrl(generated.media, input.delivery)}
              kindLabel={t('kinds.image')}
              unavailableLabel={t('previewUnavailable')}
              className="ai-image-result-preview"
            />
            <div>
              <strong>{t('aiImage.saved')}</strong>
              <p>{generated.media.filename}</p>
              <small>
                {generated.media.width}×{generated.media.height}
                {' · '}
                {t('aiImage.seedValue', { seed: generated.seed })}
              </small>
            </div>
          </div>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          disabled={running || promptInvalid || altInvalid}
        >
          {running
            ? t('aiImage.generating')
            : generated
              ? t('aiImage.generateAnother')
              : t('aiImage.generate')}
        </Button>
      </form>
    </Dialog>
  );
}

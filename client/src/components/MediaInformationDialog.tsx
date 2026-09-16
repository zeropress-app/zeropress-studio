import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MEDIA_REFERENCES_DEFAULT_PAGE_SIZE,
  createManagedMediaReference,
  mediaLocationLabel,
  type Media,
  type MediaDelivery,
  type MediaUsageReference,
} from '../../../contracts/media';
import type { MediaAiGeneration } from '../../../contracts/media-ai-generation';
import { isMediaImageEditable } from '../../../contracts/media-image-editor';
import { isMediaImageUpscalable } from '../../../contracts/media-image-upscale';
import { requestMediaInformation } from '../lib/media-client';
import { resolveMediaPreviewUrl } from '../lib/media-preview';
import {
  STUDIO_PATHS,
  studioPagePath,
  studioPostPath,
} from '../routing/studio-routes';
import { MediaPreview } from './MediaPreview';
import {
  Button,
  ButtonLink,
  Dialog,
  InlineStatus,
  Notice,
  Pagination,
} from './primitives';

function referencePath(reference: MediaUsageReference): string {
  if (reference.type === 'post') return studioPostPath(reference.id);
  if (reference.type === 'page') return studioPagePath(reference.id);
  if (reference.type === 'author') {
    const params = new URLSearchParams({
      search: reference.display_name,
      edit: reference.id,
    });
    return `${STUDIO_PATHS.authors}?${params}`;
  }
  return STUDIO_PATHS.brandingSettings;
}

function referenceName(reference: MediaUsageReference): string {
  if (reference.type === 'post' || reference.type === 'page') {
    return reference.title;
  }
  if (reference.type === 'author') return reference.display_name;
  return reference.slot;
}

export function MediaInformationDialog(input: {
  media: Media;
  delivery: MediaDelivery;
  canManage: boolean;
  onClose: () => void;
  onSessionEnded: () => void;
  onEditMetadata?: () => void;
  onEditImage?: () => void;
  onUpscaleImage?: () => void;
}) {
  const { t, i18n } = useTranslation('media');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [references, setReferences] = useState<
    | { kind: 'idle' | 'loading' | 'error' }
    | {
        kind: 'ready';
        items: MediaUsageReference[];
        generation: MediaAiGeneration | null;
        total: number;
        totalPages: number;
      }
  >({ kind: input.canManage ? 'loading' : 'idle' });
  const [copied, setCopied] = useState(false);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    { dateStyle: 'medium', timeStyle: 'short' },
  ), [i18n.resolvedLanguage]);
  const preview = resolveMediaPreviewUrl(input.media, input.delivery);
  const publicReference = input.media.location.type === 'external'
    ? input.media.location.url
    : input.delivery.media_origin
      ? `${input.delivery.media_origin}/${input.media.location.key}`
      : `/${input.media.location.key}`;
  const contentReference = input.media.location.type === 'external'
    ? input.media.location.url
    : createManagedMediaReference(input.media.location.key);

  useEffect(() => {
    if (!input.canManage) return undefined;
    const controller = new AbortController();
    let active = true;
    setReferences({ kind: 'loading' });
    void requestMediaInformation(input.media.id, {
      page,
      per_page: MEDIA_REFERENCES_DEFAULT_PAGE_SIZE,
    }, controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setReferences({ kind: 'error' });
        return;
      }
      setReferences({
        kind: 'ready',
        items: response.data.references.items,
        generation: response.data.generation,
        total: response.data.references.pagination.total,
        totalPages: response.data.references.pagination.total_pages,
      });
    }).catch(() => {
      if (active && !controller.signal.aborted) setReferences({ kind: 'error' });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, input.canManage, input.media.id, input.onSessionEnded, page]);

  async function copyReference() {
    try {
      await navigator.clipboard.writeText(contentReference);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog
      open
      size="wide"
      initialFocus="title"
      onClose={input.onClose}
      kicker={t('information.kicker')}
      title={input.media.filename}
      description={t('information.description')}
      actions={(
        <>
          {input.onEditImage && isMediaImageEditable(input.media) ? (
            <Button type="button" onClick={input.onEditImage}>
              {t('imageEditor.action')}
            </Button>
          ) : null}
          {input.onUpscaleImage && isMediaImageUpscalable(input.media) ? (
            <Button type="button" onClick={input.onUpscaleImage}>
              {t('imageUpscaler.action')}
            </Button>
          ) : null}
          {input.onEditMetadata ? (
            <Button type="button" variant="ghost" onClick={input.onEditMetadata}>
              {t('actions.edit')}
            </Button>
          ) : null}
          <Button type="button" variant="primary" onClick={input.onClose}>
            {t('picker.close')}
          </Button>
        </>
      )}
    >
      <div className="media-information-layout">
        <div className="media-information-preview">
          <MediaPreview
            media={input.media}
            source={preview}
            kindLabel={t(`kinds.${input.media.kind}`)}
            unavailableLabel={t('previewUnavailable')}
            className="media-information-image"
          />
        </div>
        <dl className="media-information-grid">
          <div><dt>{t('information.id')}</dt><dd><code>{input.media.id}</code></dd></div>
          <div><dt>{t('information.kind')}</dt><dd>{t(`kinds.${input.media.kind}`)}</dd></div>
          <div><dt>{t('information.storage')}</dt><dd>{t(`storage.${input.media.location.type}`)}</dd></div>
          <div><dt>{t('information.mimeType')}</dt><dd><code>{input.media.mime_type}</code></dd></div>
          <div><dt>{t('information.location')}</dt><dd><code>{mediaLocationLabel(input.media.location)}</code></dd></div>
          <div><dt>{t('information.publicReference')}</dt><dd><code>{publicReference}</code></dd></div>
          <div><dt>{t('information.size')}</dt><dd>{input.media.size_bytes ?? t('information.unknown')}</dd></div>
          <div><dt>{t('information.dimensions')}</dt><dd>{input.media.width && input.media.height ? `${input.media.width}×${input.media.height}` : t('information.unknown')}</dd></div>
          <div><dt>{t('information.duration')}</dt><dd>{input.media.duration_ms === null ? t('information.unknown') : `${input.media.duration_ms} ms`}</dd></div>
          <div><dt>{t('information.collection')}</dt><dd>{input.media.collection?.name ?? t('collections.unfiled')}</dd></div>
          <div><dt>{t('information.created')}</dt><dd>{dateFormatter.format(new Date(input.media.created_at_iso))}</dd></div>
          <div><dt>{t('information.updated')}</dt><dd>{dateFormatter.format(new Date(input.media.updated_at_iso))}</dd></div>
          <div className="media-information-wide"><dt>{t('information.alt')}</dt><dd>{input.media.alt || t('information.empty')}</dd></div>
        </dl>
      </div>
      <div className="media-information-copy">
        <code>{contentReference}</code>
        <Button type="button" size="sm" onClick={() => void copyReference()}>
          {copied ? t('information.copied') : t('information.copyReference')}
        </Button>
        {preview ? (
          <ButtonLink external to={preview} size="sm" variant="ghost">
            {t('information.open')}
          </ButtonLink>
        ) : null}
      </div>
      {references.kind === 'ready' && references.generation ? (
        <section
          className="media-information-generation"
          aria-labelledby="media-information-generation-title"
        >
          <h3 id="media-information-generation-title">
            {t('information.aiGeneration')}
          </h3>
          <dl className="media-information-generation-grid">
            <div>
              <dt>{t('information.aiModel')}</dt>
              <dd><code>{references.generation.model}</code></dd>
            </div>
            <div>
              <dt>{t('information.aiPromptVersion')}</dt>
              <dd><code>{references.generation.prompt_version}</code></dd>
            </div>
            <div>
              <dt>{t('information.aiAspectRatio')}</dt>
              <dd>{t(`aiImage.aspect.${references.generation.aspect_ratio}`)}</dd>
            </div>
            <div>
              <dt>{t('information.aiSeed')}</dt>
              <dd><code>{references.generation.seed}</code></dd>
            </div>
            <div className="media-information-generation-prompt">
              <dt>{t('information.aiPrompt')}</dt>
              <dd>{references.generation.prompt}</dd>
            </div>
          </dl>
        </section>
      ) : null}
      {input.canManage ? (
        <section className="media-information-references" aria-labelledby="media-information-references-title">
          <h3 id="media-information-references-title">
            {t('information.references')}
          </h3>
          {references.kind === 'loading' ? (
            <InlineStatus>{t('references.loading')}</InlineStatus>
          ) : references.kind === 'error' ? (
            <Notice
              tone="error"
              actions={<Button type="button" size="sm" onClick={() => setAttempt((value) => value + 1)}>{t('retry')}</Button>}
            >
              {t('information.additionalInformationError')}
            </Notice>
          ) : references.kind === 'ready' && references.total > 0 ? (
            <>
              <ul className="media-reference-list">
                {references.items.map((reference) => (
                  <li key={`${reference.type}:${reference.type === 'branding' ? reference.slot : reference.id}`}>
                    <span>{referenceName(reference)}</span>
                    <ButtonLink external size="sm" variant="ghost" to={referencePath(reference)}>
                      {t('references.open')}
                    </ButtonLink>
                  </li>
                ))}
              </ul>
              {references.totalPages > 1 ? (
                <Pagination
                  label={t('references.pagination.label')}
                  position={t('references.pagination.position', { page, pages: references.totalPages })}
                  previousLabel={t('references.pagination.previous')}
                  nextLabel={t('references.pagination.next')}
                  page={page}
                  totalPages={references.totalPages}
                  onChange={setPage}
                />
              ) : null}
            </>
          ) : references.kind === 'ready' ? (
            <p>{t('information.notReferenced')}</p>
          ) : null}
        </section>
      ) : null}
    </Dialog>
  );
}

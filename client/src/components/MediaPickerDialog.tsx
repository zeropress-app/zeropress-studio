import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  MEDIA_DEFAULT_PAGE_SIZE,
  mediaKinds,
  mediaLocationLabel,
  type Media,
  type MediaCollection,
  type MediaDelivery,
  type MediaKind,
  type MediaListQuery,
} from '../../../contracts/media';
import { isMediaImageEditable } from '../../../contracts/media-image-editor';
import { isMediaImageUpscalable } from '../../../contracts/media-image-upscale';
import {
  requestMediaCollections,
  requestMediaList,
} from '../lib/media-client';
import { resolveMediaPreviewUrl } from '../lib/media-preview';
import { STUDIO_PATHS } from '../routing/studio-routes';
import { MediaPreview } from './MediaPreview';
import { AiImageGenerationDialog } from './AiImageGenerationDialog';
import { MediaInformationDialog } from './MediaInformationDialog';
import { MediaImageEditorDialog } from './MediaImageEditorDialog';
import { MediaImageUpscaleDialog } from './MediaImageUpscaleDialog';
import {
  Button,
  ButtonLink,
  Dialog,
  EmptyState,
  Field,
  InlineStatus,
  Notice,
  Pagination,
} from './primitives';

type CollectionScope = MediaListQuery['collection'];
type KindFilter = MediaListQuery['kind'];
type LoadState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | {
      kind: 'ready';
      items: Media[];
      pagination: {
        page: number;
        per_page: number;
        total: number;
        total_pages: number;
      };
      delivery: MediaDelivery;
    };
type CatalogState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; items: MediaCollection[] };

export type MediaPickerCopy = {
  kicker: string;
  title: string;
  description: string;
  select: string;
  selectNamed: (filename: string) => string;
  emptyTitle: string;
  emptyDescription: string;
};

export function MediaPickerDialog(input: {
  purpose: MediaListQuery['purpose'];
  copy: MediaPickerCopy;
  selectedId?: string | null;
  onClose: () => void;
  onSelect: (media: Media, delivery: MediaDelivery) => void;
  onSessionEnded: () => void;
  showManageLink?: boolean;
  aiGenerationCsrfToken?: string;
  mediaManagementCsrfToken?: string;
  errorMessage?: string | null;
}) {
  const { t } = useTranslation('media');
  const closeRef = useRef<HTMLButtonElement>(null);
  const onSessionEndedRef = useRef(input.onSessionEnded);
  onSessionEndedRef.current = input.onSessionEnded;
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [catalogState, setCatalogState] = useState<CatalogState>({
    kind: 'loading',
  });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [collection, setCollection] = useState<CollectionScope>('all');
  const [page, setPage] = useState(1);
  const [aiGenerationOpen, setAiGenerationOpen] = useState(false);
  const [informationMedia, setInformationMedia] = useState<Media | null>(null);
  const [editingMedia, setEditingMedia] = useState<Media | null>(null);
  const [upscalingMedia, setUpscalingMedia] = useState<Media | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setCatalogState({ kind: 'loading' });
    void requestMediaCollections(controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          onSessionEndedRef.current();
          return;
        }
        setCatalogState({ kind: 'error' });
        return;
      }
      setCatalogState({ kind: 'ready', items: response.data.items });
    }).catch(() => {
      if (active && !controller.signal.aborted) {
        setCatalogState({ kind: 'error' });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [loadAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    void requestMediaList({
      search,
      kind: input.purpose === 'all' ? kind : 'all',
      purpose: input.purpose,
      collection,
      page,
      per_page: MEDIA_DEFAULT_PAGE_SIZE,
    }, controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          onSessionEndedRef.current();
          return;
        }
        setLoadState({ kind: 'error' });
        return;
      }
      setLoadState({ kind: 'ready', ...response.data });
    }).catch(() => {
      if (active && !controller.signal.aborted) setLoadState({ kind: 'error' });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [collection, input.purpose, kind, loadAttempt, page, search]);

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  }

  const catalog = catalogState.kind === 'ready' ? catalogState.items : [];
  const failed = loadState.kind === 'error' || catalogState.kind === 'error';

  return (
    <>
      <Dialog
      open
      size="wide"
      onClose={input.onClose}
      kicker={input.copy.kicker}
      title={input.copy.title}
      description={input.copy.description}
      initialFocusRef={closeRef}
      actions={(
        <>
          {input.aiGenerationCsrfToken
            && input.purpose !== 'branding_favicon'
            && loadState.kind === 'ready' ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setAiGenerationOpen(true)}
            >
              {t('aiImage.action')}
            </Button>
          ) : null}
          {input.showManageLink !== false ? (
            <ButtonLink variant="ghost" external to={STUDIO_PATHS.media}>
              {t('picker.manage')}
            </ButtonLink>
          ) : null}
          <Button ref={closeRef} type="button" onClick={input.onClose}>
            {t('picker.close')}
          </Button>
        </>
      )}
    >
      <div className="media-picker-body">
        <form
          className="media-picker-filters"
          role="search"
          onSubmit={applySearch}
        >
          <Field label={t('picker.search')}>
            {(control) => (
              <input
                {...control}
                type="search"
                maxLength={200}
                value={searchInput}
                placeholder={t('picker.searchPlaceholder')}
                onChange={(event) => setSearchInput(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('picker.collection')}>
            {(control) => (
              <select
                {...control}
                value={collection}
                disabled={catalogState.kind !== 'ready'}
                onChange={(event) => {
                  setCollection(event.target.value);
                  setPage(1);
                }}
              >
                <option value="all">{t('collections.all')}</option>
                <option value="unfiled">{t('collections.unfiled')}</option>
                {catalog.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {input.purpose === 'all' ? (
            <Field label={t('picker.kind')}>
              {(control) => (
                <select
                  {...control}
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value as KindFilter);
                    setPage(1);
                  }}
                >
                  <option value="all">{t('picker.allKinds')}</option>
                  {mediaKinds.map((value: MediaKind) => (
                    <option key={value} value={value}>
                      {t(`kinds.${value}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ) : null}
          <Button type="submit">{t('picker.apply')}</Button>
        </form>

        {input.errorMessage ? (
          <Notice tone="error">{input.errorMessage}</Notice>
        ) : null}

        <div className="media-picker-results">
          {failed ? (
            <Notice
              tone="error"
              actions={(
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setLoadAttempt((value) => value + 1)}
                >
                  {t('retry')}
                </Button>
              )}
            >
              {t('picker.loadError')}
            </Notice>
          ) : loadState.kind === 'loading' || catalogState.kind === 'loading' ? (
            <InlineStatus size="lg">{t('picker.loading')}</InlineStatus>
          ) : loadState.items.length === 0 ? (
            <EmptyState
              title={input.copy.emptyTitle}
              description={input.copy.emptyDescription}
            />
          ) : (
            <ul className="media-picker-list" aria-label={t('picker.results')}>
              {loadState.items.map((media) => (
                <li key={media.id}>
                  <MediaPreview
                    media={media}
                    source={resolveMediaPreviewUrl(media, loadState.delivery)}
                    kindLabel={t(`kinds.${media.kind}`)}
                    unavailableLabel={t('previewUnavailable')}
                    className="media-picker-thumbnail"
                  />
                  <span className="media-picker-details">
                    <strong className="media-picker-filename">
                      {media.filename}
                    </strong>
                    <span className="media-picker-meta">
                      {t(`kinds.${media.kind}`)}
                      {' · '}
                      {media.mime_type}
                      {' · '}
                      {media.collection
                        ? media.collection.name
                        : t('collections.unfiled')}
                    </span>
                    <code className="media-picker-location">
                      {mediaLocationLabel(media.location)}
                    </code>
                  </span>
                  <span className="media-picker-actions">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setInformationMedia(media)}
                    >
                      {t('actions.information')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={media.id === input.selectedId ? 'secondary' : 'primary'}
                      aria-label={input.copy.selectNamed(media.filename)}
                      onClick={() => input.onSelect(media, loadState.delivery)}
                    >
                      {media.id === input.selectedId
                        ? t('picker.selected')
                        : input.copy.select}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {loadState.kind === 'ready' && loadState.pagination.total_pages > 1 ? (
          <Pagination
            label={t('picker.paginationLabel')}
            position={t('pagination.position', {
              page: loadState.pagination.page,
              pages: loadState.pagination.total_pages,
            })}
            previousLabel={t('pagination.previous')}
            nextLabel={t('pagination.next')}
            page={loadState.pagination.page}
            totalPages={loadState.pagination.total_pages}
            onChange={setPage}
          />
        ) : null}
      </div>
      </Dialog>
      {aiGenerationOpen
        && input.aiGenerationCsrfToken
        && input.purpose !== 'branding_favicon'
        && loadState.kind === 'ready' ? (
          <AiImageGenerationDialog
            csrfToken={input.aiGenerationCsrfToken}
            delivery={loadState.delivery}
            onSessionEnded={input.onSessionEnded}
            onClose={() => {
              setAiGenerationOpen(false);
              setLoadAttempt((value) => value + 1);
            }}
            onUse={(media, delivery) => {
              input.onSelect(media, delivery);
              setAiGenerationOpen(false);
              setLoadAttempt((value) => value + 1);
            }}
          />
        ) : null}
      {informationMedia && loadState.kind === 'ready' ? (
        <MediaInformationDialog
          media={informationMedia}
          delivery={loadState.delivery}
          canManage={Boolean(input.mediaManagementCsrfToken)}
          onClose={() => setInformationMedia(null)}
          onSessionEnded={input.onSessionEnded}
          onEditImage={input.mediaManagementCsrfToken
            && loadState.delivery.r2_preview_available
            && isMediaImageEditable(informationMedia)
            ? () => {
                setInformationMedia(null);
                setEditingMedia(informationMedia);
              }
            : undefined}
          onUpscaleImage={input.mediaManagementCsrfToken
            && loadState.delivery.r2_preview_available
            && isMediaImageUpscalable(informationMedia)
            ? () => {
                setInformationMedia(null);
                setUpscalingMedia(informationMedia);
              }
            : undefined}
        />
      ) : null}
      {editingMedia
        && input.mediaManagementCsrfToken
        && loadState.kind === 'ready' ? (
          <MediaImageEditorDialog
            media={editingMedia}
            delivery={loadState.delivery}
            csrfToken={input.mediaManagementCsrfToken}
            onClose={() => setEditingMedia(null)}
            onSessionEnded={input.onSessionEnded}
            onSaved={() => {
              setEditingMedia(null);
              setLoadAttempt((value) => value + 1);
            }}
            onSavedAndUse={(media, delivery) => {
              setEditingMedia(null);
              input.onSelect(media, delivery);
              setLoadAttempt((value) => value + 1);
            }}
          />
        ) : null}
      {upscalingMedia
        && input.mediaManagementCsrfToken
        && loadState.kind === 'ready' ? (
          <MediaImageUpscaleDialog
            media={upscalingMedia}
            delivery={loadState.delivery}
            csrfToken={input.mediaManagementCsrfToken}
            onClose={() => setUpscalingMedia(null)}
            onSessionEnded={input.onSessionEnded}
            onSaved={() => {
              setUpscalingMedia(null);
              setLoadAttempt((value) => value + 1);
            }}
            onSavedAndUse={(media, delivery) => {
              setUpscalingMedia(null);
              input.onSelect(media, delivery);
              setLoadAttempt((value) => value + 1);
            }}
          />
        ) : null}
    </>
  );
}

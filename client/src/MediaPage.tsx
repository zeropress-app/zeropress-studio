import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import { Link } from 'react-router';
import {
  FolderCog,
  FolderInput,
  Info,
  LayoutGrid,
  Link2,
  List,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { ApiErrorCode } from '../../contracts/api';
import {
  createMediaCollectionRequestSchema,
  createMediaRequestSchema,
  isDeletableR2MediaStorageKey,
  MEDIA_COLLECTION_MAX_ITEMS,
  MEDIA_DEFAULT_PAGE_SIZE,
  MEDIA_REFERENCES_DEFAULT_PAGE_SIZE,
  mediaKinds,
  mediaLocationLabel,
  updateMediaCollectionRequestSchema,
  updateMediaRequestSchema,
  type Media,
  type BulkMediaOperationData,
  type MediaCollection,
  type MediaDelivery,
  type MediaKind,
  type MediaListQuery,
  type MediaUsageReference,
} from '../../contracts/media';
import { isMediaImageEditable } from '../../contracts/media-image-editor';
import { isMediaImageUpscalable } from '../../contracts/media-image-upscale';
import type { ManagedMediaUploadPolicyResponse } from '../../contracts/media-upload';
import { ManagedMediaUploadPanel } from './components/ManagedMediaUploadPanel';
import { AiImageGenerationDialog } from './components/AiImageGenerationDialog';
import { MediaPreview } from './components/MediaPreview';
import { MediaInformationDialog } from './components/MediaInformationDialog';
import { MediaImageEditorDialog } from './components/MediaImageEditorDialog';
import { MediaImageUpscaleDialog } from './components/MediaImageUpscaleDialog';
import {
  ActionMenu,
  Button,
  Callout,
  DataTable,
  Dialog,
  DialogActions,
  EmptyState,
  Field,
  InlineStatus,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  RouteLoading,
  StudioIcon,
  type ActionMenuItem,
} from './components/primitives';
import {
  MediaClientError,
  requestBulkMediaOperation,
  requestBulkMoveMedia,
  requestCreateMedia,
  requestCreateMediaCollection,
  requestDeleteMedia,
  requestDeleteMediaCollection,
  requestManagedMediaUploadPolicy,
  requestMediaCollections,
  requestMediaList,
  requestMediaReferences,
  requestUpdateMedia,
  requestUpdateMediaCollection,
} from './lib/media-client';
import { resolveMediaPreviewUrl } from './lib/media-preview';
import {
  STUDIO_PATHS,
  studioPagePath,
  studioPostPath,
} from './routing/studio-routes';

type CollectionScope = MediaListQuery['collection'];
type ListKind = MediaListQuery['kind'];
type MediaView = 'grid' | 'list';
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
  | {
      kind: 'ready';
      items: MediaCollection[];
      totalMediaCount: number;
      unfiledMediaCount: number;
    };
type MediaAction =
  | { kind: 'upload' }
  | { kind: 'generate' }
  | { kind: 'create' }
  | { kind: 'information'; media: Media }
  | { kind: 'imageEdit'; media: Media }
  | { kind: 'imageUpscale'; media: Media }
  | { kind: 'edit'; media: Media }
  | { kind: 'delete'; media: Media };
type CollectionAction =
  | { kind: 'manage' }
  | { kind: 'create' }
  | { kind: 'edit'; collection: MediaCollection }
  | { kind: 'delete'; collection: MediaCollection }
  | { kind: 'move' };
type BulkAction = 'edit' | 'delete';
type BulkMetadataDraft = Record<string, { filename: string; alt: string }>;
type Failure =
  | { kind: 'validation' }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' };
type Completion =
  | { key: 'created' | 'uploaded' | 'generated' | 'imageEdited' | 'imageUpscaled' | 'updated' | 'deletedMetadata' | 'deletedObject' | 'deletedPending' }
  | { key: 'collectionCreated' | 'collectionUpdated' | 'collectionDeleted' }
  | { key: 'moved'; moved: number; unchanged: number }
  | {
      key: 'bulkUpdated' | 'bulkDeleted';
      summary: BulkMediaOperationData['summary'];
    };
type ReferenceLoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; failure: Failure }
  | {
      kind: 'ready';
      items: MediaUsageReference[];
      pagination: {
        page: number;
        per_page: number;
        total: number;
        total_pages: number;
      };
    };

function nullableNumber(value: string): number | null {
  return value.trim() === '' ? null : Number(value);
}

function displayMetadata(media: Media): string {
  const values = [media.mime_type];
  if (media.size_bytes !== null) values.push(`${media.size_bytes} B`);
  if (media.width !== null && media.height !== null) {
    values.push(`${media.width}×${media.height}`);
  }
  if (media.duration_ms !== null) values.push(`${media.duration_ms} ms`);
  return values.join(' · ');
}

function mediaUsageCount(media: Media): number {
  return media.usage.posts
    + media.usage.pages
    + media.usage.authors
    + media.usage.branding;
}

function mediaReferencePath(reference: MediaUsageReference): string {
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

export function MediaPage(input: {
  data: { csrf_token: string };
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('media');
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [listKind, setListKind] = useState<ListKind>('all');
  const [collection, setCollection] = useState<CollectionScope>('all');
  const [view, setView] = useState<MediaView>('grid');
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState(() => new Set<string>());
  const [mediaAction, setMediaAction] = useState<MediaAction | null>(null);
  const [collectionAction, setCollectionAction] = useState<CollectionAction | null>(null);
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [bulkMetadata, setBulkMetadata] = useState<BulkMetadataDraft>({});
  const [collectionName, setCollectionName] = useState('');
  const [moveTarget, setMoveTarget] = useState('unfiled');
  const [uploadPolicy, setUploadPolicy] = useState<
    Extract<ManagedMediaUploadPolicyResponse, { success: true }>['data'] | null
  >(null);
  const [mediaKind, setMediaKind] = useState<MediaKind>('image');
  const [filename, setFilename] = useState('');
  const [mimeType, setMimeType] = useState('image/jpeg');
  const [source, setSource] = useState('');
  const [sizeBytes, setSizeBytes] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [durationMs, setDurationMs] = useState('');
  const [alt, setAlt] = useState('');
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [referenceState, setReferenceState] = useState<ReferenceLoadState>({
    kind: 'idle',
  });
  const [referencePage, setReferencePage] = useState(1);
  const [referenceAttempt, setReferenceAttempt] = useState(0);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const editingNativeUpload = mediaAction?.kind === 'edit'
    && mediaAction.media.location.type === 'r2'
    && mediaAction.media.location.key.startsWith('uploads/');
  const deletingR2Object = mediaAction?.kind === 'delete'
    && mediaAction.media.location.type === 'r2'
    && isDeletableR2MediaStorageKey(mediaAction.media.location.key);
  const deletingMediaId = mediaAction?.kind === 'delete'
    ? mediaAction.media.id
    : null;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    { dateStyle: 'medium', timeStyle: 'short' },
  ), [i18n.resolvedLanguage]);
  const canDeleteMedia = referenceState.kind === 'ready'
    && referenceState.pagination.total === 0;

  useStudioDocumentTitle(t('documentTitle'));

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    void requestMediaList({
      search,
      kind: listKind,
      purpose: 'all',
      collection,
      page,
      per_page: MEDIA_DEFAULT_PAGE_SIZE,
    }, controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
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
  }, [collection, input.onSessionEnded, listKind, loadAttempt, page, search]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setCatalogState({ kind: 'loading' });
    void requestMediaCollections(controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setCatalogState({ kind: 'error' });
        return;
      }
      setCatalogState({
        kind: 'ready',
        items: response.data.items,
        totalMediaCount: response.data.total_media_count,
        unfiledMediaCount: response.data.unfiled_media_count,
      });
    }).catch(() => {
      if (active && !controller.signal.aborted) setCatalogState({ kind: 'error' });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [catalogAttempt, input.onSessionEnded]);

  useEffect(() => {
    const controller = new AbortController();
    void requestManagedMediaUploadPolicy(controller.signal).then((response) => {
      if (response.success) setUploadPolicy(response.data);
      else if (response.error.code === 'AUTHENTICATION_REQUIRED') {
        input.onSessionEnded();
      }
    }).catch(() => undefined);
    return () => controller.abort();
  }, [input.onSessionEnded]);

  useEffect(() => {
    if (!deletingMediaId) {
      setReferenceState({ kind: 'idle' });
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setReferenceState({ kind: 'loading' });
    void requestMediaReferences(deletingMediaId, {
      page: referencePage,
      per_page: MEDIA_REFERENCES_DEFAULT_PAGE_SIZE,
    }, controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setReferenceState({
          kind: 'error',
          failure: { kind: 'api', code: response.error.code },
        });
        return;
      }
      if (
        response.data.pagination.total_pages > 0
        && referencePage > response.data.pagination.total_pages
      ) {
        setReferencePage(response.data.pagination.total_pages);
        return;
      }
      setReferenceState({
        kind: 'ready',
        items: response.data.items,
        pagination: response.data.pagination,
      });
    }).catch((error) => {
      if (!active || controller.signal.aborted) return;
      setReferenceState({
        kind: 'error',
        failure: {
          kind: 'client',
          code: error instanceof MediaClientError
            ? error.code
            : 'INVALID_RESPONSE',
        },
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [deletingMediaId, input.onSessionEnded, referenceAttempt, referencePage]);

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function setMediaSelected(id: string, selected: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function refreshMediaAndCatalog() {
    clearSelection();
    setLoadAttempt((value) => value + 1);
    setCatalogAttempt((value) => value + 1);
  }

  function chooseCollection(next: CollectionScope) {
    setCollection(next);
    setPage(1);
    clearSelection();
    setCompletion(null);
  }

  function openCreate() {
    setMediaAction({ kind: 'create' });
    setMediaKind('image');
    setFilename('');
    setMimeType('image/jpeg');
    setSource('');
    setSizeBytes('');
    setWidth('');
    setHeight('');
    setDurationMs('');
    setAlt('');
    setFailure(null);
  }

  function openUpload() {
    if (!uploadPolicy?.available) return;
    setMediaAction({ kind: 'upload' });
    setFailure(null);
  }

  function openEdit(media: Media) {
    setMediaAction({ kind: 'edit', media });
    setMediaKind(media.kind);
    setFilename(media.filename);
    setMimeType(media.mime_type);
    setSource(mediaLocationLabel(media.location));
    setSizeBytes(media.size_bytes === null ? '' : String(media.size_bytes));
    setWidth(media.width === null ? '' : String(media.width));
    setHeight(media.height === null ? '' : String(media.height));
    setDurationMs(media.duration_ms === null ? '' : String(media.duration_ms));
    setAlt(media.alt);
    setFailure(null);
  }

  function openInformation(media: Media) {
    setMediaAction({ kind: 'information', media });
    setFailure(null);
  }

  function openDelete(media: Media) {
    setMediaAction({ kind: 'delete', media });
    setReferencePage(1);
    setReferenceAttempt((value) => value + 1);
    setFailure(null);
  }

  function mediaActionItems(media: Media): ActionMenuItem[] {
    return [
      {
        id: 'information',
        kind: 'button',
        label: t('actions.information'),
        icon: Info,
        onSelect: () => openInformation(media),
      },
      {
        id: 'edit',
        kind: 'button',
        label: t('actions.edit'),
        icon: Pencil,
        onSelect: () => openEdit(media),
      },
      {
        id: 'delete',
        kind: 'button',
        label: t('actions.delete'),
        icon: Trash2,
        tone: 'critical',
        onSelect: () => openDelete(media),
      },
    ];
  }

  function openBulkEdit() {
    if (loadState.kind !== 'ready') return;
    const selected = loadState.items.filter((item) => selectedIds.has(item.id));
    if (selected.length === 0) return;
    setBulkMetadata(Object.fromEntries(selected.map((item) => [
      item.id,
      { filename: item.filename, alt: item.alt },
    ])));
    setBulkAction('edit');
    setFailure(null);
  }

  function openBulkDelete() {
    if (loadState.kind !== 'ready' || selectedIds.size === 0) return;
    setBulkAction('delete');
    setFailure(null);
  }

  function refreshReferences() {
    setFailure(null);
    setReferenceAttempt((value) => value + 1);
  }

  function changeMediaKind(value: MediaKind) {
    setMediaKind(value);
    if (!['image', 'video'].includes(value)) {
      setWidth('');
      setHeight('');
    }
    if (!['audio', 'video'].includes(value)) setDurationMs('');
    if (value !== 'image') setAlt('');
  }

  function openCreateCollection() {
    setCollectionAction({ kind: 'create' });
    setCollectionName('');
    setFailure(null);
  }

  function openCollectionsManager() {
    setCollectionAction({ kind: 'manage' });
    setFailure(null);
  }

  function openEditCollection(value: MediaCollection) {
    setCollectionAction({ kind: 'edit', collection: value });
    setCollectionName(value.name);
    setFailure(null);
  }

  function failureMessage(value: Failure): string {
    if (value.kind === 'validation') return t('validation');
    if (value.kind === 'client') {
      if (value.code === 'TIMEOUT') return t('errors.timeout');
      if (value.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    const collectionErrors: Partial<Record<ApiErrorCode, string>> = {
      MEDIA_COLLECTION_NOT_FOUND: t('collections.errors.notFound'),
      MEDIA_COLLECTION_NAME_CONFLICT: t('collections.errors.nameConflict'),
      MEDIA_COLLECTION_REVISION_CONFLICT: t('collections.errors.revisionConflict'),
      MEDIA_COLLECTION_NOT_EMPTY: t('collections.errors.notEmpty'),
      MEDIA_COLLECTION_LIMIT_REACHED: t('collections.errors.limit'),
      MEDIA_BULK_MOVE_CONFLICT: t('collections.errors.bulkConflict'),
    };
    if (collectionErrors[value.code]) return collectionErrors[value.code] as string;
    if (value.code === 'MEDIA_SOURCE_CONFLICT') return t('errors.sourceConflict');
    if (value.code === 'MEDIA_NOT_FOUND') return t('errors.notFound');
    if (value.code === 'MEDIA_REVISION_CONFLICT') return t('errors.revisionConflict');
    if (value.code === 'MEDIA_IN_USE') return t('errors.inUse');
    if (value.code === 'MEDIA_MANAGED_FILE_IMMUTABLE') return t('errors.managedImmutable');
    if (value.code === 'FORBIDDEN') return t('errors.forbidden');
    return t('errors.api');
  }

  function referenceTypeLabel(reference: MediaUsageReference): string {
    if (reference.type === 'post') return t('references.types.post');
    if (reference.type === 'page') return t('references.types.page');
    if (reference.type === 'author') return t('references.types.author');
    return t('references.types.branding');
  }

  function referenceLabel(reference: MediaUsageReference): string {
    if (reference.type === 'post' || reference.type === 'page') {
      return reference.title;
    }
    if (reference.type === 'author') return reference.display_name;
    if (reference.slot === 'favicon') return t('references.slots.favicon');
    if (reference.slot === 'favicon_dark') {
      return t('references.slots.faviconDark');
    }
    if (reference.slot === 'apple_touch_icon') {
      return t('references.slots.appleTouchIcon');
    }
    return t('references.slots.logo');
  }

  function referenceIdentity(reference: MediaUsageReference): string | null {
    if (reference.type === 'post' || reference.type === 'page') {
      return t('references.publicId', { id: reference.public_id });
    }
    if (reference.type === 'author') {
      return t('references.authorId', { id: reference.id });
    }
    return null;
  }

  async function submitMedia(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !mediaAction
      || mediaAction.kind === 'delete'
      || mediaAction.kind === 'upload'
      || mediaAction.kind === 'generate'
      || mediaAction.kind === 'information'
      || mediaAction.kind === 'imageEdit'
      || mediaAction.kind === 'imageUpscale'
      || running
    ) return;
    const location = mediaAction.kind === 'edit' && mediaAction.media.location.type === 'r2'
      ? { type: 'r2' as const, key: source }
      : { type: 'external' as const, url: source };
    const authored = {
      kind: mediaKind,
      filename,
      mime_type: mimeType,
      location,
      size_bytes: nullableNumber(sizeBytes),
      width: nullableNumber(width),
      height: nullableNumber(height),
      duration_ms: nullableNumber(durationMs),
      alt: mediaKind === 'image' ? alt : '',
    };
    setRunning(true);
    setFailure(null);
    try {
      let response;
      if (mediaAction.kind === 'create') {
        const parsed = createMediaRequestSchema.safeParse(authored);
        if (!parsed.success) {
          setFailure({ kind: 'validation' });
          return;
        }
        response = await requestCreateMedia(input.data.csrf_token, parsed.data);
      } else {
        const parsed = updateMediaRequestSchema.safeParse({
          ...authored,
          expected_revision: mediaAction.media.revision,
        });
        if (!parsed.success) {
          setFailure({ kind: 'validation' });
          return;
        }
        response = await requestUpdateMedia(
          input.data.csrf_token,
          mediaAction.media.id,
          parsed.data,
        );
      }
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setCompletion({ key: mediaAction.kind === 'create' ? 'created' : 'updated' });
      setMediaAction(null);
      refreshMediaAndCatalog();
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof MediaClientError ? error.code : 'INVALID_RESPONSE',
      });
    } finally {
      setRunning(false);
    }
  }

  async function confirmDeleteMedia() {
    if (mediaAction?.kind !== 'delete' || running) return;
    setRunning(true);
    setFailure(null);
    try {
      const response = await requestDeleteMedia(
        input.data.csrf_token,
        mediaAction.media.id,
        mediaAction.media.revision,
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        if (response.error.code === 'MEDIA_IN_USE') {
          setReferencePage(1);
          setReferenceAttempt((value) => value + 1);
        }
        return;
      }
      setCompletion({
        key: response.data.object_cleanup === 'completed'
          ? 'deletedObject'
          : response.data.object_cleanup === 'pending'
            ? 'deletedPending'
            : 'deletedMetadata',
      });
      setMediaAction(null);
      if (loadState.kind === 'ready' && loadState.items.length === 1 && page > 1) {
        setPage((value) => value - 1);
        clearSelection();
        setCatalogAttempt((value) => value + 1);
      } else refreshMediaAndCatalog();
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof MediaClientError ? error.code : 'INVALID_RESPONSE',
      });
    } finally {
      setRunning(false);
    }
  }

  async function submitCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !collectionAction
      || (collectionAction.kind !== 'create' && collectionAction.kind !== 'edit')
      || running
    ) return;
    setRunning(true);
    setFailure(null);
    try {
      const response = collectionAction.kind === 'create'
        ? await (async () => {
            const parsed = createMediaCollectionRequestSchema.safeParse({
              name: collectionName,
            });
            if (!parsed.success) return null;
            return requestCreateMediaCollection(input.data.csrf_token, parsed.data);
          })()
        : await (async () => {
            const parsed = updateMediaCollectionRequestSchema.safeParse({
              name: collectionName,
              expected_revision: collectionAction.collection.revision,
            });
            if (!parsed.success) return null;
            return requestUpdateMediaCollection(
              input.data.csrf_token,
              collectionAction.collection.id,
              parsed.data,
            );
          })();
      if (!response) {
        setFailure({ kind: 'validation' });
        return;
      }
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setCompletion({
        key: collectionAction.kind === 'create'
          ? 'collectionCreated'
          : 'collectionUpdated',
      });
      setCollectionAction({ kind: 'manage' });
      setCatalogAttempt((value) => value + 1);
      setLoadAttempt((value) => value + 1);
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof MediaClientError ? error.code : 'INVALID_RESPONSE',
      });
    } finally {
      setRunning(false);
    }
  }

  async function confirmDeleteCollection() {
    if (collectionAction?.kind !== 'delete' || running) return;
    setRunning(true);
    setFailure(null);
    try {
      const response = await requestDeleteMediaCollection(
        input.data.csrf_token,
        collectionAction.collection.id,
        collectionAction.collection.revision,
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      if (collection === collectionAction.collection.id) chooseCollection('all');
      setCompletion({ key: 'collectionDeleted' });
      setCollectionAction({ kind: 'manage' });
      setCatalogAttempt((value) => value + 1);
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof MediaClientError ? error.code : 'INVALID_RESPONSE',
      });
    } finally {
      setRunning(false);
    }
  }

  async function confirmBulkMove() {
    if (collectionAction?.kind !== 'move' || running || loadState.kind !== 'ready') return;
    const selected = loadState.items.filter((item) => selectedIds.has(item.id));
    if (selected.length === 0) return;
    setRunning(true);
    setFailure(null);
    try {
      const response = await requestBulkMoveMedia(input.data.csrf_token, {
        target_collection_id: moveTarget === 'unfiled' ? null : moveTarget,
        items: selected.map((item) => ({
          id: item.id,
          expected_revision: item.revision,
        })),
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setCompletion({
        key: 'moved',
        moved: response.data.moved_count,
        unchanged: response.data.unchanged_count,
      });
      setCollectionAction(null);
      refreshMediaAndCatalog();
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof MediaClientError ? error.code : 'INVALID_RESPONSE',
      });
    } finally {
      setRunning(false);
    }
  }

  async function confirmBulkMetadataUpdate() {
    if (bulkAction !== 'edit' || running || loadState.kind !== 'ready') return;
    const selected = loadState.items.filter((item) => selectedIds.has(item.id));
    if (selected.length === 0) return;
    setRunning(true);
    setFailure(null);
    try {
      const response = await requestBulkMediaOperation(input.data.csrf_token, {
        operation: 'update_metadata',
        items: selected.map((item) => ({
          id: item.id,
          expected_revision: item.revision,
          filename: bulkMetadata[item.id]?.filename ?? item.filename,
          alt: item.kind === 'image'
            ? bulkMetadata[item.id]?.alt ?? item.alt
            : '',
        })),
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      const retryIds = new Set(response.data.results
        .filter((result) => ['conflict', 'skipped'].includes(result.outcome))
        .map((result) => result.id));
      setCompletion({ key: 'bulkUpdated', summary: response.data.summary });
      setBulkAction(null);
      setSelectedIds(retryIds);
      setLoadAttempt((value) => value + 1);
      setCatalogAttempt((value) => value + 1);
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof MediaClientError ? error.code : 'INVALID_RESPONSE',
      });
    } finally {
      setRunning(false);
    }
  }

  async function confirmBulkDelete() {
    if (bulkAction !== 'delete' || running || loadState.kind !== 'ready') return;
    const selected = loadState.items.filter((item) => selectedIds.has(item.id));
    if (selected.length === 0) return;
    setRunning(true);
    setFailure(null);
    try {
      const response = await requestBulkMediaOperation(input.data.csrf_token, {
        operation: 'delete',
        items: selected.map((item) => ({
          id: item.id,
          expected_revision: item.revision,
        })),
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      const retryIds = new Set(response.data.results
        .filter((result) => ['conflict', 'skipped'].includes(result.outcome))
        .map((result) => result.id));
      setCompletion({ key: 'bulkDeleted', summary: response.data.summary });
      setBulkAction(null);
      setSelectedIds(retryIds);
      if (
        response.data.summary.updated === loadState.items.length
        && page > 1
      ) setPage((value) => value - 1);
      else setLoadAttempt((value) => value + 1);
      setCatalogAttempt((value) => value + 1);
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof MediaClientError ? error.code : 'INVALID_RESPONSE',
      });
    } finally {
      setRunning(false);
    }
  }

  if (loadState.kind === 'loading' || catalogState.kind === 'loading') {
    return <RouteLoading>{t('loading')}</RouteLoading>;
  }
  if (loadState.kind === 'error' || catalogState.kind === 'error') {
    return (
      <main id="studio-main-content">
        <PageHeader titleId="media-title" title={t('title')} />
        <Notice
          tone="error"
          actions={(
            <Button
              type="button"
              onClick={() => {
                setLoadAttempt((value) => value + 1);
                setCatalogAttempt((value) => value + 1);
              }}
            >
              {t('retry')}
            </Button>
          )}
        >
          {t('errors.load')}
        </Notice>
      </main>
    );
  }

  const editingR2 = mediaAction?.kind === 'edit'
    && mediaAction.media.location.type === 'r2';
  const allPageSelected = loadState.items.length > 0
    && loadState.items.every((item) => selectedIds.has(item.id));
  const selectedItems = loadState.items.filter((item) => selectedIds.has(item.id));

  return (
    <main id="studio-main-content" aria-labelledby="media-title">
      <PageHeader
        titleId="media-title"
        kicker={t('kicker')}
        title={t('title')}
        description={t('description')}
      />

      {completion ? (
        <div className="content-list-message">
          <Notice tone="success">
            {completion.key === 'moved'
              ? t('completion.moved', completion)
              : completion.key === 'bulkUpdated' || completion.key === 'bulkDeleted'
                ? t(`completion.${completion.key}`, completion.summary)
              : t(`completion.${completion.key}`)}
          </Notice>
        </div>
      ) : null}

      <section className="media-library" aria-label={t('table.label')}>
        <div className="media-library-toolbar">
          <form
            className="media-list-filters"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
              clearSelection();
              setSearch(searchInput.trim());
            }}
          >
            <div className="media-filter-search">
              <Field
                label={t('filters.search')}
                labelHidden
                leading={<StudioIcon icon={Search} />}
              >
                {(control) => (
                  <input
                    {...control}
                    type="search"
                    maxLength={200}
                    value={searchInput}
                    placeholder={t('filters.placeholder')}
                    onChange={(event) => setSearchInput(event.target.value)}
                  />
                )}
              </Field>
              <Button type="submit">
                <StudioIcon icon={Search} className="media-button-icon" />
                {t('filters.apply')}
              </Button>
            </div>
            <div className="media-filter-kind">
              <Field label={t('filters.kind')} labelHidden>
                {(control) => (
                  <select
                    {...control}
                    value={listKind}
                    onChange={(event) => {
                      setListKind(event.target.value as ListKind);
                      setPage(1);
                      clearSelection();
                    }}
                  >
                    <option value="all">{t('filters.allKinds')}</option>
                    {mediaKinds.map((value) => (
                      <option value={value} key={value}>{t(`kinds.${value}`)}</option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <div className="media-filter-collection">
              <Field label={t('filters.collection')} labelHidden>
                {(control) => (
                  <select
                    {...control}
                    value={collection}
                    onChange={(event) => chooseCollection(
                      event.target.value as CollectionScope,
                    )}
                  >
                    <option value="all">
                      {t('collections.optionNamed', {
                        name: t('collections.all'),
                        count: catalogState.totalMediaCount,
                      })}
                    </option>
                    <option value="unfiled">
                      {t('collections.optionNamed', {
                        name: t('collections.unfiled'),
                        count: catalogState.unfiledMediaCount,
                      })}
                    </option>
                    {catalogState.items.map((item) => (
                      <option value={item.id} key={item.id}>
                        {t('collections.optionNamed', {
                          name: item.name,
                          count: item.media_count,
                        })}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
          </form>

          <div className="media-toolbar-actions">
            <Button
              type="button"
              variant="primary"
              disabled={!uploadPolicy?.available}
              title={uploadPolicy?.available ? undefined : t('uploadUnavailable')}
              onClick={openUpload}
            >
              <StudioIcon icon={Upload} className="media-button-icon" />
              {t('uploadAction')}
            </Button>
            <Button
              type="button"
              disabled={!uploadPolicy?.available}
              title={uploadPolicy?.available ? undefined : t('uploadUnavailable')}
              onClick={() => {
                setFailure(null);
                setMediaAction({ kind: 'generate' });
              }}
            >
              <StudioIcon icon={Sparkles} className="media-button-icon" />
              {t('aiImage.action')}
            </Button>
            <Button type="button" onClick={openCreate}>
              <StudioIcon icon={Link2} className="media-button-icon" />
              {t('create')}
            </Button>
            <Button type="button" onClick={openCollectionsManager}>
              <StudioIcon icon={FolderCog} className="media-button-icon" />
              {t('collections.manage')}
            </Button>
          </div>

          <div className="media-view-toggle" role="group" aria-label={t('view.label')}>
            <Button
              type="button"
              size="sm"
              variant={view === 'grid' ? 'secondary' : 'ghost'}
              aria-label={t('view.grid')}
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
            >
              <StudioIcon icon={LayoutGrid} className="media-view-icon" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant={view === 'list' ? 'secondary' : 'ghost'}
              aria-label={t('view.list')}
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <StudioIcon icon={List} className="media-view-icon" />
            </Button>
          </div>
        </div>

        {selectedIds.size > 0 ? (
          <div className="media-bulk-toolbar" role="region" aria-label={t('bulk.label')}>
            <span>{t('bulk.selected', { count: selectedIds.size })}</span>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setMoveTarget(collection !== 'all' && collection !== 'unfiled'
                  ? collection
                  : 'unfiled');
                setCollectionAction({ kind: 'move' });
                setFailure(null);
              }}
            >
              <StudioIcon icon={FolderInput} className="media-button-icon" />
              {t('bulk.move')}
            </Button>
            <Button type="button" size="sm" onClick={openBulkEdit}>
              <StudioIcon icon={Pencil} className="media-button-icon" />
              {t('bulk.edit')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="danger"
              onClick={openBulkDelete}
            >
              <StudioIcon icon={Trash2} className="media-button-icon" />
              {t('bulk.delete')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={clearSelection}>
              <StudioIcon icon={X} className="media-button-icon" />
              {t('bulk.clear')}
            </Button>
          </div>
        ) : null}

        <div className="media-results-heading">
          <p>{t('summary.results', {
            shown: loadState.items.length,
            total: loadState.pagination.total,
          })}</p>
          {view === 'grid' && loadState.items.length > 0 ? (
            <label className="media-select-page">
              <input
                type="checkbox"
                checked={allPageSelected}
                onChange={(event) => setSelectedIds(event.target.checked
                  ? new Set(loadState.items.map((item) => item.id))
                  : new Set())}
              />
              <span>{t('bulk.selectPageShort')}</span>
            </label>
          ) : null}
        </div>

        {loadState.items.length === 0 ? (
          <EmptyState
            headingLevel={2}
            announce={Boolean(search || listKind !== 'all' || collection !== 'all')}
            title={t(search || listKind !== 'all' || collection !== 'all'
              ? 'empty.filteredTitle'
              : 'empty.title')}
            description={t(search || listKind !== 'all' || collection !== 'all'
              ? 'empty.filteredDescription'
              : 'empty.description')}
          />
        ) : view === 'grid' ? (
          <ul className="media-grid" aria-label={t('grid.label')}>
            {loadState.items.map((item) => {
              const usageCount = mediaUsageCount(item);
              const selected = selectedIds.has(item.id);
              return (
                <li
                  key={item.id}
                  className={`media-grid-card${selected ? ' media-grid-card-selected' : ''}`}
                >
                  <div className="media-grid-preview">
                    <button
                      type="button"
                      className="media-grid-preview-button"
                      aria-label={t('actions.informationNamed', {
                        filename: item.filename,
                      })}
                      onClick={() => openInformation(item)}
                    >
                      <MediaPreview
                        media={item}
                        source={resolveMediaPreviewUrl(item, loadState.delivery)}
                        kindLabel={t(`kinds.${item.kind}`)}
                        unavailableLabel={t('previewUnavailable')}
                        className="media-grid-thumbnail"
                      />
                    </button>
                    <label className="media-grid-selection">
                      <span className="visually-hidden">
                        {t('bulk.selectNamed', { filename: item.filename })}
                      </span>
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(event) => setMediaSelected(
                          item.id,
                          event.target.checked,
                        )}
                      />
                    </label>
                    <span className="media-grid-storage">
                      {t(`storageBadge.${item.location.type}`)}
                    </span>
                  </div>
                  <div className="media-grid-body">
                    <div className="media-grid-title-row">
                      <button
                        type="button"
                        className="media-grid-title"
                        onClick={() => openInformation(item)}
                      >
                        {item.filename}
                      </button>
                      <ActionMenu
                        label={t('actions.menuNamed', { filename: item.filename })}
                        items={mediaActionItems(item)}
                      />
                    </div>
                    <p className="media-grid-collection">
                      {item.collection?.name ?? t('collections.unfiled')}
                    </p>
                    <p className="media-grid-metadata">{displayMetadata(item)}</p>
                    {usageCount > 0 ? (
                      <p className="media-grid-usage">
                        <StudioIcon icon={Link2} />
                        {t('grid.references', { count: usageCount })}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Panel flush>
            <DataTable
              caption={t('table.label')}
              minWidthPx={1080}
              stacked="compact"
              selection={{
                label: t('bulk.selectPage'),
                checked: allPageSelected,
                indeterminate: selectedIds.size > 0 && !allPageSelected,
                onChange: (checked) => setSelectedIds(checked
                  ? new Set(loadState.items.map((item) => item.id))
                  : new Set()),
              }}
            >
              <thead>
                <tr>
                  <th scope="col" className="media-selection-cell">
                    <span className="visually-hidden">{t('bulk.select')}</span>
                  </th>
                  <th scope="col">{t('table.kind')}</th>
                  <th scope="col">{t('table.asset')}</th>
                  <th scope="col">{t('table.collection')}</th>
                  <th scope="col">{t('table.metadata')}</th>
                  <th scope="col">{t('table.usage')}</th>
                  <th scope="col">{t('table.updated')}</th>
                  <th scope="col">{t('table.actions')}</th>
                </tr>
              </thead>
              <tbody>{loadState.items.map((item) => {
                const inUse = mediaUsageCount(item) > 0;
                return (
                  <tr key={item.id}>
                    <td data-label={t('bulk.select')} data-stack="select" className="media-selection-cell">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.id)}
                        aria-label={t('bulk.selectNamed', { filename: item.filename })}
                        onChange={(event) => setMediaSelected(
                          item.id,
                          event.target.checked,
                        )}
                      />
                    </td>
                    <td data-label={t('table.kind')} data-stack="preview">
                      <MediaPreview
                        media={item}
                        source={resolveMediaPreviewUrl(item, loadState.delivery)}
                        kindLabel={t(`kinds.${item.kind}`)}
                        unavailableLabel={t('previewUnavailable')}
                      />
                    </td>
                    <td data-label={t('table.asset')} data-stack="primary">
                      <span className="content-list-stacked-cell">
                        <button
                          type="button"
                          className="media-list-asset-button"
                          onClick={() => openInformation(item)}
                        >
                          {item.filename}
                        </button>
                        <code className="content-list-slug" data-stack-detail="secondary">{mediaLocationLabel(item.location)}</code>
                        <small className="content-list-cell-detail">
                          {t(`storage.${item.location.type}`)}
                        </small>
                      </span>
                    </td>
                    <td data-label={t('table.collection')}>
                      {item.collection?.name ?? t('collections.unfiled')}
                    </td>
                    <td data-label={t('table.metadata')} data-stack="wide">
                      <span className="content-list-stacked-cell">
                        <span>{displayMetadata(item)}</span>
                        {item.alt ? <small className="content-list-cell-detail">{item.alt}</small> : null}
                      </span>
                    </td>
                    <td data-label={t('table.usage')}>
                      {inUse ? t('table.used', item.usage) : t('table.unused')}
                    </td>
                    <td data-label={t('table.updated')}>
                      {dateFormatter.format(new Date(item.updated_at_iso))}
                    </td>
                    <td data-label={t('table.actions')} data-stack="actions">
                      <ActionMenu
                        label={t('actions.menuNamed', { filename: item.filename })}
                        items={mediaActionItems(item)}
                      />
                    </td>
                  </tr>
                );
              })}</tbody>
            </DataTable>
          </Panel>
        )}

        {loadState.pagination.total_pages > 1 ? (
          <div className="content-list-pagination">
            <Pagination
              label={t('pagination.label')}
              position={t('pagination.position', {
                page: loadState.pagination.page,
                pages: loadState.pagination.total_pages,
              })}
              previousLabel={t('pagination.previous')}
              nextLabel={t('pagination.next')}
              page={page}
              totalPages={loadState.pagination.total_pages}
              onChange={(next) => {
                setPage(next);
                clearSelection();
              }}
            />
          </div>
        ) : null}
      </section>

      {mediaAction?.kind === 'upload' && uploadPolicy?.available ? (
        <Dialog
          open
          busy={running}
          onClose={() => setMediaAction(null)}
          size="wide"
          kicker={t('upload.kicker')}
          title={t('upload.title')}
          initialFocusRef={cancelRef}
        >
          <ManagedMediaUploadPanel
            csrfToken={input.data.csrf_token}
            maxBytes={uploadPolicy.max_bytes}
            maxSvgBytes={uploadPolicy.max_svg_bytes}
            maxFiles={uploadPolicy.max_files}
            concurrency={uploadPolicy.concurrency}
            cancelRef={cancelRef}
            onClose={() => setMediaAction(null)}
            onSessionEnded={input.onSessionEnded}
            onRunningChange={setRunning}
            onUploaded={() => {
              setCompletion({ key: 'uploaded' });
              refreshMediaAndCatalog();
            }}
          />
        </Dialog>
      ) : null}

      {mediaAction?.kind === 'generate' && uploadPolicy?.available ? (
        <AiImageGenerationDialog
          csrfToken={input.data.csrf_token}
          delivery={loadState.delivery}
          onClose={() => setMediaAction(null)}
          onSessionEnded={input.onSessionEnded}
          onGenerated={(media) => {
            setCompletion({ key: 'generated' });
            openInformation(media);
            refreshMediaAndCatalog();
          }}
        />
      ) : null}

      {mediaAction?.kind === 'information' ? (
        <MediaInformationDialog
          media={mediaAction.media}
          delivery={loadState.delivery}
          canManage
          onClose={() => setMediaAction(null)}
          onSessionEnded={input.onSessionEnded}
          onEditMetadata={() => openEdit(mediaAction.media)}
          onEditImage={uploadPolicy?.available
            && isMediaImageEditable(mediaAction.media)
            ? () => setMediaAction({
                kind: 'imageEdit',
                media: mediaAction.media,
              })
            : undefined}
          onUpscaleImage={uploadPolicy?.available
            && isMediaImageUpscalable(mediaAction.media)
            ? () => setMediaAction({
                kind: 'imageUpscale',
                media: mediaAction.media,
              })
            : undefined}
        />
      ) : null}

      {mediaAction?.kind === 'imageEdit' && uploadPolicy?.available ? (
        <MediaImageEditorDialog
          media={mediaAction.media}
          delivery={loadState.delivery}
          csrfToken={input.data.csrf_token}
          onClose={() => setMediaAction(null)}
          onSessionEnded={input.onSessionEnded}
          onSaved={() => {
            setCompletion({ key: 'imageEdited' });
            setMediaAction(null);
            refreshMediaAndCatalog();
          }}
        />
      ) : null}

      {mediaAction?.kind === 'imageUpscale' && uploadPolicy?.available ? (
        <MediaImageUpscaleDialog
          media={mediaAction.media}
          delivery={loadState.delivery}
          csrfToken={input.data.csrf_token}
          onClose={() => setMediaAction(null)}
          onSessionEnded={input.onSessionEnded}
          onSaved={() => {
            setCompletion({ key: 'imageUpscaled' });
            setMediaAction(null);
            refreshMediaAndCatalog();
          }}
        />
      ) : null}

      {mediaAction?.kind === 'delete' ? (
        <Dialog
          open
          busy={running}
          onClose={() => setMediaAction(null)}
          kicker={t(deletingR2Object
            ? 'dialog.deleteR2Kicker'
            : 'dialog.deleteMetadataKicker')}
          title={t(deletingR2Object
            ? 'dialog.deleteR2Title'
            : 'dialog.deleteMetadataTitle')}
          description={t(deletingR2Object
            ? 'dialog.deleteR2Description'
            : 'dialog.deleteMetadataDescription')}
          initialFocusRef={cancelRef}
          actions={(
            <>
              <Button ref={cancelRef} type="button" disabled={running} onClick={() => setMediaAction(null)}>
                {t('dialog.cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={running || !canDeleteMedia}
                onClick={confirmDeleteMedia}
              >
                {running
                  ? t('dialog.running')
                  : t(deletingR2Object
                      ? 'dialog.confirmDeleteR2'
                      : 'dialog.confirmDeleteMetadata')}
              </Button>
            </>
          )}
        >
          {failure ? <Notice tone="error">{failureMessage(failure)}</Notice> : null}
          {referenceState.kind === 'loading' ? (
            <InlineStatus>{t('references.loading')}</InlineStatus>
          ) : null}
          {referenceState.kind === 'error' ? (
            <div className="media-reference-status">
              <Notice tone="error">
                {failureMessage(referenceState.failure)}
              </Notice>
              <Button type="button" size="sm" onClick={refreshReferences}>
                {t('references.retry')}
              </Button>
            </div>
          ) : null}
          {referenceState.kind === 'ready'
            && referenceState.pagination.total === 0 ? (
              <div className="media-reference-status">
                <Callout tone="success" title={t('references.readyTitle')}>
                  {t('references.readyDescription')}
                </Callout>
                <Button type="button" size="sm" onClick={refreshReferences}>
                  {t('references.recheck')}
                </Button>
              </div>
            ) : null}
          {referenceState.kind === 'ready'
            && referenceState.pagination.total > 0 ? (
              <div className="media-reference-status">
                <Callout tone="warning" title={t('references.blockedTitle', {
                  count: referenceState.pagination.total,
                })}>
                  {t('references.blockedDescription')}
                </Callout>
                <ul
                  className="media-reference-list"
                  aria-label={t('references.listLabel')}
                >
                  {referenceState.items.map((reference) => {
                    const identity = referenceIdentity(reference);
                    const key = reference.type === 'branding'
                      ? `branding:${reference.slot}`
                      : `${reference.type}:${reference.id}`;
                    return (
                      <li key={key}>
                        <span className="media-reference-copy">
                          <small className="media-reference-type">
                            {referenceTypeLabel(reference)}
                          </small>
                          <strong className="media-reference-label">
                            {referenceLabel(reference)}
                          </strong>
                          {identity ? (
                            <code className="media-reference-identity">
                              {identity}
                            </code>
                          ) : null}
                        </span>
                        <Link
                          to={mediaReferencePath(reference)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('references.open')}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
                {referenceState.pagination.total_pages > 1 ? (
                  <Pagination
                    label={t('references.pagination.label')}
                    position={t('references.pagination.position', {
                      page: referenceState.pagination.page,
                      pages: referenceState.pagination.total_pages,
                    })}
                    previousLabel={t('references.pagination.previous')}
                    nextLabel={t('references.pagination.next')}
                    page={referenceState.pagination.page}
                    totalPages={referenceState.pagination.total_pages}
                    onChange={setReferencePage}
                  />
                ) : null}
                <Button type="button" size="sm" onClick={refreshReferences}>
                  {t('references.recheck')}
                </Button>
              </div>
            ) : null}
        </Dialog>
      ) : null}

      {mediaAction
        && (mediaAction.kind === 'create' || mediaAction.kind === 'edit') ? (
        <Dialog
          open
          busy={running}
          onClose={() => setMediaAction(null)}
          size="wide"
          kicker={t(mediaAction.kind === 'create' ? 'dialog.createKicker' : 'dialog.editKicker')}
          title={t(mediaAction.kind === 'create' ? 'dialog.createTitle' : 'dialog.editTitle')}
          description={t(mediaAction.kind === 'create'
            ? 'dialog.createDescription'
            : 'dialog.editDescription')}
          initialFocusRef={cancelRef}
        >
          <form className="content-list-dialog-form" onSubmit={submitMedia}>
            <Field label={t('dialog.kind')}>
              {(control) => (
                <select
                  {...control}
                  value={mediaKind}
                  disabled={running || editingNativeUpload}
                  onChange={(event) => changeMediaKind(event.target.value as MediaKind)}
                >
                  {mediaKinds.map((value) => (
                    <option value={value} key={value}>{t(`kinds.${value}`)}</option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('dialog.filename')}>
              {(control) => (
                <input
                  {...control}
                  type="text"
                  maxLength={255}
                  value={filename}
                  required
                  disabled={running}
                  onChange={(event) => setFilename(event.target.value)}
                />
              )}
            </Field>
            <Field label={t('dialog.mimeType')}>
              {(control) => (
                <input
                  {...control}
                  type="text"
                  maxLength={255}
                  value={mimeType}
                  required
                  disabled={running || editingNativeUpload}
                  onChange={(event) => setMimeType(event.target.value)}
                />
              )}
            </Field>
            <Field
              label={t(editingR2 ? 'dialog.storageKey' : 'dialog.source')}
              hint={t(editingR2 ? 'dialog.storageKeyHint' : 'dialog.sourceHint')}
            >
              {(control) => (
                <input
                  {...control}
                  type="text"
                  inputMode={editingR2 ? 'text' : 'url'}
                  maxLength={2048}
                  value={source}
                  required
                  disabled={running || editingR2}
                  onChange={(event) => setSource(event.target.value)}
                />
              )}
            </Field>
            <Field label={t('dialog.sizeBytes')}>
              {(control) => (
                <input
                  {...control}
                  type="number"
                  min={0}
                  value={sizeBytes}
                  disabled={running || editingNativeUpload}
                  onChange={(event) => setSizeBytes(event.target.value)}
                />
              )}
            </Field>
            {mediaKind === 'image' || mediaKind === 'video' ? (
              <div className="media-dimension-fields">
                <Field label={t('dialog.width')}>
                  {(control) => (
                    <input {...control} type="number" min={1} max={100000} value={width} disabled={running} onChange={(event) => setWidth(event.target.value)} />
                  )}
                </Field>
                <Field label={t('dialog.height')}>
                  {(control) => (
                    <input {...control} type="number" min={1} max={100000} value={height} disabled={running} onChange={(event) => setHeight(event.target.value)} />
                  )}
                </Field>
              </div>
            ) : null}
            {mediaKind === 'audio' || mediaKind === 'video' ? (
              <Field label={t('dialog.durationMs')}>
                {(control) => (
                  <input {...control} type="number" min={0} value={durationMs} disabled={running} onChange={(event) => setDurationMs(event.target.value)} />
                )}
              </Field>
            ) : null}
            {mediaKind === 'image' ? (
              <Field label={t('dialog.alt')} hint={t('dialog.altHint')}>
                {(control) => (
                  <input {...control} type="text" maxLength={1000} value={alt} disabled={running} onChange={(event) => setAlt(event.target.value)} />
                )}
              </Field>
            ) : null}
            {failure ? <Notice tone="error">{failureMessage(failure)}</Notice> : null}
            <DialogActions>
              <Button ref={cancelRef} type="button" disabled={running} onClick={() => setMediaAction(null)}>
                {t('dialog.cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={running}>
                {running
                  ? t('dialog.running')
                  : t(mediaAction.kind === 'create' ? 'dialog.confirmCreate' : 'dialog.confirmEdit')}
              </Button>
            </DialogActions>
          </form>
        </Dialog>
      ) : null}

      {collectionAction?.kind === 'manage' ? (
        <Dialog
          open
          size="wide"
          onClose={() => setCollectionAction(null)}
          kicker={t('collections.dialog.manageKicker')}
          title={t('collections.dialog.manageTitle')}
          description={t('collections.description')}
          actions={(
            <Button
              ref={cancelRef}
              type="button"
              onClick={() => setCollectionAction(null)}
            >
              {t('picker.close')}
            </Button>
          )}
        >
          <div className="media-collection-manager">
            <div className="media-collection-manager-heading">
              <p>{t('collections.dialog.manageCount', {
                count: catalogState.items.length,
                max: MEDIA_COLLECTION_MAX_ITEMS,
              })}</p>
              <Button
                type="button"
                variant="primary"
                disabled={catalogState.items.length >= MEDIA_COLLECTION_MAX_ITEMS}
                onClick={openCreateCollection}
              >
                <StudioIcon icon={Plus} className="media-button-icon" />
                {t('collections.create')}
              </Button>
            </div>
            {catalogState.items.length === 0 ? (
              <p className="media-collection-manager-empty">
                {t('collections.dialog.manageEmpty')}
              </p>
            ) : (
              <ul
                className="media-collection-manager-list"
                aria-label={t('collections.dialog.manageList')}
              >
                {catalogState.items.map((item) => (
                  <li key={item.id}>
                    <span className="media-collection-manager-name">
                      <strong>{item.name}</strong>
                      <small className="media-collection-manager-count">{t('collections.mediaCount', {
                        count: item.media_count,
                      })}</small>
                    </span>
                    <span className="media-collection-manager-actions">
                      <Button
                        type="button"
                        size="sm"
                        aria-label={t('collections.editNamed', { name: item.name })}
                        onClick={() => openEditCollection(item)}
                      >
                        <StudioIcon icon={Pencil} className="media-button-icon" />
                        {t('collections.edit')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        aria-label={t('collections.deleteNamed', { name: item.name })}
                        onClick={() => {
                          setCollectionAction({ kind: 'delete', collection: item });
                          setFailure(null);
                        }}
                      >
                        <StudioIcon icon={Trash2} className="media-button-icon" />
                        {t('collections.delete')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog>
      ) : null}

      {collectionAction
        && (collectionAction.kind === 'create' || collectionAction.kind === 'edit') ? (
        <Dialog
          open
          busy={running}
          onClose={() => setCollectionAction({ kind: 'manage' })}
          kicker={t(collectionAction.kind === 'create'
            ? 'collections.dialog.createKicker'
            : 'collections.dialog.editKicker')}
          title={t(collectionAction.kind === 'create'
            ? 'collections.dialog.createTitle'
            : 'collections.dialog.editTitle')}
          description={t('collections.dialog.description')}
          initialFocusRef={cancelRef}
        >
          <form className="content-list-dialog-form" onSubmit={submitCollection}>
            <Field label={t('collections.dialog.name')}>
              {(control) => (
                <input
                  {...control}
                  type="text"
                  required
                  maxLength={100}
                  value={collectionName}
                  disabled={running}
                  onChange={(event) => setCollectionName(event.target.value)}
                />
              )}
            </Field>
            {failure ? <Notice tone="error">{failureMessage(failure)}</Notice> : null}
            <DialogActions>
              {collectionAction.kind === 'edit' ? (
                <Button
                  type="button"
                  variant="danger"
                  disabled={running}
                  onClick={() => {
                    setCollectionAction({
                      kind: 'delete',
                      collection: collectionAction.collection,
                    });
                    setFailure(null);
                  }}
                >
                  {t('collections.delete')}
                </Button>
              ) : null}
              <Button ref={cancelRef} type="button" disabled={running} onClick={() => setCollectionAction({ kind: 'manage' })}>
                {t('dialog.cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={running}>
                {running ? t('dialog.running') : t('collections.dialog.save')}
              </Button>
            </DialogActions>
          </form>
        </Dialog>
      ) : null}

      {collectionAction?.kind === 'delete' ? (
        <Dialog
          open
          busy={running}
          onClose={() => setCollectionAction({ kind: 'manage' })}
          kicker={t('collections.dialog.deleteKicker')}
          title={t('collections.dialog.deleteTitle', { name: collectionAction.collection.name })}
          description={t('collections.dialog.deleteDescription')}
          initialFocusRef={cancelRef}
          actions={(
            <>
              <Button ref={cancelRef} type="button" disabled={running} onClick={() => setCollectionAction({ kind: 'manage' })}>
                {t('dialog.cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={running || collectionAction.collection.media_count > 0}
                onClick={confirmDeleteCollection}
              >
                {running ? t('dialog.running') : t('collections.dialog.confirmDelete')}
              </Button>
            </>
          )}
        >
          {collectionAction.collection.media_count > 0 ? (
            <Notice tone="info">{t('collections.dialog.deleteBlocked')}</Notice>
          ) : null}
          {failure ? <Notice tone="error">{failureMessage(failure)}</Notice> : null}
        </Dialog>
      ) : null}

      {collectionAction?.kind === 'move' ? (
        <Dialog
          open
          busy={running}
          onClose={() => setCollectionAction(null)}
          kicker={t('bulk.kicker')}
          title={t('bulk.title', { count: selectedItems.length })}
          description={t('bulk.description')}
          initialFocusRef={cancelRef}
          actions={(
            <>
              <Button ref={cancelRef} type="button" disabled={running} onClick={() => setCollectionAction(null)}>
                {t('dialog.cancel')}
              </Button>
              <Button type="button" variant="primary" disabled={running} onClick={confirmBulkMove}>
                {running ? t('dialog.running') : t('bulk.confirm')}
              </Button>
            </>
          )}
        >
          <div className="content-list-dialog-form">
            <Field label={t('bulk.target')}>
              {(control) => (
                <select {...control} value={moveTarget} disabled={running} onChange={(event) => setMoveTarget(event.target.value)}>
                  <option value="unfiled">{t('collections.unfiled')}</option>
                  {catalogState.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {failure ? <Notice tone="error">{failureMessage(failure)}</Notice> : null}
          </div>
        </Dialog>
      ) : null}

      {bulkAction === 'edit' ? (
        <Dialog
          open
          busy={running}
          size="wide"
          onClose={() => setBulkAction(null)}
          kicker={t('bulk.editDialog.kicker')}
          title={t('bulk.editDialog.title', { count: selectedItems.length })}
          description={t('bulk.editDialog.description')}
          initialFocusRef={cancelRef}
          actions={(
            <>
              <Button ref={cancelRef} type="button" disabled={running} onClick={() => setBulkAction(null)}>
                {t('dialog.cancel')}
              </Button>
              <Button type="button" variant="primary" disabled={running} onClick={confirmBulkMetadataUpdate}>
                {running ? t('dialog.running') : t('bulk.editDialog.confirm')}
              </Button>
            </>
          )}
        >
          <div className="media-bulk-metadata-list">
            {selectedItems.map((item) => (
              <fieldset key={item.id} className="media-bulk-metadata-item">
                <legend>{item.filename}</legend>
                <Field label={t('dialog.filename')}>
                  {(control) => (
                    <input
                      {...control}
                      type="text"
                      required
                      maxLength={255}
                      disabled={running}
                      value={bulkMetadata[item.id]?.filename ?? item.filename}
                      onChange={(event) => setBulkMetadata((current) => ({
                        ...current,
                        [item.id]: {
                          filename: event.target.value,
                          alt: current[item.id]?.alt ?? item.alt,
                        },
                      }))}
                    />
                  )}
                </Field>
                {item.kind === 'image' ? (
                  <Field label={t('dialog.alt')} hint={t('dialog.altHint')}>
                    {(control) => (
                      <input
                        {...control}
                        type="text"
                        maxLength={1000}
                        disabled={running}
                        value={bulkMetadata[item.id]?.alt ?? item.alt}
                        onChange={(event) => setBulkMetadata((current) => ({
                          ...current,
                          [item.id]: {
                            filename: current[item.id]?.filename ?? item.filename,
                            alt: event.target.value,
                          },
                        }))}
                      />
                    )}
                  </Field>
                ) : null}
              </fieldset>
            ))}
          </div>
          {failure ? <Notice tone="error">{failureMessage(failure)}</Notice> : null}
        </Dialog>
      ) : null}

      {bulkAction === 'delete' ? (
        <Dialog
          open
          busy={running}
          onClose={() => setBulkAction(null)}
          kicker={t('bulk.deleteDialog.kicker')}
          title={t('bulk.deleteDialog.title', { count: selectedItems.length })}
          description={t('bulk.deleteDialog.description')}
          initialFocusRef={cancelRef}
          actions={(
            <>
              <Button ref={cancelRef} type="button" disabled={running} onClick={() => setBulkAction(null)}>
                {t('dialog.cancel')}
              </Button>
              <Button type="button" variant="danger" disabled={running} onClick={confirmBulkDelete}>
                {running ? t('dialog.running') : t('bulk.deleteDialog.confirm')}
              </Button>
            </>
          )}
        >
          <Callout tone="warning" title={t('bulk.deleteDialog.impactTitle')}>
            {t('bulk.deleteDialog.impact', {
              r2: selectedItems.filter((item) => item.location.type === 'r2').length,
              external: selectedItems.filter((item) => item.location.type === 'external').length,
              inUse: selectedItems.filter((item) => (
                item.usage.posts + item.usage.pages + item.usage.authors
                  + item.usage.branding > 0
              )).length,
            })}
          </Callout>
          {failure ? <Notice tone="error">{failureMessage(failure)}</Notice> : null}
        </Dialog>
      ) : null}

    </main>
  );
}

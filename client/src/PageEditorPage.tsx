import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import {
  Link,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router';
import {
  ArrowLeft,
  History,
  Save,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { ApiErrorCode } from '../../contracts/api';
import { contentDraftIdSchema } from '../../contracts/content-snapshots';
import type { Media, MediaReference } from '../../contracts/media';
import {
  currentPageContentSnapshotSchema,
  normalizePageContentSnapshot,
  type CurrentPageContentSnapshot,
  type PageAutosaveDocument,
} from '../../contracts/page-autosaves';
import {
  createPageRequestSchema,
  PAGE_CONTENT_MAX_LENGTH,
  pageIdSchema,
  suggestPageSlug,
  type CreatePageRequest,
  type Page,
  type PageParentOption,
} from '../../contracts/pages';
import {
  Button,
  ButtonLink,
  Dialog,
  Field,
  Notice,
  PageHeader,
  Panel,
  RouteLoading,
  StudioIcon,
} from './components/primitives';
import { UnsavedChangesGuard } from './components/UnsavedChangesGuard';
import { CommentRuntimeStatus } from './components/CommentRuntimeStatus';
import { FeaturedImageField } from './components/FeaturedImageField';
import {
  ContentRecoveryDialog,
  ContentRecoveryNotice,
} from './components/ContentRecoveryDialog';
import { ContentAutosaveComparisonDialog } from './components/ContentAutosaveComparisonDialog';
import { ContentRevisionHistoryDialog } from './components/ContentRevisionHistoryDialog';
import { ContentMediaInsertDialog } from './components/ContentMediaInsertDialog';
import { AiExcerptField } from './components/AiExcerptField';
import {
  AiPageDraftDialog,
  type AiContentDraftSelection,
} from './components/AiPostDraftDialog';
import type {
  AiPageDraftCandidate,
  AiPageDraftTarget,
} from '../../contracts/ai-page-draft';
import {
  ContentBodyEditor,
  type ContentBodyEditorHandle,
} from './components/ContentBodyEditor';
import {
  createContentDraftId,
  useContentAutosave,
  type ContentAutosavePersistResult,
} from './hooks/useContentAutosave';
import {
  PagesClientError,
  requestCreatePage,
  requestDeletePage,
  requestPage,
  requestPageAutosave,
  requestRecentPageAutosave,
  requestPromotePageAutosave,
  requestPageParentOptions,
  requestPutPageAutosave,
  requestDeletePageAutosave,
  requestGeneratePageExcerpt,
  requestGeneratePageDraft,
  requestPageRevision,
  requestPageRevisions,
  requestRestorePageRevision,
  requestUpdatePage,
} from './lib/pages-client';
import { STUDIO_PATHS, studioPagePath } from './routing/studio-routes';

type AccountSession = {
  csrf_token: string;
  user?: { roles: string[] };
};
type PageDraft = Omit<CreatePageRequest, 'autosave_draft_id'>;
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; page: Page | null }
  | { kind: 'not_found' }
  | { kind: 'error' };
type Failure =
  | { kind: 'validation' }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' };

const EMPTY_DRAFT: PageDraft = {
  parent_id: null,
  title: '',
  slug: '',
  content: '',
  document_type: 'html',
  editor_mode: 'visual',
  editor_profile: 'tiptap-v1',
  excerpt: '',
  status: 'draft',
  discoverability: 'default',
  allow_comments: false,
  featured_image_id: null,
};

function draftFromPage(page: Page): PageDraft {
  return {
    parent_id: page.parent?.id ?? null,
    title: page.title,
    slug: page.slug,
    content: page.content,
    document_type: page.document_type,
    editor_mode: page.editor_mode,
    editor_profile: page.editor_profile,
    excerpt: page.excerpt,
    status: page.status,
    discoverability: page.discoverability,
    allow_comments: page.allow_comments,
    featured_image_id: page.featured_image?.id ?? null,
  };
}

function mergeParentOptions(
  current: PageParentOption[],
  incoming: PageParentOption[],
): PageParentOption[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()].sort((left, right) => (
    left.path.localeCompare(right.path) || left.id.localeCompare(right.id)
  ));
}

function currentParentOption(page: Page): PageParentOption | null {
  if (!page.parent) return null;
  const segments = page.path.split('/');
  segments.pop();
  const path = segments.join('/');
  if (!path) return null;
  return {
    id: page.parent.id,
    title: page.parent.title,
    slug: page.parent.slug,
    path,
  };
}

function snapshotFromDraft(
  draft: PageDraft,
  parentOptions: PageParentOption[],
  featuredImage: MediaReference | null,
): CurrentPageContentSnapshot | null {
  const parent = draft.parent_id === null
    ? null
    : parentOptions.find((item) => item.id === draft.parent_id) ?? null;
  if (
    (draft.parent_id !== null && parent === null)
    || (featuredImage?.id ?? null) !== draft.featured_image_id
  ) return null;
  const parsed = currentPageContentSnapshotSchema.safeParse({
    version: 2,
    content_type: 'page',
    draft,
    references: { parent, featured_image: featuredImage },
  });
  return parsed.success ? parsed.data : null;
}

export function PageEditorPage(input: {
  mode: 'create' | 'edit';
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('pages');
  const allowCommentsId = useId();
  const allowCommentsHintId = useId();
  const { t: tMedia } = useTranslation('media');
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ pageId: string }>();
  // The Field primitive generates control IDs and ARIA associations.
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [draft, setDraft] = useState<PageDraft>({ ...EMPTY_DRAFT });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [originalDraftKey, setOriginalDraftKey] = useState('');
  const [initialAutosaveQuery] = useState(() => {
    const requested = new URLSearchParams(location.search).get('autosave');
    const parsed = contentDraftIdSchema.safeParse(requested);
    return parsed.success
      ? { explicit: true as const, draftId: parsed.data }
      : { explicit: false as const, draftId: createContentDraftId() };
  });
  const [autosaveDraftId, setAutosaveDraftId] = useState(() => {
    return initialAutosaveQuery.draftId;
  });
  const [recoveryCandidate, setRecoveryCandidate] = useState<PageAutosaveDocument | null>(null);
  const [recoveryComparisonOpen, setRecoveryComparisonOpen] = useState(false);
  const [recoveryDiscarding, setRecoveryDiscarding] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [persistedSnapshotKey, setPersistedSnapshotKey] = useState('');
  const [recoveredAutosaveAtIso, setRecoveredAutosaveAtIso] = useState<string | null>(null);
  const promotedPageRef = useRef<Page | null>(null);
  const [promotedPage, setPromotedPage] = useState<Page | null>(null);
  const [featuredImageReference, setFeaturedImageReference] = useState<MediaReference | null>(null);
  const [slugEdited, setSlugEdited] = useState(false);
  const [parentOptions, setParentOptions] = useState<PageParentOption[]>([]);
  const parentOptionsRef = useRef(parentOptions);
  parentOptionsRef.current = parentOptions;
  const [parentSearch, setParentSearch] = useState('');
  const [parentSearching, setParentSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [revisionHistoryOpen, setRevisionHistoryOpen] = useState(false);
  const [contentMediaMode, setContentMediaMode] = useState<
    'insert' | 'replace-image' | null
  >(null);
  const [aiDraftOpen, setAiDraftOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const contentEditorRef = useRef<ContentBodyEditorHandle>(null);
  const [contentBridgeDirty, setContentBridgeDirty] = useState(false);
  const featuredImageReferenceRef = useRef(featuredImageReference);
  featuredImageReferenceRef.current = featuredImageReference;
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deletingRef = useRef(deleting);
  deletingRef.current = deleting;
  const parsedPageId = input.mode === 'edit'
    ? pageIdSchema.safeParse(params.pageId)
    : null;
  const currentPage = loadState.kind === 'ready' ? loadState.page : null;
  const effectivePage = currentPage ?? promotedPage;
  const recoveryDecisionRequired = recoveryCandidate !== null
    && currentPage !== null;
  const canChangeDocumentType = draft.content === ''
    && (effectivePage?.content ?? '') === '';
  const hasChanges = loadState.kind === 'ready'
    && (contentBridgeDirty || JSON.stringify(draft) !== originalDraftKey);
  const canonicalDraft = useMemo(() => (
    originalDraftKey === ''
      ? null
      : JSON.parse(originalDraftKey) as PageDraft
  ), [originalDraftKey]);
  const canonicalEditorContextClean = canonicalDraft !== null
    && !contentBridgeDirty
    && JSON.stringify({
      ...draft,
      content: canonicalDraft.content,
      editor_mode: canonicalDraft.editor_mode,
      editor_profile: canonicalDraft.editor_profile,
    }) === originalDraftKey;
  const selectedParent = parentOptions.find(
    (option) => option.id === draft.parent_id,
  );
  const effectivePath = [selectedParent?.path, draft.slug]
    .filter(Boolean)
    .join('/');
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    { dateStyle: 'medium', timeStyle: 'short' },
  ), [i18n.resolvedLanguage]);
  const autosaveSnapshot = useMemo(() => snapshotFromDraft(
    draft,
    parentOptions,
    featuredImageReference,
  ), [draft, featuredImageReference, parentOptions]);
  const normalizedRecoverySnapshot = useMemo(() => (
    recoveryCandidate
      ? normalizePageContentSnapshot(recoveryCandidate.snapshot)
      : null
  ), [recoveryCandidate]);
  const persistAutosave = useCallback(async (
    snapshot: CurrentPageContentSnapshot,
    _reason: 'scheduled' | 'flush',
  ): Promise<ContentAutosavePersistResult> => {
    try {
      const target = currentPage ?? promotedPageRef.current;
      const response = await requestPutPageAutosave(input.data.csrf_token, {
        draft_id: autosaveDraftId,
        target_id: target?.id ?? null,
        base_revision: target?.revision ?? null,
        snapshot,
      });
      if (response.success) {
        if (
          target === null
          && snapshot.draft.status === 'draft'
          && createPageRequestSchema.safeParse(snapshot.draft).success
        ) {
          try {
            const promotion = await requestPromotePageAutosave(
              input.data.csrf_token,
              { draft_id: autosaveDraftId },
            );
            if (promotion.success) {
              promotedPageRef.current = promotion.data.page;
              setPromotedPage(promotion.data.page);
            } else if (promotion.error.code === 'AUTHENTICATION_REQUIRED') {
              input.onSessionEnded();
            }
          } catch {
            // The recovery snapshot is already durable. Draft promotion is a
            // best-effort follow-up and must not downgrade that successful save.
          }
        }
        return { kind: 'saved', updatedAtIso: response.data.updated_at_iso };
      }
      if (response.error.code === 'AUTHENTICATION_REQUIRED') {
        input.onSessionEnded();
        return { kind: 'session_ended' };
      }
      if (
        response.error.code === 'PAGE_REVISION_CONFLICT'
        || response.error.code === 'PAGE_NOT_FOUND'
      ) return { kind: 'conflict' };
      return { kind: 'failed' };
    } catch {
      return { kind: 'failed' };
    }
  }, [autosaveDraftId, currentPage, input.data.csrf_token, input.onSessionEnded]);
  const prepareAutosaveSnapshot = useCallback(() => {
    const current = draftRef.current;
    const content = contentEditorRef.current?.flush() ?? current.content;
    return snapshotFromDraft(
      content === current.content ? current : { ...current, content },
      parentOptionsRef.current,
      featuredImageReferenceRef.current,
    );
  }, []);
  const autosave = useContentAutosave({
    active: loadState.kind === 'ready'
      && hasChanges
      && !saving
      && recoveryCandidate === null,
    snapshot: autosaveSnapshot,
    externalSnapshotDirty: contentBridgeDirty,
    prepareSnapshot: prepareAutosaveSnapshot,
    persistedSnapshotKey,
    persist: persistAutosave,
  });
  const discardStoredAutosave = useCallback(async () => {
    await autosave.prepareForCanonicalSave();
    try {
      const response = await requestDeletePageAutosave(
        input.data.csrf_token,
        { draft_id: autosaveDraftId },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
        } else {
          autosave.resumeAfterCanonicalFailure();
        }
        return false;
      }
      setPersistedSnapshotKey('');
      autosave.markAutosaveDiscarded();
      return true;
    } catch {
      autosave.resumeAfterCanonicalFailure();
      return false;
    }
  }, [
    autosave.markAutosaveDiscarded,
    autosave.prepareForCanonicalSave,
    autosave.resumeAfterCanonicalFailure,
    autosaveDraftId,
    input.data.csrf_token,
    input.onSessionEnded,
  ]);

  useEffect(() => {
    if (
      loadState.kind === 'ready'
      && !hasChanges
      && recoveryCandidate === null
      && autosave.hasPersistedAutosave
    ) void discardStoredAutosave();
  }, [autosave.hasPersistedAutosave, discardStoredAutosave, hasChanges, loadState.kind, recoveryCandidate]);

  useEffect(() => {
    if (
      input.mode === 'create'
      && promotedPage
      && autosave.durability === 'recoverable'
    ) {
      navigate(studioPagePath(promotedPage.id), { replace: true });
    }
  }, [autosave.durability, input.mode, navigate, promotedPage]);

  useStudioDocumentTitle(t(input.mode === 'create'
    ? 'editor.createDocumentTitle'
    : 'editor.editDocumentTitle'));

  useEffect(() => {
    if (input.mode !== 'create') return;
    const query = new URLSearchParams(location.search);
    if (query.get('autosave') === autosaveDraftId) return;
    query.set('autosave', autosaveDraftId);
    navigate(`${location.pathname}?${query.toString()}`, {
      replace: true,
      state: location.state,
    });
  }, [autosaveDraftId, input.mode, location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    if (input.mode === 'edit' && !parsedPageId?.success) {
      setLoadState({ kind: 'not_found' });
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setFailure(null);
    setRecoveryError(null);
    setRecoveryComparisonOpen(false);
    const pageRequest = input.mode === 'edit' && parsedPageId?.success
      ? requestPage(parsedPageId.data, controller.signal)
      : Promise.resolve(null);
    const autosaveRequest = input.mode === 'edit' && parsedPageId?.success
      ? requestPageAutosave({ target_id: parsedPageId.data }, controller.signal)
      : initialAutosaveQuery.explicit
        ? requestPageAutosave(
            { draft_id: initialAutosaveQuery.draftId },
            controller.signal,
          )
        : requestRecentPageAutosave(controller.signal);
    void Promise.all([
      pageRequest,
      autosaveRequest,
      requestPageParentOptions(
        '',
        parsedPageId?.success ? parsedPageId.data : undefined,
        controller.signal,
      ),
    ]).then(([pageResponse, autosaveResponse, optionsResponse]) => {
      if (!active) return;
      if (!optionsResponse.success) {
        if (optionsResponse.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({ kind: 'error' });
        return;
      }
      if (pageResponse && !pageResponse.success) {
        if (pageResponse.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        if (pageResponse.error.code === 'PAGE_NOT_FOUND') {
          setLoadState({ kind: 'not_found' });
          return;
        }
        setLoadState({ kind: 'error' });
        return;
      }
      if (!autosaveResponse.success) {
        if (autosaveResponse.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({ kind: 'error' });
        return;
      }
      const page = pageResponse?.success ? pageResponse.data : null;
      const autosaveDocument = autosaveResponse.data.autosave;
      if (!page && autosaveDocument?.target_id) {
        void requestPage(autosaveDocument.target_id, controller.signal).then(
          (targetResponse) => {
            if (!active) return;
            if (targetResponse.success) {
              navigate(studioPagePath(targetResponse.data.id), {
                replace: true,
              });
            } else if (
              targetResponse.error.code === 'AUTHENTICATION_REQUIRED'
            ) {
              input.onSessionEnded();
            } else {
              setLoadState({ kind: 'error' });
            }
          },
          () => {
            if (active && !controller.signal.aborted) {
              setLoadState({ kind: 'error' });
            }
          },
        );
        return;
      }
      const nextDraft = page ? draftFromPage(page) : { ...EMPTY_DRAFT };
      const parent = page ? currentParentOption(page) : null;
      setOriginalDraftKey(JSON.stringify(nextDraft));
      setRecoveredAutosaveAtIso(null);
      let initialParentOptions = mergeParentOptions(
        parent ? [parent] : [],
        optionsResponse.data.items,
      );
      if (autosaveDocument) {
        const normalizedSnapshot = normalizePageContentSnapshot(
          autosaveDocument.snapshot,
        );
        if (normalizedSnapshot.references.parent) {
          initialParentOptions = mergeParentOptions(
            initialParentOptions,
            [normalizedSnapshot.references.parent],
          );
        }
        setAutosaveDraftId(autosaveDocument.draft_id);
        setPersistedSnapshotKey(JSON.stringify(normalizedSnapshot));
        const differsFromCanonical = JSON.stringify(
          normalizedSnapshot.draft,
        ) !== JSON.stringify(nextDraft);
        setRecoveryCandidate(
          differsFromCanonical ? autosaveDocument : null,
        );
      } else {
        setPersistedSnapshotKey('');
        setRecoveryCandidate(null);
      }
      setDraft(nextDraft);
      setContentBridgeDirty(false);
      setSlugEdited(Boolean(page) || nextDraft.slug !== '');
      setFeaturedImageReference(page?.featured_image ?? null);
      setParentOptions(initialParentOptions);
      setLoadState({ kind: 'ready', page });
      setSaved(Boolean((location.state as { saved?: boolean } | null)?.saved));
      if ((location.state as { saved?: boolean } | null)?.saved) {
        navigate(location.pathname, { replace: true, state: null });
      }
    }).catch(() => {
      if (active && !controller.signal.aborted) setLoadState({ kind: 'error' });
    });
    return () => {
      active = false;
      controller.abort();
    };
  // Location state is consumed without turning save notifications into reloads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.mode, input.onSessionEnded, loadAttempt, params.pageId]);

  // The Dialog primitive owns focus trapping, Escape handling,
  // and scroll locking for the deletion dialog.

  function updateDraft<K extends keyof PageDraft>(key: K, value: PageDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
    setFailure(null);
  }

  function changeDocumentType(documentType: PageDraft['document_type']) {
    const current = draftRef.current;
    if (documentType === current.document_type || !canChangeDocumentType) return;
    setDraft({
      ...current,
      document_type: documentType,
      editor_mode: documentType === 'html' ? 'visual' : 'source',
      editor_profile: documentType === 'html' ? 'tiptap-v1' : null,
    });
    setContentBridgeDirty(false);
    setSaved(false);
    setFailure(null);
  }

  function insertContentMedia(media: Media): boolean {
    const inserted = contentMediaMode === 'replace-image'
      ? contentEditorRef.current?.replaceSelectedImage(media) ?? false
      : contentEditorRef.current?.insertMedia(media) ?? false;
    if (inserted) setContentMediaMode(null);
    return inserted;
  }

  function applyAiPageDraft(
    candidate: AiPageDraftCandidate,
    selection: AiContentDraftSelection,
  ) {
    setContentBridgeDirty(false);
    setDraft((current) => {
      const next = {
        ...current,
        ...(selection.title ? { title: candidate.title } : {}),
        ...(selection.excerpt ? { excerpt: candidate.excerpt } : {}),
        ...(selection.content ? {
          content: candidate.content,
          document_type: candidate.document_type,
          editor_mode: candidate.editor_mode,
          editor_profile: candidate.editor_profile,
        } : {}),
      };
      if (selection.title && !slugEdited) {
        next.slug = suggestPageSlug(candidate.title);
      }
      return next;
    });
    setSaved(false);
    setFailure(null);
  }

  function failureMessage(current: Failure): string {
    if (current.kind === 'validation') return t('errors.validation');
    if (current.kind === 'client') {
      if (current.code === 'TIMEOUT') return t('errors.timeout');
      if (current.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (current.code === 'PAGE_SLUG_CONFLICT') return t('errors.slugConflict');
    if (current.code === 'PAGE_REVISION_CONFLICT') return t('errors.revisionConflict');
    if (current.code === 'PAGE_NOT_FOUND') return t('errors.notFound');
    if (current.code === 'PAGE_NOT_IN_TRASH') return t('errors.notInTrash');
    if (current.code === 'PAGE_PARENT_NOT_FOUND') return t('errors.parentNotFound');
    if (current.code === 'PAGE_PARENT_CYCLE') return t('errors.parentCycle');
    if (current.code === 'PAGE_HAS_CHILDREN') return t('errors.hasChildren');
    if (current.code === 'PAGE_IS_FRONT_PAGE') return t('errors.frontPage');
    if (current.code === 'CONTENT_DOCUMENT_TYPE_CHANGE_FORBIDDEN') {
      return t('errors.documentTypeChangeForbidden');
    }
    if (current.code === 'FORBIDDEN') return t('errors.forbidden');
    return t('errors.api');
  }

  function restoreAutosave() {
    if (!recoveryCandidate || !normalizedRecoverySnapshot) return;
    const recoveredAtIso = recoveryCandidate.updated_at_iso;
    const snapshot = normalizedRecoverySnapshot;
    setDraft(snapshot.draft);
    setFeaturedImageReference(snapshot.references.featured_image);
    if (snapshot.references.parent) {
      setParentOptions((current) => mergeParentOptions(
        current,
        [snapshot.references.parent!],
      ));
    }
    setSlugEdited(snapshot.draft.slug !== '');
    setRecoveryError(null);
    setRecoveryComparisonOpen(false);
    setRecoveryCandidate(null);
    setRecoveredAutosaveAtIso(recoveredAtIso);
    setContentBridgeDirty(false);
  }

  async function discardAutosave() {
    if (!recoveryCandidate || recoveryDiscarding) return;
    setRecoveryDiscarding(true);
    setRecoveryError(null);
    try {
      if (!await discardStoredAutosave()) {
        setRecoveryError(t('autosave.discardError'));
        return;
      }
      setRecoveryComparisonOpen(false);
      setRecoveryCandidate(null);
    } catch {
      setRecoveryError(t('autosave.discardError'));
    } finally {
      setRecoveryDiscarding(false);
    }
  }

  async function refreshParentOptions() {
    if (parentSearching) return;
    setParentSearching(true);
    setFailure(null);
    try {
      const response = await requestPageParentOptions(
        parentSearch.trim(),
        parsedPageId?.success ? parsedPageId.data : undefined,
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          autosave.resumeAfterCanonicalFailure();
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      const selected = parentOptionsRef.current.filter(
        (option) => option.id === draft.parent_id,
      );
      setParentOptions(mergeParentOptions(selected, response.data.items));
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof PagesClientError
          ? error.code
          : 'INVALID_RESPONSE',
      });
    } finally {
      setParentSearching(false);
    }
  }

  async function savePage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loadState.kind !== 'ready') return;
    const current = draftRef.current;
    const content = contentEditorRef.current?.flush() ?? current.content;
    const draftForSave = content === current.content
      ? current
      : { ...current, content };
    const parsed = createPageRequestSchema.safeParse(draftForSave);
    if (!parsed.success) {
      setFailure({ kind: 'validation' });
      return;
    }
    setSaving(true);
    setFailure(null);
    setSaved(false);
    try {
      await autosave.prepareForCanonicalSave();
      const targetPage = currentPage ?? promotedPageRef.current;
      const response = targetPage
        ? await requestUpdatePage(input.data.csrf_token, targetPage.id, {
            ...parsed.data,
            expected_revision: targetPage.revision,
            autosave_draft_id: autosaveDraftId,
          })
        : await requestCreatePage(input.data.csrf_token, {
            ...parsed.data,
            autosave_draft_id: autosaveDraftId,
          });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        autosave.resumeAfterCanonicalFailure();
        return;
      }
      const nextDraft = draftFromPage(response.data);
      const parent = currentParentOption(response.data);
      setDraft(nextDraft);
      setContentBridgeDirty(false);
      setOriginalDraftKey(JSON.stringify(nextDraft));
      setParentOptions((current) => mergeParentOptions(
        parent ? [parent] : [],
        current,
      ));
      setSaved(true);
      setLoadState({ kind: 'ready', page: response.data });
      setFeaturedImageReference(response.data.featured_image);
      setPersistedSnapshotKey('');
      autosave.markCanonicalSaveCompleted();
      if (input.mode === 'create') {
        navigate(studioPagePath(response.data.id), {
          replace: true,
          state: { saved: true },
        });
      }
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof PagesClientError
          ? error.code
          : 'INVALID_RESPONSE',
      });
      autosave.resumeAfterCanonicalFailure();
    } finally {
      setSaving(false);
    }
  }

  async function permanentlyDelete() {
    if (
      !currentPage
      || currentPage.status !== 'trash'
      || hasChanges
      || deleting
    ) return;
    setDeleting(true);
    setFailure(null);
    try {
      const response = await requestDeletePage(
        input.data.csrf_token,
        currentPage.id,
        { expected_revision: currentPage.revision },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setDeleteOpen(false);
      navigate(STUDIO_PATHS.pages, { replace: true });
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof PagesClientError
          ? error.code
          : 'INVALID_RESPONSE',
      });
    } finally {
      setDeleting(false);
    }
  }

  if (loadState.kind === 'loading') {
    return (
      <RouteLoading>{t('editor.loading')}</RouteLoading>
    );
  }
  if (loadState.kind === 'not_found') {
    return (
      <main
        id="studio-main-content"
        aria-labelledby="page-editor-title"
      >
        <PageHeader
          titleId="page-editor-title"
          kicker={t('editor.notFoundKicker')}
          title={t('editor.notFoundTitle')}
          description={t('editor.notFoundDescription')}
          actions={(
            <ButtonLink to={STUDIO_PATHS.pages}>
              {t('editor.backToPages')}
            </ButtonLink>
          )}
        />
      </main>
    );
  }
  if (loadState.kind === 'error') {
    return (
      <main
        id="studio-main-content"
        aria-labelledby="page-editor-title"
      >
        <PageHeader
          titleId="page-editor-title"
          kicker={t('editor.kicker')}
          title={t(input.mode === 'create'
            ? 'editor.createTitle'
            : 'editor.editTitle')}
        />
        <Notice
          tone="error"
          actions={(
            <Button
              type="button"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              {t('list.retry')}
            </Button>
          )}
        >
          {t('errors.loadEditor')}
        </Notice>
      </main>
    );
  }

  const aiDraftTarget: AiPageDraftTarget | null = draft.document_type === 'html'
    ? {
        document_type: 'html',
        editor_mode: draft.editor_mode,
      }
    : draft.editor_mode === 'source'
      ? {
          document_type: draft.document_type,
          editor_mode: 'source',
        }
      : null;
  const aiDraftAvailable = draft.status === 'draft'
    && aiDraftTarget !== null
    && draft.content.trim() === ''
    && !contentBridgeDirty
    && !saving
    && !recoveryDecisionRequired;
  return (
    <>
      <main
        id="studio-main-content"
      >
        <PageHeader
          titleId="page-editor-title"
          kicker={t('editor.kicker')}
          title={t(input.mode === 'create'
            ? 'editor.createTitle'
            : 'editor.editTitle')}
          description={t('editor.description')}
        />

        {recoveredAutosaveAtIso ? (
          <Notice tone="info">
            {t('autosave.recoveredCurrent', {
              time: dateFormatter.format(new Date(recoveredAutosaveAtIso)),
            })}
          </Notice>
        ) : null}

        {recoveryDecisionRequired && recoveryCandidate && currentPage ? (
          <ContentRecoveryNotice
            title={t('autosave.recoveryTitle')}
            description={t('autosave.recoveryDescription')}
            staleDescription={t('autosave.recoveryStale')}
            isStale={recoveryCandidate.base_revision !== currentPage.revision}
            updatedLabel={t('autosave.recoveryUpdated', {
              time: dateFormatter.format(new Date(recoveryCandidate.updated_at_iso)),
            })}
            discardLabel={t('autosave.discard')}
            restoreLabel={t('autosave.restore')}
            compareLabel={autosaveSnapshot
              ? t('autosave.compare')
              : undefined}
            discardingLabel={t('autosave.discarding')}
            busy={recoveryDiscarding}
            error={recoveryError}
            onDiscard={() => void discardAutosave()}
            onRestore={restoreAutosave}
            onCompare={autosaveSnapshot
              ? () => setRecoveryComparisonOpen(true)
              : undefined}
          />
        ) : null}

        <form
          className="content-editor-form content-editor-page-form"
          onSubmit={savePage}
        >
          <fieldset
            className="content-editor-recovery-fields"
            disabled={recoveryDecisionRequired}
          >
            <legend className="visually-hidden">
              {t('autosave.resolveBeforeEditing')}
            </legend>
            <header className="content-editor-command-bar">
              <Link className="content-editor-back" to={STUDIO_PATHS.pages}>
                <StudioIcon icon={ArrowLeft} />
                <span className="content-editor-back-label">
                  {t('editor.backToPages')}
                </span>
              </Link>
              {saved || (!saved && hasChanges) || failure ? (
                <div className="content-editor-status">
                  {saved ? (
                    <strong className="content-editor-saved" role="status">
                      {t('editor.saved')}
                    </strong>
                  ) : null}
                  {!saved && hasChanges ? (
                    <span
                      className={`content-autosave-status is-${autosave.status}`}
                      role="status"
                    >
                      {t(`autosave.status.${autosave.status}`, {
                        time: autosave.lastSavedAtIso
                          ? dateFormatter.format(
                              new Date(autosave.lastSavedAtIso),
                            )
                          : '',
                      })}
                    </span>
                  ) : null}
                  {failure ? (
                    <span className="content-editor-failure" role="alert">
                      {failureMessage(failure)}
                    </span>
                  ) : null}
                  {failure?.kind === 'api'
                    && failure.code === 'PAGE_REVISION_CONFLICT' ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => setLoadAttempt((value) => value + 1)}
                      >
                        {t('editor.reloadLatest')}
                      </Button>
                    ) : null}
                </div>
              ) : null}
              <div className="content-editor-command-buttons">
                {aiDraftAvailable ? (
                  <Button type="button" onClick={() => setAiDraftOpen(true)}>
                    <StudioIcon
                      className="content-editor-button-icon"
                      icon={Sparkles}
                    />
                    <span className="content-editor-command-label-secondary">
                      {t('aiDraft.open')}
                    </span>
                  </Button>
                ) : null}
                {currentPage ? (
                  <Button
                    type="button"
                    disabled={hasChanges || saving}
                    title={hasChanges
                      ? t('revisions.saveBeforeViewing')
                      : undefined}
                    onClick={() => setRevisionHistoryOpen(true)}
                  >
                    <StudioIcon
                      className="content-editor-button-icon"
                      icon={History}
                    />
                    <span className="content-editor-command-label-secondary">
                      {t('revisions.open')}
                    </span>
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  variant="primary"
                  disabled={saving || !hasChanges}
                >
                  <StudioIcon
                    className="content-editor-button-icon"
                    icon={Save}
                  />
                  {saving ? t('editor.saving') : t('editor.save')}
                </Button>
              </div>
            </header>
            <div className="content-editor-main">
              <Panel>
                <div className="content-editor-title-fields">
                  <Field
                    label={t('editor.titleLabel')}
                    labelHidden
                    variant="title"
                  >
                  {(control) => (
                    <input
                      {...control}
                      type="text"
                      maxLength={200}
                      required
                      placeholder={t('editor.titleLabel')}
                      value={draft.title}
                      onChange={(event) => {
                        const value = event.target.value;
                        updateDraft('title', value);
                        if (!slugEdited) {
                          setDraft((current) => ({
                            ...current,
                            slug: suggestPageSlug(value),
                          }));
                        }
                      }}
                    />
                  )}
                  </Field>
                  <Field
                    label={t('editor.slugLabel')}
                    hint={t('editor.slugHint')}
                  >
                  {(control) => (
                    <input
                      {...control}
                      type="text"
                      maxLength={400}
                      required
                      value={draft.slug}
                      onChange={(event) => {
                        setSlugEdited(true);
                        updateDraft('slug', event.target.value);
                      }}
                    />
                  )}
                  </Field>
                  {effectivePage ? (
                    <dl className="content-editor-identity">
                      <div>
                        <dt>{t('editor.publicId')}</dt>
                        <dd>{effectivePage.public_id}</dd>
                      </div>
                      <div>
                        <dt>{t('editor.effectivePath')}</dt>
                        <dd>/{effectivePage.path}</dd>
                      </div>
                      <div>
                        <dt>{t('editor.updated')}</dt>
                        <dd>
                          {dateFormatter.format(
                            new Date(effectivePage.updated_at_iso),
                          )}
                        </dd>
                      </div>
                    </dl>
                  ) : null}
                </div>
              </Panel>

              <Panel title={t('editor.contentHeading')}>
                <div className="content-editor-fields">
                <div className="content-editor-source-heading">
                  <Field label={t('editor.documentTypeLabel')}>
                    {(control) => (
                      <select
                        {...control}
                        value={draft.document_type}
                        disabled={!canChangeDocumentType}
                        onChange={(event) => changeDocumentType(
                          event.target.value as PageDraft['document_type'],
                        )}
                      >
                        <option value="html">{t('documentType.html')}</option>
                        <option value="markdown">
                          {t('documentType.markdown')}
                        </option>
                        <option value="plaintext">
                          {t('documentType.plaintext')}
                        </option>
                      </select>
                    )}
                  </Field>
                  <div className="content-editor-source-controls">
                    <p className="content-editor-source-hint">
                      {t(canChangeDocumentType
                        ? 'editor.sourceHint'
                        : 'editor.documentTypeLockedHint')}
                    </p>
                    {draft.editor_mode === 'source' ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => setContentMediaMode('insert')}
                      >
                        {tMedia('contentInsertion.action')}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <ContentBodyEditor
                  ref={contentEditorRef}
                  value={draft.content}
                  documentType={draft.document_type}
                  editorMode={draft.editor_mode}
                  editorProfile={draft.editor_profile}
                  maximumLength={PAGE_CONTENT_MAX_LENGTH}
                  disabled={saving || recoveryDecisionRequired}
                  canonicalClean={!hasChanges}
                  canonicalEditorState={canonicalDraft ? {
                    content: canonicalDraft.content,
                    editor_mode: canonicalDraft.editor_mode,
                    editor_profile: canonicalDraft.editor_profile,
                  } : null}
                  canonicalEditorContextClean={canonicalEditorContextClean}
                  onDirty={() => {
                    setContentBridgeDirty(true);
                    setSaved(false);
                    setFailure(null);
                  }}
                  onChange={(value) => {
                    setContentBridgeDirty(false);
                    if (draftRef.current.content === value) return;
                    updateDraft('content', value);
                  }}
                  onEditorStateChange={(state) => {
                    setContentBridgeDirty(false);
                    setDraft((currentDraft) => ({ ...currentDraft, ...state }));
                    setSaved(false);
                    setFailure(null);
                  }}
                  onRequestMedia={setContentMediaMode}
                />
                <AiExcerptField
                  label={t('editor.excerptLabel')}
                  hint={t('editor.excerptHint')}
                  value={draft.excerpt}
                  disabled={saving || recoveryDecisionRequired}
                  getSource={() => {
                    const current = draftRef.current;
                    return {
                      title: current.title,
                      content: contentEditorRef.current?.flush()
                        ?? current.content,
                      document_type: current.document_type,
                    };
                  }}
                  generate={(request, signal) => requestGeneratePageExcerpt(
                    input.data.csrf_token,
                    request,
                    signal,
                  )}
                  onChange={(value) => updateDraft('excerpt', value)}
                  onSessionEnded={input.onSessionEnded}
                />
                </div>
              </Panel>
            </div>

            <aside className="content-editor-sidebar">
              <Panel title={t('editor.publicationHeading')}>
                <div className="content-editor-fields">
                  <Field label={t('editor.statusLabel')}>
                    {(control) => (
                      <select
                        {...control}
                        value={draft.status}
                        onChange={(event) => updateDraft(
                          'status',
                          event.target.value as PageDraft['status'],
                        )}
                      >
                        <option value="draft">{t('status.draft')}</option>
                        <option value="published">{t('status.published')}</option>
                        {currentPage ? (
                          <option value="trash">{t('status.trash')}</option>
                        ) : null}
                      </select>
                    )}
                  </Field>
                  <Field label={t('editor.discoverabilityLabel')}>
                    {(control) => (
                      <select
                        {...control}
                        value={draft.discoverability}
                        onChange={(event) => updateDraft(
                          'discoverability',
                          event.target.value as PageDraft['discoverability'],
                        )}
                      >
                        <option value="default">
                          {t('discoverability.default')}
                        </option>
                        <option value="noindex">
                          {t('discoverability.noindex')}
                        </option>
                        <option value="delist">
                          {t('discoverability.delist')}
                        </option>
                      </select>
                    )}
                  </Field>
                  <div className="content-editor-comment-setting">
                    <div className="content-editor-checkbox">
                      <input
                        id={allowCommentsId}
                        aria-describedby={allowCommentsHintId}
                        type="checkbox"
                        checked={draft.allow_comments}
                        onChange={(event) => updateDraft(
                          'allow_comments',
                          event.target.checked,
                        )}
                      />
                      <span className="content-editor-checkbox-copy">
                        <label
                          className="content-editor-checkbox-label"
                          htmlFor={allowCommentsId}
                        >
                          {t('editor.allowCommentsLabel')}
                        </label>
                        <span
                          className="content-editor-checkbox-hint"
                          id={allowCommentsHintId}
                        >
                          {t('editor.allowCommentsHint')}
                        </span>
                      </span>
                    </div>
                    <CommentRuntimeStatus
                      roles={input.data.user?.roles ?? []}
                      onSessionEnded={input.onSessionEnded}
                      copy={{
                        loading: t('editor.commentRuntime.loading'),
                        active: t('editor.commentRuntime.active'),
                        disabled: t('editor.commentRuntime.disabled'),
                        integrationDisabled: t('editor.commentRuntime.integrationDisabled'),
                        unconfigured: t('editor.commentRuntime.unconfigured'),
                        unavailable: t('editor.commentRuntime.unavailable'),
                        settingsLink: t('editor.commentRuntime.settingsLink'),
                        edgeServicesLink: t('editor.commentRuntime.edgeServicesLink'),
                      }}
                    />
                  </div>
                  {currentPage?.status === 'trash' ? (
                    <div className="content-editor-danger-zone">
                      <Button
                        type="button"
                        variant="danger"
                        disabled={hasChanges}
                        title={hasChanges
                          ? t('editor.saveBeforeDelete')
                          : undefined}
                        onClick={() => {
                          setFailure(null);
                          setDeleteOpen(true);
                        }}
                      >
                        <StudioIcon
                          className="content-editor-button-icon"
                          icon={Trash2}
                        />
                        {t('editor.deletePermanently')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              </Panel>

              <Panel title={t('editor.hierarchyHeading')}>
                <div className="content-editor-fields">
                  <Field
                    label={t('editor.parentLabel')}
                    hint={t('editor.parentHint')}
                  >
                    {(control) => (
                      <select
                        {...control}
                        value={draft.parent_id ?? ''}
                        onChange={(event) => updateDraft(
                          'parent_id',
                          event.target.value || null,
                        )}
                      >
                        <option value="">{t('editor.noParent')}</option>
                        {parentOptions.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.title} (/{option.path})
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <div className="content-editor-option-search">
                    <input
                      type="search"
                      maxLength={200}
                      aria-label={t('editor.searchParents')}
                      placeholder={t('editor.searchParents')}
                      value={parentSearch}
                      onChange={(event) => setParentSearch(event.target.value)}
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={refreshParentOptions}
                    >
                      {parentSearching
                        ? t('editor.searching')
                        : t('editor.search')}
                    </Button>
                  </div>
                  {effectivePath ? (
                    <p className="content-editor-empty-reference">
                      {t('editor.pathPreview', { path: effectivePath })}
                    </p>
                  ) : null}
                </div>
              </Panel>

              <FeaturedImageField
                value={draft.featured_image_id}
                current={featuredImageReference}
                onChange={(id, reference) => {
                  setFeaturedImageReference(reference);
                  updateDraft('featured_image_id', id);
                }}
                onSessionEnded={input.onSessionEnded}
                aiGenerationCsrfToken={input.data.csrf_token}
                mediaManagementCsrfToken={input.data.csrf_token}
              />
            </aside>
          </fieldset>
        </form>
      </main>

      <UnsavedChangesGuard
        active={autosave.hasUnpersistedChanges && !saving}
        onLeave={autosave.flushNow}
        onDiscard={discardStoredAutosave}
        copy={{
          kicker: t('unsaved.kicker'),
          title: t('unsaved.title'),
          description: t('unsaved.description'),
          stay: t('unsaved.stay'),
          leave: t('unsaved.leave'),
          discard: t('unsaved.discard'),
          discarding: t('unsaved.discarding'),
          discardError: t('unsaved.discardError'),
          leaving: t('autosave.flushing'),
          leaveError: t('autosave.flushError'),
        }}
      />

      {contentMediaMode ? (
        <ContentMediaInsertDialog
          mode={contentMediaMode}
          onClose={() => setContentMediaMode(null)}
          onInsert={insertContentMedia}
          onSessionEnded={input.onSessionEnded}
          aiGenerationCsrfToken={input.data.csrf_token}
          mediaManagementCsrfToken={input.data.csrf_token}
        />
      ) : null}

      {aiDraftTarget ? (
        <AiPageDraftDialog
          open={aiDraftOpen}
          currentTitle={draft.title}
          currentExcerpt={draft.excerpt}
          target={aiDraftTarget}
          generate={(request, signal) => requestGeneratePageDraft(
            input.data.csrf_token,
            request,
            signal,
          )}
          onApply={applyAiPageDraft}
          onClose={() => setAiDraftOpen(false)}
          onSessionEnded={input.onSessionEnded}
        />
      ) : null}

      {revisionHistoryOpen && currentPage ? (
        <ContentRevisionHistoryDialog
          formatDate={(iso) => dateFormatter.format(new Date(iso))}
          onClose={() => setRevisionHistoryOpen(false)}
          onRestored={() => {
            setRevisionHistoryOpen(false);
            navigate(location.pathname, { replace: true, state: { saved: true } });
            setLoadAttempt((value) => value + 1);
          }}
          onSessionEnded={input.onSessionEnded}
          requestList={(signal) => requestPageRevisions(currentPage.id, signal)}
          requestDetail={(revisionId, signal) => (
            requestPageRevision(currentPage.id, revisionId, signal)
          )}
          requestRestore={(revisionId, request) => requestRestorePageRevision(
            input.data.csrf_token,
            currentPage.id,
            revisionId,
            request,
          )}
          copy={{
            title: t('revisions.title'),
            description: t('revisions.description'),
            close: t('revisions.close'),
            loading: t('revisions.loading'),
            loadError: t('revisions.loadError'),
            noHistory: t('revisions.noHistory'),
            olderRevision: t('revisions.olderRevision'),
            newerRevision: t('revisions.newerRevision'),
            current: t('revisions.current'),
            comparison: t('revisions.comparison'),
            metadataSame: t('revisions.metadataSame'),
            content: t('revisions.content'),
            contentSame: t('revisions.contentSame'),
            contentChanged: t('revisions.contentChanged'),
            diffLabel: t('revisions.diffLabel'),
            diffLoading: t('revisions.diffLoading'),
            diffUnavailable: t('revisions.diffUnavailable'),
            diffRetry: t('revisions.diffRetry'),
            restore: t('revisions.restore'),
            restoreConfirmTitle: t('revisions.restoreConfirmTitle'),
            restoreConfirmDescription: t('revisions.restoreConfirmDescription'),
            restoreCancel: t('revisions.restoreCancel'),
            restoreConfirm: t('revisions.restoreConfirm'),
            restoring: t('revisions.restoring'),
            restoreError: t('revisions.restoreError'),
            revisionConflict: t('revisions.revisionConflict'),
            revisionNotFound: t('revisions.revisionNotFound'),
            restoreUnavailable: t('revisions.restoreUnavailable'),
            leftSource: t('revisions.leftSource'),
            rightSource: t('revisions.rightSource'),
            none: t('revisions.none'),
            yes: t('revisions.yes'),
            no: t('revisions.no'),
            fields: {
              title: t('revisions.fields.title'),
              slug: t('revisions.fields.slug'),
              documentType: t('revisions.fields.documentType'),
              editorMode: t('revisions.fields.editorMode'),
              excerpt: t('revisions.fields.excerpt'),
              status: t('revisions.fields.status'),
              discoverability: t('revisions.fields.discoverability'),
              allowComments: t('revisions.fields.allowComments'),
              featuredImage: t('revisions.fields.featuredImage'),
              author: t('revisions.fields.author'),
              categories: t('revisions.fields.categories'),
              tags: t('revisions.fields.tags'),
              parent: t('revisions.fields.parent'),
            },
          }}
        />
      ) : null}

      {recoveryComparisonOpen
        && recoveryCandidate
        && normalizedRecoverySnapshot
        && autosaveSnapshot
        && currentPage ? (
          <ContentAutosaveComparisonDialog
            title={t('autosave.compareTitle')}
            description={t('autosave.compareDescription')}
            closeLabel={t('autosave.compareClose')}
            staleDescription={t('autosave.recoveryStale')}
            isStale={recoveryCandidate.base_revision !== currentPage.revision}
            savedLabel={t('autosave.savedVersion')}
            autosaveLabel={t('autosave.recoveryVersion')}
            comparisonKey={`${currentPage.revision}:${recoveryCandidate.snapshot_sha256}`}
            savedSnapshot={autosaveSnapshot}
            autosaveSnapshot={normalizedRecoverySnapshot}
            copy={{
              comparison: t('revisions.comparison'),
              metadataSame: t('revisions.metadataSame'),
              content: t('revisions.content'),
              contentSame: t('revisions.contentSame'),
              contentChanged: t('revisions.contentChanged'),
              diffLabel: t('autosave.compareDiffLabel'),
              diffLoading: t('revisions.diffLoading'),
              diffUnavailable: t('revisions.diffUnavailable'),
              diffRetry: t('revisions.diffRetry'),
              leftSource: t('autosave.savedSource'),
              rightSource: t('autosave.recoverySource'),
              none: t('revisions.none'),
              yes: t('revisions.yes'),
              no: t('revisions.no'),
              fields: {
                title: t('revisions.fields.title'),
                slug: t('revisions.fields.slug'),
                documentType: t('revisions.fields.documentType'),
                editorMode: t('revisions.fields.editorMode'),
                excerpt: t('revisions.fields.excerpt'),
                status: t('revisions.fields.status'),
                discoverability: t('revisions.fields.discoverability'),
                allowComments: t('revisions.fields.allowComments'),
                featuredImage: t('revisions.fields.featuredImage'),
                author: t('revisions.fields.author'),
                categories: t('revisions.fields.categories'),
                tags: t('revisions.fields.tags'),
                parent: t('revisions.fields.parent'),
              },
            }}
            onClose={() => setRecoveryComparisonOpen(false)}
          />
        ) : null}

      {recoveryCandidate && currentPage === null ? (
        <ContentRecoveryDialog
          title={t('autosave.recoveryTitle')}
          description={t('autosave.recoveryDescription')}
          staleDescription={t('autosave.recoveryStale')}
          isStale={false}
          updatedLabel={t('autosave.recoveryUpdated', {
            time: dateFormatter.format(new Date(recoveryCandidate.updated_at_iso)),
          })}
          discardLabel={t('autosave.discard')}
          restoreLabel={t('autosave.restore')}
          discardingLabel={t('autosave.discarding')}
          busy={recoveryDiscarding}
          error={recoveryError}
          onDiscard={() => void discardAutosave()}
          onRestore={restoreAutosave}
        />
      ) : null}

      <Dialog
        open={deleteOpen && currentPage !== null}
        onClose={() => {
          setDeleteOpen(false);
          setFailure(null);
        }}
        busy={deleting}
        kicker={t('delete.kicker')}
        title={t('delete.title', { title: currentPage?.title ?? '' })}
        description={t('delete.description')}
        initialFocusRef={deleteCancelRef}
        actions={(
          <>
            <Button
              ref={deleteCancelRef}
              type="button"
              disabled={deleting}
              onClick={() => {
                setDeleteOpen(false);
                setFailure(null);
              }}
            >
              {t('delete.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={deleting}
              onClick={() => void permanentlyDelete()}
            >
              {deleting ? t('delete.running') : t('delete.confirm')}
            </Button>
          </>
        )}
      >
        {failure ? (
          <div className="content-editor-dialog-notice">
            <Notice tone="error">{failureMessage(failure)}</Notice>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

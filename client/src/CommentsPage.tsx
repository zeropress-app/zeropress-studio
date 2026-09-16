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
  Check,
  Clock3,
  CornerDownRight,
  FileText,
  Files,
  Info,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Reply,
  Save,
  Search,
  Send,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import type { ApiErrorCode } from '../../contracts/api';
import {
  COMMENT_BULK_MODERATION_MAX_ITEMS,
  COMMENT_CONTENT_MAX_LENGTH,
  COMMENTS_DEFAULT_PAGE_SIZE,
  normalizeCommentContent,
  type CommentBulkModerationData,
  type CommentStatus,
  type CommentTarget,
  type ManagedComment,
} from '../../contracts/comments';
import type { CurrentSessionSuccess } from '../../contracts/session';
import {
  ActionMenu,
  Button,
  Dialog,
  DialogActions,
  EmptyState,
  Field,
  FilterTabs,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  RouteLoading,
  StudioIcon,
  StatusPill,
  useStudioToast,
  type ActionMenuItem,
  type StatusTone,
} from './components/primitives';
import { IdentityAvatar } from './components/IdentityAvatar';
import {
  CommentsClientError,
  requestBulkCommentModeration,
  requestCommentTargets,
  requestComments,
  requestCreateStudioComment,
  requestDeleteComment,
  requestUpdateComment,
  type CommentsClientErrorCode,
} from './lib/comments-client';
import {
  studioPagePath,
  studioPostPath,
} from './routing/studio-routes';

type AccountSession = CurrentSessionSuccess['data'];
type StatusFilter = 'all' | CommentStatus;

/** Map moderation states to the primitives' semantic tones. */
const STATUS_TONE: Record<CommentStatus, StatusTone> = {
  approved: 'positive',
  pending: 'attention',
  spam: 'critical',
  trash: 'critical',
};
type TargetTypeFilter = 'all' | 'post' | 'page';
type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      items: ManagedComment[];
      pagination: {
        page: number;
        per_page: number;
        total: number;
        total_pages: number;
      };
      statusCounts: Record<StatusFilter, number>;
    }
  | { kind: 'error' };
type TargetOptionsState =
  | { kind: 'idle' | 'loading' }
  | { kind: 'ready'; items: CommentTarget[] }
  | { kind: 'error' };
type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: CommentsClientErrorCode }
  | { kind: 'unexpected' };
type Completion =
  | {
      kind:
        | 'approved'
        | 'pending'
        | 'spam'
        | 'trashed'
        | 'edited'
        | 'created'
        | 'replied';
    }
  | { kind: 'deleted'; count: number };
type BulkOperation =
  | { operation: 'set_status'; status: CommentStatus }
  | { operation: 'delete_permanently' };
type BulkCompletion = {
  data: CommentBulkModerationData;
  labels: Record<string, string>;
};
type DialogState =
  | { kind: 'details'; comment: ManagedComment }
  | { kind: 'edit'; comment: ManagedComment; content: string }
  | {
    kind: 'compose';
    target: CommentTarget;
    parent: ManagedComment | null;
    content: string;
  }
  | { kind: 'delete'; comment: ManagedComment }
  | null;

function commentTargetPath(comment: ManagedComment): string | null {
  if (!comment.target) return null;
  return comment.target.type === 'post'
    ? studioPostPath(comment.target.id)
    : studioPagePath(comment.target.id);
}

function clientFailure(error: unknown): Failure {
  return error instanceof CommentsClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

export function CommentsPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('comments');
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [targetType, setTargetType] = useState<TargetTypeFilter>('all');
  const [targetFiltersOpen, setTargetFiltersOpen] = useState(false);
  const [targetSearchInput, setTargetSearchInput] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [targetOptionsAttempt, setTargetOptionsAttempt] = useState(0);
  const [targetOptionsState, setTargetOptionsState] =
    useState<TargetOptionsState>({ kind: 'idle' });
  const [selectedTarget, setSelectedTarget] = useState<CommentTarget | null>(
    null,
  );
  const [page, setPage] = useState(1);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set<string>());
  const [bulkOperation, setBulkOperation] = useState<BulkOperation | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkFailure, setBulkFailure] = useState<Failure | null>(null);
  const [bulkCompletion, setBulkCompletion] = useState<BulkCompletion | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const dialogCancelRef = useRef<HTMLButtonElement>(null);
  const bulkCancelRef = useRef<HTMLButtonElement>(null);
  const selectPageRef = useRef<HTMLInputElement>(null);
  const activeCommentIdRef = useRef(activeCommentId);
  activeCommentIdRef.current = activeCommentId;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    { dateStyle: 'medium', timeStyle: 'short' },
  ), [i18n.resolvedLanguage]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(
    i18n.resolvedLanguage,
  ), [i18n.resolvedLanguage]);
  const selectedTargetPublicId = selectedTarget?.public_id;

  useStudioDocumentTitle(t('documentTitle'));
  useStudioToast({
    id: 'comment-moderation',
    tone: 'success',
    message: completion && completion.kind !== 'deleted'
      ? t(`completion.${completion.kind}`)
      : null,
  });

  useEffect(() => {
    if (!selectPageRef.current || loadState.kind !== 'ready') return;
    const selectedOnPage = loadState.items.filter((comment) => selectedIds.has(comment.id));
    selectPageRef.current.indeterminate = selectedOnPage.length > 0
      && selectedOnPage.length < loadState.items.length;
  }, [loadState, selectedIds]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    void requestComments({
      search,
      status,
      target_type: targetType,
      ...(selectedTargetPublicId === undefined
        ? {}
        : { target_public_id: selectedTargetPublicId }),
      page,
      per_page: COMMENTS_DEFAULT_PAGE_SIZE,
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
      setLoadState({
        kind: 'ready',
        items: response.data.items,
        pagination: response.data.pagination,
        statusCounts: response.data.status_counts,
      });
    }).catch(() => {
      if (active && !controller.signal.aborted) setLoadState({ kind: 'error' });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    input.onSessionEnded,
    loadAttempt,
    page,
    search,
    selectedTargetPublicId,
    status,
    targetType,
  ]);

  useEffect(() => {
    if (targetType === 'all') {
      setTargetOptionsState({ kind: 'idle' });
      return undefined;
    }
    const controller = new AbortController();
    let active = true;
    setTargetOptionsState({ kind: 'loading' });
    void requestCommentTargets({
      target_type: targetType,
      search: targetSearch,
    }, controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setTargetOptionsState({ kind: 'error' });
        return;
      }
      setTargetOptionsState({ kind: 'ready', items: response.data.items });
    }).catch(() => {
      if (active && !controller.signal.aborted) {
        setTargetOptionsState({ kind: 'error' });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    input.onSessionEnded,
    targetOptionsAttempt,
    targetSearch,
    targetType,
  ]);

  // The Dialog primitive owns focus trapping, Escape handling, and scroll locking.


  function failureMessage(current: Failure): string {
    if (current.kind === 'client') {
      if (current.code === 'TIMEOUT') return t('errors.timeout');
      if (current.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (current.kind === 'unexpected') return t('errors.api');
    if (current.code === 'COMMENT_NOT_FOUND') return t('errors.notFound');
    if (current.code === 'COMMENT_REVISION_CONFLICT') {
      return t('errors.revisionConflict');
    }
    if (current.code === 'COMMENT_TARGET_NOT_AVAILABLE') {
      return t('errors.targetNotAvailable');
    }
    if (current.code === 'COMMENT_REPLY_NOT_AVAILABLE') {
      return t('errors.replyNotAvailable');
    }
    if (current.code === 'COMMENT_CREATION_CONFLICT') {
      return t('errors.creationConflict');
    }
    if (current.code === 'FORBIDDEN') return t('errors.forbidden');
    if (current.code === 'VALIDATION_ERROR') return t('errors.validation');
    return t('errors.api');
  }

  function reloadAfterMutation() {
    if (
      loadState.kind === 'ready'
      && loadState.items.length === 1
      && page > 1
    ) {
      setPage((value) => Math.max(1, value - 1));
    } else {
      setLoadAttempt((value) => value + 1);
    }
  }

  function clearBulkSelection() {
    setSelectedIds(new Set());
  }

  function resetBulkContext() {
    clearBulkSelection();
    setBulkOperation(null);
    setBulkFailure(null);
    setBulkCompletion(null);
  }

  async function confirmBulkModeration() {
    if (
      bulkOperation === null
      || bulkRunning
      || activeCommentId !== null
      || loadState.kind !== 'ready'
    ) return;
    const selected = loadState.items.filter((comment) => (
      selectedIds.has(comment.id)
    ));
    if (selected.length === 0) return;
    setBulkRunning(true);
    setBulkFailure(null);
    setBulkCompletion(null);
    setCompletion(null);
    try {
      const response = await requestBulkCommentModeration(
        input.data.csrf_token,
        bulkOperation.operation === 'set_status'
          ? {
              operation: 'set_status',
              status: bulkOperation.status,
              items: selected.map((comment) => ({
                id: comment.id,
                expected_updated_at_iso: comment.updated_at_iso,
              })),
            }
          : {
              operation: 'delete_permanently',
              items: selected.map((comment) => ({
                id: comment.id,
                expected_updated_at_iso: comment.updated_at_iso,
              })),
            },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setBulkFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setBulkCompletion({
        data: response.data,
        labels: Object.fromEntries(selected.map((comment) => [
          comment.id,
          `#${comment.public_id} · ${comment.author.name}`,
        ])),
      });
      const completedIds = new Set(response.data.results
        .filter((result) => (
          result.outcome === 'updated'
          || result.outcome === 'unchanged'
          || (result.outcome === 'skipped' && result.reason === 'not_found')
        ))
        .map((result) => result.id));
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const id of completedIds) next.delete(id);
        return next;
      });
      const updatedIds = new Set(response.data.results
        .filter((result) => result.outcome === 'updated')
        .map((result) => result.id));
      const leavesCurrentFilter = response.data.operation === 'delete_permanently'
        || (
          status !== 'all'
          && response.data.operation === 'set_status'
          && response.data.status !== status
        );
      setBulkOperation(null);
      if (
        leavesCurrentFilter
        && page > 1
        && loadState.items.every((comment) => updatedIds.has(comment.id))
      ) {
        setPage((value) => Math.max(1, value - 1));
      } else {
        setLoadAttempt((value) => value + 1);
      }
    } catch (error) {
      setBulkFailure(clientFailure(error));
    } finally {
      setBulkRunning(false);
    }
  }

  async function applyStatus(comment: ManagedComment, next: CommentStatus) {
    if (activeCommentId) return;
    setActiveCommentId(comment.id);
    setFailure(null);
    setCompletion(null);
    try {
      const response = next === 'trash'
        ? await requestDeleteComment(input.data.csrf_token, comment.id, {
            expected_updated_at_iso: comment.updated_at_iso,
          })
        : await requestUpdateComment(input.data.csrf_token, comment.id, {
            status: next,
            expected_updated_at_iso: comment.updated_at_iso,
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
        kind: next === 'approved'
          ? 'approved'
          : next === 'pending'
            ? 'pending'
            : next === 'spam'
              ? 'spam'
              : 'trashed',
      });
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(comment.id);
        return next;
      });
      reloadAfterMutation();
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setActiveCommentId(null);
    }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog || dialog.kind !== 'edit' || activeCommentId) return;
    const content = normalizeCommentContent(dialog.content);
    if (!content || content.length > COMMENT_CONTENT_MAX_LENGTH) {
      setFailure({ kind: 'api', code: 'VALIDATION_ERROR' });
      return;
    }
    setActiveCommentId(dialog.comment.id);
    setFailure(null);
    setCompletion(null);
    try {
      const response = await requestUpdateComment(
        input.data.csrf_token,
        dialog.comment.id,
        {
          content_text: content,
          expected_updated_at_iso: dialog.comment.updated_at_iso,
        },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setDialog(null);
      setCompletion({ kind: 'edited' });
      reloadAfterMutation();
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setActiveCommentId(null);
    }
  }

  async function createAuthoredComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog || dialog.kind !== 'compose' || activeCommentId) return;
    const content = normalizeCommentContent(dialog.content);
    if (!content || content.length > COMMENT_CONTENT_MAX_LENGTH) {
      setFailure({ kind: 'api', code: 'VALIDATION_ERROR' });
      return;
    }
    const mutationKey = dialog.parent?.id
      ?? `${dialog.target.type}:${dialog.target.public_id}`;
    setActiveCommentId(mutationKey);
    setFailure(null);
    setCompletion(null);
    try {
      const response = await requestCreateStudioComment(
        input.data.csrf_token,
        {
          target_type: dialog.target.type,
          target_public_id: dialog.target.public_id,
          parent_public_id: dialog.parent?.public_id ?? null,
          content_text: content,
        },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      const wasReply = dialog.parent !== null;
      setDialog(null);
      setCompletion({ kind: wasReply ? 'replied' : 'created' });
      reloadAfterMutation();
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setActiveCommentId(null);
    }
  }

  async function permanentlyDelete() {
    if (!dialog || dialog.kind !== 'delete' || activeCommentId) return;
    setActiveCommentId(dialog.comment.id);
    setFailure(null);
    setCompletion(null);
    try {
      const response = await requestDeleteComment(
        input.data.csrf_token,
        dialog.comment.id,
        { expected_updated_at_iso: dialog.comment.updated_at_iso },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      if (response.data.status !== 'permanently_deleted') {
        setFailure({ kind: 'unexpected' });
        return;
      }
      setDialog(null);
      setCompletion({ kind: 'deleted', count: response.data.deleted_count });
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(dialog.comment.id);
        return next;
      });
      reloadAfterMutation();
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setActiveCommentId(null);
    }
  }

  if (loadState.kind === 'loading') {
    return (
      <RouteLoading>{t('loading')}</RouteLoading>
    );
  }
  if (loadState.kind === 'error') {
    return (
      <main
        id="studio-main-content"
        aria-labelledby="comments-title"
      >
        <PageHeader
          titleId="comments-title"
          kicker={t('kicker')}
          title={t('title')}
        />
        <Notice
          tone="error"
          actions={(
            <Button
              type="button"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              {t('actions.retry')}
            </Button>
          )}
        >
          {t('errors.load')}
        </Notice>
      </main>
    );
  }

  // All comment dialogs share the same focus and scroll ownership.
  const dialogCopy = dialog === null
    ? { kicker: '', title: '', description: undefined as string | undefined }
    : dialog.kind === 'details'
      ? {
        kicker: t('dialog.details.kicker'),
        title: t('dialog.details.title'),
        description: t('dialog.details.description', { author: dialog.comment.author.name }),
      }
      : dialog.kind === 'edit'
        ? {
          kicker: t('dialog.edit.kicker'),
          title: t('dialog.edit.title'),
          description: t('dialog.edit.description'),
        }
        : dialog.kind === 'compose'
          ? {
            kicker: dialog.parent
              ? t('dialog.compose.replyKicker')
              : t('dialog.compose.commentKicker'),
            title: dialog.parent
              ? t('dialog.compose.replyTitle')
              : t('dialog.compose.commentTitle'),
            description: dialog.parent
              ? t('dialog.compose.replyDescription')
              : t('dialog.compose.commentDescription'),
          }
          : {
            kicker: t('dialog.delete.kicker'),
            title: t('dialog.delete.title'),
            description: t('dialog.delete.description'),
          };
  const statuses: StatusFilter[] = [
    'all', 'pending', 'approved', 'spam', 'trash',
  ];
  const targetOptions = targetOptionsState.kind === 'ready'
    ? targetOptionsState.items
    : [];
  const visibleTargetOptions = selectedTarget && !targetOptions.some(
    (target) => target.public_id === selectedTarget.public_id,
  )
    ? [selectedTarget, ...targetOptions]
    : targetOptions;
  const selectedComments = loadState.items.filter((comment) => (
    selectedIds.has(comment.id)
  ));
  const canPermanentlyDeleteSelection = selectedComments.length > 0
    && selectedComments.length === selectedIds.size
    && selectedComments.every((comment) => comment.status === 'trash');
  const mutationBusy = bulkRunning || activeCommentId !== null;

  function commentMenuItems(comment: ManagedComment): ActionMenuItem[] {
    const items: ActionMenuItem[] = [
      {
        id: 'details', kind: 'button', label: t('actions.details'), icon: Info,
        onSelect: () => {
          setDialog({ kind: 'details', comment });
          setFailure(null);
        },
      },
      {
        id: 'edit', kind: 'button', label: t('actions.edit'), icon: Pencil,
        onSelect: () => {
          setDialog({ kind: 'edit', comment, content: comment.content_text });
          setFailure(null);
        },
      },
    ];
    // Pending exposes Approve directly. Other transitions remain in the menu.
    if (comment.status !== 'approved' && comment.status !== 'pending') {
      items.push({
        id: 'approve', kind: 'button', label: t('actions.approve'), icon: Check,
        onSelect: () => void applyStatus(comment, 'approved'),
      });
    }
    if (comment.status !== 'pending') {
      items.push({
        id: 'pending', kind: 'button', label: t('actions.pending'), icon: Clock3,
        onSelect: () => void applyStatus(comment, 'pending'),
      });
    }
    if (comment.status !== 'spam') {
      items.push({
        id: 'spam', kind: 'button', label: t('actions.spam'), icon: ShieldAlert,
        onSelect: () => void applyStatus(comment, 'spam'),
      });
    }
    items.push(comment.status === 'trash' ? {
      id: 'delete', kind: 'button', label: t('actions.deletePermanently'),
      icon: Trash2, tone: 'critical',
      onSelect: () => {
        setDialog({ kind: 'delete', comment });
        setFailure(null);
      },
    } : {
      id: 'trash', kind: 'button', label: t('actions.trash'), icon: Trash2, tone: 'critical',
      onSelect: () => void applyStatus(comment, 'trash'),
    });
    return items;
  }
  return (
    <>
      <main
        id="studio-main-content"
        aria-labelledby="comments-title"
      >
        <PageHeader
          titleId="comments-title"
          kicker={t('kicker')}
          title={t('title')}
          description={t('description')}
        />

        <div className="comments-toolbar">
          <div className="comments-controls">
            <form
              className="comments-search"
              role="search"
              aria-label={t('filters.searchLabel')}
              onSubmit={(event) => {
                event.preventDefault();
                setSearch(searchInput.trim());
                setPage(1);
                resetBulkContext();
              }}
            >
              <div className="comments-search-field">
                <Field
                  label={t('filters.searchLabel')}
                  labelHidden
                  leading={<StudioIcon icon={Search} />}
                >
                  {(control) => (
                    <input
                      {...control}
                      type="search"
                      value={searchInput}
                      maxLength={200}
                      placeholder={t('filters.searchPlaceholder')}
                      onChange={(event) => setSearchInput(event.target.value)}
                    />
                  )}
                </Field>
              </div>
              <Button type="submit">{t('actions.search')}</Button>
              {search ? (
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={t('actions.clearSearch')}
                  onClick={() => {
                    setSearchInput('');
                    setSearch('');
                    setPage(1);
                    resetBulkContext();
                  }}
                >
                  <StudioIcon icon={X} className="comments-action-icon" />
                </Button>
              ) : null}
            </form>
            <div className="comments-type-filter">
              <Field label={t('filters.targetType')} labelHidden>
                {(control) => (
                  <select
                    {...control}
                    value={targetType}
                    onChange={(event) => {
                      setTargetType(event.target.value as TargetTypeFilter);
                      setTargetFiltersOpen(false);
                      setTargetSearchInput('');
                      setTargetSearch('');
                      setSelectedTarget(null);
                      setPage(1);
                      setFailure(null);
                      setCompletion(null);
                      resetBulkContext();
                    }}
                  >
                    <option value="all">{t('target.all')}</option>
                    <option value="post">{t('target.post')}</option>
                    <option value="page">{t('target.page')}</option>
                  </select>
                )}
              </Field>
            </div>
            {targetType !== 'all' ? (
              <div className="comments-target-toggle">
                <Button
                  type="button"
                  block
                  aria-expanded={targetFiltersOpen}
                  aria-controls="comments-target-filters"
                  onClick={() => setTargetFiltersOpen((open) => !open)}
                >
                  <StudioIcon icon={SlidersHorizontal} className="comments-action-icon" />
                  <span className="comments-target-name">
                    {selectedTarget?.title ?? t('filters.chooseTarget')}
                  </span>
                </Button>
              </div>
            ) : null}
            {selectedTarget ? (
              <div className="comments-create-action">
                <Button
                  type="button"
                  variant="primary"
                  disabled={mutationBusy}
                  onClick={() => {
                    setDialog({
                      kind: 'compose', target: selectedTarget, parent: null, content: '',
                    });
                    setFailure(null);
                  }}
                >
                  <StudioIcon icon={MessageSquarePlus} className="comments-action-icon" />
                  {t('actions.addComment')}
                </Button>
              </div>
            ) : null}
          </div>
          {targetType !== 'all' ? (
            <div id="comments-target-filters" hidden={!targetFiltersOpen}>
              <form
                className="comments-target-filters"
                role="search"
                aria-label={t('filters.targetSearchLabel')}
                onSubmit={(event) => {
                  event.preventDefault();
                  setTargetSearch(targetSearchInput.trim());
                }}
              >
                <div className="comments-target-search">
                  <Field label={t('filters.targetSearchLabel')}>
                    {(control) => (
                      <input
                        {...control}
                        type="search"
                        value={targetSearchInput}
                        maxLength={200}
                        placeholder={t('filters.targetSearchPlaceholder')}
                        onChange={(event) => (
                          setTargetSearchInput(event.target.value)
                        )}
                      />
                    )}
                  </Field>
                </div>
                <Button type="submit">
                  <StudioIcon icon={Search} className="comments-action-icon" />
                  {t('actions.findTargets')}
                </Button>
                <div className="comments-target-select">
                  <Field label={t('filters.specificTarget')}>
                    {(control) => (
                      <select
                        {...control}
                        value={selectedTarget?.public_id ?? ''}
                        disabled={targetOptionsState.kind === 'loading'}
                        onChange={(event) => {
                          const publicId = Number(event.target.value);
                          setSelectedTarget(
                            visibleTargetOptions.find(
                              (target) => target.public_id === publicId,
                            ) ?? null,
                          );
                          setPage(1);
                          setFailure(null);
                          setCompletion(null);
                          resetBulkContext();
                        }}
                      >
                        <option value="">{t('filters.allTypedTargets')}</option>
                        {visibleTargetOptions.map((target) => (
                          <option value={target.public_id} key={target.public_id}>
                            {target.title} (#{target.public_id})
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                </div>
                {targetOptionsState.kind === 'error' ? (
                  <Button
                    type="button"
                    onClick={() => setTargetOptionsAttempt((value) => value + 1)}
                  >
                    <StudioIcon icon={RefreshCw} className="comments-action-icon" />
                    {t('actions.retryTargets')}
                  </Button>
                ) : null}
              </form>
            </div>
          ) : null}
          <FilterTabs
            appearance="underline"
            label={t('filters.statusLabel')}
            value={status}
            items={statuses.map((value) => ({
              value,
              label: t(`status.${value}`),
              count: loadState.statusCounts[value],
            }))}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
              setCompletion(null);
              setFailure(null);
              resetBulkContext();
            }}
          />
        </div>

        {completion?.kind === 'deleted' ? (
          <Notice tone="success">
            {t('completion.deleted', { count: completion.count })}
          </Notice>
        ) : null}
        {failure && !dialog ? (
          <Notice tone="error">{failureMessage(failure)}</Notice>
        ) : null}

        {bulkCompletion ? (
          <Notice
            tone={bulkCompletion.data.summary.conflict > 0
              || bulkCompletion.data.summary.skipped > 0
              ? 'warning'
              : 'success'}
            title={t('bulk.resultTitle')}
          >
            <p>{t('bulk.resultSummary', bulkCompletion.data.summary)}</p>
            {bulkCompletion.data.summary.deleted_comments > 0 ? (
              <p>{t('bulk.deletedComments', {
                count: bulkCompletion.data.summary.deleted_comments,
              })}</p>
            ) : null}
            <ul className="comments-bulk-results">
              {bulkCompletion.data.results.map((result) => (
                <li key={result.id}>
                  <strong>{bulkCompletion.labels[result.id] ?? result.id}</strong>
                  {': '}
                  {t(result.outcome === 'skipped'
                    ? `bulk.outcome.skipped.${result.reason}`
                    : result.outcome === 'updated'
                      && 'deleted_count' in result
                      ? 'bulk.outcome.deleted'
                      : `bulk.outcome.${result.outcome}`)}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}

        {selectedIds.size > 0 ? (
          <div
            className="comments-bulk-toolbar"
            role="region"
            aria-label={t('bulk.label')}
          >
            <div className="comments-bulk-selection">
              <strong>{t('bulk.selected', { count: selectedIds.size })}</strong>
              <div className="comments-bulk-actions">
                <Button
                  type="button"
                  size="sm"
                  disabled={bulkRunning || activeCommentId !== null}
                  onClick={() => setBulkOperation({
                    operation: 'set_status',
                    status: 'approved',
                  })}
                >
                  <StudioIcon icon={Check} className="comments-action-icon" />
                  {t('actions.approve')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={bulkRunning || activeCommentId !== null}
                  onClick={() => setBulkOperation({
                    operation: 'set_status',
                    status: 'pending',
                  })}
                >
                  <StudioIcon icon={Clock3} className="comments-action-icon" />
                  {t('actions.pending')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={bulkRunning || activeCommentId !== null}
                  onClick={() => setBulkOperation({
                    operation: 'set_status',
                    status: 'spam',
                  })}
                >
                  <StudioIcon icon={ShieldAlert} className="comments-action-icon" />
                  {t('actions.spam')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={bulkRunning || activeCommentId !== null}
                  onClick={() => setBulkOperation({
                    operation: 'set_status',
                    status: 'trash',
                  })}
                >
                  <StudioIcon icon={Trash2} className="comments-action-icon" />
                  {t('actions.trash')}
                </Button>
                {canPermanentlyDeleteSelection ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    disabled={bulkRunning || activeCommentId !== null}
                    onClick={() => setBulkOperation({
                      operation: 'delete_permanently',
                    })}
                  >
                    <StudioIcon icon={Trash2} className="comments-action-icon" />
                    {t('actions.deletePermanently')}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={bulkRunning}
                  onClick={clearBulkSelection}
                >
                  <StudioIcon icon={X} className="comments-action-icon" />
                  {t('bulk.clear')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <section className="comments-results" aria-label={t('resultsLabel')}>
          <Panel flush>
            <div className="comments-list-header">
              {loadState.items.length > 0 ? (
                <label className="comments-bulk-select-all">
                  <input
                    ref={selectPageRef}
                    type="checkbox"
                    checked={loadState.items.every((comment) => selectedIds.has(comment.id))}
                    disabled={mutationBusy}
                    onChange={(event) => setSelectedIds(event.target.checked
                      ? new Set(loadState.items
                        .slice(0, COMMENT_BULK_MODERATION_MAX_ITEMS)
                        .map((comment) => comment.id))
                      : new Set())}
                  />
                  <span>{t('bulk.selectPage')}</span>
                </label>
              ) : null}
              <span className="comments-result-count">
                {t('resultsCount', {
                  count: loadState.pagination.total,
                  total: numberFormatter.format(loadState.pagination.total),
                })}
              </span>
            </div>
            {loadState.items.length === 0 ? (
              <EmptyState
                headingLevel={2}
                title={t('empty.title')}
                description={t('empty.description')}
              />
            ) : (
              <ul className="comments-list" role="list">
                {loadState.items.map((comment) => {
                  const targetPath = commentTargetPath(comment);
                  const busy = activeCommentId === comment.id;
                  return (
                    <li key={comment.id}>
                      <article className="comment-row">
                        <div className="comment-leading">
                          <input
                            className="comment-selection"
                            type="checkbox"
                            aria-label={t('bulk.selectNamed', {
                              publicId: comment.public_id,
                              author: comment.author.name,
                            })}
                            checked={selectedIds.has(comment.id)}
                            disabled={mutationBusy || (
                              selectedIds.size >= COMMENT_BULK_MODERATION_MAX_ITEMS
                              && !selectedIds.has(comment.id)
                            )}
                            onChange={(event) => setSelectedIds((current) => {
                              const next = new Set(current);
                              if (event.target.checked && next.size < COMMENT_BULK_MODERATION_MAX_ITEMS) {
                                next.add(comment.id);
                              }
                              else next.delete(comment.id);
                              return next;
                            })}
                          />
                          <IdentityAvatar name={comment.author.name} className="comment-avatar" />
                        </div>
                        <div className="comment-body">
                          <header className="comment-header">
                            <div className="comment-identity-line">
                              <strong className="comment-author-name">
                                {comment.author.name}
                              </strong>
                              {comment.author.kind !== 'guest' ? (
                                <StatusPill tone="neutral">
                                  {t(`authorKind.${comment.author.kind}`)}
                                </StatusPill>
                              ) : null}
                              <StatusPill
                                tone={STATUS_TONE[comment.status]}
                                srPrefix={t('filters.statusLabel')}
                              >
                                {t(`status.${comment.status}`)}
                              </StatusPill>
                              <time className="comment-date" dateTime={comment.created_at_iso}>
                                {dateFormatter.format(new Date(comment.created_at_iso))}
                              </time>
                            </div>
                            {comment.author.email ? (
                              <a
                                className="comment-author-email"
                                href={`mailto:${comment.author.email}`}
                              >
                                {comment.author.email}
                              </a>
                            ) : (
                              <span className="comment-author-email">
                                {t('metadata.emailNotProvided')}
                              </span>
                            )}
                          </header>
                          {comment.parent_public_id !== null ? (
                            <p className="comment-parent">
                              <StudioIcon icon={CornerDownRight} className="comments-action-icon" />
                              {t('metadata.inReplyTo', { publicId: comment.parent_public_id })}
                            </p>
                          ) : null}
                          <p className="comment-content">{comment.content_text}</p>
                          <footer className="comment-footer">
                            <p className="comment-target">
                              <StudioIcon
                                icon={comment.target_type === 'post' ? FileText : Files}
                                className="comments-action-icon"
                              />
                              <span>{t(`target.${comment.target_type}`)}:</span>
                              {targetPath && comment.target ? (
                                <Link to={targetPath}>{comment.target.title}</Link>
                              ) : (
                                <span>{t('metadata.missingTarget')}</span>
                              )}
                            </p>
                            <div className="comment-actions">
                              {comment.status === 'pending' ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={mutationBusy}
                                  onClick={() => void applyStatus(comment, 'approved')}
                                >
                                  <StudioIcon icon={Check} className="comments-action-icon" />
                                  {t('actions.approve')}
                                </Button>
                              ) : null}
                              {comment.status === 'approved' ? (
                                <Button
                                  type="button"
                                  size="sm"
                                  title={comment.reply.available
                                    ? undefined
                                    : t(`replyUnavailable.${comment.reply.reason}`)}
                                  aria-describedby={comment.reply.available
                                    ? undefined
                                    : `comment-reply-unavailable-${comment.id}`}
                                  onClick={() => {
                                    if (!comment.reply.available || !comment.target) return;
                                    setDialog({
                                      kind: 'compose',
                                      target: comment.target,
                                      parent: comment,
                                      content: '',
                                    });
                                    setFailure(null);
                                  }}
                                  disabled={mutationBusy || !comment.reply.available}
                                >
                                  <StudioIcon icon={Reply} className="comments-action-icon" />
                                  {t('actions.reply')}
                                </Button>
                              ) : null}
                              <ActionMenu
                                label={t('actions.menu', {
                                  author: comment.author.name, publicId: comment.public_id,
                                })}
                                disabled={mutationBusy}
                                items={commentMenuItems(comment)}
                              />
                              {busy ? (
                                <span className="comment-busy" role="status">
                                  {t('actions.updating')}
                                </span>
                              ) : null}
                            </div>
                          </footer>
                          {comment.status === 'approved' && !comment.reply.available ? (
                            <p
                              className="comment-reply-unavailable"
                              id={`comment-reply-unavailable-${comment.id}`}
                            >
                              {t(`replyUnavailable.${comment.reply.reason}`)}
                            </p>
                          ) : null}
                        </div>
                      </article>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </section>

        <Pagination
          label={t('pagination.label')}
          position={t('pagination.summary', {
            page: loadState.pagination.page,
            pages: Math.max(loadState.pagination.total_pages, 1),
            total: loadState.pagination.total,
          })}
          previousLabel={t('pagination.previous')}
          nextLabel={t('pagination.next')}
          page={loadState.pagination.page}
          totalPages={Math.max(loadState.pagination.total_pages, 1)}
          onChange={(value) => {
            setPage(value);
            resetBulkContext();
          }}
        />
      </main>

      <Dialog
        open={dialog !== null}
        onClose={() => {
          setDialog(null);
          setFailure(null);
        }}
        busy={activeCommentId !== null}
        kicker={dialogCopy.kicker}
        title={dialogCopy.title}
        description={dialogCopy.description}
        initialFocusRef={dialogCancelRef}
      >
        {dialog?.kind === 'details' ? (
          <div className="comment-dialog-form">
            <dl className="comment-metadata">
              <div>
                <dt>{t('metadata.author')}</dt>
                <dd>{dialog.comment.author.name}</dd>
              </div>
              <div>
                <dt>{t('metadata.email')}</dt>
                <dd>{dialog.comment.author.email || t('metadata.emailNotProvided')}</dd>
              </div>
              <div>
                <dt>{t('metadata.authorKind')}</dt>
                <dd>{t(`authorKind.${dialog.comment.author.kind}`)}</dd>
              </div>
              <div>
                <dt>{t('filters.statusLabel')}</dt>
                <dd><StatusPill tone={STATUS_TONE[dialog.comment.status]}>
                  {t(`status.${dialog.comment.status}`)}
                </StatusPill></dd>
              </div>
              <div>
                <dt>{t('metadata.commentId')}</dt>
                <dd>#{dialog.comment.public_id}</dd>
              </div>
              <div>
                <dt>{t('metadata.parentComment')}</dt>
                <dd>{dialog.comment.parent_public_id === null
                  ? t('metadata.topLevel')
                  : `#${dialog.comment.parent_public_id}`}</dd>
              </div>
              <div className="comment-metadata-wide">
                <dt>{t(`target.${dialog.comment.target_type}`)}</dt>
                <dd>
                  {dialog.comment.target ? (
                    <Link to={commentTargetPath(dialog.comment)!}>
                      {dialog.comment.target.title}
                    </Link>
                  ) : t('metadata.missingTarget')}
                  <span className="comment-metadata-detail">#{dialog.comment.target_public_id}</span>
                </dd>
              </div>
              <div>
                <dt>{t('metadata.submitted')}</dt>
                <dd>{dateFormatter.format(new Date(dialog.comment.created_at_iso))}</dd>
              </div>
              <div>
                <dt>{t('metadata.updated')}</dt>
                <dd>{dateFormatter.format(new Date(dialog.comment.updated_at_iso))}</dd>
              </div>
              <div>
                <dt>{t('metadata.ipAddress')}</dt>
                <dd>{dialog.comment.ip_address ?? t('metadata.notRecorded')}</dd>
              </div>
              <div className="comment-metadata-wide">
                <dt>{t('metadata.userAgent')}</dt>
                <dd>{dialog.comment.user_agent ?? t('metadata.notRecorded')}</dd>
              </div>
            </dl>
            {!dialog.comment.reply.available ? (
              <p className="comment-reply-unavailable">
                {t(`replyUnavailable.${dialog.comment.reply.reason}`)}
              </p>
            ) : null}
            <DialogActions>
              <Button ref={dialogCancelRef} type="button" onClick={() => setDialog(null)}>
                {t('dialog.close')}
              </Button>
            </DialogActions>
          </div>
        ) : null}
        {dialog?.kind === 'edit' ? (
          <form
            className="comment-dialog-form"
            onSubmit={(event) => void saveEdit(event)}
          >
            <Field
              label={t('dialog.edit.contentLabel')}
              hint={t('dialog.edit.counter', {
                count: dialog.content.length,
                limit: COMMENT_CONTENT_MAX_LENGTH,
              })}
            >
              {(control) => (
                <textarea
                  {...control}
                  value={dialog.content}
                  maxLength={COMMENT_CONTENT_MAX_LENGTH}
                  rows={9}
                  onChange={(event) => setDialog({
                    ...dialog,
                    content: event.target.value,
                  })}
                  disabled={activeCommentId !== null}
                />
              )}
            </Field>
            {failure ? (
              <Notice tone="error">{failureMessage(failure)}</Notice>
            ) : null}
            <DialogActions>
              <Button
                ref={dialogCancelRef}
                type="button"
                disabled={activeCommentId !== null}
                onClick={() => {
                  setDialog(null);
                  setFailure(null);
                }}
              >
                {t('dialog.cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  activeCommentId !== null
                  || !normalizeCommentContent(dialog.content)
                  || normalizeCommentContent(dialog.content) === dialog.comment.content_text
                }
              >
                <StudioIcon icon={Save} className="comments-action-icon" />
                {activeCommentId
                  ? t('dialog.edit.saving')
                  : t('dialog.edit.save')}
              </Button>
            </DialogActions>
          </form>
        ) : null}

        {dialog?.kind === 'compose' ? (
          <form
            className="comment-dialog-form"
            onSubmit={(event) => void createAuthoredComment(event)}
          >
            {dialog.parent ? (
              <figure className="comment-reply-context">
                <figcaption>{t('dialog.compose.originalComment', {
                  author: dialog.parent.author.name,
                })}</figcaption>
                <blockquote
                  tabIndex={0}
                  aria-label={t('dialog.compose.originalComment', {
                    author: dialog.parent.author.name,
                  })}
                >
                  <p className="comment-content">{dialog.parent.content_text}</p>
                </blockquote>
              </figure>
            ) : null}
            <dl className="comment-compose-context">
              <div>
                <dt>{t('dialog.compose.author')}</dt>
                <dd>
                  {input.data.user.name}
                  <span className="comment-compose-detail">
                    {input.data.user.email}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t(`target.${dialog.target.type}`)}</dt>
                <dd>
                  {dialog.target.title}
                  <span className="comment-compose-detail">
                    #{dialog.target.public_id}
                  </span>
                </dd>
              </div>
            </dl>
            <Field
              label={dialog.parent
                ? t('dialog.compose.replyLabel')
                : t('dialog.compose.commentLabel')}
              hint={t('dialog.compose.counter', {
                count: dialog.content.length,
                limit: COMMENT_CONTENT_MAX_LENGTH,
              })}
            >
              {(control) => (
                <textarea
                  {...control}
                  value={dialog.content}
                  maxLength={COMMENT_CONTENT_MAX_LENGTH}
                  rows={6}
                  onChange={(event) => setDialog({
                    ...dialog,
                    content: event.target.value,
                  })}
                  disabled={activeCommentId !== null}
                />
              )}
            </Field>
            {failure ? (
              <Notice tone="error">{failureMessage(failure)}</Notice>
            ) : null}
            <DialogActions>
              <Button
                ref={dialogCancelRef}
                type="button"
                disabled={activeCommentId !== null}
                onClick={() => {
                  setDialog(null);
                  setFailure(null);
                }}
              >
                {t('dialog.cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={activeCommentId !== null || !normalizeCommentContent(dialog.content)}
              >
                <StudioIcon icon={Send} className="comments-action-icon" />
                {activeCommentId
                  ? t('dialog.compose.posting')
                  : dialog.parent
                    ? t('dialog.compose.postReply')
                    : t('dialog.compose.postComment')}
              </Button>
            </DialogActions>
          </form>
        ) : null}

        {dialog?.kind === 'delete' ? (
          <div className="comment-dialog-form">
            <Notice tone="warning" title={t('dialog.delete.warningTitle')}>
              {t('dialog.delete.warningDescription')}
            </Notice>
            {failure ? (
              <Notice tone="error">{failureMessage(failure)}</Notice>
            ) : null}
            <DialogActions>
              <Button
                ref={dialogCancelRef}
                type="button"
                disabled={activeCommentId !== null}
                onClick={() => {
                  setDialog(null);
                  setFailure(null);
                }}
              >
                {t('dialog.cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={activeCommentId !== null}
                onClick={() => void permanentlyDelete()}
              >
                <StudioIcon icon={Trash2} className="comments-action-icon" />
                {activeCommentId
                  ? t('dialog.delete.deleting')
                  : t('actions.deletePermanently')}
              </Button>
            </DialogActions>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={bulkOperation !== null}
        onClose={() => {
          if (!bulkRunning) {
            setBulkOperation(null);
            setBulkFailure(null);
          }
        }}
        busy={bulkRunning}
        kicker={t('bulk.dialogKicker')}
        title={bulkOperation?.operation === 'delete_permanently'
          ? t('bulk.dialog.delete.title', { count: selectedIds.size })
          : t(`bulk.dialog.${bulkOperation?.status ?? 'approved'}.title`, {
            count: selectedIds.size,
          })}
        description={bulkOperation?.operation === 'delete_permanently'
          ? t('bulk.dialog.delete.description')
          : t(`bulk.dialog.${bulkOperation?.status ?? 'approved'}.description`)}
        initialFocusRef={bulkCancelRef}
        actions={(
          <>
            <Button
              ref={bulkCancelRef}
              type="button"
              disabled={bulkRunning}
              onClick={() => {
                setBulkOperation(null);
                setBulkFailure(null);
              }}
            >
              {t('dialog.cancel')}
            </Button>
            <Button
              type="button"
              variant={bulkOperation?.operation === 'delete_permanently'
                || bulkOperation?.status === 'trash'
                ? 'danger'
                : 'primary'}
              disabled={bulkRunning}
              onClick={() => void confirmBulkModeration()}
            >
              {bulkRunning ? t('bulk.running') : t('bulk.confirm')}
            </Button>
          </>
        )}
      >
        {bulkOperation?.operation === 'delete_permanently' ? (
          <div className="comment-dialog-form">
            <Notice tone="warning" title={t('bulk.dialog.delete.warningTitle')}>
              {t('bulk.dialog.delete.warningDescription')}
            </Notice>
          </div>
        ) : null}
        {bulkFailure ? (
          <div className="comment-dialog-form">
            <Notice tone="error">{failureMessage(bulkFailure)}</Notice>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

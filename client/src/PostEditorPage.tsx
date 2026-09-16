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
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { ApiErrorCode } from '../../contracts/api';
import { hasStudioCapability } from '../../contracts/authorization';
import { contentDraftIdSchema } from '../../contracts/content-snapshots';
import type { Media, MediaReference } from '../../contracts/media';
import {
  currentPostContentSnapshotSchema,
  normalizePostContentSnapshot,
  type CurrentPostContentSnapshot,
  type PostAutosaveDocument,
} from '../../contracts/post-autosaves';
import {
  createPostRequestSchema,
  POST_CONTENT_MAX_LENGTH,
  postIdSchema,
  suggestPostSlug,
  type CreatePostRequest,
  type Post,
  type PostEditorOption,
  type PostEditorOptionKind,
} from '../../contracts/posts';
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
  useStudioToast,
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
  AiPostDraftDialog,
  type AiPostDraftSelection,
} from './components/AiPostDraftDialog';
import { AiPostEditDialog } from './components/AiPostEditDialog';
import type {
  AiPostDraftCandidate,
  AiPostDraftTarget,
} from '../../contracts/ai-post-draft';
import type { AiPostEditTarget } from '../../contracts/ai-post-edit';
import type { ContentAiSelection } from './editor/content-ai-selection';
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
  PostsClientError,
  requestCreatePost,
  requestDeletePost,
  requestPost,
  requestPostAutosave,
  requestRecentPostAutosave,
  requestPromotePostAutosave,
  requestPostEditorOptions,
  requestPutPostAutosave,
  requestDeletePostAutosave,
  requestGeneratePostExcerpt,
  requestGeneratePostDraft,
  requestGeneratePostEdit,
  requestPostRevision,
  requestPostRevisions,
  requestPostNewsletterNotification,
  requestRestorePostRevision,
  requestUpdatePost,
} from './lib/posts-client';
import {
  STUDIO_PATHS,
  studioNewsletterDeliveriesPath,
  studioPostPath,
} from './routing/studio-routes';

type AccountSession = {
  csrf_token: string;
  user?: { roles: string[] };
};
type PostDraft = Omit<CreatePostRequest, 'autosave_draft_id'>;
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; post: Post | null }
  | { kind: 'not_found' }
  | { kind: 'error' };
type Failure =
  | { kind: 'validation' }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' };
type NotificationCompletion = {
  status: 'queued' | 'no_subscribers' | 'already_started';
  count: number;
  postId: string;
};

const EMPTY_DRAFT: PostDraft = {
  title: '',
  slug: '',
  content: '',
  document_type: 'html',
  editor_mode: 'visual',
  editor_profile: 'tiptap-v1',
  excerpt: '',
  status: 'draft',
  author_id: '',
  category_ids: [],
  tag_ids: [],
  discoverability: 'default',
  allow_comments: true,
  featured_image_id: null,
};

function draftFromPost(post: Post): PostDraft {
  return {
    title: post.title,
    slug: post.slug,
    content: post.content,
    document_type: post.document_type,
    editor_mode: post.editor_mode,
    editor_profile: post.editor_profile,
    excerpt: post.excerpt,
    status: post.status,
    author_id: post.author.id,
    category_ids: post.categories.map((item) => item.id).sort(),
    tag_ids: post.tags.map((item) => item.id),
    discoverability: post.discoverability,
    allow_comments: post.allow_comments,
    featured_image_id: post.featured_image?.id ?? null,
  };
}

function optionFromPost(
  kind: 'category' | 'tag',
  value: Post['categories'][number],
): PostEditorOption {
  return { kind, id: value.id, label: value.name, slug: value.slug };
}

function mergeOptions(
  current: PostEditorOption[],
  incoming: PostEditorOption[],
): PostEditorOption[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()].sort((left, right) => (
    left.label.localeCompare(right.label) || left.id.localeCompare(right.id)
  ));
}

function snapshotFromDraft(
  draft: PostDraft,
  options: Record<PostEditorOptionKind, PostEditorOption[]>,
  featuredImage: MediaReference | null,
): CurrentPostContentSnapshot | null {
  const author = options.author.find((item) => item.id === draft.author_id);
  const categories = draft.category_ids.map((id) => (
    options.category.find((item) => item.id === id)
  ));
  const tags = draft.tag_ids.map((id) => (
    options.tag.find((item) => item.id === id)
  ));
  if (
    (draft.author_id !== '' && !author)
    || categories.some((item) => !item)
    || tags.some((item) => !item)
    || (featuredImage?.id ?? null) !== draft.featured_image_id
  ) return null;

  const parsed = currentPostContentSnapshotSchema.safeParse({
    version: 2,
    content_type: 'post',
    draft,
    references: {
      author: author
        ? { id: author.id, display_name: author.label }
        : null,
      categories: categories.map((item) => ({
        id: item!.id,
        name: item!.label,
        slug: item!.slug,
      })),
      tags: tags.map((item) => ({
        id: item!.id,
        name: item!.label,
        slug: item!.slug,
      })),
      featured_image: featuredImage,
    },
  });
  return parsed.success ? parsed.data : null;
}

export function PostEditorPage(input: {
  mode: 'create' | 'edit';
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('posts');
  const allowCommentsId = useId();
  const allowCommentsHintId = useId();
  const { t: tMedia } = useTranslation('media');
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ postId: string }>();
  // The Field primitive generates control IDs and ARIA associations.
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [draft, setDraft] = useState<PostDraft>({ ...EMPTY_DRAFT });
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
  const [recoveryCandidate, setRecoveryCandidate] = useState<PostAutosaveDocument | null>(null);
  const [recoveryComparisonOpen, setRecoveryComparisonOpen] = useState(false);
  const [recoveryDiscarding, setRecoveryDiscarding] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [persistedSnapshotKey, setPersistedSnapshotKey] = useState('');
  const [recoveredAutosaveAtIso, setRecoveredAutosaveAtIso] = useState<string | null>(null);
  const promotedPostRef = useRef<Post | null>(null);
  const [promotedPost, setPromotedPost] = useState<Post | null>(null);
  const [featuredImageReference, setFeaturedImageReference] = useState<MediaReference | null>(null);
  const [slugEdited, setSlugEdited] = useState(false);
  const [options, setOptions] = useState<Record<PostEditorOptionKind, PostEditorOption[]>>({
    author: [],
    category: [],
    tag: [],
  });
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [optionSearch, setOptionSearch] = useState<Record<PostEditorOptionKind, string>>({
    author: '',
    category: '',
    tag: '',
  });
  const [optionLoading, setOptionLoading] = useState<PostEditorOptionKind | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [notificationFailure, setNotificationFailure] = useState<string | null>(null);
  const [notificationCompletion, setNotificationCompletion] = useState<NotificationCompletion | null>(null);
  const [revisionHistoryOpen, setRevisionHistoryOpen] = useState(false);
  const [contentMediaMode, setContentMediaMode] = useState<
    'insert' | 'replace-image' | null
  >(null);
  const [aiDraftOpen, setAiDraftOpen] = useState(false);
  const [aiEditOpen, setAiEditOpen] = useState(false);
  const [aiEditSelection, setAiEditSelection] = useState<ContentAiSelection | null>(null);
  const [aiEditSelectionMissing, setAiEditSelectionMissing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const contentEditorRef = useRef<ContentBodyEditorHandle>(null);
  const [contentBridgeDirty, setContentBridgeDirty] = useState(false);
  const featuredImageReferenceRef = useRef(featuredImageReference);
  featuredImageReferenceRef.current = featuredImageReference;
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const notificationCancelRef = useRef<HTMLButtonElement>(null);
  const deletingRef = useRef(deleting);
  deletingRef.current = deleting;
  const postId = input.mode === 'edit'
    ? postIdSchema.safeParse(params.postId)
    : null;
  const currentPost = loadState.kind === 'ready' ? loadState.post : null;
  const effectivePost = currentPost ?? promotedPost;
  const recoveryDecisionRequired = recoveryCandidate !== null
    && currentPost !== null;
  const roles = input.data.user?.roles ?? [];
  const isPostContributor = hasStudioCapability(roles, 'posts.contribute')
    && !hasStudioCapability(roles, 'posts.manage');
  const canManageAuthors = hasStudioCapability(roles, 'authors.manage');
  const canManageMedia = hasStudioCapability(roles, 'media.manage');
  const canManageNewsletters = hasStudioCapability(
    roles,
    'newsletters.manage',
  );
  const canChangeDocumentType = draft.content === ''
    && (effectivePost?.content ?? '') === '';
  const hasChanges = loadState.kind === 'ready'
    && (contentBridgeDirty || JSON.stringify(draft) !== originalDraftKey);
  const canonicalDraft = useMemo(() => (
    originalDraftKey === ''
      ? null
      : JSON.parse(originalDraftKey) as PostDraft
  ), [originalDraftKey]);
  const canonicalEditorContextClean = canonicalDraft !== null
    && !contentBridgeDirty
    && JSON.stringify({
      ...draft,
      content: canonicalDraft.content,
      editor_mode: canonicalDraft.editor_mode,
      editor_profile: canonicalDraft.editor_profile,
    }) === originalDraftKey;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    { dateStyle: 'medium', timeStyle: 'short' },
  ), [i18n.resolvedLanguage]);
  useStudioToast({
    id: 'post-newsletter-notification',
    tone: notificationCompletion?.status === 'queued' ? 'success' : 'info',
    message: notificationCompletion
      ? t(`notification.completion.${notificationCompletion.status}`, {
          count: notificationCompletion.count,
        })
      : null,
    link: notificationCompletion
      && notificationCompletion.status !== 'no_subscribers'
      ? {
          label: t('notification.viewDeliveries'),
          to: studioNewsletterDeliveriesPath(notificationCompletion.postId),
        }
      : undefined,
  });
  const autosaveSnapshot = useMemo(() => snapshotFromDraft(
    draft,
    options,
    featuredImageReference,
  ), [draft, featuredImageReference, options]);
  const normalizedRecoverySnapshot = useMemo(() => (
    recoveryCandidate
      ? normalizePostContentSnapshot(recoveryCandidate.snapshot)
      : null
  ), [recoveryCandidate]);
  const persistAutosave = useCallback(async (
    snapshot: CurrentPostContentSnapshot,
    _reason: 'scheduled' | 'flush',
  ): Promise<ContentAutosavePersistResult> => {
    try {
      const target = currentPost ?? promotedPostRef.current;
      const response = await requestPutPostAutosave(input.data.csrf_token, {
        draft_id: autosaveDraftId,
        target_id: target?.id ?? null,
        base_revision: target?.revision ?? null,
        snapshot,
      });
      if (response.success) {
        if (
          target === null
          && snapshot.draft.status === 'draft'
          && createPostRequestSchema.safeParse(snapshot.draft).success
        ) {
          try {
            const promotion = await requestPromotePostAutosave(
              input.data.csrf_token,
              { draft_id: autosaveDraftId },
            );
            if (promotion.success) {
              promotedPostRef.current = promotion.data.post;
              setPromotedPost(promotion.data.post);
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
        response.error.code === 'POST_REVISION_CONFLICT'
        || response.error.code === 'POST_NOT_FOUND'
      ) return { kind: 'conflict' };
      return { kind: 'failed' };
    } catch {
      return { kind: 'failed' };
    }
  }, [autosaveDraftId, currentPost, input.data.csrf_token, input.onSessionEnded]);
  const prepareAutosaveSnapshot = useCallback(() => {
    const current = draftRef.current;
    const content = contentEditorRef.current?.flush() ?? current.content;
    return snapshotFromDraft(
      content === current.content ? current : { ...current, content },
      optionsRef.current,
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
      const response = await requestDeletePostAutosave(
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
      && promotedPost
      && autosave.durability === 'recoverable'
    ) {
      navigate(studioPostPath(promotedPost.id), { replace: true });
    }
  }, [autosave.durability, input.mode, navigate, promotedPost]);

  useStudioDocumentTitle(t(input.mode === 'create'
    ? 'editor.createDocumentTitle'
    : 'editor.editDocumentTitle'));

  useEffect(() => {
    if (input.mode !== 'create') return;
    const params = new URLSearchParams(location.search);
    if (params.get('autosave') === autosaveDraftId) return;
    params.set('autosave', autosaveDraftId);
    navigate(`${location.pathname}?${params.toString()}`, {
      replace: true,
      state: location.state,
    });
  }, [autosaveDraftId, input.mode, location.pathname, location.search, location.state, navigate]);

  useEffect(() => {
    if (input.mode === 'edit' && !postId?.success) {
      setLoadState({ kind: 'not_found' });
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setFailure(null);
    setRecoveryError(null);
    setRecoveryComparisonOpen(false);
    const postRequest = input.mode === 'edit' && postId?.success
      ? requestPost(postId.data, controller.signal)
      : Promise.resolve(null);
    const autosaveRequest = input.mode === 'edit' && postId?.success
      ? requestPostAutosave({ target_id: postId.data }, controller.signal)
      : initialAutosaveQuery.explicit
        ? requestPostAutosave(
            { draft_id: initialAutosaveQuery.draftId },
            controller.signal,
          )
        : requestRecentPostAutosave(controller.signal);
    void Promise.all([
      postRequest,
      autosaveRequest,
      requestPostEditorOptions('author', '', controller.signal),
      requestPostEditorOptions('category', '', controller.signal),
      requestPostEditorOptions('tag', '', controller.signal),
    ]).then(([postResponse, autosaveResponse, authorResponse, categoryResponse, tagResponse]) => {
      if (!active) return;
      const responses = [authorResponse, categoryResponse, tagResponse];
      const failed = responses.find((response) => !response.success);
      if (failed && !failed.success) {
        if (failed.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({ kind: 'error' });
        return;
      }
      if (postResponse && !postResponse.success) {
        if (postResponse.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        if (postResponse.error.code === 'POST_NOT_FOUND') {
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
      const post = postResponse?.success ? postResponse.data : null;
      const autosave = autosaveResponse.data.autosave;
      if (!post && autosave?.target_id) {
        void requestPost(autosave.target_id, controller.signal).then(
          (targetResponse) => {
            if (!active) return;
            if (targetResponse.success) {
              navigate(studioPostPath(targetResponse.data.id), {
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
      const nextDraft = post ? draftFromPost(post) : {
        ...EMPTY_DRAFT,
        author_id: authorResponse.success
          ? authorResponse.data.items[0]?.id ?? ''
          : '',
      };
      setOriginalDraftKey(JSON.stringify(nextDraft));
      setRecoveredAutosaveAtIso(null);
      const initialOptions = {
        author: authorResponse.success ? authorResponse.data.items : [],
        category: categoryResponse.success ? categoryResponse.data.items : [],
        tag: tagResponse.success ? tagResponse.data.items : [],
      };
      if (post) {
        initialOptions.author = mergeOptions(initialOptions.author, [{
          kind: 'author',
          id: post.author.id,
          label: post.author.display_name,
          slug: null,
        }]);
        initialOptions.category = mergeOptions(
          initialOptions.category,
          post.categories.map((item) => optionFromPost('category', item)),
        );
        initialOptions.tag = mergeOptions(
          initialOptions.tag,
          post.tags.map((item) => optionFromPost('tag', item)),
        );
      }
      if (autosave) {
        const normalizedSnapshot = normalizePostContentSnapshot(autosave.snapshot);
        const references = normalizedSnapshot.references;
        if (references.author) {
          initialOptions.author = mergeOptions(initialOptions.author, [{
            kind: 'author',
            id: references.author.id,
            label: references.author.display_name,
            slug: null,
          }]);
        }
        initialOptions.category = mergeOptions(
          initialOptions.category,
          references.categories.map((item) => optionFromPost('category', item)),
        );
        initialOptions.tag = mergeOptions(
          initialOptions.tag,
          references.tags.map((item) => optionFromPost('tag', item)),
        );
        setAutosaveDraftId(autosave.draft_id);
        setPersistedSnapshotKey(JSON.stringify(normalizedSnapshot));
        const differsFromCanonical = JSON.stringify(normalizedSnapshot.draft)
          !== JSON.stringify(nextDraft);
        setRecoveryCandidate(differsFromCanonical ? autosave : null);
      } else {
        setPersistedSnapshotKey('');
        setRecoveryCandidate(null);
      }
      setDraft(nextDraft);
      setContentBridgeDirty(false);
      setSlugEdited(Boolean(post) || nextDraft.slug !== '');
      setFeaturedImageReference(post?.featured_image ?? null);
      setOptions(initialOptions);
      setLoadState({ kind: 'ready', post });
      setSaved(Boolean((location.state as { saved?: boolean } | null)?.saved));
      if ((location.state as { saved?: boolean } | null)?.saved) {
        navigate(location.pathname, { replace: true, state: null });
      }
    }).catch(() => {
      if (active && !controller.signal.aborted) {
        setLoadState({ kind: 'error' });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  // location state is consumed without turning save notifications into reloads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.mode, input.onSessionEnded, loadAttempt, params.postId]);

  // The Dialog primitive owns focus trapping, Escape handling,
  // and scroll locking for the deletion dialog.

  function updateDraft<K extends keyof PostDraft>(key: K, value: PostDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
    setFailure(null);
  }

  function changeDocumentType(documentType: PostDraft['document_type']) {
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

  function failureMessage(current: Failure): string {
    if (current.kind === 'validation') return t('errors.validation');
    if (current.kind === 'client') {
      if (current.code === 'TIMEOUT') return t('errors.timeout');
      if (current.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (current.code === 'POST_SLUG_CONFLICT') return t('errors.slugConflict');
    if (current.code === 'POST_REVISION_CONFLICT') return t('errors.revisionConflict');
    if (current.code === 'POST_NOT_FOUND') return t('errors.notFound');
    if (current.code === 'POST_NOT_IN_TRASH') return t('errors.notInTrash');
    if (current.code === 'CONTENT_DOCUMENT_TYPE_CHANGE_FORBIDDEN') {
      return t('errors.documentTypeChangeForbidden');
    }
    if (current.code === 'AUTHOR_NOT_FOUND') return t('errors.authorNotFound');
    if (current.code === 'POST_AUTHOR_NOT_LINKED') {
      return t('errors.authorNotLinked');
    }
    if (current.code === 'TAXONOMY_TERM_NOT_FOUND') return t('errors.taxonomyNotFound');
    if (current.code === 'FORBIDDEN') return t('errors.forbidden');
    return t('errors.api');
  }

  function notificationApiFailure(code: ApiErrorCode): string {
    switch (code) {
      case 'POST_REVISION_CONFLICT':
      case 'NEWSLETTER_MAIL_NOT_CONFIGURED':
      case 'NEWSLETTER_POST_NOTIFICATION_REQUIRES_PUBLISHED':
      case 'NEWSLETTER_POST_NOTIFICATION_UNAVAILABLE':
      case 'EDGE_INTEGRATION_DISABLED':
      case 'EDGE_INTEGRATION_UNAVAILABLE':
      case 'EDGE_DATABASE_UPGRADE_REQUIRED':
      case 'EDGE_DATABASE_RECOVERY_REQUIRED':
        return t(`notification.errors.${code}`);
      default:
        return t('notification.errors.api');
    }
  }

  async function notifySubscribers() {
    if (!currentPost || currentPost.status !== 'published') return;
    setNotifying(true);
    setNotificationFailure(null);
    try {
      const response = await requestPostNewsletterNotification(
        input.data.csrf_token,
        currentPost.id,
        { expected_revision: currentPost.revision },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setNotificationFailure(notificationApiFailure(response.error.code));
        return;
      }
      setNotificationCompletion({
        status: response.data.status,
        count: response.data.recipient_count,
        postId: response.data.post_id,
      });
      setNotificationOpen(false);
    } catch (error) {
      setNotificationFailure(t(
        error instanceof PostsClientError
          ? `notification.errors.${error.code}`
          : 'notification.errors.api',
      ));
    } finally {
      setNotifying(false);
    }
  }

  function restoreAutosave() {
    if (!recoveryCandidate || !normalizedRecoverySnapshot) return;
    const recoveredAtIso = recoveryCandidate.updated_at_iso;
    const snapshot = normalizedRecoverySnapshot;
    setDraft(snapshot.draft);
    setFeaturedImageReference(snapshot.references.featured_image);
    setOptions((current) => ({
      author: snapshot.references.author
        ? mergeOptions(current.author, [{
            kind: 'author',
            id: snapshot.references.author.id,
            label: snapshot.references.author.display_name,
            slug: null,
          }])
        : current.author,
      category: mergeOptions(
        current.category,
        snapshot.references.categories.map((item) => optionFromPost('category', item)),
      ),
      tag: mergeOptions(
        current.tag,
        snapshot.references.tags.map((item) => optionFromPost('tag', item)),
      ),
    }));
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

  async function refreshOptions(kind: PostEditorOptionKind) {
    if (optionLoading) return;
    setOptionLoading(kind);
    setFailure(null);
    try {
      const response = await requestPostEditorOptions(
        kind,
        optionSearch[kind].trim(),
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
      setOptions((current) => {
        const selectedIds = kind === 'author'
          ? [draftRef.current.author_id]
          : kind === 'category'
            ? draftRef.current.category_ids
            : draftRef.current.tag_ids;
        const selected = current[kind].filter((item) => (
          selectedIds.includes(item.id)
        ));
        return {
          ...current,
          [kind]: mergeOptions(selected, response.data.items),
        };
      });
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof PostsClientError
          ? error.code
          : 'INVALID_RESPONSE',
      });
    } finally {
      setOptionLoading(null);
    }
  }

  async function savePost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || loadState.kind !== 'ready') return;
    const current = draftRef.current;
    const content = contentEditorRef.current?.flush() ?? current.content;
    const draftForSave = content === current.content
      ? current
      : { ...current, content };
    const parsed = createPostRequestSchema.safeParse(draftForSave);
    if (!parsed.success) {
      setFailure({ kind: 'validation' });
      return;
    }
    setSaving(true);
    setFailure(null);
    setSaved(false);
    try {
      await autosave.prepareForCanonicalSave();
      const targetPost = currentPost ?? promotedPostRef.current;
      const response = targetPost
        ? await requestUpdatePost(input.data.csrf_token, targetPost.id, {
            ...parsed.data,
            expected_revision: targetPost.revision,
            autosave_draft_id: autosaveDraftId,
          })
        : await requestCreatePost(input.data.csrf_token, {
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
      const nextDraft = draftFromPost(response.data);
      setDraft(nextDraft);
      setContentBridgeDirty(false);
      setOriginalDraftKey(JSON.stringify(nextDraft));
      setSaved(true);
      setLoadState({ kind: 'ready', post: response.data });
      setFeaturedImageReference(response.data.featured_image);
      setPersistedSnapshotKey('');
      autosave.markCanonicalSaveCompleted();
      if (input.mode === 'create') {
        navigate(studioPostPath(response.data.id), {
          replace: true,
          state: { saved: true },
        });
      }
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof PostsClientError
          ? error.code
          : 'INVALID_RESPONSE',
      });
      autosave.resumeAfterCanonicalFailure();
    } finally {
      setSaving(false);
    }
  }

  function applyAiPostDraft(
    candidate: AiPostDraftCandidate,
    selection: AiPostDraftSelection,
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
        next.slug = suggestPostSlug(candidate.title);
      }
      return next;
    });
    setSaved(false);
    setFailure(null);
  }

  function openAiPostEdit() {
    const selection = contentEditorRef.current?.captureAiSelection() ?? null;
    if (!selection) {
      setAiEditSelectionMissing(true);
      contentEditorRef.current?.focus();
      return;
    }
    setAiEditSelection(selection);
    setAiEditSelectionMissing(false);
    setAiEditOpen(true);
  }

  function applyAiPostEdit(content: string) {
    setContentBridgeDirty(false);
    setDraft((current) => ({ ...current, content }));
    setSaved(false);
    setFailure(null);
  }

  async function permanentlyDelete() {
    if (
      !currentPost
      || currentPost.status !== 'trash'
      || hasChanges
      || deleting
    ) return;
    setDeleting(true);
    setFailure(null);
    try {
      const response = await requestDeletePost(
        input.data.csrf_token,
        currentPost.id,
        { expected_revision: currentPost.revision },
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
      navigate(STUDIO_PATHS.posts, { replace: true });
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof PostsClientError
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
        aria-labelledby="post-editor-title"
      >
        <PageHeader
          titleId="post-editor-title"
          kicker={t('editor.notFoundKicker')}
          title={t('editor.notFoundTitle')}
          description={t('editor.notFoundDescription')}
          actions={(
            <ButtonLink to={STUDIO_PATHS.posts}>
              {t('editor.backToPosts')}
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
        aria-labelledby="post-editor-title"
      >
        <PageHeader
          titleId="post-editor-title"
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

  const tagById = new Map(options.tag.map((item) => [item.id, item]));
  const aiDraftTarget: AiPostDraftTarget | null = draft.document_type === 'html'
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
    && (!isPostContributor || draft.author_id !== '')
    && !contentBridgeDirty
    && !saving
    && !recoveryDecisionRequired;
  const aiEditTarget: AiPostEditTarget | null = draft.document_type === 'html'
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
  const aiEditAvailable = currentPost !== null
    && draft.status !== 'trash'
    && aiEditTarget !== null
    && draft.content.trim() !== ''
    && (!isPostContributor || draft.author_id !== '')
    && !saving
    && !recoveryDecisionRequired;
  return (
    <>
      <main
        id="studio-main-content"
      >
        <PageHeader
          titleId="post-editor-title"
          kicker={t('editor.kicker')}
          title={t(input.mode === 'create'
            ? 'editor.createTitle'
            : 'editor.editTitle')}
        />

        {recoveredAutosaveAtIso ? (
          <Notice tone="info">
            {t('autosave.recoveredCurrent', {
              time: dateFormatter.format(new Date(recoveredAutosaveAtIso)),
            })}
          </Notice>
        ) : null}

        {recoveryDecisionRequired && recoveryCandidate && currentPost ? (
          <ContentRecoveryNotice
            title={t('autosave.recoveryTitle')}
            description={t('autosave.recoveryDescription')}
            staleDescription={t('autosave.recoveryStale')}
            isStale={recoveryCandidate.base_revision !== currentPost.revision}
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
          className="content-editor-form content-editor-post-form"
          onSubmit={savePost}
        >
          <fieldset
            className="content-editor-recovery-fields"
            disabled={recoveryDecisionRequired}
          >
            <legend className="visually-hidden">
              {t('autosave.resolveBeforeEditing')}
            </legend>
            <header className="content-editor-command-bar">
              <Link className="content-editor-back" to={STUDIO_PATHS.posts}>
                <StudioIcon icon={ArrowLeft} />
                <span className="content-editor-back-label">
                  {t('editor.backToPosts')}
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
                    && failure.code === 'POST_REVISION_CONFLICT' ? (
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
                {canManageNewsletters && currentPost?.status === 'published' ? (
                  <Button
                    type="button"
                    disabled={hasChanges || saving || notifying}
                    title={hasChanges
                      ? t('notification.saveBeforeSending')
                      : undefined}
                    onClick={() => {
                      setNotificationFailure(null);
                      setNotificationCompletion(null);
                      setNotificationOpen(true);
                    }}
                  >
                    <StudioIcon
                      className="content-editor-button-icon"
                      icon={Send}
                    />
                    <span className="content-editor-command-label-secondary">
                      {t('notification.open')}
                    </span>
                  </Button>
                ) : null}
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
                ) : aiEditAvailable ? (
                  <Button type="button" onClick={openAiPostEdit}>
                    <StudioIcon
                      className="content-editor-button-icon"
                      icon={Sparkles}
                    />
                    <span className="content-editor-command-label-secondary">
                      {t('aiEdit.open')}
                    </span>
                  </Button>
                ) : null}
                {currentPost ? (
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
                              slug: suggestPostSlug(value),
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
                  {effectivePost ? (
                    <dl className="content-editor-identity">
                      <div>
                        <dt>{t('editor.publicId')}</dt>
                        <dd>{effectivePost.public_id}</dd>
                      </div>
                      <div>
                        <dt>{t('editor.updated')}</dt>
                        <dd>
                          {dateFormatter.format(
                            new Date(effectivePost.updated_at_iso),
                          )}
                        </dd>
                      </div>
                    </dl>
                  ) : null}
                </div>
              </Panel>

              <Panel title={t('editor.contentHeading')}>
                <div className="content-editor-fields">
                {aiEditSelectionMissing ? (
                  <Notice tone="warning">
                    {t('aiEdit.selectionRequired')}
                  </Notice>
                ) : null}
                <div className="content-editor-source-heading">
                  <Field label={t('editor.documentTypeLabel')}>
                    {(control) => (
                      <select
                        {...control}
                        value={draft.document_type}
                        disabled={!canChangeDocumentType}
                        onChange={(event) => changeDocumentType(
                          event.target.value as PostDraft['document_type'],
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
                  maximumLength={POST_CONTENT_MAX_LENGTH}
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
                    setDraft((current) => ({ ...current, ...state }));
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
                  generate={(request, signal) => requestGeneratePostExcerpt(
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
              <Panel title={t('editor.publishHeading')}>
                <div className="content-editor-fields">
              <Field label={t('editor.statusLabel')}>
                {(control) => (
                  <select
                    {...control}
                    value={draft.status}
                    onChange={(event) => updateDraft(
                      'status',
                      event.target.value as PostDraft['status'],
                    )}
                  >
                    <option value="draft">{t('status.draft')}</option>
                    <option value="published">{t('status.published')}</option>
                    {currentPost
                      ? <option value="trash">{t('status.trash')}</option>
                      : null}
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
                      event.target.value as PostDraft['discoverability'],
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
                    onChange={(event) => updateDraft('allow_comments', event.target.checked)}
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
              {currentPost?.status === 'trash' ? (
                <div className="content-editor-danger-zone">
                  <Button
                    type="button"
                    variant="danger"
                    disabled={hasChanges}
                    title={hasChanges ? t('editor.saveBeforeDelete') : undefined}
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

            <FeaturedImageField
              value={draft.featured_image_id}
              current={featuredImageReference}
              onChange={(id, reference) => {
                setFeaturedImageReference(reference);
                updateDraft('featured_image_id', id);
              }}
              onSessionEnded={input.onSessionEnded}
              showManageLink={canManageMedia}
              aiGenerationCsrfToken={canManageMedia
                ? input.data.csrf_token
                : undefined}
              mediaManagementCsrfToken={canManageMedia
                ? input.data.csrf_token
                : undefined}
            />

            <Panel title={t('editor.authorHeading')}>
              <div className="content-editor-fields">
                {isPostContributor ? (
                  draft.author_id ? (
                    <Field
                      label={t('editor.authorLabel')}
                      hint={t('editor.authorFixedHint')}
                    >
                      {(control) => (
                        <input
                          {...control}
                          type="text"
                          readOnly
                          value={options.author.find(
                            (item) => item.id === draft.author_id,
                          )?.label ?? draft.author_id}
                        />
                      )}
                    </Field>
                  ) : (
                    <Notice
                      tone="warning"
                      title={t('editor.authorLinkRequiredTitle')}
                    >
                      {t('editor.authorLinkRequiredDescription')}
                    </Notice>
                  )
                ) : (
                  <>
                    <Field label={t('editor.authorLabel')}>
                      {(control) => (
                        <select
                          {...control}
                          required
                          value={draft.author_id}
                          onChange={(event) => (
                            updateDraft('author_id', event.target.value)
                          )}
                        >
                          <option value="">{t('editor.selectAuthor')}</option>
                          {options.author.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </Field>
                    <div className="content-editor-option-search">
                      <input
                        type="search"
                        maxLength={200}
                        aria-label={t('editor.searchAuthors')}
                        placeholder={t('editor.searchAuthors')}
                        value={optionSearch.author}
                        onChange={(event) => setOptionSearch((current) => ({
                          ...current,
                          author: event.target.value,
                        }))}
                      />
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => refreshOptions('author')}
                      >
                        {optionLoading === 'author'
                          ? t('editor.searching')
                          : t('editor.search')}
                      </Button>
                    </div>
                  </>
                )}
                {options.author.length === 0 && !isPostContributor ? (
                  <p className="content-editor-empty-reference">
                    {t('editor.noAuthors')}
                    {canManageAuthors ? (
                      <>
                        {' '}
                        <Link
                          to={STUDIO_PATHS.authors}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t('editor.manageAuthors')}
                        </Link>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>
            </Panel>

            <Panel title={t('editor.categoriesHeading')}>
              <div className="content-editor-fields">
                <div className="content-editor-option-search">
                  <input
                    type="search"
                    maxLength={200}
                    aria-label={t('editor.searchCategories')}
                    placeholder={t('editor.searchCategories')}
                    value={optionSearch.category}
                    onChange={(event) => setOptionSearch((current) => ({
                      ...current,
                      category: event.target.value,
                    }))}
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => refreshOptions('category')}
                  >
                    {optionLoading === 'category'
                      ? t('editor.searching')
                      : t('editor.search')}
                  </Button>
                </div>
                <div className="content-editor-check-list">
                  {options.category.map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={draft.category_ids.includes(item.id)}
                        onChange={(event) => updateDraft(
                          'category_ids',
                          event.target.checked
                            ? [...draft.category_ids, item.id].sort()
                            : draft.category_ids.filter((id) => id !== item.id),
                        )}
                      />
                      <span className="content-editor-check-copy">
                        {item.label}
                        <span className="content-editor-check-slug">
                          /{item.slug}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </Panel>

            <Panel
              title={t('editor.tagsHeading')}
              description={t('editor.tagsDescription')}
            >
              <div className="content-editor-fields">
              <div className="content-editor-option-search">
                <input
                  type="search"
                  maxLength={200}
                  aria-label={t('editor.searchTags')}
                  placeholder={t('editor.searchTags')}
                  value={optionSearch.tag}
                  onChange={(event) => setOptionSearch((current) => ({
                    ...current,
                    tag: event.target.value,
                  }))}
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => refreshOptions('tag')}
                >
                  {optionLoading === 'tag'
                    ? t('editor.searching')
                    : t('editor.search')}
                </Button>
              </div>
              <div className="content-editor-check-list">
                {options.tag.map((item) => (
                  <label key={item.id}>
                    <input
                      type="checkbox"
                      checked={draft.tag_ids.includes(item.id)}
                      onChange={(event) => updateDraft(
                        'tag_ids',
                        event.target.checked
                          ? [...draft.tag_ids, item.id]
                          : draft.tag_ids.filter((id) => id !== item.id),
                      )}
                    />
                    <span className="content-editor-check-copy">
                      {item.label}
                      <span className="content-editor-check-slug">
                        /{item.slug}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {draft.tag_ids.length > 0 ? (
                <ol className="content-editor-tag-order">
                  {draft.tag_ids.map((id, index) => {
                    const item = tagById.get(id);
                    return (
                      <li key={id}>
                        <span className="content-editor-tag-name">
                          {item?.label ?? id}
                        </span>
                        <div className="content-editor-tag-controls">
                          <Button
                            type="button"
                            size="sm"
                            aria-label={t('editor.moveTagUp', { tag: item?.label ?? id })}
                            disabled={index === 0}
                            onClick={() => {
                              const next = [...draft.tag_ids];
                              [next[index - 1], next[index]] = [next[index], next[index - 1]];
                              updateDraft('tag_ids', next);
                            }}
                          >
                            ↑
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            aria-label={t('editor.moveTagDown', { tag: item?.label ?? id })}
                            disabled={index === draft.tag_ids.length - 1}
                            onClick={() => {
                              const next = [...draft.tag_ids];
                              [next[index], next[index + 1]] = [next[index + 1], next[index]];
                              updateDraft('tag_ids', next);
                            }}
                          >
                            ↓
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : null}
              </div>
            </Panel>
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
          showManageLink={canManageMedia}
          aiGenerationCsrfToken={canManageMedia
            ? input.data.csrf_token
            : undefined}
          mediaManagementCsrfToken={canManageMedia
            ? input.data.csrf_token
            : undefined}
        />
      ) : null}

      {aiDraftTarget ? (
        <AiPostDraftDialog
          open={aiDraftOpen}
          currentTitle={draft.title}
          currentExcerpt={draft.excerpt}
          target={aiDraftTarget}
          generate={(request, signal) => requestGeneratePostDraft(
            input.data.csrf_token,
            request,
            signal,
          )}
          onApply={applyAiPostDraft}
          onClose={() => setAiDraftOpen(false)}
          onSessionEnded={input.onSessionEnded}
        />
      ) : null}

      {currentPost && aiEditTarget && aiEditSelection ? (
        <AiPostEditDialog
          open={aiEditOpen}
          expectedRevision={currentPost.revision}
          target={aiEditTarget}
          selection={aiEditSelection}
          generate={(request, signal) => requestGeneratePostEdit(
            input.data.csrf_token,
            currentPost.id,
            request,
            signal,
          )}
          composeCandidate={(selection, replacement) => (
            contentEditorRef.current?.buildAiCandidate(selection, replacement)
              ?? null
          )}
          onApply={applyAiPostEdit}
          onClose={() => {
            setAiEditOpen(false);
            setAiEditSelection(null);
          }}
          onSessionEnded={input.onSessionEnded}
        />
      ) : null}

      {revisionHistoryOpen && currentPost ? (
        <ContentRevisionHistoryDialog
          formatDate={(iso) => dateFormatter.format(new Date(iso))}
          onClose={() => setRevisionHistoryOpen(false)}
          onRestored={() => {
            setRevisionHistoryOpen(false);
            navigate(location.pathname, { replace: true, state: { saved: true } });
            setLoadAttempt((value) => value + 1);
          }}
          onSessionEnded={input.onSessionEnded}
          requestList={(signal) => requestPostRevisions(currentPost.id, signal)}
          requestDetail={(revisionId, signal) => (
            requestPostRevision(currentPost.id, revisionId, signal)
          )}
          requestRestore={(revisionId, request) => requestRestorePostRevision(
            input.data.csrf_token,
            currentPost.id,
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
        && currentPost ? (
          <ContentAutosaveComparisonDialog
            title={t('autosave.compareTitle')}
            description={t('autosave.compareDescription')}
            closeLabel={t('autosave.compareClose')}
            staleDescription={t('autosave.recoveryStale')}
            isStale={recoveryCandidate.base_revision !== currentPost.revision}
            savedLabel={t('autosave.savedVersion')}
            autosaveLabel={t('autosave.recoveryVersion')}
            comparisonKey={`${currentPost.revision}:${recoveryCandidate.snapshot_sha256}`}
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

      {recoveryCandidate && currentPost === null ? (
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
        open={notificationOpen && currentPost?.status === 'published'}
        onClose={() => {
          setNotificationOpen(false);
          setNotificationFailure(null);
        }}
        busy={notifying}
        kicker={t('notification.kicker')}
        title={t('notification.title', { title: currentPost?.title ?? '' })}
        description={t('notification.description')}
        initialFocusRef={notificationCancelRef}
        actions={(
          <>
            <Button
              ref={notificationCancelRef}
              type="button"
              disabled={notifying}
              onClick={() => {
                setNotificationOpen(false);
                setNotificationFailure(null);
              }}
            >
              {t('notification.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={notifying}
              onClick={() => void notifySubscribers()}
            >
              <StudioIcon icon={Send} />
              {notifying
                ? t('notification.sending')
                : t('notification.confirm')}
            </Button>
          </>
        )}
      >
        {notificationFailure ? (
          <div className="content-editor-dialog-notice">
            <Notice tone="error">{notificationFailure}</Notice>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={deleteOpen && currentPost !== null}
        onClose={() => {
          setDeleteOpen(false);
          setFailure(null);
        }}
        busy={deleting}
        kicker={t('delete.kicker')}
        title={t('delete.title', { title: currentPost?.title ?? '' })}
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

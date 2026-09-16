import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import { Link, useSearchParams } from 'react-router';
import {
  Fingerprint,
  ImagePlus,
  Link2,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  UserRound,
} from 'lucide-react';
import type { ApiErrorCode } from '../../contracts/api';
import {
  AUTHORS_DEFAULT_PAGE_SIZE,
  authorDisplayNameInputSchema,
  authorIdSchema,
  suggestAuthorId,
  type Author,
  type AuthorListItem,
  type AuthorListSummary,
  type AuthorUserOption,
} from '../../contracts/authors';
import type { Media } from '../../contracts/media';
import {
  AuthorsClientError,
  requestAuthors,
  requestAuthorUserOptions,
  requestCreateAuthor,
  requestDeleteAuthor,
  requestUpdateAuthor,
} from './lib/authors-client';
import {
  ActionMenu,
  Button,
  DataTable,
  Dialog,
  DialogActions,
  EmptyState,
  Field,
  FilterTabs,
  Notice,
  PageHeader,
  Pagination,
  RouteLoading,
  StatusPill,
  StudioIcon,
  useStudioToast,
} from './components/primitives';
import { studioPostsByAuthorPath } from './routing/studio-routes';
import { MediaPickerDialog } from './components/MediaPickerDialog';
import { IdentityAvatar } from './components/IdentityAvatar';
import { resolveMediaPreviewUrl } from './lib/media-preview';

type AccountSession = {
  csrf_token: string;
};

type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      authors: AuthorListItem[];
      users: AuthorUserOption[];
      pagination: {
        page: number;
        per_page: number;
        total: number;
        total_pages: number;
      };
      summary: AuthorListSummary;
    }
  | { kind: 'error' };

type AuthorAction =
  | { kind: 'create' }
  | { kind: 'edit'; author: Author }
  | { kind: 'delete'; author: Author };

type Failure =
  | { kind: 'validation'; field: 'id' | 'display_name' }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' };

type Completion = {
  kind: 'created' | 'updated' | 'deleted';
  displayName: string;
};

export function AuthorsPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('authors');
  const [searchParams] = useSearchParams();
  const initialSearch = searchParams.get('search')?.trim().slice(0, 200) ?? '';
  const requestedEditAuthorId = authorIdSchema.safeParse(
    searchParams.get('edit'),
  );
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [search, setSearch] = useState(initialSearch);
  const [linked, setLinked] = useState<'all' | 'linked' | 'unlinked'>('all');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<AuthorAction | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [id, setId] = useState('');
  const [idEdited, setIdEdited] = useState(false);
  const [linkedUserId, setLinkedUserId] = useState('');
  const [avatar, setAvatar] = useState<Author['avatar']>(null);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const pendingEditAuthorIdRef = useRef<string | null>(
    requestedEditAuthorId.success ? requestedEditAuthorId.data : null,
  );
  const runningRef = useRef(running);
  runningRef.current = running;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    { dateStyle: 'medium', timeStyle: 'short' },
  ), [i18n.resolvedLanguage]);
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage),
    [i18n.resolvedLanguage],
  );

  useStudioDocumentTitle(t('documentTitle'));
  useStudioToast({
    id: 'authors-completion',
    tone: 'success',
    message: completion
      ? t(`completion.${completion.kind}`, { name: completion.displayName })
      : null,
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    void Promise.all([
      requestAuthors({
        search,
        linked,
        page,
        per_page: AUTHORS_DEFAULT_PAGE_SIZE,
      }, controller.signal),
      requestAuthorUserOptions(controller.signal),
    ]).then(([authorsResponse, usersResponse]) => {
      if (!active) return;
      if (!authorsResponse.success || !usersResponse.success) {
        const code = !authorsResponse.success
          ? authorsResponse.error.code
          : !usersResponse.success
            ? usersResponse.error.code
            : 'INTERNAL_ERROR';
        if (code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({ kind: 'error' });
        return;
      }
      setLoadState({
        kind: 'ready',
        authors: authorsResponse.data.items,
        users: usersResponse.data.items,
        pagination: authorsResponse.data.pagination,
        summary: authorsResponse.data.summary,
      });
    }).catch(() => {
      if (active && !controller.signal.aborted) {
        setLoadState({ kind: 'error' });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [input.onSessionEnded, linked, loadAttempt, page, search]);

  useEffect(() => {
    if (loadState.kind !== 'ready' || !pendingEditAuthorIdRef.current) return;
    const target = loadState.authors.find(
      (author) => author.id === pendingEditAuthorIdRef.current,
    );
    if (!target) return;
    pendingEditAuthorIdRef.current = null;
    openEdit(target);
  }, [loadState]);

  function openCreate() {
    setAction({ kind: 'create' });
    setDisplayName('');
    setId('');
    setIdEdited(false);
    setLinkedUserId('');
    setAvatar(null);
    setAvatarPickerOpen(false);
    setFailure(null);
  }

  function openEdit(author: Author) {
    setAction({ kind: 'edit', author });
    setDisplayName(author.display_name);
    setId(author.id);
    setIdEdited(true);
    setLinkedUserId(author.user?.id ?? '');
    setAvatar(author.avatar);
    setAvatarPickerOpen(false);
    setFailure(null);
  }

  function openDelete(author: Author) {
    setAction({ kind: 'delete', author });
    setFailure(null);
  }

  function closeAction() {
    if (runningRef.current) return;
    setAction(null);
    setAvatarPickerOpen(false);
    setFailure(null);
  }

  function handleDisplayName(value: string) {
    setDisplayName(value);
    if (action?.kind === 'create' && !idEdited) {
      setId(suggestAuthorId(value));
    }
  }

  function handleApiFailure(code: ApiErrorCode) {
    if (code === 'AUTHENTICATION_REQUIRED') {
      input.onSessionEnded();
      return;
    }
    setFailure({ kind: 'api', code });
  }

  function failureMessage(current: Failure): string {
    if (current.kind === 'validation') {
      return t(`validation.${current.field}`);
    }
    if (current.kind === 'client') {
      if (current.code === 'TIMEOUT') return t('errors.timeout');
      if (current.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (current.code === 'AUTHOR_ID_CONFLICT') return t('errors.idConflict');
    if (current.code === 'AUTHOR_USER_CONFLICT') return t('errors.userConflict');
    if (current.code === 'AUTHOR_NOT_FOUND') return t('errors.notFound');
    if (current.code === 'AUTHOR_REVISION_CONFLICT') {
      return t('errors.revisionConflict');
    }
    if (current.code === 'AUTHOR_IN_USE') return t('errors.inUse');
    if (current.code === 'USER_NOT_FOUND') return t('errors.userNotFound');
    if (current.code === 'MEDIA_NOT_FOUND') return t('errors.mediaNotFound');
    if (current.code === 'FORBIDDEN') return t('errors.forbidden');
    return t('errors.api');
  }

  async function submitAuthor(event: FormEvent) {
    event.preventDefault();
    if (!action || action.kind === 'delete') return;
    const parsedName = authorDisplayNameInputSchema.safeParse(displayName);
    if (!parsedName.success) {
      setFailure({ kind: 'validation', field: 'display_name' });
      return;
    }
    if (action.kind === 'create' && !authorIdSchema.safeParse(id).success) {
      setFailure({ kind: 'validation', field: 'id' });
      return;
    }
    setRunning(true);
    setFailure(null);
    try {
      const response = action.kind === 'create'
        ? await requestCreateAuthor(input.data.csrf_token, {
            id,
            display_name: parsedName.data,
            user_id: linkedUserId || null,
            avatar_media_id: avatar?.id ?? null,
          })
        : await requestUpdateAuthor(
            input.data.csrf_token,
            action.author.id,
            {
              display_name: parsedName.data,
              user_id: linkedUserId || null,
              avatar_media_id: avatar?.id ?? null,
              expected_revision: action.author.revision,
            },
          );
      if (!response.success) {
        handleApiFailure(response.error.code);
        return;
      }
      setCompletion({
        kind: action.kind === 'create' ? 'created' : 'updated',
        displayName: response.data.display_name,
      });
      setAction(null);
      setLoadAttempt((value) => value + 1);
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof AuthorsClientError
          ? error.code
          : 'INVALID_RESPONSE',
      });
    } finally {
      setRunning(false);
    }
  }

  async function confirmDelete() {
    if (action?.kind !== 'delete') return;
    setRunning(true);
    setFailure(null);
    try {
      const response = await requestDeleteAuthor(
        input.data.csrf_token,
        action.author.id,
        { expected_revision: action.author.revision },
      );
      if (!response.success) {
        handleApiFailure(response.error.code);
        return;
      }
      setCompletion({
        kind: 'deleted',
        displayName: action.author.display_name,
      });
      setAction(null);
      if (loadState.kind === 'ready' && loadState.authors.length === 1 && page > 1) {
        setPage((value) => value - 1);
      } else {
        setLoadAttempt((value) => value + 1);
      }
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof AuthorsClientError
          ? error.code
          : 'INVALID_RESPONSE',
      });
    } finally {
      setRunning(false);
    }
  }

  if (loadState.kind === 'loading') {
    return (
      <RouteLoading>{t('loading')}</RouteLoading>
    );
  }

  if (loadState.kind === 'error') {
    return (
      <main id="studio-main-content">
        <PageHeader titleId="authors-title" title={t('title')} />
        <Notice
          tone="error"
          actions={(
            <Button
              type="button"
              onClick={() => setLoadAttempt((value) => value + 1)}
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

  const editedAuthor = action?.kind === 'edit' ? action.author : null;
  const availableUsers = loadState.users.filter((user) => (
    user.linked_author_id === null
    || user.linked_author_id === editedAuthor?.id
  ));

  const filtered = Boolean(search) || linked !== 'all';
  return (
    <main
      id="studio-main-content"
      aria-labelledby="authors-title"
    >
      <PageHeader
        titleId="authors-title"
        kicker={t('kicker')}
        title={t('title')}
        description={t('description')}
      />

      <div className="content-list-toolbar content-list-toolbar-editorial">
        <div className="content-list-toolbar-controls">
          <form
            className="content-list-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
              setSearch(searchInput.trim());
            }}
          >
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
                  placeholder={t('filters.searchPlaceholder')}
                  onChange={(event) => setSearchInput(event.target.value)}
                />
              )}
            </Field>
            <Button type="submit">{t('filters.apply')}</Button>
          </form>

          <FilterTabs
            label={t('filters.linkFilterLabel')}
            value={linked}
            items={(['all', 'linked', 'unlinked'] as const).map((value) => ({
              value,
              label: t(`filters.${value}`),
            }))}
            onChange={(value) => {
              setLinked(value);
              setPage(1);
            }}
          />

          <div className="content-list-create-action">
            <Button type="button" variant="primary" onClick={openCreate}>
              <StudioIcon icon={Plus} className="content-list-button-icon" />
              {t('create')}
            </Button>
          </div>
        </div>
      </div>

      <dl
        className="content-list-metrics"
        aria-label={t('summary.label')}
      >
        <div>
          <dt>{t('summary.total')}</dt>
          <dd>{numberFormatter.format(loadState.summary.total)}</dd>
        </div>
        <div>
          <dt>{t('summary.linked')}</dt>
          <dd>{numberFormatter.format(loadState.summary.linked)}</dd>
        </div>
        <div>
          <dt>{t('summary.unlinked')}</dt>
          <dd>{numberFormatter.format(loadState.summary.unlinked)}</dd>
        </div>
      </dl>

      {loadState.authors.length === 0 ? (
        <EmptyState
          headingLevel={2}
          announce={filtered}
          title={t(filtered ? 'empty.filteredTitle' : 'empty.title')}
          description={t(filtered
            ? 'empty.filteredDescription'
            : 'empty.description')}
        />
      ) : (
        <DataTable
          caption={t('table.label')}
          minWidthPx={760}
          stacked="compact"
          framed
        >
          <thead>
            <tr>
              <th scope="col">{t('table.author')}</th>
              <th scope="col">{t('table.account')}</th>
              <th scope="col">{t('table.posts')}</th>
              <th scope="col">{t('table.updated')}</th>
              <th scope="col">{t('table.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loadState.authors.map((author) => (
              <tr key={author.id}>
                <td data-label={t('table.author')} data-stack="primary">
                  <span className="author-list-identity">
                    <IdentityAvatar
                      className="author-avatar author-avatar-list"
                      name={author.display_name}
                      src={author.avatar?.preview_url}
                    />
                    <span className="content-list-stacked-cell">
                      <strong className="content-list-title">
                        {author.display_name}
                      </strong>
                      <code className="content-list-slug">{author.id}</code>
                    </span>
                  </span>
                </td>
                <td data-label={t('table.account')}>
                  {author.user ? (
                    <span className="author-account-cell">
                      <StatusPill tone="positive">
                        {t('table.accountLinked')}
                      </StatusPill>
                      <strong className="content-list-cell-primary">
                        {author.user.name}
                      </strong>
                      <small className="content-list-cell-detail">{author.user.email}</small>
                    </span>
                  ) : (
                    <StatusPill tone="neutral">
                      {t('table.noAccount')}
                    </StatusPill>
                  )}
                </td>
                <td data-label={t('table.posts')}>
                  <span className="content-list-stacked-cell">
                    <strong className="content-list-cell-primary">
                      {author.post_count}
                    </strong>
                    <Link to={studioPostsByAuthorPath(author.id)}>
                      {t('actions.viewPosts')}
                    </Link>
                  </span>
                </td>
                <td data-label={t('table.updated')} data-stack="wide">
                  {dateFormatter.format(new Date(author.updated_at_iso))}
                </td>
                <td data-label={t('table.actions')} data-stack="actions">
                  <div className="content-list-row-actions">
                    <ActionMenu
                      label={t('actions.menuLabel', {
                        name: author.display_name,
                      })}
                      items={[
                        {
                          id: 'edit',
                          kind: 'button',
                          label: t('actions.edit'),
                          icon: Pencil,
                          onSelect: () => openEdit(author),
                        },
                        {
                          id: 'delete',
                          kind: 'button',
                          label: t('actions.delete'),
                          icon: Trash2,
                          tone: 'critical',
                          onSelect: () => openDelete(author),
                        },
                      ]}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
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
            onChange={setPage}
          />
        </div>
      ) : null}

      {action?.kind === 'delete' ? (
        <Dialog
          open
          busy={running}
          onClose={closeAction}
          kicker={t('dialog.deleteKicker')}
          title={t('dialog.deleteTitle', {
            name: action.author.display_name,
          })}
          description={t('dialog.deleteDescription')}
          initialFocusRef={cancelRef}
          actions={(
            <>
              <Button
                ref={cancelRef}
                type="button"
                disabled={running}
                onClick={closeAction}
              >
                {t('dialog.cancel')}
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={running}
                onClick={confirmDelete}
              >
                <StudioIcon
                  icon={Trash2}
                  className="content-list-button-icon"
                />
                {running ? t('dialog.running') : t('dialog.confirmDelete')}
              </Button>
            </>
          )}
        >
          {failure ? (
            <div className="content-list-dialog-notice">
              <Notice tone="error">{failureMessage(failure)}</Notice>
            </div>
          ) : null}
        </Dialog>
      ) : null}

      {action && action.kind !== 'delete' ? (
        <Dialog
          open
          busy={running}
          onClose={closeAction}
          kicker={t(action.kind === 'create'
            ? 'dialog.createKicker'
            : 'dialog.editKicker')}
          title={t(action.kind === 'create'
            ? 'dialog.createTitle'
            : 'dialog.editTitle')}
          description={t(action.kind === 'create'
            ? 'dialog.createDescription'
            : 'dialog.editDescription')}
          initialFocusRef={cancelRef}
        >
          {/* Keep DialogActions in children so the submit button stays inside the form. */}
          <form className="content-list-dialog-form" onSubmit={submitAuthor}>
            <Field
              label={t('dialog.displayName')}
              leading={<StudioIcon icon={UserRound} />}
            >
              {(control) => (
                <input
                  {...control}
                  type="text"
                  maxLength={200}
                  value={displayName}
                  required
                  disabled={running}
                  onChange={(event) => handleDisplayName(event.target.value)}
                />
              )}
            </Field>
            <Field
              label={t('dialog.authorId')}
              hint={t(action.kind === 'create'
                ? 'dialog.authorIdHint'
                : 'dialog.authorIdImmutable')}
              leading={<StudioIcon icon={Fingerprint} />}
            >
              {(control) => (
                <input
                  {...control}
                  type="text"
                  maxLength={512}
                  pattern="[A-Za-z0-9_-]+"
                  value={id}
                  readOnly={action.kind === 'edit'}
                  required
                  disabled={running}
                  onChange={(event) => {
                    setId(event.target.value);
                    setIdEdited(true);
                  }}
                />
              )}
            </Field>
            <Field
              label={t('dialog.linkedAccount')}
              hint={t('dialog.linkedAccountHint')}
              leading={<StudioIcon icon={Link2} />}
            >
              {(control) => (
                <select
                  {...control}
                  value={linkedUserId}
                  disabled={running}
                  onChange={(event) => setLinkedUserId(event.target.value)}
                >
                  <option value="">{t('dialog.noAccount')}</option>
                  {availableUsers.map((user) => (
                    <option key={user.id} value={user.id}>
                      {`${user.name} — ${user.email}`}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <div className="author-avatar-editor">
              <IdentityAvatar
                className="author-avatar author-avatar-editor-preview"
                name={displayName || id || t('dialog.avatarFallbackName')}
                src={avatar?.preview_url}
              />
              <span className="author-avatar-editor-copy">
                <strong>{t('dialog.avatar')}</strong>
                <small className="author-avatar-editor-detail">
                  {avatar?.filename ?? t('dialog.noAvatar')}
                </small>
              </span>
              <span className="content-list-row-actions">
                <Button
                  type="button"
                  size="sm"
                  disabled={running}
                  onClick={() => setAvatarPickerOpen(true)}
                >
                  <StudioIcon
                    icon={ImagePlus}
                    className="content-list-button-icon"
                  />
                  {avatar ? t('dialog.replaceAvatar') : t('dialog.chooseAvatar')}
                </Button>
                {avatar ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={running}
                    onClick={() => setAvatar(null)}
                  >
                    {t('dialog.removeAvatar')}
                  </Button>
                ) : null}
              </span>
            </div>
            {failure ? (
              <Notice tone="error">{failureMessage(failure)}</Notice>
            ) : null}
            <DialogActions>
              <Button
                ref={cancelRef}
                type="button"
                disabled={running}
                onClick={closeAction}
              >
                {t('dialog.cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={running}>
                <StudioIcon
                  icon={action.kind === 'create' ? Plus : Save}
                  className="content-list-button-icon"
                />
                {running
                  ? t('dialog.running')
                  : t(action.kind === 'create'
                      ? 'dialog.confirmCreate'
                      : 'dialog.confirmEdit')}
              </Button>
            </DialogActions>
          </form>
        </Dialog>
      ) : null}
      {avatarPickerOpen && action && action.kind !== 'delete' ? (
        <MediaPickerDialog
          purpose="author_avatar"
          selectedId={avatar?.id}
          copy={{
            kicker: t('picker.kicker'),
            title: t('picker.title'),
            description: t('picker.description'),
            select: t('picker.select'),
            selectNamed: (filename) => t('picker.selectNamed', { filename }),
            emptyTitle: t('picker.emptyTitle'),
            emptyDescription: t('picker.emptyDescription'),
          }}
          showManageLink
          onClose={() => setAvatarPickerOpen(false)}
          onSessionEnded={input.onSessionEnded}
          aiGenerationCsrfToken={input.data.csrf_token}
          mediaManagementCsrfToken={input.data.csrf_token}
          onSelect={(media: Media, delivery) => {
            setAvatar({
              id: media.id,
              filename: media.filename,
              mime_type: media.mime_type,
              location: media.location,
              preview_url: resolveMediaPreviewUrl(media, delivery),
            });
            setAvatarPickerOpen(false);
          }}
        />
      ) : null}
    </main>
  );
}

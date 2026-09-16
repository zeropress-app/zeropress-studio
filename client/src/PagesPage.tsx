import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import { Link } from 'react-router';
import {
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import type { ApiErrorCode } from '../../contracts/api';
import { CONTENT_BULK_LIFECYCLE_MAX_ITEMS } from '../../contracts/content-bulk-lifecycle';
import {
  PAGES_DEFAULT_PAGE_SIZE,
  type PageBulkLifecycleData,
  type PageStatus,
  type PageSummary,
  type PageListItem,
} from '../../contracts/pages';
import {
  ActionMenu,
  Button,
  ButtonLink,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  FilterTabs,
  Notice,
  PageHeader,
  Pagination,
  RouteLoading,
  StatusPill,
  StudioIcon,
  type StatusTone,
} from './components/primitives';
import {
  PagesClientError,
  requestDeletePage,
  requestPageBulkLifecycle,
  requestPages,
} from './lib/pages-client';
import { STUDIO_PATHS, studioPagePath } from './routing/studio-routes';
import { ContentSearchMatchContext } from './components/ContentSearchMatch';

type AccountSession = { csrf_token: string };
type StatusFilter = 'all' | PageStatus;
type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      items: PageListItem[];
      pagination: {
        page: number;
        per_page: number;
        total: number;
        total_pages: number;
      };
      statusCounts: Record<StatusFilter, number>;
    }
  | { kind: 'error'; code: ApiErrorCode | null };
type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' };
type BulkCompletion = {
  data: PageBulkLifecycleData;
  titles: Record<string, string>;
};

/** Map authoring states to the primitives' semantic tones. */
const STATUS_TONE: Record<PageStatus, StatusTone> = {
  published: 'positive',
  draft: 'neutral',
  trash: 'critical',
};

export function PagesPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('pages');
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<PageSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [completion, setCompletion] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set<string>());
  const [bulkTarget, setBulkTarget] = useState<PageStatus | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkFailure, setBulkFailure] = useState<Failure | null>(null);
  const [bulkCompletion, setBulkCompletion] = useState<BulkCompletion | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    { dateStyle: 'medium', timeStyle: 'short' },
  ), [i18n.resolvedLanguage]);

  useStudioDocumentTitle(t('list.documentTitle'));

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    void requestPages({
      search,
      status,
      page,
      per_page: PAGES_DEFAULT_PAGE_SIZE,
    }, controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({ kind: 'error', code: response.error.code });
        return;
      }
      setLoadState({
        kind: 'ready',
        items: response.data.items,
        pagination: response.data.pagination,
        statusCounts: response.data.status_counts,
      });
    }).catch(() => {
      if (active && !controller.signal.aborted) {
        setLoadState({ kind: 'error', code: null });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [input.onSessionEnded, loadAttempt, page, search, status]);

  function failureMessage(current: Failure): string {
    if (current.kind === 'client') {
      if (current.code === 'TIMEOUT') return t('errors.timeout');
      if (current.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (current.code === 'PAGE_REVISION_CONFLICT') {
      return t('errors.revisionConflict');
    }
    if (current.code === 'PAGE_NOT_FOUND') return t('errors.notFound');
    if (current.code === 'PAGE_NOT_IN_TRASH') return t('errors.notInTrash');
    if (current.code === 'PAGE_HAS_CHILDREN') return t('errors.hasChildren');
    if (current.code === 'PAGE_IS_FRONT_PAGE') return t('errors.frontPage');
    if (current.code === 'FORBIDDEN') return t('errors.forbidden');
    return t('errors.api');
  }

  function closeDelete() {
    setDeleteTarget(null);
    setFailure(null);
  }

  function clearBulkSelection() {
    setSelectedIds(new Set());
  }

  function resetBulkContext() {
    clearBulkSelection();
    setBulkTarget(null);
    setBulkFailure(null);
    setBulkCompletion(null);
  }

  async function confirmBulkLifecycle() {
    if (bulkTarget === null || bulkRunning || loadState.kind !== 'ready') return;
    const selected = loadState.items.filter((item) => selectedIds.has(item.id));
    if (selected.length === 0) return;
    setBulkRunning(true);
    setBulkFailure(null);
    try {
      const response = await requestPageBulkLifecycle(input.data.csrf_token, {
        target_status: bulkTarget,
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
        setBulkFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setBulkCompletion({
        data: response.data,
        titles: Object.fromEntries(selected.map((item) => [item.id, item.title])),
      });
      setSelectedIds((current) => {
        const next = new Set(current);
        for (const result of response.data.results) {
          if (result.outcome === 'updated' || result.outcome === 'unchanged') {
            next.delete(result.id);
          }
        }
        return next;
      });
      setBulkTarget(null);
      setLoadAttempt((value) => value + 1);
    } catch (error) {
      setBulkFailure({
        kind: 'client',
        code: error instanceof PagesClientError
          ? error.code
          : 'INVALID_RESPONSE',
      });
    } finally {
      setBulkRunning(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setFailure(null);
    try {
      const response = await requestDeletePage(
        input.data.csrf_token,
        deleteTarget.id,
        { expected_revision: deleteTarget.revision },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      const title = deleteTarget.title;
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(deleteTarget.id);
        return next;
      });
      setDeleteTarget(null);
      setCompletion(title);
      if (loadState.kind === 'ready'
        && loadState.items.length === 1 && page > 1) {
        setPage((value) => Math.max(1, value - 1));
      } else {
        setLoadAttempt((value) => value + 1);
      }
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
      <RouteLoading>{t('list.loading')}</RouteLoading>
    );
  }

  if (loadState.kind === 'error') {
    const searchFailure = search !== '' && (
      loadState.code === 'CONTENT_SEARCH_INDEX_NOT_READY'
      || loadState.code === 'CONTENT_SEARCH_INDEX_UNAVAILABLE'
      || loadState.code === 'CONTENT_SEARCH_QUERY_INVALID'
    );
    return (
      <main
        id="studio-main-content"
        aria-labelledby="pages-title"
      >
        <PageHeader
          titleId="pages-title"
          kicker={t('list.kicker')}
          title={t('list.title')}
        />
        <Notice
          tone={searchFailure ? 'warning' : 'error'}
          actions={(
            <Button
              type="button"
              onClick={() => {
                if (searchFailure) {
                  setSearchInput('');
                  setSearch('');
                  setPage(1);
                } else {
                  setLoadAttempt((value) => value + 1);
                }
              }}
            >
              {t(searchFailure ? 'list.clearSearch' : 'list.retry')}
            </Button>
          )}
        >
          {t(loadState.code === 'CONTENT_SEARCH_QUERY_INVALID'
            ? 'errors.searchQueryInvalid'
            : searchFailure ? 'errors.searchIndexNotReady' : 'errors.load')}
        </Notice>
      </main>
    );
  }

  const statuses: StatusFilter[] = ['all', 'draft', 'published', 'trash'];
  const filtered = search !== '' || status !== 'all';
  const dialogOpen = deleteTarget !== null;

  return (
    <>
      <main
        id="studio-main-content"
        aria-labelledby="pages-title"
      >
        <PageHeader
          titleId="pages-title"
          kicker={t('list.kicker')}
          title={t('list.title')}
          description={t('list.description')}
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
                resetBulkContext();
              }}
            >
              <Field
                label={t('list.search')}
                labelHidden
                leading={<StudioIcon icon={Search} />}
              >
                {(control) => (
                  <input
                    {...control}
                    type="search"
                    maxLength={200}
                    value={searchInput}
                    placeholder={t('list.searchPlaceholder')}
                    onChange={(event) => setSearchInput(event.target.value)}
                  />
                )}
              </Field>
              <Button type="submit">{t('list.applySearch')}</Button>
            </form>

            <div className="content-list-create-action">
              <ButtonLink variant="primary" to={STUDIO_PATHS.newPage}>
                <StudioIcon icon={Plus} className="content-list-button-icon" />
                {t('list.create')}
              </ButtonLink>
            </div>
          </div>

          <FilterTabs
            label={t('list.statusFilterLabel')}
            value={status}
            appearance="underline"
            items={statuses.map((value) => ({
              value,
              label: t(`status.${value}`),
              count: loadState.statusCounts[value],
            }))}
            onChange={(value) => {
              setStatus(value);
              setPage(1);
              setCompletion(null);
              resetBulkContext();
            }}
          />
        </div>

        {completion ? (
          <Notice tone="success">
            {t('list.deleted', { title: completion })}
          </Notice>
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
            <ul className="content-list-bulk-results">
              {bulkCompletion.data.results.map((result) => (
                <li key={result.id}>
                  <Link to={studioPagePath(result.id)}>
                    {bulkCompletion.titles[result.id] ?? result.id}
                  </Link>
                  {': '}
                  {t(result.outcome === 'skipped'
                    ? `bulk.outcome.skipped.${result.reason}`
                    : `bulk.outcome.${result.outcome}`)}
                  {result.outcome === 'skipped'
                    && result.reason === 'front_page_protected' ? (
                      <>
                        {' '}
                        <Link to={STUDIO_PATHS.routingSettings}>
                          {t('bulk.openRoutingSettings')}
                        </Link>
                      </>
                    ) : null}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}

        {search ? (
          <p className="visually-hidden" role="status" aria-live="polite">
            {t('list.searchResultAnnouncement', {
              count: loadState.pagination.total,
            })}
          </p>
        ) : null}

        {loadState.items.length === 0 ? (
          <EmptyState
            announce={filtered}
            headingLevel={2}
            title={t(filtered ? 'list.emptyFilteredTitle' : 'list.emptyTitle')}
            description={t(filtered
              ? 'list.emptyFilteredDescription'
              : 'list.emptyDescription')}
          />
        ) : (
          <>
            {selectedIds.size > 0 ? (
              <div
                className="content-list-bulk-toolbar"
                role="region"
                aria-label={t('bulk.label')}
              >
                <strong>{t('bulk.selected', { count: selectedIds.size })}</strong>
                <div className="content-list-bulk-actions">
                  <Button type="button" size="sm" onClick={() => setBulkTarget('published')}>
                    {t('bulk.publish')}
                  </Button>
                  <Button type="button" size="sm" onClick={() => setBulkTarget('draft')}>
                    {t('bulk.draft')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    onClick={() => setBulkTarget('trash')}
                  >
                    {t('bulk.trash')}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={clearBulkSelection}>
                    {t('bulk.clear')}
                  </Button>
                </div>
              </div>
            ) : null}
            <DataTable
              caption={t('list.tableLabel')}
              minWidthPx={760}
              stacked="compact"
              framed
              selection={{
                label: t('bulk.selectPage', { count: CONTENT_BULK_LIFECYCLE_MAX_ITEMS }),
                checked: loadState.items.slice(0, CONTENT_BULK_LIFECYCLE_MAX_ITEMS)
                  .every((item) => selectedIds.has(item.id)),
                indeterminate: selectedIds.size > 0 && !loadState.items
                  .slice(0, CONTENT_BULK_LIFECYCLE_MAX_ITEMS)
                  .every((item) => selectedIds.has(item.id)),
                onChange: (checked) => setSelectedIds(checked
                  ? new Set(loadState.items.slice(0, CONTENT_BULK_LIFECYCLE_MAX_ITEMS)
                      .map((item) => item.id))
                  : new Set()),
              }}
            >
            <thead>
              <tr>
                <th scope="col" className="content-list-selection-cell">
                  <span className="visually-hidden">{t('bulk.select')}</span>
                </th>
                <th scope="col">{t('list.tableTitle')}</th>
                <th scope="col">{t('list.tableParent')}</th>
                <th scope="col">{t('list.tableStatus')}</th>
                <th scope="col">{t('list.tableUpdated')}</th>
                <th scope="col">{t('list.tableActions')}</th>
              </tr>
            </thead>
            <tbody>
              {loadState.items.map((item) => (
                <tr key={item.id}>
                  <td
                    data-label={t('bulk.select')}
                    data-stack="select"
                    className="content-list-selection-cell"
                  >
                    <input
                      type="checkbox"
                      aria-label={t('bulk.selectNamed', { title: item.title })}
                      checked={selectedIds.has(item.id)}
                      disabled={!selectedIds.has(item.id)
                        && selectedIds.size >= CONTENT_BULK_LIFECYCLE_MAX_ITEMS}
                      onChange={(event) => setSelectedIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(item.id);
                        else next.delete(item.id);
                        return next;
                      })}
                    />
                  </td>
                  <td data-label={t('list.tableTitle')} data-stack="primary">
                    <Link
                      className="content-list-title-link"
                      to={studioPagePath(item.id)}
                    >
                      <strong className="content-list-title">
                        {item.title}
                      </strong>
                      <span className="content-list-slug">{item.public_url}</span>
                    </Link>
                    {item.search_match ? (
                      <ContentSearchMatchContext
                        match={item.search_match}
                        label={t(`list.searchMatch.${item.search_match.field}`)}
                      />
                    ) : null}
                  </td>
                  <td data-label={t('list.tableParent')}>
                    {item.parent?.title ?? t('list.noParent')}
                  </td>
                  <td data-label={t('list.tableStatus')}>
                    <StatusPill tone={STATUS_TONE[item.status]}>
                      {t(`status.${item.status}`)}
                    </StatusPill>
                  </td>
                  <td data-label={t('list.tableUpdated')} data-stack="wide">
                    {dateFormatter.format(new Date(item.updated_at_iso))}
                  </td>
                  <td data-label={t('list.tableActions')} data-stack="actions">
                    <div className="content-list-row-actions">
                      <ActionMenu
                        label={t('list.actionMenuLabel', { title: item.title })}
                        items={[
                          {
                            id: 'edit',
                            kind: 'link',
                            label: t('list.edit'),
                            icon: Pencil,
                            to: studioPagePath(item.id),
                          },
                          ...(item.status === 'trash' ? [{
                            id: 'delete',
                            kind: 'button' as const,
                            label: t('list.deletePermanently'),
                            icon: Trash2,
                            tone: 'critical' as const,
                            onSelect: () => {
                              setFailure(null);
                              setDeleteTarget(item);
                            },
                          }] : []),
                        ]}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            </DataTable>
          </>
        )}

        {loadState.pagination.total_pages > 1 ? (
          <Pagination
            label={t('list.paginationLabel')}
            position={t('list.pagePosition', {
              page: loadState.pagination.page,
              pages: loadState.pagination.total_pages,
            })}
            previousLabel={t('list.previous')}
            nextLabel={t('list.next')}
            page={loadState.pagination.page}
            totalPages={loadState.pagination.total_pages}
            onChange={(value) => {
              setPage(value);
              resetBulkContext();
            }}
          />
        ) : null}
      </main>

      <Dialog
        open={dialogOpen}
        onClose={closeDelete}
        busy={deleting}
        kicker={t('delete.kicker')}
        title={t('delete.title', { title: deleteTarget?.title ?? '' })}
        description={t('delete.description')}
        initialFocusRef={cancelRef}
        actions={(
          <>
            <Button
              ref={cancelRef}
              type="button"
              disabled={deleting}
              onClick={closeDelete}
            >
              {t('delete.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              {deleting ? t('delete.running') : t('delete.confirm')}
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

      <Dialog
        open={bulkTarget !== null}
        onClose={() => {
          if (!bulkRunning) {
            setBulkTarget(null);
            setBulkFailure(null);
          }
        }}
        busy={bulkRunning}
        kicker={t('bulk.dialogKicker')}
        title={t(`bulk.dialog.${bulkTarget ?? 'draft'}.title`, {
          count: selectedIds.size,
        })}
        description={t(`bulk.dialog.${bulkTarget ?? 'draft'}.description`)}
        initialFocusRef={cancelRef}
        actions={(
          <>
            <Button
              ref={cancelRef}
              type="button"
              disabled={bulkRunning}
              onClick={() => {
                setBulkTarget(null);
                setBulkFailure(null);
              }}
            >
              {t('bulk.cancel')}
            </Button>
            <Button
              type="button"
              variant={bulkTarget === 'trash' ? 'danger' : 'primary'}
              disabled={bulkRunning}
              onClick={() => void confirmBulkLifecycle()}
            >
              {bulkRunning ? t('bulk.running') : t('bulk.confirm')}
            </Button>
          </>
        )}
      >
        {bulkFailure ? (
          <div className="content-list-dialog-notice">
            <Notice tone="error">{failureMessage(bulkFailure)}</Notice>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

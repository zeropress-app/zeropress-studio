import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { Folder, Link2, Pencil, Plus, RefreshCw, Save, Search, Tags, Trash2, Type } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import type { ApiErrorCode } from '../../contracts/api';
import {
  TAXONOMIES_DEFAULT_PAGE_SIZE,
  suggestTaxonomySlug,
  taxonomySlugInputSchema,
  taxonomyTermDescriptionInputSchema,
  taxonomyTermNameInputSchema,
  type TaxonomyKind,
  type TaxonomyListItem,
  type TaxonomyListSummary,
} from '../../contracts/taxonomies';
import {
  requestCreateTaxonomyTerm,
  requestDeleteTaxonomyTerm,
  requestTaxonomyTerms,
  requestUpdateTaxonomyTerm,
  TaxonomiesClientError,
} from './lib/taxonomies-client';
import {
  ActionMenu,
  Button,
  DataTable,
  Dialog,
  DialogActions,
  EmptyState,
  Field,
  InlineStatus,
  Notice,
  PageHeader,
  Pagination,
  StudioIcon,
  Tabs as StudioTabs,
  useStudioToast,
} from './components/primitives';

type AccountSession = {
  csrf_token: string;
};

type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      terms: TaxonomyListItem[];
      pagination: {
        page: number;
        per_page: number;
        total: number;
        total_pages: number;
      };
    }
  | { kind: 'error' };

type TaxonomyAction =
  | { kind: 'create' }
  | { kind: 'edit'; term: TaxonomyListItem }
  | { kind: 'delete'; term: TaxonomyListItem };

type Failure =
  | { kind: 'validation'; field: 'name' | 'slug' | 'description' }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' };

type Completion = {
  kind: 'created' | 'updated' | 'deleted';
  name: string;
};

function titleKey(
  action: 'create' | 'edit' | 'delete',
  taxonomy: TaxonomyKind,
) {
  const type = taxonomy === 'category' ? 'Category' : 'Tag';
  return `dialog.${action}${type}Title` as const;
}

export function TaxonomyPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('taxonomies');
  const [taxonomy, setTaxonomy] = useState<TaxonomyKind>('category');
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [summary, setSummary] = useState<TaxonomyListSummary | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<TaxonomyAction | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState('');
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const runningRef = useRef(running);
  runningRef.current = running;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    { dateStyle: 'medium', timeStyle: 'short' },
  ), [i18n.resolvedLanguage]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(i18n.resolvedLanguage),
    [i18n.resolvedLanguage]);

  useStudioDocumentTitle(t('documentTitle'));
  useStudioToast({
    id: 'taxonomy-completion',
    tone: 'success',
    message: completion && completion.kind !== 'deleted'
      ? t(`completion.${completion.kind}`, { name: completion.name })
      : null,
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    void requestTaxonomyTerms(taxonomy, {
      search,
      page,
      per_page: TAXONOMIES_DEFAULT_PAGE_SIZE,
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
        terms: response.data.items,
        pagination: response.data.pagination,
      });
      setSummary(response.data.summary);
    }).catch(() => {
      if (active && !controller.signal.aborted) {
        setLoadState({ kind: 'error' });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [input.onSessionEnded, loadAttempt, page, search, taxonomy]);

  function changeTaxonomy(next: TaxonomyKind) {
    if (next === taxonomy) return;
    setLoadState({ kind: 'loading' });
    setTaxonomy(next);
    setSearchInput('');
    setSearch('');
    setPage(1);
    setAction(null);
    setFailure(null);
    setCompletion(null);
  }

  function openCreate() {
    setAction({ kind: 'create' });
    setName('');
    setSlug('');
    setSlugEdited(false);
    setDescription('');
    setFailure(null);
    setCompletion(null);
  }

  function openEdit(term: TaxonomyListItem) {
    setAction({ kind: 'edit', term });
    setName(term.name);
    setSlug(term.slug);
    setSlugEdited(true);
    setDescription(term.description);
    setFailure(null);
    setCompletion(null);
  }

  function openDelete(term: TaxonomyListItem) {
    setAction({ kind: 'delete', term });
    setFailure(null);
    setCompletion(null);
  }

  function closeAction() {
    if (runningRef.current) return;
    setAction(null);
    setFailure(null);
  }

  function handleName(value: string) {
    setName(value);
    if (action?.kind === 'create' && !slugEdited) {
      setSlug(suggestTaxonomySlug(value));
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
    if (current.code === 'TAXONOMY_SLUG_CONFLICT') {
      return t('errors.slugConflict');
    }
    if (current.code === 'TAXONOMY_TERM_NOT_FOUND') {
      return t('errors.notFound');
    }
    if (current.code === 'TAXONOMY_REVISION_CONFLICT') {
      return t('errors.revisionConflict');
    }
    if (current.code === 'TAXONOMY_TERM_IN_USE') return t('errors.inUse');
    if (current.code === 'FORBIDDEN') return t('errors.forbidden');
    return t('errors.api');
  }

  async function submitTerm(event: FormEvent) {
    event.preventDefault();
    if (!action || action.kind === 'delete') return;
    const parsedName = taxonomyTermNameInputSchema.safeParse(name);
    if (!parsedName.success) {
      setFailure({ kind: 'validation', field: 'name' });
      return;
    }
    const parsedSlug = taxonomySlugInputSchema.safeParse(slug);
    if (!parsedSlug.success) {
      setFailure({ kind: 'validation', field: 'slug' });
      return;
    }
    const parsedDescription = taxonomyTermDescriptionInputSchema
      .safeParse(description);
    if (!parsedDescription.success) {
      setFailure({ kind: 'validation', field: 'description' });
      return;
    }
    setRunning(true);
    setFailure(null);
    try {
      const authored = {
        name: parsedName.data,
        slug: parsedSlug.data,
        description: parsedDescription.data,
      };
      const response = action.kind === 'create'
        ? await requestCreateTaxonomyTerm(
            input.data.csrf_token,
            taxonomy,
            authored,
          )
        : await requestUpdateTaxonomyTerm(
            input.data.csrf_token,
            taxonomy,
            action.term.id,
            {
              ...authored,
              expected_revision: action.term.revision,
            },
          );
      if (!response.success) {
        handleApiFailure(response.error.code);
        return;
      }
      setCompletion({
        kind: action.kind === 'create' ? 'created' : 'updated',
        name: response.data.name,
      });
      setAction(null);
      setLoadAttempt((value) => value + 1);
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof TaxonomiesClientError
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
      const response = await requestDeleteTaxonomyTerm(
        input.data.csrf_token,
        taxonomy,
        action.term.id,
        { expected_revision: action.term.revision },
      );
      if (!response.success) {
        handleApiFailure(response.error.code);
        return;
      }
      setCompletion({ kind: 'deleted', name: action.term.name });
      setAction(null);
      if (loadState.kind === 'ready' && loadState.terms.length === 1 && page > 1) {
        setPage((value) => value - 1);
      } else {
        setLoadAttempt((value) => value + 1);
      }
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof TaxonomiesClientError
          ? error.code
          : 'INVALID_RESPONSE',
      });
    } finally {
      setRunning(false);
    }
  }

  const isCategory = taxonomy === 'category';
  const isFiltered = search.length > 0;
  const currentSlug = taxonomySlugInputSchema.safeParse(slug);
  const unchanged = action?.kind === 'edit'
    && name.trim() === action.term.name
    && currentSlug.success && currentSlug.data === action.term.slug
    && description.trim() === action.term.description;

  return (
    <main
      id="studio-main-content"
      aria-labelledby="taxonomy-title"
    >
      <PageHeader
        titleId="taxonomy-title"
        kicker={t('kicker')}
        title={t('title')}
        description={t('description')}
      />

      <StudioTabs
        label={t('tabs.label')}
        value={taxonomy}
        items={[
          {
            value: 'category', label: t('tabs.category'), icon: Folder,
            count: summary ? numberFormatter.format(summary.categories) : undefined,
          },
          {
            value: 'tag', label: t('tabs.tag'), icon: Tags,
            count: summary ? numberFormatter.format(summary.tags) : undefined,
          },
        ]}
        disabled={running}
        onChange={changeTaxonomy}
      >
        <div className="content-list-toolbar content-list-toolbar-editorial">
          <div className="content-list-toolbar-controls">
            <form
              className="content-list-search"
              role="search"
              aria-label={t(`filters.${taxonomy}`)}
              onSubmit={(event) => {
                event.preventDefault();
                const nextSearch = searchInput.trim();
                setLoadState({ kind: 'loading' });
                if (page === 1 && nextSearch === search) {
                  setLoadAttempt((value) => value + 1);
                }
                setPage(1);
                setSearch(nextSearch);
              }}
            >
              <Field
                label={t(`filters.${taxonomy}`)}
                labelHidden
                leading={<StudioIcon icon={Search} />}
              >
                {(control) => (
                  <input
                    {...control}
                    type="search"
                    maxLength={200}
                    value={searchInput}
                    disabled={running}
                    placeholder={t(`filters.${taxonomy}`)}
                    onChange={(event) => setSearchInput(event.target.value)}
                  />
                )}
              </Field>
              <Button type="submit" disabled={running}>{t('filters.apply')}</Button>
            </form>
            <div className="content-list-create-action">
              <Button
                type="button"
                variant="primary"
                onClick={openCreate}
                disabled={running || loadState.kind !== 'ready'}
              >
                <StudioIcon icon={Plus} className="content-list-button-icon" />
                {t(`create.${taxonomy}`)}
              </Button>
            </div>
          </div>
          {isFiltered && loadState.kind === 'ready' ? (
            <p className="content-list-summary" role="status">
              {t('summary.results', { value: numberFormatter.format(loadState.pagination.total) })}
            </p>
          ) : null}
        </div>

        {completion?.kind === 'deleted' ? (
          <div className="content-list-message">
            <Notice tone="success">{t('completion.deleted', { name: completion.name })}</Notice>
          </div>
        ) : null}

        <div className="taxonomy-results" aria-busy={loadState.kind === 'loading'}>
          {loadState.kind === 'loading' ? <InlineStatus>{t('loading')}</InlineStatus>
          : loadState.kind === 'error' ? (
            <Notice
              tone="error"
              actions={(
                <Button type="button" onClick={() => setLoadAttempt((value) => value + 1)}>
                  <StudioIcon icon={RefreshCw} className="content-list-button-icon" />
                  {t('retry')}
                </Button>
              )}
            >
              {t('errors.load')}
            </Notice>
          ) : loadState.terms.length === 0 ? (
            <EmptyState
              headingLevel={2}
              announce={isFiltered}
              title={t(isFiltered
                ? 'empty.filteredTitle'
                : isCategory ? 'empty.categoryTitle' : 'empty.tagTitle')}
              description={t(isFiltered
                ? 'empty.filteredDescription'
                : isCategory
                  ? 'empty.categoryDescription'
                  : 'empty.tagDescription')}
            />
          ) : (
            <>
              <p id="taxonomy-post-count-hint" className="visually-hidden">{t('table.postsHint')}</p>
              <DataTable
                caption={t(isCategory ? 'table.categoryLabel' : 'table.tagLabel')}
                minWidthPx={820}
                stacked="compact"
                framed
              >
                <colgroup>
                  <col style={{ width: '27%' }} />
                  <col style={{ width: '33%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '23%' }} />
                  <col style={{ width: '5%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">{t('table.name')}</th>
                    <th scope="col">{t('table.description')}</th>
                    <th scope="col" aria-describedby="taxonomy-post-count-hint">{t('table.posts')}</th>
                    <th scope="col">{t('table.updated')}</th>
                    <th scope="col">{t('table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {loadState.terms.map((term) => (
                    <tr key={term.id}>
                      <td data-label={t('table.name')} data-stack="primary">
                        <div className="taxonomy-identity">
                          <Button
                            type="button"
                            variant="text"
                            aria-label={t('actions.editNamed', { name: term.name })}
                            onClick={() => openEdit(term)}
                            disabled={running}
                          >
                            {term.name}
                          </Button>
                          <code className="content-list-slug">{term.slug}</code>
                        </div>
                      </td>
                      <td data-label={t('table.description')} data-stack="wide">
                        <span
                          className={term.description
                            ? 'taxonomy-description'
                            : 'content-list-placeholder'}
                        >
                          {term.description || t('table.noDescription')}
                        </span>
                      </td>
                      <td data-label={t('table.posts')}>
                        <span className="taxonomy-post-count">
                          {numberFormatter.format(term.post_count)}
                        </span>
                      </td>
                      <td data-label={t('table.updated')}>
                        <time dateTime={term.updated_at_iso}>
                          {dateFormatter.format(new Date(term.updated_at_iso))}
                        </time>
                      </td>
                      <td data-label={t('table.actions')} data-stack="actions">
                        <div className="content-list-row-actions">
                          <ActionMenu
                            label={t('actions.menuLabel', { name: term.name })}
                            disabled={running}
                            items={[
                              {
                                id: 'edit', kind: 'button', label: t('actions.edit'), icon: Pencil,
                                onSelect: () => openEdit(term),
                              },
                              {
                                id: 'delete', kind: 'button', label: t('actions.delete'),
                                icon: Trash2, tone: 'critical', onSelect: () => openDelete(term),
                              },
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
        </div>

        {loadState.kind === 'ready' && loadState.pagination.total_pages > 1 ? (
          <div className="content-list-pagination">
            <Pagination
              label={t(isCategory
                ? 'pagination.categoryLabel'
                : 'pagination.tagLabel')}
              position={t('pagination.position', {
                page: loadState.pagination.page,
                pages: loadState.pagination.total_pages,
              })}
              previousLabel={t('pagination.previous')}
              nextLabel={t('pagination.next')}
              page={page}
              totalPages={loadState.pagination.total_pages}
              onChange={(nextPage) => {
                setLoadState({ kind: 'loading' });
                setPage(nextPage);
              }}
            />
          </div>
        ) : null}
      </StudioTabs>

      {action?.kind === 'delete' ? (
        <Dialog
          open
          busy={running}
          onClose={closeAction}
          title={t(titleKey('delete', taxonomy), { name: action.term.name })}
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
                <StudioIcon icon={Trash2} className="content-list-button-icon" />
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
          title={t(titleKey(action.kind, taxonomy))}
          description={t(action.kind === 'create'
            ? 'dialog.createDescription'
            : 'dialog.editDescription')}
          initialFocusRef={nameRef}
        >
          <form className="content-list-dialog-form" onSubmit={submitTerm}>
            <Field label={t('dialog.name')} leading={<StudioIcon icon={Type} />}>
              {(control) => (
                <input
                  {...control}
                  ref={nameRef}
                  type="text"
                  maxLength={200}
                  value={name}
                  required
                  disabled={running}
                  onChange={(event) => handleName(event.target.value)}
                />
              )}
            </Field>
            <Field
              label={t('dialog.slug')}
              hint={t('dialog.slugHint')}
              leading={<StudioIcon icon={Link2} />}
            >
              {(control) => (
                <input
                  {...control}
                  type="text"
                  maxLength={400}
                  value={slug}
                  required
                  disabled={running}
                  onChange={(event) => {
                    setSlug(event.target.value);
                    setSlugEdited(true);
                  }}
                />
              )}
            </Field>
            <Field
              label={t('dialog.description')}
              hint={t('dialog.descriptionHint')}
            >
              {(control) => (
                <textarea
                  {...control}
                  maxLength={10_000}
                  rows={3}
                  value={description}
                  disabled={running}
                  onChange={(event) => setDescription(event.target.value)}
                />
              )}
            </Field>
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
              <Button
                type="submit"
                variant="primary"
                disabled={running || unchanged || !name.trim() || !slug.trim()}
              >
                <StudioIcon
                  icon={action.kind === 'create' ? Plus : Save}
                  className="content-list-button-icon"
                />
                {running
                  ? t('dialog.running')
                  : action.kind === 'create'
                    ? t(isCategory
                        ? 'dialog.confirmCreateCategory'
                        : 'dialog.confirmCreateTag')
                    : t('dialog.confirmEdit')}
              </Button>
            </DialogActions>
          </form>
        </Dialog>
      ) : null}
    </main>
  );
}

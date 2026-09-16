import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Check, RefreshCw, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MenuReferenceKind, MenuReferenceSummary } from '../../../contracts/menus';
import {
  MenuReferenceSearchError, requestMenuReferenceSearch,
  type MenuReferenceSearchQuery, type MenuReferenceSearchResult,
} from '../lib/menu-reference-search';
import {
  Button, DataTable, EmptyState, Field, InlineStatus,
  Notice, Pagination, StatusPill, StudioIcon,
} from './primitives';

type LoadState =
  | { kind: 'loading'; scope: string }
  | { kind: 'ready'; scope: string; result: MenuReferenceSearchResult }
  | { kind: 'error'; scope: string; code: MenuReferenceSearchError['code'] };

/** One view inside MenuItemEditorDialog, not a second modal or a persistence boundary. */
export function MenuReferencePicker(input: {
  kind: MenuReferenceKind;
  selectedId: string;
  onSelect: (reference: MenuReferenceSummary) => void;
  onBack: () => void;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('menus');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState<Omit<MenuReferenceSearchQuery, 'kind'>>({
    search: '', page: 1, status: 'published',
  });
  const [attempt, setAttempt] = useState(0);
  const scope = JSON.stringify([input.kind, query, attempt]);
  const [load, setLoad] = useState<LoadState>({ kind: 'loading', scope });
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const sessionEnded = useRef(input.onSessionEnded);
  sessionEnded.current = input.onSessionEnded;
  const hasStatus = input.kind === 'post' || input.kind === 'page';

  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ kind: 'loading', scope });
    void requestMenuReferenceSearch({ ...query, kind: input.kind }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setLoad({ kind: 'ready', scope, result });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        const code = cause instanceof MenuReferenceSearchError ? cause.code : 'NETWORK_ERROR';
        if (code === 'AUTHENTICATION_REQUIRED') sessionEnded.current();
        setLoad({ kind: 'error', scope, code });
      });
    return () => controller.abort();
  }, [input.kind, query, attempt, scope]);

  function search(event: FormEvent) {
    event.preventDefault();
    setQuery((current) => ({ ...current, search: searchInput.trim(), page: 1 }));
  }

  const current = load.scope === scope ? load : { kind: 'loading' as const, scope };
  const number = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage).format(value);
  const errorKey = current.kind !== 'error' ? 'network'
    : current.code === 'CONTENT_SEARCH_QUERY_INVALID' ? 'query'
      : current.code === 'CONTENT_SEARCH_INDEX_NOT_READY' ? 'unavailable'
        : current.code === 'FORBIDDEN' || current.code === 'AUTHENTICATION_REQUIRED' ? 'forbidden'
          : current.code === 'TIMEOUT' ? 'timeout'
            : current.code === 'INVALID_RESPONSE' ? 'invalidResponse'
              : current.code === 'NETWORK_ERROR' ? 'network' : 'api';

  return (
    <div className="navigation-picker">
      <div className="navigation-picker-back">
        <Button type="button" size="sm" onClick={input.onBack}>
          <StudioIcon icon={ArrowLeft} className="navigation-icon" />{t('picker.back')}
        </Button>
      </div>
      <form className="navigation-picker-filters" data-with-status={hasStatus || undefined}
        role="search" aria-label={t('picker.search')} onSubmit={search}>
        <Field label={t('picker.search')} leading={<StudioIcon icon={Search} />}>
          {(control) => <input {...control} ref={searchRef} type="search" value={searchInput}
            maxLength={200} onChange={(event) => setSearchInput(event.target.value)} />}
        </Field>
        {hasStatus && (
          <Field label={t('picker.status')}>
            {(control) => <select {...control} value={query.status} onChange={(event) => {
              const status = event.target.value === 'draft' ? 'draft' : 'published';
              setQuery((currentQuery) => ({ ...currentQuery, status, page: 1 }));
            }}>
              <option value="published">{t('picker.published')}</option>
              <option value="draft">{t('picker.draft')}</option>
            </select>}
          </Field>
        )}
        <Button type="submit"><StudioIcon icon={Search} className="navigation-icon" />{t('picker.search')}</Button>
      </form>
      <div ref={resultsRef} tabIndex={-1} className="navigation-picker-results" aria-label={t('picker.results')}>
        {current.kind === 'loading' ? <InlineStatus>{t('picker.loading')}</InlineStatus>
          : current.kind === 'error' ? (
            <Notice tone="error">
              <p>{t(`picker.errors.${errorKey}`)}</p>
              <Button type="button" onClick={() => setAttempt((value) => value + 1)}>
                <StudioIcon icon={RefreshCw} className="navigation-icon" />{t('picker.retry')}
              </Button>
            </Notice>
          ) : (
            <>
              <p className="navigation-help" role="status">
                {t('picker.resultCount', { count: current.result.pagination.total, formattedCount: number(current.result.pagination.total) })}
              </p>
              {current.result.items.length === 0 ? (
                <EmptyState title={t('picker.empty')} description={t('picker.emptyHelp')} />
              ) : (
                <DataTable caption={t('picker.results')} stacked="compact" framed>
                  <thead><tr>
                    <th scope="col">{t('item.title')}</th>
                    {hasStatus && <th scope="col">{t('picker.status')}</th>}
                    <th scope="col">{t('picker.actions')}</th>
                  </tr></thead>
                  <tbody>{current.result.items.map(({ reference, status }) => (
                    <tr key={reference.reference_id}>
                      <td data-label={t('item.title')} data-stack="primary">
                        <span className="navigation-reference-title">{reference.title}</span>
                        <span className="navigation-reference-detail">{reference.detail}</span>
                        {reference.reference_id === input.selectedId && <StatusPill tone="neutral">{t('picker.selected')}</StatusPill>}
                      </td>
                      {hasStatus && <td data-label={t('picker.status')}>
                        <StatusPill tone={status === 'published' ? 'positive' : 'neutral'}>{t(status === 'published' ? 'picker.published' : 'picker.draft')}</StatusPill>
                      </td>}
                      <td data-label={t('picker.actions')} data-stack="wide">
                        <Button type="button" size="sm" aria-label={t('picker.selectNamed', { name: reference.title })}
                          onClick={() => input.onSelect(reference)}>
                          <StudioIcon icon={Check} className="navigation-icon" />{t('picker.select')}
                        </Button>
                      </td>
                    </tr>
                  ))}</tbody>
                </DataTable>
              )}
              {current.result.pagination.total_pages > 1 && <Pagination
                label={t('picker.pagination')}
                position={t('picker.position', { page: number(query.page), total: number(current.result.pagination.total_pages) })}
                previousLabel={t('picker.previous')} nextLabel={t('picker.next')}
                page={query.page} totalPages={current.result.pagination.total_pages}
                onChange={(page) => {
                  resultsRef.current?.focus();
                  setQuery((currentQuery) => ({ ...currentQuery, page }));
                }} />}
            </>
          )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollText, RefreshCw } from 'lucide-react';
import { AUDIT_CATEGORIES, AUDIT_OUTCOMES, type AuditLog, type AuditLogDetail, type AuditLogQuery } from '../../contracts/audit-logs';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import { requestAuditLog, requestAuditLogs } from './lib/audit-client';
import { Button, DataTable, Dialog, EmptyState, Field, InlineStatus, Notice, PageHeader, Panel, StatusPill, StudioIcon } from './components/primitives';
import './screens/audit-log.css';
const emptyFilters = { from: '', to: '', actor: '', category: '', outcome: '', ip_hash: '' };
export function AuditLogPage({ onSessionEnded }: { onSessionEnded: () => void }) {
  const { t, i18n } = useTranslation('auditLog');
  useStudioDocumentTitle(t('title'));
  const [filters, setFilters] = useState(emptyFilters);
  const [query, setQuery] = useState<AuditLogQuery>({});
  const [attempt, setAttempt] = useState(0);
  const [items, setItems] = useState<AuditLog[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditLogDetail | null>(null);
  const [detailError, setDetailError] = useState(false);
  const [detailAttempt, setDetailAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLoading(true); setError(false);
    if (!query.cursor) setItems([]);
    void requestAuditLogs(query, controller.signal).then((result) => {
      if (!active) return;
      if (result.success) {
        setItems((previous) => query.cursor ? [...previous, ...result.data.items] : result.data.items);
        setNext(result.data.next_cursor);
      } else if (result.error.code === 'AUTHENTICATION_REQUIRED') onSessionEnded();
      else setError(true);
    }).catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [query, attempt, onSessionEnded]);
  useEffect(() => {
    setDetail(null); setDetailError(false);
    if (!selected) return;
    const controller = new AbortController(); let active = true;
    void requestAuditLog(selected, controller.signal).then((result) => {
      if (!active) return;
      if (result.success) setDetail(result.data);
      else if (result.error.code === 'AUTHENTICATION_REQUIRED') onSessionEnded();
      else setDetailError(true);
    }).catch(() => { if (active) setDetailError(true); });
    return () => { active = false; controller.abort(); };
  }, [selected, detailAttempt, onSessionEnded]);
  const date = (value: string) => new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  const actor = (value: AuditLog['actor']) => value.kind === 'operations' ? t('operationsToken') : value.name || value.email || value.id || t('unavailable');
  const refresh = () => { setQuery(({ cursor: _cursor, ...rest }) => rest); setAttempt((value) => value + 1); };
  const apply = () => {
    const from = filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : undefined;
    const to = filters.to ? new Date(`${filters.to}T23:59:59.999`).toISOString() : undefined;
    setQuery({ from, to, actor: filters.actor || undefined,
      category: filters.category as AuditLogQuery['category'] || undefined,
      outcome: filters.outcome as AuditLogQuery['outcome'] || undefined, ip_hash: filters.ip_hash || undefined });
  };
  return <div className="audit-log-page">
    <PageHeader titleId="audit-log-title" title={t('title')} description={t('retention')} actions={
      <Button type="button" onClick={refresh} disabled={loading}><StudioIcon icon={RefreshCw} />{t('refresh')}</Button>
    } />
    <Panel title={t('filters')} leading={<StudioIcon icon={ScrollText} />}>
      <form className="audit-log-filters" onSubmit={(event) => { event.preventDefault(); apply(); }}>
        {(['from', 'to'] as const).map((key) => <Field key={key} label={t(key)}>{(control) =>
          <input {...control} type="date" value={filters[key]} max={key === 'from' ? filters.to || undefined : undefined}
            min={key === 'to' ? filters.from || undefined : undefined} onChange={(event) => setFilters({ ...filters, [key]: event.target.value })} />
        }</Field>)}
        <Field label={t('actorSearch')}>{(control) => <input {...control} value={filters.actor} maxLength={200} onChange={(e) => setFilters({ ...filters, actor: e.target.value })} />}</Field>
        <Field label={t('category')}>{(control) => <select {...control} value={filters.category} onChange={(e) => setFilters({ ...filters, category: e.target.value })}>
          <option value="">{t('all')}</option>{AUDIT_CATEGORIES.map((v) => <option key={v} value={v}>{t(`categories.${v}`)}</option>)}
        </select>}</Field>
        <Field label={t('outcome')}>{(control) => <select {...control} value={filters.outcome} onChange={(e) => setFilters({ ...filters, outcome: e.target.value })}>
          <option value="">{t('all')}</option>{AUDIT_OUTCOMES.map((v) => <option key={v} value={v}>{t(`outcomes.${v}`)}</option>)}
        </select>}</Field>
        <div className="audit-log-buttons"><Button type="submit" disabled={loading}>{t('apply')}</Button>
          <Button type="button" variant="secondary" onClick={() => { setFilters(emptyFilters); setQuery({}); }}>{t('clear')}</Button></div>
      </form>
      {filters.ip_hash ? <p className="audit-log-hash">{t('sameIpActive')} <code>{filters.ip_hash}</code></p> : null}
    </Panel>
    <Panel flush>
      {error ? <Notice tone="error" title={t('loadError')}><Button type="button" onClick={() => setAttempt((v) => v + 1)}>{t('retry')}</Button></Notice> : null}
      {loading ? <InlineStatus>{t('loading')}</InlineStatus> : null}
      {!error && !loading && items.length === 0 ? <EmptyState title={t('empty')} /> : null}
      {items.length > 0 ? <DataTable caption={t('title')} minWidthPx={650}>
        <thead><tr>{(['time', 'actor', 'action', 'target', 'outcome'] as const).map((key) => <th key={key} scope="col">{t(key)}</th>)}</tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}>
          <td><Button type="button" variant="text" onClick={() => setSelected(item.id)} aria-label={`${t('details')}: ${date(item.occurred_at)}`}>{date(item.occurred_at)}</Button></td>
          <td>{actor(item.actor)}</td><td>{t(`actions.${item.action}`)}</td><td>{item.target.label || item.target.id || t(`categories.${item.category}`)}</td>
          <td><StatusPill tone={item.outcome === 'failed' ? 'critical' : item.outcome === 'success' ? 'positive' : 'neutral'}>{t(`outcomes.${item.outcome}`)}</StatusPill></td>
        </tr>)}</tbody>
      </DataTable> : null}
    </Panel>
    {next && !error ? <Button type="button" onClick={() => setQuery({ ...query, cursor: next })} disabled={loading}>{t('more')}</Button> : null}
    <Dialog open={selected !== null} onClose={() => setSelected(null)} title={t('details')} initialFocus="title" size="wide"
      actions={<Button type="button" variant="secondary" onClick={() => setSelected(null)}>{t('close')}</Button>}>
      {detailError ? <Notice tone="error" title={t('loadError')}><Button type="button" onClick={() => setDetailAttempt((v) => v + 1)}>{t('retry')}</Button></Notice> : !detail ? <InlineStatus>{t('loading')}</InlineStatus> : <>
        <dl className="audit-log-details">
          <dt>{t('time')}</dt><dd>{date(detail.occurred_at)}</dd>
          <dt>{t('actor')}</dt><dd>{actor(detail.actor)}{detail.actor.email && <div>{detail.actor.email}</div>}{detail.actor.id && <code>{detail.actor.id}</code>}</dd>
          <dt>{t('action')}</dt><dd>{t(`actions.${detail.action}`)}</dd>
          <dt>{t('target')}</dt><dd>{detail.target.label || detail.target.type}{detail.target.id && <div>{detail.target.id}</div>}</dd>
          <dt>{t('outcome')}</dt><dd>{t(`outcomes.${detail.outcome}`)}</dd>
          {Object.entries(detail.metadata).map(([key, value]) => <div className="audit-log-detail-row" key={key}><dt>{t(`metadata.${key as keyof typeof detail.metadata}`)}</dt><dd>{
            key === 'initiator' && typeof value === 'object' && !Array.isArray(value) ? `${value.name || value.email || value.id || t('operationsToken')}`
              : Array.isArray(value) ? value.map((entry) => typeof entry === 'string' ? entry : `${entry.field}: ${entry.action}`).join(', ') : String(value)
          }</dd></div>)}
          {Object.entries(detail.network).map(([key, value]) => <div className="audit-log-detail-row" key={key}><dt>{t(`network.${key as keyof typeof detail.network}`)}</dt><dd>{value === null ? t('unavailable') : key === 'ip_recorded_at' ? date(String(value)) : String(value)}</dd></div>)}
        </dl>
        {detail.network.ip_hash ? <Button type="button" onClick={() => {
          const ip_hash = detail.network.ip_hash!; setFilters({ ...emptyFilters, ip_hash }); setQuery({ ip_hash }); setSelected(null);
        }}>{t('sameIp')}</Button> : null}
      </>}
    </Dialog>
  </div>;
}

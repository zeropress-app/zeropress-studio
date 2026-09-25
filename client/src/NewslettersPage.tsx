import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  Eye,
  Mail,
  Settings2,
  Trash2,
  UserMinus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import type { ApiErrorCode } from '../../contracts/api';
import {
  NEWSLETTER_DEFAULT_PAGE_SIZE,
  NEWSLETTER_MAX_FIELDS,
  newsletterIdSchema,
  newsletterFieldInputSchema,
  type NewsletterField,
  type NewsletterFieldInput,
  type NewsletterDelivery,
  type NewsletterRuntime,
  type NewsletterSubscriptionDetail,
  type NewsletterSummary,
  type NewsletterSuppression,
} from '../../contracts/newsletters';
import type { CurrentSessionSuccess } from '../../contracts/session';
import {
  ActionMenu,
  Button,
  ButtonLink,
  DataTable,
  Dialog,
  EmptyState,
  Field,
  InlineStatus,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  StatusPill,
  StudioIcon,
  type StatusTone,
  Switch,
  SwitchGroup,
  Tabs,
} from './components/primitives';
import {
  NewslettersClientError,
  requestCreateNewsletterSuppression,
  requestDeleteNewsletterSubscription,
  requestDeleteNewsletterSuppression,
  requestNewsletterFields,
  requestNewsletterDeliveries,
  requestNewsletterRuntime,
  requestNewsletters,
  requestNewsletterSubscription,
  requestNewsletterSubscriptionsExport,
  requestNewsletterSubscriptions,
  requestNewsletterSuppressions,
  requestReplaceNewsletterFields,
  requestUnsubscribeNewsletterSubscription,
  requestUpdateNewsletter,
  requestUpdateNewsletterRuntime,
  type NewslettersClientErrorCode,
} from './lib/newsletters-client';
import { STUDIO_PATHS } from './routing/studio-routes';

type AccountSession = CurrentSessionSuccess['data'];
const DEFAULT_NEWSLETTER_SLUG = 'default';
const TABS = [
  'overview',
  'subscribers',
  'deliveries',
  'fields',
  'suppressions',
  'runtime',
] as const;
type Tab = typeof TABS[number];
const NEWSLETTER_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'url',
  'boolean',
  'select',
  'radio',
  'checkbox',
] as const;
/**
 * Map domain states to badge tones.
 *
 * Newsletters (active/archived), fields (active/disabled), and subscriptions
 * (pending/subscribed/unsubscribed) have different state sets but share presentation tones.
 */
const STATUS_TONE: Record<
  | NewsletterSummary['status']
  | NewsletterField['status']
  | 'pending' | 'subscribed' | 'unsubscribed',
  StatusTone
> = {
  active: 'positive',
  subscribed: 'positive',
  pending: 'attention',
  archived: 'neutral',
  disabled: 'neutral',
  unsubscribed: 'neutral',
};
const DELIVERY_STATUS_TONE: Record<NewsletterDelivery['status'], StatusTone> = {
  queued: 'attention',
  sent: 'positive',
  failed: 'critical',
  skipped: 'neutral',
};

type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: NewslettersClientErrorCode }
  | { kind: 'unexpected' };

function clientFailure(error: unknown): Failure {
  return error instanceof NewslettersClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

function useFailureMessage() {
  const { t } = useTranslation('newsletters');
  return (failure: Failure) => {
    if (failure.kind === 'client') {
      if (failure.code === 'TIMEOUT') return t('errors.timeout');
      if (failure.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (failure.kind === 'api') {
      if (failure.code === 'FORBIDDEN') return t('errors.forbidden');
      if (failure.code === 'NEWSLETTER_REVISION_CONFLICT') {
        return t('errors.conflict');
      }
      if (failure.code === 'NEWSLETTER_MAIL_NOT_CONFIGURED') {
        return t('errors.mailNotConfigured');
      }
      if (
        failure.code === 'NEWSLETTER_NOT_FOUND'
        || failure.code === 'NEWSLETTER_SUBSCRIPTION_NOT_FOUND'
        || failure.code === 'NEWSLETTER_SUPPRESSION_NOT_FOUND'
      ) return t('errors.notFound');
      if (failure.code === 'VALIDATION_ERROR') return t('errors.validation');
    }
    return t('errors.api');
  };
}

function ErrorNotice(input: { failure: Failure | null }) {
  const message = useFailureMessage();
  return input.failure ? (
    <Notice tone="error">{message(input.failure)}</Notice>
  ) : null;
}

function NewsletterConfirmationDialog(input: {
  title: string;
  description: string;
  target: string;
  confirmLabel: string;
  cancelLabel: string;
  busy: boolean;
  failure: Failure | null;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      onClose={input.onClose}
      busy={input.busy}
      title={input.title}
      description={input.description}
      initialFocusRef={cancelRef}
      actions={(
        <>
          <Button
            ref={cancelRef}
            type="button"
            disabled={input.busy}
            onClick={input.onClose}
          >
            {input.cancelLabel}
          </Button>
          <Button
            type="button"
            variant={input.danger ? 'danger' : 'primary'}
            disabled={input.busy}
            onClick={input.onConfirm}
          >
            {input.confirmLabel}
          </Button>
        </>
      )}
    >
      <div className="newsletter-dialog-body">
        <code className="newsletter-dialog-target">{input.target}</code>
        <ErrorNotice failure={input.failure} />
      </div>
    </Dialog>
  );
}

function OverviewPanel(input: {
  newsletter: NewsletterSummary;
  csrfToken: string;
  onSessionEnded: () => void;
  onUpdated: (value: NewsletterSummary) => void;
}) {
  const { t, i18n } = useTranslation('newsletters');
  const [title, setTitle] = useState(input.newsletter.title);
  const [description, setDescription] = useState(
    input.newsletter.description ?? '',
  );
  const [status, setStatus] = useState(input.newsletter.status);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    setTitle(input.newsletter.title);
    setDescription(input.newsletter.description ?? '');
    setStatus(input.newsletter.status);
    setSaved(false);
    setFailure(null);
  }, [input.newsletter]);
  const changed = title.trim() !== input.newsletter.title
    || description.trim() !== (input.newsletter.description ?? '')
    || status !== input.newsletter.status;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!changed || !title.trim() || saving) return;
    setSaving(true);
    setSaved(false);
    setFailure(null);
    try {
      const response = await requestUpdateNewsletter(
        input.csrfToken,
        input.newsletter.id,
        {
          title,
          description: description.trim() || null,
          status,
          expected_updated_at_iso: input.newsletter.updated_at_iso,
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
      input.onUpdated(response.data);
      setSaved(true);
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setSaving(false);
    }
  }

  const formatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (
    <form onSubmit={(event) => void save(event)}>
      <Panel
        title={t('overview.title')}
        description={t('overview.description')}
        actions={(
          <StatusPill tone={STATUS_TONE[input.newsletter.status]}>
            {t(`status.${input.newsletter.status}`)}
          </StatusPill>
        )}
        footer={(
          <>
            <span>
              {t('overview.updated', {
                date: formatter.format(
                  new Date(input.newsletter.updated_at_iso),
                ),
              })}
            </span>
            <Button
              type="submit"
              variant="primary"
              disabled={!changed || !title.trim() || saving}
            >
              {saving ? t('actions.saving') : t('actions.save')}
            </Button>
          </>
        )}
      >
        <div className="newsletter-stack">
          {saved ? (
            <Notice tone="success">{t('overview.saved')}</Notice>
          ) : null}
          <ErrorNotice failure={failure} />
          <SwitchGroup>
            <Switch
              label={t('overview.enableLabel')}
              description={t('overview.enableDescription')}
              checked={status === 'active'}
              disabled={saving}
              onChange={(enabled) => setStatus(enabled ? 'active' : 'archived')}
            />
          </SwitchGroup>
          <Field label={t('overview.fields.title')}>
            {(control) => (
              <input
                {...control}
                value={title}
                maxLength={200}
                disabled={saving}
                onChange={(event) => setTitle(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('overview.fields.description')}>
            {(control) => (
              <textarea
                {...control}
                rows={4}
                maxLength={2000}
                value={description}
                disabled={saving}
                onChange={(event) => setDescription(event.target.value)}
              />
            )}
          </Field>
        </div>
      </Panel>
    </form>
  );
}

function RuntimePanel(input: {
  runtime: NewsletterRuntime;
  csrfToken: string;
  onSessionEnded: () => void;
  onUpdated: (value: NewsletterRuntime) => void;
}) {
  const { t } = useTranslation('newsletters');
  const [enabled, setEnabled] = useState(input.runtime.confirmation_enabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    setEnabled(input.runtime.confirmation_enabled);
    setSaved(false);
    setFailure(null);
  }, [input.runtime]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (enabled === input.runtime.confirmation_enabled || saving) return;
    setSaving(true);
    setSaved(false);
    setFailure(null);
    try {
      const response = await requestUpdateNewsletterRuntime(
        input.csrfToken,
        {
          confirmation_enabled: enabled,
          expected_updated_at_iso: input.runtime.updated_at_iso,
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
      input.onUpdated(response.data);
      setSaved(true);
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      <Panel
        title={t('runtime.title')}
        description={t('runtime.description')}
        actions={(
          <StatusPill tone={input.runtime.ready ? 'positive' : 'neutral'}>
            {input.runtime.ready ? t('runtime.ready') : t('runtime.notReady')}
          </StatusPill>
        )}
        footer={(
          <>
            <span>{t('runtime.queueDescription')}</span>
            <Button
              type="submit"
              variant="primary"
              disabled={
                enabled === input.runtime.confirmation_enabled
                || saving
                || (enabled && !input.runtime.mail_configured)
              }
            >
              {saving ? t('actions.saving') : t('actions.save')}
            </Button>
          </>
        )}
      >
        <div className="newsletter-stack">
          {saved ? (
            <Notice tone="success">{t('runtime.saved')}</Notice>
          ) : null}
          <ErrorNotice failure={failure} />
          {!input.runtime.mail_configured ? (
            <Notice
              tone="warning"
              title={t('runtime.mailMissingTitle')}
              actions={(
                <ButtonLink size="sm" to={STUDIO_PATHS.mailSettings}>
                  {t('runtime.openMailSettings')}
                </ButtonLink>
              )}
            >
              {t('runtime.mailMissingDescription')}
            </Notice>
          ) : null}
          <SwitchGroup>
            <Switch
              label={t('runtime.enableLabel')}
              description={t('runtime.enableDescription')}
              checked={enabled}
              disabled={saving
                || (!input.runtime.mail_configured && !enabled)}
              onChange={setEnabled}
            />
          </SwitchGroup>
        </div>
      </Panel>
    </form>
  );
}

function FieldsPanel(input: {
  newsletter: NewsletterSummary;
  csrfToken: string;
  onSessionEnded: () => void;
  onNewsletterChanged: () => void;
}) {
  const { t } = useTranslation('newsletters');
  const [items, setItems] = useState<NewsletterFieldInput[]>([]);
  const [revision, setRevision] = useState(input.newsletter.updated_at_iso);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    void requestNewsletterFields(input.newsletter.id, controller.signal)
      .then((response) => {
        if (!response.success) {
          if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
          else setFailure({ kind: 'api', code: response.error.code });
          return;
        }
        setItems(response.data.items.map(({ newsletter_id: _newsletter, created_at_iso: _created, updated_at_iso: _updated, ...field }) => field));
        setRevision(response.data.newsletter_updated_at_iso);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setFailure(clientFailure(error));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [input.newsletter.id, input.onSessionEnded]);

  function edit(index: number, update: Partial<NewsletterFieldInput>) {
    setItems((current) => current.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...update } : field));
    setSaved(false);
  }
  function add() {
    setItems((current) => [...current, {
      field_key: `field_${current.length + 1}`,
      label: '',
      type: 'text',
      required: false,
      options: [],
      sort_order: current.length,
      status: 'active',
    }]);
    setSaved(false);
  }
  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    setItems((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next.map((field, sortOrder) => ({
        ...field,
        sort_order: sortOrder,
      }));
    });
    setSaved(false);
  }
  function removeDraft(index: number) {
    setItems((current) => current
      .filter((_field, fieldIndex) => fieldIndex !== index)
      .map((field, sortOrder) => ({ ...field, sort_order: sortOrder })));
    setSaved(false);
  }

  async function save() {
    const normalized = items.map((field, index) => ({ ...field, sort_order: index }));
    if (normalized.some((field) => !newsletterFieldInputSchema.safeParse(field).success) || saving) {
      setFailure({ kind: 'api', code: 'VALIDATION_ERROR' });
      return;
    }
    setSaving(true);
    setSaved(false);
    setFailure(null);
    try {
      const response = await requestReplaceNewsletterFields(
        input.csrfToken,
        input.newsletter.id,
        { fields: normalized, expected_updated_at_iso: revision },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setItems(response.data.items.map(({ newsletter_id: _newsletter, created_at_iso: _created, updated_at_iso: _updated, ...field }) => field));
      setRevision(response.data.newsletter_updated_at_iso);
      setSaved(true);
      input.onNewsletterChanged();
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Panel>
        <InlineStatus>{t('loading')}</InlineStatus>
      </Panel>
    );
  }
  return (
    <Panel
      title={t('fields.title')}
      description={t('fields.description')}
      actions={(
        <Button
          type="button"
          onClick={add}
          disabled={items.length >= NEWSLETTER_MAX_FIELDS || saving}
        >
          {t('fields.add')}
        </Button>
      )}
      footer={(
        <>
          <span>{t('fields.limit', { count: items.length })}</span>
          <Button
            type="button"
            variant="primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? t('actions.saving') : t('actions.save')}
          </Button>
        </>
      )}
    >
      <div className="newsletter-stack">
      {saved ? <Notice tone="success">{t('fields.saved')}</Notice> : null}
      <ErrorNotice failure={failure} />
      <div className="newsletter-field-list">
        <article
          className="newsletter-field-card"
          aria-labelledby="newsletter-system-email-field-name"
        >
          <header className="newsletter-field-card-heading">
            <div>
              <strong
                className="newsletter-field-name"
                id="newsletter-system-email-field-name"
              >
                {t('fields.systemEmailLabel')}
              </strong>
              <StatusPill tone="positive">
                {t('fields.protected')}
              </StatusPill>
              <StatusPill tone="positive">
                {t('status.active')}
              </StatusPill>
            </div>
          </header>
          <div className="newsletter-form-grid">
            <Field label={t('fields.key')}>
              {(control) => (
                <input {...control} value="email" readOnly />
              )}
            </Field>
            <Field label={t('fields.label')}>
              {(control) => (
                <input
                  {...control}
                  value={t('fields.systemEmailLabel')}
                  readOnly
                />
              )}
            </Field>
            <Field label={t('fields.type')}>
              {(control) => (
                <input
                  {...control}
                  value={t('fields.systemEmailType')}
                  readOnly
                />
              )}
            </Field>
            <Field label={t('fields.status')}>
              {(control) => (
                <input
                  {...control}
                  value={t('status.active')}
                  readOnly
                />
              )}
            </Field>
            <label className="newsletter-check">
              <input type="checkbox" checked disabled />
              <span>{t('fields.required')}</span>
            </label>
          </div>
        </article>
        {items.length === 0 ? (
          <EmptyState
            title={t('fields.emptyTitle')}
            description={t('fields.emptyDescription')}
          />
        ) : (
          <>
          {items.map((field, index) => {
            const usesOptions = field.type === 'select' || field.type === 'radio' || field.type === 'checkbox';
            return <article className="newsletter-field-card" key={field.id ?? `new-${index}`}>
              <header className="newsletter-field-card-heading">
                <div>
                  <strong className="newsletter-field-name">
                    {field.label || field.field_key || t('fields.untitled')}
                  </strong>
                  <StatusPill tone={STATUS_TONE[field.status]}>
                    {t(`status.${field.status}`)}
                  </StatusPill>
                </div>
                <div className="newsletter-field-order-actions">
                  <Button type="button" size="sm" onClick={() => move(index, -1)} disabled={saving || index === 0} aria-label={t('fields.moveUpLabel', { field: field.label || field.field_key || t('fields.untitled') })}>{t('fields.moveUp')}</Button>
                  <Button type="button" size="sm" onClick={() => move(index, 1)} disabled={saving || index === items.length - 1} aria-label={t('fields.moveDownLabel', { field: field.label || field.field_key || t('fields.untitled') })}>{t('fields.moveDown')}</Button>
                  {!field.id ? <Button type="button" size="sm" variant="danger" onClick={() => removeDraft(index)} disabled={saving}>{t('fields.removeDraft')}</Button> : null}
                </div>
              </header>
              <div className="newsletter-form-grid">
                <Field label={t('fields.key')}>{(control) => <input {...control} value={field.field_key} maxLength={64} onChange={(event) => edit(index, { field_key: event.target.value.toLowerCase() })} disabled={saving} />}</Field>
                <Field label={t('fields.label')}>{(control) => <input {...control} value={field.label} maxLength={200} onChange={(event) => edit(index, { label: event.target.value })} disabled={saving} />}</Field>
                <Field label={t('fields.type')}>{(control) => <select {...control} value={field.type} onChange={(event) => edit(index, { type: event.target.value as NewsletterField['type'], options: ['select', 'radio', 'checkbox'].includes(event.target.value) ? field.options : [] })} disabled={saving}>{NEWSLETTER_FIELD_TYPES.map((type) => <option value={type} key={type}>{t(`fieldType.${type}`)}</option>)}</select>}</Field>
                <Field label={t('fields.status')}>{(control) => <select {...control} value={field.status} onChange={(event) => edit(index, { status: event.target.value as NewsletterField['status'] })} disabled={saving}><option value="active">{t('status.active')}</option><option value="disabled">{t('status.disabled')}</option></select>}</Field>
                <label className="newsletter-check"><input type="checkbox" checked={field.required} onChange={(event) => edit(index, { required: event.target.checked })} disabled={saving} /><span>{t('fields.required')}</span></label>
                {usesOptions ? <div className="newsletter-field-wide"><Field label={t('fields.options')} hint={t('fields.optionsHelp')}>{(control) => <textarea {...control} rows={3} value={field.options.map((option) => `${option.value}|${option.label}`).join('\n')} onChange={(event) => edit(index, { options: event.target.value.split(/\r?\n/u).filter((line) => line.trim()).map((line) => { const [value, ...label] = line.split('|'); return { value: value.trim(), label: (label.join('|') || value).trim() }; }) })} disabled={saving} />}</Field></div> : null}
              </div>
            </article>;
          })}
          </>
        )}
      </div>
      </div>
    </Panel>
  );
}

function SubscribersPanel(input: {
  newsletter: NewsletterSummary;
  csrfToken: string;
  onSessionEnded: () => void;
  onNewsletterChanged: () => void;
}) {
  const { t, i18n } = useTranslation('newsletters');
  const [status, setStatus] = useState<'all' | 'pending' | 'subscribed' | 'unsubscribed'>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [rows, setRows] = useState<import('../../contracts/newsletters').NewsletterSubscription[]>([]);
  const [pagination, setPagination] = useState({ total: 0, total_pages: 0 });
  const [detail, setDetail] = useState<NewsletterSubscriptionDetail | null>(null);
  const [confirmation, setConfirmation] = useState<{
    kind: 'unsubscribe' | 'delete';
    id: string;
    email: string;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [exportResult, setExportResult] = useState<{
    rowCount: number;
    truncated: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const detailCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    void requestNewsletterSubscriptions(input.newsletter.id, {
      status,
      search,
      page,
      per_page: NEWSLETTER_DEFAULT_PAGE_SIZE,
    }, controller.signal).then((response) => {
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setRows(response.data.items);
      setPagination({ total: response.data.pagination.total, total_pages: response.data.pagination.total_pages });
    }).catch((error) => {
      if (!controller.signal.aborted) setFailure(clientFailure(error));
    });
    return () => controller.abort();
  }, [attempt, input.newsletter.id, input.onSessionEnded, page, search, status]);
  const formatter = useMemo(() => new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' }), [i18n.resolvedLanguage]);
  const exportDatesInvalid = Boolean(
    (exportFrom && exportTo && exportFrom > exportTo)
    || exportTo.startsWith('9999-'),
  );

  async function openDetail(id: string) {
    setBusy(id); setFailure(null);
    try {
      const response = await requestNewsletterSubscription(input.newsletter.id, id);
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
      } else setDetail(response.data);
    } catch (error) { setFailure(clientFailure(error)); } finally { setBusy(null); }
  }
  async function unsubscribe(id: string) {
    if (busy) return;
    setBusy(id); setFailure(null);
    try {
      const response = await requestUnsubscribeNewsletterSubscription(input.csrfToken, input.newsletter.id, id);
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
      } else { setConfirmation(null); setAttempt((value) => value + 1); input.onNewsletterChanged(); }
    } catch (error) { setFailure(clientFailure(error)); } finally { setBusy(null); }
  }
  async function remove(id: string) {
    if (busy) return;
    setBusy(id); setFailure(null);
    try {
      const response = await requestDeleteNewsletterSubscription(input.csrfToken, input.newsletter.id, id);
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
      } else { setConfirmation(null); setDetail(null); setAttempt((value) => value + 1); input.onNewsletterChanged(); }
    } catch (error) { setFailure(clientFailure(error)); } finally { setBusy(null); }
  }
  async function exportCsv() {
    if (exporting || exportDatesInvalid) return;
    setExporting(true);
    setExportResult(null);
    setFailure(null);
    try {
      const response = await requestNewsletterSubscriptionsExport(
        input.newsletter.id,
        {
          status,
          ...(exportFrom ? { from: exportFrom } : {}),
          ...(exportTo ? { to: exportTo } : {}),
        },
      );
      if ('success' in response) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
        } else {
          setFailure({ kind: 'api', code: response.error.code });
        }
        return;
      }
      const url = URL.createObjectURL(response.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = response.filename;
      link.click();
      URL.revokeObjectURL(url);
      setExportResult({
        rowCount: response.row_count,
        truncated: response.truncated,
      });
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setExporting(false);
    }
  }
  return <Panel
    title={t('subscribers.title')}
    description={t('subscribers.description')}
    actions={<span className="newsletter-total">{t('subscribers.total', { count: pagination.total })}</span>}
    footer={(
      <Pagination
        label={t('subscribers.title')}
        position={t('pagination.summary', { page, pages: Math.max(1, pagination.total_pages) })}
        previousLabel={t('pagination.previous')}
        nextLabel={t('pagination.next')}
        page={page}
        totalPages={Math.max(1, pagination.total_pages)}
        onChange={setPage}
      />
    )}
  >
    <div className="newsletter-stack">
    <form className="newsletter-filters" role="search" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(searchInput.trim().toLowerCase()); }}>
      <Field label={t('subscribers.status')}>{(control) => <select {...control} value={status} onChange={(event) => { setStatus(event.target.value as typeof status); setPage(1); }}><option value="all">{t('status.all')}</option><option value="pending">{t('status.pending')}</option><option value="subscribed">{t('status.subscribed')}</option><option value="unsubscribed">{t('status.unsubscribed')}</option></select>}</Field>
      <Field label={t('subscribers.search')}>{(control) => <input {...control} type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />}</Field>
      <Button type="submit">{t('actions.search')}</Button>
    </form>
    <div className="newsletter-export-controls">
      <div className="newsletter-export-copy">
        <strong className="newsletter-export-title">
          {t('subscribers.exportTitle')}
        </strong>
        <span>{t('subscribers.exportHelp')}</span>
      </div>
      <Field label={t('subscribers.exportFrom')}>{(control) => <input {...control} type="date" value={exportFrom} onChange={(event) => setExportFrom(event.target.value)} />}</Field>
      <Field label={t('subscribers.exportTo')}>{(control) => <input {...control} type="date" max="9998-12-31" value={exportTo} onChange={(event) => setExportTo(event.target.value)} />}</Field>
      <Button type="button" onClick={() => void exportCsv()} disabled={exporting || exportDatesInvalid}>{exporting ? t('actions.exporting') : t('actions.export')}</Button>
    </div>
    {exportDatesInvalid ? <Notice tone="error">{t('subscribers.exportDateError')}</Notice> : null}
    {exportResult ? <Notice tone={exportResult.truncated ? 'warning' : 'success'}>{t(exportResult.truncated ? 'subscribers.exportTruncated' : 'subscribers.exported', { count: exportResult.rowCount })}</Notice> : null}
    <ErrorNotice failure={failure} />
    {rows.length === 0 ? (
      <EmptyState title={t('subscribers.emptyTitle')} description={t('subscribers.emptyDescription')} />
    ) : (
      <DataTable
        caption={t('subscribers.title')}
        minWidthPx={720}
        stacked="compact"
        framed
      >
        <thead><tr>
          <th scope="col">{t('subscribers.email')}</th>
          <th scope="col">{t('subscribers.status')}</th>
          <th scope="col">{t('subscribers.confirmation')}</th>
          <th scope="col">{t('subscribers.created')}</th>
          <th scope="col">{t('subscribers.actions')}</th>
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          <td
            data-label={t('subscribers.email')}
            data-stack="primary"
            className="newsletter-table-primary"
          >
            {row.email}
          </td>
          <td data-label={t('subscribers.status')}><StatusPill tone={STATUS_TONE[row.status]}>{t(`status.${row.status}`)}</StatusPill></td>
          <td data-label={t('subscribers.confirmation')}>{t(`confirmation.${row.confirmation_status}`)}</td>
          <td data-label={t('subscribers.created')} data-stack="wide">{formatter.format(new Date(row.created_at_iso))}</td>
          <td data-label={t('subscribers.actions')} data-stack="actions">
            <ActionMenu
              label={t('subscribers.actionMenuLabel', { email: row.email })}
              disabled={busy === row.id}
              items={[
                {
                  id: 'view',
                  kind: 'button',
                  label: t('actions.view'),
                  icon: Eye,
                  onSelect: () => void openDetail(row.id),
                },
                ...(row.status !== 'unsubscribed' ? [{
                  id: 'unsubscribe',
                  kind: 'button' as const,
                  label: t('actions.unsubscribe'),
                  icon: UserMinus,
                  onSelect: () => {
                    setFailure(null);
                    setConfirmation({
                      kind: 'unsubscribe',
                      id: row.id,
                      email: row.email,
                    });
                  },
                }] : []),
                {
                  id: 'delete',
                  kind: 'button',
                  label: t('actions.delete'),
                  icon: Trash2,
                  tone: 'critical',
                  onSelect: () => {
                    setFailure(null);
                    setConfirmation({
                      kind: 'delete',
                      id: row.id,
                      email: row.email,
                    });
                  },
                },
              ]}
            />
          </td>
        </tr>)}</tbody>
      </DataTable>
    )}
    </div>
    <Dialog
      open={detail !== null}
      size="wide"
      onClose={() => setDetail(null)}
      kicker={t('subscribers.detailKicker')}
      title={detail?.email ?? ''}
      initialFocusRef={detailCloseRef}
      actions={(
        <Button ref={detailCloseRef} type="button" onClick={() => setDetail(null)}>
          {t('actions.close')}
        </Button>
      )}
    >
      {detail ? (
        <div className="newsletter-detail-body">
          <dl className="newsletter-detail-summary">
            <div><dt>{t('subscribers.detailStatus')}</dt><dd>{t(`status.${detail.status}`)}</dd></div>
            <div><dt>{t('subscribers.detailConfirmation')}</dt><dd>{t(`confirmation.${detail.confirmation_status}`)}</dd></div>
            <div><dt>{t('subscribers.detailCreated')}</dt><dd>{formatter.format(new Date(detail.created_at_iso))}</dd></div>
            <div><dt>{t('subscribers.detailConfirmationSent')}</dt><dd>{detail.confirm_sent_at_iso ? formatter.format(new Date(detail.confirm_sent_at_iso)) : '—'}</dd></div>
            <div><dt>{t('subscribers.detailConfirmed')}</dt><dd>{detail.confirmed_at_iso ? formatter.format(new Date(detail.confirmed_at_iso)) : '—'}</dd></div>
            <div><dt>{t('subscribers.detailSubscribed')}</dt><dd>{detail.subscribed_at_iso ? formatter.format(new Date(detail.subscribed_at_iso)) : '—'}</dd></div>
            <div><dt>{t('subscribers.detailUnsubscribed')}</dt><dd>{detail.unsubscribed_at_iso ? formatter.format(new Date(detail.unsubscribed_at_iso)) : '—'}</dd></div>
            <div><dt>{t('subscribers.detailCountry')}</dt><dd>{detail.country_code || '—'}</dd></div>
            <div className="newsletter-detail-wide"><dt>{t('subscribers.detailSource')}</dt><dd>{detail.source_url || '—'}</dd></div>
          </dl>
          <h3 className="newsletter-detail-heading">{t('subscribers.detailFields')}</h3>
          {detail.values.length === 0 ? (
            <p className="newsletter-detail-empty">{t('subscribers.detailNoFields')}</p>
          ) : (
            <dl className="newsletter-detail-summary">
              {detail.values.map((value) => (
                <div key={value.field_id}><dt>{value.label}</dt><dd>{value.value || '—'}</dd></div>
              ))}
            </dl>
          )}
        </div>
      ) : null}
    </Dialog>
    {confirmation ? <NewsletterConfirmationDialog title={t(confirmation.kind === 'delete' ? 'subscribers.deleteTitle' : 'subscribers.unsubscribeTitle')} description={t(confirmation.kind === 'delete' ? 'subscribers.confirmDelete' : 'subscribers.confirmUnsubscribe')} target={confirmation.email} confirmLabel={t(confirmation.kind === 'delete' ? 'actions.delete' : 'actions.unsubscribe')} cancelLabel={t('actions.cancel')} busy={busy === confirmation.id} failure={failure} danger={confirmation.kind === 'delete'} onClose={() => { setConfirmation(null); setFailure(null); }} onConfirm={() => void (confirmation.kind === 'delete' ? remove(confirmation.id) : unsubscribe(confirmation.id))} /> : null}
  </Panel>;
}

function DeliveriesPanel(input: {
  newsletter: NewsletterSummary;
  contentId: string;
  onContentIdChange: (contentId: string) => void;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('newsletters');
  const [status, setStatus] = useState<'all' | NewsletterDelivery['status']>('all');
  const [type, setType] = useState<'all' | NewsletterDelivery['delivery_type']>('all');
  const [contentIdInput, setContentIdInput] = useState(input.contentId);
  const [contentIdInvalid, setContentIdInvalid] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<NewsletterDelivery[]>([]);
  const [pagination, setPagination] = useState({ total: 0, total_pages: 0 });
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    setContentIdInput(input.contentId);
    setContentIdInvalid(false);
  }, [input.contentId]);
  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    void requestNewsletterDeliveries(input.newsletter.id, {
      status,
      type,
      ...(input.contentId ? { content_id: input.contentId } : {}),
      search,
      page,
      per_page: NEWSLETTER_DEFAULT_PAGE_SIZE,
    }, controller.signal).then((response) => {
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setRows(response.data.items);
      setPagination({
        total: response.data.pagination.total,
        total_pages: response.data.pagination.total_pages,
      });
    }).catch((error) => {
      if (!controller.signal.aborted) setFailure(clientFailure(error));
    });
    return () => controller.abort();
  }, [input.contentId, input.newsletter.id, input.onSessionEnded, page, search, status, type]);
  const formatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.resolvedLanguage, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
    [i18n.resolvedLanguage],
  );
  return (
    <Panel
      title={t('deliveries.title')}
      description={t('deliveries.description')}
      actions={<span className="newsletter-total">{t('deliveries.total', { count: pagination.total })}</span>}
      footer={(
        <Pagination
          label={t('deliveries.title')}
          position={t('pagination.summary', { page, pages: Math.max(1, pagination.total_pages) })}
          previousLabel={t('pagination.previous')}
          nextLabel={t('pagination.next')}
          page={page}
          totalPages={Math.max(1, pagination.total_pages)}
          onChange={setPage}
        />
      )}
    >
      <div className="newsletter-stack">
        <form className="newsletter-filters" role="search" onSubmit={(event) => {
          event.preventDefault();
          const nextContentId = contentIdInput.trim().toLowerCase();
          if (
            nextContentId !== ''
            && !newsletterIdSchema.safeParse(nextContentId).success
          ) {
            setContentIdInvalid(true);
            return;
          }
          setContentIdInvalid(false);
          setContentIdInput(nextContentId);
          setPage(1);
          setSearch(searchInput.trim().toLowerCase());
          input.onContentIdChange(nextContentId);
        }}>
          <Field label={t('deliveries.status')}>{(control) => (
            <select {...control} value={status} onChange={(event) => {
              setStatus(event.target.value as typeof status);
              setPage(1);
            }}>
              <option value="all">{t('status.all')}</option>
              <option value="queued">{t('deliveryStatus.queued')}</option>
              <option value="sent">{t('deliveryStatus.sent')}</option>
              <option value="failed">{t('deliveryStatus.failed')}</option>
              <option value="skipped">{t('deliveryStatus.skipped')}</option>
            </select>
          )}</Field>
          <Field label={t('deliveries.type')}>{(control) => (
            <select {...control} value={type} onChange={(event) => {
              setType(event.target.value as typeof type);
              setPage(1);
            }}>
              <option value="all">{t('deliveries.allTypes')}</option>
              <option value="confirmation">{t('deliveryType.confirmation')}</option>
              <option value="post_notification">{t('deliveryType.post_notification')}</option>
            </select>
          )}</Field>
          <Field
            label={t('deliveries.postId')}
            hint={t('deliveries.postIdHint')}
            error={contentIdInvalid
              ? t('deliveries.postIdInvalid')
              : undefined}
          >{(control) => (
            <input
              {...control}
              type="search"
              maxLength={32}
              spellCheck={false}
              value={contentIdInput}
              onChange={(event) => {
                setContentIdInput(event.target.value);
                setContentIdInvalid(false);
              }}
            />
          )}</Field>
          <Field label={t('deliveries.search')}>{(control) => (
            <input {...control} type="search" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
          )}</Field>
          <Button type="submit">{t('actions.search')}</Button>
        </form>
        <ErrorNotice failure={failure} />
        {rows.length === 0 ? (
          <EmptyState title={t('deliveries.emptyTitle')} description={t('deliveries.emptyDescription')} />
        ) : (
          <DataTable caption={t('deliveries.title')} minWidthPx={900} stacked="compact" framed>
            <thead><tr>
              <th scope="col">{t('deliveries.recipient')}</th>
              <th scope="col">{t('deliveries.type')}</th>
              <th scope="col">{t('deliveries.status')}</th>
              <th scope="col">{t('deliveries.provider')}</th>
              <th scope="col">{t('deliveries.attempts')}</th>
              <th scope="col">{t('deliveries.queued')}</th>
              <th scope="col">{t('deliveries.completed')}</th>
            </tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.id}>
                <td data-label={t('deliveries.recipient')} data-stack="primary" className="newsletter-table-primary">{row.email}</td>
                <td data-label={t('deliveries.type')}>{t(`deliveryType.${row.delivery_type}`)}</td>
                <td data-label={t('deliveries.status')}>
                  <StatusPill tone={DELIVERY_STATUS_TONE[row.status]}>{t(`deliveryStatus.${row.status}`)}</StatusPill>
                  {row.failure_code ? <span className="newsletter-delivery-failure">{row.failure_code}</span> : null}
                </td>
                <td data-label={t('deliveries.provider')}>{row.provider ? t(`deliveryProvider.${row.provider}`) : '—'}</td>
                <td data-label={t('deliveries.attempts')}>{row.attempt_count}</td>
                <td data-label={t('deliveries.queued')} data-stack="wide">{formatter.format(new Date(row.queued_at_iso))}</td>
                <td data-label={t('deliveries.completed')} data-stack="wide">{row.sent_at_iso ? formatter.format(new Date(row.sent_at_iso)) : '—'}</td>
              </tr>
            ))}</tbody>
          </DataTable>
        )}
      </div>
    </Panel>
  );
}

type SuppressionConfirmation =
  | { kind: 'create'; email: string; note: string | null }
  | { kind: 'remove'; suppression: NewsletterSuppression };

function SuppressionsPanel(input: { csrfToken: string; onSessionEnded: () => void }) {
  const { t, i18n } = useTranslation('newsletters');
  const [items, setItems] = useState<NewsletterSuppression[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [reason, setReason] = useState<'all' | NewsletterSuppression['reason']>('all');
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<SuppressionConfirmation | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    void requestNewsletterSuppressions({ reason, search, page, per_page: NEWSLETTER_DEFAULT_PAGE_SIZE }, controller.signal).then((response) => {
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setItems(response.data.items); setPages(response.data.pagination.total_pages);
    }).catch((error) => { if (!controller.signal.aborted) setFailure(clientFailure(error)); });
    return () => controller.abort();
  }, [attempt, input.onSessionEnded, page, reason, search]);
  const formatter = useMemo(() => new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' }), [i18n.resolvedLanguage]);

  function prepareCreate(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFailure(null);
    setConfirmation({
      kind: 'create',
      email: email.trim().toLowerCase(),
      note: note.trim() || null,
    });
  }

  async function create(pending: Extract<SuppressionConfirmation, { kind: 'create' }>) {
    if (busy) return; setBusy(true); setFailure(null);
    try {
      const response = await requestCreateNewsletterSuppression(input.csrfToken, { email: pending.email, note: pending.note });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
      } else { setConfirmation(null); setEmail(''); setNote(''); setPage(1); setAttempt((value) => value + 1); }
    } catch (error) { setFailure(clientFailure(error)); } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (busy) return; setBusy(true); setFailure(null);
    try {
      const response = await requestDeleteNewsletterSuppression(input.csrfToken, id);
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
      } else { setConfirmation(null); setAttempt((value) => value + 1); }
    } catch (error) { setFailure(clientFailure(error)); } finally { setBusy(false); }
  }
  return <Panel
    title={t('suppressions.title')}
    description={t('suppressions.description')}
    footer={(
      <Pagination
        label={t('suppressions.title')}
        position={t('pagination.summary', { page, pages: Math.max(1, pages) })}
        previousLabel={t('pagination.previous')}
        nextLabel={t('pagination.next')}
        page={page}
        totalPages={Math.max(1, pages)}
        onChange={setPage}
      />
    )}
  >
    <div className="newsletter-stack">
    <form className="newsletter-suppression-form" onSubmit={prepareCreate}>
      <Field label={t('suppressions.email')}>
        {(control) => (
          <input
            {...control}
            type="email"
            value={email}
            required
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </Field>
      <Field label={t('suppressions.note')}>
        {(control) => (
          <input
            {...control}
            value={note}
            maxLength={1000}
            onChange={(event) => setNote(event.target.value)}
          />
        )}
      </Field>
      <Button type="submit" variant="primary" disabled={busy}>
        {t('suppressions.add')}
      </Button>
    </form>
    <form
      className="newsletter-filters"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        setPage(1);
        setSearch(searchInput.trim().toLowerCase());
      }}
    >
      <Field label={t('suppressions.reasonFilter')}>
        {(control) => (
          <select
            {...control}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value as typeof reason);
              setPage(1);
            }}
          >
            <option value="all">{t('suppressions.allReasons')}</option>
            <option value="manual">{t('suppressionReason.manual')}</option>
            <option value="bounce">{t('suppressionReason.bounce')}</option>
            <option value="complaint">{t('suppressionReason.complaint')}</option>
            <option value="invalid">{t('suppressionReason.invalid')}</option>
          </select>
        )}
      </Field>
      <Field label={t('suppressions.search')}>
        {(control) => (
          <input
            {...control}
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
        )}
      </Field>
      <Button type="submit">{t('actions.search')}</Button>
    </form>
    <ErrorNotice failure={failure} />
    {items.length === 0 ? (
      <EmptyState
        title={t('suppressions.emptyTitle')}
        description={t('suppressions.emptyDescription')}
      />
    ) : (
      <DataTable
        caption={t('suppressions.title')}
        minWidthPx={820}
        stacked="compact"
        framed
      >
        <thead><tr>
          <th scope="col">{t('suppressions.email')}</th>
          <th scope="col">{t('suppressions.reason')}</th>
          <th scope="col">{t('suppressions.source')}</th>
          <th scope="col">{t('suppressions.note')}</th>
          <th scope="col">{t('suppressions.created')}</th>
          <th scope="col">{t('subscribers.actions')}</th>
        </tr></thead>
        <tbody>{items.map((item) => (
          <tr key={item.id}>
            <td
              data-label={t('suppressions.email')}
              data-stack="primary"
              className="newsletter-table-primary"
            >
              {item.email}
            </td>
            <td data-label={t('suppressions.reason')}>
              {t(`suppressionReason.${item.reason}`)}
            </td>
            <td data-label={t('suppressions.source')}>{item.source}</td>
            <td data-label={t('suppressions.note')} data-stack="wide">{item.note || '—'}</td>
            <td data-label={t('suppressions.created')}>
              {formatter.format(new Date(item.created_at_iso))}
            </td>
            <td data-label={t('subscribers.actions')} data-stack="actions">
              <ActionMenu
                label={t('suppressions.actionMenuLabel', {
                  email: item.email,
                })}
                disabled={busy}
                items={[{
                  id: 'remove',
                  kind: 'button',
                  label: t('actions.remove'),
                  icon: Trash2,
                  tone: 'critical',
                  onSelect: () => {
                    setFailure(null);
                    setConfirmation({ kind: 'remove', suppression: item });
                  },
                }]}
              />
            </td>
          </tr>
        ))}</tbody>
      </DataTable>
    )}
    </div>
    {confirmation ? <NewsletterConfirmationDialog title={t(confirmation.kind === 'create' ? 'suppressions.addTitle' : 'suppressions.deleteTitle')} description={t(confirmation.kind === 'create' ? 'suppressions.confirmAdd' : 'suppressions.confirmDelete')} target={confirmation.kind === 'create' ? confirmation.email : confirmation.suppression.email} confirmLabel={t(confirmation.kind === 'create' ? 'suppressions.add' : 'actions.remove')} cancelLabel={t('actions.cancel')} busy={busy} failure={failure} danger onClose={() => { setConfirmation(null); setFailure(null); }} onConfirm={() => void (confirmation.kind === 'create' ? create(confirmation) : remove(confirmation.suppression.id))} /> : null}
  </Panel>;
}

export function NewslettersPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('newsletters');
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const tab = TABS.some((value) => value === requestedTab)
    ? requestedTab as Tab
    : 'overview';
  const parsedContentId = newsletterIdSchema.safeParse(
    searchParams.get('content_id'),
  );
  const deliveryContentId = parsedContentId.success
    ? parsedContentId.data
    : '';
  const [newsletter, setNewsletter] = useState<NewsletterSummary | null>(null);
  const [runtime, setRuntime] = useState<NewsletterRuntime | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage),
    [i18n.resolvedLanguage],
  );

  useStudioDocumentTitle(t('documentTitle'));
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setFailure(null);
    void Promise.all([
      requestNewsletters({
        status: 'all',
        search: DEFAULT_NEWSLETTER_SLUG,
        page: 1,
        per_page: 100,
      }, controller.signal),
      requestNewsletterRuntime(controller.signal),
    ]).then(([list, runtimeResponse]) => {
      const error = !list.success ? list : !runtimeResponse.success ? runtimeResponse : null;
      if (error && !error.success) {
        if (error.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: error.error.code });
        return;
      }
      if (list.success && runtimeResponse.success) {
        setNewsletter(list.data.items.find(
          (item) => item.slug === DEFAULT_NEWSLETTER_SLUG,
        ) ?? null);
        setRuntime(runtimeResponse.data);
      }
    }).catch((error) => { if (!controller.signal.aborted) setFailure(clientFailure(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt, input.onSessionEnded]);

  function updateNewsletterSummary(value: NewsletterSummary) {
    setNewsletter(value);
  }
  function reloadNewsletter() { setAttempt((value) => value + 1); }
  function changeTab(value: Tab) {
    const next = new URLSearchParams(searchParams);
    if (value === 'overview') next.delete('tab');
    else next.set('tab', value);
    setSearchParams(next, { replace: true });
  }
  function changeDeliveryContentId(contentId: string) {
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'deliveries');
    if (contentId) next.set('content_id', contentId);
    else next.delete('content_id');
    setSearchParams(next, { replace: true });
  }

  return (
    <main
      id="studio-main-content"
      aria-labelledby="newsletters-title"
    >
      <PageHeader
        titleId="newsletters-title"
        kicker={t('kicker')}
        title={t('title')}
        description={t('description')}
      />
      {loading ? (
        <Panel>
          <InlineStatus>{t('loading')}</InlineStatus>
        </Panel>
      ) : null}
      <ErrorNotice failure={failure} />
      {!loading && failure ? (
        <Button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
        >
          {t('actions.retry')}
        </Button>
      ) : null}
      {!loading && !failure && !newsletter ? (
        <EmptyState
          headingLevel={2}
          title={t('empty.title')}
          description={t('empty.description')}
        />
      ) : null}
      {!loading && !failure && newsletter && runtime ? (
        <div className="newsletter-channel-stack">
          <Panel
            kicker={t('channel.kicker')}
            title={newsletter.title}
            description={newsletter.description ?? t('channel.description')}
            leading={<StudioIcon icon={Mail} />}
            actions={(
              <>
                <StatusPill tone={STATUS_TONE[newsletter.status]}>
                  {t(`status.${newsletter.status}`)}
                </StatusPill>
                <ButtonLink size="sm" to={STUDIO_PATHS.newsletterSettings}>
                  <StudioIcon icon={Settings2} />
                  {t('links.cta')}
                </ButtonLink>
                <ButtonLink size="sm" to={STUDIO_PATHS.mailSettings}>
                  <StudioIcon icon={Mail} />
                  {t('links.mail')}
                </ButtonLink>
              </>
            )}
          />
          <dl
            className="newsletter-metrics"
            aria-label={t('channel.metricsLabel')}
          >
            <div>
              <dt>{t('metrics.subscribed')}</dt>
              <dd>{numberFormatter.format(newsletter.subscribed_count)}</dd>
            </div>
            <div>
              <dt>{t('metrics.pending')}</dt>
              <dd>{numberFormatter.format(newsletter.pending_count)}</dd>
            </div>
            <div>
              <dt>{t('metrics.unsubscribed')}</dt>
              <dd>{numberFormatter.format(newsletter.unsubscribed_count)}</dd>
            </div>
            <div>
              <dt>{t('metrics.fields')}</dt>
              <dd>{numberFormatter.format(newsletter.fields_count)}</dd>
            </div>
          </dl>
          <Tabs
            label={t('tabs.label')}
            value={tab}
            items={TABS.map((value) => ({
              value,
              label: t(`tabs.${value}`),
            }))}
            onChange={changeTab}
          >
            {tab === 'overview' ? (
              <OverviewPanel
                newsletter={newsletter}
                csrfToken={input.data.csrf_token}
                onSessionEnded={input.onSessionEnded}
                onUpdated={updateNewsletterSummary}
              />
            ) : null}
            {tab === 'subscribers' ? (
              <SubscribersPanel
                newsletter={newsletter}
                csrfToken={input.data.csrf_token}
                onSessionEnded={input.onSessionEnded}
                onNewsletterChanged={reloadNewsletter}
              />
            ) : null}
            {tab === 'deliveries' ? (
              <DeliveriesPanel
                newsletter={newsletter}
                contentId={deliveryContentId}
                onContentIdChange={changeDeliveryContentId}
                onSessionEnded={input.onSessionEnded}
              />
            ) : null}
            {tab === 'fields' ? (
              <FieldsPanel
                newsletter={newsletter}
                csrfToken={input.data.csrf_token}
                onSessionEnded={input.onSessionEnded}
                onNewsletterChanged={reloadNewsletter}
              />
            ) : null}
            {tab === 'suppressions' ? (
              <SuppressionsPanel
                csrfToken={input.data.csrf_token}
                onSessionEnded={input.onSessionEnded}
              />
            ) : null}
            {tab === 'runtime' ? (
              <RuntimePanel
                runtime={runtime}
                csrfToken={input.data.csrf_token}
                onSessionEnded={input.onSessionEnded}
                onUpdated={setRuntime}
              />
            ) : null}
          </Tabs>
        </div>
      ) : null}
    </main>
  );
}

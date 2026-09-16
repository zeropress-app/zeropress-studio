import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  Eye,
  FileText,
  Inbox,
  List,
  Pencil,
  Plus,
  Save,
  Search,
  Settings2,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import type { ApiErrorCode } from '../../contracts/api';
import {
  FORM_DEFAULT_PAGE_SIZE,
  FORM_MAX_FIELDS,
  formFieldInputSchema,
  type FormField,
  type FormFieldInput,
  type FormNotificationRecipientIdentity,
  type FormNotificationSettings,
  type FormSubmission,
  type FormSubmissionDetail,
  type FormSummary,
} from '../../contracts/forms';
import type { CurrentSessionSuccess } from '../../contracts/session';
import {
  Button,
  DataTable,
  Dialog,
  DialogActions,
  EmptyState,
  Field,
  FilterTabs,
  InlineStatus,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  StatusPill,
  StudioIcon,
  type StatusTone,
  Switch,
  Tabs,
} from './components/primitives';
import { UnsavedChangesGuard } from './components/UnsavedChangesGuard';
import {
  FormsClientError,
  requestCreateForm,
  requestDeleteForm,
  requestDeleteFormSubmission,
  requestForm,
  requestFormFields,
  requestFormNotificationRecipientCandidates,
  requestFormNotificationSettings,
  requestForms,
  requestFormSubmission,
  requestFormSubmissions,
  requestReplaceFormFields,
  requestUpdateForm,
  requestUpdateFormNotificationSettings,
  requestUpdateFormSubmission,
  type FormsClientErrorCode,
} from './lib/forms-client';

type AccountSession = CurrentSessionSuccess['data'];
const TABS = ['submissions', 'fields', 'notifications', 'settings'] as const;
type Tab = typeof TABS[number];
const FORM_LIST_PAGE_SIZE = 10;

/**
 * Map domain states to badge tones.
 *
 * Forms (draft/active/disabled/archived), fields (active/disabled), and submissions
 * (unread/read/archived/spam) have different state sets but share presentation tones. Only spam is
 * critical; ordinary workflow states should not look like errors.
 */
const STATUS_TONE: Record<
  FormSummary['status'] | FormSubmission['status'],
  StatusTone
> = {
  active: 'positive',
  draft: 'neutral',
  disabled: 'neutral',
  archived: 'neutral',
  unread: 'attention',
  read: 'neutral',
  spam: 'critical',
};

type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: FormsClientErrorCode }
  | { kind: 'unexpected' };

const FORM_FIELD_TYPES = [
  'text', 'textarea', 'email', 'number', 'date',
  'select', 'radio', 'checkbox', 'phone',
] as const;

function clientFailure(error: unknown): Failure {
  return error instanceof FormsClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

function useFailureMessage() {
  const { t } = useTranslation('forms');
  return (failure: Failure) => {
    if (failure.kind === 'client') {
      if (failure.code === 'TIMEOUT') return t('errors.timeout');
      if (failure.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (failure.kind === 'api') {
      if (failure.code === 'FORBIDDEN') return t('errors.forbidden');
      if (failure.code === 'FORM_REVISION_CONFLICT') return t('errors.conflict');
      if (failure.code === 'FORM_ALREADY_EXISTS') return t('errors.exists');
      if (failure.code === 'FORM_HAS_SUBMISSIONS') return t('errors.hasSubmissions');
      if (failure.code === 'FORM_NOTIFICATION_RECIPIENT_NOT_AVAILABLE') {
        return t('errors.recipientUnavailable');
      }
      if (
        failure.code === 'FORM_NOT_FOUND'
        || failure.code === 'FORM_SUBMISSION_NOT_FOUND'
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

function ConfirmationDialog(input: {
  title: string;
  description: string;
  target: string;
  busy: boolean;
  failure: Failure | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('forms');
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
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={input.busy}
            onClick={input.onConfirm}
          >
            {t('actions.delete')}
          </Button>
        </>
      )}
    >
      <div className="forms-dialog-body">
        <code className="forms-dialog-target">{input.target}</code>
        <ErrorNotice failure={input.failure} />
      </div>
    </Dialog>
  );
}

function CreateFormDialog(input: {
  busy: boolean;
  failure: Failure | null;
  onCreate: (value: { slug: string; title: string }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('forms');
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const slugRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open
      onClose={input.onClose}
      busy={input.busy}
      kicker={t('kicker')}
      title={t('createTitle')}
      initialFocusRef={slugRef}
    >
      {/*
       * Use DialogActions instead of the actions prop so the submit button stays inside the form.
       */}
      <form
        className="forms-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          input.onCreate({
            slug: slug.trim().toLowerCase(),
            title: title.trim(),
          });
        }}
      >
        <div className="forms-grid">
          <Field label={t('settings.slug')}>
            {(control) => (
              <input
                {...control}
                ref={slugRef}
                value={slug}
                maxLength={64}
                pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
                required
                disabled={input.busy}
                onChange={(event) => setSlug(event.target.value.toLowerCase())}
              />
            )}
          </Field>
          <Field label={t('settings.formTitle')}>
            {(control) => (
              <input
                {...control}
                value={title}
                maxLength={200}
                required
                disabled={input.busy}
                onChange={(event) => setTitle(event.target.value)}
              />
            )}
          </Field>
        </div>
        <ErrorNotice failure={input.failure} />
        <DialogActions>
          <Button type="button" disabled={input.busy} onClick={input.onClose}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={input.busy || !slug.trim() || !title.trim()}
          >
            {input.busy ? t('actions.saving') : t('create')}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

function NotificationsPanel(input: {
  form: FormSummary;
  csrfToken: string;
  onSessionEnded: () => void;
  onUpdated: (updatedAtIso: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation('forms');
  const [settings, setSettings] = useState<FormNotificationSettings | null>(null);
  const [recipient, setRecipient] = useState<FormNotificationSettings['recipient']>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearchInput, setPickerSearchInput] = useState('');
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerAttempt, setPickerAttempt] = useState(0);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [candidates, setCandidates] = useState<FormNotificationRecipientIdentity[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    setSaved(false);
    void requestFormNotificationSettings(input.form.id, controller.signal)
      .then((response) => {
        if (!response.success) {
          if (response.error.code === 'AUTHENTICATION_REQUIRED') {
            input.onSessionEnded();
          } else setFailure({ kind: 'api', code: response.error.code });
          return;
        }
        setSettings(response.data);
        setRecipient(response.data.recipient);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setFailure(clientFailure(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [input.form.id, input.onSessionEnded]);

  useEffect(() => {
    if (!pickerOpen) return undefined;
    const controller = new AbortController();
    setPickerLoading(true);
    setFailure(null);
    void requestFormNotificationRecipientCandidates({
      search: pickerSearch,
      page: 1,
      per_page: 50,
    }, controller.signal).then((response) => {
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
        } else setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setCandidates(response.data.items);
    }).catch((error) => {
      if (!controller.signal.aborted) setFailure(clientFailure(error));
    }).finally(() => {
      if (!controller.signal.aborted) setPickerLoading(false);
    });
    return () => controller.abort();
  }, [input.onSessionEnded, pickerAttempt, pickerOpen, pickerSearch]);

  const baselineId = settings?.recipient?.id ?? null;
  const recipientId = recipient?.id ?? null;
  const dirty = settings !== null && recipientId !== baselineId;
  useEffect(() => {
    input.onDirtyChange(dirty && !saving);
  }, [dirty, input.onDirtyChange, saving]);

  async function save() {
    if (!settings || !dirty || saving) return;
    setSaving(true);
    setSaved(false);
    setFailure(null);
    try {
      const response = await requestUpdateFormNotificationSettings(
        input.csrfToken,
        input.form.id,
        recipientId,
        settings.form_updated_at_iso,
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
        } else setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setSettings(response.data);
      setRecipient(response.data.recipient);
      setSaved(true);
      input.onUpdated(response.data.form_updated_at_iso);
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Panel>
        <InlineStatus>{t('notifications.loading')}</InlineStatus>
      </Panel>
    );
  }

  return (
    <>
      <Panel
        title={t('notifications.title')}
        description={t('notifications.description')}
        leading={<StudioIcon icon={Bell} />}
        footer={(
          <Button
            type="button"
            variant="primary"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            <StudioIcon icon={Save} className="navigation-icon" />
            {saving ? t('actions.saving') : t('actions.save')}
          </Button>
        )}
      >
        <div className="forms-stack">
          {saved ? <Notice tone="success">{t('notifications.saved')}</Notice> : null}
          <ErrorNotice failure={failure} />
          {settings && !settings.mail_configured ? (
            <Notice tone="warning">{t('notifications.mailWarning')}</Notice>
          ) : null}
          <section className="forms-recipient-card" aria-labelledby="form-recipient-title">
            <div className="forms-recipient-copy">
              <span className="forms-recipient-icon" aria-hidden="true">
                <StudioIcon icon={UserRound} />
              </span>
              <div>
                <h3 id="form-recipient-title">{t('notifications.recipient')}</h3>
                {recipient ? (
                  <>
                    <strong className="forms-recipient-name">
                      {recipient.name ?? t('notifications.unavailableName')}
                    </strong>
                    <span className="forms-recipient-email">
                      {recipient.email ?? t('notifications.unavailableEmail')}
                    </span>
                  </>
                ) : (
                  <p>{t('notifications.noRecipient')}</p>
                )}
              </div>
            </div>
            <div className="forms-recipient-actions">
              {recipient ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={saving}
                  onClick={() => { setRecipient(null); setSaved(false); }}
                >
                  <StudioIcon icon={X} className="navigation-icon" />
                  {t('notifications.remove')}
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setPickerOpen(true);
                  setPickerAttempt((value) => value + 1);
                }}
              >
                <StudioIcon icon={Search} className="navigation-icon" />
                {recipient
                  ? t('notifications.changeRecipient')
                  : t('notifications.selectRecipient')}
              </Button>
            </div>
          </section>
          {recipient?.state === 'unavailable' ? (
            <Notice tone="warning">{t('notifications.recipientUnavailable')}</Notice>
          ) : null}
        </div>
      </Panel>
      <UnsavedChangesGuard
        active={dirty && !saving}
        copy={{
          kicker: t('discard.kicker'),
          title: t('discard.title'),
          description: t('discard.description'),
          stay: t('discard.stay'),
          leave: t('discard.leave'),
        }}
      />
      <Dialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={t('notifications.pickerTitle')}
        description={t('notifications.pickerDescription')}
        initialFocusRef={searchRef}
        actions={(
          <Button type="button" onClick={() => setPickerOpen(false)}>
            {t('actions.close')}
          </Button>
        )}
      >
        <div className="forms-dialog-body">
          <form
            className="forms-recipient-search"
            onSubmit={(event) => {
              event.preventDefault();
              setPickerSearch(pickerSearchInput.trim());
              setPickerAttempt((value) => value + 1);
            }}
          >
            <Field label={t('notifications.searchLabel')} labelHidden>
              {(control) => (
                <input
                  {...control}
                  ref={searchRef}
                  value={pickerSearchInput}
                  placeholder={t('notifications.searchPlaceholder')}
                  onChange={(event) => setPickerSearchInput(event.target.value)}
                />
              )}
            </Field>
            <Button type="submit" disabled={pickerLoading}>
              <StudioIcon icon={Search} className="navigation-icon" />
              {t('notifications.search')}
            </Button>
          </form>
          {pickerLoading ? (
            <InlineStatus>{t('notifications.loadingRecipients')}</InlineStatus>
          ) : candidates.length === 0 ? (
            <EmptyState
              headingLevel={3}
              title={t('notifications.noCandidates')}
              description={t('notifications.noCandidatesDescription')}
            />
          ) : (
            <ul className="forms-recipient-list">
              {candidates.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    className="forms-recipient-option"
                    onClick={() => {
                      setRecipient({ state: 'available', ...candidate });
                      setSaved(false);
                      setPickerOpen(false);
                    }}
                  >
                    <strong className="forms-recipient-option-name">
                      {candidate.name}
                    </strong>
                    <span className="forms-recipient-option-email">
                      {candidate.email}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>
    </>
  );
}

function SettingsPanel(input: {
  form: FormSummary;
  csrfToken: string;
  onSessionEnded: () => void;
  onUpdated: (form: FormSummary) => void;
  onDeleted: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, i18n } = useTranslation('forms');
  const [draft, setDraft] = useState({
    title: input.form.title,
    description: input.form.description ?? '',
    status: input.form.status,
    submitLabel: input.form.submit_label,
    successMessage: input.form.success_message ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setDraft({
      title: input.form.title,
      description: input.form.description ?? '',
      status: input.form.status,
      submitLabel: input.form.submit_label,
      successMessage: input.form.success_message ?? '',
    });
    setSaved(false);
    setFailure(null);
  }, [input.form]);
  const dirty = draft.title.trim() !== input.form.title
    || draft.description.trim() !== (input.form.description ?? '')
    || draft.status !== input.form.status
    || draft.submitLabel.trim() !== input.form.submit_label
    || draft.successMessage.trim() !== (input.form.success_message ?? '');
  useEffect(() => input.onDirtyChange(dirty && !saving), [dirty, input.onDirtyChange, saving]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true); setSaved(false); setFailure(null);
    try {
      const response = await requestUpdateForm(input.csrfToken, input.form.id, {
        title: draft.title,
        description: draft.description.trim() || null,
        status: draft.status,
        submit_label: draft.submitLabel,
        success_message: draft.successMessage.trim() || null,
        expected_updated_at_iso: input.form.updated_at_iso,
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      input.onUpdated(response.data); setSaved(true);
    } catch (error) { setFailure(clientFailure(error)); } finally { setSaving(false); }
  }
  async function remove() {
    if (saving) return;
    setSaving(true); setFailure(null);
    try {
      const response = await requestDeleteForm(input.csrfToken, input.form.id, input.form.updated_at_iso);
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      input.onDeleted();
    } catch (error) { setFailure(clientFailure(error)); } finally { setSaving(false); }
  }
  const formatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' });
  const deleteBlocked = input.form.submissions_count > 0;
  return (
    <form onSubmit={(event) => void save(event)}>
      <Panel
        title={t('settings.title')}
        description={t('settings.description')}
        leading={<StudioIcon icon={Settings2} />}
        actions={(
          <StatusPill tone={STATUS_TONE[input.form.status]}>
            {t(`status.${input.form.status}`)}
          </StatusPill>
        )}
        footer={(
          <>
            <Button
              type="button"
              variant="danger"
              disabled={saving || deleteBlocked}
              onClick={() => setConfirmDelete(true)}
            >
              <StudioIcon icon={Trash2} className="navigation-icon" />
              {t('settings.delete')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!dirty || saving || !draft.title.trim()
                || !draft.submitLabel.trim()}
            >
              <StudioIcon icon={Save} className="navigation-icon" />
              {saving ? t('actions.saving') : t('actions.save')}
            </Button>
          </>
        )}
      >
        <div className="forms-stack">
          {saved ? (
            <Notice tone="success">{t('settings.saved')}</Notice>
          ) : null}
          <ErrorNotice failure={failure} />
          {deleteBlocked ? (
            <Notice tone="warning">{t('settings.deleteBlocked')}</Notice>
          ) : null}
          <div className="forms-grid">
            <Field label={t('settings.slug')}>
              {(control) => (
                <input {...control} value={input.form.slug} disabled />
              )}
            </Field>
            <Field label={t('settings.status')}>
              {(control) => (
                <select
                  {...control}
                  value={draft.status}
                  disabled={saving}
                  onChange={(event) => setDraft((value) => ({
                    ...value,
                    status: event.target.value as FormSummary['status'],
                  }))}
                >
                  <option value="draft">{t('status.draft')}</option>
                  <option value="active">{t('status.active')}</option>
                  <option value="disabled">{t('status.disabled')}</option>
                  <option value="archived">{t('status.archived')}</option>
                </select>
              )}
            </Field>
            <div className="forms-field-wide">
              <Field label={t('settings.formTitle')}>
                {(control) => (
                  <input
                    {...control}
                    value={draft.title}
                    maxLength={200}
                    required
                    disabled={saving}
                    onChange={(event) => setDraft((value) => ({
                      ...value, title: event.target.value,
                    }))}
                  />
                )}
              </Field>
            </div>
            <div className="forms-field-wide">
              <Field label={t('settings.descriptionField')}>
                {(control) => (
                  <textarea
                    {...control}
                    rows={3}
                    value={draft.description}
                    maxLength={2000}
                    disabled={saving}
                    onChange={(event) => setDraft((value) => ({
                      ...value, description: event.target.value,
                    }))}
                  />
                )}
              </Field>
            </div>
            <Field label={t('settings.submitLabel')}>
              {(control) => (
                <input
                  {...control}
                  value={draft.submitLabel}
                  maxLength={80}
                  required
                  disabled={saving}
                  onChange={(event) => setDraft((value) => ({
                    ...value, submitLabel: event.target.value,
                  }))}
                />
              )}
            </Field>
            <div className="forms-field-wide">
              <Field label={t('settings.successMessage')}>
                {(control) => (
                  <textarea
                    {...control}
                    rows={3}
                    value={draft.successMessage}
                    maxLength={2000}
                    disabled={saving}
                    onChange={(event) => setDraft((value) => ({
                      ...value, successMessage: event.target.value,
                    }))}
                  />
                )}
              </Field>
            </div>
          </div>
          <dl className="forms-metrics">
            <div>
              <dt>{t('settings.metrics.fields')}</dt>
              <dd>{input.form.fields_count}</dd>
            </div>
            <div>
              <dt>{t('settings.metrics.submissions')}</dt>
              <dd>{input.form.submissions_count}</dd>
            </div>
            <div>
              <dt>{t('settings.metrics.unread')}</dt>
              <dd>{input.form.unread_count}</dd>
            </div>
            <div>
              <dt>{t('settings.metrics.lastSubmission')}</dt>
              <dd>
                {input.form.last_submitted_at_iso
                  ? formatter.format(new Date(input.form.last_submitted_at_iso))
                  : '—'}
              </dd>
            </div>
          </dl>
        </div>
      </Panel>
      <UnsavedChangesGuard active={dirty && !saving} copy={{ kicker: t('discard.kicker'), title: t('discard.title'), description: t('discard.description'), stay: t('discard.stay'), leave: t('discard.leave') }} />
      {confirmDelete ? <ConfirmationDialog title={t('settings.deleteTitle')} description={t('settings.deleteDescription')} target={input.form.title} busy={saving} failure={failure} onClose={() => { setConfirmDelete(false); setFailure(null); }} onConfirm={() => void remove()} /> : null}
    </form>
  );
}

function FieldsPanel(input: {
  form: FormSummary;
  csrfToken: string;
  onSessionEnded: () => void;
  onChanged: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation('forms');
  const [items, setItems] = useState<FormFieldInput[]>([]);
  const [baseline, setBaseline] = useState('[]');
  const [revision, setRevision] = useState(input.form.updated_at_iso);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [editor, setEditor] = useState<{
    index: number | null;
    draft: FormFieldInput;
  } | null>(null);
  const [editorInvalid, setEditorInvalid] = useState(false);
  const [removeIndex, setRemoveIndex] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    setEditor(null);
    setRemoveIndex(null);
    void requestFormFields(input.form.id, controller.signal).then((response) => {
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      const fields = response.data.items.map(({ form_id: _form, created_at_iso: _created, updated_at_iso: _updated, ...field }) => field);
      setItems(fields); setBaseline(JSON.stringify(fields)); setRevision(response.data.form_updated_at_iso);
    }).catch((error) => { if (!controller.signal.aborted) setFailure(clientFailure(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [input.form.id, input.onSessionEnded]);
  const dirty = JSON.stringify(items) !== baseline;
  useEffect(() => input.onDirtyChange(dirty && !saving), [dirty, input.onDirtyChange, saving]);

  function nextFieldKey() {
    let index = items.length + 1;
    while (items.some((field) => field.field_key === `field_${index}`)) index += 1;
    return `field_${index}`;
  }

  function openAdd() {
    setEditorInvalid(false);
    setEditor({
      index: null,
      draft: {
        field_key: nextFieldKey(),
        label: '',
        type: 'text',
        required: false,
        placeholder: null,
        help_text: null,
        options: [],
        sort_order: items.length,
        status: 'active',
      },
    });
  }

  function openEdit(index: number) {
    const draft = items[index];
    if (!draft) return;
    setEditorInvalid(false);
    setEditor({ index, draft: structuredClone(draft) });
  }

  function editDraft(update: Partial<FormFieldInput>) {
    setEditorInvalid(false);
    setEditor((current) => current
      ? { ...current, draft: { ...current.draft, ...update } }
      : current);
  }

  function applyEditor(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    const sortOrder = editor.index === null ? items.length : editor.index;
    const candidate = { ...editor.draft, sort_order: sortOrder };
    const duplicateKey = items.some((field, index) => (
      index !== editor.index && field.field_key === candidate.field_key
    ));
    if (duplicateKey || !formFieldInputSchema.safeParse(candidate).success) {
      setEditorInvalid(true);
      return;
    }
    setItems((current) => editor.index === null
      ? [...current, candidate]
      : current.map((field, index) => index === editor.index ? candidate : field));
    setSaved(false);
    setEditor(null);
  }

  function move(index: number, direction: -1 | 1) { const target = index + direction; if (target < 0 || target >= items.length) return; setItems((current) => { const next = [...current]; [next[index], next[target]] = [next[target]!, next[index]!]; return next.map((field, sortOrder) => ({ ...field, sort_order: sortOrder })); }); }
  function removeField() {
    if (removeIndex === null) return;
    setItems((current) => current
      .filter((_field, index) => index !== removeIndex)
      .map((field, sortOrder) => ({ ...field, sort_order: sortOrder })));
    setSaved(false);
    setRemoveIndex(null);
  }
  async function save() {
    const normalized = items.map((field, sortOrder) => ({ ...field, sort_order: sortOrder }));
    if (saving || normalized.some((field) => !formFieldInputSchema.safeParse(field).success)) { setFailure({ kind: 'api', code: 'VALIDATION_ERROR' }); return; }
    setSaving(true); setSaved(false); setFailure(null);
    try {
      const response = await requestReplaceFormFields(input.csrfToken, input.form.id, { fields: normalized, expected_updated_at_iso: revision });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      const fields = response.data.items.map(({ form_id: _form, created_at_iso: _created, updated_at_iso: _updated, ...field }) => field);
      setItems(fields); setBaseline(JSON.stringify(fields)); setRevision(response.data.form_updated_at_iso); setSaved(true); input.onChanged();
    } catch (error) { setFailure(clientFailure(error)); } finally { setSaving(false); }
  }
  if (loading) {
    return (
      <Panel>
        <InlineStatus>{t('loading')}</InlineStatus>
      </Panel>
    );
  }
  return (
    <>
      <Panel
        title={t('fields.title')}
        description={t('fields.description')}
        leading={<StudioIcon icon={List} />}
        actions={(
          <Button
            type="button"
            onClick={openAdd}
            disabled={saving || items.length >= FORM_MAX_FIELDS}
          >
            <StudioIcon icon={Plus} className="navigation-icon" />
            {t('fields.add')}
          </Button>
        )}
        footer={(
          <>
            <span>{t('fields.limit', { count: items.length })}</span>
            <Button
              type="button"
              variant="primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
            >
              <StudioIcon icon={Save} className="navigation-icon" />
              {saving ? t('actions.saving') : t('actions.save')}
            </Button>
          </>
        )}
      >
        <div className="forms-stack">
          {saved ? <Notice tone="success">{t('fields.saved')}</Notice> : null}
          <ErrorNotice failure={failure} />
          {items.length === 0 ? (
            <EmptyState
              title={t('fields.emptyTitle')}
              description={t('fields.emptyDescription')}
            />
          ) : (
            <div className="forms-field-list">
              {items.map((field, index) => {
                const usesOptions = field.type === 'select'
                  || field.type === 'radio' || field.type === 'checkbox';
                const name = field.label || field.field_key
                  || t('fields.untitled');
                return (
                  <article
                    className="forms-field-card"
                    key={field.id ?? `new-${index}`}
                  >
                    <header className="forms-field-card-heading">
                      <div>
                        <span className="forms-field-title-row">
                          <strong className="forms-field-name">{name}</strong>
                          {field.required ? (
                            <span className="forms-required-marker">
                              {t('fields.required')}
                            </span>
                          ) : null}
                        </span>
                        <StatusPill tone={STATUS_TONE[field.status]}>
                          {t(`status.${field.status}`)}
                        </StatusPill>
                      </div>
                      <div className="forms-field-order-actions">
                        {/*
                         * These buttons repeat on every card. Include the field being moved in the
                         * accessible name.
                         */}
                        <Button
                          type="button"
                          size="sm"
                          disabled={saving || index === 0}
                          aria-label={t('fields.moveUpLabel', { field: name })}
                          onClick={() => move(index, -1)}
                        >
                          <StudioIcon icon={ArrowUp} />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={saving || index === items.length - 1}
                          aria-label={t('fields.moveDownLabel', { field: name })}
                          onClick={() => move(index, 1)}
                        >
                          <StudioIcon icon={ArrowDown} />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={saving}
                          aria-label={t('fields.editLabel', { field: name })}
                          onClick={() => openEdit(index)}
                        >
                          <StudioIcon icon={Pencil} />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={saving}
                          aria-label={t('fields.removeLabel', { field: name })}
                          onClick={() => setRemoveIndex(index)}
                        >
                          <StudioIcon icon={Trash2} className="forms-danger-icon" />
                        </Button>
                      </div>
                    </header>
                    <div className="forms-field-summary">
                      <span><code>{field.field_key}</code></span>
                      <span>{t(`fieldType.${field.type}`)}</span>
                      {usesOptions ? (
                        <span>{t('fields.optionCount', { count: field.options.length })}</span>
                      ) : null}
                    </div>
                    {field.help_text ? (
                      <p className="forms-field-help">{field.help_text}</p>
                    ) : null}
                    {usesOptions && field.options.length > 0 ? (
                      <div className="forms-field-options">
                        {field.options.map((option) => (
                          <span className="forms-field-option" key={option.value}>
                            {option.label} <code>{option.value}</code>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </Panel>
      <UnsavedChangesGuard active={dirty && !saving} copy={{ kicker: t('discard.kicker'), title: t('discard.title'), description: t('discard.description'), stay: t('discard.stay'), leave: t('discard.leave') }} />
      <Dialog
        open={editor !== null}
        onClose={() => setEditor(null)}
        size="editor"
        kicker={t('fields.editorKicker')}
        title={editor?.index === null ? t('fields.add') : t('fields.edit')}
        description={t('fields.editorDescription')}
      >
        {editor ? (
          <form className="forms-dialog-form" onSubmit={applyEditor}>
            {editorInvalid ? (
              <Notice tone="error">{t('fields.editorInvalid')}</Notice>
            ) : null}
            <div className="forms-grid">
              <Field label={t('fields.type')}>
                {(control) => (
                  <select
                    {...control}
                    value={editor.draft.type}
                    onChange={(event) => editDraft({
                      type: event.target.value as FormField['type'],
                      options: ['select', 'radio', 'checkbox']
                        .includes(event.target.value)
                        ? editor.draft.options
                        : [],
                    })}
                  >
                    {FORM_FIELD_TYPES.map((type) => (
                      <option value={type} key={type}>
                        {t(`fieldType.${type}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={t('fields.status')}>
                {(control) => (
                  <select
                    {...control}
                    value={editor.draft.status}
                    onChange={(event) => editDraft({
                      status: event.target.value as FormField['status'],
                    })}
                  >
                    <option value="active">{t('status.active')}</option>
                    <option value="disabled">{t('status.disabled')}</option>
                  </select>
                )}
              </Field>
              <Field label={t('fields.label')}>
                {(control) => (
                  <input
                    {...control}
                    value={editor.draft.label}
                    maxLength={200}
                    required
                    onChange={(event) => editDraft({ label: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('fields.key')}>
                {(control) => (
                  <input
                    {...control}
                    value={editor.draft.field_key}
                    maxLength={64}
                    required
                    pattern="[a-z][a-z0-9_]*"
                    onChange={(event) => editDraft({
                      field_key: event.target.value.toLowerCase(),
                    })}
                  />
                )}
              </Field>
              <Field label={t('fields.placeholder')}>
                {(control) => (
                  <input
                    {...control}
                    value={editor.draft.placeholder ?? ''}
                    maxLength={200}
                    onChange={(event) => editDraft({
                      placeholder: event.target.value || null,
                    })}
                  />
                )}
              </Field>
              <Field label={t('fields.helpText')}>
                {(control) => (
                  <input
                    {...control}
                    value={editor.draft.help_text ?? ''}
                    maxLength={1000}
                    onChange={(event) => editDraft({
                      help_text: event.target.value || null,
                    })}
                  />
                )}
              </Field>
              <div className="forms-field-wide">
                <Switch
                  density="inline"
                  label={t('fields.required')}
                  description={t('fields.requiredDescription')}
                  checked={editor.draft.required}
                  onChange={(required) => editDraft({ required })}
                />
              </div>
              {['select', 'radio', 'checkbox'].includes(editor.draft.type) ? (
                <div className="forms-field-wide">
                  <Field label={t('fields.options')} hint={t('fields.optionsHelp')}>
                    {(control) => (
                      <textarea
                        {...control}
                        rows={6}
                        value={editor.draft.options
                          .map((option) => `${option.value}|${option.label}`)
                          .join('\n')}
                        required
                        onChange={(event) => editDraft({
                          options: event.target.value
                            .split(/\r?\n/u)
                            .filter((line) => line.trim())
                            .map((line) => {
                              const [value, ...label] = line.split('|');
                              return {
                                value: value!.trim(),
                                label: (label.join('|') || value)!.trim(),
                              };
                            }),
                        })}
                      />
                    )}
                  </Field>
                </div>
              ) : null}
            </div>
            <DialogActions>
              <Button type="button" onClick={() => setEditor(null)}>
                {t('actions.cancel')}
              </Button>
              <Button type="submit" variant="primary">
                {editor.index === null ? t('fields.addDraft') : t('fields.applyEdit')}
              </Button>
            </DialogActions>
          </form>
        ) : null}
      </Dialog>
      <Dialog
        open={removeIndex !== null}
        onClose={() => setRemoveIndex(null)}
        title={t('fields.removeTitle')}
        description={t('fields.removeDescription')}
        actions={(
          <>
            <Button type="button" onClick={() => setRemoveIndex(null)}>
              {t('actions.cancel')}
            </Button>
            <Button type="button" variant="danger" onClick={removeField}>
              {t('fields.remove')}
            </Button>
          </>
        )}
      >
        {removeIndex === null ? null : (
          <div className="forms-dialog-body">
            <code className="forms-dialog-target">
              {items[removeIndex]?.label || items[removeIndex]?.field_key}
            </code>
          </div>
        )}
      </Dialog>
    </>
  );
}

function SubmissionsPanel(input: {
  form: FormSummary;
  csrfToken: string;
  onSessionEnded: () => void;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation('forms');
  const [status, setStatus] = useState<'all' | FormSubmission['status']>('all');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<FormSubmission[]>([]);
  const [pages, setPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ all: 0, unread: 0, read: 0, archived: 0, spam: 0 });
  const [detail, setDetail] = useState<FormSubmissionDetail | null>(null);
  const [confirmation, setConfirmation] = useState<FormSubmission | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const detailCloseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController(); setFailure(null);
    void requestFormSubmissions(input.form.id, { status, page, per_page: FORM_DEFAULT_PAGE_SIZE }, controller.signal).then((response) => {
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setItems(response.data.items); setPages(response.data.pagination.total_pages); setTotal(response.data.pagination.total); setCounts(response.data.status_counts);
    }).catch((error) => { if (!controller.signal.aborted) setFailure(clientFailure(error)); });
    return () => controller.abort();
  }, [attempt, input.form.id, input.onSessionEnded, page, status]);
  const formatter = useMemo(() => new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' }), [i18n.resolvedLanguage]);
  async function openDetail(id: string) { setBusy(id); setFailure(null); try { const response = await requestFormSubmission(input.form.id, id); if (!response.success) { if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded(); else setFailure({ kind: 'api', code: response.error.code }); } else setDetail(response.data); } catch (error) { setFailure(clientFailure(error)); } finally { setBusy(null); } }
  async function changeStatus(item: FormSubmission, next: FormSubmission['status']) { if (busy) return; setBusy(item.id); setFailure(null); try { const response = await requestUpdateFormSubmission(input.csrfToken, input.form.id, item.id, next, item.updated_at_iso); if (!response.success) { if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded(); else setFailure({ kind: 'api', code: response.error.code }); } else { setItems((current) => current.map((value) => value.id === item.id ? response.data : value)); setDetail((value) => value?.id === item.id ? { ...value, ...response.data } : value); setAttempt((value) => value + 1); input.onChanged(); } } catch (error) { setFailure(clientFailure(error)); } finally { setBusy(null); } }
  async function remove() { if (!confirmation || busy) return; setBusy(confirmation.id); setFailure(null); try { const response = await requestDeleteFormSubmission(input.csrfToken, input.form.id, confirmation.id, confirmation.updated_at_iso); if (!response.success) { if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded(); else setFailure({ kind: 'api', code: response.error.code }); } else { setConfirmation(null); setDetail(null); setAttempt((value) => value + 1); input.onChanged(); } } catch (error) { setFailure(clientFailure(error)); } finally { setBusy(null); } }
  return (
    <Panel
      title={t('submissions.title')}
      description={t('submissions.description')}
      leading={<StudioIcon icon={Inbox} />}
      actions={(
        <span className="forms-total">
          {t('submissions.total', { count: total })}
        </span>
      )}
      footer={(
        <Pagination
          label={t('submissions.title')}
          position={t('pagination.summary', {
            page, pages: Math.max(1, pages),
          })}
          previousLabel={t('pagination.previous')}
          nextLabel={t('pagination.next')}
          page={page}
          totalPages={Math.max(1, pages)}
          onChange={setPage}
        />
      )}
    >
      <div className="forms-stack">
        <FilterTabs
          appearance="pills"
          label={t('submissions.statusFilter')}
          value={status}
          items={([
            ['all', counts.all],
            ['unread', counts.unread],
            ['read', counts.read],
            ['archived', counts.archived],
            ['spam', counts.spam],
          ] as const).map(([value, count]) => ({
            value,
            count,
            label: t(`status.${value}`),
          }))}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
        <ErrorNotice failure={failure} />
        {items.length === 0 ? (
          <EmptyState
            title={t('submissions.emptyTitle')}
            description={t('submissions.emptyDescription')}
          />
        ) : (
          <DataTable caption={t('submissions.title')} minWidthPx={820} stacked>
            <thead><tr>
              <th scope="col">{t('submissions.summary')}</th>
              <th scope="col">{t('submissions.submitter')}</th>
              <th scope="col">{t('submissions.status')}</th>
              <th scope="col">{t('submissions.submitted')}</th>
              <th scope="col">{t('submissions.actions')}</th>
            </tr></thead>
            <tbody>{items.map((item) => (
              <tr key={item.id}>
                <td data-label={t('submissions.summary')}>
                  {item.summary || '—'}
                </td>
                <td data-label={t('submissions.submitter')}>
                  {item.submitter_name || item.submitter_email || '—'}
                  {item.submitter_name && item.submitter_email ? (
                    <span className="forms-submitter-email">
                      {item.submitter_email}
                    </span>
                  ) : null}
                </td>
                <td data-label={t('submissions.status')}>
                  {/*
                   * Use a select for an editable status. Include the submission in its accessible
                   * name to distinguish repeated row controls.
                   */}
                  <select
                    className="forms-status-select"
                    aria-label={t('submissions.statusLabel', {
                      submission: item.summary || item.id,
                    })}
                    value={item.status}
                    disabled={busy === item.id}
                    onChange={(event) => void changeStatus(
                      item,
                      event.target.value as FormSubmission['status'],
                    )}
                  >
                    <option value="unread">{t('status.unread')}</option>
                    <option value="read">{t('status.read')}</option>
                    <option value="archived">{t('status.archived')}</option>
                    <option value="spam">{t('status.spam')}</option>
                  </select>
                </td>
                <td data-label={t('submissions.submitted')}>
                  {formatter.format(new Date(item.submitted_at_iso))}
                </td>
                <td data-label={t('submissions.actions')}>
                  <div className="forms-row-actions">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy === item.id}
                      onClick={() => void openDetail(item.id)}
                    >
                      <StudioIcon icon={Eye} className="navigation-icon" />
                      {t('actions.view')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="danger"
                      disabled={busy === item.id}
                      onClick={() => { setFailure(null); setConfirmation(item); }}
                    >
                      <StudioIcon icon={Trash2} className="navigation-icon" />
                      {t('actions.delete')}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}</tbody>
          </DataTable>
        )}
      </div>
      <Dialog
        open={detail !== null}
        size="wide"
        onClose={() => setDetail(null)}
        kicker={t('kicker')}
        title={t('submissions.detailTitle')}
        initialFocusRef={detailCloseRef}
        actions={(
          <Button
            ref={detailCloseRef}
            type="button"
            onClick={() => setDetail(null)}
          >
            {t('actions.close')}
          </Button>
        )}
      >
        {detail ? (
          <div className="forms-detail-body">
            <dl className="forms-detail-summary">
              <div>
                <dt>{t('submissions.status')}</dt>
                <dd>{t(`status.${detail.status}`)}</dd>
              </div>
              <div>
                <dt>{t('submissions.submitted')}</dt>
                <dd>{formatter.format(new Date(detail.submitted_at_iso))}</dd>
              </div>
              <div>
                <dt>{t('submissions.submitter')}</dt>
                <dd>
                  {detail.submitter_name || detail.submitter_email || '—'}
                </dd>
              </div>
              <div>
                <dt>{t('submissions.country')}</dt>
                <dd>{detail.country_code || '—'}</dd>
              </div>
              <div className="forms-detail-wide">
                <dt>{t('submissions.source')}</dt>
                <dd>{detail.source_url || '—'}</dd>
              </div>
            </dl>
            <h3 className="forms-detail-heading">{t('submissions.values')}</h3>
            {detail.values.length === 0 ? (
              <p className="forms-detail-empty">{t('submissions.noValues')}</p>
            ) : (
              <dl className="forms-detail-summary">
                {detail.values.map((value, index) => (
                  <div key={`${value.field_id ?? value.field_key}-${index}`}>
                    <dt>{value.label}</dt>
                    <dd>{value.value || '—'}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        ) : null}
      </Dialog>
      {confirmation ? <ConfirmationDialog title={t('submissions.deleteTitle')} description={t('submissions.deleteDescription')} target={confirmation.summary || confirmation.id} busy={busy === confirmation.id} failure={failure} onClose={() => { setConfirmation(null); setFailure(null); }} onConfirm={() => void remove()} /> : null}
    </Panel>
  );
}

export function FormsPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('forms');
  const [tab, setTab] = useState<Tab>('submissions');
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [formStatus, setFormStatus] = useState<'all' | FormSummary['status']>('all');
  const [formSearchInput, setFormSearchInput] = useState('');
  const [formSearch, setFormSearch] = useState('');
  const [formPage, setFormPage] = useState(1);
  const [formPages, setFormPages] = useState(0);
  const [formTotal, setFormTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [creating, setCreating] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useStudioDocumentTitle(t('documentTitle'));
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    void requestForms({
      status: formStatus,
      search: formSearch,
      page: formPage,
      per_page: FORM_LIST_PAGE_SIZE,
    }, controller.signal).then((list) => {
      if (!list.success) {
        if (list.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
        else setFailure({ kind: 'api', code: list.error.code });
        return;
      }
      if (
        list.data.pagination.total_pages > 0
        && formPage > list.data.pagination.total_pages
      ) {
        setFormPage(list.data.pagination.total_pages);
        return;
      }
      setForms(list.data.items);
      setFormPages(list.data.pagination.total_pages);
      setFormTotal(list.data.pagination.total);
      setSelectedId((current) => list.data.items.some((form) => form.id === current)
        ? current
        : list.data.items[0]?.id ?? '');
    }).catch((error) => { if (!controller.signal.aborted) setFailure(clientFailure(error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt, formPage, formSearch, formStatus, input.onSessionEnded]);
  const selected = forms.find((form) => form.id === selectedId) ?? null;
  function updateSummary(value: FormSummary) { setForms((current) => current.map((form) => form.id === value.id ? value : form)); }
  async function reloadSelected() { if (!selectedId) return; try { const response = await requestForm(selectedId); if (response.success) updateSummary(response.data); else if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded(); } catch { setAttempt((value) => value + 1); } }
  function selectForm(id: string) {
    if (dirty) return;
    setSelectedId(id);
    setTab('submissions');
  }
  async function create(value: { slug: string; title: string }) {
    if (createBusy) return;
    setCreateBusy(true);
    setFailure(null);
    try {
      const response = await requestCreateForm(input.data.csrf_token, {
        ...value,
        description: null,
        status: 'draft',
        submit_label: 'Submit',
        success_message: null,
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
        } else {
          setFailure({ kind: 'api', code: response.error.code });
        }
        return;
      }
      const nextTotal = formTotal + 1;
      setFormSearchInput('');
      setFormSearch('');
      setFormStatus('all');
      setFormPage(1);
      setFormTotal(nextTotal);
      setFormPages(Math.max(1, Math.ceil(nextTotal / FORM_LIST_PAGE_SIZE)));
      setForms((current) => [
        response.data,
        ...current.filter((form) => form.id !== response.data.id),
      ]);
      setSelectedId(response.data.id);
      setTab('settings');
      setCreating(false);
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setCreateBusy(false);
    }
  }
  const filtersActive = Boolean(formSearch) || formStatus !== 'all';
  return (
    <main
      id="studio-main-content"
      aria-labelledby="forms-title"
    >
      <PageHeader
        titleId="forms-title"
        kicker={t('kicker')}
        title={t('title')}
        description={t('description')}
        actions={(
          <Button
            type="button"
            variant="primary"
            disabled={dirty}
            onClick={() => { setFailure(null); setCreating(true); }}
          >
            <StudioIcon icon={Plus} className="navigation-icon" />
            {t('create')}
          </Button>
        )}
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
      {!loading && !failure && forms.length === 0 && !filtersActive ? (
        <EmptyState
          headingLevel={2}
          title={t('empty.title')}
          description={t('empty.description')}
          actions={(
            <Button
              type="button"
              variant="primary"
              onClick={() => setCreating(true)}
            >
              <StudioIcon icon={Plus} className="navigation-icon" />
              {t('create')}
            </Button>
          )}
        />
      ) : null}
      {!loading && !failure && (forms.length > 0 || filtersActive) ? (
        <div className="forms-workspace">
          <aside className="forms-sidebar" aria-label={t('listLabel')}>
            <header className="forms-sidebar-header">
              <h2>{t('listLabel')}</h2>
              <span className="forms-sidebar-total">
                {t('list.total', { count: formTotal })}
              </span>
            </header>
            <form
              className="forms-list-tools"
              onSubmit={(event) => {
                event.preventDefault();
                setFormPage(1);
                setFormSearch(formSearchInput.trim());
              }}
            >
              <Field label={t('list.searchLabel')} labelHidden leading={<StudioIcon icon={Search} />}>
                {(control) => (
                  <input
                    {...control}
                    type="search"
                    value={formSearchInput}
                    maxLength={200}
                    placeholder={t('list.searchPlaceholder')}
                    disabled={dirty}
                    onChange={(event) => setFormSearchInput(event.target.value)}
                  />
                )}
              </Field>
              <Button type="submit" size="sm" disabled={dirty}>
                {t('list.search')}
              </Button>
              <Field label={t('list.statusLabel')} labelHidden>
                {(control) => (
                  <select
                    {...control}
                    value={formStatus}
                    disabled={dirty}
                    onChange={(event) => {
                      setFormStatus(event.target.value as typeof formStatus);
                      setFormPage(1);
                    }}
                  >
                    <option value="all">{t('status.all')}</option>
                    <option value="draft">{t('status.draft')}</option>
                    <option value="active">{t('status.active')}</option>
                    <option value="disabled">{t('status.disabled')}</option>
                    <option value="archived">{t('status.archived')}</option>
                  </select>
                )}
              </Field>
            </form>
            <div className="forms-mobile-selector">
              <Field label={t('list.selectLabel')} labelHidden leading={<StudioIcon icon={FileText} />}>
                {(control) => (
                  <select
                    {...control}
                    value={selectedId}
                    disabled={dirty || forms.length === 0}
                    onChange={(event) => selectForm(event.target.value)}
                  >
                    {forms.length === 0 ? (
                      <option value="">{t('list.noMatches')}</option>
                    ) : null}
                    {forms.map((form) => (
                      <option key={form.id} value={form.id}>
                        {`${form.title} (/${form.slug})`}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            {forms.length === 0 ? (
              <div className="forms-list-empty">
                <p>{t('list.noMatches')}</p>
                <Button
                  type="button"
                  size="sm"
                  disabled={dirty}
                  onClick={() => {
                    setFormSearchInput('');
                    setFormSearch('');
                    setFormStatus('all');
                    setFormPage(1);
                  }}
                >
                  {t('list.clearFilters')}
                </Button>
              </div>
            ) : (
              <ul className="forms-target-list">
                {forms.map((form) => (
                  <li key={form.id}>
                    <button
                      type="button"
                      className="forms-target"
                      aria-current={form.id === selectedId ? 'true' : undefined}
                      disabled={dirty}
                      onClick={() => selectForm(form.id)}
                    >
                      <span className="forms-target-top">
                        <strong className="forms-target-name">{form.title}</strong>
                        {form.unread_count > 0 ? (
                          <span className="forms-target-count">
                            {t('list.unreadCount', { count: form.unread_count })}
                          </span>
                        ) : null}
                      </span>
                      <span className="forms-target-bottom">
                        <code>/{form.slug}</code>
                        <StatusPill tone={STATUS_TONE[form.status]}>
                          {t(`status.${form.status}`)}
                        </StatusPill>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {formPages > 1 ? (
              <nav className="forms-list-pagination" aria-label={t('list.paginationLabel')}>
                <Button
                  type="button"
                  size="sm"
                  disabled={dirty || formPage <= 1}
                  aria-label={t('pagination.previous')}
                  onClick={() => setFormPage((value) => Math.max(1, value - 1))}
                >
                  <StudioIcon icon={ArrowLeft} />
                </Button>
                <span>{t('pagination.summary', { page: formPage, pages: formPages })}</span>
                <Button
                  type="button"
                  size="sm"
                  disabled={dirty || formPage >= formPages}
                  aria-label={t('pagination.next')}
                  onClick={() => setFormPage((value) => Math.min(formPages, value + 1))}
                >
                  <StudioIcon icon={ArrowRight} />
                </Button>
              </nav>
            ) : null}
          </aside>
          <section className="forms-editor">
            {!selected ? (
              <EmptyState
                headingLevel={2}
                title={t('list.noMatches')}
                description={t('list.noMatchesDescription')}
              />
            ) : (
              <>
                <header className="forms-selected-header">
                  <div className="forms-selected-copy">
                    <span className="forms-selected-icon">
                      <StudioIcon icon={FileText} />
                    </span>
                    <div>
                      <h2>{selected.title}</h2>
                      <p>{selected.description || `/${selected.slug}`}</p>
                    </div>
                  </div>
                  <StatusPill tone={STATUS_TONE[selected.status]}>
                    {t(`status.${selected.status}`)}
                  </StatusPill>
                </header>
                <Tabs
                  label={t('tabs.label')}
                  value={tab}
                  items={[
                    {
                      value: 'submissions',
                      label: t('tabs.submissions'),
                      icon: Inbox,
                      count: String(selected.submissions_count),
                    },
                    {
                      value: 'fields',
                      label: t('tabs.fields'),
                      icon: List,
                      count: String(selected.fields_count),
                    },
                    {
                      value: 'notifications',
                      label: t('tabs.notifications'),
                      icon: Bell,
                    },
                    {
                      value: 'settings',
                      label: t('tabs.settings'),
                      icon: Settings2,
                    },
                  ] as const}
                  disabled={dirty}
                  onChange={setTab}
                >
                  {tab === 'submissions' ? (
                    <SubmissionsPanel
                      form={selected}
                      csrfToken={input.data.csrf_token}
                      onSessionEnded={input.onSessionEnded}
                      onChanged={() => void reloadSelected()}
                    />
                  ) : null}
                  {tab === 'fields' ? (
                    <FieldsPanel
                      form={selected}
                      csrfToken={input.data.csrf_token}
                      onSessionEnded={input.onSessionEnded}
                      onChanged={() => void reloadSelected()}
                      onDirtyChange={setDirty}
                    />
                  ) : null}
                  {tab === 'notifications' ? (
                    <NotificationsPanel
                      form={selected}
                      csrfToken={input.data.csrf_token}
                      onSessionEnded={input.onSessionEnded}
                      onUpdated={(updatedAtIso) => {
                        updateSummary({
                          ...selected,
                          updated_at_iso: updatedAtIso,
                        });
                      }}
                      onDirtyChange={setDirty}
                    />
                  ) : null}
                  {tab === 'settings' ? (
                    <SettingsPanel
                      form={selected}
                      csrfToken={input.data.csrf_token}
                      onSessionEnded={input.onSessionEnded}
                      onUpdated={updateSummary}
                      onDeleted={() => {
                        setDirty(false);
                        setSelectedId('');
                        setTab('submissions');
                        setAttempt((value) => value + 1);
                      }}
                      onDirtyChange={setDirty}
                    />
                  ) : null}
                </Tabs>
              </>
            )}
          </section>
        </div>
      ) : null}
      {creating ? <CreateFormDialog busy={createBusy} failure={failure} onCreate={(value) => void create(value)} onClose={() => { if (!createBusy) { setCreating(false); setFailure(null); } }} /> : null}
    </main>
  );
}

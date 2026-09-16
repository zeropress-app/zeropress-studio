import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../contracts/api';
import {
  materializeMailSettingsDefaults,
  sendTestMailRequestSchema,
  testMailConnectionRequestSchema,
  updateMailSettingsRequestSchema,
  type MailSettings,
  type MailSettingsDocument,
} from '../../contracts/mail-settings';
import type { CurrentSessionSuccess } from '../../contracts/session';
import {
  Button,
  Dialog,
  Field,
  Notice,
  Panel,
} from './components/primitives';
import { SettingsScreen } from './components/SettingsScreen';
import {
  MailSettingsClientError,
  requestMailSettings,
  requestSendTestMail,
  requestTestMailConnection,
  requestUpdateMailSettings,
  type MailSettingsClientErrorCode,
} from './lib/mail-settings-client';

type AccountSession = CurrentSessionSuccess['data'];
type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: MailSettingsClientErrorCode }
  | { kind: 'unexpected' };
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: MailSettingsDocument }
  | { kind: 'error'; failure: Failure };
type SaveState =
  | { kind: 'idle' | 'saving' | 'saved' | 'validation' | 'conflict' }
  | { kind: 'failed'; failure: Failure };
type TestState =
  | { kind: 'idle' | 'running' | 'connection_success' | 'mail_success' }
  | { kind: 'failed'; failure: Failure };

type CredentialDraft = {
  resend: string;
  cloudflare: string;
  removeResend: boolean;
  removeCloudflare: boolean;
};

function clientFailure(error: unknown): Failure {
  return error instanceof MailSettingsClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

function settingsEqual(left: MailSettings, right: MailSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function credentialActions(draft: CredentialDraft) {
  return {
    resend_api_key: draft.removeResend
      ? { action: 'remove' as const }
      : draft.resend
        ? { action: 'replace' as const, value: draft.resend }
        : { action: 'preserve' as const },
    cloudflare_api_token: draft.removeCloudflare
      ? { action: 'remove' as const }
      : draft.cloudflare
        ? { action: 'replace' as const, value: draft.cloudflare }
        : { action: 'preserve' as const },
  };
}

const EMPTY_CREDENTIAL_DRAFT: CredentialDraft = {
  resend: '',
  cloudflare: '',
  removeResend: false,
  removeCloudflare: false,
};

export function MailSettingsPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('mailSettings');
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  const [testConfirmationOpen, setTestConfirmationOpen] = useState(false);
  const [draft, setDraft] = useState<MailSettings>(materializeMailSettingsDefaults());
  const [credentialDraft, setCredentialDraft] = useState<CredentialDraft>(EMPTY_CREDENTIAL_DRAFT);
  const [recipient, setRecipient] = useState(input.data.user.email);
  const testDialogCancelRef = useRef<HTMLButtonElement>(null);
  const settingsDocument = loadState.kind === 'ready' ? loadState.document : null;
  const hasCredentialChanges = Boolean(
    credentialDraft.resend
    || credentialDraft.cloudflare
    || credentialDraft.removeResend
    || credentialDraft.removeCloudflare,
  );
  const hasChanges = settingsDocument !== null && (
    !settingsEqual(draft, settingsDocument.settings) || hasCredentialChanges
  );
  const updateRequest = useMemo(() => settingsDocument
    ? {
        settings: draft,
        credentials: credentialActions(credentialDraft),
        expected_revision: settingsDocument.revision,
      }
    : null, [credentialDraft, draft, settingsDocument]);
  const resendCredentialAvailable = !credentialDraft.removeResend && Boolean(
    credentialDraft.resend
    || settingsDocument?.credentials.resend_api_key_configured,
  );
  const cloudflareCredentialAvailable = !credentialDraft.removeCloudflare
    && Boolean(
      credentialDraft.cloudflare
      || settingsDocument?.credentials.cloudflare_api_token_configured,
    );
  const selectedCredentialAvailable = draft.provider === 'disabled'
    || (draft.provider === 'resend' && resendCredentialAvailable)
    || (draft.provider === 'cloudflare' && cloudflareCredentialAvailable);
  const connectionRequest = draft.provider === 'resend'
    ? {
        provider: 'resend' as const,
        ...(credentialDraft.resend
          ? { credential: credentialDraft.resend }
          : {}),
      }
    : draft.provider === 'cloudflare'
      ? {
          provider: 'cloudflare' as const,
          cloudflare_account_id: draft.cloudflare_account_id,
          ...(credentialDraft.cloudflare
            ? { credential: credentialDraft.cloudflare }
            : {}),
        }
      : null;
  const connectionAvailable = connectionRequest !== null
    && (draft.provider === 'resend'
      ? resendCredentialAvailable
      : cloudflareCredentialAvailable)
    && testMailConnectionRequestSchema.safeParse(connectionRequest).success;
  const testRecipientValid = sendTestMailRequestSchema.safeParse({
    recipient,
  }).success;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setSaveState({ kind: 'idle' });
    setTestState({ kind: 'idle' });
    void requestMailSettings(controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({ kind: 'error', failure: { kind: 'api', code: response.error.code } });
        return;
      }
      setDraft({ ...response.data.settings });
      setCredentialDraft(EMPTY_CREDENTIAL_DRAFT);
      setLoadState({ kind: 'ready', document: response.data });
    }).catch((error) => {
      if (!active || controller.signal.aborted) return;
      setLoadState({ kind: 'error', failure: clientFailure(error) });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, input.onSessionEnded]);

  function edit<K extends keyof MailSettings>(key: K, value: MailSettings[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaveState((current) => current.kind === 'conflict' ? current : { kind: 'idle' });
    setTestState({ kind: 'idle' });
  }

  function editCredential(update: Partial<CredentialDraft>) {
    setCredentialDraft((current) => ({ ...current, ...update }));
    setSaveState((current) => current.kind === 'conflict' ? current : { kind: 'idle' });
    setTestState({ kind: 'idle' });
  }

  function failureMessage(failure: Failure): string {
    if (failure.kind === 'client') {
      if (failure.code === 'TIMEOUT') return t('errors.timeout');
      if (failure.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (failure.kind === 'api') {
      if (failure.code === 'FORBIDDEN') return t('errors.forbidden');
      if (failure.code === 'MAIL_CREDENTIAL_NOT_CONFIGURED') return t('errors.credentialMissing');
      if (failure.code === 'MAIL_PROVIDER_AUTHENTICATION_FAILED') return t('errors.authentication');
      if (failure.code === 'MAIL_PROVIDER_REQUEST_REJECTED') return t('errors.rejected');
      if (failure.code === 'MAIL_PROVIDER_UNAVAILABLE') return t('errors.unavailable');
      if (failure.code === 'MAIL_PROVIDER_RESPONSE_INVALID') return t('errors.providerResponse');
    }
    return t('errors.api');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!updateRequest || !hasChanges || saveState.kind === 'saving' || saveState.kind === 'conflict') return;
    const parsed = updateMailSettingsRequestSchema.safeParse(updateRequest);
    if (!parsed.success) {
      setSaveState({ kind: 'validation' });
      return;
    }
    if (!selectedCredentialAvailable) {
      setSaveState({
        kind: 'failed',
        failure: { kind: 'api', code: 'MAIL_CREDENTIAL_NOT_CONFIGURED' },
      });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      const response = await requestUpdateMailSettings(
        input.data.csrf_token,
        parsed.data,
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          setSaveState({ kind: 'idle' });
          input.onSessionEnded();
          return;
        }
        if (response.error.code === 'SETTINGS_REVISION_CONFLICT') {
          setSaveState({ kind: 'conflict' });
          return;
        }
        if (response.error.code === 'VALIDATION_ERROR') {
          setSaveState({ kind: 'validation' });
          return;
        }
        setSaveState({ kind: 'failed', failure: { kind: 'api', code: response.error.code } });
        return;
      }
      setDraft({ ...response.data.settings });
      setCredentialDraft(EMPTY_CREDENTIAL_DRAFT);
      setLoadState({ kind: 'ready', document: response.data });
      setSaveState({ kind: 'saved' });
    } catch (error) {
      setSaveState({ kind: 'failed', failure: clientFailure(error) });
    }
  }

  async function testConnection() {
    if (draft.provider === 'disabled' || testState.kind === 'running') return;
    setTestState({ kind: 'running' });
    if (!connectionRequest) return;
    try {
      const response = await requestTestMailConnection(
        input.data.csrf_token,
        connectionRequest,
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setTestState({ kind: 'failed', failure: { kind: 'api', code: response.error.code } });
        return;
      }
      setTestState({ kind: 'connection_success' });
    } catch (error) {
      setTestState({ kind: 'failed', failure: clientFailure(error) });
    }
  }

  async function sendTest() {
    if (!settingsDocument?.configured || hasChanges || !testRecipientValid || testState.kind === 'running') return;
    setTestState({ kind: 'running' });
    try {
      const response = await requestSendTestMail(
        input.data.csrf_token,
        { recipient },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setTestState({ kind: 'failed', failure: { kind: 'api', code: response.error.code } });
        return;
      }
      setTestState({ kind: 'mail_success' });
      setTestConfirmationOpen(false);
    } catch (error) {
      setTestState({ kind: 'failed', failure: clientFailure(error) });
    }
  }

  function openTestConfirmation() {
    if (
      !settingsDocument?.configured
      || hasChanges
      || !testRecipientValid
      || testState.kind === 'running'
    ) return;
    setTestConfirmationOpen(true);
  }

  const lastSaved = settingsDocument?.updated_at_iso
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' })
      .format(new Date(settingsDocument.updated_at_iso))
    : null;

  const saving = saveState.kind === 'saving';
  const credentials = settingsDocument?.credentials;
  return (
    <SettingsScreen
      navigation="edge"
      copy={{
        documentTitle: t('documentTitle'),
        kicker: t('kicker'),
        title: t('title'),
        description: t('description'),
        loading: {
          title: t('loading.title'),
          description: t('loading.description'),
        },
        loadError: {
          title: t('loadError.title'),
          description: t('loadError.description'),
        },
        saved: t('state.saved'),
        validation: t('errors.validation'),
        conflict: {
          title: t('errors.conflictTitle'),
          description: t('errors.conflictDescription'),
        },
        save: t('actions.save'),
      }}
      load={loadState.kind}
      onRetry={() => setAttempt((value) => value + 1)}
      save={saveState.kind === 'failed' ? 'idle' : saveState.kind}
      error={saveState.kind === 'failed'
        ? failureMessage(saveState.failure)
        : null}
      reload={{
        label: t('errors.reload'),
        onReload: () => setAttempt((value) => value + 1),
      }}
      dirty={hasChanges}
      statusDetail={lastSaved
        ? t('state.lastSaved', { date: lastSaved })
        : t('state.defaults')}
      onReset={() => {
        if (settingsDocument) setDraft({ ...settingsDocument.settings });
        setCredentialDraft(EMPTY_CREDENTIAL_DRAFT);
        setSaveState({ kind: 'idle' });
      }}
      onSubmit={(event) => void save(event)}
    >
      <Panel
        layout="split"
        title={t('provider.title')}
        description={t('provider.description')}
      >
        <div className="settings-fields">
          <Field
            label={t('fields.provider.label')}
            hint={t('fields.provider.description')}
          >
            {(control) => (
              <select
                {...control}
                value={draft.provider}
                disabled={saving}
                onChange={(event) => edit(
                  'provider',
                  event.target.value as MailSettings['provider'],
                )}
              >
                <option value="disabled">{t('fields.provider.disabled')}</option>
                <option value="resend">Resend</option>
                <option value="cloudflare">Cloudflare Email Service</option>
              </select>
            )}
          </Field>
          <Field
            label={t('fields.fromEmail.label')}
            hint={t('fields.fromEmail.description')}
          >
            {(control) => (
              <input
                {...control}
                type="email"
                value={draft.from_email}
                disabled={saving}
                onChange={(event) => edit('from_email', event.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('fields.fromName.label')}
            hint={t('fields.fromName.description')}
          >
            {(control) => (
              <input
                {...control}
                value={draft.from_name}
                disabled={saving}
                onChange={(event) => edit('from_name', event.target.value)}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        layout="split"
        title={t('credentials.title')}
        description={t('credentials.description')}
      >
        <div className="settings-fields">
          {draft.provider === 'resend' ? (
            <>
              <Field
                label={t('fields.resendKey.label')}
                hint={t('fields.resendKey.description')}
              >
                {(control) => (
                  <input
                    {...control}
                    type="password"
                    autoComplete="new-password"
                    value={credentialDraft.resend}
                    placeholder={credentials?.resend_api_key_configured
                      ? t('credentials.savedPlaceholder')
                      : ''}
                    disabled={saving}
                    onChange={(event) => editCredential({
                      resend: event.target.value,
                      removeResend: false,
                    })}
                  />
                )}
              </Field>
              {credentials?.resend_api_key_configured ? (
                <label className="mail-credential-remove">
                  <input
                    type="checkbox"
                    checked={credentialDraft.removeResend}
                    onChange={(event) => editCredential({
                      removeResend: event.target.checked,
                      resend: '',
                    })}
                  />
                  <span>{t('credentials.removeSaved')}</span>
                </label>
              ) : null}
            </>
          ) : null}
          {draft.provider === 'cloudflare' ? (
            <>
              <Field
                label={t('fields.accountId.label')}
                hint={t('fields.accountId.description')}
              >
                {(control) => (
                  <input
                    {...control}
                    value={draft.cloudflare_account_id}
                    disabled={saving}
                    onChange={(event) => edit(
                      'cloudflare_account_id',
                      event.target.value,
                    )}
                  />
                )}
              </Field>
              <Field
                label={t('fields.cloudflareToken.label')}
                hint={t('fields.cloudflareToken.description')}
              >
                {(control) => (
                  <input
                    {...control}
                    type="password"
                    autoComplete="new-password"
                    value={credentialDraft.cloudflare}
                    placeholder={credentials?.cloudflare_api_token_configured
                      ? t('credentials.savedPlaceholder')
                      : ''}
                    disabled={saving}
                    onChange={(event) => editCredential({
                      cloudflare: event.target.value,
                      removeCloudflare: false,
                    })}
                  />
                )}
              </Field>
              {credentials?.cloudflare_api_token_configured ? (
                <label className="mail-credential-remove">
                  <input
                    type="checkbox"
                    checked={credentialDraft.removeCloudflare}
                    onChange={(event) => editCredential({
                      removeCloudflare: event.target.checked,
                      cloudflare: '',
                    })}
                  />
                  <span>{t('credentials.removeSaved')}</span>
                </label>
              ) : null}
            </>
          ) : null}
          {draft.provider !== 'disabled' ? (
            <Button
              type="button"
              disabled={testState.kind === 'running' || !connectionAvailable}
              onClick={() => void testConnection()}
            >
              {testState.kind === 'running'
                ? t('tests.running')
                : t('tests.connection')}
            </Button>
          ) : null}
        </div>
      </Panel>

      <Panel
        layout="split"
        title={t('tests.title')}
        description={t('tests.description')}
      >
        <div className="settings-fields">
          <Field
            label={t('fields.recipient.label')}
            hint={t('fields.recipient.description')}
          >
            {(control) => (
              <input
                {...control}
                type="email"
                value={recipient}
                onChange={(event) => {
                  setRecipient(event.target.value);
                  setTestState({ kind: 'idle' });
                }}
              />
            )}
          </Field>
          <Button
            type="button"
            disabled={!settingsDocument?.configured
              || hasChanges
              || !testRecipientValid
              || testState.kind === 'running'}
            onClick={openTestConfirmation}
          >
            {testState.kind === 'running' ? t('tests.running') : t('tests.send')}
          </Button>
          {testState.kind === 'connection_success' ? (
            <Notice tone="success">
              {settingsDocument?.configured && !hasChanges
                ? t('tests.connectionSuccess')
                : t('tests.connectionSuccessSaveFirst')}
            </Notice>
          ) : null}
          {testState.kind === 'mail_success' ? (
            <Notice tone="success">{t('tests.mailSuccess')}</Notice>
          ) : null}
          {testState.kind === 'failed' ? (
            <Notice tone="error">{failureMessage(testState.failure)}</Notice>
          ) : null}
        </div>
      </Panel>

      <Dialog
        open={testConfirmationOpen && settingsDocument !== null}
        busy={testState.kind === 'running'}
        onClose={() => setTestConfirmationOpen(false)}
        kicker={t('confirmation.kicker')}
        title={t('confirmation.title')}
        description={t('confirmation.description')}
        initialFocusRef={testDialogCancelRef}
        actions={(
          <>
            <Button
              ref={testDialogCancelRef}
              type="button"
              disabled={testState.kind === 'running'}
              onClick={() => setTestConfirmationOpen(false)}
            >
              {t('confirmation.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={testState.kind === 'running'}
              onClick={() => void sendTest()}
            >
              {testState.kind === 'running'
                ? t('confirmation.sending')
                : t('confirmation.confirm')}
            </Button>
          </>
        )}
      >
        {settingsDocument ? (
          <div className="mail-test-body">
            <dl className="mail-test-summary">
              <div>
                <dt>{t('confirmation.provider')}</dt>
                <dd>
                  {settingsDocument.settings.provider === 'resend'
                    ? 'Resend'
                    : 'Cloudflare Email Service'}
                </dd>
              </div>
              <div>
                <dt>{t('confirmation.sender')}</dt>
                <dd>
                  {settingsDocument.settings.from_name
                    ? `${settingsDocument.settings.from_name} <${settingsDocument.settings.from_email}>`
                    : settingsDocument.settings.from_email}
                </dd>
              </div>
              <div>
                <dt>{t('confirmation.recipient')}</dt>
                <dd>{recipient}</dd>
              </div>
            </dl>
            {testState.kind === 'failed' ? (
              <Notice tone="error">{failureMessage(testState.failure)}</Notice>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </SettingsScreen>
  );
}

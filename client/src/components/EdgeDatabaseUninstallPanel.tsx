import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { DatabaseX } from 'lucide-react';
import {
  EDGE_DATABASE_UNINSTALL_CONFIRMATION,
  type EdgeDatabaseStatus,
  type EdgeDatabaseUninstallRequest,
} from '../../../contracts/edge-database-lifecycle';
import type { EdgeIntegrationMode } from '../../../contracts/session';
import { createDeletionReport } from '../lib/deletion-report';
import {
  OperationsClientError,
  requestEdgeDatabaseUninstall,
  requestEdgeDatabaseUninstallPreview,
} from '../lib/operations-client';
import { useBusyChange, type BusyChangeHandler } from '../hooks/useBusyChange';
import {
  Button,
  Callout,
  Dialog,
  DialogActions,
  Field,
  Notice,
  Panel,
  Spinner,
  StudioIcon,
} from './primitives';

type Stage = 'entry' | 'confirm' | 'completed';

export function EdgeDatabaseUninstallPanel(props: {
  token: string;
  status: EdgeDatabaseStatus;
  edgeIntegrationMode: EdgeIntegrationMode;
  studioDatabaseReady: boolean;
  refreshStatus: () => Promise<void>;
  headingLevel?: 2 | 3;
  onBusyChange?: BusyChangeHandler;
}) {
  const { t } = useTranslation('operations');
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<Stage>('entry');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [backup, setBackup] = useState(false);
  const [publicWritesStopped, setPublicWritesStopped] = useState(false);
  const [pendingMailAcknowledged, setPendingMailAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [rows, setRows] = useState<Record<string, number> | null>(null);
  const [message, setMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  useBusyChange(props.onBusyChange, mutationBusy);
  const report = useMemo(
    () => rows ? createDeletionReport(rows) : null,
    [rows],
  );

  const available = props.studioDatabaseReady
    && props.status.state === 'ready'
    && props.edgeIntegrationMode === 'disabled';

  function unavailableMessage(): string {
    if (!props.studioDatabaseReady) {
      return t('edgeUninstall.unavailable.studioDatabase');
    }
    if (props.edgeIntegrationMode !== 'disabled') {
      return t('edgeUninstall.unavailable.integrationEnabled');
    }
    return t('edgeUninstall.unavailable.edgeDatabase', {
      state: props.status.state,
    });
  }

  function resetDialog() {
    setOpen(false);
    setStage('entry');
    setPassword('');
    setBackup(false);
    setPublicWritesStopped(false);
    setPendingMailAcknowledged(false);
    setConfirmation('');
    setRows(null);
  }

  function closeDialog() {
    if (busy) return;
    resetDialog();
  }

  function requestBody(): EdgeDatabaseUninstallRequest {
    return {
      administrator_email: email,
      administrator_password: password,
      backup_acknowledged: true,
      public_edge_writes_disabled: true,
      pending_mail_acknowledged: true,
      confirmation: EDGE_DATABASE_UNINSTALL_CONFIRMATION,
    };
  }

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!available || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await requestEdgeDatabaseUninstallPreview({
        token: props.token,
        request: requestBody(),
      });
      if (!response.success) {
        setMessage({
          tone: 'error',
          text: t('edgeUninstall.errors.api', { code: response.error.code }),
        });
        return;
      }
      setRows(response.data.expected_effects.deleted_rows);
      setStage('confirm');
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof OperationsClientError
          ? t('edgeUninstall.errors.client', { code: error.code })
          : t('edgeUninstall.errors.unexpected'),
      });
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    if (!available || busy || stage !== 'confirm' || rows === null) return;
    setMutationBusy(true);
    setBusy(true);
    setMessage(null);
    try {
      const response = await requestEdgeDatabaseUninstall({
        token: props.token,
        request: requestBody(),
      });
      if (!response.success) {
        setMessage({
          tone: 'error',
          text: t('edgeUninstall.errors.api', { code: response.error.code }),
        });
        return;
      }
      setRows(response.data.effects.deleted_rows);
      setPassword('');
      setStage('completed');
      setMessage({ tone: 'success', text: t('edgeUninstall.completed') });
      await props.refreshStatus();
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof OperationsClientError
          ? t('edgeUninstall.errors.client', { code: error.code })
          : t('edgeUninstall.errors.unexpected'),
      });
    } finally {
      setBusy(false);
      setMutationBusy(false);
    }
  }

  return (
    <>
      <Panel
        headingLevel={props.headingLevel ?? 3}
        leading={<StudioIcon icon={DatabaseX} />}
        kicker={t('edgeUninstall.level')}
        title={t('edgeUninstall.title')}
        description={t('edgeUninstall.description')}
      >
        <div className="operations-content-card">
          <Callout tone="warning" title={t('edgeUninstall.scopeTitle')}>
            {t('edgeUninstall.scopeDescription')}
          </Callout>
          {!available ? (
            <Notice tone="warning">{unavailableMessage()}</Notice>
          ) : null}
          <div className="operations-actions">
            <Button
              type="button"
              variant="danger"
              disabled={!available || busy}
              onClick={() => {
                setMessage(null);
                setOpen(true);
              }}
            >
              <StudioIcon className="operations-button-icon" icon={DatabaseX} />
              {t('edgeUninstall.open')}
            </Button>
          </div>
        </div>
      </Panel>

      <Dialog
        open={open}
        onClose={closeDialog}
        busy={busy}
        size="wide"
        kicker={t('edgeUninstall.level')}
        title={stage === 'entry'
          ? t('edgeUninstall.dialog.entryTitle')
          : stage === 'confirm'
            ? t('edgeUninstall.dialog.confirmTitle')
            : t('edgeUninstall.dialog.completedTitle')}
        description={stage === 'entry'
          ? t('edgeUninstall.dialog.entryDescription')
          : stage === 'confirm'
            ? t('edgeUninstall.dialog.confirmDescription')
            : t('edgeUninstall.dialog.completedDescription')}
      >
        {stage === 'entry' ? (
          <form
            className="operations-upgrade-form"
            onSubmit={preview}
            noValidate
          >
            <Field label={t('credentials.email')}>
              {(control) => (
                <input
                  {...control}
                  type="email"
                  autoComplete="username"
                  maxLength={254}
                  value={email}
                  required
                  disabled={busy}
                  onChange={(event) => setEmail(event.target.value)}
                />
              )}
            </Field>
            <Field label={t('credentials.password')}>
              {(control) => (
                <input
                  {...control}
                  type="password"
                  autoComplete="current-password"
                  maxLength={1024}
                  value={password}
                  required
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </Field>
            <label className="operations-acknowledgement">
              <input
                type="checkbox"
                checked={backup}
                disabled={busy}
                onChange={(event) => setBackup(event.target.checked)}
              />
              <span>{t('edgeUninstall.backupAcknowledgement')}</span>
            </label>
            <label className="operations-acknowledgement">
              <input
                type="checkbox"
                checked={publicWritesStopped}
                disabled={busy}
                onChange={(event) => setPublicWritesStopped(
                  event.target.checked,
                )}
              />
              <span>{t('edgeUninstall.publicWritesAcknowledgement')}</span>
            </label>
            <label className="operations-acknowledgement">
              <input
                type="checkbox"
                checked={pendingMailAcknowledged}
                disabled={busy}
                onChange={(event) => setPendingMailAcknowledged(
                  event.target.checked,
                )}
              />
              <span>{t('edgeUninstall.pendingMailAcknowledgement')}</span>
            </label>
            <Field
              label={t('edgeUninstall.confirmation')}
              labelAdornment={(
                <code className="operations-code">
                  {EDGE_DATABASE_UNINSTALL_CONFIRMATION}
                </code>
              )}
            >
              {(control) => (
                <input
                  {...control}
                  value={confirmation}
                  autoComplete="off"
                  disabled={busy}
                  required
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              )}
            </Field>
            {message ? <Notice tone="error">{message.text}</Notice> : null}
            <DialogActions>
              <Button type="button" disabled={busy} onClick={closeDialog}>
                {t('confirmation.cancel')}
              </Button>
              <Button
                type="submit"
                variant="danger"
                disabled={
                  busy
                  || email.length === 0
                  || password.length === 0
                  || !backup
                  || !publicWritesStopped
                  || !pendingMailAcknowledged
                  || confirmation !== EDGE_DATABASE_UNINSTALL_CONFIRMATION
                }
              >
                {busy ? <Spinner /> : null}
                <StudioIcon className="operations-button-icon" icon={DatabaseX} />
                {t('edgeUninstall.preview')}
              </Button>
            </DialogActions>
          </form>
        ) : stage === 'confirm' ? (
          <div className="operations-dialog-form">
            <Callout tone="warning">
              {t('edgeUninstall.dialog.irreversible')}
            </Callout>
            {report ? (
              <Field label={t('edgeUninstall.report.expected')}>
                {(control) => (
                  <textarea
                    {...control}
                    value={report}
                    rows={Math.min(report.split('\n').length, 18)}
                    readOnly
                    spellCheck={false}
                  />
                )}
              </Field>
            ) : null}
            {message ? <Notice tone="error">{message.text}</Notice> : null}
            <DialogActions>
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  setStage('entry');
                  setRows(null);
                  setMessage(null);
                }}
              >
                {t('confirmation.back')}
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={busy || rows === null}
                onClick={() => void execute()}
              >
                {busy ? <Spinner /> : null}
                <StudioIcon className="operations-button-icon" icon={DatabaseX} />
                {t('edgeUninstall.execute')}
              </Button>
            </DialogActions>
          </div>
        ) : (
          <div className="operations-dialog-form">
            {message ? <Notice tone="success">{message.text}</Notice> : null}
            {report ? (
              <Field label={t('edgeUninstall.report.completed')}>
                {(control) => (
                  <textarea
                    {...control}
                    value={report}
                    rows={Math.min(report.split('\n').length, 18)}
                    readOnly
                    spellCheck={false}
                  />
                )}
              </Field>
            ) : null}
            <DialogActions>
              <Button type="button" variant="primary" onClick={closeDialog}>
                {t('confirmation.close')}
              </Button>
            </DialogActions>
          </div>
        )}
      </Dialog>
    </>
  );
}

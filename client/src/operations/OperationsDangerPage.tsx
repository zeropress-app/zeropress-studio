import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertOctagon,
  Eraser,
  RotateCcw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { ApiErrorCode } from '../../../contracts/api';
import {
  operationsRequestSchema,
  type OperationsAction,
  type OperationsStatusData,
} from '../../../contracts/operations';
import {
  OperationsClientError,
  requestOperationsAction,
  requestUninstallPreview,
  type OperationsClientErrorCode,
} from '../lib/operations-client';
import { createDeletionReport } from '../lib/deletion-report';
import {
  Button,
  Callout,
  Dialog,
  DialogActions,
  Field,
  Notice,
  Panel,
  StudioIcon,
} from '../components/primitives';
import { useBusyChange } from '../hooks/useBusyChange';
import {
  useOperationsActivity,
  useOperationsContext,
} from './operations-context';
import { OperationsPageHeading } from './OperationsPageHeading';
import { OperationsUnavailable } from './OperationsUnavailable';

type ResultState =
  | {
      kind: 'success';
      action: OperationsAction;
      deletedRows: Record<string, number>;
      resources: {
        studio: 'completed';
        edge: 'completed' | 'skipped_disabled' | 'not_applicable';
      };
    }
  | { kind: 'api_error'; code: ApiErrorCode }
  | { kind: 'client_error'; code: OperationsClientErrorCode }
  | { kind: 'unexpected_error' };

type DialogStage = 'entry' | 'confirm' | 'completed';
type ReportCopyState = 'idle' | 'copied' | 'failed';

const ACTION_ORDER = [
  'clear_site_content',
  'reset_studio',
  'uninstall_studio',
] as const satisfies readonly OperationsAction[];

const ACTION_ICONS = {
  clear_site_content: Eraser,
  reset_studio: RotateCcw,
  uninstall_studio: Trash2,
} as const satisfies Record<OperationsAction, LucideIcon>;

function visibleActions(
  status: OperationsStatusData,
): readonly OperationsAction[] {
  if (status.database.state !== 'ready') return [];
  if (status.site_mode === 'operational') return ['clear_site_content'];
  return status.site_mode === 'maintenance' ? ACTION_ORDER : [];
}

function apiErrorKey(code: ApiErrorCode) {
  switch (code) {
    case 'INVALID_OPERATIONS_TOKEN':
      return 'errors.invalidToken' as const;
    case 'INVALID_OPERATIONS_CREDENTIALS':
      return 'errors.invalidCredentials' as const;
    case 'OPERATIONS_CONFIGURATION_ERROR':
      return 'errors.configuration' as const;
    case 'OPERATIONS_MAINTENANCE_REQUIRED':
      return 'errors.maintenanceRequired' as const;
    case 'OPERATIONS_CONFIRMATION_MISMATCH':
      return 'errors.confirmation' as const;
    case 'RATE_LIMIT_EXCEEDED':
      return 'errors.rateLimit' as const;
    case 'NOT_FOUND':
      return 'errors.notFound' as const;
    case 'SYSTEM_NOT_AVAILABLE':
    case 'SITE_MAINTENANCE':
    case 'SITE_RECOVERY':
    case 'SYSTEM_CONFIGURATION_ERROR':
    case 'INSTALLATION_REQUIRED':
    case 'INSTALLATION_NOT_AVAILABLE':
    case 'INSTALLATION_ALREADY_COMPLETED':
    case 'SITE_ACTIVATION_REQUIRED':
    case 'DATABASE_UPGRADE_REQUIRED':
    case 'DATABASE_UPGRADE_NOT_AVAILABLE':
    case 'EDGE_INTEGRATION_DISABLED':
    case 'EDGE_INTEGRATION_UNAVAILABLE':
    case 'EDGE_RECONCILIATION_REQUIRED':
    case 'EDGE_TARGET_PROJECTION_PENDING':
    case 'EDGE_DATABASE_INSTALL_REQUIRED':
    case 'EDGE_DATABASE_ADOPTION_REQUIRED':
    case 'EDGE_DATABASE_UPGRADE_REQUIRED':
    case 'EDGE_DATABASE_RECOVERY_REQUIRED':
    case 'EDGE_DATABASE_STUDIO_NOT_READY':
    case 'EDGE_DATABASE_INSTALL_NOT_AVAILABLE':
    case 'EDGE_DATABASE_ADOPTION_NOT_AVAILABLE':
    case 'EDGE_DATABASE_UPGRADE_NOT_AVAILABLE':
    case 'EDGE_DATABASE_UNINSTALL_NOT_AVAILABLE':
    case 'EDGE_INTEGRATION_MUST_BE_DISABLED':
    case 'EDGE_DATABASE_STATE_CONFLICT':
    case 'EDGE_TARGET_RECONCILIATION_NOT_AVAILABLE':
    case 'EDGE_TARGET_RECONCILIATION_STATE_CONFLICT':
    case 'CONTENT_SEARCH_INDEX_NOT_READY':
    case 'CONTENT_SEARCH_INDEX_UNAVAILABLE':
    case 'CONTENT_SEARCH_INDEX_REBUILD_NOT_AVAILABLE':
    case 'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT':
    case 'DATABASE_BACKUP_NOT_AVAILABLE':
    case 'CLOUDFLARE_ACCESS_REQUIRED':
    case 'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE':
    case 'CLOUDFLARE_ACCESS_RECOVERY_NOT_AVAILABLE':
      return 'errors.unavailable' as const;
    case 'VALIDATION_ERROR':
    case 'INVALID_JSON':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'PAYLOAD_TOO_LARGE':
    case 'DATABASE_BACKUP_ARTIFACT_INVALID':
    case 'DATABASE_BACKUP_LIMIT_EXCEEDED':
    case 'DATABASE_BACKUP_TARGET_MISMATCH':
    case 'DATABASE_BACKUP_SCHEMA_MISMATCH':
    case 'DATABASE_RESTORE_UNSUPPORTED_MODE':
    case 'DATABASE_RESTORE_LIMIT_EXCEEDED':
    case 'DATABASE_RESTORE_STATE_CONFLICT':
    case 'DATABASE_UPGRADE_STATE_CONFLICT':
    case 'CLOUDFLARE_ACCESS_NOT_DETECTED':
      return 'errors.request' as const;
    default:
      return 'errors.unexpected' as const;
  }
}

function clientErrorKey(code: OperationsClientErrorCode) {
  switch (code) {
    case 'INVALID_TOKEN_FORMAT':
      return 'errors.tokenFormat' as const;
    case 'INVALID_RESPONSE':
      return 'errors.invalidResponse' as const;
    case 'TIMEOUT':
      return 'errors.timeout' as const;
    case 'NETWORK_ERROR':
      return 'errors.network' as const;
  }
}

export function OperationsDangerPage() {
  const { t, i18n } = useTranslation('operations');
  const { token, status, refreshStatus } = useOperationsContext();
  const reportBusy = useOperationsActivity('danger-action');
  const actions = visibleActions(status);
  const [administratorEmail, setAdministratorEmail] = useState('');
  const [administratorPassword, setAdministratorPassword] = useState('');
  const [selectedAction, setSelectedAction] =
    useState<OperationsAction | null>(null);
  const [dialogStage, setDialogStage] = useState<DialogStage>('entry');
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(false);
  const [mutationLoading, setMutationLoading] = useState(false);
  const [result, setResult] = useState<ResultState | null>(null);
  const [uninstallPreviewRows, setUninstallPreviewRows] =
    useState<Record<string, number> | null>(null);
  const [reportCopyState, setReportCopyState] =
    useState<ReportCopyState>('idle');
  useBusyChange(reportBusy, mutationLoading);
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en'),
    [i18n.resolvedLanguage],
  );

  function resetDialogState(options?: { preserveResult?: boolean }) {
    setSelectedAction(null);
    setDialogStage('entry');
    setConfirmation('');
    setAdministratorPassword('');
    setUninstallPreviewRows(null);
    setReportCopyState('idle');
    if (!options?.preserveResult) setResult(null);
  }

  function selectAction(action: OperationsAction) {
    resetDialogState();
    setSelectedAction(action);
  }

  async function reviewAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedAction || loading) return;
    if (confirmation !== status.actions[selectedAction].confirmation) {
      setResult({
        kind: 'api_error',
        code: 'OPERATIONS_CONFIRMATION_MISMATCH',
      });
      return;
    }

    const parsed = operationsRequestSchema.safeParse({
      administrator_email: administratorEmail,
      administrator_password: administratorPassword,
      confirmation,
    });
    if (!parsed.success) {
      setResult({ kind: 'api_error', code: 'VALIDATION_ERROR' });
      return;
    }

    setAdministratorEmail(parsed.data.administrator_email);
    setResult(null);
    setReportCopyState('idle');
    if (selectedAction !== 'uninstall_studio') {
      setDialogStage('confirm');
      return;
    }

    setLoading(true);
    setUninstallPreviewRows(null);
    try {
      const response = await requestUninstallPreview({
        token,
        request: parsed.data,
      });
      if (!response.success) {
        setResult({ kind: 'api_error', code: response.error.code });
        return;
      }
      setUninstallPreviewRows(response.data.expected_effects.deleted_rows);
      setDialogStage('confirm');
    } catch (error) {
      setResult(error instanceof OperationsClientError
        ? { kind: 'client_error', code: error.code }
        : { kind: 'unexpected_error' });
    } finally {
      setLoading(false);
    }
  }

  async function executeAction() {
    if (
      !selectedAction
      || dialogStage !== 'confirm'
      || loading
      || (selectedAction === 'uninstall_studio' && uninstallPreviewRows === null)
    ) return;

    const parsed = operationsRequestSchema.safeParse({
      administrator_email: administratorEmail,
      administrator_password: administratorPassword,
      confirmation,
    });
    if (!parsed.success) {
      setDialogStage('entry');
      setUninstallPreviewRows(null);
      setResult({ kind: 'api_error', code: 'VALIDATION_ERROR' });
      return;
    }

    setMutationLoading(true);
    setLoading(true);
    setResult(null);
    try {
      const response = await requestOperationsAction({
        token,
        action: selectedAction,
        request: parsed.data,
      });
      if (!response.success) {
        setDialogStage('entry');
        setUninstallPreviewRows(null);
        setResult({ kind: 'api_error', code: response.error.code });
        return;
      }
      setResult({
        kind: 'success',
        action: response.data.operation,
        deletedRows: response.data.effects.deleted_rows,
        resources: response.data.resources,
      });
      setUninstallPreviewRows(null);
      setReportCopyState('idle');
      setDialogStage('completed');
      setConfirmation('');
      setAdministratorPassword('');
      try {
        await refreshStatus();
      } catch {
        // The operation succeeded; retain its report if the secondary refresh fails.
      }
    } catch (error) {
      setDialogStage('entry');
      setUninstallPreviewRows(null);
      setResult(error instanceof OperationsClientError
        ? { kind: 'client_error', code: error.code }
        : { kind: 'unexpected_error' });
    } finally {
      setLoading(false);
      setMutationLoading(false);
    }
  }

  function resultMessage(): string | null {
    if (!result) return null;
    if (result.kind === 'success') {
      if (result.action === 'reset_studio') return t('result.resetCompleted');
      if (result.action === 'uninstall_studio') {
        return t('result.uninstallCompleted', {
          tables: numberFormatter.format(Object.keys(result.deletedRows).length),
        });
      }
      return t('result.completed', {
        action: t(`actions.${result.action}.title`),
        rows: numberFormatter.format(
          Object.values(result.deletedRows).reduce((total, rows) => total + rows, 0),
        ),
      });
    }
    if (result.kind === 'api_error') return t(apiErrorKey(result.code));
    if (result.kind === 'client_error') return t(clientErrorKey(result.code));
    return t('errors.unexpected');
  }

  const message = resultMessage();
  const uninstallExpectedReport = uninstallPreviewRows
    ? createDeletionReport(uninstallPreviewRows)
    : null;
  const deletionReport = result?.kind === 'success'
    && result.action !== 'reset_studio'
    ? createDeletionReport(result.deletedRows)
    : null;

  async function copyDeletionReport() {
    if (!deletionReport) return;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new TypeError('Clipboard API is unavailable.');
      }
      await navigator.clipboard.writeText(deletionReport);
      setReportCopyState('copied');
    } catch {
      setReportCopyState('failed');
    }
  }

  return (
    <div className="operations-page">
      <OperationsPageHeading
        icon={AlertOctagon}
        kicker={t('pages.danger.kicker')}
        title={t('pages.danger.title')}
        description={t('pages.danger.description')}
      />

      {message && result?.kind === 'success' && selectedAction === null ? (
        <Notice tone="success">{message}</Notice>
      ) : null}

      {actions.length > 0 ? (
        <Panel title={t('actions.title')}>
          <div className="operations-action-grid">
            {actions.map((action) => {
              const availability = status.actions[action];
              const unavailableReason = !availability.available
                && action !== 'uninstall_studio'
                && status.edge_integration.mode === 'enabled'
                && status.edge_integration.document?.effective_state !== 'ready'
                ? t('actions.edgeIntegrationNotReady')
                : !availability.available
                  && action !== 'uninstall_studio'
                  && !status.bindings.EDGE_DB.bound
                  ? t('actions.edgeDatabaseRequired')
                  : t('actions.unavailable');
              return (
                <article className="operations-action" key={action}>
                  <div className="operations-action-heading">
                    <span className="operations-action-icon">
                      <StudioIcon icon={ACTION_ICONS[action]} />
                    </span>
                    <div>
                      <p className="operations-level operations-level-danger">
                        {t(`actions.${action}.level`)}
                      </p>
                      <h3 className="operations-action-title">
                        {t(`actions.${action}.title`)}
                      </h3>
                    </div>
                  </div>
                  <p className="operations-action-description">
                    {t(`actions.${action}.description`)}
                  </p>
                  {!availability.available ? (
                    <p className="operations-action-condition">
                      {unavailableReason}
                    </p>
                  ) : null}
                  <div className="operations-action-button">
                    <Button
                      type="button"
                      variant="danger"
                      block
                      disabled={!availability.available || loading}
                      onClick={() => selectAction(action)}
                    >
                      <StudioIcon icon={ACTION_ICONS[action]} />
                      {availability.available
                        ? t(`actions.${action}.button`)
                        : t('actions.unavailable')}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        </Panel>
      ) : (
        <OperationsUnavailable title={t('pages.danger.unavailableTitle')}>
          {t('pages.danger.unavailableDescription')}
        </OperationsUnavailable>
      )}

      <Dialog
        open={selectedAction !== null}
        onClose={() => resetDialogState()}
        busy={loading}
        size="wide"
        kicker={selectedAction ? t(`actions.${selectedAction}.level`) : undefined}
        title={dialogStage === 'entry' && selectedAction
          ? t(`actions.${selectedAction}.title`)
          : dialogStage === 'confirm'
            ? t('confirmation.reviewTitle')
            : t('confirmation.completedTitle')}
        description={dialogStage === 'entry' && selectedAction
          ? t(`actions.${selectedAction}.warning`)
          : dialogStage === 'confirm' && selectedAction
            ? t('confirmation.reviewDescription', {
              action: t(`actions.${selectedAction}.title`),
            })
            : t('confirmation.completedDescription')}
      >
        {dialogStage === 'entry' && selectedAction ? (
          <form className="operations-dialog-form" onSubmit={reviewAction} noValidate>
            <div className="operations-credentials">
              <h3 className="operations-credentials-title">{t('credentials.title')}</h3>
              <p className="operations-credentials-detail">{t('credentials.description')}</p>
              <Field label={t('credentials.email')}>
                {(control) => (
                  <input
                    {...control}
                    type="email"
                    autoComplete="username"
                    maxLength={254}
                    value={administratorEmail}
                    disabled={loading}
                    required
                    onChange={(event) => setAdministratorEmail(event.target.value)}
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
                    value={administratorPassword}
                    disabled={loading}
                    required
                    onChange={(event) => setAdministratorPassword(event.target.value)}
                  />
                )}
              </Field>
            </div>
            <Field
              label={t('confirmation.label')}
              labelAdornment={(
                <code className="operations-code">
                  {status.actions[selectedAction].confirmation}
                </code>
              )}
            >
              {(control) => (
                <input
                  {...control}
                  type="text"
                  autoComplete="off"
                  value={confirmation}
                  disabled={loading}
                  required
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              )}
            </Field>
            {message && result?.kind !== 'success' ? (
              <Notice tone="error">{message}</Notice>
            ) : null}
            <DialogActions>
              <Button type="button" disabled={loading} onClick={() => resetDialogState()}>
                {t('confirmation.cancel')}
              </Button>
              <Button
                type="submit"
                variant="danger"
                disabled={loading
                  || confirmation !== status.actions[selectedAction].confirmation
                  || administratorEmail.length === 0
                  || administratorPassword.length === 0}
              >
                {loading && selectedAction === 'uninstall_studio'
                  ? t('confirmation.previewing')
                  : t('confirmation.execute')}
              </Button>
            </DialogActions>
          </form>
        ) : null}

        {dialogStage === 'confirm' && selectedAction ? (
          <div className="operations-dialog-form">
            <div className="operations-review">
              <strong className="operations-review-title">
                {t(`actions.${selectedAction}.title`)}
              </strong>
              <p className="operations-review-detail">
                {t(`actions.${selectedAction}.warning`)}
              </p>
              <Callout tone="warning">{t('confirmation.irreversible')}</Callout>
              {selectedAction !== 'uninstall_studio' ? (
                <Callout tone="info" title={t('confirmation.edgeScopeTitle')}>
                  {status.edge_integration.mode === 'disabled'
                    ? t('confirmation.edgeScopeDisabled')
                    : t('confirmation.edgeScopeEnabled')}
                </Callout>
              ) : null}
            </div>
            {uninstallExpectedReport ? (
              <div className="operations-review">
                <strong className="operations-review-title">
                  {t('confirmation.expectedResult', {
                    tables: numberFormatter.format(
                      Object.keys(uninstallPreviewRows ?? {}).length,
                    ),
                  })}
                </strong>
                <p className="operations-review-detail">
                  {t('confirmation.expectedResultDescription')}
                </p>
                <div className="operations-report">
                  <Field label={t('confirmation.expectedReportLabel')}>
                    {(control) => (
                      <textarea
                        {...control}
                        value={uninstallExpectedReport}
                        rows={Math.min(uninstallExpectedReport.split('\n').length, 14)}
                        readOnly
                        spellCheck={false}
                      />
                    )}
                  </Field>
                </div>
              </div>
            ) : null}
            <DialogActions>
              <Button
                type="button"
                disabled={loading}
                onClick={() => {
                  setDialogStage('entry');
                  setUninstallPreviewRows(null);
                  setReportCopyState('idle');
                  setResult(null);
                }}
              >
                {t('confirmation.back')}
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={loading
                  || (selectedAction === 'uninstall_studio'
                    && uninstallPreviewRows === null)}
                onClick={executeAction}
              >
                {loading ? t('confirmation.running') : t('confirmation.confirmExecute')}
              </Button>
            </DialogActions>
          </div>
        ) : null}

        {dialogStage === 'completed' ? (
          <div className="operations-dialog-form">
            {message ? <Notice tone="success">{message}</Notice> : null}
            {result?.kind === 'success'
              && result.resources.edge === 'skipped_disabled' ? (
                <Notice tone="info">{t('result.edgeSkippedDisabled')}</Notice>
              ) : null}
            {deletionReport ? (
              <div className="operations-report">
                <Field
                  label={result?.kind === 'success'
                    && result.action === 'clear_site_content'
                    ? t('result.clearReportLabel')
                    : t('result.uninstallReportLabel')}
                >
                  {(control) => (
                    <textarea
                      {...control}
                      value={deletionReport}
                      rows={Math.min(deletionReport.split('\n').length, 14)}
                      readOnly
                      spellCheck={false}
                    />
                  )}
                </Field>
                {reportCopyState !== 'idle' ? (
                  <Notice tone={reportCopyState === 'failed' ? 'error' : 'success'}>
                    {reportCopyState === 'copied'
                      ? t('result.reportCopied')
                      : t('result.reportCopyFailed')}
                  </Notice>
                ) : null}
              </div>
            ) : null}
            <DialogActions>
              {deletionReport ? (
                <Button type="button" onClick={copyDeletionReport}>
                  {reportCopyState === 'copied'
                    ? t('result.reportCopiedButton')
                    : t('result.copyReport')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="primary"
                onClick={() => resetDialogState({ preserveResult: true })}
              >
                {t('confirmation.close')}
              </Button>
            </DialogActions>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

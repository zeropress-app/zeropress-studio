import {
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { DatabaseBackup, Download, Upload } from 'lucide-react';
import {
  createDatabaseRestoreChunks,
  createDatabaseRestorePlan,
  databaseBackupRequestSchema,
  databaseRestoreStartRequestSchema,
  inspectDatabaseBackupArtifact,
  type DatabaseBackupMode,
  type DatabaseBackupTarget,
  type DatabaseRestorePlan,
  type DatabaseTransferAvailability,
} from '../../../contracts/database-backup';
import type { ApiErrorCode } from '../../../contracts/api';
import type { OperationsStatusData } from '../../../contracts/operations';
import {
  OperationsClientError,
  requestDatabaseBackup,
  requestDatabaseRestoreChunk,
  requestDatabaseRestoreFinalize,
  requestDatabaseRestoreStart,
  type OperationsClientErrorCode,
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
  StudioIcon,
} from './primitives';

type TransferMessage =
  | { kind: 'success'; text: string }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: OperationsClientErrorCode }
  | { kind: 'invalid_file' }
  | { kind: 'unexpected' };

type RestoreStage = 'closed' | 'entry' | 'confirm' | 'completed';

type Props = {
  token: string;
  availability: DatabaseTransferAvailability;
  siteMode: OperationsStatusData['site_mode'];
  databaseState: OperationsStatusData['database']['state'];
  headingLevel?: 2 | 3;
  onBusyChange?: BusyChangeHandler;
};

const databaseOrder: DatabaseBackupTarget[] = ['studio', 'edge'];
const modeOrder: DatabaseBackupMode[] = [
  'structure_and_data',
  'structure_only',
  'data_only',
];

type DatabaseTransferErrorKey =
  | 'databaseTransfer.errors.invalidCredentials'
  | 'databaseTransfer.errors.invalidArtifact'
  | 'databaseTransfer.errors.targetMismatch'
  | 'databaseTransfer.errors.schemaMismatch'
  | 'databaseTransfer.errors.unsupportedMode'
  | 'databaseTransfer.errors.limitExceeded'
  | 'databaseTransfer.errors.stateConflict'
  | 'databaseTransfer.errors.unavailable'
  | 'databaseTransfer.errors.validation'
  | 'databaseTransfer.errors.unexpected'
  | 'errors.invalidToken'
  | 'errors.tokenFormat'
  | 'errors.rateLimit'
  | 'errors.configuration'
  | 'errors.invalidResponse'
  | 'errors.timeout'
  | 'errors.network';

function apiErrorKey(code: ApiErrorCode): DatabaseTransferErrorKey {
  switch (code) {
    case 'INVALID_OPERATIONS_CREDENTIALS':
      return 'databaseTransfer.errors.invalidCredentials';
    case 'DATABASE_BACKUP_ARTIFACT_INVALID':
      return 'databaseTransfer.errors.invalidArtifact';
    case 'DATABASE_BACKUP_TARGET_MISMATCH':
      return 'databaseTransfer.errors.targetMismatch';
    case 'DATABASE_BACKUP_SCHEMA_MISMATCH':
      return 'databaseTransfer.errors.schemaMismatch';
    case 'DATABASE_RESTORE_UNSUPPORTED_MODE':
      return 'databaseTransfer.errors.unsupportedMode';
    case 'DATABASE_RESTORE_STATE_CONFLICT':
      return 'databaseTransfer.errors.stateConflict';
    case 'DATABASE_BACKUP_LIMIT_EXCEEDED':
    case 'DATABASE_RESTORE_LIMIT_EXCEEDED':
    case 'PAYLOAD_TOO_LARGE':
      return 'databaseTransfer.errors.limitExceeded';
    case 'DATABASE_BACKUP_NOT_AVAILABLE':
    case 'OPERATIONS_MAINTENANCE_REQUIRED':
    case 'SYSTEM_NOT_AVAILABLE':
    case 'SITE_MAINTENANCE':
    case 'SITE_RECOVERY':
      return 'databaseTransfer.errors.unavailable';
    case 'INVALID_OPERATIONS_TOKEN':
      return 'errors.invalidToken';
    case 'RATE_LIMIT_EXCEEDED':
      return 'errors.rateLimit';
    case 'OPERATIONS_CONFIGURATION_ERROR':
      return 'errors.configuration';
    case 'VALIDATION_ERROR':
    case 'INVALID_JSON':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'OPERATIONS_CONFIRMATION_MISMATCH':
      return 'databaseTransfer.errors.validation';
    default:
      return 'databaseTransfer.errors.unexpected';
  }
}

function clientErrorKey(
  code: OperationsClientErrorCode,
): DatabaseTransferErrorKey {
  switch (code) {
    case 'INVALID_TOKEN_FORMAT':
      return 'errors.tokenFormat';
    case 'INVALID_RESPONSE':
      return 'errors.invalidResponse';
    case 'TIMEOUT':
      return 'errors.timeout';
    case 'NETWORK_ERROR':
      return 'errors.network';
  }
}

export function DatabaseBackupPanel({
  token,
  availability,
  siteMode,
  databaseState,
  headingLevel = 3,
  onBusyChange,
}: Props) {
  const { t } = useTranslation('operations');
  const [exportDatabase, setExportDatabase] =
    useState<DatabaseBackupTarget>('studio');
  const [exportMode, setExportMode] =
    useState<DatabaseBackupMode>('structure_and_data');
  const [exportEmail, setExportEmail] = useState('');
  const [exportPassword, setExportPassword] = useState('');
  const [exportLoading, setExportLoading] = useState(false);
  const [exportMessage, setExportMessage] =
    useState<TransferMessage | null>(null);
  const [restorePlan, setRestorePlan] = useState<DatabaseRestorePlan | null>(null);
  const [restoreFilename, setRestoreFilename] = useState('');
  const [restoreReading, setRestoreReading] = useState(false);
  const [restoreStage, setRestoreStage] =
    useState<RestoreStage>('closed');
  const [restoreEmail, setRestoreEmail] = useState('');
  const [restorePassword, setRestorePassword] = useState('');
  const [restoreConfirmation, setRestoreConfirmation] = useState('');
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState({ current: 0, total: 0 });
  const [restoreMessage, setRestoreMessage] =
    useState<TransferMessage | null>(null);
  useBusyChange(
    onBusyChange,
    exportLoading || restoreReading || restoreLoading,
  );
  const exportableDatabases = databaseOrder.filter(
    (database) => availability.databases[database].export_available,
  );
  const activeExportDatabase = exportableDatabases.includes(exportDatabase)
    ? exportDatabase
    : exportableDatabases[0] ?? null;
  const uninstalledMaintenanceRestore = siteMode === 'maintenance'
    && databaseState === 'uninstalled';
  const restoreAvailable = databaseOrder.some(
    (database) => availability.databases[database].restore_available,
  ) || uninstalledMaintenanceRestore;

  function messageText(message: TransferMessage | null): string | null {
    if (!message) return null;
    if (message.kind === 'success') return message.text;
    if (message.kind === 'api') return t(apiErrorKey(message.code));
    if (message.kind === 'client') return t(clientErrorKey(message.code));
    if (message.kind === 'invalid_file') {
      return t('databaseTransfer.errors.invalidArtifact');
    }
    return t('databaseTransfer.errors.unexpected');
  }

  async function exportBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (exportLoading || !activeExportDatabase) return;
    const parsed = databaseBackupRequestSchema.safeParse({
      database: activeExportDatabase,
      mode: exportMode,
      ...(availability.requires_administrator_credentials
        ? {
            administrator_email: exportEmail,
            administrator_password: exportPassword,
          }
        : {}),
    });
    if (!parsed.success) {
      setExportMessage({ kind: 'api', code: 'VALIDATION_ERROR' });
      return;
    }
    setExportLoading(true);
    setExportMessage(null);
    try {
      const response = await requestDatabaseBackup({
        token,
        request: parsed.data,
      });
      if (!response.success) {
        setExportMessage({ kind: 'api', code: response.error.code });
        return;
      }
      const url = URL.createObjectURL(response.data.blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = response.data.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      setExportMessage({
        kind: 'success',
        text: t('databaseTransfer.export.completed', {
          filename: response.data.filename,
        }),
      });
      setExportPassword('');
    } catch (error) {
      setExportMessage(
        error instanceof OperationsClientError
          ? { kind: 'client', code: error.code }
          : { kind: 'unexpected' },
      );
    } finally {
      setExportLoading(false);
    }
  }

  async function loadRestoreFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || restoreReading) return;
    setRestoreReading(true);
    setRestoreMessage(null);
    setRestorePlan(null);
    setRestoreFilename('');
    try {
      const sql = await file.text();
      const inspection = await inspectDatabaseBackupArtifact(sql);
      const plan = inspection.manifest.mode === 'structure_only'
        ? null
        : await createDatabaseRestorePlan(inspection);
      setRestorePlan(plan ?? {
        manifest: inspection.manifest,
        footer: inspection.footer,
        artifactDigest: inspection.footer.statement_chain_sha256,
        tableStatements: [],
        secondaryStatements: [],
        tables: [],
        rowCount: inspection.manifest.tables.reduce(
          (total, table) => total + table.row_count,
          0,
        ),
        chunkCount: 0,
      });
      setRestoreFilename(file.name);
      if (inspection.manifest.mode === 'structure_only') {
        setRestoreMessage({
          kind: 'api',
          code: 'DATABASE_RESTORE_UNSUPPORTED_MODE',
        });
      }
    } catch {
      setRestoreMessage({ kind: 'invalid_file' });
    } finally {
      setRestoreReading(false);
    }
  }

  function openRestoreDialog() {
    if (!restorePlan || restorePlan.manifest.mode === 'structure_only') {
      return;
    }
    setRestoreStage('entry');
    setRestoreMessage(null);
    setRestorePassword('');
    setRestoreConfirmation('');
  }

  function closeRestoreDialog() {
    if (restoreLoading) return;
    setRestoreStage('closed');
    setRestorePassword('');
    setRestoreConfirmation('');
    setRestoreMessage((current) =>
      current?.kind === 'success' ? current : null);
  }

  function reviewRestore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restorePlan || restoreLoading) return;
    const request = databaseRestoreStartRequestSchema.safeParse({
      database: restorePlan.manifest.database,
      manifest: restorePlan.manifest,
      manifest_sha256: restorePlan.footer.manifest_sha256,
      artifact_digest: restorePlan.artifactDigest,
      artifact_statement_count: restorePlan.footer.statement_count,
      expected_chunk_count: restorePlan.chunkCount,
      table_statements: restorePlan.tableStatements,
      secondary_statements: restorePlan.secondaryStatements,
      confirmation: restoreConfirmation,
      ...(availability.requires_administrator_credentials
        ? {
            administrator_email: restoreEmail,
            administrator_password: restorePassword,
          }
        : {}),
    });
    if (!request.success) {
      setRestoreMessage({ kind: 'api', code: 'VALIDATION_ERROR' });
      return;
    }
    setRestoreEmail(request.data.administrator_email ?? '');
    setRestoreMessage(null);
    setRestoreStage('confirm');
  }

  async function executeRestore() {
    if (!restorePlan || restoreStage !== 'confirm' || restoreLoading) {
      return;
    }
    const parsed = databaseRestoreStartRequestSchema.safeParse({
      database: restorePlan.manifest.database,
      manifest: restorePlan.manifest,
      manifest_sha256: restorePlan.footer.manifest_sha256,
      artifact_digest: restorePlan.artifactDigest,
      artifact_statement_count: restorePlan.footer.statement_count,
      expected_chunk_count: restorePlan.chunkCount,
      table_statements: restorePlan.tableStatements,
      secondary_statements: restorePlan.secondaryStatements,
      confirmation: restoreConfirmation,
      ...(availability.requires_administrator_credentials
        ? {
            administrator_email: restoreEmail,
            administrator_password: restorePassword,
          }
        : {}),
    });
    if (!parsed.success) {
      setRestoreStage('entry');
      setRestoreMessage({ kind: 'api', code: 'VALIDATION_ERROR' });
      return;
    }
    setRestoreLoading(true);
    setRestoreProgress({ current: 0, total: restorePlan.chunkCount });
    setRestoreMessage(null);
    try {
      const started = await requestDatabaseRestoreStart({
        token,
        request: parsed.data,
      });
      if (!started.success) {
        setRestoreStage('entry');
        setRestoreMessage({ kind: 'api', code: started.error.code });
        return;
      }
      const chunks = createDatabaseRestoreChunks(restorePlan);
      for (const chunk of chunks) {
        const response = await requestDatabaseRestoreChunk({
          token,
          request: {
            database: restorePlan.manifest.database,
            restore_id: started.data.restore_id,
            artifact_digest: restorePlan.artifactDigest,
            chunk_index: chunk.chunkIndex,
            table: chunk.table,
            columns: chunk.columns,
            rows: chunk.rows,
          },
        });
        if (!response.success) {
          setRestoreStage('entry');
          setRestoreMessage({ kind: 'api', code: response.error.code });
          return;
        }
        setRestoreProgress({ current: response.data.next_chunk, total: chunks.length });
      }
      const response = await requestDatabaseRestoreFinalize({
        token,
        request: {
          database: restorePlan.manifest.database,
          restore_id: started.data.restore_id,
          artifact_digest: restorePlan.artifactDigest,
          expected_chunk_count: chunks.length,
          secondary_statements: restorePlan.secondaryStatements,
        },
      });
      if (!response.success) {
        setRestoreStage('entry');
        setRestoreMessage({ kind: 'api', code: response.error.code });
        return;
      }
      setRestorePassword('');
      setRestoreConfirmation('');
      setRestoreMessage({
        kind: 'success',
        text: t('databaseTransfer.restore.completed', {
          database: t(
            `databaseTransfer.databases.${response.data.database}.label`,
          ),
          tables: response.data.restored_tables.length,
        }),
      });
      setRestoreStage('completed');
    } catch (error) {
      setRestoreStage('entry');
      setRestoreMessage(
        error instanceof OperationsClientError
          ? { kind: 'client', code: error.code }
          : { kind: 'unexpected' },
      );
    } finally {
      setRestoreLoading(false);
    }
  }

  const selectedExportAvailability =
    activeExportDatabase !== null
    && availability.databases[activeExportDatabase].export_available;
  const selectedRestoreAvailability = restorePlan
    ? availability.databases[restorePlan.manifest.database]
      .restore_available
    : false;
  const restoreRows = restorePlan?.rowCount ?? 0;
  const exportMessageText = messageText(exportMessage);
  const restoreMessageText = messageText(restoreMessage);

  return (
    <Panel
      headingLevel={headingLevel}
      leading={<StudioIcon icon={DatabaseBackup} />}
      title={t('databaseTransfer.title')}
      description={t('databaseTransfer.description')}
    >
      <div className="operations-stack">
        <Callout tone="warning">
          {t('databaseTransfer.sensitiveArtifact')}
        </Callout>

        <div className="operations-transfer-grid">
          {activeExportDatabase ? (
            <form className="operations-transfer" onSubmit={exportBackup}>
            <p className="operations-level operations-level-primary">
              {t('databaseTransfer.export.level')}
            </p>
            <h3 className="operations-action-title">
              {t('databaseTransfer.export.title')}
            </h3>
            <p className="operations-action-description">
              {t('databaseTransfer.export.description')}
            </p>
            <Field label={t('databaseTransfer.database')}>
              {(control) => (
                <select
                  {...control}
                  value={activeExportDatabase}
                  disabled={exportLoading}
                  onChange={(event) => setExportDatabase(
                    event.target.value as DatabaseBackupTarget,
                  )}
                >
                  {exportableDatabases.map((database) => (
                    <option
                      key={database}
                      value={database}
                    >
                      {t(`databaseTransfer.databases.${database}.label`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              label={t('databaseTransfer.mode')}
              hint={t(`databaseTransfer.modes.${exportMode}.description`)}
            >
              {(control) => (
                <select
                  {...control}
                  value={exportMode}
                  disabled={exportLoading}
                  onChange={(event) => setExportMode(
                    event.target.value as DatabaseBackupMode,
                  )}
                >
                  {modeOrder.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`databaseTransfer.modes.${mode}.label`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {activeExportDatabase === 'edge' ? (
              <Callout tone="warning">
                {t('databaseTransfer.edgeQuiesce')}
              </Callout>
            ) : null}
            {availability.requires_administrator_credentials ? (
              <div className="operations-credentials">
                <Field label={t('credentials.email')}>
                  {(control) => (
                    <input
                      {...control}
                      type="email"
                      autoComplete="username"
                      value={exportEmail}
                      disabled={exportLoading}
                      required
                      onChange={(event) => setExportEmail(event.target.value)}
                    />
                  )}
                </Field>
                <Field label={t('credentials.password')}>
                  {(control) => (
                    <input
                      {...control}
                      type="password"
                      autoComplete="current-password"
                      value={exportPassword}
                      disabled={exportLoading}
                      required
                      onChange={(event) => setExportPassword(
                        event.target.value,
                      )}
                    />
                  )}
                </Field>
              </div>
            ) : (
              <Callout tone="info">
                {t('databaseTransfer.recoveryBoundary')}
              </Callout>
            )}
            <div className="operations-transfer-submit">
              <Button
                type="submit"
                variant="primary"
                block
                disabled={exportLoading || !selectedExportAvailability}
              >
                <StudioIcon className="operations-button-icon" icon={Download} />
                {exportLoading
                  ? t('databaseTransfer.export.generating')
                  : t('databaseTransfer.export.button')}
              </Button>
            </div>
            {exportMessageText ? (
              <Notice
                tone={exportMessage?.kind === 'success' ? 'success' : 'error'}
              >
                {exportMessageText}
              </Notice>
            ) : null}
            </form>
          ) : null}

          {restoreAvailable ? (
            <div className="operations-transfer">
              <p className="operations-level operations-level-danger">
                {t('databaseTransfer.restore.level')}
              </p>
              <h3 className="operations-action-title">
                {t('databaseTransfer.restore.title')}
              </h3>
              <p className="operations-action-description">
                {t('databaseTransfer.restore.description')}
              </p>
              {uninstalledMaintenanceRestore ? (
                <Callout tone="warning">
                  {t('databaseTransfer.restore.uninstalledRequiresRecovery')}
                </Callout>
              ) : null}
              <Field
                label={t('databaseTransfer.restore.file')}
                hint={t('databaseTransfer.restore.fileHint')}
              >
                {(control) => (
                  <input
                    {...control}
                    className="operations-file-input"
                    type="file"
                    accept=".sql,application/sql,text/plain"
                    disabled={restoreReading || restoreLoading}
                    onChange={loadRestoreFile}
                  />
                )}
              </Field>
              {restorePlan ? (
                <dl className="operations-artifact">
                  <div>
                    <dt>{t('databaseTransfer.restore.filename')}</dt>
                    <dd>{restoreFilename}</dd>
                  </div>
                  <div>
                    <dt>{t('databaseTransfer.database')}</dt>
                    <dd>
                      {t(`databaseTransfer.databases.${
                        restorePlan.manifest.database}.label`)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('databaseTransfer.mode')}</dt>
                    <dd>
                      {t(`databaseTransfer.modes.${
                        restorePlan.manifest.mode}.label`)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('databaseTransfer.restore.tables')}</dt>
                    <dd>{restorePlan.manifest.tables.length}</dd>
                  </div>
                  <div>
                    <dt>{t('databaseTransfer.restore.rows')}</dt>
                    <dd>{restoreRows}</dd>
                  </div>
                  <div>
                    <dt>{t('databaseTransfer.restore.statements')}</dt>
                    <dd>{restorePlan.footer.statement_count}</dd>
                  </div>
                </dl>
              ) : null}
              <div className="operations-transfer-submit">
                <Button
                  type="button"
                  variant="danger"
                  block
                  disabled={restoreReading
                    || !restorePlan
                    || restorePlan.manifest.mode === 'structure_only'
                    || !selectedRestoreAvailability}
                  onClick={openRestoreDialog}
                >
                  <StudioIcon className="operations-button-icon" icon={Upload} />
                  {restoreReading
                    ? t('databaseTransfer.restore.inspecting')
                    : t('databaseTransfer.restore.button')}
                </Button>
              </div>
              {restoreMessageText && restoreStage === 'closed' ? (
                <Notice
                  tone={restoreMessage?.kind === 'success' ? 'success' : 'error'}
                >
                  {restoreMessageText}
                </Notice>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <Dialog
        open={restoreStage !== 'closed' && restorePlan !== null}
        onClose={closeRestoreDialog}
        busy={restoreLoading}
        size="wide"
        title={restoreStage === 'completed'
          ? t('databaseTransfer.restore.completedTitle')
          : restoreStage === 'confirm'
            ? t('databaseTransfer.restore.finalTitle')
            : t('databaseTransfer.restore.reviewTitle')}
      >
        {restoreStage === 'entry' && restorePlan ? (
          <form className="operations-dialog-form" onSubmit={reviewRestore}>
            <p className="operations-review-detail">
              {t('databaseTransfer.restore.reviewDescription')}
            </p>
            <div className="operations-review">
              <strong className="operations-review-title">
                {restoreFilename}
              </strong>
              <p className="operations-review-detail">
                {t('databaseTransfer.restore.reviewSummary', {
                  database: t(`databaseTransfer.databases.${
                    restorePlan.manifest.database}.label`),
                  tables: restorePlan.manifest.tables.length,
                  rows: restoreRows,
                })}
              </p>
              <Callout tone="warning">
                {t('databaseTransfer.restore.atomicNote')}
              </Callout>
            </div>
            {availability.requires_administrator_credentials ? (
              <div className="operations-credentials">
                <Field label={t('credentials.email')}>
                  {(control) => (
                    <input
                      {...control}
                      type="email"
                      autoComplete="username"
                      value={restoreEmail}
                      required
                      onChange={(event) => setRestoreEmail(event.target.value)}
                    />
                  )}
                </Field>
                <Field label={t('credentials.password')}>
                  {(control) => (
                    <input
                      {...control}
                      type="password"
                      autoComplete="current-password"
                      value={restorePassword}
                      required
                      onChange={(event) => setRestorePassword(
                        event.target.value,
                      )}
                    />
                  )}
                </Field>
              </div>
            ) : (
              <Callout tone="info">
                {t('databaseTransfer.recoveryBoundary')}
              </Callout>
            )}
            <Field
              label={t('databaseTransfer.restore.confirmationLabel')}
              labelAdornment={(
                <code className="operations-code">
                  {availability.restore_confirmation}
                </code>
              )}
            >
              {(control) => (
                <input
                  {...control}
                  type="text"
                  autoComplete="off"
                  value={restoreConfirmation}
                  required
                  onChange={(event) => setRestoreConfirmation(
                    event.target.value,
                  )}
                />
              )}
            </Field>
            {restoreMessageText ? (
              <Notice tone="error">{restoreMessageText}</Notice>
            ) : null}
            <DialogActions>
              <Button type="button" onClick={closeRestoreDialog}>
                {t('confirmation.cancel')}
              </Button>
              <Button type="submit" variant="danger">
                <StudioIcon className="operations-button-icon" icon={Upload} />
                {t('databaseTransfer.restore.review')}
              </Button>
            </DialogActions>
          </form>
        ) : restoreStage === 'confirm' && restorePlan ? (
          <div className="operations-dialog-form">
            <p className="operations-review-detail">
              {t('databaseTransfer.restore.finalDescription')}
            </p>
            <div className="operations-review">
              <strong className="operations-review-title">
                {t('databaseTransfer.restore.irreversible')}
              </strong>
              <p className="operations-review-detail">
                {t('databaseTransfer.restore.finalSummary', {
                  database: t(`databaseTransfer.databases.${
                    restorePlan.manifest.database}.label`),
                  mode: t(`databaseTransfer.modes.${
                    restorePlan.manifest.mode}.label`),
                })}
              </p>
              <Callout tone="warning">
                {t('databaseTransfer.restore.r2Excluded')}
              </Callout>
              {restoreLoading ? (
                <p className="operations-review-detail" role="status">
                  {t('databaseTransfer.restore.progress', {
                    current: restoreProgress.current,
                    total: restoreProgress.total,
                  })}
                </p>
              ) : null}
            </div>
            <DialogActions>
              <Button
                type="button"
                disabled={restoreLoading}
                onClick={() => setRestoreStage('entry')}
              >
                {t('confirmation.back')}
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={restoreLoading}
                onClick={executeRestore}
              >
                <StudioIcon className="operations-button-icon" icon={Upload} />
                {restoreLoading
                  ? t('databaseTransfer.restore.restoring')
                  : t('databaseTransfer.restore.execute')}
              </Button>
            </DialogActions>
          </div>
        ) : (
          <div className="operations-dialog-form">
            <p className="operations-review-detail">{restoreMessageText}</p>
            <DialogActions>
              <Button
                type="button"
                variant="primary"
                onClick={closeRestoreDialog}
              >
                {t('confirmation.close')}
              </Button>
            </DialogActions>
          </div>
        )}
      </Dialog>
    </Panel>
  );
}

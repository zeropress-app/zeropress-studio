import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleArrowUp } from 'lucide-react';
import type { ApiErrorCode } from '../../../contracts/api';
import {
  DATABASE_UPGRADE_CONFIRMATION,
  databaseUpgradeStartRequestSchema,
  databaseUpgradeStepRequestSchema,
  type DatabaseUpgradeStatus,
  type DatabaseUpgradeStep,
} from '../../../contracts/database-upgrade';
import {
  OperationsClientError,
  requestDatabaseUpgradeStart,
  requestDatabaseUpgradeStep,
  type OperationsClientErrorCode,
} from '../lib/operations-client';
import { useBusyChange, type BusyChangeHandler } from '../hooks/useBusyChange';
import {
  Button,
  Callout,
  Field,
  Notice,
  Panel,
  StudioIcon,
} from './primitives';

type Props = {
  token: string;
  status: DatabaseUpgradeStatus;
  refreshStatus: () => Promise<DatabaseUpgradeStatus>;
  headingLevel?: 2 | 3;
  onBusyChange?: BusyChangeHandler;
};

type UpgradeMessage =
  | { kind: 'success' }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: OperationsClientErrorCode }
  | { kind: 'unexpected' };

function errorKey(message: Exclude<UpgradeMessage, { kind: 'success' }>) {
  if (message.kind === 'client') {
    if (message.code === 'INVALID_TOKEN_FORMAT') {
      return 'errors.tokenFormat' as const;
    }
    if (message.code === 'TIMEOUT') return 'errors.timeout' as const;
    if (message.code === 'NETWORK_ERROR') return 'errors.network' as const;
    return 'errors.invalidResponse' as const;
  }
  if (message.kind === 'unexpected') {
    return 'databaseUpgrade.errors.unexpected' as const;
  }
  switch (message.code) {
    case 'INVALID_OPERATIONS_CREDENTIALS':
      return 'databaseUpgrade.errors.invalidCredentials' as const;
    case 'DATABASE_UPGRADE_STATE_CONFLICT':
      return 'databaseUpgrade.errors.stateConflict' as const;
    case 'DATABASE_UPGRADE_NOT_AVAILABLE':
    case 'OPERATIONS_MAINTENANCE_REQUIRED':
    case 'SYSTEM_NOT_AVAILABLE':
      return 'databaseUpgrade.errors.unavailable' as const;
    case 'VALIDATION_ERROR':
    case 'INVALID_JSON':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'PAYLOAD_TOO_LARGE':
      return 'databaseUpgrade.errors.validation' as const;
    case 'INVALID_OPERATIONS_TOKEN':
      return 'errors.invalidToken' as const;
    case 'RATE_LIMIT_EXCEEDED':
      return 'errors.rateLimit' as const;
    default:
      return 'databaseUpgrade.errors.unexpected' as const;
  }
}

function unavailableReasonKey(
  reason: Extract<DatabaseUpgradeStatus, { state: 'unavailable' }>['reason'],
) {
  switch (reason) {
    case 'site_mode':
      return 'databaseUpgrade.reasons.siteMode' as const;
    case 'database_uninstalled':
      return 'databaseUpgrade.reasons.databaseUninstalled' as const;
    case 'database_unmanaged':
      return 'databaseUpgrade.reasons.databaseUnmanaged' as const;
    case 'database_unavailable':
      return 'databaseUpgrade.reasons.databaseUnavailable' as const;
    case 'recovery_required':
      return 'databaseUpgrade.reasons.recoveryRequired' as const;
    case 'newer_than_code':
      return 'databaseUpgrade.reasons.newerThanCode' as const;
    case 'unsupported':
      return 'databaseUpgrade.reasons.unsupported' as const;
    case 'artifact_chain_invalid':
      return 'databaseUpgrade.reasons.artifactChainInvalid' as const;
  }
}

function StepList({ steps }: { steps: DatabaseUpgradeStep[] }) {
  const { t } = useTranslation('operations');
  return (
    <ol className="operations-upgrade-steps">
      {steps.map((step) => (
        <li className="operations-upgrade-step" key={step.id}>
          <strong>
            {t('databaseUpgrade.stepVersion', {
              from: step.from_version,
              to: step.to_version,
            })}
          </strong>
          <span>{step.id}</span>
          <small>
            {t('databaseUpgrade.statementCount', {
              count: step.statement_count,
            })}
          </small>
          <code>{step.sha256}</code>
        </li>
      ))}
    </ol>
  );
}

export function DatabaseUpgradePanel({
  token,
  status,
  refreshStatus,
  headingLevel = 3,
  onBusyChange,
}: Props) {
  const { t } = useTranslation('operations');
  const acknowledgementId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [backupAcknowledged, setBackupAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [running, setRunning] = useState(false);
  const [progressVersion, setProgressVersion] = useState<number | null>(null);
  const [message, setMessage] = useState<UpgradeMessage | null>(null);
  useBusyChange(onBusyChange, running);

  useEffect(() => {
    setProgressVersion(status.current_schema_version);
  }, [status]);

  async function applySteps(input: {
    operationId: string;
    firstStep: DatabaseUpgradeStep;
  }) {
    let nextStep: DatabaseUpgradeStep | null = input.firstStep;
    while (nextStep) {
      const parsed = databaseUpgradeStepRequestSchema.safeParse({
        operation_id: input.operationId,
        step_id: nextStep.id,
        confirmation: DATABASE_UPGRADE_CONFIRMATION,
      });
      if (!parsed.success) throw new TypeError('Invalid upgrade step request.');
      const response = await requestDatabaseUpgradeStep({
        token,
        request: parsed.data,
      });
      if (!response.success) {
        setMessage({ kind: 'api', code: response.error.code });
        return false;
      }
      setProgressVersion(response.data.current_schema_version);
      nextStep = response.data.next_step;
    }
    setMessage({ kind: 'success' });
    setPassword('');
    setConfirmation('');
    return true;
  }

  async function execute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running || !status.available) return;
    setMessage(null);
    setRunning(true);
    try {
      if (status.state === 'upgrade_required') {
        const parsed = databaseUpgradeStartRequestSchema.safeParse({
          administrator_email: email,
          administrator_password: password,
          backup_acknowledged: backupAcknowledged,
          confirmation,
        });
        if (!parsed.success) {
          setMessage({ kind: 'api', code: 'VALIDATION_ERROR' });
          return;
        }
        const started = await requestDatabaseUpgradeStart({
          token,
          request: parsed.data,
        });
        if (!started.success) {
          setMessage({ kind: 'api', code: started.error.code });
          return;
        }
        // Authorization is now represented by the server-side lifecycle
        // operation. Do not retain the administrator password while patches
        // continue or wait for a later resume.
        setPassword('');
        await applySteps({
          operationId: started.data.operation_id,
          firstStep: started.data.next_step,
        });
      } else if (status.state === 'in_progress') {
        if (confirmation !== DATABASE_UPGRADE_CONFIRMATION) {
          setMessage({ kind: 'api', code: 'VALIDATION_ERROR' });
          return;
        }
        await applySteps({
          operationId: status.operation_id,
          firstStep: status.steps[0]!,
        });
      }
    } catch (error) {
      setMessage(
        error instanceof OperationsClientError
          ? { kind: 'client', code: error.code }
          : { kind: 'unexpected' },
      );
    } finally {
      try {
        const refreshed = await refreshStatus();
        if (refreshed.state === 'up_to_date') {
          setMessage({ kind: 'success' });
          setPassword('');
          setConfirmation('');
        }
      } catch {
        // The lifecycle row is authoritative. A later dashboard refresh will
        // reconcile a response lost after an atomic step committed.
      }
      setRunning(false);
    }
  }

  const messageText = message
    ? message.kind === 'success'
      ? t('databaseUpgrade.completed')
      : t(errorKey(message))
    : null;

  return (
    <Panel
      headingLevel={headingLevel}
      leading={<StudioIcon icon={CircleArrowUp} />}
      kicker={t('databaseUpgrade.level')}
      title={t('databaseUpgrade.title')}
      description={t('databaseUpgrade.description')}
    >
      <div className="operations-content-card">
        {status.state === 'up_to_date' ? (
          <Callout tone="success" title={t('databaseUpgrade.upToDate')}>
            {t('databaseUpgrade.currentVersion', {
              version: status.current_schema_version,
            })}
          </Callout>
        ) : null}

        {status.state === 'unavailable' ? (
          <Notice tone="error">{t(unavailableReasonKey(status.reason))}</Notice>
        ) : null}

        {status.state === 'upgrade_required' || status.state === 'in_progress' ? (
          <>
            <Callout
              tone="warning"
              title={status.state === 'in_progress'
                ? t('databaseUpgrade.resumeTitle')
                : t('databaseUpgrade.requiredTitle')}
            >
              {t('databaseUpgrade.versionRange', {
                current: progressVersion ?? status.current_schema_version,
                target: status.target_schema_version,
              })}
            </Callout>
            <StepList steps={status.steps} />
            <form
              className="operations-upgrade-form"
              onSubmit={execute}
              noValidate
            >
              {status.state === 'upgrade_required' ? (
                <>
                  <Field label={t('credentials.email')}>
                    {(control) => (
                      <input
                        {...control}
                        type="email"
                        autoComplete="username"
                        maxLength={254}
                        value={email}
                        disabled={running}
                        required
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
                        disabled={running}
                        required
                        onChange={(event) => setPassword(event.target.value)}
                      />
                    )}
                  </Field>
                  <label
                    className="operations-acknowledgement"
                    htmlFor={acknowledgementId}
                  >
                    <input
                      id={acknowledgementId}
                      type="checkbox"
                      checked={backupAcknowledged}
                      disabled={running}
                      onChange={(event) => setBackupAcknowledged(
                        event.target.checked,
                      )}
                    />
                    <span className="operations-acknowledgement-text">
                      <span className="operations-acknowledgement-title">
                        {t('databaseUpgrade.backupAcknowledgement')}
                      </span>
                    </span>
                  </label>
                </>
              ) : (
                <Callout tone="info">{t('databaseUpgrade.resumeNote')}</Callout>
              )}
              <Field
                label={t('databaseUpgrade.confirmationLabel')}
                labelAdornment={(
                  <code className="operations-code">
                    {DATABASE_UPGRADE_CONFIRMATION}
                  </code>
                )}
              >
                {(control) => (
                  <input
                    {...control}
                    value={confirmation}
                    autoComplete="off"
                    disabled={running}
                    required
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                )}
              </Field>
              <div className="operations-actions">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={running || !status.available}
                >
                  <StudioIcon className="operations-button-icon" icon={CircleArrowUp} />
                  {running
                    ? t('databaseUpgrade.running')
                    : status.state === 'in_progress'
                      ? t('databaseUpgrade.resume')
                      : t('databaseUpgrade.start')}
                </Button>
              </div>
            </form>
          </>
        ) : null}

        {messageText ? (
          <Notice tone={message?.kind === 'success' ? 'success' : 'error'}>
            {messageText}
          </Notice>
        ) : null}
      </div>
    </Panel>
  );
}

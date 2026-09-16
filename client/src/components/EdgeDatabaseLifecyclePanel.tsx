import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { DatabaseZap } from 'lucide-react';
import type { ApiErrorCode } from '../../../contracts/api';
import type { DatabaseUpgradeStep } from '../../../contracts/database-upgrade';
import {
  EDGE_DATABASE_ADOPT_CONFIRMATION,
  EDGE_DATABASE_INSTALL_CONFIRMATION,
  EDGE_DATABASE_UPGRADE_CONFIRMATION,
  type EdgeDatabaseStatus,
} from '../../../contracts/edge-database-lifecycle';
import {
  OperationsClientError,
  requestEdgeDatabaseAdoption,
  requestEdgeDatabaseInstall,
  requestEdgeDatabaseUpgradeStart,
  requestEdgeDatabaseUpgradeStep,
} from '../lib/operations-client';
import { useBusyChange, type BusyChangeHandler } from '../hooks/useBusyChange';
import {
  Button,
  Callout,
  DataTable,
  Dialog,
  DialogActions,
  Field,
  Notice,
  Panel,
  Spinner,
  StatusPill,
  StudioIcon,
  type StatusTone,
} from './primitives';

type Action = 'install' | 'adopt' | 'upgrade';

const tones: Record<EdgeDatabaseStatus['state'], StatusTone> = {
  uninstalled: 'attention',
  adoption_required: 'attention',
  ready: 'positive',
  upgrade_required: 'attention',
  in_progress: 'attention',
  recovery_required: 'critical',
  unmanaged: 'critical',
  newer_than_code: 'critical',
  unavailable: 'critical',
};

const confirmations = {
  install: EDGE_DATABASE_INSTALL_CONFIRMATION,
  adopt: EDGE_DATABASE_ADOPT_CONFIRMATION,
  upgrade: EDGE_DATABASE_UPGRADE_CONFIRMATION,
} as const;

export function EdgeDatabaseLifecyclePanel(props: {
  token: string;
  status: EdgeDatabaseStatus;
  studioDatabaseReady: boolean;
  refreshStatus: () => Promise<void>;
  headingLevel?: 2 | 3;
  onBusyChange?: BusyChangeHandler;
}) {
  const { t } = useTranslation('operations');
  const [action, setAction] = useState<Action | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [backup, setBackup] = useState(false);
  const [publicWritesStopped, setPublicWritesStopped] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<
    { tone: 'success' | 'error'; text: string } | null
  >(null);
  useBusyChange(props.onBusyChange, busy);

  const availableAction: Action | null = props.status.install_available
    ? 'install'
    : props.status.adopt_available
      ? 'adopt'
      : props.status.upgrade_available
        ? 'upgrade'
        : null;
  const studioDatabaseBlocksLifecycle = !props.studioDatabaseReady && (
    props.status.state === 'uninstalled'
    || props.status.state === 'adoption_required'
    || props.status.state === 'upgrade_required'
    || props.status.state === 'in_progress'
  );

  function close() {
    if (busy) return;
    resetDialog();
  }

  function resetDialog() {
    setAction(null);
    setPassword('');
    setBackup(false);
    setPublicWritesStopped(false);
    setConfirmation('');
  }

  function apiError(code: ApiErrorCode) {
    setMessage({
      tone: 'error',
      text: code === 'EDGE_DATABASE_STUDIO_NOT_READY'
        ? t('edgeDatabase.errors.studioDatabaseNotReady')
        : t('edgeDatabase.errors.api', { code }),
    });
  }

  async function execute(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!action || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const common = {
        administrator_email: email,
        administrator_password: password,
        public_edge_writes_disabled: publicWritesStopped as true,
      };
      let response;
      if (action === 'install') {
        response = await requestEdgeDatabaseInstall({
          token: props.token,
          request: {
            ...common,
            empty_database_acknowledged: backup as true,
            confirmation: EDGE_DATABASE_INSTALL_CONFIRMATION,
          },
        });
      } else if (action === 'adopt') {
        response = await requestEdgeDatabaseAdoption({
          token: props.token,
          request: {
            ...common,
            backup_acknowledged: backup as true,
            confirmation: EDGE_DATABASE_ADOPT_CONFIRMATION,
          },
        });
      } else {
        response = await requestEdgeDatabaseUpgradeStart({
          token: props.token,
          request: {
            ...common,
            backup_acknowledged: backup as true,
            confirmation: EDGE_DATABASE_UPGRADE_CONFIRMATION,
          },
        });
        if (response.success && response.data.next_step) {
          let next: DatabaseUpgradeStep | null = response.data.next_step;
          const operationId = response.data.operation_id!;
          while (next) {
            const stepped = await requestEdgeDatabaseUpgradeStep({
              token: props.token,
              request: {
                operation_id: operationId,
                step_id: next.id,
                confirmation: EDGE_DATABASE_UPGRADE_CONFIRMATION,
              },
            });
            if (!stepped.success) {
              apiError(stepped.error.code);
              return;
            }
            next = stepped.data.next_step;
          }
        }
      }
      if (!response.success) {
        apiError(response.error.code);
        return;
      }
      setMessage({ tone: 'success', text: t('edgeDatabase.completed') });
      resetDialog();
      await props.refreshStatus();
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof OperationsClientError
          ? t('edgeDatabase.errors.client', { code: error.code })
          : t('edgeDatabase.errors.unexpected'),
      });
    } finally {
      setBusy(false);
      setPassword('');
    }
  }

  return (
    <>
      <Panel
        headingLevel={props.headingLevel ?? 3}
        leading={<StudioIcon icon={DatabaseZap} />}
        kicker={t('edgeDatabase.level')}
        title={t('edgeDatabase.title')}
        description={t('edgeDatabase.description')}
      >
        <div className="operations-content-card">
          <div className="operations-summary">
            <p className="operations-summary-card">
              <span className="operations-summary-label">{t('edgeDatabase.state')}</span>
              <span className="operations-summary-value">
                <StatusPill tone={tones[props.status.state]}>
                  {t(`edgeDatabase.states.${props.status.state}`)}
                </StatusPill>
              </span>
            </p>
            <p className="operations-summary-card">
              <span className="operations-summary-label">{t('edgeDatabase.version')}</span>
              <strong className="operations-summary-value">
                {props.status.current_schema_version ?? '—'} / {props.status.target_schema_version}
              </strong>
            </p>
          </div>
          <Callout
            tone={props.status.state === 'ready' && !studioDatabaseBlocksLifecycle
              ? 'success'
              : 'warning'}
            title={studioDatabaseBlocksLifecycle
              ? t('edgeDatabase.studioDatabaseRequired.title')
              : t(`edgeDatabase.states.${props.status.state}`)}
          >
            {studioDatabaseBlocksLifecycle
              ? t('edgeDatabase.studioDatabaseRequired.description')
              : t(`edgeDatabase.guidance.${props.status.state}`)}
          </Callout>
          {props.status.next_upgrade_steps.length > 0 ? (
            <DataTable
              caption={t('edgeDatabase.steps')}
              minWidthPx={520}
              stacked
              framed
            >
              <thead>
                <tr>
                  <th scope="col">{t('edgeDatabase.stepColumns.step')}</th>
                  <th scope="col">{t('edgeDatabase.stepColumns.version')}</th>
                  <th scope="col">{t('edgeDatabase.stepColumns.statements')}</th>
                </tr>
              </thead>
              <tbody>
                {props.status.next_upgrade_steps.map((step) => (
                  <tr key={step.id}>
                    <th scope="row"><code>{step.id}</code></th>
                    <td data-label={t('edgeDatabase.stepColumns.version')}>
                      {step.from_version} → {step.to_version}
                    </td>
                    <td data-label={t('edgeDatabase.stepColumns.statements')}>
                      {step.statement_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : null}
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          {availableAction ? (
            <div className="operations-actions">
              <Button
                type="button"
                variant="primary"
                onClick={() => setAction(availableAction)}
              >
                <StudioIcon className="operations-button-icon" icon={DatabaseZap} />
                {t(`edgeDatabase.actions.${availableAction}`)}
              </Button>
            </div>
          ) : null}
        </div>
      </Panel>

      <Dialog
        open={action !== null}
        onClose={close}
        busy={busy}
        title={action ? t(`edgeDatabase.actions.${action}`) : ''}
        description={action ? t(`edgeDatabase.confirm.${action}`) : ''}
      >
        {action ? (
          <form className="operations-upgrade-form" onSubmit={execute} noValidate>
            <Field label={t('credentials.email')}>
              {(control) => (
                <input {...control} type="email" value={email} required
                  autoComplete="username" disabled={busy}
                  onChange={(event) => setEmail(event.target.value)} />
              )}
            </Field>
            <Field label={t('credentials.password')}>
              {(control) => (
                <input {...control} type="password" value={password} required
                  autoComplete="current-password" disabled={busy}
                  onChange={(event) => setPassword(event.target.value)} />
              )}
            </Field>
            <label className="operations-acknowledgement">
              <input type="checkbox" checked={backup} disabled={busy}
                onChange={(event) => setBackup(event.target.checked)} />
              <span>{t(action === 'install'
                ? 'edgeDatabase.emptyAcknowledgement'
                : 'edgeDatabase.backupAcknowledgement')}</span>
            </label>
            <label className="operations-acknowledgement">
              <input type="checkbox" checked={publicWritesStopped} disabled={busy}
                onChange={(event) => setPublicWritesStopped(event.target.checked)} />
              <span>{t('edgeDatabase.publicWritesAcknowledgement')}</span>
            </label>
            <Field
              label={t('edgeDatabase.confirmation')}
              labelAdornment={<code className="operations-code">{confirmations[action]}</code>}
            >
              {(control) => (
                <input {...control} value={confirmation} required disabled={busy}
                  autoComplete="off"
                  onChange={(event) => setConfirmation(event.target.value)} />
              )}
            </Field>
            <DialogActions>
              <Button type="button" onClick={close} disabled={busy}>{t('confirmation.cancel')}</Button>
              <Button
                type="submit"
                variant="primary"
                disabled={
                  busy || !backup || !publicWritesStopped
                  || confirmation !== confirmations[action]
                }
              >
                {busy ? <Spinner /> : null}
                <StudioIcon className="operations-button-icon" icon={DatabaseZap} />
                {t(`edgeDatabase.actions.${action}`)}
              </Button>
            </DialogActions>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}

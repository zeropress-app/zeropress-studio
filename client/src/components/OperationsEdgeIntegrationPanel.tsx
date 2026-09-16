import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { CloudCog } from 'lucide-react';
import {
  operationsEdgeIntegrationConfirmation,
} from '../../../contracts/operations';
import type { EdgeServicesDocument } from '../../../contracts/edge-services';
import type { EdgeIntegrationMode } from '../../../contracts/session';
import {
  OperationsClientError,
  requestOperationsEdgeIntegrationUpdate,
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
  StatusPill,
  StudioIcon,
  type StatusTone,
} from './primitives';

const EFFECTIVE_TONES: Record<
  EdgeServicesDocument['effective_state'],
  StatusTone
> = {
  disabled: 'neutral',
  ready: 'positive',
  projection_pending: 'attention',
  reconciliation_required: 'attention',
  unavailable: 'critical',
};

export function OperationsEdgeIntegrationPanel(props: {
  token: string;
  document: EdgeServicesDocument;
  changeAvailable: boolean;
  refreshStatus: () => Promise<void>;
  headingLevel?: 2 | 3;
  onBusyChange?: BusyChangeHandler;
}) {
  const { t } = useTranslation('operations');
  const [pendingMode, setPendingMode] = useState<EdgeIntegrationMode | null>(
    null,
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: 'success' | 'error';
    text: string;
  } | null>(null);
  useBusyChange(props.onBusyChange, busy);

  const expectedConfirmation = pendingMode
    ? operationsEdgeIntegrationConfirmation[pendingMode]
    : '';

  function resetDialog() {
    setPendingMode(null);
    setPassword('');
    setConfirmation('');
  }

  function closeDialog() {
    if (busy) return;
    resetDialog();
  }

  async function updateMode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingMode || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await requestOperationsEdgeIntegrationUpdate({
        token: props.token,
        request: pendingMode === 'enabled'
          ? {
              mode: 'enabled',
              administrator_email: email,
              administrator_password: password,
              expected_revision: props.document.revision,
              confirmation: operationsEdgeIntegrationConfirmation.enabled,
            }
          : {
              mode: 'disabled',
              administrator_email: email,
              administrator_password: password,
              expected_revision: props.document.revision,
              confirmation: operationsEdgeIntegrationConfirmation.disabled,
            },
      });
      if (!response.success) {
        setMessage({
          tone: 'error',
          text: t('edgeIntegration.errors.api', {
            code: response.error.code,
          }),
        });
        return;
      }
      const completedMode = pendingMode;
      resetDialog();
      setMessage({
        tone: 'success',
        text: t(`edgeIntegration.changed.${completedMode}`),
      });
      await props.refreshStatus();
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof OperationsClientError
          ? t('edgeIntegration.errors.client', { code: error.code })
          : t('edgeIntegration.errors.unexpected'),
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
        leading={<StudioIcon icon={CloudCog} />}
        kicker={t('edgeIntegration.level')}
        title={t('edgeIntegration.title')}
        description={t('edgeIntegration.description')}
      >
        <div className="operations-content-card">
          <div className="operations-summary">
            <p className="operations-summary-card">
              <span className="operations-summary-label">
                {t('edgeIntegration.configuredMode')}
              </span>
              <span className="operations-summary-value">
                <StatusPill
                  tone={props.document.settings.mode === 'enabled'
                    ? 'positive'
                    : 'neutral'}
                >
                  {t(`edgeIntegration.modes.${props.document.settings.mode}`)}
                </StatusPill>
              </span>
            </p>
            <p className="operations-summary-card">
              <span className="operations-summary-label">
                {t('edgeIntegration.effectiveState')}
              </span>
              <span className="operations-summary-value">
                <StatusPill
                  tone={EFFECTIVE_TONES[props.document.effective_state]}
                >
                  {t(`edgeIntegration.states.${props.document.effective_state}`)}
                </StatusPill>
              </span>
            </p>
            <p className="operations-summary-card">
              <span className="operations-summary-label">
                {t('edgeIntegration.pendingEvents')}
              </span>
              <strong className="operations-summary-value">
                {props.document.pending_target_events}
              </strong>
            </p>
          </div>
          <Callout
            tone={props.document.effective_state === 'ready'
              || props.document.effective_state === 'disabled'
              ? 'info'
              : 'warning'}
            title={t('edgeIntegration.boundaryTitle')}
          >
            {t('edgeIntegration.boundaryDescription')}
          </Callout>
          {props.document.unavailable_reason ? (
            <Notice tone="error">
              {t('edgeIntegration.unavailableReason', {
                reason: props.document.unavailable_reason,
              })}
            </Notice>
          ) : null}
          {!props.changeAvailable ? (
            <Notice tone="warning">
              {t('edgeIntegration.changeUnavailable')}
            </Notice>
          ) : null}
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          <div className="operations-actions">
            <Button
              type="button"
              variant="primary"
              disabled={
                busy
                || !props.changeAvailable
                || props.document.settings.mode === 'enabled'
              }
              onClick={() => setPendingMode('enabled')}
            >
              <StudioIcon className="operations-button-icon" icon={CloudCog} />
              {t('edgeIntegration.enable')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={
                busy
                || !props.changeAvailable
                || props.document.settings.mode === 'disabled'
              }
              onClick={() => setPendingMode('disabled')}
            >
              <StudioIcon className="operations-button-icon" icon={CloudCog} />
              {t('edgeIntegration.disable')}
            </Button>
          </div>
        </div>
      </Panel>

      <Dialog
        open={pendingMode !== null}
        onClose={closeDialog}
        busy={busy}
        title={pendingMode
          ? t(`edgeIntegration.confirm.${pendingMode}.title`)
          : ''}
        description={pendingMode
          ? t(`edgeIntegration.confirm.${pendingMode}.description`)
          : undefined}
      >
        {pendingMode ? (
          <form
            className="operations-upgrade-form"
            onSubmit={updateMode}
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
            <Field
              label={t('edgeIntegration.confirmation')}
              labelAdornment={(
                <code className="operations-code">
                  {expectedConfirmation}
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
            <DialogActions>
              <Button type="button" disabled={busy} onClick={closeDialog}>
                {t('confirmation.cancel')}
              </Button>
              <Button
                type="submit"
                variant={pendingMode === 'disabled' ? 'danger' : 'primary'}
                disabled={
                  busy
                  || email.length === 0
                  || password.length === 0
                  || confirmation !== expectedConfirmation
                }
              >
                {busy ? <Spinner /> : null}
                <StudioIcon className="operations-button-icon" icon={CloudCog} />
                {t('edgeIntegration.apply')}
              </Button>
            </DialogActions>
          </form>
        ) : null}
      </Dialog>
    </>
  );
}

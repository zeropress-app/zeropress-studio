import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { GitCompareArrows, RefreshCw, Trash2 } from 'lucide-react';
import {
  EDGE_TARGET_ORPHAN_PURGE_CONFIRMATION,
  EDGE_TARGET_RECONCILIATION_CANCEL_CONFIRMATION,
  EDGE_TARGET_RECONCILIATION_CONFIRMATION,
  type EdgeTargetOrphan,
  type EdgeTargetReconciliationStatus,
} from '../../../contracts/edge-target-reconciliation';
import {
  OperationsClientError,
  requestEdgeOrphanPurge,
  requestEdgeOrphans,
  requestEdgeReconciliationCancel,
  requestEdgeReconciliationFinalize,
  requestEdgeReconciliationStart,
  requestEdgeReconciliationStep,
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
} from './primitives';

type DialogKind = 'start' | 'purge' | 'cancel' | null;

export function EdgeTargetReconciliationPanel(props: {
  token: string;
  status: EdgeTargetReconciliationStatus;
  maintenanceRequired: boolean;
  refreshStatus: () => Promise<void>;
  headingLevel?: 2 | 3;
  onBusyChange?: BusyChangeHandler;
}) {
  const { t } = useTranslation('operations');
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [backup, setBackup] = useState(false);
  const [writesStopped, setWritesStopped] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [orphans, setOrphans] = useState<EdgeTargetOrphan[]>([]);
  const [nextOrphanCursor, setNextOrphanCursor] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  useBusyChange(props.onBusyChange, busy);

  useEffect(() => {
    if (
      !props.status.available
      || props.status.state !== 'orphan_review'
      || !props.status.operation_id
    ) {
      setOrphans([]);
      setNextOrphanCursor(null);
      setSelected(new Set());
      return;
    }
    void loadOrphans(props.status.operation_id);
  }, [
    props.status.available,
    props.status.operation_id,
    props.status.state,
  ]);

  async function loadOrphans(
    operationId: string,
    cursor?: number,
    append = false,
  ) {
    try {
      const response = await requestEdgeOrphans({
        token: props.token,
        operationId,
        cursor,
        limit: 50,
      });
      setOrphans((current) => append
        ? [...current, ...response.data.items]
        : response.data.items);
      setNextOrphanCursor(response.data.next_cursor);
    } catch {
      setMessage({ tone: 'error', text: t('edgeReconciliation.errors.load') });
    }
  }

  function closeDialog() {
    if (busy) return;
    resetDialog();
  }

  function resetDialog() {
    setDialog(null);
    setPassword('');
    setBackup(false);
    setWritesStopped(false);
    setConfirmation('');
  }

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await requestEdgeReconciliationStart({
        token: props.token,
        request: {
          administrator_email: email,
          administrator_password: password,
          backup_acknowledged: backup,
          public_edge_writes_disabled: writesStopped,
          confirmation,
        },
      });
      if (!response.success) {
        setMessage({ tone: 'error', text: t('edgeReconciliation.errors.api', { code: response.error.code }) });
        return;
      }
      resetDialog();
      await props.refreshStatus();
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof OperationsClientError
        ? t('edgeReconciliation.errors.client', { code: error.code })
        : t('edgeReconciliation.errors.unexpected') });
    } finally {
      setBusy(false);
      setPassword('');
    }
  }

  async function step() {
    if (!props.status.operation_id || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await requestEdgeReconciliationStep({
        token: props.token,
        operationId: props.status.operation_id,
      });
      if (!response.success) {
        setMessage({ tone: 'error', text: t('edgeReconciliation.errors.api', { code: response.error.code }) });
        return;
      }
      await props.refreshStatus();
    } catch {
      setMessage({ tone: 'error', text: t('edgeReconciliation.errors.unexpected') });
    } finally {
      setBusy(false);
    }
  }

  async function finalize() {
    if (!props.status.operation_id || busy) return;
    setBusy(true);
    try {
      const response = await requestEdgeReconciliationFinalize({
        token: props.token,
        operationId: props.status.operation_id,
      });
      if (!response.success) {
        setMessage({ tone: 'error', text: t('edgeReconciliation.errors.api', { code: response.error.code }) });
        return;
      }
      setMessage({ tone: 'success', text: t('edgeReconciliation.completed') });
      await props.refreshStatus();
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof OperationsClientError
        ? t('edgeReconciliation.errors.client', { code: error.code })
        : t('edgeReconciliation.errors.unexpected') });
    } finally {
      setBusy(false);
    }
  }

  async function confirmSecondary() {
    if (!props.status.operation_id || !dialog || busy) return;
    const action = dialog;
    setBusy(true);
    try {
      const response = dialog === 'purge'
        ? await requestEdgeOrphanPurge({
            token: props.token,
            operationId: props.status.operation_id,
            targetIds: [...selected],
            confirmation,
          })
        : await requestEdgeReconciliationCancel({
            token: props.token,
            operationId: props.status.operation_id,
            confirmation,
          });
      if (!response.success) {
        setMessage({ tone: 'error', text: t('edgeReconciliation.errors.api', { code: response.error.code }) });
        return;
      }
      resetDialog();
      setSelected(new Set());
      await props.refreshStatus();
      if (action === 'purge') await loadOrphans(props.status.operation_id);
    } catch (error) {
      setMessage({ tone: 'error', text: error instanceof OperationsClientError
        ? t('edgeReconciliation.errors.client', { code: error.code })
        : t('edgeReconciliation.errors.unexpected') });
    } finally {
      setBusy(false);
    }
  }

  const selectedComments = orphans
    .filter((item) => selected.has(item.target_id))
    .reduce((sum, item) => sum + item.comment_count, 0);
  const secondaryConfirmation = dialog === 'purge'
    ? EDGE_TARGET_ORPHAN_PURGE_CONFIRMATION
    : EDGE_TARGET_RECONCILIATION_CANCEL_CONFIRMATION;

  return (
    <>
      <Panel
        headingLevel={props.headingLevel ?? 3}
        leading={<StudioIcon icon={GitCompareArrows} />}
        kicker={t('edgeReconciliation.level')}
        title={t('edgeReconciliation.title')}
        description={t('edgeReconciliation.description')}
      >
        <div className="operations-content-card">
          {props.maintenanceRequired ? (
            <Callout
              tone="warning"
              title={t('edgeReconciliation.maintenanceRequired.title')}
            >
              {t('edgeReconciliation.maintenanceRequired.description')}
            </Callout>
          ) : null}
          <Callout
            tone={props.status.state === 'not_required' ? 'success' : 'warning'}
            title={t(`edgeReconciliation.states.${props.status.state}`)}
          >
            {t(`edgeReconciliation.guidance.${props.status.state}`)}
          </Callout>
          <div className="operations-summary">
            {[
              { label: t('edgeReconciliation.metrics.posts'), value: props.status.processed_posts },
              { label: t('edgeReconciliation.metrics.pages'), value: props.status.processed_pages },
              { label: t('edgeReconciliation.metrics.scanned'), value: props.status.scanned_edge_targets },
              { label: t('edgeReconciliation.metrics.orphans'), value: props.status.orphan_targets },
              { label: t('edgeReconciliation.metrics.comments'), value: props.status.orphan_comments },
            ].map((metric) => (
              <p className="operations-summary-card" key={metric.label}>
                <span className="operations-summary-label">{metric.label}</span>
                <strong className="operations-summary-value">{metric.value}</strong>
              </p>
            ))}
          </div>
          {props.status.phase ? (
            <p><StatusPill tone="attention">{t(`edgeReconciliation.phases.${props.status.phase}`)}</StatusPill></p>
          ) : null}
          {props.status.available && orphans.length > 0 ? (
            <DataTable caption={t('edgeReconciliation.orphans.title')} minWidthPx={680}>
              <thead><tr><th>{t('edgeReconciliation.orphans.select')}</th><th>{t('edgeReconciliation.orphans.target')}</th><th>{t('edgeReconciliation.orphans.status')}</th><th>{t('edgeReconciliation.orphans.comments')}</th></tr></thead>
              <tbody>
                {orphans.map((item) => (
                  <tr key={item.target_id}>
                    <td><input type="checkbox" checked={selected.has(item.target_id)} onChange={(event) => {
                      setSelected((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(item.target_id);
                        else next.delete(item.target_id);
                        return next;
                      });
                    }} /></td>
                    <th scope="row">{item.target_type}:{item.target_public_id}</th>
                    <td>{item.status}</td>
                    <td>{item.comment_count}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : null}
          {props.status.available
            && props.status.state === 'orphan_review'
            && nextOrphanCursor !== null ? (
            <div className="operations-actions">
              <Button
                type="button"
                disabled={busy}
                onClick={() => props.status.operation_id
                  ? void loadOrphans(
                      props.status.operation_id,
                      nextOrphanCursor,
                      true,
                    )
                  : undefined}
              >
                {t('edgeReconciliation.actions.loadMore')}
              </Button>
            </div>
          ) : null}
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          <div className="operations-actions">
            {(props.status.state === 'required' || props.status.state === 'not_required')
              && props.status.available ? (
                <Button type="button" variant="primary" onClick={() => setDialog('start')}>
                  <StudioIcon className="operations-button-icon" icon={GitCompareArrows} />
                  {t('edgeReconciliation.actions.start')}
                </Button>
              ) : null}
            {props.status.state === 'in_progress' && props.status.available ? (
              <Button type="button" variant="primary" disabled={busy} onClick={() => void step()}>
                {busy ? <Spinner /> : null}
                <StudioIcon className="operations-button-icon" icon={RefreshCw} />
                {t('edgeReconciliation.actions.step')}
              </Button>
            ) : null}
            {props.status.state === 'orphan_review'
              && props.status.available
              && selected.size > 0 ? (
              <Button type="button" variant="danger" onClick={() => setDialog('purge')}>
                <StudioIcon className="operations-button-icon" icon={Trash2} />
                {t('edgeReconciliation.actions.purge', { count: selected.size })}
              </Button>
            ) : null}
            {props.status.state === 'orphan_review'
              && props.status.available
              && props.status.orphan_targets === 0 ? (
              <Button type="button" variant="primary" disabled={busy} onClick={() => void finalize()}>
                <StudioIcon className="operations-button-icon" icon={GitCompareArrows} />
                {t('edgeReconciliation.actions.finalize')}
              </Button>
            ) : null}
            {props.status.available
              && (props.status.state === 'in_progress'
                || props.status.state === 'orphan_review') ? (
              <Button type="button" disabled={busy} onClick={() => setDialog('cancel')}>
                {t('edgeReconciliation.actions.cancel')}
              </Button>
            ) : null}
          </div>
        </div>
      </Panel>

      <Dialog
        open={dialog !== null}
        onClose={closeDialog}
        busy={busy}
        title={dialog ? t(`edgeReconciliation.dialog.${dialog}.title`) : ''}
        description={dialog ? t(`edgeReconciliation.dialog.${dialog}.description`, {
          targets: selected.size,
          comments: selectedComments,
        }) : ''}
      >
        {dialog === 'start' ? (
          <form className="operations-upgrade-form" onSubmit={start} noValidate>
            <Field label={t('credentials.email')}>{(control) => (
              <input {...control} type="email" value={email} required disabled={busy}
                autoComplete="username" onChange={(event) => setEmail(event.target.value)} />
            )}</Field>
            <Field label={t('credentials.password')}>{(control) => (
              <input {...control} type="password" value={password} required disabled={busy}
                autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
            )}</Field>
            <label className="operations-acknowledgement"><input type="checkbox" checked={backup} onChange={(event) => setBackup(event.target.checked)} /><span>{t('edgeReconciliation.backupAcknowledgement')}</span></label>
            <label className="operations-acknowledgement"><input type="checkbox" checked={writesStopped} onChange={(event) => setWritesStopped(event.target.checked)} /><span>{t('edgeReconciliation.publicWritesAcknowledgement')}</span></label>
            <Field label={t('edgeReconciliation.confirmation')} labelAdornment={<code className="operations-code">{EDGE_TARGET_RECONCILIATION_CONFIRMATION}</code>}>
              {(control) => <input {...control} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />}
            </Field>
            <DialogActions>
              <Button type="button" onClick={closeDialog}>{t('confirmation.cancel')}</Button>
              <Button type="submit" variant="primary" disabled={busy || !backup || !writesStopped || confirmation !== EDGE_TARGET_RECONCILIATION_CONFIRMATION}>
                <StudioIcon className="operations-button-icon" icon={GitCompareArrows} />
                {t('edgeReconciliation.actions.start')}
              </Button>
            </DialogActions>
          </form>
        ) : dialog ? (
          <div className="operations-upgrade-form">
            <Callout tone={dialog === 'purge' ? 'warning' : 'info'}>
              {t(`edgeReconciliation.dialog.${dialog}.impact`, {
                targets: selected.size,
                comments: selectedComments,
              })}
            </Callout>
            <Field label={t('edgeReconciliation.confirmation')} labelAdornment={<code className="operations-code">{secondaryConfirmation}</code>}>
              {(control) => <input {...control} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />}
            </Field>
            <DialogActions>
              <Button type="button" onClick={closeDialog}>{t('confirmation.cancel')}</Button>
              <Button type="button" variant={dialog === 'purge' ? 'danger' : 'primary'} disabled={busy || confirmation !== secondaryConfirmation} onClick={() => void confirmSecondary()}>
                <StudioIcon className="operations-button-icon" icon={dialog === 'purge' ? Trash2 : GitCompareArrows} />
                {t(`edgeReconciliation.actions.${dialog}`)}
              </Button>
            </DialogActions>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleCheck,
  Clock3,
  CloudCog,
  Power,
  PowerOff,
  RefreshCw,
  Settings2,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import type { ApiErrorCode } from '../../contracts/api';
import type { EdgeServicesDocument } from '../../contracts/edge-services';
import type { EdgeDatabaseRuntimeState } from '../../contracts/edge-runtime';
import {
  EDGE_WORKER_CONFIGURATION_CATALOG,
} from '../../contracts/worker-configuration';
import type {
  CurrentSessionSuccess,
  EdgeIntegrationMode,
} from '../../contracts/session';
import { EdgeSettingsLayout } from './components/EdgeSettingsLayout';
import {
  Button,
  ButtonLink,
  Callout,
  ConfigurationReference,
  Dialog,
  InlineStatus,
  Notice,
  PageHeader,
  Panel,
  StatusPill,
  StudioIcon,
  type StatusTone,
} from './components/primitives';
import { useEdgeIntegration } from './EdgeIntegrationContext';
import {
  EdgeServicesClientError,
  requestDrainEdgeProjections,
  requestEdgeServices,
  requestUpdateEdgeServices,
} from './lib/edge-services-client';

type SessionData = CurrentSessionSuccess['data'];
type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: 'NETWORK_ERROR' | 'TIMEOUT' | 'INVALID_RESPONSE' }
  | { kind: 'unexpected' };

const MAINTENANCE_ERROR_CODES = new Set<ApiErrorCode>([
  'EDGE_RECONCILIATION_REQUIRED',
  'EDGE_DATABASE_INSTALL_REQUIRED',
  'EDGE_DATABASE_ADOPTION_REQUIRED',
  'EDGE_DATABASE_UPGRADE_REQUIRED',
  'EDGE_DATABASE_RECOVERY_REQUIRED',
]);

function databaseState(
  document: EdgeServicesDocument,
): EdgeDatabaseRuntimeState {
  if (document.effective_state !== 'unavailable') return 'ready';
  if (document.unavailable_reason === 'database_upgrade_required') {
    return 'upgrade_required';
  }
  if (
    document.unavailable_reason === 'database_recovery_required'
    || document.unavailable_reason === 'database_unmanaged'
    || document.unavailable_reason === 'database_newer_than_code'
    || document.unavailable_reason === 'schema_incomplete'
    || document.unavailable_reason === 'seed_incomplete'
  ) return 'recovery_required';
  return 'unavailable';
}

const EFFECTIVE_TONES: Record<EdgeServicesDocument['effective_state'], StatusTone> = {
  disabled: 'neutral',
  ready: 'positive',
  projection_pending: 'attention',
  reconciliation_required: 'attention',
  unavailable: 'critical',
};

const EFFECTIVE_ICONS: Record<EdgeServicesDocument['effective_state'], LucideIcon> = {
  disabled: PowerOff,
  ready: CircleCheck,
  projection_pending: Clock3,
  reconciliation_required: RefreshCw,
  unavailable: TriangleAlert,
};

function asFailure(error: unknown): Failure {
  return error instanceof EdgeServicesClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

export function EdgeServicesSettingsPage(input: {
  data: SessionData;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('edgeServices');
  const edgeIntegration = useEdgeIntegration();
  const [settingsDocument, setSettingsDocument] = useState<EdgeServicesDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pendingMode, setPendingMode] = useState<EdgeIntegrationMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [draining, setDraining] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useStudioDocumentTitle(t('documentTitle'));

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    void requestEdgeServices(controller.signal).then((response) => {
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setSettingsDocument(response.data);
      edgeIntegration.setMode(response.data.settings.mode);
      edgeIntegration.setDatabaseState(databaseState(response.data));
    }).catch((error) => {
      if (!controller.signal.aborted) setFailure(asFailure(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [
    attempt,
    edgeIntegration.setDatabaseState,
    edgeIntegration.setMode,
    input.onSessionEnded,
  ]);

  function failureMessage(value: Failure): string {
    if (value.kind === 'client') return t(`errors.${value.code}`);
    if (value.kind === 'unexpected') return t('errors.unexpected');
    if (value.code === 'SETTINGS_REVISION_CONFLICT') return t('errors.conflict');
    if (value.code === 'EDGE_RECONCILIATION_REQUIRED') {
      return t('errors.reconciliationRequired');
    }
    if (value.code === 'EDGE_TARGET_PROJECTION_PENDING') {
      return t('errors.projectionPending');
    }
    if (value.code === 'EDGE_INTEGRATION_UNAVAILABLE') {
      return t('errors.unavailable');
    }
    if (value.code === 'EDGE_DATABASE_INSTALL_REQUIRED') {
      return t('errors.installRequired');
    }
    if (value.code === 'EDGE_DATABASE_ADOPTION_REQUIRED') {
      return t('errors.adoptionRequired');
    }
    if (value.code === 'EDGE_DATABASE_UPGRADE_REQUIRED') {
      return t('errors.upgradeRequired');
    }
    if (value.code === 'EDGE_DATABASE_RECOVERY_REQUIRED') {
      return t('errors.recoveryRequired');
    }
    if (value.code === 'FORBIDDEN') return t('errors.forbidden');
    return t('errors.api');
  }

  async function confirmModeChange() {
    if (!settingsDocument || !pendingMode || saving) return;
    setSaving(true);
    setFailure(null);
    setSuccessMessage(null);
    try {
      const response = await requestUpdateEdgeServices({
        csrfToken: input.data.csrf_token,
        settings: { mode: pendingMode },
        expectedRevision: settingsDocument.revision,
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setPendingMode(null);
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setSettingsDocument(response.data);
      edgeIntegration.setMode(response.data.settings.mode);
      edgeIntegration.setDatabaseState(databaseState(response.data));
      setPendingMode(null);
      setSuccessMessage(response.data.settings.mode === 'enabled'
        ? t('mode.changed.enabled')
        : t('mode.changed.disabled'));
    } catch (error) {
      setFailure(asFailure(error));
    } finally {
      setSaving(false);
    }
  }

  async function drainPending() {
    if (draining) return;
    setDraining(true);
    setFailure(null);
    setSuccessMessage(null);
    try {
      const response = await requestDrainEdgeProjections({
        csrfToken: input.data.csrf_token,
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setSuccessMessage(t('projections.completed', response.data));
      setAttempt((value) => value + 1);
    } catch (error) {
      setFailure(asFailure(error));
    } finally {
      setDraining(false);
    }
  }

  const nextMode: EdgeIntegrationMode | null = settingsDocument
    ? settingsDocument.settings.mode === 'enabled' ? 'disabled' : 'enabled'
    : null;
  const opensMaintenance = settingsDocument
    ? settingsDocument.effective_state === 'unavailable'
      || settingsDocument.effective_state === 'reconciliation_required'
    : false;

  return (
    <main id="studio-main-content" aria-labelledby="edge-services-title">
      <PageHeader
        titleId="edge-services-title"
        kicker={t('kicker')}
        title={t('title')}
        description={t('description')}
      />
      <EdgeSettingsLayout>
        <div className="settings-stack">
          {loading && !settingsDocument ? <InlineStatus>{t('loading')}</InlineStatus> : null}
          {failure ? <Notice tone="error">{failureMessage(failure)}</Notice> : null}
          {failure?.kind === 'api' && MAINTENANCE_ERROR_CODES.has(failure.code) ? (
            <div className="settings-action-row">
              <ButtonLink to="/system/operations/edge">
                <StudioIcon icon={Wrench} />
                {t('status.openMaintenance')}
              </ButtonLink>
            </div>
          ) : null}
          {successMessage ? <Notice tone="success">{successMessage}</Notice> : null}
          {!loading && !settingsDocument ? (
            <Panel
              title={t('loadError.title')}
              description={t('loadError.description')}
              actions={(
                <Button type="button" onClick={() => setAttempt((value) => value + 1)}>
                  <StudioIcon icon={RefreshCw} />
                  {t('actions.retry')}
                </Button>
              )}
            />
          ) : null}
          {settingsDocument && nextMode ? (
            <>
              <Panel
                kicker={t('status.kicker')}
                leading={<StudioIcon icon={EFFECTIVE_ICONS[settingsDocument.effective_state]} />}
                title={t('status.title')}
                description={t(`status.description.${settingsDocument.effective_state}`)}
                actions={(
                  <StatusPill tone={EFFECTIVE_TONES[settingsDocument.effective_state]}>
                    {t(`status.value.${settingsDocument.effective_state}`)}
                  </StatusPill>
                )}
                footer={opensMaintenance ? (
                  <div className="edge-settings-status-actions">
                    <ButtonLink to="/system/operations/edge">
                      <StudioIcon icon={Wrench} />
                      {t('status.openMaintenance')}
                    </ButtonLink>
                  </div>
                ) : undefined}
              >
                <div className="edge-settings-status-body">
                  <dl className="edge-settings-status-facts">
                    <div><dt>{t('status.configuredMode')}</dt><dd>{t(`mode.value.${settingsDocument.settings.mode}`)}</dd></div>
                    <div><dt>{t('status.pending')}</dt><dd>{t('status.pendingValue', { count: settingsDocument.pending_target_events })}</dd></div>
                  </dl>
                  {settingsDocument.unavailable_reason ? (
                    <Callout tone="warning" title={t('status.reason')}>
                      {t(`reasons.${settingsDocument.unavailable_reason}`)}
                    </Callout>
                  ) : null}
                </div>
              </Panel>
              <Panel
                leading={<StudioIcon icon={CloudCog} />}
                title={t('mode.title')}
                description={t('mode.description')}
                footer={(
                  <>
                    <span className="edge-settings-mode-current">
                      {t('mode.current', {
                        value: t(`mode.value.${settingsDocument.settings.mode}`),
                      })}
                    </span>
                    <Button
                      type="button"
                      variant={nextMode === 'disabled' ? 'danger' : 'primary'}
                      disabled={saving}
                      onClick={() => setPendingMode(nextMode)}
                    >
                      <StudioIcon icon={nextMode === 'disabled' ? PowerOff : Power} />
                      {t(nextMode === 'disabled' ? 'mode.disable' : 'mode.enable')}
                    </Button>
                  </>
                )}
              >
                <Callout tone="info" title={t('mode.boundaryTitle')}>
                  {t('mode.boundaryDescription')}
                </Callout>
                <details className="edge-settings-technical-details">
                  <summary>
                    <StudioIcon icon={Settings2} />
                    {t('mode.technicalDetails')}
                  </summary>
                  <div className="settings-worker-configuration">
                    <p>{t('mode.technicalDescription')}</p>
                    <ul className="settings-worker-configuration-list">
                      <li>
                        <ConfigurationReference
                          name="EDGE_MAINTENANCE_MODE"
                          kind={EDGE_WORKER_CONFIGURATION_CATALOG
                            .EDGE_MAINTENANCE_MODE.kind}
                        />
                        <span>{t('mode.maintenanceVariable')}</span>
                      </li>
                      <li>
                        <div className="settings-worker-configuration-group">
                          <ConfigurationReference
                            name="COMMENTS_ENABLED"
                            kind={EDGE_WORKER_CONFIGURATION_CATALOG
                              .COMMENTS_ENABLED.kind}
                          />
                          <ConfigurationReference
                            name="FORMS_ENABLED"
                            kind={EDGE_WORKER_CONFIGURATION_CATALOG
                              .FORMS_ENABLED.kind}
                          />
                          <ConfigurationReference
                            name="NEWSLETTER_ENABLED"
                            kind={EDGE_WORKER_CONFIGURATION_CATALOG
                              .NEWSLETTER_ENABLED.kind}
                          />
                        </div>
                        <span>{t('mode.featureVariables')}</span>
                      </li>
                    </ul>
                  </div>
                </details>
              </Panel>
              {settingsDocument.settings.mode === 'enabled'
                && settingsDocument.pending_target_events > 0 ? (
                  <Panel
                    leading={<StudioIcon icon={RefreshCw} />}
                    title={t('projections.title')}
                    description={t('projections.description')}
                    actions={(
                      <Button
                        type="button"
                        disabled={draining}
                        onClick={() => void drainPending()}
                      >
                        <StudioIcon icon={RefreshCw} />
                        {draining ? t('projections.running') : t('projections.retry')}
                      </Button>
                    )}
                  />
                ) : null}
            </>
          ) : null}
        </div>
      </EdgeSettingsLayout>
      <Dialog
        open={pendingMode !== null}
        onClose={() => setPendingMode(null)}
        busy={saving}
        initialFocusRef={cancelRef}
        kicker={t('confirm.kicker')}
        title={pendingMode ? t(`confirm.${pendingMode}.title`) : ''}
        description={pendingMode ? t(`confirm.${pendingMode}.description`) : undefined}
        actions={(
          <>
            <Button ref={cancelRef} type="button" disabled={saving} onClick={() => setPendingMode(null)}>
              {t('confirm.cancel')}
            </Button>
            <Button type="button" variant={pendingMode === 'disabled' ? 'danger' : 'primary'} disabled={saving} onClick={() => void confirmModeChange()}>
              {saving ? t('confirm.running') : t('confirm.apply')}
            </Button>
          </>
        )}
      />
    </main>
  );
}

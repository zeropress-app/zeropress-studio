import { useTranslation } from 'react-i18next';
import { Cloud } from 'lucide-react';
import { EdgeDatabaseLifecyclePanel } from '../components/EdgeDatabaseLifecyclePanel';
import { EdgeDatabaseUninstallPanel } from '../components/EdgeDatabaseUninstallPanel';
import { EdgeTargetReconciliationPanel } from '../components/EdgeTargetReconciliationPanel';
import { OperationsEdgeIntegrationPanel } from '../components/OperationsEdgeIntegrationPanel';
import {
  useOperationsActivity,
  useOperationsContext,
} from './operations-context';
import { OperationsPageHeading } from './OperationsPageHeading';
import { OperationsUnavailable } from './OperationsUnavailable';

export function OperationsEdgePage() {
  const { t } = useTranslation('operations');
  const { token, status, refreshStatus } = useOperationsContext();
  const reportIntegrationBusy = useOperationsActivity('edge-integration');
  const reportLifecycleBusy = useOperationsActivity('edge-lifecycle');
  const reportUninstallBusy = useOperationsActivity('edge-uninstall');
  const reportReconciliationBusy = useOperationsActivity('edge-reconciliation');
  const studioDatabaseInstalled = status.database.state !== 'uninstalled';
  const showIntegration = status.database.state === 'ready'
    && status.edge_integration.document !== null
    && (status.site_mode === 'operational' || status.site_mode === 'maintenance');
  const showOperationalUpgrade = status.site_mode === 'operational'
    && (
      status.edge_database.state === 'upgrade_required'
      || status.edge_database.state === 'in_progress'
    );
  const showLifecycle = studioDatabaseInstalled
    && (status.site_mode === 'maintenance' || showOperationalUpgrade);
  const showUninstall = studioDatabaseInstalled
    && status.site_mode === 'maintenance';
  const showReconciliation = studioDatabaseInstalled && (
    status.site_mode === 'maintenance'
    || (
      status.site_mode === 'operational'
      && status.edge_target_reconciliation.state !== 'not_required'
      && status.edge_target_reconciliation.state !== 'unavailable'
    )
  );
  const available = showIntegration || showLifecycle || showReconciliation;

  return (
    <div className="operations-page">
      <OperationsPageHeading
        icon={Cloud}
        kicker={t('pages.edge.kicker')}
        title={t('pages.edge.title')}
        description={t('pages.edge.description')}
      />
      {available ? (
        <div className="operations-stack">
          {showIntegration ? (
            <OperationsEdgeIntegrationPanel
              token={token}
              document={status.edge_integration.document!}
              changeAvailable={status.edge_integration.change_available}
              refreshStatus={refreshStatus}
              headingLevel={2}
              onBusyChange={reportIntegrationBusy}
            />
          ) : null}
          {showLifecycle ? (
            <EdgeDatabaseLifecyclePanel
              token={token}
              status={status.edge_database}
              studioDatabaseReady={status.database.state === 'ready'}
              refreshStatus={refreshStatus}
              headingLevel={2}
              onBusyChange={reportLifecycleBusy}
            />
          ) : null}
          {showUninstall ? (
            <EdgeDatabaseUninstallPanel
              token={token}
              status={status.edge_database}
              edgeIntegrationMode={status.edge_integration.mode}
              studioDatabaseReady={status.database.state === 'ready'}
              refreshStatus={refreshStatus}
              headingLevel={2}
              onBusyChange={reportUninstallBusy}
            />
          ) : null}
          {showReconciliation ? (
            <EdgeTargetReconciliationPanel
              token={token}
              status={status.edge_target_reconciliation}
              maintenanceRequired={status.site_mode !== 'maintenance'}
              refreshStatus={refreshStatus}
              headingLevel={2}
              onBusyChange={reportReconciliationBusy}
            />
          ) : null}
        </div>
      ) : (
        <OperationsUnavailable title={t('pages.edge.unavailableTitle')}>
          {t('pages.edge.unavailableDescription')}
        </OperationsUnavailable>
      )}
    </div>
  );
}

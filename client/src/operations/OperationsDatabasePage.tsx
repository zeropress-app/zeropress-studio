import { useTranslation } from 'react-i18next';
import { Database } from 'lucide-react';
import { ContentSearchIndexPanel } from '../components/ContentSearchIndexPanel';
import { DatabaseBackupPanel } from '../components/DatabaseBackupPanel';
import { DatabaseUpgradePanel } from '../components/DatabaseUpgradePanel';
import {
  useOperationsActivity,
  useOperationsContext,
} from './operations-context';
import { OperationsPageHeading } from './OperationsPageHeading';
import { OperationsUnavailable } from './OperationsUnavailable';

export function OperationsDatabasePage() {
  const { t } = useTranslation('operations');
  const {
    token,
    status,
    refreshDatabaseUpgradeStatus,
    refreshStatus,
  } = useOperationsContext();
  const reportTransferBusy = useOperationsActivity('database-transfer');
  const reportUpgradeBusy = useOperationsActivity('database-upgrade');
  const reportSearchBusy = useOperationsActivity('content-search-index');
  const studioDatabaseInstalled = status.database.state !== 'uninstalled';
  const showTransfer = Object.values(status.database_transfer.databases)
    .some((database) => (
      database.export_available || database.restore_available
    ));
  const showSearch = status.database.state === 'ready'
    && (status.site_mode === 'maintenance' || status.site_mode === 'recovery');
  const showUpgrade = status.site_mode === 'maintenance'
    && studioDatabaseInstalled;
  const available = showTransfer || showSearch || showUpgrade;

  return (
    <div className="operations-page">
      <OperationsPageHeading
        icon={Database}
        kicker={t('pages.database.kicker')}
        title={t('pages.database.title')}
        description={t('pages.database.description')}
      />
      {available ? (
        <div className="operations-stack">
          {showTransfer ? (
            <DatabaseBackupPanel
              token={token}
              availability={status.database_transfer}
              siteMode={status.site_mode}
              databaseState={status.database.state}
              headingLevel={2}
              onBusyChange={reportTransferBusy}
            />
          ) : null}
          {showUpgrade ? (
            <DatabaseUpgradePanel
              token={token}
              status={status.database_upgrade}
              refreshStatus={refreshDatabaseUpgradeStatus}
              headingLevel={2}
              onBusyChange={reportUpgradeBusy}
            />
          ) : null}
          {showSearch ? (
            <ContentSearchIndexPanel
              token={token}
              status={status.content_search_index}
              refreshStatus={refreshStatus}
              headingLevel={2}
              onBusyChange={reportSearchBusy}
            />
          ) : null}
        </div>
      ) : (
        <OperationsUnavailable title={t('pages.database.unavailableTitle')}>
          {t('pages.database.unavailableDescription')}
        </OperationsUnavailable>
      )}
    </div>
  );
}

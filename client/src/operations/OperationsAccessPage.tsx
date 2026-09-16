import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { CloudflareAccessManager } from '../CloudflareAccessSettingsPage';
import { CloudflareAccessRecoveryPanel } from '../components/CloudflareAccessRecoveryPanel';
import {
  useOperationsActivity,
  useOperationsContext,
} from './operations-context';
import { OperationsPageHeading } from './OperationsPageHeading';
import { OperationsUnavailable } from './OperationsUnavailable';

export function OperationsAccessPage() {
  const { t } = useTranslation('operations');
  const {
    token,
    status,
    operationalAccess,
    refreshStatus,
    endOperationalSession,
  } = useOperationsContext();
  const reportAccessSettingsBusy = useOperationsActivity('access-settings');
  const reportAccessRecoveryBusy = useOperationsActivity('access-recovery');

  return (
    <div className="operations-page">
      <OperationsPageHeading
        icon={ShieldCheck}
        kicker={t('pages.access.kicker')}
        title={t('pages.access.title')}
        description={t('pages.access.description')}
      />
      {status.site_mode === 'operational' && operationalAccess ? (
        <CloudflareAccessManager
          token={token}
          onSessionEnded={endOperationalSession}
          onBusyChange={reportAccessSettingsBusy}
        />
      ) : status.site_mode === 'recovery' ? (
        <CloudflareAccessRecoveryPanel
          token={token}
          status={status.cloudflare_access}
          refreshStatus={refreshStatus}
          headingLevel={2}
          onBusyChange={reportAccessRecoveryBusy}
        />
      ) : (
        <OperationsUnavailable title={t('pages.access.unavailableTitle')}>
          {t('pages.access.unavailableDescription')}
        </OperationsUnavailable>
      )}
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { KeyRound } from 'lucide-react';
import { AdministratorRecoveryPanel } from '../components/AdministratorRecoveryPanel';
import {
  useOperationsActivity,
  useOperationsContext,
} from './operations-context';
import { OperationsPageHeading } from './OperationsPageHeading';
import { OperationsUnavailable } from './OperationsUnavailable';

export function OperationsRecoveryPage() {
  const { t } = useTranslation('operations');
  const { token, status } = useOperationsContext();
  const reportRecoveryBusy = useOperationsActivity('administrator-recovery');

  return (
    <div className="operations-page">
      <OperationsPageHeading
        icon={KeyRound}
        kicker={t('pages.recovery.kicker')}
        title={t('pages.recovery.title')}
        description={t('pages.recovery.description')}
      />
      {status.site_mode === 'recovery' ? (
        <AdministratorRecoveryPanel
          token={token}
          headingLevel={2}
          onBusyChange={reportRecoveryBusy}
        />
      ) : (
        <OperationsUnavailable title={t('pages.recovery.unavailableTitle')}>
          {t('pages.recovery.unavailableDescription')}
        </OperationsUnavailable>
      )}
    </div>
  );
}

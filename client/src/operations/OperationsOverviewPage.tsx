import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import {
  Cloud,
  Database,
  Gauge,
  Globe,
  Settings2,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type { OperationsStatusData } from '../../../contracts/operations';
import {
  Callout,
  ConfigurationKindBadge,
  DataTable,
  Panel,
  StatusPill,
  StudioIcon,
  type StatusTone,
} from '../components/primitives';
import { useOperationsContext } from './operations-context';
import { OperationsPageHeading } from './OperationsPageHeading';

const SITE_MODE_TONE = {
  initial: 'attention',
  operational: 'positive',
  maintenance: 'attention',
  recovery: 'critical',
} as const satisfies Record<
  NonNullable<OperationsStatusData['site_mode']>,
  StatusTone
>;

const DATABASE_STATE_TONE = {
  uninstalled: 'attention',
  ready: 'positive',
  upgrade_required: 'attention',
  update_in_progress: 'attention',
  recovery_required: 'critical',
  newer_than_code: 'critical',
  unsupported: 'critical',
  unmanaged: 'critical',
  unavailable: 'critical',
} as const satisfies Record<
  OperationsStatusData['database']['state'],
  StatusTone
>;

type SummaryIconKind = 'mode' | 'database' | 'connection' | 'edge';

const SUMMARY_ICONS = {
  mode: ShieldCheck,
  database: Database,
  connection: Globe,
  edge: Cloud,
} as const satisfies Record<SummaryIconKind, LucideIcon>;

function SummaryCard(input: {
  icon: SummaryIconKind;
  label: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <article className="operations-summary-card">
      <div className="operations-summary-heading">
        <span className="operations-summary-icon">
          <StudioIcon icon={SUMMARY_ICONS[input.icon]} />
        </span>
        <span className="operations-summary-label">{input.label}</span>
      </div>
      <div className="operations-summary-value">{input.children}</div>
      <p className="operations-summary-detail">{input.detail}</p>
    </article>
  );
}

export function OperationsOverviewPage() {
  const { t } = useTranslation('operations');
  const { status } = useOperationsContext();
  const studioDatabaseInstalled = status.database.state !== 'uninstalled';

  return (
    <div className="operations-page">
      <OperationsPageHeading
        icon={Gauge}
        kicker={t('pages.overview.kicker')}
        title={t('pages.overview.title')}
        description={t('pages.overview.description')}
      />

      <div
        className={`operations-summary operations-overview-summary${studioDatabaseInstalled
          ? ' operations-summary-four-columns'
          : ''}`}
        aria-label={t('summary.label')}
      >
        <SummaryCard
          icon="mode"
          label={t('summary.siteMode')}
          detail={t('summary.siteModeHint')}
        >
          <StatusPill
            tone={status.site_mode === null
              ? 'critical'
              : SITE_MODE_TONE[status.site_mode]}
          >
            {status.site_mode === null
              ? t('summary.invalid')
              : t(`summary.siteModes.${status.site_mode}`)}
          </StatusPill>
        </SummaryCard>
        <SummaryCard
          icon="database"
          label={t('summary.database')}
          detail={t('summary.databaseHint')}
        >
          <StatusPill tone={DATABASE_STATE_TONE[status.database.state]}>
            {t(`summary.databaseStates.${status.database.state}`)}
          </StatusPill>
        </SummaryCard>
        <SummaryCard
          icon="connection"
          label={t('summary.currentIp')}
          detail={t('summary.currentIpHint')}
        >
          <strong>{status.current_ip}</strong>
        </SummaryCard>
        {studioDatabaseInstalled ? (
          <SummaryCard
            icon="edge"
            label={t('summary.edgeIntegration')}
            detail={t('summary.edgeIntegrationHint')}
          >
            <StatusPill
              tone={status.edge_integration.mode === 'disabled'
                ? 'neutral'
                : status.edge_integration.document?.effective_state === 'ready'
                  ? 'positive'
                  : 'attention'}
            >
              {t(`edgeIntegration.modes.${status.edge_integration.mode}`)}
            </StatusPill>
          </SummaryCard>
        ) : null}
      </div>

      {status.database.state === 'uninstalled' ? (
        <Callout
          tone="warning"
          title={t(status.site_mode === 'initial'
            ? 'databaseGuidance.uninstalledInitial.title'
            : 'databaseGuidance.uninstalled.title')}
        >
          {t(status.site_mode === 'initial'
            ? 'databaseGuidance.uninstalledInitial.description'
            : 'databaseGuidance.uninstalled.description')}
        </Callout>
      ) : status.site_mode === 'maintenance'
        || status.site_mode === 'recovery' ? (
          <Callout
            tone={status.site_mode === 'recovery' ? 'warning' : 'info'}
            title={t(`modeGuidance.${status.site_mode}.title`)}
          >
            {t(`modeGuidance.${status.site_mode}.description`)}
          </Callout>
        ) : null}

      <Panel
        headingLevel={2}
        leading={<StudioIcon icon={Settings2} />}
        title={t('environment.title')}
        description={t('environment.description')}
        footer={(
          <p className="operations-note">
            {t('environment.allowedIps', {
              ips: status.allowed_ips.join(', '),
            })}
          </p>
        )}
      >
        <div className="operations-content-card">
          <DataTable
            caption={t('environment.tableLabel')}
            minWidthPx={760}
            stacked
          >
            <thead>
              <tr>
                <th scope="col">{t('environment.columns.name')}</th>
                <th scope="col">{t('environment.columns.expectedStorage')}</th>
                <th scope="col">{t('environment.columns.value')}</th>
              </tr>
            </thead>
            <tbody>
              {status.environment.map((entry) => (
                <tr key={entry.name}>
                  <th className="operations-env-key" scope="row">
                    {entry.name}
                  </th>
                  <td
                    className="operations-env-kind"
                    data-label={t('environment.columns.expectedStorage')}
                  >
                    <ConfigurationKindBadge kind={entry.expected_storage} />
                  </td>
                  <td
                    className="operations-env-value"
                    data-label={t('environment.columns.value')}
                  >
                    {entry.exposure === 'value'
                      ? entry.value ?? t('environment.invalid')
                      : (
                        <StatusPill
                          tone={entry.state === 'valid'
                            ? 'positive'
                            : entry.state === 'missing'
                              && entry.name === 'STUDIO_INSTALL_TOKEN'
                              && status.database.state !== 'uninstalled'
                              ? 'positive'
                              : 'critical'}
                        >
                          {entry.state === 'valid'
                            ? t('environment.secretSet')
                            : entry.state === 'must_be_removed'
                              ? t('environment.secretMustBeRemoved')
                              : entry.state === 'invalid'
                                ? t('environment.secretInvalid')
                                : t('environment.secretNotSet')}
                        </StatusPill>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </div>
      </Panel>
    </div>
  );
}

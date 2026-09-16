import { ArrowRight, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { EdgeDatabaseRuntimeState } from '../../contracts/edge-runtime';
import { EdgeSettingsLayout } from './components/EdgeSettingsLayout';
import {
  ButtonLink,
  EmptyState,
  PageHeader,
  StudioIcon,
} from './components/primitives';
import { STUDIO_PATHS } from './routing/studio-routes';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';

type UnavailableState = Exclude<EdgeDatabaseRuntimeState, 'ready'>;

export function EdgeIntegrationUnavailablePage(input: {
  state: UnavailableState;
  settingsContext?: boolean;
  canManageSettings?: boolean;
}) {
  const { t } = useTranslation('edgeServices');
  useStudioDocumentTitle(t('documentTitle'));
  const maintenance = input.state === 'upgrade_required'
    || input.state === 'recovery_required';
  const content = (
    <EmptyState
      title={t(`runtimeUnavailable.${input.state}.actionTitle`)}
      description={t(`runtimeUnavailable.${input.state}.actionDescription`)}
      actions={input.canManageSettings ? (
        <ButtonLink
          variant="primary"
          to={maintenance
            ? '/system/operations/edge'
            : STUDIO_PATHS.edgeServicesSettings}
          external={maintenance}
        >
          {maintenance
            ? t('runtimeUnavailable.openMaintenance')
            : t('runtimeUnavailable.openSettings')}
          <StudioIcon icon={maintenance ? Wrench : ArrowRight} />
        </ButtonLink>
      ) : undefined}
    />
  );

  return (
    <main id="studio-main-content" aria-labelledby="edge-runtime-title">
      <PageHeader
        titleId="edge-runtime-title"
        kicker={t('runtimeUnavailable.kicker')}
        title={t(`runtimeUnavailable.${input.state}.title`)}
        description={t(`runtimeUnavailable.${input.state}.description`)}
      />
      {input.settingsContext ? (
        <EdgeSettingsLayout>{content}</EdgeSettingsLayout>
      ) : content}
    </main>
  );
}

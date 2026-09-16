import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import { EdgeSettingsLayout } from './components/EdgeSettingsLayout';
import {
  ButtonLink,
  EmptyState,
  PageHeader,
  StudioIcon,
} from './components/primitives';
import { STUDIO_PATHS } from './routing/studio-routes';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';

export function EdgeIntegrationDisabledPage(input: {
  settingsContext?: boolean;
}) {
  const { t } = useTranslation('edgeServices');
  useStudioDocumentTitle(t('documentTitle'));
  const content = (
    <EmptyState
      title={t('disabled.actionTitle')}
      description={t('disabled.actionDescription')}
      actions={(
        <ButtonLink variant="primary" to={STUDIO_PATHS.edgeServicesSettings}>
          {t('disabled.openSettings')}
          <StudioIcon icon={ArrowRight} />
        </ButtonLink>
      )}
    />
  );

  return (
    <main id="studio-main-content" aria-labelledby="edge-disabled-title">
      <PageHeader
        titleId="edge-disabled-title"
        kicker={t('disabled.kicker')}
        title={t('disabled.title')}
        description={t('disabled.description')}
      />
      {input.settingsContext ? (
        <EdgeSettingsLayout>{content}</EdgeSettingsLayout>
      ) : content}
    </main>
  );
}

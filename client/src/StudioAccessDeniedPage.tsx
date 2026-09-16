import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import { STUDIO_PATHS } from './routing/studio-routes';
import { ButtonLink } from './components/primitives';

export function StudioAccessDeniedPage() {
  const { t } = useTranslation('studio');

  useStudioDocumentTitle(t('accessDenied.documentTitle'));

  return (
    <main
      id="studio-main-content"
      // Use the same landmark naming pattern as the 404 screen.
      // Otherwise, assistive technology presents this main landmark without a name.
      aria-labelledby="studio-access-denied-title"
      className="studio-not-found"
    >
      <p className="studio-not-found-kicker">{t('accessDenied.kicker')}</p>
      <h1 id="studio-access-denied-title">{t('accessDenied.title')}</h1>
      <p>{t('accessDenied.description')}</p>
      <div className="studio-not-found-action">
        <ButtonLink variant="primary" to={STUDIO_PATHS.dashboard}>
          {t('accessDenied.returnToDashboard')}
        </ButtonLink>
      </div>
    </main>
  );
}

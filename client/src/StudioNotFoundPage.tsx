import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import { STUDIO_PATHS } from './routing/studio-routes';
import { ButtonLink } from './components/primitives';

export function StudioNotFoundPage(input: {
  showReturnAction?: boolean;
} = {}) {
  const { t } = useTranslation('studio');
  const showReturnAction = input.showReturnAction ?? true;

  useStudioDocumentTitle(t('notFound.documentTitle'));

  return (
    <main
      id="studio-main-content"
      className="studio-not-found"
      aria-labelledby="studio-not-found-title"
    >
      <span className="studio-not-found-code" aria-hidden="true">404</span>
      <p className="studio-not-found-kicker">{t('notFound.kicker')}</p>
      <h1 id="studio-not-found-title">{t('notFound.title')}</h1>
      <p>{t('notFound.description')}</p>
      {showReturnAction ? (
        <div className="studio-not-found-action">
          <ButtonLink variant="primary" to={STUDIO_PATHS.dashboard}>
            {t('notFound.returnToDashboard')}
          </ButtonLink>
        </div>
      ) : null}
    </main>
  );
}

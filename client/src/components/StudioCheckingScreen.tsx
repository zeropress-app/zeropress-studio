import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Spinner } from './primitives';
import { StandaloneStatusScreen } from './StandaloneStatusScreen';

/** Shared screen for Studio startup and Operations preflight checks. */
export function StudioCheckingScreen(input: {
  updateDocumentTitle?: boolean;
} = {}) {
  const { t, i18n } = useTranslation('system');

  useEffect(() => {
    if (input.updateDocumentTitle !== false) {
      document.title = t('documentTitle');
    }
  }, [i18n.resolvedLanguage, input.updateDocumentTitle, t]);

  return (
    <StandaloneStatusScreen
      regionLabel={t('regionLabel')}
      brandLabel={t('brandLabel')}
      kicker={t('loading.eyebrow')}
      title={t('loading.title')}
      description={t('loading.message')}
      tone="info"
      pending
      leading={<Spinner size="lg" />}
    />
  );
}

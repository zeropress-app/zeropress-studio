import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import { Field, Notice, PageHeader, Panel } from './components/primitives';
import { changeLocale, getCurrentLocale } from './i18n';
import {
  INTERFACE_LOCALE_METADATA,
  normalizeLocale,
} from './i18n/locale';
import { useStudioInterfaceSettings } from './StudioInterfaceSettingsContext';

/**
 * Studio UI preferences for the current browser.
 *
 * Keep these separate from published-site settings and account security. The language preference
 * is browser-local and does not change Preview Data's site.locale or D1 settings.
 */
export function StudioPreferencesPage() {
  const { t } = useTranslation('preferences');
  const { settings } = useStudioInterfaceSettings();

  useStudioDocumentTitle(t('documentTitle'));

  return (
    <main
      id="studio-main-content"
      aria-labelledby="studio-preferences-title"
    >
      <PageHeader
        titleId="studio-preferences-title"
        kicker={t('kicker')}
        title={t('title')}
        description={t('description')}
      />

      {settings.enabled_locales.length === 1 ? (
        <Notice tone="info" title={t('language.managed.title')}>
          {t('language.managed.description', {
            language: INTERFACE_LOCALE_METADATA[
              settings.enabled_locales[0]
            ].nativeLabel,
          })}
        </Notice>
      ) : <Panel
        layout="split"
        title={t('language.title')}
        description={t('language.description')}
      >
        <div className="settings-fields">
          <Field
            label={t('language.label')}
            hint={t('language.hint')}
          >
            {(control) => (
              <select
                {...control}
                value={getCurrentLocale()}
                onChange={(event) => {
                  const locale = normalizeLocale(
                    event.target.value,
                    settings.enabled_locales,
                  );
                  if (locale) void changeLocale(locale);
                }}
              >
                {settings.enabled_locales.map((locale) => (
                  <option value={locale} key={locale}>
                    {INTERFACE_LOCALE_METADATA[locale].nativeLabel}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </Panel>}
    </main>
  );
}

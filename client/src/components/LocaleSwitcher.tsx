import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import type { SupportedLocale } from '../i18n/locale';
import { ChromeSelect, StudioIcon } from './primitives';
import { useStudioInterfaceSettings } from '../StudioInterfaceSettingsContext';
import { useLocaleSelection } from './useLocaleSelection';

export function LocaleSwitcher(input: {
  /** Defaults to the translated name from the shared UI. */
  label?: string;
  /**
   * Defaults to the organization's D1 locale policy. Only boundaries that must work independently
   * of D1, such as Maintenance & Recovery, explicitly supply all bundled locales.
   */
  availableLocales?: readonly SupportedLocale[];
} = {}) {
  const { t } = useTranslation('common');
  const { settings } = useStudioInterfaceSettings();
  const availableLocales = input.availableLocales ?? settings.enabled_locales;
  const selection = useLocaleSelection(availableLocales);

  if (selection.options.length < 2) return null;

  return (
    <ChromeSelect
      label={input.label ?? t('language.label')}
      icon={(
        <StudioIcon icon={Globe} />
      )}
      value={selection.locale}
      onChange={(value) => {
        void selection.selectLocale(value);
      }}
      options={selection.options}
    />
  );
}

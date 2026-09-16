import { useId, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getThemePreference,
  setThemePreference,
  subscribeThemePreference,
  THEME_PREFERENCES,
  type ThemePreference,
} from '../lib/theme-preference';

/**
 * Theme selection inside the account menu.
 *
 * The three choices include system, which follows the OS and is the default. Persist the
 * preference and apply it through the document root's data-theme so pre-authentication screens
 * share it. Show all choices in a radio group inside the account popover; a cycling button cannot
 * clearly explain both the current choice and next result.
 */
export function ThemeSwitcher() {
  const { t } = useTranslation('common');
  const name = `${useId().replaceAll(':', '')}-theme`;
  const preference = useSyncExternalStore(
    subscribeThemePreference,
    getThemePreference,
    // The hook requires a server snapshot even without SSR. Use the same fallback as inaccessible storage.
    () => 'system' as ThemePreference,
  );

  return (
    <fieldset className="studio-theme-switcher">
      <legend className="studio-theme-switcher-label">
        {t('theme.label')}
      </legend>
      <div className="studio-theme-options">
        {THEME_PREFERENCES.map((option) => (
          <label className="studio-theme-option" key={option}>
            <input
              className="visually-hidden"
              type="radio"
              name={name}
              value={option}
              checked={preference === option}
              onChange={() => setThemePreference(option)}
            />
            <span className="studio-theme-option-label">
              {t(`theme.${option}`)}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

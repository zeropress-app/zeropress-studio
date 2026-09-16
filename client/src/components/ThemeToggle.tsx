import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Moon, Sun } from 'lucide-react';
import {
  getResolvedTheme,
  setThemePreference,
  subscribeThemePreference,
  type ResolvedTheme,
} from '../lib/theme-preference';
import { ChromeToggle, StudioIcon } from './primitives';

/**
 * Compact two-state appearance control for pre-authentication screens.
 *
 * Honor a stored system preference until the user clicks. Then save the opposite of the currently
 * displayed theme as an explicit light/dark preference under the shared zeropress-studio.theme
 * key. The authenticated three-state ThemeSwitcher uses that same preference.
 */
export function ThemeToggle() {
  const { t } = useTranslation('common');
  const resolvedTheme = useSyncExternalStore(
    subscribeThemePreference,
    getResolvedTheme,
    () => 'light' as ResolvedTheme,
  );
  const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
  const label = nextTheme === 'dark'
    ? t('theme.useDark')
    : t('theme.useLight');

  return (
    <ChromeToggle
      label={label}
      onClick={() => setThemePreference(nextTheme)}
      icon={nextTheme === 'dark' ? (
        <StudioIcon icon={Moon} />
      ) : (
        <StudioIcon icon={Sun} />
      )}
    />
  );
}

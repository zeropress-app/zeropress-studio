import { isLocalStorageChange } from './local-storage-event';

export const THEME_STORAGE_KEY = 'zeropress-studio.theme';

/** User preference. `system` explicitly follows the OS; it is not an unset value. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** Applied theme after resolving `system` against the OS setting. */
export type ResolvedTheme = 'light' | 'dark';

export const THEME_PREFERENCES: readonly ThemePreference[] = [
  'system',
  'light',
  'dark',
];

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Browser-local theme preference.
 *
 * Like sidebar collapse, theme depends on the device and lighting. Storing it
 * on the server would also require revision and capability contracts.
 *
 * Resolve the stored choice and OS preference here, then set `data-theme` on
 * the document root. CSS must not independently read `prefers-color-scheme`,
 * which could make some styles dark despite an explicit light preference.
 *
 * The inline script in `index.html` applies the same policy before first paint
 * to avoid a light flash while this module loads.
 */
export function readThemePreference(): ThemePreference {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return THEME_PREFERENCES.includes(stored as ThemePreference)
      ? stored as ThemePreference
      : 'system';
  } catch {
    // Storage may be unavailable in privacy-restricted contexts.
    return 'system';
  }
}

function persist(preference: ThemePreference): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // The current session's theme still works without persistence.
  }
}

function systemPrefersDark(): boolean {
  return globalThis.matchMedia?.(DARK_QUERY).matches ?? false;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') return preference;
  return systemPrefersDark() ? 'dark' : 'light';
}

/**
 * Browser chrome color, matching the `--studio-background` token.
 * `theme-preference.test.ts` checks that the values stay aligned.
 */
const BROWSER_CHROME: Readonly<Record<ResolvedTheme, string>> = {
  light: '#f8eee3',
  dark: '#16100d',
};

export function applyResolvedTheme(theme: ResolvedTheme): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.dataset.theme = theme;
  const meta = globalThis.document
    ?.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', BROWSER_CHROME[theme]);
}

const listeners = new Set<() => void>();
let current = readThemePreference();

export function getThemePreference(): ThemePreference {
  return current;
}

/**
 * External-store snapshot of the resolved theme.
 *
 * The authenticated account menu shows `system | light | dark`, while the
 * compact pre-authentication toggle switches to the opposite visible theme.
 * Expose this snapshot so both controls subscribe to the same store.
 */
export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(current);
}

export function setThemePreference(preference: ThemePreference): void {
  current = preference;
  persist(preference);
  applyResolvedTheme(resolveTheme(preference));
  for (const listener of listeners) listener();
}

export function subscribeThemePreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Apply the stored preference and follow OS changes.
 *
 * Users who choose `system` should see OS theme changes immediately. The inline
 * script already handles first paint; reapplying confirms that result and
 * handles cases where storage could not be read.
 */
export function startThemeSync(): () => void {
  current = readThemePreference();
  applyResolvedTheme(resolveTheme(current));

  const handleStorage = (event: StorageEvent) => {
    if (!isLocalStorageChange(event, THEME_STORAGE_KEY)) return;
    const preference = THEME_PREFERENCES.includes(
      event.newValue as ThemePreference,
    )
      ? event.newValue as ThemePreference
      : 'system';
    current = preference;
    applyResolvedTheme(resolveTheme(preference));
    for (const listener of listeners) listener();
  };
  globalThis.addEventListener?.('storage', handleStorage);

  const query = globalThis.matchMedia?.(DARK_QUERY);
  const handleChange = () => {
    if (current !== 'system') return;
    applyResolvedTheme(resolveTheme(current));
    for (const listener of listeners) listener();
  };
  query?.addEventListener('change', handleChange);
  return () => {
    globalThis.removeEventListener?.('storage', handleStorage);
    query?.removeEventListener('change', handleChange);
  };
}

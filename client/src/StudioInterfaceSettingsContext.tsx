import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  FALLBACK_INTERFACE_LOCALE,
  SUPPORTED_INTERFACE_LOCALES,
  type StudioInterfaceSettings,
} from '../../contracts/studio-interface-settings';
import { changeLocale } from './i18n';
import {
  readPersistedLocale,
  resolveLocale,
} from './i18n/locale';

export const CODE_DEFAULT_INTERFACE_SETTINGS: StudioInterfaceSettings = {
  default_locale: FALLBACK_INTERFACE_LOCALE,
  enabled_locales: [...SUPPORTED_INTERFACE_LOCALES],
};

export const SAFE_INTERFACE_SETTINGS_FALLBACK: StudioInterfaceSettings = {
  default_locale: FALLBACK_INTERFACE_LOCALE,
  enabled_locales: [FALLBACK_INTERFACE_LOCALE],
};

type StudioInterfaceSettingsContextValue = {
  settings: StudioInterfaceSettings;
  organizationPolicyLoaded: boolean;
  applyOrganizationSettings: (
    settings: StudioInterfaceSettings,
  ) => Promise<void>;
};

const StudioInterfaceSettingsContext = createContext<
  StudioInterfaceSettingsContextValue | null
>(null);

export function StudioInterfaceSettingsProvider(input: {
  children: ReactNode;
}) {
  const [settings, setSettings] = useState<StudioInterfaceSettings>(
    CODE_DEFAULT_INTERFACE_SETTINGS,
  );
  const [organizationPolicyLoaded, setOrganizationPolicyLoaded] =
    useState(false);

  const applyOrganizationSettings = useCallback(async (
    nextSettings: StudioInterfaceSettings,
  ) => {
    const preferredLanguages = typeof navigator === 'undefined'
      ? []
      : navigator.languages;
    const locale = resolveLocale({
      storedLocale: readPersistedLocale(),
      preferredLanguages,
      enabledLocales: nextSettings.enabled_locales,
      defaultLocale: nextSettings.default_locale,
    });
    setSettings({
      default_locale: nextSettings.default_locale,
      enabled_locales: [...nextSettings.enabled_locales],
    });
    setOrganizationPolicyLoaded(true);
    await changeLocale(locale);
  }, []);

  const value = useMemo(() => ({
    settings,
    organizationPolicyLoaded,
    applyOrganizationSettings,
  }), [applyOrganizationSettings, organizationPolicyLoaded, settings]);

  return (
    <StudioInterfaceSettingsContext.Provider value={value}>
      {input.children}
    </StudioInterfaceSettingsContext.Provider>
  );
}

export function useStudioInterfaceSettings() {
  return useContext(StudioInterfaceSettingsContext) ?? {
    settings: CODE_DEFAULT_INTERFACE_SETTINGS,
    organizationPolicyLoaded: false,
    async applyOrganizationSettings() {},
  };
}

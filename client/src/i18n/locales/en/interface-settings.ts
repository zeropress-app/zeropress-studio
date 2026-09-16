export const interfaceSettings = {
  documentTitle: 'Studio interface — ZeroPress Studio',
  kicker: 'STUDIO ADMINISTRATION',
  title: 'Studio interface',
  description: 'Choose the languages available in Studio, separately from your public site.',
  loading: {
    title: 'Loading interface settings',
    description: 'Loading the available languages and default choice.',
  },
  loadError: {
    title: 'Interface settings could not be loaded',
    description: 'The current organization language policy has not been changed.',
  },
  fields: {
    defaultLocale: {
      title: 'Default language',
      description: 'Used when neither a saved choice nor the browser language is available.',
      label: 'Default language',
    },
    enabledLocales: {
      title: 'Available languages',
      description: 'Choose the languages people can select. Keep the default language enabled.',
      legend: 'Enabled Studio interface languages',
      defaultBadge: 'Default',
    },
  },
  state: {
    saved: 'Studio interface settings were saved.',
    validation: 'Enable at least one language and keep the default language enabled.',
    lastSaved: 'Last saved {{date}}',
  },
  conflict: {
    title: 'Interface settings changed elsewhere',
    description: 'Reload the latest settings before making another change.',
    reload: 'Reload latest settings',
  },
  errors: {
    forbidden: 'Your account cannot manage Studio interface settings.',
    timeout: 'The request timed out. The stored settings were not changed.',
    network: 'Studio could not reach the settings API.',
    invalidResponse: 'Studio received an invalid interface-settings response.',
    api: 'Interface settings could not be saved.',
  },
  actions: {
    save: 'Save interface settings',
  },
} as const;

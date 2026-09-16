export const outputSettings = {
  documentTitle: 'Display & output — ZeroPress Studio',
  kicker: 'SITE CONFIGURATION',
  title: 'Display & output',
  description: 'Choose how your site displays content and appears in search results.',
  loading: {
    title: 'Loading output settings',
    description: 'Studio is reading the current output configuration.',
  },
  loadError: {
    title: 'Output settings could not be loaded',
    description: 'Your existing settings have not been changed.',
    retry: 'Try again',
  },
  pagination: {
    title: 'Pagination & dates',
    description: 'Choose how many posts appear per page and how dates are displayed.',
  },
  features: {
    title: 'Site features',
    description: 'Enable the features supported by your site’s theme.',
    menuNotice: 'Disabling RSS or the archive does not remove links already saved in menus.',
  },
  footer: {
    title: 'Footer',
    description: 'Set footer text and credits. Your theme decides how they appear.',
  },
  visibility: {
    title: 'Visibility & metadata',
    description: 'Control search-engine indexing and ZeroPress identification.',
  },
  fields: {
    postsPerPage: {
      label: 'Posts per page',
      description: 'Number of posts in each list page. Minimum 1.',
      error: 'Enter a whole number of at least 1.',
    },
    dateStyle: {
      label: 'Date style',
      description: 'Choose how much date detail to show.',
    },
    timeStyle: {
      label: 'Time style',
      description: 'Choose None to leave out the time.',
    },
    datetimePreview: {
      title: 'Date and time preview',
      basis: 'Previewed in this browser’s language and timezone. Your theme may display dates differently.',
      omitted: 'No date or time style is selected. Your theme may hide the timestamp.',
    },
    styles: {
      none: 'None',
      short: 'Short',
      medium: 'Medium',
      long: 'Long',
      full: 'Full',
    },
    search: {
      label: 'Enable static search',
      description: 'Requires a theme that supports search.',
    },
    feed: {
      label: 'Generate RSS feed',
      description: 'Requires a Site URL in General settings.',
    },
    archive: {
      label: 'Generate chronological archive',
      description: 'Requires a theme with an archive template.',
    },
    footerCopyright: {
      label: 'Copyright or legal text (optional)',
      description: 'Leave blank to let your theme decide what to show.',
    },
    footerAttribution: {
      label: 'Allow ZeroPress attribution',
      description: 'Themes may use this preference to show their standard ZeroPress attribution.',
    },
    indexing: {
      label: 'Allow search-engine indexing',
      description: 'Enable when your public site is ready for search engines. This is not an access restriction.',
    },
    generator: {
      label: 'Expose ZeroPress generator metadata',
      description: 'Adds the standard ZeroPress generator meta tag to generated pages.',
    },
  },
  state: {
    saved: 'Display and output settings saved.',
    dirty: 'You have unsaved changes.',
    clean: 'All changes are saved.',
    defaults: 'Defaults are active until these settings are saved for the first time.',
    lastSaved: 'Last saved {{date}}',
  },
  actions: {
    reset: 'Reset changes',
    save: 'Save settings',
    saving: 'Saving…',
  },
  errors: {
    conflictTitle: 'Output settings changed in another session',
    conflictDescription: 'Your edits remain in this form. Load the latest saved values before editing and saving again.',
    reload: 'Load latest values',
    forbidden: 'Your account cannot manage site settings.',
    validation: 'Review the highlighted fields before saving.',
    timeout: 'The settings request timed out. Please try again.',
    network: 'Studio could not be reached. Check your connection and try again.',
    invalidResponse: 'Studio returned an unexpected output-settings response.',
    api: 'Studio could not save output settings. Your edits remain in this form.',
  },
  discard: {
    kicker: 'UNSAVED CHANGES',
    title: 'Leave without saving?',
    description: 'Changes made on this page will be discarded.',
    stay: 'Keep editing',
    leave: 'Discard and leave',
  },
} as const;

export const mediaSettings = {
  documentTitle: 'Media settings — ZeroPress Studio',
  kicker: 'MEDIA DELIVERY',
  title: 'Media settings',
  description: 'Choose where your site’s images and files are served.',
  loading: 'Loading Media Settings…',
  loadError: 'Media Settings could not be loaded',
  section: {
    title: 'Public delivery',
    description: 'Set the public delivery address. Upload and manage files in Media.',
  },
  fields: {
    origin: {
      label: 'Media address',
      description: 'Enter an HTTP(S) address without a path. Leave blank to use site-relative paths such as /uploads/image.png.',
      placeholder: 'https://media.example.com',
    },
    mode: {
      label: 'Delivery mode',
      none: 'Standard media URLs',
      mediaDomain: 'ZeroPress media domain',
      description: 'Use ZeroPress media domain only with a service that supports ZeroPress image variants.',
    },
  },
  state: {
    saved: 'Media Settings saved.',
    dirty: 'You have unsaved changes.',
    clean: 'All changes are saved.',
  },
  actions: { retry: 'Try again', reset: 'Reset changes', save: 'Save settings', saving: 'Saving…' },
  errors: {
    validation: 'Enter a valid media origin and select a compatible delivery mode.',
    conflictTitle: 'Media Settings changed in another session',
    conflictDescription: 'Load the latest values before saving.',
    forbidden: 'Your account cannot manage Media Settings.',
    timeout: 'The Media Settings request timed out.',
    network: 'Studio could not be reached.',
    invalidResponse: 'Studio returned an unexpected Media Settings response.',
    api: 'Studio could not save Media Settings.',
  },
  discard: {
    kicker: 'UNSAVED CHANGES',
    title: 'Leave without saving?',
    description: 'Changes made on this page will be discarded.',
    stay: 'Keep editing',
    leave: 'Discard and leave',
  },
} as const;

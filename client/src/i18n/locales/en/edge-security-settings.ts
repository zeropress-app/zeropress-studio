export const edgeSecuritySettings = {
  documentTitle: 'Edge Security — ZeroPress Studio',
  kicker: 'PUBLIC REQUEST SECURITY',
  title: 'Edge Security',
  description: 'Configure verification for comments, signups, and form submissions, and set IP address retention.',
  loading: {
    title: 'Loading Edge Security',
    description: 'Studio is reading the shared Edge runtime policy.',
  },
  loadError: {
    title: 'Edge Security could not be loaded',
    description: 'Edge comments, signups, and form submissions are paused until valid settings can be loaded.',
    retry: 'Try again',
  },
  verification: {
    title: 'Public write verification',
    description: 'Choose a verification method for each feature.',
  },
  turnstile: {
    title: 'Cloudflare Turnstile',
    description: 'The public key shown to visitors when Turnstile is used.',
    secretTitle: 'Configure the Worker secret separately',
    secretDescription: 'Store the secret from the same Turnstile widget on the ZeroPress Edge Worker. Use a Secret rather than a plaintext variable.',
  },
  retention: {
    title: 'IP address retention',
    description: 'Choose when stored IP addresses are automatically deleted.',
  },
  fields: {
    commentMode: {
      label: 'Comment submission',
      description: 'Verification for new public Post and Page comments.',
    },
    newsletterMode: {
      label: 'Newsletter subscription',
      description: 'Verification for new public newsletter subscriptions.',
    },
    formMode: {
      label: 'Form submission',
      description: 'Verification for new public Form submissions.',
    },
    modeOptions: {
      pow: 'Proof of Work',
      turnstile: 'Cloudflare Turnstile',
    },
    sitekey: {
      label: 'Turnstile sitekey',
      description: 'May remain empty while all three write surfaces use Proof of Work.',
      placeholder: '0x4AAAAAAA…',
      errorRequired: 'Enter the public Turnstile sitekey while any write surface uses Turnstile.',
      errorLength: 'The Turnstile sitekey must be 256 characters or fewer.',
    },
    retentionDays: {
      label: 'Retention period (days)',
      description: 'Choose a whole number from 1 through 365. The default is 30 days.',
      error: 'Enter a whole number from 1 through 365.',
    },
  },
  state: {
    saved: 'Edge public request security settings saved.',
    dirty: 'You have unsaved changes.',
    clean: 'All changes are saved.',
    lastSaved: 'Last saved {{date}}',
  },
  actions: {
    reset: 'Reset changes',
    save: 'Save Edge Security',
    saving: 'Saving…',
  },
  errors: {
    conflictTitle: 'Edge Security changed in another session',
    conflictDescription: 'Your edits remain in this form. Load the latest Edge settings before saving again.',
    reload: 'Load latest values',
    forbidden: 'Your account cannot manage Edge Security.',
    validation: 'Review the verification, sitekey, and retention settings before saving.',
    timeout: 'The Edge Security request timed out. Please try again.',
    network: 'Studio could not be reached. Check your connection and try again.',
    invalidResponse: 'Studio returned an unexpected Edge Security response.',
    api: 'Studio could not complete the Edge Security request. Existing settings remain unchanged.',
  },
  discard: {
    kicker: 'UNSAVED CHANGES',
    title: 'Leave without saving?',
    description: 'Changes made to Edge Security will be discarded.',
    stay: 'Keep editing',
    leave: 'Discard and leave',
  },
} as const;

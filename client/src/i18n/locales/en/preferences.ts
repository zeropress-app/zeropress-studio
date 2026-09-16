export const preferences = {
  documentTitle: 'Studio preferences · ZeroPress Studio',
  kicker: 'PERSONAL PREFERENCE',
  title: 'Studio preferences',
  description: 'Choose your Studio preferences for this browser.',
  language: {
    title: 'Interface language',
    description: 'Choose the language used by Studio administration screens.',
    label: 'Studio interface language',
    hint: 'Applies only to this browser. The public site language is unchanged.',
    managed: {
      title: 'Language is managed for this Studio',
      description: '{{language}} is the only interface language currently enabled by an administrator.',
    },
  },
} as const;

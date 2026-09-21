export const analytics = {
  title: 'Analytics',
  kicker: 'Overview',
  connection: 'Connection settings',
  configure: 'Open settings',
  period: 'Period',
  periods: {
    '30m': 'Last 30 minutes',
    '6h': 'Last 6 hours',
    '12h': 'Last 12 hours',
    '24h': 'Last 24 hours',
    '3d': 'Last 3 days',
    '7d': 'Last 7 days',
    '14d': 'Last 2 weeks',
    '21d': 'Last 21 days',
    '30d': 'Last 30 days',
  },
  pageviews: 'Page views',
  visits: 'Visits',
  trend: 'Daily traffic',
  chartMetric: 'Chart metric',
  chartLabel: '{{metric}} by day',
  dailyValues: 'View daily values',
  date: 'Date',
  url: 'URL',
  source: 'Source',
  topPaths: 'Top URLs',
  topReferrers: 'Referring sites',
  direct: 'Direct / unknown',
  updated: 'Last fetched: {{time}}',
  loading: 'Loading analytics…',
  loadError: 'Analytics could not be loaded',
  retry: 'Try again',
  notConnected: 'Analytics is not connected',
  noData: {
    title: 'No traffic recorded',
    description:
      'No page views were returned for this site and period. Check that Web Analytics is collecting data on your public site.',
  },
  sampling:
    'Cloudflare may estimate traffic using sampling. Visits count arrivals from another site or a direct link, not unique people.',
  settings: {
    title: 'Analytics Settings',
    kicker: 'Site settings',
    description:
      'Connect statistics already collected by Cloudflare Web Analytics on your public site.',
    enabled: 'Enable analytics',
    dashboardUrl: 'Web Analytics URL',
    dashboardUrlHint:
      'Select the site in Cloudflare, then paste the URL from your browser.',
    dashboardUrlInvalid:
      'Paste the Cloudflare Web Analytics URL with one site selected.',
    selectSite: 'Select site in Cloudflare',
    manualIds: 'Enter IDs manually',
    account_id: 'Account ID',
    site_tag: 'Site Tag',
    token: 'API Token',
    tokenHint:
      'Create a token in the same Cloudflare account as your site, then paste it here.',
    createToken: 'Create API Token in Cloudflare',
    tokenStored: 'A token is saved. Leave this field empty to keep it.',
    removeToken: 'Remove saved token',
    test: 'Test connection',
    testing: 'Checking connection…',
    data_found: 'The API connection works and traffic data was found.',
    no_data:
      'The API query succeeded, but no traffic was found in the last 24 hours. Check the Site Tag and public-site collection settings.',
    saved: 'Analytics settings saved.',
    save: 'Save analytics settings',
    validation:
      'Check the connection fields and provide a token before enabling analytics.',
    conflict: 'These settings changed in another session',
    conflictDescription: 'Reload the current settings before saving again.',
  },
  errors: {
    notConfigured:
      'Connect Cloudflare Web Analytics to view your site traffic.',
    siteMissing: 'Set the public site URL in General Settings first.',
    tokenMissing:
      'Add an API Token, or disable analytics before removing the saved token.',
    authentication:
      'Cloudflare denied access. Check the account and the token’s Analytics read permission.',
    limited:
      'The query exceeded an Analytics limit. Try a shorter period or retry later.',
    unavailable:
      'Cloudflare Web Analytics is temporarily unavailable. Try again later.',
    invalid: 'The analytics response could not be read. Try again later.',
    forbidden: 'Only administrators can access analytics.',
    timeout: 'The analytics request timed out. Try again.',
    network:
      'Could not connect to Studio. Check your connection and try again.',
    unexpected: 'Analytics could not be loaded or saved. Try again.',
  },
};

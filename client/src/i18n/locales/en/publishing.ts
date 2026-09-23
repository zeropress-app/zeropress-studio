export const publishing = {
  loading: 'Checking publishing status…',
  loadError: 'GitHub connection could not be loaded',
  retry: 'Check again',
  settings: {
    title: 'Publishing',
    kicker: 'SITE SETTINGS',
    description: 'Connect the Preview Data file used to build your site.',
    starter: {
      title: 'Start a new site',
      description:
        'Use Deploy to Cloudflare in the Studio starter to create your site and GitHub repository. Then open zeropress-preview-data.json in your new repository and paste its GitHub URL below.',
      action: 'Open Studio starter',
    },
    enabled: 'Publish to GitHub',
    fileUrl: 'GitHub file URL',
    fileUrlHint:
      'Open the Preview Data JSON file used by your site build on GitHub and paste its URL.',
    owner: 'Repository owner',
    repo: 'Repository',
    branch: 'Branch',
    path: 'File path',
    manual: 'Enter target manually',
    token: 'GitHub Token',
    tokenHint:
      'Select the target repository and allow Contents: Read and write.',
    tokenStored: 'A token is saved. Leave this field blank to keep it.',
    createToken: 'Create GitHub token',
    removeToken: 'Delete saved token',
    test: 'Check connection',
    testing: 'Checking connection…',
    testSuccess:
      'The branch and JSON file are accessible. Publishing also requires write permission and must meet the branch rules.',
    save: 'Save publishing settings',
    saved: 'Publishing settings saved.',
    validation: 'Check the target and token before saving.',
  },
  panel: {
    title: 'GitHub publishing',
    description:
      'Publish the prepared data. Your connected build service handles deployment.',
    notConfigured:
      'To publish directly to GitHub, connect a repository in publishing settings.',
    disabled: 'GitHub publishing is turned off',
    enableHint:
      'To use your saved connection, turn on “Publish to GitHub” in publishing settings and save.',
    target: 'Target file',
    latest: 'Latest file commit',
    settings: 'Publishing settings',
    publish: 'Publish to GitHub',
    publishing: 'Publishing…',
    failed: 'GitHub request failed',
    unknown: 'Check whether the publish completed',
  },
  readiness: {
    notPrepared: 'Prepare the site data to check for changes.',
    checking: 'Comparing with GitHub…',
    unchanged: 'The prepared data is already on GitHub.',
    changed: 'There are changes to publish.',
    baseline: 'Ready to publish. This file has no matching Studio comparison record.',
    stale: 'The site data changed after preparation. Prepare it again before publishing.',
    prepareAgain: 'Prepare data again',
  },
  confirmation: {
    title: 'Publish to GitHub?',
    description:
      'This commits the prepared site data to the file below and may start your site’s deployment.',
    cancel: 'Cancel',
  },
  outcome: {
    committed: 'Updated on GitHub.',
    confirmed: 'The update was confirmed on GitHub.',
  },
  leaving: {
    title: 'Publishing is in progress',
    description:
      'Leaving this page will not cancel a commit already sent to GitHub.',
    stay: 'Stay here',
    leave: 'Leave page',
  },
  errors: {
    notConfigured:
      'Check your publishing settings and turn on “Publish to GitHub”.',
    tokenMissing: 'Enter a GitHub token or keep a saved token.',
    urlInvalid:
      'Enter a github.com file URL containing /blob/ and a .json file path.',
    urlAmbiguous:
      'This URL matches more than one branch and file. Enter the branch and file path manually.',
    authentication:
      'GitHub rejected the token. Check whether it is valid and has expired.',
    permission:
      'The token cannot access this repository or update its contents. Check its repository selection, permissions, and organization approval.',
    notFound:
      'The branch or file could not be found. Check the target and token access to private repositories.',
    targetInvalid:
      'Choose an existing regular .json file on a branch. Tags, commit IDs, directories, and symbolic links cannot be used.',
    branchRestricted:
      'GitHub branch rules rejected this commit. Choose a branch that permits direct publishing with this token.',
    conflict:
      'The GitHub file changed. Check it again before publishing.',
    dataChanged: 'The site data changed after preparation. Prepare it again before publishing.',
    settingsConflict:
      'The connection settings changed. Reload them before continuing.',
    limited: 'GitHub limited this request. Wait before trying again.',
    unavailable: 'GitHub is temporarily unavailable. Try again later.',
    invalid: 'GitHub returned an unexpected response.',
    unknown:
      'Studio could not confirm the result. Check the latest file commit on GitHub before publishing again.',
    forbidden: 'Your account cannot manage site publishing.',
    timeout: 'The GitHub request timed out.',
    network: 'Studio could not be reached. Check your connection.',
    edge: 'Preview Data is not ready. Check the Edge integration in site settings and try again.',
    unexpected:
      'Studio could not prepare or publish the site data. Check the site configuration and Worker logs.',
  },
} as const;

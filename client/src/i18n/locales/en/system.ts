export const system = {
  documentTitle: 'System status · ZeroPress Studio',
  regionLabel: 'ZeroPress Studio system status',
  brandLabel: 'ZeroPress Studio',
  loading: {
    eyebrow: 'GETTING READY',
    title: 'Getting Studio ready',
    message: 'This should only take a moment.',
  },
  states: {
    installation: {
      eyebrow: 'INITIAL SETUP',
      title: 'Studio is ready to install',
      message: 'Enter the install token and create the first administrator account to install Studio.',
    },
    installationConfiguration: {
      eyebrow: 'INSTALLATION SETUP',
      title: 'Complete the installation setup',
      message: 'Complete the remaining Worker setting, redeploy, then check the setup again.',
      retry: 'Check setup again',
    },
    activationRequired: {
      eyebrow: 'OPERATOR ACTION REQUIRED',
      title: 'Installation is complete',
      message: 'Finish the remaining Worker configuration before signing in.',
      finalization: {
        title: 'Enable Studio sign-in',
        description: 'Complete these steps in order, then check the configuration again.',
        removeInstallToken: 'Delete this Runtime secret.',
        setOperationalMode: 'Set the value to operational.',
        redeploy: 'Redeploy the Worker with the updated configuration.',
      },
      retry: 'Check configuration again',
    },
    maintenance: {
      eyebrow: 'MAINTENANCE',
      title: 'Studio is temporarily unavailable',
      visitorMessage: 'Maintenance is in progress. Try again later.',
      operatorMessage: 'Planned lifecycle work is in progress. Maintenance blocks normal sign-in and product APIs while allowing reviewed backup, restore, upgrade, reset, and uninstall operations.',
      operationsLink: 'Open Maintenance & Recovery',
    },
    recovery: {
      eyebrow: 'RECOVERY MODE',
      title: 'Studio access is limited during recovery',
      visitorMessage: 'Recovery work is in progress. Try again after normal Studio access has been restored.',
      operatorMessage: 'Normal sign-in is paused. Authorized operators can use Maintenance & Recovery to back up or restore databases and recover administrator access.',
      operationsLink: 'Open Maintenance & Recovery',
      retry: 'Check recovery status',
    },
    unavailable: {
      eyebrow: 'SYSTEM UNAVAILABLE',
      title: 'Studio cannot start',
      message: 'The system status could not be verified. Check the browser connection and Worker configuration, then try again.',
    },
    cloudflareAccess: {
      eyebrow: 'PROTECTED ACCESS',
      required: {
        title: 'Open Studio through Cloudflare Access',
        message: 'This Studio requires a verified Cloudflare Access session. Use its protected address, then try again.',
      },
      sessionExpired: {
        message: 'Your Cloudflare Access session is no longer active. Continue to authenticate again without discarding work kept in this page.',
      },
      unavailable: {
        title: 'Cloudflare Access cannot be verified',
        message: 'Studio could not verify the configured Access application. Try again, or use the recovery procedure if you administer this Studio.',
      },
      continue: 'Continue through Cloudflare Access',
    },
    blocked: {
      SITE_MODE_MISSING: {
        eyebrow: 'CONFIGURATION REQUIRED',
        title: 'Set the Studio site mode',
        message: 'Set STUDIO_SITE_MODE to initial, operational, maintenance, or recovery, then redeploy the Worker.',
        retry: 'Check configuration again',
      },
      SITE_MODE_INVALID: {
        eyebrow: 'CONFIGURATION REQUIRED',
        title: 'Correct the Studio site mode',
        message: 'Use initial, operational, maintenance, or recovery exactly, then redeploy the Worker.',
        retry: 'Check configuration again',
      },
      INSTALL_TOKEN_NOT_CONFIGURED: {
        title: 'Installation is not authorized',
        message: 'Configure STUDIO_INSTALL_TOKEN with 32–256 printable ASCII characters without spaces before opening the installer.',
      },
      AUTH_SECRET_NOT_CONFIGURED: {
        eyebrow: 'CONFIGURATION REQUIRED',
        title: 'Set the Studio authentication secret',
        message: 'STUDIO_AUTH_SECRET is missing or invalid. Update the Cloudflare Secret, redeploy, then check again.',
        retry: 'Check configuration again',
      },
      DATABASE_UNMANAGED: {
        title: 'The database is not managed by Studio',
        message: 'Verify that the DB binding points to the dedicated Studio database.',
      },
      DATABASE_UNAVAILABLE: {
        title: 'The database is unavailable',
        message: 'Verify the DB binding and Cloudflare D1 availability.',
      },
      DATABASE_SCHEMA_STATE_INVALID: {
        title: 'The database needs recovery',
        message: 'The database lifecycle state is incomplete or invalid. Keep normal access disabled and use the supported lifecycle recovery flow before continuing.',
      },
      DATABASE_UPGRADE_REQUIRED: {
        eyebrow: 'DATABASE UPDATE REQUIRED',
        title: 'Update the Studio database',
        message: 'This database was created by an earlier Studio version. Complete the update before returning Studio to normal operation.',
        retry: 'Check status again',
        status: {
          title: 'Database schema',
          versionRange: 'Version {{current}} → {{target}}',
          required: 'Update required',
        },
        stepsLabel: 'Database update preparation',
        steps: {
          maintenance: {
            title: 'Switch to maintenance mode',
            description: 'Set STUDIO_SITE_MODE to maintenance and redeploy the Worker.',
          },
          upgrade: {
            title: 'Back up and update',
            description: 'Open Maintenance & Recovery, create and keep a Studio database backup, then run the update.',
          },
        },
        recoveryNote: 'Cannot verify an administrator? Restore access in recovery mode before switching to maintenance.',
      },
      DATABASE_NEWER_THAN_CODE: {
        eyebrow: 'DATABASE COMPATIBILITY',
        title: 'Update the Studio Worker',
        message: 'The database schema is newer than this Worker supports. Studio access is paused until they are compatible.',
        retry: 'Check after deployment',
        versions: {
          title: 'Version comparison',
          studio: 'Studio version (Worker)',
          database: 'Database schema',
          worker: 'Worker supports schema',
          unknown: 'Not reported',
        },
        stepsLabel: 'Restore compatibility',
        steps: {
          deploy: {
            title: 'Deploy a compatible Studio version',
            description: 'In Cloudflare, open this Worker’s Deployments. If you rolled back, return to the deployment used after the database upgrade, or deploy a release that supports this schema.',
          },
          binding: {
            title: 'Check the database connection',
            description: 'If this mismatch was unexpected, check that the Worker’s DB binding points to the intended Studio database.',
          },
        },
      },
      DATABASE_UNSUPPORTED: {
        title: 'The database schema is no longer supported',
        message: 'Use a supported upgrade path or restore a compatible database backup.',
      },
    },
  },
  workerSecretSetup: {
    authentication: {
      requirement: 'Use 32–256 printable ASCII characters without spaces.',
      existingInstallation: 'If this Studio was already in use, restore its existing value.',
      generate: 'Generate value',
      copySuccess: 'Generated value copied.',
    },
    installation: {
      regionLabel: 'Installation Worker settings',
      storageGuidance: 'Use a unique value for each Secret and store it in Cloudflare Secrets, not plaintext Variables.',
      siteMode: 'The initial installation mode is active.',
      siteModeChangeRequired: 'Change the value to initial before installation.',
    },
    authSecret: {
      description: 'Protects MFA data and stored service credentials.',
    },
    installToken: {
      description: 'Used to access the Studio installer.',
      retention: 'Keep this value in a safe place until installation is complete. You will need to enter it on the installation page.',
      copySuccess: 'STUDIO_INSTALL_TOKEN copied. Keep it safe until installation is complete.',
    },
    states: {
      valid: 'Configured',
      missing: 'Not set',
      invalid: 'Invalid',
      unknown: 'Check required',
      changeRequired: 'Change required',
    },
    generate: 'Generate {{name}}',
    generateValue: 'Generate value',
    regenerate: 'Generate another value',
    valueLabel: 'Generated {{name}}',
    copy: 'Copy value',
    copied: 'Copied',
    copySuccess: 'The generated {{name}} value was copied.',
    copyFailed: 'The value could not be copied automatically. Select and copy it manually.',
    generationFailed: 'This browser could not generate a secure value. Use the command in the setup guide instead.',
    guide: 'Open setup guide',
  },
  retry: 'Check again',
  operatorNote: 'The matching Worker operational log includes detailed recovery guidance.',
} as const;

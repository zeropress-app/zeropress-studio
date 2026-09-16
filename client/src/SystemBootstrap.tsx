import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import type { TFunction } from 'i18next';
import {
  Database,
  RefreshCw,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type {
  DatabaseStatus,
  SystemBlockedReason,
  SystemStatusData,
  SystemStatusResponse,
} from '../../contracts/system';
import type { CurrentSessionSuccess } from '../../contracts/session';
import type { InstallSuccess } from '../../contracts/install';
import {
  STUDIO_WORKER_CONFIGURATION_CATALOG,
  type StudioWorkerConfigurationName,
} from '../../contracts/worker-configuration';
import { AuthenticatedApplication } from './AuthenticatedApplication';
import { InstallShell } from './components/InstallShell';
import {
  WorkerSecretSetup,
  type WorkerSecretSetupTarget,
} from './components/WorkerSecretSetup';
import {
  SessionReauthenticationDialog,
  type SessionReauthenticationPhase,
} from './components/SessionReauthenticationDialog';
import {
  InitialCheckingPlaceholder,
  useInitialCheckingPhase,
} from './components/InitialCheckingGate';
import { StandaloneStatusScreen } from './components/StandaloneStatusScreen';
import {
  DatabaseCompatibilityDetails,
  type DatabaseCompatibilityDetailsProps,
} from './components/DatabaseCompatibilityDetails';
import { StudioCheckingScreen } from './components/StudioCheckingScreen';
import { InstallFlow } from './InstallFlow';
import { LoginPage } from './LoginPage';
import {
  requestCurrentSession,
  requestLogout,
  SessionClientError,
} from './lib/session-client';
import { requestSystemStatus } from './lib/system-client';
import { requestPublicInterfaceConfig } from './lib/studio-interface-settings-client';
import {
  subscribeStudioAccessInterruption,
  type StudioAccessInterruption,
} from './lib/studio-fetch';
import {
  SAFE_INTERFACE_SETTINGS_FALLBACK,
  useStudioInterfaceSettings,
} from './StudioInterfaceSettingsContext';
import {
  Button,
  ButtonLink,
  Callout,
  ConfigurationReference,
  Dialog,
  DialogActions,
  StatusPill,
  StudioToaster,
  StudioIcon,
} from './components/primitives';

type BootstrapState =
  | { kind: 'loading' }
  | {
      kind: 'resolved';
      status: SystemStatusResponse['data'];
    }
  | { kind: 'unavailable' };

type StatusPresentation = {
  eyebrow: string;
  title: string;
  message: string;
  tone: 'info' | 'warning' | 'error';
  frameSize?: 'default' | 'wide';
  operatorLogAvailable?: boolean;
  retryIcon?: LucideIcon;
  retryLabel?: string;
  operationsIcon?: LucideIcon;
  operationsLabel?: string;
  operationsPrimary?: boolean;
  configuration?: StudioWorkerConfigurationName;
  configurationState?: 'missing' | 'invalid';
  databaseInstallationRequired?: boolean;
  databaseCompatibility?: DatabaseCompatibilityDetailsProps;
  databaseUpgrade?: {
    currentVersion: number;
    targetVersion: number;
  };
};

function databaseUninstalledPresentation(
  t: TFunction<'system'>,
): StatusPresentation {
  return {
    eyebrow: t('states.installationConfiguration.eyebrow'),
    title: t('states.installationConfiguration.title'),
    message: t('states.installationConfiguration.message'),
    tone: 'warning',
    frameSize: 'wide',
    retryIcon: RefreshCw,
    retryLabel: t('states.installationConfiguration.retry'),
    databaseInstallationRequired: true,
  };
}

function blockedPresentation(
  reason: SystemBlockedReason,
  database: DatabaseStatus,
  t: TFunction<'system'>,
  studioVersion?: string,
): StatusPresentation {
  switch (reason) {
    case 'SITE_MODE_MISSING':
      return {
        eyebrow: t('states.blocked.SITE_MODE_MISSING.eyebrow'),
        title: t('states.blocked.SITE_MODE_MISSING.title'),
        message: t('states.blocked.SITE_MODE_MISSING.message'),
        tone: 'error',
        frameSize: 'wide',
        retryIcon: RefreshCw,
        retryLabel: t('states.blocked.SITE_MODE_MISSING.retry'),
        configuration: 'STUDIO_SITE_MODE',
        configurationState: 'missing',
      };
    case 'SITE_MODE_INVALID':
      return {
        eyebrow: t('states.blocked.SITE_MODE_INVALID.eyebrow'),
        title: t('states.blocked.SITE_MODE_INVALID.title'),
        message: t('states.blocked.SITE_MODE_INVALID.message'),
        tone: 'error',
        frameSize: 'wide',
        retryIcon: RefreshCw,
        retryLabel: t('states.blocked.SITE_MODE_INVALID.retry'),
        configuration: 'STUDIO_SITE_MODE',
        configurationState: 'invalid',
      };
    case 'INSTALL_TOKEN_NOT_CONFIGURED':
      return {
        eyebrow: t('states.unavailable.eyebrow'),
        title: t('states.blocked.INSTALL_TOKEN_NOT_CONFIGURED.title'),
        message: t('states.blocked.INSTALL_TOKEN_NOT_CONFIGURED.message'),
        tone: 'error',
        frameSize: 'wide',
        operatorLogAvailable: true,
        configuration: 'STUDIO_INSTALL_TOKEN',
      };
    case 'INSTALL_TOKEN_STILL_CONFIGURED':
      return {
        eyebrow: t('states.activationRequired.eyebrow'),
        title: t('states.activationRequired.title'),
        message: t('states.activationRequired.message'),
        tone: 'warning',
        retryIcon: RefreshCw,
        retryLabel: t('states.activationRequired.retry'),
        configuration: 'STUDIO_INSTALL_TOKEN',
      };
    case 'AUTH_SECRET_NOT_CONFIGURED':
      return {
        eyebrow: t('states.blocked.AUTH_SECRET_NOT_CONFIGURED.eyebrow'),
        title: t('states.blocked.AUTH_SECRET_NOT_CONFIGURED.title'),
        message: t('states.blocked.AUTH_SECRET_NOT_CONFIGURED.message'),
        tone: 'error',
        frameSize: 'wide',
        retryIcon: RefreshCw,
        retryLabel: t('states.blocked.AUTH_SECRET_NOT_CONFIGURED.retry'),
        configuration: 'STUDIO_AUTH_SECRET',
      };
    case 'DATABASE_UNINSTALLED':
      return databaseUninstalledPresentation(t);
    case 'DATABASE_UNMANAGED':
      return {
        eyebrow: t('states.unavailable.eyebrow'),
        title: t('states.blocked.DATABASE_UNMANAGED.title'),
        message: t('states.blocked.DATABASE_UNMANAGED.message'),
        tone: 'error',
        operatorLogAvailable: true,
      };
    case 'DATABASE_UNAVAILABLE':
      return {
        eyebrow: t('states.unavailable.eyebrow'),
        title: t('states.blocked.DATABASE_UNAVAILABLE.title'),
        message: t('states.blocked.DATABASE_UNAVAILABLE.message'),
        tone: 'error',
        operatorLogAvailable: true,
      };
    case 'DATABASE_SCHEMA_STATE_INVALID':
      return {
        eyebrow: t('states.unavailable.eyebrow'),
        title: t('states.blocked.DATABASE_SCHEMA_STATE_INVALID.title'),
        message: t('states.blocked.DATABASE_SCHEMA_STATE_INVALID.message'),
        tone: 'error',
        operatorLogAvailable: database.state === 'recovery_required',
      };
    case 'DATABASE_UPGRADE_REQUIRED':
      return {
        eyebrow: t('states.blocked.DATABASE_UPGRADE_REQUIRED.eyebrow'),
        title: t('states.blocked.DATABASE_UPGRADE_REQUIRED.title'),
        message: t('states.blocked.DATABASE_UPGRADE_REQUIRED.message'),
        tone: 'warning',
        frameSize: 'wide',
        retryIcon: RefreshCw,
        retryLabel: t('states.blocked.DATABASE_UPGRADE_REQUIRED.retry'),
        ...(database.state === 'upgrade_required'
          ? {
              databaseUpgrade: {
                currentVersion: database.schema_version,
                targetVersion: database.target_schema_version,
              },
            }
          : {}),
      };
    case 'DATABASE_NEWER_THAN_CODE':
      return {
        eyebrow: t('states.blocked.DATABASE_NEWER_THAN_CODE.eyebrow'),
        title: t('states.blocked.DATABASE_NEWER_THAN_CODE.title'),
        message: t('states.blocked.DATABASE_NEWER_THAN_CODE.message'),
        tone: 'error',
        frameSize: 'wide',
        retryIcon: RefreshCw,
        retryLabel: t('states.blocked.DATABASE_NEWER_THAN_CODE.retry'),
        ...(database.state === 'newer_than_code'
          ? {
              databaseCompatibility: {
                studioVersion,
                currentVersion: database.schema_version,
                targetVersion: database.target_schema_version,
              },
            }
          : {}),
      };
    case 'DATABASE_UNSUPPORTED':
      return {
        eyebrow: t('states.unavailable.eyebrow'),
        title: t('states.blocked.DATABASE_UNSUPPORTED.title'),
        message: t('states.blocked.DATABASE_UNSUPPORTED.message'),
        tone: 'error',
      };
  }
}

function resolvedPresentation(
  status: SystemStatusData,
  operationsAvailable: boolean,
  t: TFunction<'system'>,
): StatusPresentation | null {
  if (status.access.state === 'operational') {
    return null;
  }
  if (status.installation_configuration) {
    return {
      eyebrow: t('states.installationConfiguration.eyebrow'),
      title: t('states.installationConfiguration.title'),
      message: t('states.installationConfiguration.message'),
      tone: 'warning',
      frameSize: 'wide',
      retryIcon: RefreshCw,
      retryLabel: t('states.installationConfiguration.retry'),
    };
  }
  if (status.access.state === 'installation') {
    return {
      eyebrow: t('states.installation.eyebrow'),
      title: t('states.installation.title'),
      message: t('states.installation.message'),
      tone: 'info',
    };
  }
  if (status.access.state === 'activation_required') {
    return {
      eyebrow: t('states.activationRequired.eyebrow'),
      title: t('states.activationRequired.title'),
      message: t('states.activationRequired.message'),
      tone: 'warning',
      retryIcon: RefreshCw,
      retryLabel: t('states.activationRequired.retry'),
      configuration: 'STUDIO_INSTALL_TOKEN',
    };
  }
  if (status.access.state === 'maintenance') {
    if (status.database.state === 'uninstalled' && !operationsAvailable) {
      return databaseUninstalledPresentation(t);
    }
    return {
      eyebrow: t('states.maintenance.eyebrow'),
      title: t('states.maintenance.title'),
      message: operationsAvailable
        ? t('states.maintenance.operatorMessage')
        : t('states.maintenance.visitorMessage'),
      tone: 'warning',
    };
  }
  if (status.access.state === 'recovery') {
    if (status.database.state === 'uninstalled' && !operationsAvailable) {
      return databaseUninstalledPresentation(t);
    }
    return {
      eyebrow: t('states.recovery.eyebrow'),
      title: t('states.recovery.title'),
      message: operationsAvailable
        ? t('states.recovery.operatorMessage')
        : t('states.recovery.visitorMessage'),
      tone: 'warning',
      retryIcon: RefreshCw,
      retryLabel: t('states.recovery.retry'),
      operationsIcon: Wrench,
      operationsLabel: t('states.recovery.operationsLink'),
      operationsPrimary: true,
    };
  }
  return blockedPresentation(
    status.access.reason, status.database, t, status.studio_version,
  );
}

function StatusScreen(input: {
  presentation: StatusPresentation;
  onRetry: () => void;
  workerSecretSetup?: {
    context: 'authentication' | 'installation';
    targets: readonly WorkerSecretSetupTarget[];
    siteModeState?: 'valid' | 'change_required';
  };
  showOperationsLink?: boolean;
  installationCompletion?: {
    installTokenRemovalRequired: boolean;
  };
  installationNotice?: {
    title: string;
    description: string;
  };
}) {
  const { t, i18n } = useTranslation('system');

  useEffect(() => {
    document.title = t('documentTitle');
  }, [i18n.resolvedLanguage, t]);

  const retryAction = (
    <Button type="button" block onClick={input.onRetry}>
      {input.presentation.retryIcon ? (
        <StudioIcon
          icon={input.presentation.retryIcon}
          className="auth-button-icon"
        />
      ) : null}
      {input.presentation.retryLabel ?? t('retry')}
    </Button>
  );
  const operationsAction = input.showOperationsLink ? (
    <ButtonLink
      variant={input.presentation.operationsPrimary ? 'primary' : 'danger'}
      block
      to="/system/operations"
    >
      {input.presentation.operationsIcon ? (
        <StudioIcon
          icon={input.presentation.operationsIcon}
          className="auth-button-icon"
        />
      ) : null}
      {input.presentation.operationsLabel
        ?? t('states.maintenance.operationsLink')}
    </ButtonLink>
  ) : null;

  const supportingDetails = (
    <>
      {input.installationNotice ? (
        <Callout tone="warning" title={input.installationNotice.title}>
          {input.installationNotice.description}
        </Callout>
      ) : null}

      {input.presentation.configuration
        && !input.workerSecretSetup
        && !input.installationCompletion ? (
        input.presentation.configurationState ? (
          <section
            className="auth-secret-requirement auth-secret-requirement-compact standalone-status-configuration-requirement"
            aria-label={input.presentation.configuration}
          >
            <div className="auth-secret-requirement-heading">
              <div className="auth-secret-requirement-identity">
                <ConfigurationReference
                  name={input.presentation.configuration}
                  kind={STUDIO_WORKER_CONFIGURATION_CATALOG[
                    input.presentation.configuration
                  ].kind}
                />
              </div>
              <StatusPill
                tone={input.presentation.configurationState === 'invalid'
                  ? 'critical'
                  : 'attention'}
              >
                {t(`workerSecretSetup.states.${
                  input.presentation.configurationState
                }`)}
              </StatusPill>
            </div>
          </section>
        ) : (
          <div className="standalone-status-configuration">
            <ConfigurationReference
              name={input.presentation.configuration}
              kind={STUDIO_WORKER_CONFIGURATION_CATALOG[
                input.presentation.configuration
              ].kind}
            />
          </div>
        )
      ) : null}

      {input.presentation.databaseUpgrade ? (
        <>
          <section
            className="auth-secret-requirement auth-secret-requirement-compact standalone-status-configuration-requirement"
            aria-labelledby="studio-database-upgrade-status-title"
          >
            <div className="auth-secret-requirement-heading">
              <div className="auth-secret-requirement-identity">
                <div className="standalone-status-upgrade-identity">
                  <StudioIcon
                    icon={Database}
                    className="standalone-status-upgrade-icon"
                  />
                  <div className="standalone-status-upgrade-summary">
                    <h2
                      className="standalone-status-upgrade-summary-title"
                      id="studio-database-upgrade-status-title"
                    >
                      {t(
                        'states.blocked.DATABASE_UPGRADE_REQUIRED.status.title',
                      )}
                    </h2>
                    <p className="standalone-status-upgrade-version">
                      {t(
                        'states.blocked.DATABASE_UPGRADE_REQUIRED.status.versionRange',
                        {
                          current:
                            input.presentation.databaseUpgrade.currentVersion,
                          target:
                            input.presentation.databaseUpgrade.targetVersion,
                        },
                      )}
                    </p>
                  </div>
                </div>
              </div>
              <StatusPill tone="attention">
                {t(
                  'states.blocked.DATABASE_UPGRADE_REQUIRED.status.required',
                )}
              </StatusPill>
            </div>
          </section>

          <ol
            className="standalone-status-upgrade-steps"
            aria-label={t(
              'states.blocked.DATABASE_UPGRADE_REQUIRED.stepsLabel',
            )}
          >
            <li>
              <span
                className="standalone-status-upgrade-step-number"
                aria-hidden="true"
              >
                1
              </span>
              <div className="standalone-status-upgrade-step-copy">
                <h3>{t(
                  'states.blocked.DATABASE_UPGRADE_REQUIRED.steps.maintenance.title',
                )}</h3>
                <p>{t(
                  'states.blocked.DATABASE_UPGRADE_REQUIRED.steps.maintenance.description',
                )}</p>
              </div>
            </li>
            <li>
              <span
                className="standalone-status-upgrade-step-number"
                aria-hidden="true"
              >
                2
              </span>
              <div className="standalone-status-upgrade-step-copy">
                <h3>{t(
                  'states.blocked.DATABASE_UPGRADE_REQUIRED.steps.upgrade.title',
                )}</h3>
                <p>{t(
                  'states.blocked.DATABASE_UPGRADE_REQUIRED.steps.upgrade.description',
                )}</p>
              </div>
            </li>
          </ol>

          <p className="standalone-status-upgrade-note">
            {t('states.blocked.DATABASE_UPGRADE_REQUIRED.recoveryNote')}
          </p>
        </>
      ) : null}

      {input.presentation.databaseCompatibility ? (
        <DatabaseCompatibilityDetails
          {...input.presentation.databaseCompatibility}
        />
      ) : null}

      {input.workerSecretSetup ? (
        <WorkerSecretSetup {...input.workerSecretSetup} />
      ) : null}

      {input.presentation.operatorLogAvailable ? (
        <p className="standalone-status-note">{t('operatorNote')}</p>
      ) : null}
    </>
  );

  const actions = (
    <div className="standalone-status-actions">
      {input.presentation.operationsPrimary ? operationsAction : retryAction}
      {input.presentation.operationsPrimary ? retryAction : operationsAction}
    </div>
  );

  if (input.installationCompletion) {
    const finalizationSteps: Array<{
      key: string;
      description: string;
      configuration?: StudioWorkerConfigurationName;
    }> = [
      ...(input.installationCompletion.installTokenRemovalRequired
        ? [{
            key: 'remove-install-token',
            configuration: 'STUDIO_INSTALL_TOKEN' as const,
            description: t(
              'states.activationRequired.finalization.removeInstallToken',
            ),
          }]
        : []),
      {
        key: 'set-operational-mode',
        configuration: 'STUDIO_SITE_MODE' as const,
        description: t(
          'states.activationRequired.finalization.setOperationalMode',
        ),
      },
      {
        key: 'redeploy',
        description: t('states.activationRequired.finalization.redeploy'),
      },
    ];

    return (
      <InstallShell
        current="complete"
        regionLabel={t('regionLabel')}
        heading={{
          kicker: input.presentation.eyebrow,
          title: input.presentation.title,
          description: input.presentation.message,
          role: input.presentation.tone === 'error' ? 'alert' : 'status',
        }}
      >
        <div className="auth-install-complete">
          <section
            className="auth-install-finalization"
            aria-labelledby="studio-install-finalization-title"
          >
            <header className="auth-install-finalization-heading">
              <h2
                className="auth-install-finalization-title"
                id="studio-install-finalization-title"
              >
                {t('states.activationRequired.finalization.title')}
              </h2>
              <p className="auth-install-finalization-description">
                {t('states.activationRequired.finalization.description')}
              </p>
            </header>
            <ol className="auth-install-finalization-steps">
              {finalizationSteps.map((step, index) => (
                <li key={step.key}>
                  <span
                    className="auth-install-finalization-step-number"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <div className="auth-install-finalization-step-content">
                    {step.configuration ? (
                      <ConfigurationReference
                        name={step.configuration}
                        kind={STUDIO_WORKER_CONFIGURATION_CATALOG[
                          step.configuration
                        ].kind}
                      />
                    ) : null}
                    <span>{step.description}</span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
          {supportingDetails}
          {actions}
        </div>
      </InstallShell>
    );
  }

  return (
    <>
      <StudioToaster />
      <StandaloneStatusScreen
        regionLabel={t('regionLabel')}
        brandLabel={t('brandLabel')}
        kicker={input.presentation.eyebrow}
        title={input.presentation.title}
        description={input.presentation.message}
        tone={input.presentation.tone}
        wide={input.presentation.frameSize === 'wide'}
      >
        {supportingDetails}
        {actions}
      </StandaloneStatusScreen>
    </>
  );
}

export function SystemBootstrap() {
  return <DefaultSystemBootstrap />;
}

function DefaultSystemBootstrap() {
  const { t } = useTranslation('system');
  const { t: tInstall } = useTranslation('install');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<BootstrapState>({ kind: 'loading' });
  const [installationEdgeOutcome, setInstallationEdgeOutcome] = useState<
    InstallSuccess['data']['edge_database'] | null
  >(null);
  const bootstrapPending = state.kind === 'loading';
  const checkingPhase = useInitialCheckingPhase(
    bootstrapPending,
    attempt > 0,
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ kind: 'loading' });

    void requestSystemStatus(controller.signal)
      .then((response) => {
        if (!active) return;
        setState({ kind: 'resolved', status: response.data });
      })
      .catch(() => {
        if (active) {
          setState({ kind: 'unavailable' });
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt]);

  if (bootstrapPending) {
    return checkingPhase === 'hidden'
      ? <InitialCheckingPlaceholder label={t('loading.title')} />
      : <StudioCheckingScreen />;
  }
  if (checkingPhase === 'checking') {
    return <StudioCheckingScreen />;
  }

  if (state.kind === 'unavailable') {
    return (
      <StatusScreen
        presentation={{
          eyebrow: t('states.unavailable.eyebrow'),
          title: t('states.unavailable.title'),
          message: t('states.unavailable.message'),
          tone: 'error',
        }}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }

  if (state.status.access.state === 'installation') {
    return (
      <InstallFlow
        onInstallationChanged={(edgeDatabase) => {
          setInstallationEdgeOutcome(edgeDatabase ?? null);
          setAttempt((value) => value + 1);
        }}
      />
    );
  }

  const operationsAvailable =
    (state.status.access.state === 'maintenance'
      || state.status.access.state === 'recovery')
    && state.status.operations.state === 'available';
  const presentation = resolvedPresentation(
    state.status,
    operationsAvailable,
    t,
  );
  if (!presentation) {
    return <OperationalApplication />;
  }

  const installationConfiguration =
    state.status.installation_configuration;
  const workerSecretSetup = installationConfiguration
    ? {
        context: 'installation' as const,
        siteModeState: 'valid' as const,
        targets: [
          {
            name: 'STUDIO_AUTH_SECRET' as const,
            state: installationConfiguration.auth_secret,
          },
          {
            name: 'STUDIO_INSTALL_TOKEN' as const,
            state: installationConfiguration.install_token,
          },
        ],
      }
    : state.status.access.state === 'blocked'
      && state.status.access.reason === 'AUTH_SECRET_NOT_CONFIGURED'
      ? {
          context: 'authentication' as const,
          targets: [{ name: 'STUDIO_AUTH_SECRET' as const }],
        }
      : presentation.databaseInstallationRequired
        ? {
            context: 'installation' as const,
            siteModeState: 'change_required' as const,
            targets: [
              ...(state.status.access.state === 'blocked'
                && state.status.access.reason === 'DATABASE_UNINSTALLED'
                ? [{
                    name: 'STUDIO_AUTH_SECRET' as const,
                    state: 'valid' as const,
                  }]
                : []),
              {
                name: 'STUDIO_INSTALL_TOKEN' as const,
                state: 'unknown' as const,
              },
            ],
          }
        : undefined;
  const installationComplete =
    state.status.access.state === 'activation_required'
    || (
      state.status.access.state === 'blocked'
      && state.status.access.reason === 'INSTALL_TOKEN_STILL_CONFIGURED'
    );
  const installTokenRemovalRequired =
    state.status.access.state === 'blocked'
    && state.status.access.reason === 'INSTALL_TOKEN_STILL_CONFIGURED';

  return (
    <StatusScreen
      presentation={presentation}
      onRetry={() => setAttempt((value) => value + 1)}
      workerSecretSetup={workerSecretSetup}
      showOperationsLink={operationsAvailable}
      installationCompletion={installationComplete
        ? { installTokenRemovalRequired }
        : undefined}
      installationNotice={installationComplete
        && installationEdgeOutcome?.status === 'skipped_nonempty'
        ? {
            title: tInstall('edgeSetupSkipped.title'),
            description: tInstall('edgeSetupSkipped.description'),
          }
        : undefined}
    />
  );
}

type OperationalState =
  | { kind: 'loading' }
  | { kind: 'anonymous' }
  | {
    kind: 'authenticated';
    data: CurrentSessionSuccess['data'];
    reauthentication: SessionReauthenticationPhase | null;
  }
  | { kind: 'unavailable' };

const SESSION_ACTIVITY_SYNC_INTERVAL_MS = 30 * 60 * 1000;

function OperationalApplication() {
  const { t } = useTranslation('system');
  const navigate = useNavigate();
  const { applyOrganizationSettings } = useStudioInterfaceSettings();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<OperationalState>({
    kind: 'loading',
  });
  const [accessInterruption, setAccessInterruption] =
    useState<StudioAccessInterruption | null>(null);
  const checkingPhase = useInitialCheckingPhase(
    state.kind === 'loading',
    attempt > 0,
  );
  const interfaceSettingsLoaded = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => subscribeStudioAccessInterruption(
    setAccessInterruption,
  ), []);

  const reloadThroughAccess = useCallback(() => {
    window.location.reload();
  }, []);

  const finishSession = useCallback(() => {
    void navigate('/', { replace: true });
    setState({ kind: 'anonymous' });
  }, [navigate]);

  const requireReauthentication = useCallback(() => {
    setState((current) => current.kind === 'authenticated'
      && current.reauthentication === null
      ? { ...current, reauthentication: 'required' }
      : current);
  }, []);

  const updateCurrentUserName = useCallback((name: string) => {
    setState((current) => current.kind === 'authenticated'
      ? {
        ...current,
        data: {
          ...current.data,
          user: { ...current.data.user, name },
        },
      }
      : current);
  }, []);

  const discardWorkspace = useCallback(() => {
    const current = stateRef.current;
    if (current.kind === 'authenticated') {
      // Best effort only: an expired cookie normally makes this request a
      // no-op, while a locally expired session can still be revoked.
      void requestLogout(current.data.csrf_token).catch(() => undefined);
    }
    finishSession();
  }, [finishSession]);

  const restoreSession = useCallback(async () => {
    const original = stateRef.current;
    if (original.kind !== 'authenticated') return;
    const originalUserId = original.data.user.id;
    setState((current) => current.kind === 'authenticated'
      ? { ...current, reauthentication: 'refreshing' }
      : current);
    try {
      const response = await requestCurrentSession();
      if (!response.success) {
        setState((current) => current.kind === 'authenticated'
          ? { ...current, reauthentication: 'required' }
          : current);
        return;
      }
      if (response.data.user.id !== originalUserId) {
        // Never attach preserved in-memory content to a different identity.
        await requestLogout(response.data.csrf_token).catch(() => undefined);
        setState((current) => current.kind === 'authenticated'
          ? { ...current, reauthentication: 'identity_mismatch' }
          : current);
        return;
      }
      setState({
        kind: 'authenticated',
        data: response.data,
        reauthentication: null,
      });
    } catch {
      setState((current) => current.kind === 'authenticated'
        ? { ...current, reauthentication: 'refresh_failed' }
        : current);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ kind: 'loading' });

    void (async () => {
      if (!interfaceSettingsLoaded.current) {
        let interfaceSettings = SAFE_INTERFACE_SETTINGS_FALLBACK;
        try {
          const response = await requestPublicInterfaceConfig(
            controller.signal,
          );
          if (response.success) interfaceSettings = response.data;
        } catch {
          if (controller.signal.aborted) return;
          // Interface settings must not make authentication unavailable. The
          // Worker has already logged the failed or invalid settings read.
        }
        if (!active) return;
        await applyOrganizationSettings(interfaceSettings);
        interfaceSettingsLoaded.current = true;
      }
      if (!active) return;

      const response = await requestCurrentSession(controller.signal);
      if (!active) return;
      if (response.success) {
        setState({
          kind: 'authenticated',
          data: response.data,
          reauthentication: null,
        });
        return;
      }
      if (response.error.code === 'AUTHENTICATION_REQUIRED') {
        setState({ kind: 'anonymous' });
        return;
      }
      setState({ kind: 'unavailable' });
    })()
      .catch((error) => {
        if (!active) return;
        if (error instanceof SessionClientError && controller.signal.aborted) {
          return;
        }
        setState({ kind: 'unavailable' });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [applyOrganizationSettings, attempt]);

  useEffect(() => {
    if (state.kind !== 'authenticated' || state.reauthentication !== null) {
      return;
    }
    const idleExpiry = Date.parse(state.data.session.idle_expires_at_iso);
    const absoluteExpiry = Date.parse(
      state.data.session.absolute_expires_at_iso,
    );
    const deadline = Math.min(idleExpiry, absoluteExpiry);
    let timerId: number | null = null;
    const expireIfDue = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        requireReauthentication();
        return true;
      }
      return false;
    };
    const scheduleExpiryCheck = () => {
      if (expireIfDue()) return;
      // Browsers clamp timers to a signed 32-bit delay. Long-lived test
      // fixtures and future policy changes must not turn that overflow into
      // an immediate lock.
      timerId = window.setTimeout(
        scheduleExpiryCheck,
        Math.min(deadline - Date.now(), 2_147_000_000),
      );
    };
    scheduleExpiryCheck();
    document.addEventListener('visibilitychange', expireIfDue);
    window.addEventListener('focus', expireIfDue);
    return () => {
      if (timerId !== null) window.clearTimeout(timerId);
      document.removeEventListener('visibilitychange', expireIfDue);
      window.removeEventListener('focus', expireIfDue);
    };
  }, [requireReauthentication, state]);

  useEffect(() => {
    if (state.kind !== 'authenticated' || state.reauthentication !== null) {
      return;
    }
    const controller = new AbortController();
    let inFlight = false;
    let lastSyncAt = Date.now();
    const originalUserId = state.data.user.id;

    const synchronizeActiveSession = () => {
      if (
        inFlight
        || Date.now() - lastSyncAt < SESSION_ACTIVITY_SYNC_INTERVAL_MS
      ) return;
      inFlight = true;
      lastSyncAt = Date.now();
      void requestCurrentSession(controller.signal)
        .then((response) => {
          if (!response.success) {
            if (response.error.code === 'AUTHENTICATION_REQUIRED') {
              requireReauthentication();
            }
            return;
          }
          if (response.data.user.id !== originalUserId) {
            requireReauthentication();
            return;
          }
          setState({
            kind: 'authenticated',
            data: response.data,
            reauthentication: null,
          });
        })
        .catch(() => {
          // A transient network failure is not proof that the session ended.
          // The next user interaction may retry after the normal interval.
        })
        .finally(() => {
          inFlight = false;
        });
    };

    window.addEventListener('pointerdown', synchronizeActiveSession, {
      passive: true,
    });
    window.addEventListener('keydown', synchronizeActiveSession);
    return () => {
      controller.abort();
      window.removeEventListener('pointerdown', synchronizeActiveSession);
      window.removeEventListener('keydown', synchronizeActiveSession);
    };
  }, [requireReauthentication, state]);

  const accessTitle = accessInterruption === 'verification_unavailable'
    ? t('states.cloudflareAccess.unavailable.title')
    : t('states.cloudflareAccess.required.title');
  const accessMessage = accessInterruption === 'verification_unavailable'
    ? t('states.cloudflareAccess.unavailable.message')
    : accessInterruption === 'outer_session_required'
      ? t('states.cloudflareAccess.sessionExpired.message')
      : t('states.cloudflareAccess.required.message');

  if (accessInterruption !== null && state.kind !== 'authenticated') {
    return (
      <StatusScreen
        presentation={{
          eyebrow: t('states.cloudflareAccess.eyebrow'),
          title: accessTitle,
          message: accessMessage,
          tone: accessInterruption === 'verification_unavailable'
            ? 'error'
            : 'warning',
          retryIcon: ShieldCheck,
          retryLabel: t('states.cloudflareAccess.continue'),
        }}
        onRetry={reloadThroughAccess}
      />
    );
  }

  if (state.kind === 'loading') {
    return checkingPhase === 'hidden'
      ? <InitialCheckingPlaceholder label={t('loading.title')} />
      : <StudioCheckingScreen />;
  }
  if (checkingPhase === 'checking') {
    return <StudioCheckingScreen />;
  }
  if (state.kind === 'anonymous') {
    return (
      <LoginPage
        onAuthenticated={() => setAttempt((value) => value + 1)}
      />
    );
  }
  if (state.kind === 'authenticated') {
    return (
      <>
        <AuthenticatedApplication
          data={state.data}
          onSessionEnded={requireReauthentication}
          onSignedOut={finishSession}
          onCurrentUserNameChanged={updateCurrentUserName}
        />
        {state.reauthentication !== null ? (
          <SessionReauthenticationDialog
            phase={state.reauthentication}
            email={state.data.user.email}
            accountName={state.data.user.name}
            onAuthenticated={() => void restoreSession()}
            onRetry={() => void restoreSession()}
            onDiscard={discardWorkspace}
          />
        ) : null}
        <Dialog
          open={accessInterruption !== null}
          onClose={() => undefined}
          title={accessTitle}
          description={accessMessage}
        >
          <DialogActions>
            <Button
              type="button"
              variant="primary"
              block
              onClick={reloadThroughAccess}
            >
              <StudioIcon icon={ShieldCheck} />
              {t('states.cloudflareAccess.continue')}
            </Button>
          </DialogActions>
        </Dialog>
      </>
    );
  }
  return (
    <StatusScreen
      presentation={{
        eyebrow: t('states.unavailable.eyebrow'),
        title: t('states.unavailable.title'),
        message: t('states.unavailable.message'),
        tone: 'error',
      }}
      onRetry={() => setAttempt((value) => value + 1)}
    />
  );
}

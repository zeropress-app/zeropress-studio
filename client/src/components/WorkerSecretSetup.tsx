import {
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Clock3,
  Copy,
  ExternalLink,
  KeyRound,
  RefreshCw,
} from 'lucide-react';
import type { StudioWorkerSecretState } from '../../../contracts/worker-secret';
import {
  STUDIO_WORKER_CONFIGURATION_CATALOG,
} from '../../../contracts/worker-configuration';
import { generateWorkerSecretCandidate } from '../lib/worker-secret';
import {
  Button,
  ButtonLink,
  ConfigurationReference,
  Field,
  Notice,
  StatusPill,
  StudioIcon,
  useStudioToast,
  type StatusTone,
} from './primitives';

const WORKER_SECRETS_GUIDE_URL =
  'https://studio.zeropress.dev/getting-started/worker-secrets/';

export type BootstrapWorkerSecretName =
  | 'STUDIO_AUTH_SECRET'
  | 'STUDIO_INSTALL_TOKEN';

export type WorkerSecretSetupTarget = {
  name: BootstrapWorkerSecretName;
  state?: StudioWorkerSecretState | 'unknown';
};

type CopyState = 'idle' | 'copied' | 'failed';

function statusTone(
  state: StudioWorkerSecretState | 'unknown',
): StatusTone {
  if (state === 'valid') return 'positive';
  if (state === 'invalid') return 'critical';
  return 'attention';
}

export function WorkerSecretSetup(input: {
  context: 'authentication' | 'installation';
  targets: readonly WorkerSecretSetupTarget[];
  siteModeState?: 'valid' | 'change_required';
}) {
  const { t } = useTranslation('system');
  const valueInputs = useRef<Partial<
    Record<BootstrapWorkerSecretName, HTMLInputElement | null>
  >>({});
  const [secrets, setSecrets] = useState<Partial<
    Record<BootstrapWorkerSecretName, string>
  >>({});
  const [generationFailures, setGenerationFailures] = useState<Partial<
    Record<BootstrapWorkerSecretName, boolean>
  >>({});
  const [copyStates, setCopyStates] = useState<Partial<
    Record<BootstrapWorkerSecretName, CopyState>
  >>({});

  useStudioToast({
    id: 'system-auth-secret-copy',
    tone: 'success',
    message: copyStates.STUDIO_AUTH_SECRET === 'copied'
      ? input.context === 'authentication'
        ? t('workerSecretSetup.authentication.copySuccess')
        : t('workerSecretSetup.copySuccess', {
            name: 'STUDIO_AUTH_SECRET',
          })
      : null,
  });
  useStudioToast({
    id: 'system-install-token-copy',
    tone: 'success',
    message: input.context === 'installation'
      && copyStates.STUDIO_INSTALL_TOKEN === 'copied'
      ? t('workerSecretSetup.installToken.copySuccess')
      : null,
  });

  useEffect(() => {
    function clearGeneratedValues() {
      setSecrets({});
      setGenerationFailures({});
      setCopyStates({});
    }

    function clearRestoredValues(event: PageTransitionEvent) {
      if (event.persisted) clearGeneratedValues();
    }

    window.addEventListener('pagehide', clearGeneratedValues);
    window.addEventListener('pageshow', clearRestoredValues);
    return () => {
      window.removeEventListener('pagehide', clearGeneratedValues);
      window.removeEventListener('pageshow', clearRestoredValues);
    };
  }, []);

  function generateSecret(name: BootstrapWorkerSecretName) {
    try {
      const secret = generateWorkerSecretCandidate();
      setSecrets((current) => ({ ...current, [name]: secret }));
      setGenerationFailures((current) => ({ ...current, [name]: false }));
      setCopyStates((current) => ({ ...current, [name]: 'idle' }));
    } catch {
      setGenerationFailures((current) => ({ ...current, [name]: true }));
      setCopyStates((current) => ({ ...current, [name]: 'idle' }));
    }
  }

  async function copySecret(name: BootstrapWorkerSecretName) {
    const secret = secrets[name];
    if (!secret) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Unavailable');
      await navigator.clipboard.writeText(secret);
      setCopyStates((current) => ({ ...current, [name]: 'copied' }));
    } catch {
      setCopyStates((current) => ({ ...current, [name]: 'failed' }));
      valueInputs.current[name]?.focus();
      valueInputs.current[name]?.select();
    }
  }

  const isInstallation = input.context === 'installation';
  const siteModeReady = input.siteModeState !== 'change_required';
  const authenticationTarget = !isInstallation
    ? input.targets.find((target) => target.name === 'STUDIO_AUTH_SECRET')
    : undefined;

  if (authenticationTarget) {
    const secret = secrets[authenticationTarget.name];
    const copyState = copyStates[authenticationTarget.name] ?? 'idle';

    return (
      <section
        className="auth-secret-setup auth-secret-setup-compact"
        aria-label={authenticationTarget.name}
      >
        <ConfigurationReference
          name={authenticationTarget.name}
          kind={STUDIO_WORKER_CONFIGURATION_CATALOG[
            authenticationTarget.name
          ].kind}
        />
        <p className="auth-secret-compact-requirement">
          {t('workerSecretSetup.authentication.requirement')}
        </p>
        <p className="auth-secret-compact-safety">
          {t('workerSecretSetup.authentication.existingInstallation')}
        </p>

        {secret ? (
          <Field
            label={t('workerSecretSetup.valueLabel', {
              name: authenticationTarget.name,
            })}
          >
            {(control) => (
              <input
                {...control}
                ref={(element) => {
                  valueInputs.current[authenticationTarget.name] = element;
                }}
                className="auth-secret-value"
                type="text"
                value={secret}
                readOnly
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
                onFocus={(event) => event.currentTarget.select()}
              />
            )}
          </Field>
        ) : null}

        <div className="auth-secret-actions">
          {secret ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={() => void copySecret(authenticationTarget.name)}
              >
                <StudioIcon icon={Copy} className="auth-button-icon" />
                {copyState === 'copied'
                  ? t('workerSecretSetup.copied')
                  : t('workerSecretSetup.copy')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => generateSecret(authenticationTarget.name)}
              >
                <StudioIcon icon={RefreshCw} className="auth-button-icon" />
                {t('workerSecretSetup.regenerate')}
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="primary"
              onClick={() => generateSecret(authenticationTarget.name)}
            >
              <StudioIcon icon={KeyRound} className="auth-button-icon" />
              {t('workerSecretSetup.authentication.generate')}
            </Button>
          )}
          <ButtonLink
            external
            size="sm"
            to={WORKER_SECRETS_GUIDE_URL}
          >
            <StudioIcon icon={ExternalLink} className="auth-button-icon" />
            {t('workerSecretSetup.guide')}
          </ButtonLink>
        </div>

        {copyState === 'failed' ? (
          <p
            className="auth-secret-feedback auth-secret-feedback-error"
            role="alert"
          >
            {t('workerSecretSetup.copyFailed')}
          </p>
        ) : null}
        {generationFailures[authenticationTarget.name] ? (
          <p
            className="auth-secret-feedback auth-secret-feedback-error"
            role="alert"
          >
            {t('workerSecretSetup.generationFailed')}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section
      className="auth-secret-setup auth-secret-setup-checklist"
      aria-label={t('workerSecretSetup.installation.regionLabel')}
    >
      <p className="auth-secret-storage-guidance">
        {t('workerSecretSetup.installation.storageGuidance')}{' '}
        <a
          className="auth-secret-guide-link"
          href={WORKER_SECRETS_GUIDE_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('workerSecretSetup.guide')}
        </a>
      </p>

      <div className="auth-secret-checklist">
        <section
          className="auth-secret-requirement auth-secret-requirement-compact"
          aria-label="STUDIO_SITE_MODE"
        >
          <div className="auth-secret-requirement-heading">
            <div className="auth-secret-requirement-identity">
              <ConfigurationReference
                name="STUDIO_SITE_MODE"
                kind={STUDIO_WORKER_CONFIGURATION_CATALOG.STUDIO_SITE_MODE.kind}
              />
              <p className="auth-secret-requirement-summary">
                {siteModeReady
                  ? t('workerSecretSetup.installation.siteMode')
                  : t('workerSecretSetup.installation.siteModeChangeRequired')}
              </p>
            </div>
            <StatusPill tone={siteModeReady ? 'positive' : 'attention'}>
              {siteModeReady
                ? t('workerSecretSetup.states.valid')
                : t('workerSecretSetup.states.changeRequired')}
            </StatusPill>
          </div>
        </section>

        {input.targets.map((target) => {
          const secret = secrets[target.name];
          const copyState = copyStates[target.name] ?? 'idle';
          const isConfigured = target.state === 'valid';
          const isAuthSecret = target.name === 'STUDIO_AUTH_SECRET';
          const description = isAuthSecret
            ? t('workerSecretSetup.authSecret.description')
            : t('workerSecretSetup.installToken.description');

          return (
            <section
              className={`auth-secret-requirement${
                isConfigured ? ' auth-secret-requirement-compact' : ''
              }`}
              aria-label={target.name}
              key={target.name}
            >
              <div className="auth-secret-requirement-heading">
                <div className="auth-secret-requirement-identity">
                  <ConfigurationReference
                    name={target.name}
                    kind={STUDIO_WORKER_CONFIGURATION_CATALOG[target.name].kind}
                  />
                  {isConfigured ? (
                    <p className="auth-secret-requirement-summary">
                      {description}
                    </p>
                  ) : null}
                </div>
                {target.state ? (
                  <StatusPill tone={statusTone(target.state)}>
                    {target.state === 'valid'
                      ? t('workerSecretSetup.states.valid')
                      : target.state === 'invalid'
                        ? t('workerSecretSetup.states.invalid')
                        : target.state === 'missing'
                          ? t('workerSecretSetup.states.missing')
                          : t('workerSecretSetup.states.unknown')}
                  </StatusPill>
                ) : null}
              </div>

              {!isConfigured ? (
                <div className="auth-secret-requirement-body">
                  <p className="auth-secret-requirement-description">
                    {description}
                  </p>

                  {!secret ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="primary"
                      aria-label={t('workerSecretSetup.generate', {
                        name: target.name,
                      })}
                      onClick={() => generateSecret(target.name)}
                    >
                      <StudioIcon icon={KeyRound} className="auth-button-icon" />
                      {t('workerSecretSetup.generateValue')}
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {!isConfigured && secret ? (
                <Field
                  label={t('workerSecretSetup.valueLabel', {
                    name: target.name,
                  })}
                >
                  {(control) => (
                    <input
                      {...control}
                      ref={(element) => {
                        valueInputs.current[target.name] = element;
                      }}
                      className="auth-secret-value"
                      type="text"
                      value={secret}
                      readOnly
                      spellCheck={false}
                      autoComplete="off"
                      autoCapitalize="none"
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  )}
                </Field>
              ) : null}

              {!isConfigured && secret && !isAuthSecret ? (
                <p className="auth-secret-retention-note">
                  <StudioIcon icon={Clock3} />
                  {t('workerSecretSetup.installToken.retention')}
                </p>
              ) : null}

              {!isConfigured && secret ? (
                <div className="auth-secret-actions">
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    onClick={() => void copySecret(target.name)}
                  >
                    <StudioIcon icon={Copy} className="auth-button-icon" />
                    {copyState === 'copied'
                      ? t('workerSecretSetup.copied')
                      : t('workerSecretSetup.copy')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => generateSecret(target.name)}
                  >
                    <StudioIcon icon={RefreshCw} className="auth-button-icon" />
                    {t('workerSecretSetup.regenerate')}
                  </Button>
                </div>
              ) : null}

              {copyState === 'failed' ? (
                <Notice tone="error">
                  {t('workerSecretSetup.copyFailed')}
                </Notice>
              ) : null}
              {generationFailures[target.name] ? (
                <Notice tone="error">
                  {t('workerSecretSetup.generationFailed')}
                </Notice>
              ) : null}
            </section>
          );
        })}
      </div>
    </section>
  );
}

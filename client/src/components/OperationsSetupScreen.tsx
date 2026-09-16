import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, KeyRound, RefreshCw } from 'lucide-react';
import type { OperationsSetupConfiguration } from '../../../contracts/system';
import {
  STUDIO_WORKER_CONFIGURATION_CATALOG,
} from '../../../contracts/worker-configuration';
import { SUPPORTED_LOCALES } from '../i18n/locale';
import { generateWorkerSecretCandidate } from '../lib/worker-secret';
import { StandaloneStatusScreen } from './StandaloneStatusScreen';
import {
  Button,
  ConfigurationReference,
  Field,
  Notice,
  StatusPill,
  StudioIcon,
  useStudioToast,
} from './primitives';

const TOKEN_NAME = 'STUDIO_OPERATIONS_TOKEN';
const ALLOWLIST_NAME = 'STUDIO_OPERATIONS_ALLOWED_IPS';

function OperationsClientIpField(input: { clientIp: string | null }) {
  const { t } = useTranslation('operations');
  const clientIp = input.clientIp;
  const valueInput = useRef<HTMLInputElement>(null);
  const copyAttempt = useRef(0);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useStudioToast({
    id: 'operations-setup-ip-copy',
    tone: 'success',
    message: copyState === 'copied' ? t('setup.clientIp.copySuccess') : null,
  });

  useEffect(() => {
    const clearFeedback = () => {
      copyAttempt.current += 1;
      setCopyState('idle');
    };
    window.addEventListener('pagehide', clearFeedback);
    return () => {
      copyAttempt.current += 1;
      window.removeEventListener('pagehide', clearFeedback);
    };
  }, []);

  async function copyIp() {
    if (!clientIp) return;
    const attempt = ++copyAttempt.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Unavailable');
      await navigator.clipboard.writeText(clientIp);
      if (copyAttempt.current === attempt) setCopyState('copied');
    } catch {
      if (copyAttempt.current !== attempt) return;
      setCopyState('failed');
      valueInput.current?.focus();
      valueInput.current?.select();
    }
  }

  if (clientIp === null) {
    return <p className="auth-secret-storage-guidance">{t('setup.clientIp.unavailable')}</p>;
  }

  return (
    <>
      <Field label={t('setup.clientIp.label')} hint={t('setup.clientIp.hint')}>
        {(control) => (
          <input
            {...control}
            ref={valueInput}
            className="auth-secret-value"
            type="text"
            value={clientIp}
            readOnly
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
      </Field>
      <div className="auth-secret-actions">
        <Button type="button" size="sm" onClick={() => void copyIp()}>
          <StudioIcon icon={Copy} />
          {copyState === 'copied' ? t('setup.copied') : t('setup.clientIp.copy')}
        </Button>
      </div>
      {copyState === 'failed' ? (
        <Notice tone="error">{t('setup.clientIp.copyFailed')}</Notice>
      ) : null}
    </>
  );
}

export function OperationsSetupScreen(input: {
  configuration: OperationsSetupConfiguration;
  onRetry: () => void;
}) {
  const { t } = useTranslation('operations');
  const valueInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [secret, setSecret] = useState('');
  const [generationFailed, setGenerationFailed] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useStudioToast({
    id: 'operations-setup-token-copy',
    tone: 'success',
    message: copyState === 'copied' ? t('setup.copySuccess') : null,
  });

  useEffect(() => {
    function clearGeneratedValue() {
      generation.current += 1;
      setSecret('');
      setGenerationFailed(false);
      setCopyState('idle');
    }
    function clearRestoredValue(event: PageTransitionEvent) {
      if (event.persisted) clearGeneratedValue();
    }
    window.addEventListener('pagehide', clearGeneratedValue);
    window.addEventListener('pageshow', clearRestoredValue);
    return () => {
      generation.current += 1;
      window.removeEventListener('pagehide', clearGeneratedValue);
      window.removeEventListener('pageshow', clearRestoredValue);
    };
  }, []);

  function generateSecret() {
    generation.current += 1;
    setCopyState('idle');
    try {
      setSecret(generateWorkerSecretCandidate());
      setGenerationFailed(false);
    } catch {
      setGenerationFailed(true);
    }
  }

  async function copySecret() {
    const currentGeneration = generation.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Unavailable');
      await navigator.clipboard.writeText(secret);
      if (generation.current === currentGeneration) setCopyState('copied');
    } catch {
      if (generation.current !== currentGeneration) return;
      setCopyState('failed');
      valueInput.current?.focus();
      valueInput.current?.select();
    }
  }

  return (
    <StandaloneStatusScreen
      regionLabel={t('setup.title')}
      brandLabel="ZeroPress Studio"
      kicker={t('setup.kicker')}
      title={t('setup.title')}
      description={t('setup.description')}
      tone="warning"
      wide
      localeLabel={t('language.label')}
      availableLocales={SUPPORTED_LOCALES}
    >
      <div className="auth-secret-setup auth-secret-setup-checklist">
        <p className="auth-secret-storage-guidance">
          {t('setup.storageGuidance')}{' '}
          <a
            className="auth-secret-guide-link"
            href="https://studio.zeropress.dev/getting-started/worker-secrets/"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('setup.guide')}
          </a>
        </p>
        <div className="auth-secret-checklist">
          {([
            {
              name: ALLOWLIST_NAME,
              state: input.configuration.allowed_ips,
              description: t('setup.allowedIps'),
            },
            {
              name: TOKEN_NAME,
              state: input.configuration.token,
              description: t('setup.token'),
            },
          ] as const).map((target) => (
            <section
              className="auth-secret-requirement"
              aria-label={target.name}
              key={target.name}
            >
              <div className="auth-secret-requirement-heading">
                <ConfigurationReference
                  name={target.name}
                  kind={STUDIO_WORKER_CONFIGURATION_CATALOG[target.name].kind}
                />
                <StatusPill
                  tone={target.state === 'valid'
                    ? 'positive' : target.state === 'missing' ? 'attention' : 'critical'}
                >
                  {t(`setup.states.${target.state}`)}
                </StatusPill>
              </div>
              <p className="auth-secret-requirement-description">
                {target.description}
              </p>
              {target.name === ALLOWLIST_NAME && input.configuration.allowed_ips !== 'valid' ? (
                <OperationsClientIpField
                  key={input.configuration.client_ip}
                  clientIp={input.configuration.client_ip}
                />
              ) : null}
              {target.name === TOKEN_NAME && target.state !== 'valid' ? (
                <>
                  {secret ? (
                    <>
                      <Field label={t('setup.valueLabel')}>
                        {(control) => (
                          <input
                            {...control}
                            ref={valueInput}
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
                      <p className="auth-secret-retention-note">
                        {t('setup.retention')}
                      </p>
                    </>
                  ) : null}
                  <div className="auth-secret-actions">
                    {secret ? (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="primary"
                          onClick={() => void copySecret()}
                        >
                          <StudioIcon icon={Copy} />
                          {copyState === 'copied' ? t('setup.copied') : t('setup.copy')}
                        </Button>
                        <Button type="button" size="sm" onClick={generateSecret}>
                          <StudioIcon icon={RefreshCw} />
                          {t('setup.regenerate')}
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        onClick={generateSecret}
                      >
                        <StudioIcon icon={KeyRound} />
                        {t('setup.generate')}
                      </Button>
                    )}
                  </div>
                  {copyState === 'failed' ? (
                    <Notice tone="error">{t('setup.copyFailed')}</Notice>
                  ) : null}
                  {generationFailed ? (
                    <Notice tone="error">{t('setup.generationFailed')}</Notice>
                  ) : null}
                </>
              ) : null}
            </section>
          ))}
        </div>
      </div>
      <Button type="button" size="lg" block onClick={input.onRetry}>
        <StudioIcon icon={RefreshCw} />
        {t('setup.retry')}
      </Button>
    </StandaloneStatusScreen>
  );
}

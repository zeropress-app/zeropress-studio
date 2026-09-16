import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, KeyRound } from 'lucide-react';
import type { ApiErrorCode } from '../../contracts/api';
import type { InstallSuccess } from '../../contracts/install';
import {
  isValidStudioWorkerSecret,
  STUDIO_WORKER_SECRET_MAX_LENGTH,
  STUDIO_WORKER_SECRET_MIN_LENGTH,
} from '../../contracts/worker-secret';
import { InstallPage } from './InstallPage';
import { LocaleSwitcher } from './components/LocaleSwitcher';
import { LogoBadge } from './components/LogoBadge';
import { ThemeToggle } from './components/ThemeToggle';
import {
  Button,
  Field,
  Notice,
  Spinner,
  StudioIcon,
} from './components/primitives';
import {
  InstallClientError,
  requestInstallAccess,
  type InstallClientErrorCode,
} from './lib/install-client';

type InstallAccessResult =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: InstallClientErrorCode }
  | { kind: 'unexpected' };

function InstallAccessPage(input: {
  authorizationExpired: boolean;
  onAuthorized: (token: string) => void;
  onInstallationChanged: () => void;
}) {
  const { t, i18n } = useTranslation('install');
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showExpiredNotice, setShowExpiredNotice] = useState(
    input.authorizationExpired,
  );
  const [result, setResult] = useState<InstallAccessResult | null>(null);

  useEffect(() => {
    document.title = t('documentTitle');
  }, [i18n.resolvedLanguage, t]);

  function resultMessage(): string | null {
    if (!result) return null;
    if (result.kind === 'client') {
      if (result.code === 'INVALID_TOKEN_FORMAT') {
        return t('validation.token');
      }
      if (result.code === 'TIMEOUT') return t('errors.timeout');
      if (result.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (result.kind === 'unexpected') return t('errors.unknown');
    if (result.code === 'INVALID_INSTALL_TOKEN') {
      return t('errors.invalidToken');
    }
    if (result.code === 'RATE_LIMIT_EXCEEDED') {
      return t('errors.rateLimit');
    }
    return t('errors.unavailable');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || token.length === 0) return;

    setSubmitting(true);
    setResult(null);
    setShowExpiredNotice(false);
    try {
      const response = await requestInstallAccess(token);
      if (!response.success) {
        if (response.error.code === 'INSTALLATION_ALREADY_COMPLETED') {
          input.onInstallationChanged();
          return;
        }
        setResult({ kind: 'api', code: response.error.code });
        return;
      }
      input.onAuthorized(token);
    } catch (error) {
      setResult(
        error instanceof InstallClientError
          ? { kind: 'client', code: error.code }
          : { kind: 'unexpected' },
      );
    } finally {
      setSubmitting(false);
    }
  }

  const message = resultMessage();

  return (
    <main className="auth-shell auth-shell-login">
      <section
        className="auth-frame auth-frame-login"
        aria-label={t('access.regionLabel')}
      >
        <aside className="auth-brand">
          <p className="auth-lockup">
            <LogoBadge />
            <span>
              ZeroPress{' '}
              <strong className="auth-lockup-emphasis">Studio</strong>
            </span>
          </p>
          <div className="auth-brand-copy">
            <p className="auth-eyebrow">{t('access.brand.eyebrow')}</p>
            <h1 className="auth-brand-headline">
              {t('access.brand.headline')}
            </h1>
            <p className="auth-brand-description">
              {t('access.brand.description')}
            </p>
          </div>
        </aside>

        <div className="auth-form-panel auth-form-panel-login">
          <div className="auth-login-chrome">
            <p className="auth-mobile-brand">
              <LogoBadge />
              <span className="auth-mobile-brand-label">
                ZeroPress{' '}
                <strong className="auth-lockup-emphasis">Studio</strong>
              </span>
            </p>
            <div className="auth-login-controls">
              <ThemeToggle />
              <LocaleSwitcher />
            </div>
          </div>

          <div className="auth-form-content">
            <header className="auth-form-header">
              <p className="auth-kicker">{t('access.kicker')}</p>
              <h2 className="auth-form-title">{t('access.title')}</h2>
              <p className="auth-form-description">
                {t('access.description')}
              </p>
            </header>

            <form className="auth-form" onSubmit={handleSubmit} noValidate>
              <Field label={t('fields.token.label')}>
                {(control) => (
                  <div className="auth-input">
                    <StudioIcon icon={KeyRound} />
                    <input
                      {...control}
                      type="password"
                      autoComplete="off"
                      minLength={STUDIO_WORKER_SECRET_MIN_LENGTH}
                      maxLength={STUDIO_WORKER_SECRET_MAX_LENGTH}
                      required
                      aria-invalid={
                        token.length > 0
                        && !isValidStudioWorkerSecret(token)
                      }
                      value={token}
                      placeholder={t('fields.token.placeholder')}
                      disabled={submitting}
                      onChange={(event) => {
                        setToken(event.target.value);
                        setResult(null);
                        setShowExpiredNotice(false);
                      }}
                    />
                  </div>
                )}
              </Field>

              <Button
                type="submit"
                variant="primary"
                size="lg"
                block
                disabled={submitting || token.length === 0}
              >
                {submitting ? <Spinner /> : null}
                {submitting ? t('access.submitting') : t('access.submit')}
                {!submitting ? (
                  <StudioIcon
                    className="auth-button-icon"
                    icon={ArrowRight}
                  />
                ) : null}
              </Button>

              {showExpiredNotice ? (
                <Notice tone="warning">
                  {t('access.authorizationExpired')}
                </Notice>
              ) : null}
              {message ? <Notice tone="error">{message}</Notice> : null}
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}

export function InstallFlow(input: {
  onInstallationChanged: (
    edgeDatabase?: InstallSuccess['data']['edge_database'],
  ) => void;
}) {
  const [authorizedToken, setAuthorizedToken] = useState<string | null>(null);
  const [authorizationExpired, setAuthorizationExpired] = useState(false);
  const [accessEpoch, setAccessEpoch] = useState(0);

  const lockInstaller = useCallback((expired = false) => {
    setAuthorizedToken(null);
    setAuthorizationExpired(expired);
    setAccessEpoch((current) => current + 1);
  }, []);

  useEffect(() => {
    const lockBeforeLeaving = () => lockInstaller(false);
    const lockAfterHistoryRestore = (event: PageTransitionEvent) => {
      if (event.persisted) lockInstaller(false);
    };

    window.addEventListener('pagehide', lockBeforeLeaving);
    window.addEventListener('pageshow', lockAfterHistoryRestore);
    return () => {
      window.removeEventListener('pagehide', lockBeforeLeaving);
      window.removeEventListener('pageshow', lockAfterHistoryRestore);
    };
  }, [lockInstaller]);

  if (authorizedToken === null) {
    return (
      <InstallAccessPage
        key={accessEpoch}
        authorizationExpired={authorizationExpired}
        onAuthorized={(token) => {
          setAuthorizationExpired(false);
          setAuthorizedToken(token);
        }}
        onInstallationChanged={() => input.onInstallationChanged()}
      />
    );
  }

  return (
    <InstallPage
      token={authorizedToken}
      onAuthorizationExpired={() => lockInstaller(true)}
      onInstallationChanged={input.onInstallationChanged}
    />
  );
}

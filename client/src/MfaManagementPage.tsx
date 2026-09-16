import {
  browserSupportsWebAuthn,
  startAuthentication,
} from '@simplewebauthn/browser';
import {
  useEffect,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import { Link } from 'react-router';
import type { ApiErrorCode } from '../../contracts/api';
import type { MfaEnrollmentSetupData } from '../../contracts/mfa';
import type {
  MfaManagementStatusResponse,
  MfaManagementVerification,
} from '../../contracts/mfa-management';
import { MfaEnrollmentPanel } from './components/MfaEnrollmentPanel';
import {
  MfaManagementClientError,
  requestManagedTotpComplete,
  requestManagedTotpSetup,
  requestMfaManagementAuthorization,
  requestMfaManagementStatus,
  requestMfaManagementWebAuthnStepUpOptions,
  requestMfaManagementWebAuthnStepUpVerification,
  type MfaManagementClientErrorCode,
} from './lib/mfa-management-client';
import { STUDIO_PATHS } from './routing/studio-routes';
import {
  Button,
  ButtonLink,
  Callout,
  Field,
  Notice,
  PageHeader,
  Panel,
  Spinner,
} from './components/primitives';
import { StepUpVerification } from './components/StepUpVerification';

type AccountSession = {
  csrf_token: string;
};

type ReadyStatus = Extract<
  MfaManagementStatusResponse,
  { success: true }
>['data'];

type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: MfaManagementClientErrorCode }
  | {
    kind: 'validation';
    field:
      | 'password'
      | 'verification'
      | 'totp'
      | 'webauthn';
  }
  | { kind: 'unexpected' };

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: ReadyStatus }
  | { kind: 'error'; failure: Failure };

type Completion = {
  revokedSessions: number;
};

function clientFailure(error: unknown): Failure {
  return error instanceof MfaManagementClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

export function MfaManagementPage(input: {
  operation: 'replace_totp';
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('security');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({
    kind: 'loading',
  });
  const [password, setPassword] = useState('');
  const [verificationMethod, setVerificationMethod] =
    useState<MfaManagementVerification['method'] | 'webauthn'>('totp');
  const [webAuthnSupported] = useState(() => browserSupportsWebAuthn());
  const [verificationCode, setVerificationCode] = useState('');
  const [managementToken, setManagementToken] =
    useState<string | null>(null);
  const [totpSetup, setTotpSetup] =
    useState<MfaEnrollmentSetupData | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  useStudioDocumentTitle(t('management.totp.documentTitle'));

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    void requestMfaManagementStatus(controller.signal)
      .then((response) => {
        if (!active) return;
        if (response.success) {
          setLoadState({ kind: 'ready', status: response.data });
          return;
        }
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({
          kind: 'error',
          failure: { kind: 'api', code: response.error.code },
        });
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        setLoadState({ kind: 'error', failure: clientFailure(error) });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [input.onSessionEnded, loadAttempt]);

  function errorMessage(value: Failure): string {
    if (value.kind === 'validation') {
      return t(`management.validation.${value.field}`);
    }
    if (value.kind === 'client') {
      if (value.code === 'TIMEOUT') return t('management.errors.timeout');
      if (value.code === 'NETWORK_ERROR') {
        return t('management.errors.network');
      }
      return t('management.errors.invalidResponse');
    }
    if (value.kind === 'unexpected') {
      return t('management.errors.unexpected');
    }
    if (value.code === 'INVALID_CURRENT_PASSWORD') {
      return t('management.errors.invalidPassword');
    }
    if (
      value.code === 'INVALID_MFA_CODE'
      || value.code === 'WEBAUTHN_VERIFICATION_FAILED'
    ) {
      return t('management.errors.invalidMfa');
    }
    if (value.code === 'MFA_STEP_UP_REQUIRED') {
      return t('management.errors.stepUpRequired');
    }
    if (
      value.code === 'MFA_MANAGEMENT_CHALLENGE_INVALID'
      || value.code === 'MFA_ENROLLMENT_INVALID'
      || value.code === 'MFA_CHALLENGE_INVALID'
      || value.code === 'WEBAUTHN_CHALLENGE_INVALID'
    ) {
      return t('management.errors.expired');
    }
    if (value.code === 'RATE_LIMIT_EXCEEDED') {
      return t('management.errors.rateLimit');
    }
    return t('management.errors.api');
  }

  function handleApiError(code: ApiErrorCode): void {
    if (code === 'AUTHENTICATION_REQUIRED') {
      input.onSessionEnded();
      return;
    }
    setFailure({ kind: 'api', code });
    if (code === 'MFA_STEP_UP_REQUIRED') {
      setLoadState((current) => current.kind === 'ready'
        ? {
            kind: 'ready',
            status: {
              ...current.status,
              step_up: {
                ...current.status.step_up,
                mfa_required: true,
              },
            },
          }
        : current);
    }
  }

  function resetSensitiveFlow(): void {
    setPassword('');
    setVerificationCode('');
    setManagementToken(null);
    setTotpSetup(null);
    setTotpCode('');
    setFailure(null);
    setCompletion(null);
  }

  async function beginManagement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running || loadState.kind !== 'ready') return;
    if (!password) {
      setFailure({ kind: 'validation', field: 'password' });
      return;
    }
    if (
      loadState.status.step_up.mfa_required
      && verificationMethod !== 'webauthn'
      && !/^[0-9]{6}$/u.test(verificationCode)
    ) {
      setFailure({ kind: 'validation', field: 'verification' });
      return;
    }

    setRunning(true);
    setFailure(null);
    try {
      let authorization;
      if (
        loadState.status.step_up.mfa_required
        && verificationMethod === 'webauthn'
      ) {
        const options = await requestMfaManagementWebAuthnStepUpOptions(
          input.data.csrf_token,
          {
            operation: input.operation,
            password,
          },
        );
        if (!options.success) {
          handleApiError(options.error.code);
          return;
        }
        let assertion;
        try {
          assertion = await startAuthentication({
            optionsJSON: options.data.options,
          });
        } catch {
          setFailure({ kind: 'validation', field: 'webauthn' });
          return;
        }
        authorization =
          await requestMfaManagementWebAuthnStepUpVerification(
            input.data.csrf_token,
            {
              operation: input.operation,
              challenge_token: options.data.challenge_token,
              response: assertion,
            },
          );
      } else {
        const verification = loadState.status.step_up.mfa_required
          ? {
            method: verificationMethod,
            code: verificationCode,
          } as MfaManagementVerification
          : undefined;
        authorization = await requestMfaManagementAuthorization(
          input.data.csrf_token,
          {
            operation: input.operation,
            password,
            ...(verification ? { verification } : {}),
          },
        );
      }
      if (!authorization.success) {
        handleApiError(authorization.error.code);
        return;
      }
      const token = authorization.data.management_token;
      setManagementToken(token);

      const setup = await requestManagedTotpSetup(
        input.data.csrf_token,
        token,
      );
      if (!setup.success) {
        setManagementToken(null);
        handleApiError(setup.error.code);
        return;
      }
      setTotpSetup(setup.data);
    } catch (error) {
      setManagementToken(null);
      setFailure(clientFailure(error));
    } finally {
      setPassword('');
      setVerificationCode('');
      setRunning(false);
    }
  }

  async function completeTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running || !managementToken || !totpSetup) return;
    if (!/^[0-9]{6}$/u.test(totpCode)) {
      setFailure({ kind: 'validation', field: 'totp' });
      return;
    }
    setRunning(true);
    setFailure(null);
    try {
      const response = await requestManagedTotpComplete(
        input.data.csrf_token,
        {
          management_token: managementToken,
          mfa: {
            enrollment_token: totpSetup.enrollment_token,
            totp_code: totpCode,
          },
        },
      );
      if (!response.success) {
        handleApiError(response.error.code);
        return;
      }
      setTotpSetup(null);
      setManagementToken(null);
      setTotpCode('');
      setCompletion({
        revokedSessions: response.data.revoked_sessions,
      });
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setRunning(false);
    }
  }

  const pageTitle = t('management.totp.title');
  const pageDescription = t('management.totp.description');
  const canUseWebAuthn = webAuthnSupported
    && loadState.kind === 'ready'
    && loadState.status.webauthn.credentials.some(
      (credential) =>
        credential.rp_id === loadState.status.webauthn.current_rp_id,
    );

  return (
    <main
      id="studio-main-content"
      aria-labelledby="mfa-management-title"
    >
      <Link className="account-back" to={STUDIO_PATHS.accountSecurity}>
        <span aria-hidden="true">←</span>
        {t('management.back')}
      </Link>
      <PageHeader
        titleId="mfa-management-title"
        kicker={t('management.kicker')}
        title={pageTitle}
        description={pageDescription}
      />

      <div className="account-stack">
        {loadState.kind === 'loading' ? (
          <Panel>
            <div className="account-state" role="status">
              <Spinner size="lg" />
              <div className="account-state-text">
                <strong className="account-state-title">
                  {t('management.loading.title')}
                </strong>
                <p className="account-state-detail">
                  {t('management.loading.message')}
                </p>
              </div>
            </div>
          </Panel>
        ) : null}

        {loadState.kind === 'error' ? (
          <Notice
            tone="error"
            title={t('management.loadError.title')}
            actions={(
              <Button
                type="button"
                onClick={() => setLoadAttempt((value) => value + 1)}
              >
                {t('loadError.retry')}
              </Button>
            )}
          >
            {errorMessage(loadState.failure)}
          </Notice>
        ) : null}

        {loadState.kind === 'ready' && !managementToken && !completion ? (
          <form onSubmit={(event) => void beginManagement(event)}>
            <Panel
              title={t('management.authorize.title')}
              description={t('management.authorize.description')}
              footer={(
                <>
                  <ButtonLink
                    variant="ghost"
                    to={STUDIO_PATHS.accountSecurity}
                  >
                    {t('management.cancel')}
                  </ButtonLink>
                  <Button type="submit" variant="primary" disabled={running}>
                    {running
                      ? t('management.authorize.running')
                      : t('management.authorize.continue')}
                  </Button>
                </>
              )}
            >
              <div className="account-form-fields">
                <Field label={t('management.authorize.password')}>
                  {(control) => (
                    <input
                      {...control}
                      type="password"
                      autoComplete="current-password"
                      maxLength={1024}
                      value={password}
                      disabled={running}
                      required
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  )}
                </Field>
                <StepUpVerification
                  name="management-mfa-method"
                  required={loadState.status.step_up.mfa_required}
                  method={verificationMethod}
                  onMethodChange={setVerificationMethod}
                  code={verificationCode}
                  onCodeChange={setVerificationCode}
                  webAuthnAvailable={canUseWebAuthn}
                  disabled={running}
                  copy={{
                    legend: t('management.authorize.mfaLegend'),
                    notRequired: t('management.authorize.recentMfa'),
                    webauthn: t('management.authorize.webauthn'),
                    webauthnPrompt: t('management.authorize.webauthnPrompt'),
                    totp: t('management.authorize.totp'),
                    totpCode: t('management.authorize.totpCode'),
                  }}
                />
                {failure ? (
                  <Notice tone="error">{errorMessage(failure)}</Notice>
                ) : null}
              </div>
            </Panel>
          </form>
        ) : null}

        {totpSetup && managementToken ? (
          <form onSubmit={(event) => void completeTotp(event)}>
            <Panel
              title={t('management.totp.setupTitle')}
              description={t('management.totp.setupDescription')}
              footer={(
                <>
                  <Button
                    type="button"
                    disabled={running}
                    onClick={resetSensitiveFlow}
                  >
                    {t('management.restart')}
                  </Button>
                  <Button type="submit" variant="primary" disabled={running}>
                    {running
                      ? t('management.totp.saving')
                      : t('management.totp.confirm')}
                  </Button>
                </>
              )}
            >
              <div className="account-form-fields">
                <Callout tone="warning">
                  {t('management.sessionRevocationWarning')}
                </Callout>
                <MfaEnrollmentPanel
                  enrollment={totpSetup}
                  totpCode={totpCode}
                  onTotpCodeChange={setTotpCode}
                  disabled={running}
                />
                {failure ? (
                  <Notice tone="error">{errorMessage(failure)}</Notice>
                ) : null}
              </div>
            </Panel>
          </form>
        ) : null}

        {completion ? (
          <Panel>
            <div className="account-complete" role="status" aria-live="polite">
              <p className="account-complete-mark" aria-hidden="true">✓</p>
              <h2 className="account-complete-title">
                {t('management.totp.completedTitle')}
              </h2>
              <p className="account-complete-detail">
                {t('management.totp.completedDescription')}
              </p>
              <p className="account-complete-detail">
                {t('management.completedSessions', {
                  count: completion.revokedSessions,
                })}
              </p>
              <div className="account-complete-action">
                <ButtonLink variant="primary" to={STUDIO_PATHS.accountSecurity}>
                  {t('management.return')}
                </ButtonLink>
              </div>
            </div>
          </Panel>
        ) : null}
      </div>
    </main>
  );
}

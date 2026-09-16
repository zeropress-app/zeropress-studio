import {
  browserSupportsWebAuthn,
  startAuthentication,
} from '@simplewebauthn/browser';
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import { Link } from 'react-router';
import type { ApiErrorCode } from '../../contracts/api';
import type {
  MfaManagementStatusResponse,
  MfaManagementVerification,
} from '../../contracts/mfa-management';
import {
  assessInstallPasswordPolicy,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../contracts/password-policy';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { InstallPasswordAssessment } from './components/InstallPasswordAssessment';
import {
  passwordBreachAllowsSubmission,
  usePasswordBreachCheck,
} from './hooks/usePasswordBreachCheck';
import {
  MfaManagementClientError,
  requestChangePassword,
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

type AccountSession = CurrentSessionSuccess['data'];
type ReadyStatus = Extract<
  MfaManagementStatusResponse,
  { success: true }
>['data'];
type VerificationMethod = MfaManagementVerification['method'] | 'webauthn';
type Failure =
  | {
    kind: 'validation';
    code: 'current_password' | 'new_password' | 'same_password' | 'verification' | 'webauthn';
  }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: MfaManagementClientErrorCode }
  | { kind: 'unexpected' };
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: ReadyStatus }
  | { kind: 'error'; failure: Failure };

function clientFailure(error: unknown): Failure {
  return error instanceof MfaManagementClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

export function PasswordChangePage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
  onSignedOut?: () => void;
}) {
  const { t } = useTranslation('security');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [verificationMethod, setVerificationMethod] =
    useState<VerificationMethod>('totp');
  const [verificationCode, setVerificationCode] = useState('');
  const [webAuthnSupported] = useState(() => browserSupportsWebAuthn());
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [completion, setCompletion] = useState<number | null>(null);
  const assessment = useMemo(() => assessInstallPasswordPolicy({
    password: newPassword,
    email: input.data.user.email,
    displayName: input.data.user.name,
  }), [input.data.user.email, input.data.user.name, newPassword]);
  const passwordBreach = usePasswordBreachCheck({
    password: newPassword,
    enabled: assessment.allowed && newPassword === confirmPassword,
  });

  useStudioDocumentTitle(t('password.documentTitle'));

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

  function message(value: Failure): string {
    if (value.kind === 'validation') {
      return t(`password.validation.${value.code}`);
    }
    if (value.kind === 'client') {
      if (value.code === 'TIMEOUT') return t('password.errors.timeout');
      if (value.code === 'NETWORK_ERROR') return t('password.errors.network');
      return t('password.errors.invalidResponse');
    }
    if (value.kind === 'unexpected') return t('password.errors.unexpected');
    if (value.code === 'INVALID_CURRENT_PASSWORD') {
      return t('password.errors.invalidCurrentPassword');
    }
    if (value.code === 'NEW_PASSWORD_MUST_DIFFER') {
      return t('password.errors.samePassword');
    }
    if (value.code === 'WEAK_USER_PASSWORD') {
      return t('password.errors.weakPassword');
    }
    if (
      value.code === 'INVALID_MFA_CODE'
      || value.code === 'WEBAUTHN_VERIFICATION_FAILED'
    ) {
      return t('password.errors.invalidMfa');
    }
    if (
      value.code === 'MFA_MANAGEMENT_CHALLENGE_INVALID'
      || value.code === 'MFA_STEP_UP_REQUIRED'
      || value.code === 'WEBAUTHN_CHALLENGE_INVALID'
    ) {
      return t('password.errors.expired');
    }
    if (value.code === 'RATE_LIMIT_EXCEEDED') {
      return t('password.errors.rateLimit');
    }
    return t('password.errors.api');
  }

  function apiFailure(code: ApiErrorCode): void {
    if (code === 'AUTHENTICATION_REQUIRED') {
      input.onSessionEnded();
      return;
    }
    setFailure({ kind: 'api', code });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running || loadState.kind !== 'ready') return;
    if (!currentPassword) {
      setFailure({ kind: 'validation', code: 'current_password' });
      return;
    }
    if (
      newPassword.length < PASSWORD_MIN_LENGTH
      || newPassword.length > PASSWORD_MAX_LENGTH
      || newPassword !== confirmPassword
      || !assessment.allowed
      || !passwordBreachAllowsSubmission(passwordBreach)
    ) {
      setFailure({ kind: 'validation', code: 'new_password' });
      return;
    }
    if (newPassword === currentPassword) {
      setFailure({ kind: 'validation', code: 'same_password' });
      return;
    }
    if (
      loadState.status.step_up.mfa_required
      && verificationMethod !== 'webauthn'
      && !/^[0-9]{6}$/u.test(verificationCode)
    ) {
      setFailure({ kind: 'validation', code: 'verification' });
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
          { operation: 'change_password', password: currentPassword },
        );
        if (!options.success) {
          apiFailure(options.error.code);
          return;
        }
        let assertion;
        try {
          assertion = await startAuthentication({
            optionsJSON: options.data.options,
          });
        } catch {
          setFailure({ kind: 'validation', code: 'webauthn' });
          return;
        }
        authorization = await requestMfaManagementWebAuthnStepUpVerification(
          input.data.csrf_token,
          {
            operation: 'change_password',
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
            operation: 'change_password',
            password: currentPassword,
            ...(verification ? { verification } : {}),
          },
        );
      }
      if (!authorization.success) {
        apiFailure(authorization.error.code);
        return;
      }
      const response = await requestChangePassword(
        input.data.csrf_token,
        {
          management_token: authorization.data.management_token,
          new_password: newPassword,
        },
      );
      if (!response.success) {
        apiFailure(response.error.code);
        return;
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setVerificationCode('');
      setCompletion(response.data.revoked_sessions);
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setRunning(false);
    }
  }

  const canUseWebAuthn = webAuthnSupported
    && loadState.kind === 'ready'
    && loadState.status.webauthn.credentials.some(
      (credential) =>
        credential.rp_id === loadState.status.webauthn.current_rp_id,
    );

  return (
    <main
      id="studio-main-content"
      aria-labelledby="password-change-title"
    >
      <Link className="account-back" to={STUDIO_PATHS.accountSecurity}>
        <span aria-hidden="true">←</span>
        {t('password.back')}
      </Link>
      <PageHeader
        titleId="password-change-title"
        kicker={t('password.kicker')}
        title={t('password.title')}
        description={t('password.description')}
      />

      <div className="account-stack">
        {loadState.kind === 'loading' ? (
          <Panel>
            <div className="account-state" role="status">
              <Spinner size="lg" />
              <div className="account-state-text">
                <strong className="account-state-title">
                  {t('password.loadingTitle')}
                </strong>
                <p className="account-state-detail">
                  {t('password.loadingDescription')}
                </p>
              </div>
            </div>
          </Panel>
        ) : null}

        {loadState.kind === 'error' ? (
          <Notice
            tone="error"
            title={t('password.loadErrorTitle')}
            actions={(
              <Button
                type="button"
                onClick={() => setLoadAttempt((value) => value + 1)}
              >
                {t('loadError.retry')}
              </Button>
            )}
          >
            {message(loadState.failure)}
          </Notice>
        ) : null}

        {loadState.kind === 'ready' && completion === null ? (
          <form onSubmit={(event) => void submit(event)}>
            <Panel
              title={t('password.formTitle')}
              description={t('password.formDescription')}
              footer={(
                <>
                  <ButtonLink
                    variant="ghost"
                    to={STUDIO_PATHS.accountSecurity}
                  >
                    {t('password.cancel')}
                  </ButtonLink>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={running || (
                      assessment.allowed
                      && !passwordBreachAllowsSubmission(passwordBreach)
                    )}
                  >
                    {running ? t('password.running') : t('password.confirm')}
                  </Button>
                </>
              )}
            >
              <div className="account-form-fields">
                <Field label={t('password.currentPassword')}>
                  {(control) => (
                    <input
                      {...control}
                      type="password"
                      autoComplete="current-password"
                      maxLength={1024}
                      value={currentPassword}
                      disabled={running}
                      required
                      onChange={(event) => setCurrentPassword(
                        event.target.value,
                      )}
                    />
                  )}
                </Field>
                <Field label={t('password.newPassword')}>
                  {(control) => (
                    <input
                      {...control}
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      minLength={PASSWORD_MIN_LENGTH}
                      maxLength={PASSWORD_MAX_LENGTH}
                      value={newPassword}
                      disabled={running}
                      required
                      onChange={(event) => setNewPassword(event.target.value)}
                    />
                  )}
                </Field>
                <Field label={t('password.confirmPassword')}>
                  {(control) => (
                    <input
                      {...control}
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      minLength={PASSWORD_MIN_LENGTH}
                      maxLength={PASSWORD_MAX_LENGTH}
                      value={confirmPassword}
                      disabled={running}
                      required
                      onChange={(event) => setConfirmPassword(
                        event.target.value,
                      )}
                    />
                  )}
                </Field>
                <label className="account-password-toggle">
                  <input
                    type="checkbox"
                    checked={showPassword}
                    disabled={running}
                    onChange={(event) => setShowPassword(event.target.checked)}
                  />
                  {t('password.showPassword')}
                </label>
                <InstallPasswordAssessment
                  password={newPassword}
                  confirmPassword={confirmPassword}
                  email={input.data.user.email}
                  displayName={input.data.user.name}
                  assessment={assessment}
                  breach={passwordBreach}
                />
                <StepUpVerification
                  name="password-mfa-method"
                  required={loadState.status.step_up.mfa_required}
                  method={verificationMethod}
                  onMethodChange={setVerificationMethod}
                  code={verificationCode}
                  onCodeChange={setVerificationCode}
                  webAuthnAvailable={canUseWebAuthn}
                  disabled={running}
                  copy={{
                    legend: t('password.mfaLegend'),
                    notRequired: t('password.recentMfa'),
                    webauthn: t('management.authorize.webauthn'),
                    webauthnPrompt: t('management.authorize.webauthnPrompt'),
                    totp: t('management.authorize.totp'),
                    totpCode: t('management.authorize.totpCode'),
                  }}
                />
                <Callout tone="warning">
                  {t('password.signOutWarning')}
                </Callout>
                {failure ? (
                  <Notice tone="error">{message(failure)}</Notice>
                ) : null}
              </div>
            </Panel>
          </form>
        ) : null}

        {completion !== null ? (
          <Panel>
            <div className="account-complete" role="status" aria-live="polite">
              <p className="account-complete-mark" aria-hidden="true">✓</p>
              <h2 className="account-complete-title">
                {t('password.completedTitle')}
              </h2>
              <p className="account-complete-detail">
                {t('password.completedDescription', { count: completion })}
              </p>
              <div className="account-complete-action">
                <Button
                  type="button"
                  variant="primary"
                  onClick={input.onSignedOut ?? input.onSessionEnded}
                >
                  {t('password.signIn')}
                </Button>
              </div>
            </div>
          </Panel>
        ) : null}
      </div>
    </main>
  );
}

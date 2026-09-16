import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Clock3,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import type { ApiErrorCode } from '../../contracts/api';
import type { MfaEnrollmentSetupData } from '../../contracts/mfa';
import {
  assessInstallPasswordPolicy,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../contracts/password-policy';
import type { InspectUserSetupResponse } from '../../contracts/users';
import { InstallPasswordAssessment } from './components/InstallPasswordAssessment';
import {
  passwordBreachAllowsSubmission,
  usePasswordBreachCheck,
} from './hooks/usePasswordBreachCheck';
import { MfaEnrollmentPanel } from './components/MfaEnrollmentPanel';
import { NewPasswordFields } from './components/NewPasswordFields';
import {
  UserActivationShell,
  type UserActivationStep,
} from './components/UserActivationShell';
import {
  InitialCheckingPlaceholder,
  useInitialCheckingPhase,
} from './components/InitialCheckingGate';
import { StandaloneStatusScreen } from './components/StandaloneStatusScreen';
import {
  requestCompleteUserSetup,
  requestInspectUserSetup,
  requestPrepareUserSetup,
  UsersClientError,
  type UsersClientErrorCode,
} from './lib/users-client';
import {
  Button,
  ButtonLink,
  Notice,
  Spinner,
  StudioIcon,
} from './components/primitives';

type SetupIdentity = Extract<
  InspectUserSetupResponse,
  { success: true }
>['data'];

type ActivationState =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'password'; identity: SetupIdentity }
  | {
    kind: 'mfa';
    identity: SetupIdentity;
    enrollment: MfaEnrollmentSetupData;
  }
  | { kind: 'complete'; purpose: SetupIdentity['purpose'] };

type Failure =
  | { kind: 'validation'; code: 'passwordLength' | 'passwordMismatch' | 'weakPassword' | 'totp' }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: UsersClientErrorCode };

export function UserActivationCheckingScreen() {
  const { t } = useTranslation('users');

  return (
    <StandaloneStatusScreen
      regionLabel={t('activation.regionLabel')}
      brandLabel={t('activation.brandLabel')}
      kicker={t('activation.kicker')}
      title={t('activation.loading')}
      tone="info"
      pending
      leading={<Spinner size="lg" />}
    />
  );
}

export function UserActivationPage(input: { setupToken: string }) {
  const { t, i18n } = useTranslation('users');
  const setupToken = input.setupToken;
  const [state, setState] = useState<ActivationState>({ kind: 'loading' });
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const stageTitleRef = useRef<HTMLHeadingElement>(null);
  const previousStageRef = useRef<UserActivationStep>('password');
  const checkingPhase = useInitialCheckingPhase(state.kind === 'loading');
  const identity = state.kind === 'password' || state.kind === 'mfa'
    ? state.identity
    : null;
  const isRecovery = identity?.purpose === 'credential_recovery'
    || (state.kind === 'complete'
      && state.purpose === 'credential_recovery');
  const passwordAssessment = useMemo(() => assessInstallPasswordPolicy({
    password,
    email: identity?.email ?? '',
    displayName: identity?.name ?? '',
  }), [identity?.email, identity?.name, password]);
  const passwordBreach = usePasswordBreachCheck({
    password,
    enabled: passwordAssessment.allowed && password === confirmPassword,
  });
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    { dateStyle: 'medium', timeStyle: 'short' },
  ), [i18n.resolvedLanguage]);
  const activationStep: UserActivationStep = state.kind === 'mfa'
    ? 'mfa'
    : 'password';

  useEffect(() => {
    document.title = t(isRecovery
      ? 'activation.recoveryDocumentTitle'
      : 'activation.documentTitle');
  }, [i18n.resolvedLanguage, isRecovery, t]);

  useEffect(() => {
    if (
      (state.kind === 'password' || state.kind === 'mfa')
      && previousStageRef.current !== activationStep
    ) {
      stageTitleRef.current?.focus();
      previousStageRef.current = activationStep;
    }
  }, [activationStep, state.kind]);

  useEffect(() => {
    if (!setupToken) {
      setState({ kind: 'invalid' });
      return;
    }
    const controller = new AbortController();
    let active = true;
    void requestInspectUserSetup(
      { setup_token: setupToken },
      controller.signal,
    ).then((response) => {
      if (!active) return;
      setState(response.success
        ? { kind: 'password', identity: response.data }
        : { kind: 'invalid' });
    }).catch(() => {
      if (active) setState({ kind: 'invalid' });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [setupToken]);

  function failureMessage(value: Failure): string {
    if (value.kind === 'validation') {
      return t(`activation.validation.${value.code}`);
    }
    if (value.kind === 'client') {
      if (value.code === 'TIMEOUT') return t('activation.errors.timeout');
      if (value.code === 'NETWORK_ERROR') {
        return t('activation.errors.network');
      }
      return t('activation.errors.invalidResponse');
    }
    if (value.code === 'USER_SETUP_TOKEN_INVALID') {
      return t('activation.errors.invalid');
    }
    if (
      value.code === 'INVALID_MFA_CODE'
      || value.code === 'MFA_ENROLLMENT_INVALID'
    ) {
      return t('activation.errors.mfa');
    }
    if (value.code === 'RATE_LIMIT_EXCEEDED') {
      return t('activation.errors.rateLimit');
    }
    return t('activation.errors.api');
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running || state.kind !== 'password') return;
    if (
      password.length < PASSWORD_MIN_LENGTH
      || password.length > PASSWORD_MAX_LENGTH
    ) {
      setFailure({ kind: 'validation', code: 'passwordLength' });
      return;
    }
    if (password !== confirmPassword) {
      setFailure({ kind: 'validation', code: 'passwordMismatch' });
      return;
    }
    if (
      !passwordAssessment.allowed
      || !passwordBreachAllowsSubmission(passwordBreach)
    ) {
      setFailure({ kind: 'validation', code: 'weakPassword' });
      return;
    }
    setRunning(true);
    setFailure(null);
    try {
      const response = await requestPrepareUserSetup({
        setup_token: setupToken,
        password,
      });
      if (!response.success) {
        setFailure({ kind: 'api', code: response.error.code });
        if (response.error.code === 'USER_SETUP_TOKEN_INVALID') {
          setState({ kind: 'invalid' });
        }
        return;
      }
      setPassword('');
      setConfirmPassword('');
      setState({
        kind: 'mfa',
        identity: state.identity,
        enrollment: response.data,
      });
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof UsersClientError
          ? error.code
          : 'INVALID_RESPONSE',
      });
    } finally {
      setRunning(false);
    }
  }

  async function completeActivation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (running || state.kind !== 'mfa') return;
    if (!/^[0-9]{6}$/u.test(totpCode)) {
      setFailure({ kind: 'validation', code: 'totp' });
      return;
    }
    setRunning(true);
    setFailure(null);
    try {
      const response = await requestCompleteUserSetup({
        mfa: {
          enrollment_token: state.enrollment.enrollment_token,
          totp_code: totpCode,
        },
      });
      if (!response.success) {
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setState({ kind: 'complete', purpose: state.identity.purpose });
    } catch (error) {
      setFailure({
        kind: 'client',
        code: error instanceof UsersClientError
          ? error.code
          : 'INVALID_RESPONSE',
      });
    } finally {
      setRunning(false);
    }
  }

  const errorMessage = failure ? failureMessage(failure) : null;

  if (state.kind === 'loading') {
    return checkingPhase === 'hidden'
      ? <InitialCheckingPlaceholder label={t('activation.loading')} />
      : <UserActivationCheckingScreen />;
  }

  if (checkingPhase === 'checking') {
    return <UserActivationCheckingScreen />;
  }

  if (state.kind === 'invalid') {
    return (
      <StandaloneStatusScreen
        regionLabel={t('activation.regionLabel')}
        brandLabel={t('activation.brandLabel')}
        kicker={t('activation.kicker')}
        title={t('activation.invalidTitle')}
        description={t('activation.invalidDescription')}
        tone="error"
      />
    );
  }

  if (state.kind === 'complete') {
    const recovery = state.purpose === 'credential_recovery';
    return (
      <StandaloneStatusScreen
        regionLabel={t(recovery
          ? 'activation.recoveryRegionLabel'
          : 'activation.regionLabel')}
        brandLabel={t('activation.brandLabel')}
        kicker={t(recovery
          ? 'activation.recoverySuccessKicker'
          : 'activation.successKicker')}
        title={t(recovery
          ? 'activation.recoverySuccessTitle'
          : 'activation.successTitle')}
        description={t(recovery
          ? 'activation.recoverySuccessDescription'
          : 'activation.successDescription')}
        tone="info"
      >
        <div className="standalone-status-actions">
          <ButtonLink variant="primary" size="lg" to="/">
            {t('activation.signIn')}
          </ButtonLink>
        </div>
      </StandaloneStatusScreen>
    );
  }

  const recovery = state.identity.purpose === 'credential_recovery';
  const headings = {
    password: {
      kicker: t('activation.kicker'),
      title: t(recovery
        ? 'activation.recoveryTitle'
        : 'activation.title'),
      description: t(recovery
        ? 'activation.recoveryDescription'
        : 'activation.description'),
    },
    mfa: {
      kicker: t('activation.kicker'),
      title: t('activation.mfaTitle'),
      description: t('activation.mfaDescription'),
    },
  };

  return (
    <UserActivationShell
      regionLabel={t(recovery
        ? 'activation.recoveryRegionLabel'
        : 'activation.regionLabel')}
      current={activationStep}
      headings={headings}
      titleRef={stageTitleRef}
    >
      <div className="setup-activation-stage">
        <section
          className="setup-activation-identity"
          aria-label={t('activation.identityLabel')}
        >
          <div className="setup-activation-person">
            <span className="setup-activation-person-icon" aria-hidden="true">
              <StudioIcon icon={UserRound} />
            </span>
            <span className="setup-activation-person-copy">
              <strong className="setup-activation-person-name">
                {state.identity.name}
              </strong>
              <span className="setup-activation-person-detail">
                {t('activation.identityDetail', {
                  email: state.identity.email,
                  role: t(`roles.${state.identity.role}`),
                })}
              </span>
            </span>
          </div>
          <p className="setup-activation-expiry">
            <StudioIcon icon={Clock3} />
            <time dateTime={state.identity.expires_at_iso}>
              {t('activation.expires', {
                date: dateFormatter.format(
                  new Date(state.identity.expires_at_iso),
                ),
              })}
            </time>
          </p>
        </section>

        {state.kind === 'password' ? (
          <form
            className="setup-activation-form"
            onSubmit={submitPassword}
            noValidate
          >
            <div className="setup-form-section">
              <div className="setup-field-grid">
                <NewPasswordFields
                  password={password}
                  confirmPassword={confirmPassword}
                  revealed={showPassword}
                  disabled={running}
                  passwordInvalid={password.length > 0
                    && !passwordAssessment.allowed}
                  confirmationInvalid={confirmPassword.length > 0
                    && confirmPassword !== password}
                  labels={{
                    password: t('activation.password'),
                    confirmPassword: t('activation.confirmPassword'),
                    passwordPlaceholder: t(
                      'activation.passwordPlaceholder',
                    ),
                    confirmPasswordPlaceholder: t(
                      'activation.confirmPasswordPlaceholder',
                    ),
                    showPassword: t('activation.showPassword'),
                    hidePassword: t('activation.hidePassword'),
                  }}
                  onPasswordChange={setPassword}
                  onConfirmPasswordChange={setConfirmPassword}
                  onRevealedChange={setShowPassword}
                />
              </div>
              <InstallPasswordAssessment
                password={password}
                confirmPassword={confirmPassword}
                email={state.identity.email}
                displayName={state.identity.name}
                assessment={passwordAssessment}
                breach={passwordBreach}
              />
            </div>
            {errorMessage ? (
              <Notice tone="error">{errorMessage}</Notice>
            ) : null}
            <div className="setup-actions setup-activation-actions">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={running
                  || password.length === 0
                  || confirmPassword.length === 0
                  || password !== confirmPassword
                  || !passwordAssessment.allowed
                  || !passwordBreachAllowsSubmission(passwordBreach)}
              >
                {running ? <Spinner /> : null}
                {running
                  ? t('activation.preparing')
                  : t('activation.continue')}
                {!running ? (
                  <StudioIcon className="auth-button-icon" icon={ArrowRight} />
                ) : null}
              </Button>
            </div>
          </form>
        ) : (
          <form
            className="setup-activation-form"
            onSubmit={completeActivation}
            noValidate
          >
            <MfaEnrollmentPanel
              enrollment={state.enrollment}
              totpCode={totpCode}
              disabled={running}
              onTotpCodeChange={setTotpCode}
            />
            {errorMessage ? (
              <Notice tone="error">{errorMessage}</Notice>
            ) : null}
            <div className="setup-actions setup-activation-actions">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={running || totpCode.length !== 6}
              >
                {running ? <Spinner /> : null}
                {running
                  ? t(recovery
                    ? 'activation.recoveryCompleting'
                    : 'activation.completing')
                  : t(recovery
                    ? 'activation.recoveryComplete'
                    : 'activation.complete')}
                {!running ? (
                  <StudioIcon
                    className="auth-button-icon"
                    icon={ShieldCheck}
                  />
                ) : null}
              </Button>
            </div>
          </form>
        )}
      </div>
    </UserActivationShell>
  );
}

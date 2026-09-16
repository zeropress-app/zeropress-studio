import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Mail,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import licenseText from '../../LICENSE?raw';
import type { ApiErrorCode } from '../../contracts/api';
import {
  installRequestSchema,
  type InstallRequest,
  type InstallSuccess,
} from '../../contracts/install';
import type { MfaEnrollmentSetupData } from '../../contracts/mfa';
import {
  assessInstallPasswordPolicy,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../contracts/password-policy';
import { InstallShell } from './components/InstallShell';
import { InstallPasswordAssessment } from './components/InstallPasswordAssessment';
import { MfaEnrollmentPanel } from './components/MfaEnrollmentPanel';
import { NewPasswordFields } from './components/NewPasswordFields';
import {
  InstallClientError,
  requestInstall,
  requestInstallMfaSetup,
  type InstallClientErrorCode,
} from './lib/install-client';
import {
  Button,
  Field,
  Notice,
  Spinner,
  StudioIcon,
} from './components/primitives';
import { getCurrentLocale } from './i18n';
import {
  passwordBreachAllowsSubmission,
  usePasswordBreachCheck,
} from './hooks/usePasswordBreachCheck';

type LocalValidationCode =
  | 'required'
  | 'name'
  | 'email'
  | 'passwordLength'
  | 'passwordMismatch'
  | 'weakPassword'
  | 'mfaCode';

type InstallAdministrator = Omit<
  InstallRequest,
  'interface_locale' | 'mfa'
>;
const installAdministratorSchema = installRequestSchema.omit({
  interface_locale: true,
  mfa: true,
});

type InstallResult =
  | { kind: 'validation'; code: LocalValidationCode }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: InstallClientErrorCode }
  | { kind: 'unexpected' };

type InstallStage = 'license' | 'account' | 'mfa';

function validateInstallInput(input: {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
}): { ok: true; data: InstallAdministrator } | {
  ok: false;
  code: LocalValidationCode;
} {
  if (
    input.name.length === 0
    || input.email.length === 0
    || input.password.length === 0
    || input.confirmPassword.length === 0
  ) {
    return { ok: false, code: 'required' };
  }
  if (input.name.trim().length < 2 || input.name.trim().length > 100) {
    return { ok: false, code: 'name' };
  }
  if (!installRequestSchema.shape.admin_email.safeParse(input.email).success) {
    return { ok: false, code: 'email' };
  }
  if (
    input.password.length < PASSWORD_MIN_LENGTH
    || input.password.length > PASSWORD_MAX_LENGTH
  ) {
    return { ok: false, code: 'passwordLength' };
  }
  if (input.password !== input.confirmPassword) {
    return { ok: false, code: 'passwordMismatch' };
  }
  if (!assessInstallPasswordPolicy({
    password: input.password,
    email: input.email,
    displayName: input.name,
  }).allowed) {
    return { ok: false, code: 'weakPassword' };
  }

  const parsed = installAdministratorSchema.safeParse({
    admin_name: input.name,
    admin_email: input.email,
    admin_password: input.password,
  });
  if (!parsed.success) {
    return { ok: false, code: 'required' };
  }
  return { ok: true, data: parsed.data };
}

export function InstallPage({
  token,
  onAuthorizationExpired,
  onInstallationChanged,
}: {
  token: string;
  onAuthorizationExpired: () => void;
  onInstallationChanged: (
    edgeDatabase?: InstallSuccess['data']['edge_database'],
  ) => void;
}) {
  const { t, i18n } = useTranslation('install');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [stage, setStage] = useState<InstallStage>('license');
  const [pendingAdministrator, setPendingAdministrator] =
    useState<InstallAdministrator | null>(null);
  const [mfaEnrollment, setMfaEnrollment] =
    useState<MfaEnrollmentSetupData | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const stageTitleRef = useRef<HTMLHeadingElement>(null);
  const previousStageRef = useRef<InstallStage>(stage);
  const passwordAssessment = useMemo(
    () => assessInstallPasswordPolicy({
      password,
      email,
      displayName: name,
    }),
    [email, name, password],
  );
  const passwordBreach = usePasswordBreachCheck({
    password,
    enabled: passwordAssessment.allowed && password === confirmPassword,
  });

  useEffect(() => {
    document.title = t('documentTitle');
  }, [i18n.resolvedLanguage, t]);

  useEffect(() => {
    if (previousStageRef.current !== stage) {
      stageTitleRef.current?.focus();
      previousStageRef.current = stage;
    }
  }, [stage]);

  function resultMessage(): string | null {
    if (!result) return null;
    if (result.kind === 'validation') {
      return t(`validation.${result.code}`);
    }
    if (result.kind === 'client') {
      if (result.code === 'INVALID_TOKEN_FORMAT') {
        return t('validation.token');
      }
      if (result.code === 'TIMEOUT') return t('errors.timeout');
      if (result.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (result.kind === 'unexpected') {
      return t('errors.unknown');
    }

    if (result.code === 'INVALID_INSTALL_TOKEN') {
      return t('errors.invalidToken');
    }
    if (result.code === 'RATE_LIMIT_EXCEEDED') {
      return t('errors.rateLimit');
    }
    if (result.code === 'VALIDATION_ERROR') {
      return t('errors.validation');
    }
    if (result.code === 'WEAK_ADMIN_PASSWORD') {
      return t('errors.weakPassword');
    }
    if (
      result.code === 'INSTALLATION_NOT_AVAILABLE'
      || result.code === 'INSTALLATION_ALREADY_COMPLETED'
      || result.code === 'SITE_ACTIVATION_REQUIRED'
      || result.code === 'SITE_MAINTENANCE'
      || result.code === 'SITE_RECOVERY'
    ) {
      return t('errors.unavailable');
    }
    if (
      result.code === 'INVALID_MFA_CODE'
      || result.code === 'MFA_ENROLLMENT_INVALID'
    ) {
      return t('errors.mfa');
    }
    return t('errors.unknown');
  }

  async function handleAccountSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    setResult(null);
    const validated = validateInstallInput({
      name,
      email,
      password,
      confirmPassword,
    });
    if (!validated.ok) {
      setResult({ kind: 'validation', code: validated.code });
      return;
    }
    if (!passwordBreachAllowsSubmission(passwordBreach)) {
      setResult({ kind: 'validation', code: 'weakPassword' });
      return;
    }

    setSubmitting(true);
    try {
      const response = await requestInstallMfaSetup({
        token,
        adminEmail: validated.data.admin_email,
      });
      if (!response.success) {
        if (response.error.code === 'INVALID_INSTALL_TOKEN') {
          onAuthorizationExpired();
          return;
        }
        if (response.error.code === 'INSTALLATION_ALREADY_COMPLETED') {
          onInstallationChanged();
          return;
        }
        setResult({ kind: 'api', code: response.error.code });
        return;
      }
      setPendingAdministrator(validated.data);
      setMfaEnrollment(response.data);
      setTotpCode('');
      setStage('mfa');
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

  async function handleInstallSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !pendingAdministrator || !mfaEnrollment) return;
    if (!/^[0-9]{6}$/u.test(totpCode)) {
      setResult({ kind: 'validation', code: 'mfaCode' });
      return;
    }
    const request = installRequestSchema.safeParse({
      ...pendingAdministrator,
      interface_locale: getCurrentLocale(),
      mfa: {
        enrollment_token: mfaEnrollment.enrollment_token,
        totp_code: totpCode,
      },
    });
    if (!request.success) {
      setResult({ kind: 'validation', code: 'required' });
      return;
    }

    setSubmitting(true);
    setResult(null);
    try {
      const response = await requestInstall({
        token,
        administrator: request.data,
      });
      if (response.success) {
        onInstallationChanged(response.data.edge_database);
        return;
      }
      if (response.error.code === 'INSTALLATION_ALREADY_COMPLETED') {
        onInstallationChanged();
        return;
      }
      if (response.error.code === 'INVALID_INSTALL_TOKEN') {
        onAuthorizationExpired();
        return;
      }
      setResult({ kind: 'api', code: response.error.code });
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
  const progressState = stage === 'license'
    ? 'license'
    : stage === 'account'
      ? 'information'
      : 'mfa';
  const stagePresentations = {
    license: {
      kicker: t('stages.license.eyebrow'),
      title: t('stages.license.title'),
      description: t('stages.license.description'),
    },
    information: {
      kicker: t('stages.account.eyebrow'),
      title: t('stages.account.title'),
      description: t('stages.account.description'),
    },
    mfa: {
      kicker: t('stages.mfa.eyebrow'),
      title: t('stages.mfa.title'),
      description: t('stages.mfa.description'),
    },
  };

  return (
    <InstallShell
      current={progressState}
      regionLabel={t('regionLabel')}
      headings={stagePresentations}
      titleRef={stageTitleRef}
    >
      {stage === 'license' ? (
        <div className="setup-license setup-install-stage">
          <section
            className="setup-license-card"
            aria-labelledby="setup-license-title"
          >
            <header className="setup-license-heading">
              <h2 id="setup-license-title">{t('license.title')}</h2>
              <p>{t('license.summary')}</p>
            </header>
            <pre
              className="setup-license-text"
              aria-label={t('license.textLabel')}
              tabIndex={0}
            >
              {licenseText}
            </pre>
            <a
              className="setup-license-source"
              href="https://github.com/zeropress-app/zeropress-studio/blob/main/LICENSE"
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('license.sourceLinkLabel')}
            >
              <span>{t('license.sourceLink')}</span>
              <StudioIcon icon={ExternalLink} />
            </a>
          </section>
          <div className="setup-actions">
            <Button
              type="button"
              variant="primary"
              size="lg"
              onClick={() => setStage('account')}
            >
              {t('license.continue')}
              <StudioIcon className="auth-button-icon" icon={ArrowRight} />
            </Button>
          </div>
        </div>
      ) : stage === 'account' ? (
          <form
            className="setup-form setup-form-account setup-install-stage"
            onSubmit={handleAccountSubmit}
            noValidate
          >
            <div className="setup-form-section">
              <div className="setup-field-grid">
                <Field label={t('fields.name.label')}>
                  {(control) => (
                    <div className="auth-input">
                      <StudioIcon icon={UserRound} />
                      <input
                        {...control}
                        type="text"
                        autoComplete="name"
                        minLength={2}
                        maxLength={100}
                        required
                        value={name}
                        placeholder={t('fields.name.placeholder')}
                        disabled={submitting}
                        onChange={(event) => setName(event.target.value)}
                      />
                    </div>
                  )}
                </Field>

                <Field label={t('fields.email.label')}>
                  {(control) => (
                    <div className="auth-input">
                      <StudioIcon icon={Mail} />
                      <input
                        {...control}
                        type="email"
                        inputMode="email"
                        autoComplete="username"
                        maxLength={254}
                        required
                        value={email}
                        placeholder={t('fields.email.placeholder')}
                        disabled={submitting}
                        onChange={(event) => setEmail(event.target.value)}
                      />
                    </div>
                  )}
                </Field>

                <NewPasswordFields
                  password={password}
                  confirmPassword={confirmPassword}
                  revealed={showPassword}
                  disabled={submitting}
                  passwordInvalid={password.length > 0
                    && !passwordAssessment.allowed}
                  confirmationInvalid={confirmPassword.length > 0
                    && confirmPassword !== password}
                  labels={{
                    password: t('fields.password.label'),
                    confirmPassword: t('fields.confirmPassword.label'),
                    passwordPlaceholder: t('fields.password.placeholder'),
                    confirmPasswordPlaceholder: t(
                      'fields.confirmPassword.placeholder',
                    ),
                    showPassword: t('fields.password.show'),
                    hidePassword: t('fields.password.hide'),
                  }}
                  onPasswordChange={setPassword}
                  onConfirmPasswordChange={setConfirmPassword}
                  onRevealedChange={setShowPassword}
                />
              </div>

              <InstallPasswordAssessment
                password={password}
                confirmPassword={confirmPassword}
                email={email}
                displayName={name}
                assessment={passwordAssessment}
                breach={passwordBreach}
              />
            </div>

            {message ? (
              <Notice tone="error">{message}</Notice>
            ) : null}

            <div className="setup-actions">
              <Button
                type="button"
                size="lg"
                disabled={submitting}
                onClick={() => {
                  setResult(null);
                  setStage('license');
                }}
              >
                <StudioIcon className="auth-button-icon" icon={ArrowLeft} />
                {t('backToLicense')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={submitting || (
                  passwordAssessment.allowed
                  && !passwordBreachAllowsSubmission(passwordBreach)
                )}
              >
                {submitting ? <Spinner /> : null}
                {submitting ? t('mfaPreparing') : t('continueToMfa')}
                {!submitting ? (
                  <StudioIcon
                    className="auth-button-icon"
                    icon={ArrowRight}
                  />
                ) : null}
              </Button>
            </div>
          </form>
      ) : mfaEnrollment && pendingAdministrator ? (
          <form
            className="setup-form setup-form-single setup-install-stage"
            onSubmit={handleInstallSubmit}
            noValidate
          >
            <MfaEnrollmentPanel
              enrollment={mfaEnrollment}
              totpCode={totpCode}
              account={{
                label: t('mfaAccount'),
                value: pendingAdministrator.admin_email,
              }}
              disabled={submitting}
              onTotpCodeChange={setTotpCode}
            />

            {message ? <Notice tone="error">{message}</Notice> : null}

            <div className="setup-actions">
              <Button
                type="button"
                size="lg"
                disabled={submitting}
                onClick={() => {
                  setStage('account');
                  setPendingAdministrator(null);
                  setMfaEnrollment(null);
                  setTotpCode('');
                  setResult(null);
                }}
              >
                <StudioIcon className="auth-button-icon" icon={ArrowLeft} />
                {t('backToAdministrator')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="lg"
                disabled={submitting
                  || totpCode.length !== 6}
              >
                {submitting ? <Spinner /> : null}
                {!submitting ? (
                  <StudioIcon
                    className="auth-button-icon"
                    icon={ShieldCheck}
                  />
                ) : null}
                {submitting ? t('submitting') : t('submit')}
              </Button>
            </div>
          </form>
      ) : null}
    </InstallShell>
  );
}

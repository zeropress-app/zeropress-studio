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
import type { TFunction } from 'i18next';
import {
  ArrowRight,
  Check,
  ChevronLeft,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Mail,
  Smartphone,
} from 'lucide-react';
import type { ApiErrorCode } from '../../contracts/api';
import type { LoginMfaMethod } from '../../contracts/auth';
import type { MfaEnrollmentSetupData } from '../../contracts/mfa';
import { MfaEnrollmentPanel } from './components/MfaEnrollmentPanel';
import { LocaleSwitcher } from './components/LocaleSwitcher';
import { LogoBadge } from './components/LogoBadge';
import { ThemeToggle } from './components/ThemeToggle';
import {
  LoginClientError,
  requestLogin,
  requestMfaEnrollmentComplete,
  requestMfaEnrollmentSetup,
  requestMfaVerification,
  requestPasskeySignInOptions,
  requestPasskeySignInVerification,
  requestWebAuthnLoginOptions,
  requestWebAuthnLoginVerification,
  type LoginClientErrorCode,
} from './lib/auth-client';
import {
  Button,
  Callout,
  Field,
  Notice,
  Spinner,
  StudioIcon,
} from './components/primitives';

type LoginStage = 'credentials' | 'verification' | 'enrollment';
type ResultState =
  | {
    kind: 'validation';
    field: 'totp' | 'webauthn';
  }
  | { kind: 'api_error'; code: ApiErrorCode }
  | { kind: 'client_error'; code: LoginClientErrorCode }
  | { kind: 'unexpected_error' };

const LOGIN_METHODS = [
  {
    value: 'webauthn',
    labelKey: 'mfa.methods.webauthn',
    icon: KeyRound,
  },
  {
    value: 'totp',
    labelKey: 'mfa.methods.totp',
    icon: Smartphone,
  },
] as const;

type ResultPresentation = {
  tone: 'error' | 'neutral';
  title: string;
  message: string;
};

function getApiErrorMessage(
  code: ApiErrorCode,
  t: TFunction<'auth'>,
): string {
  switch (code) {
    case 'INVALID_CREDENTIALS':
      return t('errors.api.invalidCredentials');
    case 'ACCOUNT_NOT_ACTIVE':
      return t('errors.api.accountNotActive');
    case 'ACCOUNT_LOCKED':
      return t('errors.api.accountLocked');
    case 'MFA_CHALLENGE_INVALID':
      return t('errors.api.expiredChallenge');
    case 'MFA_ENROLLMENT_INVALID':
      return t('errors.api.invalidEnrollment');
    case 'MFA_ALREADY_CONFIGURED':
      return t('errors.api.alreadyConfigured');
    case 'INVALID_MFA_CODE':
      return t('errors.api.invalidMfa');
    case 'WEBAUTHN_VERIFICATION_FAILED':
      return t('errors.api.invalidWebAuthn');
    case 'PASSKEY_SIGN_IN_FAILED':
      return t('errors.api.passkeySignInFailed');
    case 'WEBAUTHN_CHALLENGE_INVALID':
      return t('errors.api.expiredChallenge');
    case 'WEBAUTHN_NOT_CONFIGURED':
      return t('errors.api.webauthnNotConfigured');
    case 'MFA_NOT_CONFIGURED':
    case 'INVALID_CURRENT_PASSWORD':
    case 'MFA_STEP_UP_REQUIRED':
    case 'MFA_MANAGEMENT_CHALLENGE_INVALID':
    case 'WEBAUTHN_CREDENTIAL_LIMIT_REACHED':
    case 'WEBAUTHN_CREDENTIAL_NAME_CONFLICT':
    case 'WEBAUTHN_CREDENTIAL_ALREADY_REGISTERED':
    case 'WEBAUTHN_CREDENTIAL_NOT_FOUND':
      return t('errors.api.systemNotAvailable');
    case 'AUTHENTICATION_REQUIRED':
    case 'CSRF_VALIDATION_FAILED':
    case 'EDGE_INTEGRATION_DISABLED':
    case 'EDGE_INTEGRATION_UNAVAILABLE':
    case 'EDGE_RECONCILIATION_REQUIRED':
    case 'EDGE_TARGET_PROJECTION_PENDING':
    case 'EDGE_DATABASE_INSTALL_REQUIRED':
    case 'EDGE_DATABASE_ADOPTION_REQUIRED':
    case 'EDGE_DATABASE_UPGRADE_REQUIRED':
    case 'EDGE_DATABASE_RECOVERY_REQUIRED':
    case 'EDGE_DATABASE_STUDIO_NOT_READY':
    case 'EDGE_DATABASE_INSTALL_NOT_AVAILABLE':
    case 'EDGE_DATABASE_ADOPTION_NOT_AVAILABLE':
    case 'EDGE_DATABASE_UPGRADE_NOT_AVAILABLE':
    case 'EDGE_DATABASE_UNINSTALL_NOT_AVAILABLE':
    case 'EDGE_INTEGRATION_MUST_BE_DISABLED':
    case 'EDGE_DATABASE_STATE_CONFLICT':
    case 'EDGE_TARGET_RECONCILIATION_NOT_AVAILABLE':
    case 'EDGE_TARGET_RECONCILIATION_STATE_CONFLICT':
    case 'CONTENT_SEARCH_QUERY_INVALID':
    case 'CONTENT_SEARCH_INDEX_NOT_READY':
    case 'CONTENT_SEARCH_INDEX_UNAVAILABLE':
    case 'CONTENT_SEARCH_INDEX_REBUILD_NOT_AVAILABLE':
    case 'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT':
    case 'AI_SERVICE_UNAVAILABLE':
    case 'AI_EXCERPT_SOURCE_EMPTY':
    case 'AI_EXCERPT_RESPONSE_INVALID':
    case 'AI_POST_DRAFT_SOURCE_EMPTY':
    case 'AI_POST_DRAFT_RESPONSE_INVALID':
    case 'AI_POST_EDIT_SELECTION_EMPTY':
    case 'AI_POST_EDIT_SELECTION_UNSUPPORTED':
    case 'AI_POST_EDIT_UNAVAILABLE':
    case 'AI_POST_EDIT_RESPONSE_INVALID':
    case 'AI_PAGE_DRAFT_SOURCE_EMPTY':
    case 'AI_PAGE_DRAFT_RESPONSE_INVALID':
    case 'AI_IMAGE_RESPONSE_INVALID':
    case 'AI_IMAGE_CONTENT_REJECTED':
    case 'AI_REQUEST_RATE_LIMITED':
    case 'CLOUDFLARE_ACCESS_REQUIRED':
    case 'CLOUDFLARE_ACCESS_NOT_DETECTED':
    case 'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE':
    case 'CLOUDFLARE_ACCESS_RECOVERY_NOT_AVAILABLE':
      return t('errors.api.systemNotAvailable');
    case 'RATE_LIMIT_EXCEEDED':
      return t('errors.api.rateLimitExceeded');
    case 'VALIDATION_ERROR':
      return t('errors.api.validationError');
    case 'INVALID_JSON':
      return t('errors.api.invalidJson');
    case 'UNSUPPORTED_MEDIA_TYPE':
      return t('errors.api.unsupportedMediaType');
    case 'PAYLOAD_TOO_LARGE':
      return t('errors.api.payloadTooLarge');
    case 'SYSTEM_CONFIGURATION_ERROR':
      return t('errors.api.systemConfigurationError');
    case 'INSTALLATION_REQUIRED':
      return t('errors.api.installationRequired');
    case 'INSTALLATION_NOT_AVAILABLE':
      return t('errors.api.installationNotAvailable');
    case 'INSTALLATION_ALREADY_COMPLETED':
      return t('errors.api.installationAlreadyCompleted');
    case 'INVALID_INSTALL_TOKEN':
      return t('errors.api.invalidInstallToken');
    case 'WEAK_ADMIN_PASSWORD':
      return t('errors.api.weakAdminPassword');
    case 'FORBIDDEN':
    case 'USER_EMAIL_CONFLICT':
    case 'USER_NOT_FOUND':
    case 'USER_SETUP_TOKEN_INVALID':
    case 'USER_SETUP_REQUIRED':
    case 'USER_STATE_CONFLICT':
    case 'USER_INVITATION_NOT_CANCELLABLE':
    case 'USER_ACCOUNT_DELETE_REQUIRES_INACTIVE':
    case 'CURRENT_USER_DELETE_FORBIDDEN':
    case 'LAST_ACTIVE_ADMIN_REQUIRED':
    case 'AUTHOR_ID_CONFLICT':
    case 'AUTHOR_USER_CONFLICT':
    case 'AUTHOR_NOT_FOUND':
    case 'AUTHOR_REVISION_CONFLICT':
    case 'MEDIA_SOURCE_CONFLICT':
    case 'MEDIA_NOT_FOUND':
    case 'MEDIA_REVISION_CONFLICT':
    case 'MEDIA_IN_USE':
    case 'MEDIA_MANAGED_FILE_IMMUTABLE':
    case 'MEDIA_UPLOAD_NOT_AVAILABLE':
    case 'MEDIA_UPLOAD_TYPE_NOT_ALLOWED':
    case 'MEDIA_UPLOAD_INTENT_NOT_FOUND':
    case 'MEDIA_UPLOAD_INTENT_EXPIRED':
    case 'MEDIA_UPLOAD_LIMIT_REACHED':
    case 'MEDIA_UPLOAD_SIZE_MISMATCH':
    case 'MEDIA_UPLOAD_SIGNATURE_INVALID':
    case 'MEDIA_UPLOAD_SVG_SANITIZATION_FAILED':
    case 'MEDIA_PREVIEW_NOT_FOUND':
    case 'MEDIA_PREVIEW_NOT_AVAILABLE':
    case 'MEDIA_IMAGE_EDIT_UNSUPPORTED':
    case 'MEDIA_COLLECTION_NOT_FOUND':
    case 'MEDIA_COLLECTION_NAME_CONFLICT':
    case 'MEDIA_COLLECTION_REVISION_CONFLICT':
    case 'MEDIA_COLLECTION_NOT_EMPTY':
    case 'MEDIA_COLLECTION_LIMIT_REACHED':
    case 'MEDIA_BULK_MOVE_CONFLICT':
    case 'TAXONOMY_SLUG_CONFLICT':
    case 'TAXONOMY_TERM_NOT_FOUND':
    case 'TAXONOMY_REVISION_CONFLICT':
    case 'TAXONOMY_TERM_IN_USE':
    case 'POST_SLUG_CONFLICT':
    case 'POST_AUTHOR_NOT_LINKED':
    case 'POST_NOT_FOUND':
    case 'POST_REVISION_CONFLICT':
    case 'POST_SAVED_REVISION_NOT_FOUND':
    case 'CONTENT_AUTOSAVE_NOT_FOUND':
    case 'CONTENT_AUTOSAVE_PROMOTION_NOT_READY':
    case 'POST_NOT_IN_TRASH':
    case 'CONTENT_DOCUMENT_TYPE_CHANGE_FORBIDDEN':
    case 'PAGE_SLUG_CONFLICT':
    case 'PAGE_NOT_FOUND':
    case 'PAGE_REVISION_CONFLICT':
    case 'PAGE_SAVED_REVISION_NOT_FOUND':
    case 'PAGE_NOT_IN_TRASH':
    case 'PAGE_PARENT_NOT_FOUND':
    case 'PAGE_PARENT_CYCLE':
    case 'PAGE_HAS_CHILDREN':
    case 'PAGE_IS_FRONT_PAGE':
    case 'MENU_ID_CONFLICT':
    case 'MENU_NOT_FOUND':
    case 'MENU_REVISION_CONFLICT':
    case 'MENU_PROTECTED':
    case 'MENU_REFERENCE_NOT_FOUND':
    case 'MENU_LIMIT_REACHED':
    case 'WIDGET_AREA_ID_CONFLICT':
    case 'WIDGET_AREA_NOT_FOUND':
    case 'WIDGET_AREA_REVISION_CONFLICT':
    case 'WIDGET_AREA_PROTECTED':
    case 'WIDGET_AREA_LIMIT_REACHED':
    case 'WIDGET_AUTHOR_NOT_FOUND':
    case 'COMMENT_NOT_FOUND':
    case 'COMMENT_REVISION_CONFLICT':
    case 'COMMENT_TARGET_NOT_AVAILABLE':
    case 'COMMENT_REPLY_NOT_AVAILABLE':
    case 'COMMENT_CREATION_CONFLICT':
    case 'COMMENT_REQUEST_SECURITY_NOT_ROTATABLE':
    case 'COMMENT_REQUEST_SECURITY_REVISION_CONFLICT':
    case 'FORM_NOT_FOUND':
    case 'FORM_ALREADY_EXISTS':
    case 'FORM_REVISION_CONFLICT':
    case 'FORM_HAS_SUBMISSIONS':
    case 'FORM_SUBMISSION_NOT_FOUND':
    case 'FORM_NOTIFICATION_RECIPIENT_NOT_AVAILABLE':
    case 'NEWSLETTER_NOT_FOUND':
    case 'NEWSLETTER_REVISION_CONFLICT':
    case 'NEWSLETTER_SUBSCRIPTION_NOT_FOUND':
    case 'NEWSLETTER_SUPPRESSION_NOT_FOUND':
    case 'NEWSLETTER_MAIL_NOT_CONFIGURED':
    case 'NEWSLETTER_POST_NOTIFICATION_REQUIRES_PUBLISHED':
    case 'NEWSLETTER_POST_NOTIFICATION_UNAVAILABLE':
    case 'AUTHOR_IN_USE':
    case 'WEAK_USER_PASSWORD':
    case 'NEW_PASSWORD_MUST_DIFFER':
    case 'SETTINGS_REVISION_CONFLICT':
    case 'SETTINGS_RECOVERY_CONFLICT':
    case 'SITE_SETTINGS_INCOMPLETE':
    case 'SITE_SETTINGS_DATA_INVALID':
    case 'SITE_ROUTING_SETTINGS_INCOMPLETE':
    case 'SITE_ROUTING_SETTINGS_DATA_INVALID':
    case 'SITE_BRANDING_MEDIA_NOT_FOUND':
    case 'SITE_BRANDING_MEDIA_TYPE_NOT_ALLOWED':
    case 'ROUTING_FRONT_PAGE_NOT_FOUND':
      return t('errors.api.systemNotAvailable');
    case 'SITE_ACTIVATION_REQUIRED':
      return t('errors.api.siteActivationRequired');
    case 'DATABASE_UPGRADE_REQUIRED':
    case 'DATABASE_UPGRADE_NOT_AVAILABLE':
    case 'DATABASE_UPGRADE_STATE_CONFLICT':
      return t('errors.api.databaseUpgradeRequired');
    case 'SYSTEM_NOT_AVAILABLE':
      return t('errors.api.systemNotAvailable');
    case 'SITE_MAINTENANCE':
      return t('errors.api.siteMaintenance');
    case 'SITE_RECOVERY':
      return t('errors.api.siteRecovery');
    case 'OPERATIONS_CONFIGURATION_ERROR':
    case 'INVALID_OPERATIONS_TOKEN':
    case 'INVALID_OPERATIONS_CREDENTIALS':
    case 'OPERATIONS_MAINTENANCE_REQUIRED':
    case 'OPERATIONS_CONFIRMATION_MISMATCH':
    case 'DATABASE_BACKUP_NOT_AVAILABLE':
    case 'DATABASE_BACKUP_ARTIFACT_INVALID':
    case 'DATABASE_BACKUP_LIMIT_EXCEEDED':
    case 'DATABASE_BACKUP_TARGET_MISMATCH':
    case 'DATABASE_BACKUP_SCHEMA_MISMATCH':
    case 'DATABASE_RESTORE_UNSUPPORTED_MODE':
    case 'DATABASE_RESTORE_LIMIT_EXCEEDED':
    case 'DATABASE_RESTORE_STATE_CONFLICT':
    case 'MAIL_CREDENTIAL_NOT_CONFIGURED':
    case 'MAIL_PROVIDER_AUTHENTICATION_FAILED':
    case 'MAIL_PROVIDER_REQUEST_REJECTED':
    case 'MAIL_PROVIDER_UNAVAILABLE':
    case 'MAIL_PROVIDER_RESPONSE_INVALID':
    case 'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE':
    case 'ADMINISTRATOR_NOT_FOUND':
      return t('errors.api.systemNotAvailable');
    case 'NOT_FOUND':
      return t('errors.api.notFound');
    case 'INTERNAL_ERROR':
      return t('errors.api.internalError');
  }
}

function getClientErrorMessage(
  code: LoginClientErrorCode,
  t: TFunction<'auth'>,
): string {
  switch (code) {
    case 'INVALID_RESPONSE':
      return t('errors.client.invalidResponse');
    case 'TIMEOUT':
      return t('errors.client.timeout');
    case 'NETWORK_ERROR':
      return t('errors.client.network');
  }
}

function presentResult(
  result: ResultState,
  t: TFunction<'auth'>,
): ResultPresentation {
  if (result.kind === 'validation') {
    return {
      tone: 'error',
      title: t('result.cannotCompleteTitle'),
      message: t(`validation.${result.field}`),
    };
  }
  if (result.kind === 'api_error') {
    return {
      tone: result.code === 'INVALID_CREDENTIALS'
        || result.code === 'INVALID_MFA_CODE'
        || result.code === 'WEBAUTHN_VERIFICATION_FAILED'
        || result.code === 'PASSKEY_SIGN_IN_FAILED'
        ? 'error'
        : 'neutral',
      title: result.code === 'INVALID_CREDENTIALS'
        ? t('result.loginFailedTitle')
        : t('result.cannotCompleteTitle'),
      message: getApiErrorMessage(result.code, t),
    };
  }
  if (result.kind === 'client_error') {
    return {
      tone: 'neutral',
      title: t('result.unexpectedTitle'),
      message: getClientErrorMessage(result.code, t),
    };
  }
  return {
    tone: 'neutral',
    title: t('result.unexpectedTitle'),
    message: t('errors.client.unknown'),
  };
}

export function LoginPage(input: {
  onAuthenticated: () => void;
  embedded?: boolean;
  initialEmail?: string;
  emailLocked?: boolean;
}) {
  const { t, i18n } = useTranslation('auth');
  const [stage, setStage] = useState<LoginStage>('credentials');
  const [email, setEmail] = useState(input.initialEmail ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [continuationToken, setContinuationToken] = useState('');
  const [verificationMethod, setVerificationMethod] =
    useState<LoginMfaMethod>('totp');
  const [availableMethods, setAvailableMethods] =
    useState<LoginMfaMethod[]>(['totp']);
  const [webAuthnSupported] = useState(() => browserSupportsWebAuthn());
  const [verificationCode, setVerificationCode] = useState('');
  const [enrollment, setEnrollment] =
    useState<MfaEnrollmentSetupData | null>(null);
  const [enrollmentTotpCode, setEnrollmentTotpCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPasskeySubmitting, setIsPasskeySubmitting] = useState(false);
  const [result, setResult] = useState<ResultState | null>(null);
  const resultPresentation = result ? presentResult(result, t) : null;

  useEffect(() => {
    if (!input.embedded) document.title = t('documentTitle');
  }, [i18n.resolvedLanguage, input.embedded, t]);

  function resetToCredentials() {
    setStage('credentials');
    setPassword('');
    setContinuationToken('');
    setVerificationMethod('totp');
    setAvailableMethods(['totp']);
    setVerificationCode('');
    setEnrollment(null);
    setEnrollmentTotpCode('');
    setResult(null);
  }

  function recordRequestError(error: unknown) {
    setResult(
      error instanceof LoginClientError
        ? { kind: 'client_error', code: error.code }
        : { kind: 'unexpected_error' },
    );
  }

  async function prepareEnrollment(token: string) {
    setIsSubmitting(true);
    setResult(null);
    try {
      const response = await requestMfaEnrollmentSetup({
        continuation_token: token,
      });
      if (!response.success) {
        setResult({ kind: 'api_error', code: response.error.code });
        return;
      }
      setEnrollment(response.data);
    } catch (error) {
      recordRequestError(error);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCredentialsSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    setResult(null);

    try {
      const response = await requestLogin({ email, password });
      if (!response.success) {
        setResult({ kind: 'api_error', code: response.error.code });
        return;
      }

      setPassword('');
      setContinuationToken(response.data.continuation_token);
      if (response.data.status === 'mfa_required') {
        setAvailableMethods(response.data.available_methods);
        const preferred = response.data.preferred_method === 'webauthn'
          && !webAuthnSupported
          ? 'totp'
          : response.data.preferred_method;
        setVerificationMethod(preferred);
        setStage('verification');
        setVerificationCode('');
        return;
      }

      setStage('enrollment');
      setEnrollment(null);
      setIsSubmitting(false);
      await prepareEnrollment(response.data.continuation_token);
    } catch (error) {
      recordRequestError(error);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePasskeySignIn() {
    if (isSubmitting || !webAuthnSupported) return;
    setIsSubmitting(true);
    setIsPasskeySubmitting(true);
    setResult(null);
    try {
      const options = await requestPasskeySignInOptions({});
      if (!options.success) {
        setResult({ kind: 'api_error', code: options.error.code });
        return;
      }
      let assertion;
      try {
        assertion = await startAuthentication({
          optionsJSON: options.data.options,
        });
      } catch {
        setResult({ kind: 'validation', field: 'webauthn' });
        return;
      }
      const response = await requestPasskeySignInVerification({
        challenge_token: options.data.challenge_token,
        response: assertion,
      });
      if (!response.success) {
        setResult({ kind: 'api_error', code: response.error.code });
        return;
      }
      setPassword('');
      input.onAuthenticated();
    } catch (error) {
      recordRequestError(error);
    } finally {
      setIsPasskeySubmitting(false);
      setIsSubmitting(false);
    }
  }

  async function handleVerificationSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (isSubmitting) return;
    if (verificationMethod === 'webauthn') {
      setIsSubmitting(true);
      setResult(null);
      try {
        const options = await requestWebAuthnLoginOptions({
          continuation_token: continuationToken,
        });
        if (!options.success) {
          setResult({ kind: 'api_error', code: options.error.code });
          return;
        }
        let assertion;
        try {
          assertion = await startAuthentication({
            optionsJSON: options.data.options,
          });
        } catch {
          setResult({ kind: 'validation', field: 'webauthn' });
          return;
        }
        const response = await requestWebAuthnLoginVerification({
          continuation_token: continuationToken,
          challenge_token: options.data.challenge_token,
          response: assertion,
        });
        if (!response.success) {
          setResult({ kind: 'api_error', code: response.error.code });
          return;
        }
        setContinuationToken('');
        input.onAuthenticated();
      } catch (error) {
        recordRequestError(error);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }
    const normalizedCode = verificationCode.replace(/\D/gu, '');
    if (!/^[0-9]{6}$/u.test(normalizedCode)) {
      setResult({ kind: 'validation', field: 'totp' });
      return;
    }

    setIsSubmitting(true);
    setResult(null);
    try {
      const response = await requestMfaVerification({
        continuation_token: continuationToken,
        method: verificationMethod,
        code: normalizedCode,
      });
      if (!response.success) {
        setResult({ kind: 'api_error', code: response.error.code });
        return;
      }
      setVerificationCode('');
      setContinuationToken('');
      input.onAuthenticated();
    } catch (error) {
      recordRequestError(error);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleEnrollmentSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    if (isSubmitting || !enrollment) return;
    if (!/^[0-9]{6}$/u.test(enrollmentTotpCode)) {
      setResult({ kind: 'validation', field: 'totp' });
      return;
    }
    setIsSubmitting(true);
    setResult(null);
    try {
      const response = await requestMfaEnrollmentComplete({
        continuation_token: continuationToken,
        mfa: {
          enrollment_token: enrollment.enrollment_token,
          totp_code: enrollmentTotpCode,
        },
      });
      if (!response.success) {
        setResult({ kind: 'api_error', code: response.error.code });
        return;
      }
      setEnrollment(null);
      setEnrollmentTotpCode('');
      setContinuationToken('');
      input.onAuthenticated();
    } catch (error) {
      recordRequestError(error);
    } finally {
      setIsSubmitting(false);
    }
  }

  const Shell = input.embedded ? 'div' : 'main';
  const Frame = input.embedded ? 'div' : 'section';

  return (
    <Shell className={input.embedded
      ? 'auth-shell auth-shell-embedded'
      : 'auth-shell auth-shell-login'}>

      <Frame
        className={input.embedded
          ? 'auth-frame auth-frame-embedded'
          : 'auth-frame auth-frame-login'}
        aria-label={t('loginRegionLabel')}
      >
        {!input.embedded ? <aside className="auth-brand">
          <p className="auth-lockup">
            <LogoBadge />
            <span>ZeroPress <strong className="auth-lockup-emphasis">Studio</strong></span>
          </p>
          <div className="auth-brand-copy">
            <p className="auth-eyebrow">{t('brand.eyebrow')}</p>
            <h1 className="auth-brand-headline">{t('brand.headline')}</h1>
            <p className="auth-brand-description">{t('brand.description')}</p>
          </div>
        </aside> : null}

        <div className={input.embedded
          ? 'auth-form-panel auth-form-panel-embedded'
          : 'auth-form-panel auth-form-panel-login'}>
          {!input.embedded ? (
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
          ) : null}
          <div className="auth-form-content">
            {stage === 'credentials' ? (
              <>
                {!input.embedded ? <header className="auth-form-header">
                  <p className="auth-kicker">{t('form.kicker')}</p>
                  <h2 className="auth-form-title">{t('form.title')}</h2>
                  <p className="auth-form-description">
                    {t('form.description')}
                  </p>
                </header> : null}
                <form
                  className="auth-form"
                  onSubmit={handleCredentialsSubmit}
                  noValidate
                >
                  {input.emailLocked ? (
                    <input
                      name="email"
                      type="hidden"
                      autoComplete="username"
                      value={email}
                      readOnly
                    />
                  ) : <Field label={t('form.email.label')}>
                    {(control) => (
                      <div className="auth-input">
                        <StudioIcon icon={Mail} />
                        <input
                          {...control}
                          name="email"
                          type="email"
                          autoComplete="username"
                          inputMode="email"
                          placeholder={t('form.email.placeholder')}
                          value={email}
                          required
                          disabled={isSubmitting}
                          onChange={(event) => setEmail(event.target.value)}
                        />
                      </div>
                    )}
                  </Field>}
                  <Field label={t('form.password.label')}>
                    {(control) => (
                      <div className="auth-input">
                        <StudioIcon icon={LockKeyhole} />
                        <input
                          {...control}
                          name="password"
                          type={showPassword ? 'text' : 'password'}
                          autoComplete="current-password"
                          placeholder={t('form.password.placeholder')}
                          value={password}
                          required
                          disabled={isSubmitting}
                          onChange={(event) => setPassword(event.target.value)}
                        />
                        <button
                          className="auth-password-toggle"
                          type="button"
                          aria-label={showPassword
                            ? t('form.password.hide')
                            : t('form.password.show')}
                          aria-pressed={showPassword}
                          disabled={isSubmitting}
                          onClick={() => setShowPassword(
                            (current) => !current,
                          )}
                        >
                          <StudioIcon icon={showPassword ? EyeOff : Eye} />
                        </button>
                      </div>
                    )}
                  </Field>
                  <Button
                    type="submit"
                    variant="primary"
                    size="lg"
                    block
                    disabled={isSubmitting || !email || !password}
                  >
                    {isSubmitting && !isPasskeySubmitting
                      ? <Spinner />
                      : null}
                    {isSubmitting && !isPasskeySubmitting
                      ? t('form.submitting')
                      : t('form.submit')}
                    {!isSubmitting ? (
                      <StudioIcon
                        className="auth-button-icon"
                        icon={ArrowRight}
                      />
                    ) : null}
                  </Button>
                  {webAuthnSupported ? (
                    <>
                      <div className="auth-alternative" aria-hidden="true">
                        <span>{t('form.alternative')}</span>
                      </div>
                      <Button
                        type="button"
                        size="lg"
                        block
                        disabled={isSubmitting}
                        onClick={() => void handlePasskeySignIn()}
                      >
                        {isPasskeySubmitting
                          ? <Spinner />
                          : <StudioIcon
                              className="auth-button-icon"
                              icon={KeyRound}
                            />}
                        {isPasskeySubmitting
                          ? t('form.passkeySubmitting')
                          : t('form.passkeySubmit')}
                      </Button>
                    </>
                  ) : null}
                </form>
              </>
            ) : null}

            {stage === 'verification' ? (
              <>
                <header className="auth-form-header">
                  <p className="auth-kicker">{t('mfa.kicker')}</p>
                  <h2 className="auth-form-title">{t('mfa.title')}</h2>
                  <p className="auth-form-description">
                    {t('mfa.description')}
                  </p>
                </header>
                <form
                  className="auth-form"
                  onSubmit={handleVerificationSubmit}
                  noValidate
                >
                  <fieldset className="auth-methods">
                    <legend className="auth-methods-legend">
                      {t('mfa.methodLabel')}
                    </legend>
                    {LOGIN_METHODS
                      .filter(({ value }) => value !== 'webauthn'
                        || (webAuthnSupported
                          && availableMethods.includes('webauthn')))
                      .map(({ value, labelKey, icon }) => (
                        <label className="auth-method" key={value}>
                          <input
                            type="radio"
                            name="mfa-method"
                            value={value}
                            checked={verificationMethod === value}
                            disabled={isSubmitting}
                            onChange={() => {
                              setVerificationMethod(value);
                              setVerificationCode('');
                              setResult(null);
                            }}
                          />
                          <span className="auth-method-label">
                            <span className="auth-method-icon">
                              <StudioIcon icon={icon} />
                            </span>
                            <span>{t(labelKey)}</span>
                            <StudioIcon
                              className="auth-method-check"
                              icon={Check}
                            />
                          </span>
                        </label>
                      ))}
                  </fieldset>
                  {verificationMethod === 'webauthn' ? (
                    <Callout tone="info">{t('mfa.webauthnPrompt')}</Callout>
                  ) : (
                    <Field label={t('mfa.code.totpLabel')}>
                      {(control) => (
                        <div className="auth-input auth-input-code">
                          <StudioIcon icon={Smartphone} />
                          <input
                            {...control}
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            placeholder={t('mfa.code.totpPlaceholder')}
                            value={verificationCode}
                            disabled={isSubmitting}
                            autoFocus
                            required
                            onChange={(event) => setVerificationCode(
                              event.target.value
                                .replace(/\D/gu, '')
                                .slice(0, 6),
                            )}
                          />
                        </div>
                      )}
                    </Field>
                  )}
                  <div className="auth-verification-actions">
                    <Button
                      type="submit"
                      variant="primary"
                      size="lg"
                      block
                      disabled={isSubmitting || (
                        verificationMethod !== 'webauthn'
                        && verificationCode.length === 0
                      )}
                    >
                      {isSubmitting
                        ? <Spinner />
                        : verificationMethod === 'webauthn'
                          ? (
                              <StudioIcon
                                className="auth-button-icon"
                                icon={KeyRound}
                              />
                            )
                          : null}
                      {isSubmitting
                        ? t('mfa.verifying')
                        : verificationMethod === 'webauthn'
                          ? t('mfa.verifyWebAuthn')
                          : t('mfa.verify')}
                      {!isSubmitting
                        && verificationMethod !== 'webauthn' ? (
                          <StudioIcon
                            className="auth-button-icon"
                            icon={ArrowRight}
                          />
                        ) : null}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      block
                      disabled={isSubmitting}
                      onClick={resetToCredentials}
                    >
                      <StudioIcon
                        className="auth-button-icon"
                        icon={ChevronLeft}
                      />
                      {t('mfa.back')}
                    </Button>
                  </div>
                </form>
              </>
            ) : null}

            {stage === 'enrollment' ? (
              <>
                <header className="auth-form-header">
                  <p className="auth-kicker">{t('mfa.enrollmentKicker')}</p>
                  <h2 className="auth-form-title">
                    {t('mfa.enrollmentTitle')}
                  </h2>
                  <p className="auth-form-description">
                    {t('mfa.enrollmentDescription')}
                  </p>
                </header>
                {enrollment ? (
                  <form
                    className="auth-form"
                    onSubmit={handleEnrollmentSubmit}
                    noValidate
                  >
                    <MfaEnrollmentPanel
                      enrollment={enrollment}
                      totpCode={enrollmentTotpCode}
                      disabled={isSubmitting}
                      onTotpCodeChange={setEnrollmentTotpCode}
                    />
                    <div className="auth-actions">
                      <Button
                        type="button"
                        disabled={isSubmitting}
                        onClick={resetToCredentials}
                      >
                        {t('mfa.back')}
                      </Button>
                      <Button
                        type="submit"
                        variant="primary"
                        disabled={isSubmitting
                          || enrollmentTotpCode.length !== 6}
                      >
                        {isSubmitting ? <Spinner /> : null}
                        {isSubmitting
                          ? t('mfa.enrollmentSubmitting')
                          : t('mfa.enrollmentSubmit')}
                      </Button>
                    </div>
                  </form>
                ) : (
                  <div className="auth-enrollment-pending" role="status">
                    {isSubmitting ? <Spinner /> : null}
                    <span>{t('mfa.enrollmentPreparing')}</span>
                    {!isSubmitting ? (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void prepareEnrollment(
                          continuationToken,
                        )}
                      >
                        {t('form.submit')}
                      </Button>
                    ) : null}
                  </div>
                )}
              </>
            ) : null}

            {resultPresentation ? (
              <div className="auth-notice">
                <Notice
                  tone={resultPresentation.tone === 'neutral'
                    ? 'info'
                    : resultPresentation.tone}
                  title={resultPresentation.title}
                >
                  {resultPresentation.message}
                </Notice>
              </div>
            ) : null}
          </div>
        </div>
      </Frame>
    </Shell>
  );
}

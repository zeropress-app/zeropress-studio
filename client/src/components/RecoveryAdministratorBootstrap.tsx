import {
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../../contracts/api';
import type { MfaEnrollmentSetupData } from '../../../contracts/mfa';
import {
  administratorRecoveryBootstrapConfirmation,
  administratorRecoveryBootstrapMfaSetupRequestSchema,
  administratorRecoveryBootstrapRequestSchema,
} from '../../../contracts/operations';
import {
  assessInstallPasswordPolicy,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../../contracts/password-policy';
import {
  OperationsClientError,
  requestAdministratorRecoveryBootstrap,
  requestAdministratorRecoveryBootstrapMfaSetup,
  type OperationsClientErrorCode,
} from '../lib/operations-client';
import { useBusyChange, type BusyChangeHandler } from '../hooks/useBusyChange';
import { InstallPasswordAssessment } from './InstallPasswordAssessment';
import {
  passwordBreachAllowsSubmission,
  usePasswordBreachCheck,
} from '../hooks/usePasswordBreachCheck';
import { MfaEnrollmentPanel } from './MfaEnrollmentPanel';
import {
  Button,
  Callout,
  Field,
  Notice,
  Spinner,
} from './primitives';

type BootstrapStage = 'account' | 'mfa' | 'confirm' | 'completed';
type BootstrapError =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: OperationsClientErrorCode }
  | {
      kind: 'local';
      code:
        | 'required'
        | 'passwordMismatch'
        | 'weakPassword'
        | 'backupRequired'
        | 'confirmation'
        | 'mfaCode';
    }
  | { kind: 'unexpected' };

type BootstrapErrorTranslationKey =
  | 'recovery.bootstrap.errors.required'
  | 'recovery.bootstrap.errors.passwordMismatch'
  | 'recovery.bootstrap.errors.weakPassword'
  | 'recovery.bootstrap.errors.backupRequired'
  | 'recovery.bootstrap.errors.confirmation'
  | 'recovery.bootstrap.errors.mfaCode'
  | 'recovery.bootstrap.errors.emailConflict'
  | 'recovery.bootstrap.errors.mfa'
  | 'recovery.bootstrap.errors.configuration'
  | 'recovery.bootstrap.errors.unavailable'
  | 'errors.tokenFormat'
  | 'errors.timeout'
  | 'errors.network'
  | 'errors.invalidResponse'
  | 'errors.unexpected'
  | 'errors.rateLimit'
  | 'errors.invalidToken'
  | 'errors.configuration'
  | 'errors.request';

function bootstrapErrorKey(
  error: BootstrapError,
): BootstrapErrorTranslationKey {
  if (error.kind === 'local') {
    const localKeys = {
      required: 'recovery.bootstrap.errors.required',
      passwordMismatch: 'recovery.bootstrap.errors.passwordMismatch',
      weakPassword: 'recovery.bootstrap.errors.weakPassword',
      backupRequired: 'recovery.bootstrap.errors.backupRequired',
      confirmation: 'recovery.bootstrap.errors.confirmation',
      mfaCode: 'recovery.bootstrap.errors.mfaCode',
    } as const;
    return localKeys[error.code];
  }
  if (error.kind === 'client') {
    if (error.code === 'INVALID_TOKEN_FORMAT') return 'errors.tokenFormat';
    if (error.code === 'TIMEOUT') return 'errors.timeout';
    if (error.code === 'NETWORK_ERROR') return 'errors.network';
    return 'errors.invalidResponse';
  }
  if (error.kind === 'unexpected') return 'errors.unexpected';

  switch (error.code) {
    case 'USER_EMAIL_CONFLICT':
      return 'recovery.bootstrap.errors.emailConflict';
    case 'WEAK_ADMIN_PASSWORD':
      return 'recovery.bootstrap.errors.weakPassword';
    case 'MFA_ENROLLMENT_INVALID':
    case 'INVALID_MFA_CODE':
      return 'recovery.bootstrap.errors.mfa';
    case 'SYSTEM_CONFIGURATION_ERROR':
      return 'recovery.bootstrap.errors.configuration';
    case 'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE':
    case 'SYSTEM_NOT_AVAILABLE':
      return 'recovery.bootstrap.errors.unavailable';
    case 'RATE_LIMIT_EXCEEDED':
      return 'errors.rateLimit';
    case 'INVALID_OPERATIONS_TOKEN':
      return 'errors.invalidToken';
    case 'OPERATIONS_CONFIGURATION_ERROR':
      return 'errors.configuration';
    case 'VALIDATION_ERROR':
    case 'INVALID_JSON':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'PAYLOAD_TOO_LARGE':
      return 'errors.request';
    default:
      return 'errors.unexpected';
  }
}

export function RecoveryAdministratorBootstrap(input: {
  token: string;
  onRecoveryStateChanged: () => void;
  onBusyChange?: BusyChangeHandler;
}) {
  const { t } = useTranslation('operations');
  const [stage, setStage] = useState<BootstrapStage>('account');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [backupAcknowledged, setBackupAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [enrollment, setEnrollment] =
    useState<MfaEnrollmentSetupData | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<BootstrapError | null>(null);
  useBusyChange(input.onBusyChange, submitting);
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

  function validateAccount(): BootstrapError | null {
    if (!name.trim() || !email.trim() || !password || !confirmPassword) {
      return { kind: 'local', code: 'required' };
    }
    if (password !== confirmPassword) {
      return { kind: 'local', code: 'passwordMismatch' };
    }
    if (
      !passwordAssessment.allowed
      || !passwordBreachAllowsSubmission(passwordBreach)
    ) {
      return { kind: 'local', code: 'weakPassword' };
    }
    if (!backupAcknowledged) {
      return { kind: 'local', code: 'backupRequired' };
    }
    if (confirmation !== administratorRecoveryBootstrapConfirmation) {
      return { kind: 'local', code: 'confirmation' };
    }
    return null;
  }

  async function prepareMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    const accountError = validateAccount();
    if (accountError) {
      setError(accountError);
      return;
    }
    const request =
      administratorRecoveryBootstrapMfaSetupRequestSchema.safeParse({
        administrator_email: email,
      });
    if (!request.success) {
      setError({ kind: 'local', code: 'required' });
      return;
    }

    setSubmitting(true);
    try {
      const response = await requestAdministratorRecoveryBootstrapMfaSetup({
        token: input.token,
        request: request.data,
      });
      if (!response.success) {
        setError({ kind: 'api', code: response.error.code });
        return;
      }
      setEnrollment(response.data);
      setTotpCode('');
      setStage('mfa');
    } catch (requestError) {
      setError(
        requestError instanceof OperationsClientError
          ? { kind: 'client', code: requestError.code }
          : { kind: 'unexpected' },
      );
    } finally {
      setSubmitting(false);
    }
  }

  function reviewBootstrap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrollment || submitting) return;
    setError(null);
    if (!/^[0-9]{6}$/u.test(totpCode)) {
      setError({ kind: 'local', code: 'mfaCode' });
      return;
    }
    const request = administratorRecoveryBootstrapRequestSchema.safeParse({
      administrator_name: name,
      administrator_email: email,
      new_password: password,
      backup_acknowledged: backupAcknowledged,
      confirmation,
      mfa: {
        enrollment_token: enrollment.enrollment_token,
        totp_code: totpCode,
      },
    });
    if (!request.success) {
      setError({ kind: 'local', code: 'required' });
      return;
    }
    setStage('confirm');
  }

  async function executeBootstrap() {
    if (!enrollment || submitting) return;
    const request = administratorRecoveryBootstrapRequestSchema.safeParse({
      administrator_name: name,
      administrator_email: email,
      new_password: password,
      backup_acknowledged: backupAcknowledged,
      confirmation,
      mfa: {
        enrollment_token: enrollment.enrollment_token,
        totp_code: totpCode,
      },
    });
    if (!request.success) {
      setStage('mfa');
      setError({ kind: 'local', code: 'required' });
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const response = await requestAdministratorRecoveryBootstrap({
        token: input.token,
        request: request.data,
      });
      if (!response.success) {
        setStage(
          response.error.code === 'MFA_ENROLLMENT_INVALID'
            || response.error.code === 'INVALID_MFA_CODE'
            ? 'mfa'
            : 'account',
        );
        setError({ kind: 'api', code: response.error.code });
        return;
      }
      setPassword('');
      setConfirmPassword('');
      setTotpCode('');
      setEnrollment(null);
      setStage('completed');
    } catch (requestError) {
      setStage('mfa');
      setError(
        requestError instanceof OperationsClientError
          ? { kind: 'client', code: requestError.code }
          : { kind: 'unexpected' },
      );
    } finally {
      setSubmitting(false);
    }
  }

  const errorMessage = error ? t(bootstrapErrorKey(error)) : null;

  return (
    <div className="operations-stack">
      <Callout tone="warning">
        {t('recovery.bootstrap.zeroAdministratorBoundary')}
      </Callout>

      {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}

      {stage === 'account' ? (
        <form
          className="operations-recovery-form"
          onSubmit={prepareMfa}
          noValidate
        >
          <div className="operations-recovery-passwords">
            <Field label={t('recovery.bootstrap.name')}>
              {(control) => (
                <input
                  {...control}
                  type="text"
                  autoComplete="name"
                  minLength={2}
                  maxLength={100}
                  required
                  value={name}
                  disabled={submitting}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>
            <Field label={t('recovery.bootstrap.email')}>
              {(control) => (
                <input
                  {...control}
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  maxLength={254}
                  required
                  value={email}
                  disabled={submitting}
                  onChange={(event) => setEmail(event.target.value)}
                />
              )}
            </Field>
          </div>

          <div className="operations-recovery-passwords">
            <Field label={t('recovery.bootstrap.password')}>
              {(control) => (
                <input
                  {...control}
                  type="password"
                  autoComplete="new-password"
                  minLength={PASSWORD_MIN_LENGTH}
                  maxLength={PASSWORD_MAX_LENGTH}
                  required
                  value={password}
                  disabled={submitting}
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </Field>
            <Field label={t('recovery.bootstrap.confirmPassword')}>
              {(control) => (
                <input
                  {...control}
                  type="password"
                  autoComplete="new-password"
                  minLength={PASSWORD_MIN_LENGTH}
                  maxLength={PASSWORD_MAX_LENGTH}
                  required
                  value={confirmPassword}
                  disabled={submitting}
                  onChange={(event) => setConfirmPassword(
                    event.target.value,
                  )}
                />
              )}
            </Field>
          </div>

          <InstallPasswordAssessment
            password={password}
            confirmPassword={confirmPassword}
            email={email}
            displayName={name}
            assessment={passwordAssessment}
            breach={passwordBreach}
          />

          <label className="operations-acknowledgement">
            <input
              type="checkbox"
              checked={backupAcknowledged}
              disabled={submitting}
              onChange={(event) => setBackupAcknowledged(
                event.target.checked,
              )}
            />
            <span className="operations-acknowledgement-text">
              <span className="operations-acknowledgement-title">
                {t('recovery.bootstrap.backupAcknowledgement')}
              </span>
              <span className="operations-acknowledgement-detail">
                {t('recovery.bootstrap.backupAcknowledgementHint')}
              </span>
            </span>
          </label>

          <Field
            label={t('confirmation.label')}
            labelAdornment={(
              <code className="operations-code">
                {administratorRecoveryBootstrapConfirmation}
              </code>
            )}
          >
            {(control) => (
              <input
                {...control}
                type="text"
                autoComplete="off"
                required
                value={confirmation}
                disabled={submitting}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            )}
          </Field>

          <div className="operations-actions">
            <Button
              type="button"
              disabled={submitting}
              onClick={input.onRecoveryStateChanged}
            >
              {t('recovery.refresh')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submitting
                || !name
                || !email
                || !password
                || !confirmPassword
                || !backupAcknowledged
                || confirmation
                  !== administratorRecoveryBootstrapConfirmation}
            >
              {submitting ? <Spinner /> : null}
              {submitting
                ? t('recovery.bootstrap.preparingMfa')
                : t('recovery.bootstrap.continueToMfa')}
            </Button>
          </div>
        </form>
      ) : null}

      {stage === 'mfa' && enrollment ? (
        <form
          className="operations-recovery-form"
          onSubmit={reviewBootstrap}
          noValidate
        >
          <p className="setup-account-summary">
            <span>{t('recovery.bootstrap.mfaAccount')}</span>
            <strong className="setup-account-summary-value">{email}</strong>
          </p>
          <MfaEnrollmentPanel
            enrollment={enrollment}
            totpCode={totpCode}
            disabled={submitting}
            headingLevel="h3"
            onTotpCodeChange={setTotpCode}
          />
          <div className="operations-actions">
            <Button
              type="button"
              disabled={submitting}
              onClick={() => {
                setStage('account');
                setEnrollment(null);
                setTotpCode('');
                setError(null);
              }}
            >
              {t('confirmation.back')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={submitting
                || totpCode.length !== 6}
            >
              {t('recovery.bootstrap.review')}
            </Button>
          </div>
        </form>
      ) : null}

      {stage === 'confirm' ? (
        <div className="operations-review">
          <h3 className="operations-review-title">
            {t('recovery.bootstrap.confirmTitle')}
          </h3>
          <p className="operations-review-detail">
            {t('recovery.bootstrap.confirmDescription', { email })}
          </p>
          <dl className="operations-review-list">
            <div className="operations-review-row">
              <dt>{t('recovery.bootstrap.accountEffect')}</dt>
              <dd>{t('recovery.bootstrap.accountEffectValue')}</dd>
            </div>
            <div className="operations-review-row">
              <dt>{t('recovery.bootstrap.mfaEffect')}</dt>
              <dd>{t('recovery.bootstrap.mfaEffectValue')}</dd>
            </div>
            <div className="operations-review-row">
              <dt>{t('recovery.bootstrap.contentEffect')}</dt>
              <dd>{t('recovery.bootstrap.contentEffectValue')}</dd>
            </div>
          </dl>
          <Callout tone="warning">
            {t('recovery.bootstrap.confirmWarning')}
          </Callout>
          <div className="operations-actions">
            <Button
              type="button"
              disabled={submitting}
              onClick={() => setStage('mfa')}
            >
              {t('confirmation.back')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={submitting}
              onClick={() => void executeBootstrap()}
            >
              {submitting ? <Spinner /> : null}
              {submitting
                ? t('recovery.bootstrap.creating')
                : t('recovery.bootstrap.execute')}
            </Button>
          </div>
        </div>
      ) : null}

      {stage === 'completed' ? (
        <div
          className="operations-review operations-review-complete"
          role="status"
        >
          <h3 className="operations-review-title">
            {t('recovery.bootstrap.completedTitle')}
          </h3>
          <p className="operations-review-detail">
            {t('recovery.bootstrap.completed')}
          </p>
          <div className="operations-actions">
            <Button
              type="button"
              onClick={input.onRecoveryStateChanged}
            >
              {t('recovery.bootstrap.refreshState')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

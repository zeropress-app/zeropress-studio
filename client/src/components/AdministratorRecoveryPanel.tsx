import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, UserRoundCog } from 'lucide-react';
import type { ApiErrorCode } from '../../../contracts/api';
import {
  administratorRecoveryConfirmation,
  administratorRecoveryRequestSchema,
  type AdministratorRecoveryMode,
  type RecoverableAdministrator,
} from '../../../contracts/operations';
import {
  assessInstallPasswordPolicy,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../../../contracts/password-policy';
import {
  OperationsClientError,
  requestAdministratorRecovery,
  requestAdministratorRecoveryStatus,
  type OperationsClientErrorCode,
} from '../lib/operations-client';
import { useBusyChange, type BusyChangeHandler } from '../hooks/useBusyChange';
import { InstallPasswordAssessment } from './InstallPasswordAssessment';
import {
  passwordBreachAllowsSubmission,
  usePasswordBreachCheck,
} from '../hooks/usePasswordBreachCheck';
import { RecoveryAdministratorBootstrap } from './RecoveryAdministratorBootstrap';
import {
  Button,
  Callout,
  Field,
  Notice,
  Panel,
  Spinner,
  StudioIcon,
} from './primitives';

type RecoveryStage = 'entry' | 'confirm' | 'completed';
type RecoveryError =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: OperationsClientErrorCode }
  | { kind: 'password_mismatch' }
  | { kind: 'weak_password' }
  | { kind: 'unexpected' };

type RecoveryErrorTranslationKey =
  | 'recovery.errors.passwordMismatch'
  | 'recovery.errors.weakPassword'
  | 'recovery.errors.unavailable'
  | 'recovery.errors.notFound'
  | 'errors.invalidToken'
  | 'errors.tokenFormat'
  | 'errors.configuration'
  | 'errors.rateLimit'
  | 'errors.notFound'
  | 'errors.request'
  | 'errors.invalidResponse'
  | 'errors.timeout'
  | 'errors.network'
  | 'errors.unexpected';

function recoveryErrorKey(
  error: RecoveryError,
): RecoveryErrorTranslationKey {
  if (error.kind === 'password_mismatch') {
    return 'recovery.errors.passwordMismatch';
  }
  if (error.kind === 'weak_password') {
    return 'recovery.errors.weakPassword';
  }
  if (error.kind === 'client') {
    if (error.code === 'INVALID_TOKEN_FORMAT') return 'errors.tokenFormat';
    if (error.code === 'TIMEOUT') return 'errors.timeout';
    if (error.code === 'NETWORK_ERROR') return 'errors.network';
    return 'errors.invalidResponse';
  }
  if (error.kind === 'unexpected') return 'errors.unexpected';

  switch (error.code) {
    case 'INVALID_OPERATIONS_TOKEN':
      return 'errors.invalidToken';
    case 'OPERATIONS_CONFIGURATION_ERROR':
      return 'errors.configuration';
    case 'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE':
    case 'SYSTEM_NOT_AVAILABLE':
    case 'SITE_MAINTENANCE':
    case 'SITE_RECOVERY':
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
    case 'CONTENT_SEARCH_INDEX_NOT_READY':
    case 'CONTENT_SEARCH_INDEX_UNAVAILABLE':
    case 'CONTENT_SEARCH_INDEX_REBUILD_NOT_AVAILABLE':
    case 'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT':
    case 'AI_SERVICE_UNAVAILABLE':
    case 'AI_EXCERPT_RESPONSE_INVALID':
    case 'AI_POST_DRAFT_RESPONSE_INVALID':
    case 'AI_POST_EDIT_UNAVAILABLE':
    case 'AI_POST_EDIT_RESPONSE_INVALID':
    case 'AI_PAGE_DRAFT_RESPONSE_INVALID':
    case 'AI_IMAGE_RESPONSE_INVALID':
    case 'AI_IMAGE_CONTENT_REJECTED':
    case 'CLOUDFLARE_ACCESS_REQUIRED':
    case 'CLOUDFLARE_ACCESS_NOT_DETECTED':
    case 'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE':
    case 'CLOUDFLARE_ACCESS_RECOVERY_NOT_AVAILABLE':
      return 'recovery.errors.unavailable';
    case 'ADMINISTRATOR_NOT_FOUND':
      return 'recovery.errors.notFound';
    case 'WEAK_ADMIN_PASSWORD':
      return 'recovery.errors.weakPassword';
    case 'RATE_LIMIT_EXCEEDED':
    case 'AI_REQUEST_RATE_LIMITED':
      return 'errors.rateLimit';
    case 'NOT_FOUND':
      return 'errors.notFound';
    case 'VALIDATION_ERROR':
    case 'INVALID_JSON':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'PAYLOAD_TOO_LARGE':
    case 'OPERATIONS_CONFIRMATION_MISMATCH':
    case 'CONTENT_SEARCH_QUERY_INVALID':
    case 'AI_EXCERPT_SOURCE_EMPTY':
    case 'AI_POST_DRAFT_SOURCE_EMPTY':
    case 'AI_POST_EDIT_SELECTION_EMPTY':
    case 'AI_POST_EDIT_SELECTION_UNSUPPORTED':
    case 'AI_PAGE_DRAFT_SOURCE_EMPTY':
      return 'errors.request';
    case 'INVALID_CREDENTIALS':
    case 'ACCOUNT_NOT_ACTIVE':
    case 'ACCOUNT_LOCKED':
    case 'MFA_CHALLENGE_INVALID':
    case 'MFA_ENROLLMENT_INVALID':
    case 'MFA_ALREADY_CONFIGURED':
    case 'MFA_NOT_CONFIGURED':
    case 'INVALID_MFA_CODE':
    case 'INVALID_CURRENT_PASSWORD':
    case 'MFA_STEP_UP_REQUIRED':
    case 'MFA_MANAGEMENT_CHALLENGE_INVALID':
    case 'WEBAUTHN_NOT_CONFIGURED':
    case 'WEBAUTHN_CHALLENGE_INVALID':
    case 'WEBAUTHN_VERIFICATION_FAILED':
    case 'WEBAUTHN_CREDENTIAL_LIMIT_REACHED':
    case 'WEBAUTHN_CREDENTIAL_NAME_CONFLICT':
    case 'WEBAUTHN_CREDENTIAL_ALREADY_REGISTERED':
    case 'WEBAUTHN_CREDENTIAL_NOT_FOUND':
    case 'PASSKEY_SIGN_IN_FAILED':
    case 'AUTHENTICATION_REQUIRED':
    case 'CSRF_VALIDATION_FAILED':
    case 'SYSTEM_CONFIGURATION_ERROR':
    case 'INSTALLATION_REQUIRED':
    case 'INSTALLATION_NOT_AVAILABLE':
    case 'INSTALLATION_ALREADY_COMPLETED':
    case 'INVALID_INSTALL_TOKEN':
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
    case 'SITE_ACTIVATION_REQUIRED':
    case 'DATABASE_UPGRADE_REQUIRED':
    case 'DATABASE_UPGRADE_NOT_AVAILABLE':
    case 'DATABASE_UPGRADE_STATE_CONFLICT':
    case 'INVALID_OPERATIONS_CREDENTIALS':
    case 'OPERATIONS_MAINTENANCE_REQUIRED':
    case 'DATABASE_BACKUP_NOT_AVAILABLE':
    case 'DATABASE_BACKUP_ARTIFACT_INVALID':
    case 'DATABASE_BACKUP_LIMIT_EXCEEDED':
    case 'DATABASE_BACKUP_TARGET_MISMATCH':
    case 'DATABASE_BACKUP_SCHEMA_MISMATCH':
    case 'DATABASE_RESTORE_UNSUPPORTED_MODE':
    case 'DATABASE_RESTORE_LIMIT_EXCEEDED':
    case 'DATABASE_RESTORE_STATE_CONFLICT':
    case 'ANALYTICS_NOT_CONFIGURED':
    case 'ANALYTICS_SITE_NOT_CONFIGURED':
    case 'ANALYTICS_CREDENTIAL_NOT_CONFIGURED':
    case 'ANALYTICS_AUTHENTICATION_FAILED':
    case 'ANALYTICS_QUERY_LIMITED':
    case 'ANALYTICS_UNAVAILABLE':
    case 'ANALYTICS_RESPONSE_INVALID':
    case 'MAIL_CREDENTIAL_NOT_CONFIGURED':
    case 'MAIL_PROVIDER_AUTHENTICATION_FAILED':
    case 'MAIL_PROVIDER_REQUEST_REJECTED':
    case 'MAIL_PROVIDER_UNAVAILABLE':
    case 'MAIL_PROVIDER_RESPONSE_INVALID':
    case 'INTERNAL_ERROR':
      return 'errors.unexpected';
  }
}

export function AdministratorRecoveryPanel({
  token,
  headingLevel = 3,
  onBusyChange,
}: {
  token: string;
  headingLevel?: 2 | 3;
  onBusyChange?: BusyChangeHandler;
}) {
  const { t } = useTranslation('operations');
  const resetMfaId = useId();
  const [administrators, setAdministrators] =
    useState<RecoverableAdministrator[] | null>(null);
  const [recoveryMode, setRecoveryMode] =
    useState<AdministratorRecoveryMode | null>(null);
  const [selectedAdministratorId, setSelectedAdministratorId] =
    useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [resetMfa, setResetMfa] = useState(true);
  const [confirmation, setConfirmation] = useState('');
  const [stage, setStage] = useState<RecoveryStage>('entry');
  const [loading, setLoading] = useState(true);
  const [mutationLoading, setMutationLoading] = useState(false);
  const [error, setError] = useState<RecoveryError | null>(null);
  useBusyChange(onBusyChange, mutationLoading);
  const selectedAdministrator = administrators?.find(
    (administrator) => administrator.id === selectedAdministratorId,
  ) ?? null;
  const passwordAssessment = useMemo(
    () => assessInstallPasswordPolicy({
      password,
      email: selectedAdministrator?.email,
      displayName: selectedAdministrator?.name,
    }),
    [password, selectedAdministrator],
  );
  const passwordBreach = usePasswordBreachCheck({
    password,
    enabled: passwordAssessment.allowed && password === confirmPassword,
  });

  async function loadAdministrators() {
    setLoading(true);
    setError(null);
    try {
      const response = await requestAdministratorRecoveryStatus(token);
      if (!response.success) {
        setError({ kind: 'api', code: response.error.code });
        return;
      }
      setRecoveryMode(response.data.mode);
      setAdministrators(response.data.administrators);
      setSelectedAdministratorId((current) => (
        response.data.administrators.some(
          (administrator) => administrator.id === current,
        )
          ? current
          : (response.data.administrators[0]?.id ?? '')
      ));
    } catch (requestError) {
      setError(
        requestError instanceof OperationsClientError
          ? { kind: 'client', code: requestError.code }
          : { kind: 'unexpected' },
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAdministrators();
    // The operations token is intentionally held only in parent page memory.
    // Re-read the authorized recovery catalog when that token changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  function reviewRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError({ kind: 'password_mismatch' });
      return;
    }
    if (
      !passwordAssessment.allowed
      || !passwordBreachAllowsSubmission(passwordBreach)
    ) {
      setError({ kind: 'weak_password' });
      return;
    }
    const parsed = administratorRecoveryRequestSchema.safeParse({
      administrator_id: selectedAdministratorId,
      new_password: password,
      reset_mfa: resetMfa,
      confirmation,
    });
    if (!parsed.success) {
      setError({ kind: 'api', code: 'VALIDATION_ERROR' });
      return;
    }
    setStage('confirm');
  }

  async function executeRecovery() {
    const parsed = administratorRecoveryRequestSchema.safeParse({
      administrator_id: selectedAdministratorId,
      new_password: password,
      reset_mfa: resetMfa,
      confirmation,
    });
    if (!parsed.success || loading) return;

    setMutationLoading(true);
    setLoading(true);
    setError(null);
    try {
      const response = await requestAdministratorRecovery({
        token,
        request: parsed.data,
      });
      if (!response.success) {
        setStage('entry');
        setError({ kind: 'api', code: response.error.code });
        return;
      }
      setStage('completed');
      setPassword('');
      setConfirmPassword('');
      setConfirmation('');
    } catch (requestError) {
      setStage('entry');
      setError(
        requestError instanceof OperationsClientError
          ? { kind: 'client', code: requestError.code }
          : { kind: 'unexpected' },
      );
    } finally {
      setLoading(false);
      setMutationLoading(false);
    }
  }

  const errorMessage = error ? t(recoveryErrorKey(error)) : null;

  return (
    <Panel
      headingLevel={headingLevel}
      leading={<StudioIcon icon={UserRoundCog} />}
      kicker={t('recovery.level')}
      title={recoveryMode === 'bootstrap_administrator'
        ? t('recovery.bootstrap.title')
        : t('recovery.title')}
      description={recoveryMode === 'bootstrap_administrator'
        ? t('recovery.bootstrap.description')
        : t('recovery.description')}
    >
      <div className="operations-stack">
        {loading && administrators === null ? (
          <p className="operations-upgrade-state" role="status">
            <Spinner />
            <span className="operations-upgrade-state-detail">
              {t('recovery.loading')}
            </span>
          </p>
        ) : null}

        {errorMessage ? <Notice tone="error">{errorMessage}</Notice> : null}

        {!loading && recoveryMode === 'bootstrap_administrator' ? (
          <RecoveryAdministratorBootstrap
            token={token}
            onRecoveryStateChanged={() => void loadAdministrators()}
            onBusyChange={onBusyChange}
          />
        ) : null}

        {stage === 'entry' && administrators?.length ? (
          <form
            className="operations-recovery-form"
            onSubmit={reviewRecovery}
            noValidate
          >
            <Field label={t('recovery.administrator')}>
              {(control) => (
                <select
                  {...control}
                  value={selectedAdministratorId}
                  disabled={loading}
                  onChange={(event) => {
                    setSelectedAdministratorId(event.target.value);
                    setPassword('');
                    setConfirmPassword('');
                    setError(null);
                  }}
                >
                  {administrators.map((administrator) => (
                    <option key={administrator.id} value={administrator.id}>
                      {administrator.email} · {administrator.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            {selectedAdministrator ? (
              <p className="operations-recovery-account">
                <span className="operations-recovery-fact">
                  {t('recovery.accountStatus', {
                    status: selectedAdministrator.status,
                  })}
                </span>
                <span className="operations-recovery-fact">
                  {selectedAdministrator.mfa_configured
                    ? t('recovery.mfaConfigured')
                    : t('recovery.mfaMissing')}
                </span>
              </p>
            ) : null}

            <div className="operations-recovery-passwords">
              <Field label={t('recovery.newPassword')}>
                {(control) => (
                  <input
                    {...control}
                    type="password"
                    autoComplete="new-password"
                    minLength={PASSWORD_MIN_LENGTH}
                    maxLength={PASSWORD_MAX_LENGTH}
                    value={password}
                    disabled={loading}
                    required
                    onChange={(event) => setPassword(event.target.value)}
                  />
                )}
              </Field>
              <Field label={t('recovery.confirmPassword')}>
                {(control) => (
                  <input
                    {...control}
                    type="password"
                    autoComplete="new-password"
                    minLength={PASSWORD_MIN_LENGTH}
                    maxLength={PASSWORD_MAX_LENGTH}
                    value={confirmPassword}
                    disabled={loading}
                    required
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
              email={selectedAdministrator?.email ?? ''}
              displayName={selectedAdministrator?.name ?? ''}
              assessment={passwordAssessment}
              breach={passwordBreach}
            />

            <label className="operations-acknowledgement" htmlFor={resetMfaId}>
              <input
                id={resetMfaId}
                type="checkbox"
                checked={resetMfa}
                disabled={loading}
                onChange={(event) => setResetMfa(event.target.checked)}
              />
              <span className="operations-acknowledgement-text">
                <span className="operations-acknowledgement-title">
                  {t('recovery.resetMfa')}
                </span>
                <span className="operations-acknowledgement-detail">
                  {t('recovery.resetMfaHint')}
                </span>
              </span>
            </label>

            <Field
              label={t('confirmation.label')}
              labelAdornment={(
                <code className="operations-code">
                  {administratorRecoveryConfirmation}
                </code>
              )}
            >
              {(control) => (
                <input
                  {...control}
                  type="text"
                  autoComplete="off"
                  value={confirmation}
                  disabled={loading}
                  required
                  onChange={(event) => setConfirmation(event.target.value)}
                />
              )}
            </Field>

            <div className="operations-actions">
              <Button
                type="button"
                disabled={loading}
                onClick={() => void loadAdministrators()}
              >
                <StudioIcon className="operations-button-icon" icon={RefreshCw} />
                {t('recovery.refresh')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={loading
                  || !selectedAdministrator
                  || !password
                  || !confirmPassword
                  || confirmation !== administratorRecoveryConfirmation}
              >
                <StudioIcon className="operations-button-icon" icon={UserRoundCog} />
                {t('recovery.review')}
              </Button>
            </div>
          </form>
        ) : null}

        {stage === 'confirm' && selectedAdministrator ? (
          <div className="operations-review">
            <h3 className="operations-review-title">
              {t('recovery.confirmTitle')}
            </h3>
            <p className="operations-review-detail">
              {t('recovery.confirmDescription', {
                email: selectedAdministrator.email,
              })}
            </p>
            <dl className="operations-review-list">
              <div className="operations-review-row">
                <dt>{t('recovery.passwordEffect')}</dt>
                <dd>{t('recovery.passwordEffectValue')}</dd>
              </div>
              <div className="operations-review-row">
                <dt>{t('recovery.mfaEffect')}</dt>
                <dd>
                  {resetMfa
                    ? t('recovery.mfaEffectReset')
                    : t('recovery.mfaEffectPreserve')}
                </dd>
              </div>
            </dl>
            <Callout tone="warning">{t('recovery.confirmWarning')}</Callout>
            <div className="operations-actions">
              <Button
                type="button"
                disabled={loading}
                onClick={() => setStage('entry')}
              >
                {t('confirmation.back')}
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={loading}
                onClick={() => void executeRecovery()}
              >
                <StudioIcon className="operations-button-icon" icon={UserRoundCog} />
                {loading ? t('recovery.recovering') : t('recovery.execute')}
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
              {t('recovery.completedTitle')}
            </h3>
            <p className="operations-review-detail">
              {resetMfa
                ? t('recovery.completedWithMfaReset')
                : t('recovery.completed')}
            </p>
            <div className="operations-actions">
              <Button
                type="button"
                onClick={() => {
                  setStage('entry');
                  setResetMfa(true);
                  void loadAdministrators();
                }}
              >
                {t('recovery.recoverAnother')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

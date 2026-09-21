import {
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation } from 'react-router';
import {
  ArrowRight,
  KeyRound,
  LockKeyhole,
  RefreshCw,
} from 'lucide-react';
import type { ApiErrorCode } from '../../contracts/api';
import { hasStudioCapability } from '../../contracts/authorization';
import type { CurrentSessionSuccess } from '../../contracts/session';
import type { OperationsSetupConfiguration } from '../../contracts/system';
import {
  isValidStudioWorkerSecret,
  STUDIO_WORKER_SECRET_MAX_LENGTH,
  STUDIO_WORKER_SECRET_MIN_LENGTH,
} from '../../contracts/worker-secret';
import {
  type OperationsStatusData,
} from '../../contracts/operations';
import { LoginPage } from './LoginPage';
import { LocaleSwitcher } from './components/LocaleSwitcher';
import { LogoBadge } from './components/LogoBadge';
import { OperationsAccessShell } from './components/OperationsAccessShell';
import { OperationsSetupScreen } from './components/OperationsSetupScreen';
import {
  InitialCheckingPlaceholder,
  useInitialCheckingPhase,
} from './components/InitialCheckingGate';
import { StandaloneStatusScreen } from './components/StandaloneStatusScreen';
import { StudioCheckingScreen } from './components/StudioCheckingScreen';
import { ThemeToggle } from './components/ThemeToggle';
import { SUPPORTED_LOCALES } from './i18n/locale';
import { requestCurrentSession } from './lib/session-client';
import { requestSystemStatus } from './lib/system-client';
import {
  OperationsClientError,
  requestOperationsStatus,
  type OperationsClientErrorCode,
} from './lib/operations-client';
import { OperationsNavigation } from './operations/OperationsNavigation';
import { OperationsActivityGuard } from './operations/OperationsActivityGuard';
import type { OperationsOutletContext } from './operations/operations-context';
import { operationsSectionForPath } from './operations/operations-routes';
import { STUDIO_VERSION } from './studio-version';
import {
  Button,
  Field,
  Notice,
  Spinner,
  StudioIcon,
  StudioToaster,
} from './components/primitives';

type ResultState =
  | { kind: 'api_error'; code: ApiErrorCode }
  | { kind: 'client_error'; code: OperationsClientErrorCode }
  | { kind: 'unexpected_error' };

type OperationsEntryState =
  | 'checking'
  | 'operational_login'
  | 'operational_forbidden'
  | 'operational'
  | 'unlock'
  | 'not_found'
  | 'setup_required'
  | 'unavailable';

type OperationalSession = CurrentSessionSuccess['data'];

type OperationsErrorTranslationKey =
  | 'errors.invalidToken'
  | 'errors.invalidCredentials'
  | 'errors.configuration'
  | 'errors.maintenanceRequired'
  | 'errors.confirmation'
  | 'errors.rateLimit'
  | 'errors.notFound'
  | 'errors.unavailable'
  | 'errors.request'
  | 'errors.tokenFormat'
  | 'errors.invalidResponse'
  | 'errors.timeout'
  | 'errors.network'
  | 'errors.unexpected';

function apiErrorKey(code: ApiErrorCode): OperationsErrorTranslationKey {
  switch (code) {
    case 'INVALID_OPERATIONS_TOKEN':
      return 'errors.invalidToken';
    case 'INVALID_OPERATIONS_CREDENTIALS':
      return 'errors.invalidCredentials';
    case 'OPERATIONS_CONFIGURATION_ERROR':
      return 'errors.configuration';
    case 'OPERATIONS_MAINTENANCE_REQUIRED':
      return 'errors.maintenanceRequired';
    case 'OPERATIONS_CONFIRMATION_MISMATCH':
      return 'errors.confirmation';
    case 'RATE_LIMIT_EXCEEDED':
      return 'errors.rateLimit';
    case 'NOT_FOUND':
      return 'errors.notFound';
    case 'SYSTEM_NOT_AVAILABLE':
    case 'SITE_MAINTENANCE':
    case 'SITE_RECOVERY':
    case 'SYSTEM_CONFIGURATION_ERROR':
    case 'INSTALLATION_REQUIRED':
    case 'INSTALLATION_NOT_AVAILABLE':
    case 'INSTALLATION_ALREADY_COMPLETED':
    case 'SITE_ACTIVATION_REQUIRED':
    case 'DATABASE_UPGRADE_REQUIRED':
    case 'DATABASE_UPGRADE_NOT_AVAILABLE':
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
    case 'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE':
    case 'CLOUDFLARE_ACCESS_RECOVERY_NOT_AVAILABLE':
      return 'errors.unavailable';
    case 'VALIDATION_ERROR':
    case 'INVALID_JSON':
    case 'UNSUPPORTED_MEDIA_TYPE':
    case 'PAYLOAD_TOO_LARGE':
    case 'CONTENT_SEARCH_QUERY_INVALID':
    case 'AI_EXCERPT_SOURCE_EMPTY':
    case 'AI_POST_DRAFT_SOURCE_EMPTY':
    case 'AI_POST_EDIT_SELECTION_EMPTY':
    case 'AI_POST_EDIT_SELECTION_UNSUPPORTED':
    case 'AI_PAGE_DRAFT_SOURCE_EMPTY':
    case 'CLOUDFLARE_ACCESS_NOT_DETECTED':
      return 'errors.request';
    case 'AI_REQUEST_RATE_LIMITED':
      return 'errors.rateLimit';
    case 'DATABASE_BACKUP_NOT_AVAILABLE':
      return 'errors.unavailable';
    case 'DATABASE_BACKUP_ARTIFACT_INVALID':
    case 'DATABASE_BACKUP_LIMIT_EXCEEDED':
    case 'DATABASE_BACKUP_TARGET_MISMATCH':
    case 'DATABASE_BACKUP_SCHEMA_MISMATCH':
    case 'DATABASE_RESTORE_UNSUPPORTED_MODE':
    case 'DATABASE_RESTORE_LIMIT_EXCEEDED':
    case 'DATABASE_RESTORE_STATE_CONFLICT':
    case 'PUBLISHING_NOT_CONFIGURED':
    case 'PUBLISHING_CREDENTIAL_NOT_CONFIGURED':
    case 'PUBLISHING_URL_INVALID':
    case 'PUBLISHING_URL_AMBIGUOUS':
    case 'PUBLISHING_AUTHENTICATION_FAILED':
    case 'PUBLISHING_PERMISSION_DENIED':
    case 'PUBLISHING_TARGET_NOT_FOUND':
    case 'PUBLISHING_TARGET_INVALID':
    case 'PUBLISHING_BRANCH_RESTRICTED':
    case 'PUBLISHING_CONFLICT':
    case 'PUBLISHING_RATE_LIMITED':
    case 'PUBLISHING_UNAVAILABLE':
    case 'PUBLISHING_RESPONSE_INVALID':
    case 'PUBLISHING_RESULT_UNKNOWN':
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
    case 'DATABASE_UPGRADE_STATE_CONFLICT':
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
    case 'INVALID_INSTALL_TOKEN':
    case 'WEAK_ADMIN_PASSWORD':
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
    case 'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE':
    case 'ADMINISTRATOR_NOT_FOUND':
    case 'INTERNAL_ERROR':
      return 'errors.unexpected';
  }
}

function clientErrorKey(
  code: OperationsClientErrorCode,
): OperationsErrorTranslationKey {
  switch (code) {
    case 'INVALID_TOKEN_FORMAT':
      return 'errors.tokenFormat';
    case 'INVALID_RESPONSE':
      return 'errors.invalidResponse';
    case 'TIMEOUT':
      return 'errors.timeout';
    case 'NETWORK_ERROR':
      return 'errors.network';
  }
}

export function OperationsPage() {
  const { t, i18n } = useTranslation('operations');
  const { t: tStudio } = useTranslation('studio');
  const { t: tSystem } = useTranslation('system');
  const { pathname } = useLocation();
  const currentSection = operationsSectionForPath(pathname);
  const initialCheckStarted = useRef(false);
  const [entryState, setEntryState] =
    useState<OperationsEntryState>('checking');
  const [operationalSession, setOperationalSession] =
    useState<OperationalSession | null>(null);
  const [setupConfiguration, setSetupConfiguration] =
    useState<OperationsSetupConfiguration | null>(null);
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<OperationsStatusData | null>(null);
  const [activeOperations, setActiveOperations] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ResultState | null>(null);
  const [showCheckingImmediately, setShowCheckingImmediately] =
    useState(false);
  const checkingPhase = useInitialCheckingPhase(
    entryState === 'checking',
    showCheckingImmediately,
  );

  const lockDashboard = useCallback(() => {
    setToken('');
    setStatus(null);
    setResult(null);
  }, []);

  useEffect(() => {
    if (entryState === 'not_found') {
      document.title = tStudio('notFound.documentTitle');
      return;
    }
    document.title = status
      ? `${t(`pages.${currentSection}.title`)} · ZeroPress Studio`
      : entryState === 'setup_required'
        ? `${t('setup.title')} · ZeroPress Studio`
        : entryState === 'operational'
          || entryState === 'operational_forbidden'
          ? t('operationalAccess.documentTitle')
          : t('documentTitle');
  }, [
    currentSection,
    entryState,
    i18n.resolvedLanguage,
    status,
    t,
    tStudio,
  ]);

  const resolveEntryRequirements = useCallback(async (
    showCheckingImmediately = true,
  ) => {
    setShowCheckingImmediately(showCheckingImmediately);
    setEntryState('checking');
    setResult(null);
    setSetupConfiguration(null);

    try {
      const systemStatus = await requestSystemStatus();

      if (systemStatus.data.operations.state !== 'available') {
        lockDashboard();
        setOperationalSession(null);
        if (systemStatus.data.operations.state === 'not_found') {
          setEntryState('not_found');
        } else {
          setSetupConfiguration(systemStatus.data.operations.configuration);
          setEntryState('setup_required');
        }
        return;
      }

      if (systemStatus.data.access.state === 'operational') {
        const session = await requestCurrentSession();
        if (!session.success) {
          setOperationalSession(null);
          if (session.error.code === 'AUTHENTICATION_REQUIRED') {
            setEntryState('operational_login');
            return;
          }
          setEntryState('unavailable');
          setResult({ kind: 'api_error', code: session.error.code });
          return;
        }
        if (!hasStudioCapability(session.data.user.roles, 'settings.manage')) {
          setOperationalSession(null);
          setEntryState('operational_forbidden');
          return;
        }

        setOperationalSession(session.data);
        setEntryState('operational');
        return;
      }

      setOperationalSession(null);
      setEntryState('unlock');
    } catch (error) {
      setEntryState('unavailable');
      setResult(
        error instanceof OperationsClientError
          ? { kind: 'client_error', code: error.code }
          : { kind: 'unexpected_error' },
      );
    }
  }, [lockDashboard]);

  useEffect(() => {
    // React Strict Mode replays effects in development. Keep the initial public
    // status/session check single-shot without probing the protected endpoint.
    if (initialCheckStarted.current) return;
    initialCheckStarted.current = true;
    void resolveEntryRequirements(false);
  }, [resolveEntryRequirements]);

  useEffect(() => {
    const lockBeforeLeaving = () => {
      lockDashboard();
    };
    const verifyAfterHistoryRestore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      // pagehide normally stores the locked tree in BFCache. Clear it again as
      // a defensive fallback before rechecking whether Operations still exists.
      lockDashboard();
      void resolveEntryRequirements();
    };

    window.addEventListener('pagehide', lockBeforeLeaving);
    window.addEventListener('pageshow', verifyAfterHistoryRestore);
    return () => {
      window.removeEventListener('pagehide', lockBeforeLeaving);
      window.removeEventListener('pageshow', verifyAfterHistoryRestore);
    };
  }, [lockDashboard, resolveEntryRequirements]);

  async function loadStatus(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (loading || token.length === 0) return;

    if (!isValidStudioWorkerSecret(token)) {
      setStatus(null);
      setEntryState(operationalSession ? 'operational' : 'unlock');
      setResult({ kind: 'client_error', code: 'INVALID_TOKEN_FORMAT' });
      return;
    }

    setLoading(true);
    setResult(null);
    try {
      const response = await requestOperationsStatus(token);
      if (!response.success) {
        setStatus(null);
        if (
          response.error.code === 'NOT_FOUND'
          || response.error.code === 'OPERATIONS_CONFIGURATION_ERROR'
        ) {
          // Configuration or the caller's IP may have changed since entry.
          // Re-discover without retaining the submitted credential.
          lockDashboard();
          await resolveEntryRequirements();
          return;
        }
        if (response.error.code !== 'INVALID_OPERATIONS_TOKEN') {
          setEntryState(operationalSession ? 'operational' : 'unavailable');
        }
        setResult({ kind: 'api_error', code: response.error.code });
        return;
      }
      setStatus(response.data);
    } catch (error) {
      setStatus(null);
      setEntryState(
        error instanceof OperationsClientError
        && error.code === 'INVALID_TOKEN_FORMAT'
          ? operationalSession ? 'operational' : 'unlock'
          : operationalSession ? 'operational' : 'unavailable',
      );
      setResult(
        error instanceof OperationsClientError
          ? { kind: 'client_error', code: error.code }
          : { kind: 'unexpected_error' },
      );
    } finally {
      setLoading(false);
    }
  }

  const refreshStatusData = useCallback(async () => {
    const response = await requestOperationsStatus(token);
    if (!response.success) {
      throw new TypeError(`Operations status failed: ${response.error.code}`);
    }
    setStatus(response.data);
    return response.data;
  }, [token]);

  const refreshDatabaseUpgradeStatus = useCallback(async () => (
    (await refreshStatusData()).database_upgrade
  ), [refreshStatusData]);

  const refreshOperationsStatus = useCallback(async () => {
    await refreshStatusData();
  }, [refreshStatusData]);

  const endOperationalSession = useCallback(() => {
    lockDashboard();
    setOperationalSession(null);
    setEntryState('operational_login');
  }, [lockDashboard]);

  const setActivity = useCallback((key: string, active: boolean) => {
    setActiveOperations((current) => {
      if (active === current.has(key)) return current;
      const next = new Set(current);
      if (active) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const beginActivity = useCallback((key: string) => {
    let active = true;
    setActivity(key, true);
    return () => {
      if (!active) return;
      active = false;
      setActivity(key, false);
    };
  }, [setActivity]);

  const operationsBusy = activeOperations.size > 0;

  function resultMessage(): string | null {
    if (!result) return null;
    if (result.kind === 'api_error') {
      return t(apiErrorKey(result.code));
    }
    if (result.kind === 'client_error') {
      return t(clientErrorKey(result.code));
    }
    return t('errors.unexpected');
  }

  const message = resultMessage();

  if (entryState === 'checking') {
    return checkingPhase === 'hidden'
      ? <InitialCheckingPlaceholder label={tSystem('loading.title')} />
      : <StudioCheckingScreen updateDocumentTitle={false} />;
  }

  if (checkingPhase === 'checking') {
    return <StudioCheckingScreen updateDocumentTitle={false} />;
  }

  if (entryState === 'not_found') {
    return (
      <StandaloneStatusScreen
        regionLabel={tStudio('notFound.title')}
        brandLabel="ZeroPress Studio"
        kicker={tStudio('notFound.kicker')}
        title={tStudio('notFound.title')}
        description={tStudio('notFound.description')}
        tone="error"
        localeLabel={t('language.label')}
        availableLocales={SUPPORTED_LOCALES}
      />
    );
  }

  if (entryState === 'setup_required' && setupConfiguration) {
    return (
      <>
        <StudioToaster />
        <OperationsSetupScreen
          configuration={setupConfiguration}
          onRetry={() => void resolveEntryRequirements()}
        />
      </>
    );
  }

  if (entryState === 'unavailable') {
    return (
      <StandaloneStatusScreen
        regionLabel={t('availability.unavailableTitle')}
        brandLabel="ZeroPress Studio"
        kicker={t('eyebrow')}
        title={t('availability.unavailableTitle')}
        description={t('availability.unavailableDescription')}
        localeLabel={t('language.label')}
        availableLocales={SUPPORTED_LOCALES}
      >
        {message ? <Notice tone="error">{message}</Notice> : null}
        <Button
          type="button"
          variant="primary"
          size="lg"
          block
          onClick={() => void resolveEntryRequirements()}
        >
          <StudioIcon icon={RefreshCw} />
          {t('availability.retry')}
        </Button>
      </StandaloneStatusScreen>
    );
  }

  if (entryState === 'operational_login') {
    return (
      <LoginPage
        onAuthenticated={() => void resolveEntryRequirements()}
      />
    );
  }

  if (entryState === 'operational_forbidden') {
    return (
      <StandaloneStatusScreen
        regionLabel={t('operationalAccess.deniedTitle')}
        brandLabel="ZeroPress Studio"
        kicker={t('operationalAccess.kicker')}
        title={t('operationalAccess.deniedTitle')}
        description={t('operationalAccess.deniedDescription')}
        tone="error"
        localeLabel={t('language.label')}
        availableLocales={SUPPORTED_LOCALES}
      />
    );
  }

  if (!status) {
    const isOperationalAccess = entryState === 'operational'
      && operationalSession !== null;

    return (
      <OperationsAccessShell
        regionLabel={isOperationalAccess
          ? t('operationalAccess.unlockRegionLabel')
          : t('unlock.regionLabel')}
        title={isOperationalAccess
          ? t('operationalAccess.title')
          : undefined}
        description={isOperationalAccess
          ? t('operationalAccess.unlockDescription')
          : undefined}
      >
        <form
          className="auth-form"
          onSubmit={loadStatus}
          noValidate
        >
          <Field label={t('unlock.tokenLabel')}>
            {(control) => (
              <div className="auth-input">
                <StudioIcon icon={KeyRound} />
                <input
                  {...control}
                  type="password"
                  autoComplete="off"
                  minLength={STUDIO_WORKER_SECRET_MIN_LENGTH}
                  maxLength={STUDIO_WORKER_SECRET_MAX_LENGTH}
                  value={token}
                  placeholder={t('unlock.tokenPlaceholder')}
                  disabled={loading}
                  required
                  aria-invalid={
                    token.length > 0
                    && !isValidStudioWorkerSecret(token)
                  }
                  onChange={(event) => setToken(event.target.value)}
                />
              </div>
            )}
          </Field>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            disabled={loading || token.length === 0}
          >
            {loading ? <Spinner /> : null}
            {loading
              ? t('unlock.opening')
              : isOperationalAccess
                ? t('operationalAccess.unlockOpen')
                : t('unlock.open')}
            {!loading ? (
              <StudioIcon
                className="auth-button-icon"
                icon={ArrowRight}
              />
            ) : null}
          </Button>
          {message ? <Notice tone="error">{message}</Notice> : null}
        </form>
      </OperationsAccessShell>
    );
  }

  return (
    <main className="operations-dashboard">
      <OperationsActivityGuard active={operationsBusy} />
      <div className="operations-body">
        <header className="operations-hero">
          <div className="operations-hero-toolbar">
            <p className="operations-hero-brand">
              <LogoBadge />
              <span>ZeroPress Studio</span>
            </p>
            <div className="operations-hero-actions">
              <ThemeToggle />
              <LocaleSwitcher
                label={t('language.label')}
                availableLocales={SUPPORTED_LOCALES}
              />
              <div className="operations-lock-action">
                <Button
                  type="button"
                  aria-label={t('lock')}
                  title={t('lock')}
                  disabled={operationsBusy}
                  onClick={lockDashboard}
                >
                  <StudioIcon
                    icon={LockKeyhole}
                    className="operations-lock-icon"
                  />
                  <span className="operations-lock-label">{t('lock')}</span>
                </Button>
              </div>
            </div>
          </div>
          <div className="operations-hero-main">
            <div className="operations-hero-copy">
              <p className="operations-hero-kicker">{t('eyebrow')}</p>
              <p className="operations-hero-title">
                {t('title')}
              </p>
              <p className="operations-hero-description">
                {t('description')}
              </p>
            </div>
            <p className="operations-hero-version">
              ZeroPress Studio {STUDIO_VERSION}
            </p>
          </div>
        </header>
        <div className="operations-layout">
          <OperationsNavigation disabled={operationsBusy} />
          <div className="operations-route">
            <Suspense
              fallback={(
                <div className="operations-route-pending" role="status">
                  <Spinner />
                  <span>{tSystem('loading.title')}</span>
                </div>
              )}
            >
              <Outlet
                context={{
                  token,
                  status,
                  operationalAccess: operationalSession !== null,
                  refreshDatabaseUpgradeStatus,
                  refreshStatus: refreshOperationsStatus,
                  endOperationalSession,
                  setActivity,
                  beginActivity,
                } satisfies OperationsOutletContext}
              />
            </Suspense>
          </div>
        </div>
      </div>
    </main>
  );
}

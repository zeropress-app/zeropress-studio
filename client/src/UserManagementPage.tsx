import {
  browserSupportsWebAuthn,
  startAuthentication,
} from '@simplewebauthn/browser';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import { Link } from 'react-router';
import {
  KeyRound,
  Link2,
  Pencil,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserPlus,
  UserRoundCheck,
  UserRoundCog,
  UserX,
} from 'lucide-react';
import type { ApiErrorCode } from '../../contracts/api';
import type {
  MfaManagementOperation,
  MfaManagementStatusResponse,
  MfaManagementVerification,
} from '../../contracts/mfa-management';
import {
  SYSTEM_ROLE_KEYS,
  USERS_DEFAULT_PAGE_SIZE,
  type ManagedUser,
  type UserDeletionImpact,
  type UserListSummary,
  type UserRole,
  type UserSetupPurpose,
} from '../../contracts/users';
import {
  MfaManagementClientError,
  requestMfaManagementAuthorization,
  requestMfaManagementStatus,
  requestMfaManagementWebAuthnStepUpOptions,
  requestMfaManagementWebAuthnStepUpVerification,
} from './lib/mfa-management-client';
import {
  requestCancelUserInvitation,
  requestCreateUserInvitation,
  requestDeleteUserAccount,
  requestReissueUserInvitation,
  requestResetUserAccess,
  requestUpdateUserName,
  requestUpdateUserRole,
  requestUpdateUserStatus,
  requestUserDeletionImpact,
  requestUsers,
  UsersClientError,
} from './lib/users-client';
import {
  ActionMenu,
  type ActionMenuItem,
  Button,
  DataTable,
  Dialog,
  DialogActions,
  EmptyState,
  Field,
  FilterTabs,
  Notice,
  PageHeader,
  Pagination,
  RouteLoading,
  StatusPill,
  StudioIcon,
  useStudioToast,
  type StatusTone,
} from './components/primitives';
import { IdentityAvatar } from './components/IdentityAvatar';
import {
  STUDIO_PATHS,
  studioPostsByAuthorPath,
} from './routing/studio-routes';

type AccountSession = {
  user: { id: string };
  csrf_token: string;
};

type MfaStatus = Extract<
  MfaManagementStatusResponse,
  { success: true }
>['data'];

type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      users: ManagedUser[];
      mfa: MfaStatus;
      pagination: {
        page: number;
        per_page: number;
        total: number;
        total_pages: number;
      };
      statusCounts: Record<'all' | ManagedUser['status'], number>;
      summary: UserListSummary;
    }
  | { kind: 'error' };

type UserStatusFilter = 'all' | ManagedUser['status'];
type UserRoleFilter = 'all' | UserRole;

type UserAction =
  | { kind: 'invite' }
  | { kind: 'reissue'; user: ManagedUser }
  | { kind: 'reset_access'; user: ManagedUser }
  | { kind: 'name'; user: ManagedUser }
  | { kind: 'role'; user: ManagedUser }
  | { kind: 'status'; user: ManagedUser; status: 'active' | 'inactive' }
  | {
      kind: 'cancel_invitation';
      user: ManagedUser;
      impact: UserDeletionImpact;
    }
  | {
      kind: 'delete_account';
      user: ManagedUser;
      impact: UserDeletionImpact;
    };

type VerificationMethod = MfaManagementVerification['method'] | 'webauthn';

type Failure =
  | {
      kind: 'validation';
      code:
        | 'invite'
        | 'name'
        | 'role'
        | 'password'
        | 'verification'
        | 'passkey'
        | 'confirmation'
        | 'recoveryAcknowledgement';
    }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' };

type SetupResult = {
  purpose: UserSetupPurpose;
  setupUrl: string;
  expiresAtIso: string;
};

type Completion =
  | { kind: 'name'; user: ManagedUser }
  | { kind: 'role'; user: ManagedUser }
  | { kind: 'status'; user: ManagedUser }
  | {
      kind: 'cancel_invitation' | 'delete_account';
      name: string;
    };

const STATUS_TONES: Record<ManagedUser['status'], StatusTone> = {
  active: 'positive',
  pending: 'attention',
  inactive: 'neutral',
};

const VERIFICATION_METHODS = [
  { value: 'totp', labelKey: 'dialog.methodTotp' },
  { value: 'webauthn', labelKey: 'dialog.methodPasskey' },
] as const satisfies ReadonlyArray<{
  value: VerificationMethod;
  labelKey: string;
}>;

function operationForAction(action: UserAction): MfaManagementOperation {
  if (action.kind === 'invite') return 'invite_user';
  if (action.kind === 'reissue') return 'reissue_user_invitation';
  if (action.kind === 'reset_access') return 'reset_user_access';
  if (action.kind === 'name') return 'change_user_name';
  if (action.kind === 'role') return 'change_user_role';
  if (action.kind === 'status') return 'change_user_status';
  if (action.kind === 'cancel_invitation') {
    return 'cancel_user_invitation';
  }
  return 'delete_user_account';
}

function targetForAction(action: UserAction): string | undefined {
  return action.kind === 'invite' ? undefined : action.user.id;
}

function replaceManagedUser(
  users: ManagedUser[],
  user: ManagedUser,
): ManagedUser[] {
  const index = users.findIndex((item) => item.id === user.id);
  if (index === -1) return [...users, user];
  return users.map((item) => item.id === user.id ? user : item);
}

export function UserManagementPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
  onSignedOut?: () => void;
  onCurrentUserNameChanged?: (name: string) => void;
}) {
  const { t, i18n } = useTranslation('users');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<UserRoleFilter>('all');
  const [statusFilter, setStatusFilter] = useState<UserStatusFilter>('all');
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<UserAction | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>('author');
  const [password, setPassword] = useState('');
  const [verificationMethod, setVerificationMethod] =
    useState<VerificationMethod>('totp');
  const [verificationCode, setVerificationCode] = useState('');
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const [recoveryDeletionAcknowledged, setRecoveryDeletionAcknowledged] =
    useState(false);
  const [impactLoadingUserId, setImpactLoadingUserId] =
    useState<string | null>(null);
  const [impactFailure, setImpactFailure] = useState<Failure | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [setupResult, setSetupResult] =
    useState<SetupResult | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [copyState, setCopyState] =
    useState<'idle' | 'copied' | 'failed'>('idle');
  const [webAuthnSupported] = useState(() => browserSupportsWebAuthn());
  const runningRef = useRef(running);
  runningRef.current = running;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    { dateStyle: 'medium', timeStyle: 'short' },
  ), [i18n.resolvedLanguage]);
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage),
    [i18n.resolvedLanguage],
  );

  useStudioDocumentTitle(t('documentTitle'));
  useStudioToast({
    id: 'users-completion',
    tone: 'success',
    message: completion
      ? completion.kind === 'name'
        ? t('result.nameUpdated', { name: completion.user.name })
        : completion.kind === 'role'
          ? t('result.roleUpdated', {
            name: completion.user.name,
            role: t(`roles.${completion.user.role}`),
          })
          : completion.kind === 'status'
            ? t('result.statusUpdated', {
              name: completion.user.name,
              status: t(`statuses.${completion.user.status}`),
            })
            : completion.kind === 'cancel_invitation'
              ? t('result.invitationCancelled', { name: completion.name })
              : t('result.accountDeleted', { name: completion.name })
      : null,
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState((current) => current.kind === 'ready'
      ? current
      : { kind: 'loading' });
    void Promise.all([
      requestUsers({
        search,
        role: roleFilter,
        status: statusFilter,
        page,
        per_page: USERS_DEFAULT_PAGE_SIZE,
      }, controller.signal),
      requestMfaManagementStatus(controller.signal),
    ]).then(([usersResponse, mfaResponse]) => {
      if (!active) return;
      if (
        !usersResponse.success
        || !mfaResponse.success
      ) {
        const code = !usersResponse.success
          ? usersResponse.error.code
          : !mfaResponse.success
            ? mfaResponse.error.code
            : 'INTERNAL_ERROR';
        if (code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({ kind: 'error' });
        return;
      }
      setLoadState({
        kind: 'ready',
        users: usersResponse.data.items,
        mfa: mfaResponse.data,
        pagination: usersResponse.data.pagination,
        statusCounts: usersResponse.data.status_counts,
        summary: usersResponse.data.summary,
      });
    }).catch(() => {
      if (active && !controller.signal.aborted) {
        setLoadState({ kind: 'error' });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    input.onSessionEnded,
    loadAttempt,
    page,
    roleFilter,
    search,
    statusFilter,
  ]);

  useEffect(() => {
    if (loadState.kind !== 'ready') return;
    const lastPage = Math.max(1, loadState.pagination.total_pages);
    if (page > lastPage) setPage(lastPage);
  }, [loadState, page]);

  function openAction(next: UserAction) {
    setAction(next);
    setEmail('');
    setName(next.kind === 'name' ? next.user.name : '');
    setRole(next.kind === 'role' ? next.user.role : 'author');
    setPassword('');
    setVerificationMethod('totp');
    setVerificationCode('');
    setConfirmationEmail('');
    setRecoveryDeletionAcknowledged(false);
    setFailure(null);
    setImpactFailure(null);
    setCompletion(null);
  }

  async function openDestructiveAction(inputAction: {
    kind: 'cancel_invitation' | 'delete_account';
    user: ManagedUser;
  }) {
    if (impactLoadingUserId !== null) return;
    setImpactLoadingUserId(inputAction.user.id);
    setImpactFailure(null);
    setCompletion(null);
    try {
      const response = await requestUserDeletionImpact(
        input.data.csrf_token,
        { user_id: inputAction.user.id },
      );
      if (!response.success) {
        apiFailure(response.error.code, true);
        return;
      }
      const expectedOperation = inputAction.kind === 'cancel_invitation'
        ? 'cancel_invitation'
        : 'delete_account';
      if (response.data.operation !== expectedOperation) {
        setImpactFailure({ kind: 'api', code: 'USER_STATE_CONFLICT' });
        return;
      }
      openAction({
        kind: inputAction.kind,
        user: response.data.user,
        impact: response.data,
      });
    } catch (error) {
      const code = error instanceof UsersClientError
        ? error.code
        : 'INVALID_RESPONSE';
      setImpactFailure({ kind: 'client', code });
    } finally {
      setImpactLoadingUserId(null);
    }
  }

  function closeSetupResult() {
    setSetupResult(null);
    setCopyState('idle');
  }

  function closeAction() {
    if (runningRef.current) return;
    setAction(null);
    setPassword('');
    setVerificationCode('');
    setConfirmationEmail('');
    setRecoveryDeletionAcknowledged(false);
    setFailure(null);
  }

  function apiFailure(code: ApiErrorCode, outsideDialog = false) {
    if (code === 'AUTHENTICATION_REQUIRED') {
      input.onSessionEnded();
      return;
    }
    const next = { kind: 'api' as const, code };
    if (outsideDialog) setImpactFailure(next);
    else setFailure(next);
  }

  function errorMessage(value: Failure): string {
    if (value.kind === 'validation') {
      return t(`validation.${value.code}`);
    }
    if (value.kind === 'client') {
      if (value.code === 'TIMEOUT') return t('errors.timeout');
      if (value.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (value.code === 'FORBIDDEN') return t('errors.forbidden');
    if (value.code === 'AUTHENTICATION_REQUIRED') {
      return t('errors.authentication');
    }
    if (value.code === 'INVALID_CURRENT_PASSWORD') {
      return t('errors.invalidPassword');
    }
    if (
      value.code === 'INVALID_MFA_CODE'
      || value.code === 'WEBAUTHN_VERIFICATION_FAILED'
    ) {
      return t('errors.invalidMfa');
    }
    if (
      value.code === 'MFA_MANAGEMENT_CHALLENGE_INVALID'
      || value.code === 'WEBAUTHN_CHALLENGE_INVALID'
      || value.code === 'MFA_CHALLENGE_INVALID'
      || value.code === 'MFA_STEP_UP_REQUIRED'
    ) {
      return t('errors.expiredAuthorization');
    }
    if (value.code === 'USER_EMAIL_CONFLICT') {
      return t('errors.emailConflict');
    }
    if (value.code === 'USER_NOT_FOUND') return t('errors.notFound');
    if (value.code === 'USER_STATE_CONFLICT') {
      return t('errors.stateConflict');
    }
    if (value.code === 'USER_INVITATION_NOT_CANCELLABLE') {
      return t('errors.invitationNotCancellable');
    }
    if (value.code === 'USER_ACCOUNT_DELETE_REQUIRES_INACTIVE') {
      return t('errors.deleteRequiresInactive');
    }
    if (value.code === 'CURRENT_USER_DELETE_FORBIDDEN') {
      return t('errors.currentUserDelete');
    }
    if (value.code === 'USER_SETUP_REQUIRED') {
      return t('errors.setupRequired');
    }
    if (value.code === 'LAST_ACTIVE_ADMIN_REQUIRED') {
      return t('errors.lastAdmin');
    }
    if (value.code === 'RATE_LIMIT_EXCEEDED') {
      return t('errors.rateLimit');
    }
    return t('errors.api');
  }

  async function authorize(
    currentAction: UserAction,
  ): Promise<string | null> {
    if (loadState.kind !== 'ready') return null;
    const operation = operationForAction(currentAction);
    const targetId = targetForAction(currentAction);
    if (
      loadState.mfa.step_up.mfa_required
      && verificationMethod === 'webauthn'
    ) {
      const options = await requestMfaManagementWebAuthnStepUpOptions(
        input.data.csrf_token,
        {
          operation,
          ...(targetId ? { target_id: targetId } : {}),
          password,
        },
      );
      if (!options.success) {
        apiFailure(options.error.code);
        return null;
      }
      let assertion;
      try {
        assertion = await startAuthentication({
          optionsJSON: options.data.options,
        });
      } catch {
        setFailure({ kind: 'validation', code: 'passkey' });
        return null;
      }
      const response = await requestMfaManagementWebAuthnStepUpVerification(
        input.data.csrf_token,
        {
          operation,
          ...(targetId ? { target_id: targetId } : {}),
          challenge_token: options.data.challenge_token,
          response: assertion,
        },
      );
      if (!response.success) {
        apiFailure(response.error.code);
        return null;
      }
      return response.data.management_token;
    }

    const verification = loadState.mfa.step_up.mfa_required
      ? {
        method: verificationMethod,
        code: verificationCode.replace(/\D/gu, ''),
      } as MfaManagementVerification
      : undefined;
    const response = await requestMfaManagementAuthorization(
      input.data.csrf_token,
      {
        operation,
        ...(targetId ? { target_id: targetId } : {}),
        password,
        ...(verification ? { verification } : {}),
      },
    );
    if (!response.success) {
      apiFailure(response.error.code);
      return null;
    }
    return response.data.management_token;
  }

  async function submitAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      running
      || !action
      || loadState.kind !== 'ready'
    ) return;
    if (action.kind === 'invite') {
      if (
        !/^\S+@\S+\.\S+$/u.test(email.trim())
        || name.trim().length < 2
        || name.trim().length > 100
      ) {
        setFailure({ kind: 'validation', code: 'invite' });
        return;
      }
    }
    if (
      action.kind === 'name'
      && (
        name.trim().length < 2
        || name.trim().length > 100
        || name.trim() === action.user.name
      )
    ) {
      setFailure({ kind: 'validation', code: 'name' });
      return;
    }
    if (action.kind === 'role' && role === action.user.role) {
      setFailure({ kind: 'validation', code: 'role' });
      return;
    }
    if (
      (action.kind === 'cancel_invitation'
        || action.kind === 'delete_account')
      && confirmationEmail.trim().toLowerCase() !== action.user.email
    ) {
      setFailure({ kind: 'validation', code: 'confirmation' });
      return;
    }
    if (
      action.kind === 'delete_account'
      && action.impact.effects.post_autosaves
        + action.impact.effects.page_autosaves > 0
      && !recoveryDeletionAcknowledged
    ) {
      setFailure({
        kind: 'validation',
        code: 'recoveryAcknowledgement',
      });
      return;
    }
    if (!password) {
      setFailure({ kind: 'validation', code: 'password' });
      return;
    }
    if (
      loadState.mfa.step_up.mfa_required
      && verificationMethod !== 'webauthn'
      && !/^[0-9]{6}$/u.test(verificationCode)
    ) {
      setFailure({ kind: 'validation', code: 'verification' });
      return;
    }

    setRunning(true);
    setFailure(null);
    try {
      const managementToken = await authorize(action);
      if (!managementToken) return;
      if (action.kind === 'invite') {
        const response = await requestCreateUserInvitation(
          input.data.csrf_token,
          {
            email: email.trim(),
            name: name.trim(),
            role,
            management_token: managementToken,
          },
        );
        if (!response.success) {
          apiFailure(response.error.code);
          return;
        }
        setLoadState((current) => current.kind === 'ready'
          ? {
            ...current,
            users: replaceManagedUser(current.users, response.data.user),
          }
          : current);
        setSetupResult({
          purpose: 'invitation',
          setupUrl: response.data.setup_url,
          expiresAtIso: response.data.expires_at_iso,
        });
      } else if (action.kind === 'reissue') {
        const response = await requestReissueUserInvitation(
          input.data.csrf_token,
          {
            user_id: action.user.id,
            management_token: managementToken,
          },
        );
        if (!response.success) {
          apiFailure(response.error.code);
          return;
        }
        setLoadState((current) => current.kind === 'ready'
          ? {
            ...current,
            users: replaceManagedUser(current.users, response.data.user),
          }
          : current);
        setSetupResult({
          purpose: 'invitation',
          setupUrl: response.data.setup_url,
          expiresAtIso: response.data.expires_at_iso,
        });
      } else if (action.kind === 'reset_access') {
        const response = await requestResetUserAccess(
          input.data.csrf_token,
          {
            user_id: action.user.id,
            management_token: managementToken,
          },
        );
        if (!response.success) {
          apiFailure(response.error.code);
          return;
        }
        setLoadState((current) => current.kind === 'ready'
          ? {
            ...current,
            users: replaceManagedUser(current.users, response.data.user),
          }
          : current);
        setSetupResult({
          purpose: 'credential_recovery',
          setupUrl: response.data.setup_url,
          expiresAtIso: response.data.expires_at_iso,
        });
      } else if (action.kind === 'name') {
        const response = await requestUpdateUserName(
          input.data.csrf_token,
          {
            user_id: action.user.id,
            name: name.trim(),
            expected_updated_at_iso: action.user.updated_at_iso,
            management_token: managementToken,
          },
        );
        if (!response.success) {
          apiFailure(response.error.code);
          return;
        }
        setLoadState((current) => current.kind === 'ready'
          ? {
            ...current,
            users: replaceManagedUser(current.users, response.data.user),
          }
          : current);
        setCompletion({ kind: 'name', user: response.data.user });
        if (response.data.user.id === input.data.user.id) {
          input.onCurrentUserNameChanged?.(response.data.user.name);
        }
      } else if (action.kind === 'role') {
        const response = await requestUpdateUserRole(
          input.data.csrf_token,
          {
            user_id: action.user.id,
            role,
            management_token: managementToken,
          },
        );
        if (!response.success) {
          apiFailure(response.error.code);
          return;
        }
        setLoadState((current) => current.kind === 'ready'
          ? {
            ...current,
            users: replaceManagedUser(current.users, response.data.user),
          }
          : current);
        setCompletion({ kind: 'role', user: response.data.user });
        if (response.data.current_session_ended) {
          (input.onSignedOut ?? input.onSessionEnded)();
          return;
        }
      } else if (action.kind === 'status') {
        const response = await requestUpdateUserStatus(
          input.data.csrf_token,
          {
            user_id: action.user.id,
            status: action.status,
            management_token: managementToken,
          },
        );
        if (!response.success) {
          apiFailure(response.error.code);
          return;
        }
        setLoadState((current) => current.kind === 'ready'
          ? {
            ...current,
            users: replaceManagedUser(current.users, response.data.user),
          }
          : current);
        setCompletion({ kind: 'status', user: response.data.user });
        if (response.data.current_session_ended) {
          (input.onSignedOut ?? input.onSessionEnded)();
          return;
        }
      } else if (action.kind === 'cancel_invitation') {
        const response = await requestCancelUserInvitation(
          input.data.csrf_token,
          {
            user_id: action.user.id,
            confirmation_email: confirmationEmail,
            management_token: managementToken,
          },
        );
        if (!response.success) {
          apiFailure(response.error.code);
          return;
        }
        setLoadState((current) => current.kind === 'ready'
          ? {
            ...current,
            users: current.users.filter((user) => user.id !== action.user.id),
          }
          : current);
        setCompletion({
          kind: 'cancel_invitation',
          name: action.user.name,
        });
      } else {
        const response = await requestDeleteUserAccount(
          input.data.csrf_token,
          {
            user_id: action.user.id,
            confirmation_email: confirmationEmail,
            acknowledge_recovery_copy_deletion: true,
            management_token: managementToken,
          },
        );
        if (!response.success) {
          apiFailure(response.error.code);
          return;
        }
        setLoadState((current) => current.kind === 'ready'
          ? {
            ...current,
            users: current.users.filter((user) => user.id !== action.user.id),
          }
          : current);
        setCompletion({ kind: 'delete_account', name: action.user.name });
      }
      setAction(null);
      setPassword('');
      setVerificationCode('');
      setLoadAttempt((value) => value + 1);
    } catch (error) {
      const code = error instanceof UsersClientError
        || error instanceof MfaManagementClientError
        ? error.code
        : 'INVALID_RESPONSE';
      setFailure({ kind: 'client', code });
    } finally {
      setRunning(false);
    }
  }

  async function copySetupUrl() {
    if (!setupResult) return;
    try {
      await navigator.clipboard.writeText(setupResult.setupUrl);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  function dialogCopy(currentAction: UserAction) {
    if (currentAction.kind === 'invite') {
      return {
        kicker: t('dialog.createKicker'),
        title: t('dialog.createTitle'),
        description: t('dialog.createDescription'),
        confirm: t('dialog.confirmInvite'),
      };
    }
    if (currentAction.kind === 'reissue') {
      return {
        kicker: t('dialog.reissueKicker'),
        title: t('dialog.reissueTitle'),
        description: t('dialog.reissueDescription'),
        confirm: t('dialog.confirmReissue'),
      };
    }
    if (currentAction.kind === 'reset_access') {
      return {
        kicker: t('dialog.resetAccessKicker'),
        title: t('dialog.resetAccessTitle', {
          name: currentAction.user.name,
        }),
        description: t('dialog.resetAccessDescription'),
        confirm: t('dialog.confirmResetAccess'),
      };
    }
    if (currentAction.kind === 'name') {
      return {
        kicker: t('dialog.nameKicker'),
        title: t('dialog.nameTitle', { name: currentAction.user.name }),
        description: t('dialog.nameDescription'),
        confirm: t('dialog.confirmName'),
      };
    }
    if (currentAction.kind === 'role') {
      return {
        kicker: t('dialog.roleKicker'),
        title: t('dialog.roleTitle', {
          name: currentAction.user.name,
          role: t(`roles.${role}`),
        }),
        description: t('dialog.roleDescription'),
        confirm: t('dialog.confirmRole'),
      };
    }
    if (currentAction.kind === 'cancel_invitation') {
      return {
        kicker: t('dialog.cancelInvitationKicker'),
        title: t('dialog.cancelInvitationTitle', {
          name: currentAction.user.name,
        }),
        description: t('dialog.cancelInvitationDescription'),
        confirm: t('dialog.confirmCancelInvitation'),
      };
    }
    if (currentAction.kind === 'delete_account') {
      return {
        kicker: t('dialog.deleteAccountKicker'),
        title: t('dialog.deleteAccountTitle', {
          name: currentAction.user.name,
        }),
        description: t('dialog.deleteAccountDescription'),
        confirm: t('dialog.confirmDeleteAccount'),
      };
    }
    const activating = currentAction.status === 'active';
    const cancellingRecovery = !activating
      && currentAction.user.status === 'pending'
      && currentAction.user.setup?.purpose === 'credential_recovery';
    return {
      kicker: t('dialog.statusKicker'),
      title: t(activating
        ? 'dialog.reactivateTitle'
        : 'dialog.deactivateTitle', { name: currentAction.user.name }),
      description: t(activating
        ? 'dialog.reactivateDescription'
        : cancellingRecovery
          ? 'dialog.deactivateRecoveryDescription'
          : 'dialog.deactivateDescription'),
      confirm: t('dialog.confirmStatus'),
    };
  }

  function userActionItems(managedUser: ManagedUser): ActionMenuItem[] {
    const isCurrent = managedUser.id === input.data.user.id;
    const factorless = !managedUser.mfa.totp_configured;
    const nextStatus = managedUser.status === 'active'
      ? 'inactive' as const
      : managedUser.status === 'inactive' && !factorless
        ? 'active' as const
        : managedUser.setup?.purpose === 'credential_recovery'
          ? 'inactive' as const
          : null;
    const items: ActionMenuItem[] = [
      {
        id: 'name',
        kind: 'button',
        label: t('actions.editName'),
        icon: Pencil,
        onSelect: () => openAction({ kind: 'name', user: managedUser }),
      },
      {
        id: 'role',
        kind: 'button',
        label: t('actions.changeRole'),
        icon: UserRoundCog,
        onSelect: () => openAction({ kind: 'role', user: managedUser }),
      },
    ];
    if (nextStatus) {
      items.push({
        id: 'status',
        kind: 'button',
        label: t(nextStatus === 'active'
          ? 'actions.reactivate'
          : managedUser.setup?.purpose === 'credential_recovery'
            ? 'actions.deactivateRecovery'
            : 'actions.deactivate'),
        icon: nextStatus === 'active' ? UserRoundCheck : UserX,
        onSelect: () => openAction({
          kind: 'status',
          user: managedUser,
          status: nextStatus,
        }),
      });
    }
    if (
      managedUser.status === 'pending'
      && managedUser.setup?.purpose === 'credential_recovery'
    ) {
      items.push({
        id: 'reissue-recovery',
        kind: 'button',
        label: t('actions.reissueRecovery'),
        icon: Link2,
        onSelect: () => openAction({
          kind: 'reset_access',
          user: managedUser,
        }),
      });
    } else if (managedUser.status === 'pending' || factorless) {
      items.push({
        id: 'reissue',
        kind: 'button',
        label: t('actions.reissue'),
        icon: Link2,
        onSelect: () => openAction({ kind: 'reissue', user: managedUser }),
      });
    }
    if (!isCurrent && managedUser.status !== 'pending' && !factorless) {
      items.push({
        id: 'reset-access',
        kind: 'button',
        label: t('actions.resetAccess'),
        icon: KeyRound,
        onSelect: () => openAction({
          kind: 'reset_access',
          user: managedUser,
        }),
      });
    }
    if (
      !isCurrent
      && managedUser.status === 'pending'
      && managedUser.setup?.purpose === 'invitation'
    ) {
      items.push({
        id: 'cancel-invitation',
        kind: 'button',
        label: impactLoadingUserId === managedUser.id
          ? t('actions.checkingImpact')
          : t('actions.cancelInvitation'),
        icon: UserX,
        tone: 'critical',
        onSelect: () => void openDestructiveAction({
          kind: 'cancel_invitation',
          user: managedUser,
        }),
      });
    }
    if (!isCurrent && managedUser.status === 'inactive') {
      items.push({
        id: 'delete-account',
        kind: 'button',
        label: impactLoadingUserId === managedUser.id
          ? t('actions.checkingImpact')
          : t('actions.deleteAccount'),
        icon: Trash2,
        tone: 'critical',
        onSelect: () => void openDestructiveAction({
          kind: 'delete_account',
          user: managedUser,
        }),
      });
    }
    return items;
  }

  if (loadState.kind === 'loading') {
    return (
      <RouteLoading>{t('table.label')}</RouteLoading>
    );
  }

  if (loadState.kind === 'error') {
    return (
      <main id="studio-main-content">
        <PageHeader titleId="users-title" title={t('title')} />
        <Notice
          tone="error"
          actions={(
            <Button
              type="button"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              {t('retry')}
            </Button>
          )}
        >
          {t('errors.load')}
        </Notice>
      </main>
    );
  }

  const statuses: UserStatusFilter[] = [
    'all',
    'active',
    'pending',
    'inactive',
  ];
  const filtered = search !== ''
    || roleFilter !== 'all'
    || statusFilter !== 'all';
  const dialog = action ? dialogCopy(action) : null;
  const mfa = loadState.mfa;

  return (
    <main
      id="studio-main-content"
      aria-labelledby="users-title"
    >
      <PageHeader
        titleId="users-title"
        kicker={t('kicker')}
        title={t('title')}
        description={t('description')}
      />

      <div className="content-list-toolbar content-list-toolbar-editorial">
        <div className="content-list-toolbar-controls">
          <form
            className="content-list-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(searchInput.trim());
              setPage(1);
              setCompletion(null);
            }}
          >
            <Field
              label={t('filters.search')}
              labelHidden
              leading={<StudioIcon icon={Search} />}
            >
              {(control) => (
                <input
                  {...control}
                  type="search"
                  maxLength={200}
                  value={searchInput}
                  placeholder={t('filters.searchPlaceholder')}
                  onChange={(event) => setSearchInput(event.target.value)}
                />
              )}
            </Field>
            <Button type="submit">{t('filters.apply')}</Button>
          </form>

          <div className="content-list-select-filter">
            <Field label={t('filters.role')} labelHidden>
              {(control) => (
                <select
                  {...control}
                  value={roleFilter}
                  onChange={(event) => {
                    setRoleFilter(event.target.value as UserRoleFilter);
                    setPage(1);
                    setCompletion(null);
                  }}
                >
                  <option value="all">{t('filters.allRoles')}</option>
                  {SYSTEM_ROLE_KEYS.map((key) => (
                    <option key={key} value={key}>{t(`roles.${key}`)}</option>
                  ))}
                </select>
              )}
            </Field>
          </div>

          <div className="content-list-create-action">
            <Button
              type="button"
              variant="primary"
              onClick={() => openAction({ kind: 'invite' })}
            >
              <StudioIcon icon={UserPlus} className="content-list-button-icon" />
              {t('invite')}
            </Button>
          </div>
        </div>
        <FilterTabs
          label={t('filters.statusLabel')}
          value={statusFilter}
          items={statuses.map((value) => ({
            value,
            label: t(`statuses.${value}`),
            count: loadState.statusCounts[value],
          }))}
          onChange={(value) => {
            setStatusFilter(value);
            setPage(1);
            setCompletion(null);
          }}
        />
      </div>

      <dl
        className="content-list-metrics content-list-metrics-four"
        aria-label={t('summary.label')}
      >
        <div>
          <dt>{t('summary.total')}</dt>
          <dd>{numberFormatter.format(loadState.summary.total)}</dd>
        </div>
        <div>
          <dt>{t('summary.active')}</dt>
          <dd>{numberFormatter.format(loadState.summary.active)}</dd>
        </div>
        <div>
          <dt>{t('summary.pending')}</dt>
          <dd>{numberFormatter.format(loadState.summary.pending)}</dd>
        </div>
        <div>
          <dt>{t('summary.administrators')}</dt>
          <dd>{numberFormatter.format(loadState.summary.administrators)}</dd>
        </div>
      </dl>

      {impactFailure ? (
        <div className="users-message">
          <Notice tone="error">{errorMessage(impactFailure)}</Notice>
        </div>
      ) : null}

      {search ? (
        <p className="visually-hidden" role="status" aria-live="polite">
          {t('filters.resultAnnouncement', {
            count: loadState.pagination.total,
          })}
        </p>
      ) : null}

      {loadState.users.length === 0 ? (
        <EmptyState
          headingLevel={2}
          announce={filtered}
          title={t(filtered ? 'empty.filteredTitle' : 'empty.title')}
          description={t(filtered
            ? 'empty.filteredDescription'
            : 'empty.description')}
        />
      ) : (
        <DataTable
          caption={t('table.label')}
          minWidthPx={860}
          stacked="compact"
          framed
        >
          <thead>
            <tr>
              <th scope="col">{t('table.user')}</th>
              <th scope="col">{t('table.role')}</th>
              <th scope="col">{t('table.status')}</th>
              <th scope="col">{t('table.security')}</th>
              <th scope="col">{t('table.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loadState.users.map((managedUser) => {
              const isCurrent = managedUser.id === input.data.user.id;
              return (
                <tr key={managedUser.id}>
                  <td data-label={t('table.user')} data-stack="primary">
                    <span className="users-identity">
                      <IdentityAvatar
                        className="users-avatar"
                        name={managedUser.name}
                      />
                      <span className="users-cell">
                        <span className="users-identity-name">
                          {managedUser.name}
                          {isCurrent ? (
                            <StatusPill tone="positive">
                              {t('currentUser')}
                            </StatusPill>
                          ) : null}
                        </span>
                        <span className="users-cell-detail">
                          {managedUser.email}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td data-label={t('table.role')}>
                    <div className="users-cell">
                      <span>
                        <StatusPill tone="neutral">
                          {t(`roles.${managedUser.role}`)}
                        </StatusPill>
                      </span>
                      {managedUser.author ? (
                        <Link
                          className="users-author-link"
                          to={studioPostsByAuthorPath(managedUser.author.id)}
                        >
                          {t('table.linkedAuthor', {
                            author: managedUser.author.display_name,
                          })}
                        </Link>
                      ) : managedUser.role === 'author' ? (
                        <Link
                          className="users-author-link"
                          to={STUDIO_PATHS.authors}
                        >
                          {t('table.authorLinkRequired')}
                        </Link>
                      ) : null}
                    </div>
                  </td>
                  <td data-label={t('table.status')}>
                    <div className="users-cell">
                      <span>
                        <StatusPill tone={STATUS_TONES[managedUser.status]}>
                          {t(`statuses.${managedUser.status}`)}
                        </StatusPill>
                      </span>
                      {managedUser.setup ? (
                        <span className="users-cell-detail">
                          {t(
                            managedUser.setup.purpose === 'credential_recovery'
                              ? managedUser.setup.status === 'pending'
                                ? 'table.recoveryPending'
                                : 'table.recoveryExpired'
                              : managedUser.setup.status === 'pending'
                                ? 'table.invitationPending'
                                : 'table.invitationExpired',
                            {
                              date: dateFormatter.format(
                                new Date(managedUser.setup.expires_at_iso),
                              ),
                            },
                          )}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td data-label={t('table.security')} data-stack="wide">
                    <div className="users-security">
                      <StudioIcon
                        icon={managedUser.mfa.totp_configured
                          ? ShieldCheck
                          : ShieldAlert}
                        className={managedUser.mfa.totp_configured
                          ? 'users-security-icon users-security-icon-ready'
                          : 'users-security-icon users-security-icon-missing'}
                      />
                      <span className="users-cell">
                        <span className="users-cell-primary">
                          {t(managedUser.mfa.totp_configured
                            ? 'table.totpReady'
                            : 'table.totpMissing')}
                        </span>
                        <span className="users-cell-detail">
                          {managedUser.active_sessions > 0
                            ? t('table.sessions', {
                              count: managedUser.active_sessions,
                            })
                            : t('table.noSessions')}
                        </span>
                        {managedUser.mfa.totp_configured ? (
                          <span className="users-cell-detail">
                            {t('table.passkeys', {
                              count: managedUser.mfa.webauthn_credentials,
                            })}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </td>
                  <td data-label={t('table.actions')} data-stack="actions">
                    <div className="content-list-row-actions">
                      <ActionMenu
                        label={t('actions.menuLabel', {
                          name: managedUser.name,
                        })}
                        items={userActionItems(managedUser)}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      )}

      {loadState.pagination.total_pages > 1 ? (
        <div className="content-list-pagination">
          <Pagination
            label={t('pagination.label')}
            position={t('pagination.position', {
              page: loadState.pagination.page,
              pages: loadState.pagination.total_pages,
            })}
            previousLabel={t('pagination.previous')}
            nextLabel={t('pagination.next')}
            page={loadState.pagination.page}
            totalPages={loadState.pagination.total_pages}
            onChange={setPage}
          />
        </div>
      ) : null}

      <Dialog
        open={action !== null && dialog !== null}
        onClose={closeAction}
        busy={running}
        size={action?.kind === 'invite'
          || action?.kind === 'cancel_invitation'
          || action?.kind === 'delete_account'
          ? 'wide'
          : 'default'}
        kicker={dialog?.kicker ?? ''}
        title={dialog?.title ?? ''}
        description={dialog?.description}
      >
        <form className="users-dialog-form" onSubmit={submitAction}>
          {action?.kind === 'invite' ? (
            <div className="users-dialog-grid">
              <Field label={t('dialog.name')}>
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    autoComplete="name"
                    minLength={2}
                    maxLength={100}
                    value={name}
                    disabled={running}
                    required
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
              </Field>
              <Field label={t('dialog.email')}>
                {(control) => (
                  <input
                    {...control}
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    value={email}
                    disabled={running}
                    required
                    onChange={(event) => setEmail(event.target.value)}
                  />
                )}
              </Field>
              <div className="users-field-wide">
                <Field
                  label={t('dialog.role')}
                  hint={t(`roleDescriptions.${role}`)}
                >
                  {(control) => (
                    <select
                      {...control}
                      value={role}
                      disabled={running}
                      onChange={(event) => setRole(
                        event.target.value as UserRole,
                      )}
                    >
                      {SYSTEM_ROLE_KEYS.map((key) => (
                        <option key={key} value={key}>{t(`roles.${key}`)}</option>
                      ))}
                    </select>
                  )}
                </Field>
              </div>
            </div>
          ) : null}

          {action?.kind === 'name' ? (
            <div className="users-change-fields">
              <div className="users-management-identity">
                <strong className="users-management-identity-name">
                  {action.user.name}
                </strong>
                <span className="users-management-identity-email">
                  {action.user.email}
                </span>
              </div>
              <Field
                label={t('dialog.name')}
                hint={action.user.author
                  ? t('dialog.publicAuthorNameUnchanged', {
                    author: action.user.author.display_name,
                  })
                  : t('dialog.accountNameOnly')}
              >
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    autoComplete="name"
                    minLength={2}
                    maxLength={100}
                    value={name}
                    disabled={running}
                    required
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
              </Field>
            </div>
          ) : null}

          {action?.kind === 'role' ? (
            <div className="users-change-fields">
              <dl className="users-change-summary">
                <div>
                  <dt>{t('dialog.currentRole')}</dt>
                  <dd>{t(`roles.${action.user.role}`)}</dd>
                </div>
                <div>
                  <dt>{t('dialog.activeSessions')}</dt>
                  <dd>{action.user.active_sessions}</dd>
                </div>
              </dl>
              <Field
                label={t('dialog.newRole')}
                hint={t(`roleDescriptions.${role}`)}
              >
                {(control) => (
                  <select
                    {...control}
                    value={role}
                    disabled={running}
                    onChange={(event) => setRole(
                      event.target.value as UserRole,
                    )}
                  >
                    {SYSTEM_ROLE_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {t(`roles.${key}`)}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {role === 'author' && !action.user.author ? (
                <Notice tone="info">
                  {t('dialog.authorRoleWithoutProfile')}
                </Notice>
              ) : null}
            </div>
          ) : null}

          {action?.kind === 'status' ? (
            <div className="users-change-fields">
              <dl className="users-change-summary">
                <div>
                  <dt>{t('dialog.currentStatus')}</dt>
                  <dd>{t(`statuses.${action.user.status}`)}</dd>
                </div>
                <div>
                  <dt>{t('dialog.newStatus')}</dt>
                  <dd>{t(`statuses.${action.status}`)}</dd>
                </div>
                <div>
                  <dt>{t('dialog.activeSessions')}</dt>
                  <dd>{action.user.active_sessions}</dd>
                </div>
              </dl>
            </div>
          ) : null}

          {action?.kind === 'cancel_invitation'
            || action?.kind === 'delete_account' ? (
              <div className="users-deletion-impact">
                <Notice tone="warning">
                  {action.kind === 'cancel_invitation'
                    ? t('dialog.cancelInvitationWarning')
                    : t('dialog.deleteAccountWarning')}
                </Notice>
                <dl className="users-deletion-impact-list">
                  <div>
                    <dt>{t('dialog.preservedAuthor')}</dt>
                    <dd>{action.impact.user.author
                      ? t('dialog.preservedAuthorValue', {
                        author: action.impact.user.author.display_name,
                      })
                      : t('dialog.noLinkedAuthor')}</dd>
                  </div>
                  <div>
                    <dt>{t('dialog.postRecoveryCopies')}</dt>
                    <dd>{action.impact.effects.post_autosaves}</dd>
                  </div>
                  <div>
                    <dt>{t('dialog.pageRecoveryCopies')}</dt>
                    <dd>{action.impact.effects.page_autosaves}</dd>
                  </div>
                  <div>
                    <dt>{t('dialog.pendingUploads')}</dt>
                    <dd>{action.impact.effects.media_upload_intents}</dd>
                  </div>
                </dl>
                <Field
                  label={t('dialog.confirmationEmail')}
                  hint={t('dialog.confirmationEmailHint', {
                    email: action.user.email,
                  })}
                >
                  {(control) => (
                    <input
                      {...control}
                      type="email"
                      autoComplete="off"
                      value={confirmationEmail}
                      disabled={running}
                      required
                      onChange={(event) => setConfirmationEmail(
                        event.target.value,
                      )}
                    />
                  )}
                </Field>
                {action.kind === 'delete_account'
                  && action.impact.effects.post_autosaves
                    + action.impact.effects.page_autosaves > 0 ? (
                    <label className="users-deletion-acknowledgement">
                      <input
                        type="checkbox"
                        checked={recoveryDeletionAcknowledged}
                        disabled={running}
                        onChange={(event) => setRecoveryDeletionAcknowledged(
                          event.target.checked,
                        )}
                      />
                      <span>{t('dialog.recoveryDeletionAcknowledgement', {
                        count: action.impact.effects.post_autosaves
                          + action.impact.effects.page_autosaves,
                      })}</span>
                    </label>
                  ) : null}
              </div>
            ) : null}

          <Field label={t('dialog.password')} hint={t('dialog.passwordHint')}>
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

          {mfa.step_up.mfa_required ? (
            <fieldset className="users-verification">
              <legend className="users-verification-legend">
                {t('dialog.verification')}
              </legend>
              <div className="users-verification-methods">
                {VERIFICATION_METHODS
                  .filter(({ value }) => value !== 'webauthn'
                    || (webAuthnSupported && mfa.webauthn.credentials.length > 0))
                  .map(({ value, labelKey }) => (
                    <label className="users-verification-option" key={value}>
                      <input
                        type="radio"
                        name="users-verification-method"
                        value={value}
                        checked={verificationMethod === value}
                        disabled={running}
                        onChange={() => setVerificationMethod(value)}
                      />
                      {t(labelKey)}
                    </label>
                  ))}
              </div>
              {verificationMethod !== 'webauthn' ? (
                <Field label={t('dialog.verificationCode')}>
                  {(control) => (
                    <input
                      {...control}
                      type="text"
                      inputMode={verificationMethod === 'totp'
                        ? 'numeric'
                        : 'text'}
                      autoComplete="one-time-code"
                      maxLength={verificationMethod === 'totp' ? 6 : 19}
                      value={verificationCode}
                      disabled={running}
                      required
                      onChange={(event) => setVerificationCode(
                        verificationMethod === 'totp'
                          ? event.target.value.replace(/\D/gu, '').slice(0, 6)
                          : event.target.value.toUpperCase(),
                      )}
                    />
                  )}
                </Field>
              ) : null}
            </fieldset>
          ) : null}

          {failure ? (
            <Notice tone="error">{errorMessage(failure)}</Notice>
          ) : null}

          <DialogActions>
            <Button type="button" disabled={running} onClick={closeAction}>
              {t('dialog.cancel')}
            </Button>
            <Button
              type="submit"
              variant={action?.kind === 'cancel_invitation'
                || action?.kind === 'delete_account'
                || (action?.kind === 'status'
                  && action.status === 'inactive')
                ? 'danger'
                : 'primary'}
              disabled={running
                || (action?.kind === 'name'
                  && name.trim() === action.user.name)
                || (action?.kind === 'role'
                  && role === action.user.role)}
            >
              {running ? t('dialog.running') : dialog?.confirm}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <Dialog
        open={setupResult !== null}
        onClose={closeSetupResult}
        size="wide"
        title={setupResult?.purpose === 'credential_recovery'
          ? t('result.recoveryTitle')
          : t('result.invitationTitle')}
        description={setupResult?.purpose === 'credential_recovery'
          ? t('result.recoveryDescription')
          : t('result.invitationDescription')}
        actions={(
          <>
            <Button type="button" onClick={() => void copySetupUrl()}>
              {copyState === 'copied' ? t('result.copied') : t('result.copy')}
            </Button>
            <Button type="button" variant="primary" onClick={closeSetupResult}>
              {t('result.dismiss')}
            </Button>
          </>
        )}
      >
        <div className="users-result">
          <Field label={t('result.setupUrl')}>
            {(control) => (
              <textarea
                {...control}
                className="users-setup-url"
                value={setupResult?.setupUrl ?? ''}
                rows={4}
                readOnly
                spellCheck={false}
              />
            )}
          </Field>
          <p className="users-result-expiry">
            {t('result.expires', {
              date: setupResult
                ? dateFormatter.format(new Date(setupResult.expiresAtIso))
                : '',
            })}
          </p>
          {copyState === 'failed' ? (
            <Notice tone="error">{t('result.copyFailed')}</Notice>
          ) : null}
        </div>
      </Dialog>
    </main>
  );
}

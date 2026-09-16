import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
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
import type { ApiErrorCode } from '../../contracts/api';
import type {
  MfaManagementOperation,
  MfaManagementStatusResponse,
  MfaManagementVerification,
} from '../../contracts/mfa-management';
import type {
  WebAuthnCredentialSummary,
} from '../../contracts/webauthn';
import {
  MfaManagementClientError,
  requestManagedWebAuthnRegistrationComplete,
  requestManagedWebAuthnRegistrationOptions,
  requestManagedWebAuthnRemove,
  requestManagedWebAuthnRename,
  requestMfaManagementAuthorization,
  requestMfaManagementStatus,
  requestMfaManagementWebAuthnStepUpOptions,
  requestMfaManagementWebAuthnStepUpVerification,
  type MfaManagementClientErrorCode,
} from './lib/mfa-management-client';
import { getPasskeyAuthenticatorName } from './lib/passkey-authenticator';
import { STUDIO_PATHS } from './routing/studio-routes';
import {
  Button,
  Dialog,
  DialogActions,
  EmptyState,
  Field,
  Notice,
  PageHeader,
  Panel,
  Spinner,
  StatusPill,
} from './components/primitives';
import { StepUpVerification } from './components/StepUpVerification';

type AccountSession = {
  csrf_token: string;
};

type ReadyStatus = Extract<
  MfaManagementStatusResponse,
  { success: true }
>['data'];

type CredentialAction =
  | { kind: 'add' }
  | { kind: 'rename'; credential: WebAuthnCredentialSummary }
  | { kind: 'remove'; credential: WebAuthnCredentialSummary };

type ProtectedCredentialAction = Exclude<
  CredentialAction,
  { kind: 'rename' }
>;

type VerificationMethod =
  | MfaManagementVerification['method']
  | 'webauthn';

type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: MfaManagementClientErrorCode }
  | {
    kind: 'validation';
    field: 'password' | 'name' | 'verification' | 'webauthn';
  }
  | { kind: 'unexpected' };

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: ReadyStatus }
  | { kind: 'error'; failure: Failure };

type Completion =
  | { kind: 'added'; name: string }
  | { kind: 'renamed'; name: string }
  | { kind: 'removed'; name: string; revokedSessions: number };

function clientFailure(error: unknown): Failure {
  return error instanceof MfaManagementClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

function operationForAction(
  action: ProtectedCredentialAction,
): MfaManagementOperation {
  if (action.kind === 'add') return 'add_webauthn';
  return 'remove_webauthn';
}

function targetForAction(
  action: ProtectedCredentialAction,
): string | undefined {
  return action.kind === 'add' ? undefined : action.credential.id;
}

export function WebAuthnManagementPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('security');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({
    kind: 'loading',
  });
  const [action, setAction] = useState<CredentialAction | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [verificationMethod, setVerificationMethod] =
    useState<VerificationMethod>('totp');
  const [verificationCode, setVerificationCode] = useState('');
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [webAuthnSupported] = useState(() => browserSupportsWebAuthn());
  const runningRef = useRef(running);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    {
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  ), [i18n.resolvedLanguage]);
  runningRef.current = running;

  useStudioDocumentTitle(t('webauthn.documentTitle'));

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
      return t(`webauthn.validation.${value.field}`);
    }
    if (value.kind === 'client') {
      if (value.code === 'TIMEOUT') return t('webauthn.errors.timeout');
      if (value.code === 'NETWORK_ERROR') {
        return t('webauthn.errors.network');
      }
      return t('webauthn.errors.invalidResponse');
    }
    if (value.kind === 'unexpected') {
      return t('webauthn.errors.unexpected');
    }
    if (value.code === 'INVALID_CURRENT_PASSWORD') {
      return t('management.errors.invalidPassword');
    }
    if (
      value.code === 'INVALID_MFA_CODE'
      || value.code === 'WEBAUTHN_VERIFICATION_FAILED'
    ) {
      return t('webauthn.errors.invalidVerification');
    }
    if (
      value.code === 'MFA_MANAGEMENT_CHALLENGE_INVALID'
      || value.code === 'WEBAUTHN_CHALLENGE_INVALID'
      || value.code === 'MFA_CHALLENGE_INVALID'
    ) {
      return t('webauthn.errors.expired');
    }
    if (value.code === 'WEBAUTHN_CREDENTIAL_LIMIT_REACHED') {
      return t('webauthn.errors.limit');
    }
    if (value.code === 'WEBAUTHN_CREDENTIAL_NAME_CONFLICT') {
      return t('webauthn.errors.nameConflict');
    }
    if (value.code === 'WEBAUTHN_CREDENTIAL_ALREADY_REGISTERED') {
      return t('webauthn.errors.alreadyRegistered');
    }
    if (value.code === 'WEBAUTHN_CREDENTIAL_NOT_FOUND') {
      return t('webauthn.errors.notFound');
    }
    if (value.code === 'RATE_LIMIT_EXCEEDED') {
      return t('management.errors.rateLimit');
    }
    if (value.code === 'MFA_STEP_UP_REQUIRED') {
      return t('management.errors.stepUpRequired');
    }
    return t('webauthn.errors.api');
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

  function openAction(nextAction: CredentialAction): void {
    setAction(nextAction);
    setDisplayName(
      nextAction.kind === 'rename'
        ? nextAction.credential.display_name
        : '',
    );
    setPassword('');
    setVerificationMethod('totp');
    setVerificationCode('');
    setFailure(null);
    setCompletion(null);
  }

  function closeAction(): void {
    if (running) return;
    setAction(null);
    setDisplayName('');
    setPassword('');
    setVerificationCode('');
    setFailure(null);
  }

  async function authorizeAction(
    currentAction: ProtectedCredentialAction,
    status: ReadyStatus,
  ): Promise<string | null> {
    const operation = operationForAction(currentAction);
    const targetId = targetForAction(currentAction);
    if (
      status.step_up.mfa_required
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
        handleApiError(options.error.code);
        return null;
      }
      let assertion;
      try {
        assertion = await startAuthentication({
          optionsJSON: options.data.options,
        });
      } catch {
        setFailure({ kind: 'validation', field: 'webauthn' });
        return null;
      }
      const authorization =
        await requestMfaManagementWebAuthnStepUpVerification(
          input.data.csrf_token,
          {
            operation,
            ...(targetId ? { target_id: targetId } : {}),
            challenge_token: options.data.challenge_token,
            response: assertion,
          },
        );
      if (!authorization.success) {
        handleApiError(authorization.error.code);
        return null;
      }
      return authorization.data.management_token;
    }

    const verification = status.step_up.mfa_required
      ? {
        method: verificationMethod,
        code: verificationCode.replace(/\D/gu, ''),
      } as MfaManagementVerification
      : undefined;
    const authorization = await requestMfaManagementAuthorization(
      input.data.csrf_token,
      {
        operation,
        ...(targetId ? { target_id: targetId } : {}),
        password,
        ...(verification ? { verification } : {}),
      },
    );
    if (!authorization.success) {
      handleApiError(authorization.error.code);
      return null;
    }
    return authorization.data.management_token;
  }

  async function executeAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      running
      || !action
      || loadState.kind !== 'ready'
    ) {
      return;
    }
    if (action.kind !== 'rename' && !password) {
      setFailure({ kind: 'validation', field: 'password' });
      return;
    }
    const normalizedName = displayName.trim();
    if (
      action.kind !== 'remove'
      && (normalizedName.length < 1 || normalizedName.length > 100)
    ) {
      setFailure({ kind: 'validation', field: 'name' });
      return;
    }
    if (
      action.kind !== 'rename'
      && loadState.status.step_up.mfa_required
      && verificationMethod !== 'webauthn'
      && !/^[0-9]{6}$/u.test(verificationCode)
    ) {
      setFailure({ kind: 'validation', field: 'verification' });
      return;
    }

    setRunning(true);
    setFailure(null);
    try {
      if (action.kind === 'rename') {
        const response = await requestManagedWebAuthnRename(
          input.data.csrf_token,
          {
            credential_id: action.credential.id,
            display_name: normalizedName,
          },
        );
        if (!response.success) {
          handleApiError(response.error.code);
          return;
        }
        setCompletion({
          kind: 'renamed',
          name: response.data.credential.display_name,
        });
      } else {
        const managementToken = await authorizeAction(
          action,
          loadState.status,
        );
        if (!managementToken) return;

        if (action.kind === 'add') {
          const options = await requestManagedWebAuthnRegistrationOptions(
            input.data.csrf_token,
            managementToken,
          );
          if (!options.success) {
            handleApiError(options.error.code);
            return;
          }
          let registration;
          try {
            registration = await startRegistration({
              optionsJSON: options.data.options,
            });
          } catch {
            setFailure({ kind: 'validation', field: 'webauthn' });
            return;
          }
          const response = await requestManagedWebAuthnRegistrationComplete(
            input.data.csrf_token,
            {
              management_token: managementToken,
              challenge_token: options.data.challenge_token,
              display_name: normalizedName,
              response: registration,
            },
          );
          if (!response.success) {
            handleApiError(response.error.code);
            return;
          }
          setCompletion({
            kind: 'added',
            name: response.data.credential.display_name,
          });
        } else {
          const response = await requestManagedWebAuthnRemove(
            input.data.csrf_token,
            {
              credential_id: action.credential.id,
              management_token: managementToken,
            },
          );
          if (!response.success) {
            handleApiError(response.error.code);
            return;
          }
          setCompletion({
            kind: 'removed',
            name: action.credential.display_name,
            revokedSessions: response.data.revoked_sessions,
          });
        }
      }
      setAction(null);
      setDisplayName('');
      setPassword('');
      setVerificationCode('');
      setLoadAttempt((value) => value + 1);
    } catch (error) {
      setFailure(clientFailure(error));
    } finally {
      setRunning(false);
    }
  }

  const ready = loadState.kind === 'ready' ? loadState.status : null;
  const currentRpCredentials = ready
    ? ready.webauthn.credentials.filter(
      (credential) =>
        credential.rp_id === ready.webauthn.current_rp_id,
    )
    : [];
  const canUseWebAuthnForStepUp = webAuthnSupported
    && currentRpCredentials.length > 0;

  return (
    <main
      id="studio-main-content"
      aria-labelledby="webauthn-management-title"
    >
      <Link className="account-back" to={STUDIO_PATHS.accountSecurity}>
        <span aria-hidden="true">←</span>
        {t('management.back')}
      </Link>
      <PageHeader
        titleId="webauthn-management-title"
        kicker={t('management.kicker')}
        title={t('webauthn.title')}
        description={t('webauthn.description')}
        actions={ready ? (
          <Button
            type="button"
            variant="primary"
            disabled={!webAuthnSupported
              || ready.webauthn.credentials.length
                >= ready.webauthn.max_credentials}
            onClick={() => openAction({ kind: 'add' })}
          >
            {t('webauthn.add')}
          </Button>
        ) : undefined}
      />

      <div className="account-stack">
        {!webAuthnSupported ? (
          <Notice tone="error" title={t('webauthn.unsupportedTitle')}>
            {t('webauthn.unsupportedDescription')}
          </Notice>
        ) : null}

        {loadState.kind === 'loading' ? (
          <Panel>
            <div className="account-state" role="status">
              <Spinner size="lg" />
              <div className="account-state-text">
                <strong className="account-state-title">
                  {t('webauthn.loadingTitle')}
                </strong>
                <p className="account-state-detail">
                  {t('webauthn.loadingMessage')}
                </p>
              </div>
            </div>
          </Panel>
        ) : null}

        {loadState.kind === 'error' ? (
          <Notice
            tone="error"
            title={t('webauthn.loadErrorTitle')}
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

        {completion ? (
          <Notice
            tone="success"
            title={t(`webauthn.completion.${completion.kind}Title`)}
          >
            {t(`webauthn.completion.${completion.kind}Description`, {
              name: completion.name,
              count: completion.kind === 'removed'
                ? completion.revokedSessions
                : 0,
            })}
          </Notice>
        ) : null}

        {ready ? (
          <Panel
            title={t('webauthn.listTitle')}
            description={t('webauthn.listDescription', {
              count: ready.webauthn.credentials.length,
              max: ready.webauthn.max_credentials,
              rpId: ready.webauthn.current_rp_id,
            })}
          >
            {ready.webauthn.credentials.length === 0 ? (
              <EmptyState
                title={t('webauthn.emptyTitle')}
                description={t('webauthn.emptyDescription')}
              />
            ) : (
              <div className="account-credential-list">
                {ready.webauthn.credentials.map((credential) => {
                  const currentHost =
                    credential.rp_id === ready.webauthn.current_rp_id;
                  const authenticatorName = getPasskeyAuthenticatorName(credential.aaguid);
                  return (
                    <article
                      className="account-credential"
                      key={credential.id}
                    >
                      <div className="account-credential-body">
                        <div className="account-credential-title">
                          <h3 className="account-credential-name">
                            {credential.display_name}
                          </h3>
                          <StatusPill
                            tone={currentHost ? 'positive' : 'attention'}
                          >
                            {currentHost
                              ? t('webauthn.currentHost')
                              : t('webauthn.otherHost')}
                          </StatusPill>
                        </div>
                        {authenticatorName ? (
                          <p className="account-credential-authenticator">
                            {t('webauthn.authenticator', { name: authenticatorName })}
                          </p>
                        ) : null}
                        <dl className="account-credential-meta">
                          <div>
                            <dt>{t('webauthn.fields.rpId')}</dt>
                            <dd>{credential.rp_id}</dd>
                          </div>
                          <div>
                            <dt>{t('webauthn.fields.attestationFormat')}</dt>
                            <dd>{credential.attestation_format}</dd>
                          </div>
                          <div>
                            <dt>{t('webauthn.fields.aaguid')}</dt>
                            <dd>
                              {credential.aaguid
                                ?? t('webauthn.metadataUnavailable')}
                            </dd>
                          </div>
                          <div>
                            <dt>{t('webauthn.fields.created')}</dt>
                            <dd>
                              {dateFormatter.format(
                                new Date(credential.created_at_iso),
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>{t('webauthn.fields.lastUsed')}</dt>
                            <dd>
                              {credential.last_used_at_iso
                                ? dateFormatter.format(
                                  new Date(credential.last_used_at_iso),
                                )
                                : t('webauthn.neverUsed')}
                            </dd>
                          </div>
                          <div>
                            <dt>{t('webauthn.fields.backup')}</dt>
                            <dd>
                              {credential.backed_up
                                ? t('webauthn.backedUp')
                                : t('webauthn.notBackedUp')}
                            </dd>
                          </div>
                        </dl>
                      </div>
                      <div className="account-credential-actions">
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => openAction({
                            kind: 'rename',
                            credential,
                          })}
                        >
                          {t('webauthn.rename')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="danger"
                          onClick={() => openAction({
                            kind: 'remove',
                            credential,
                          })}
                        >
                          {t('webauthn.remove')}
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </Panel>
        ) : null}
      </div>

      <Dialog
        open={action !== null && ready !== null}
        onClose={closeAction}
        busy={running}
        kicker={action?.kind === 'rename'
          ? t('webauthn.dialog.rename.kicker')
          : t('webauthn.dialog.kicker')}
        title={action ? t(`webauthn.dialog.${action.kind}.title`) : ''}
        description={action
          ? t(`webauthn.dialog.${action.kind}.description`, {
            name: action.kind === 'add' ? '' : action.credential.display_name,
          })
          : undefined}
      >
        <form
          className="account-dialog-form"
          onSubmit={(event) => void executeAction(event)}
        >
          {action && action.kind !== 'remove' ? (
            <Field label={t('webauthn.dialog.displayName')}>
              {(control) => (
                <input
                  {...control}
                  type="text"
                  maxLength={100}
                  value={displayName}
                  disabled={running}
                  required
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              )}
            </Field>
          ) : null}
          {action?.kind !== 'rename' ? (
            <>
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
                name="webauthn-management-mfa-method"
                required={ready?.step_up.mfa_required ?? false}
                method={verificationMethod}
                onMethodChange={setVerificationMethod}
                code={verificationCode}
                onCodeChange={setVerificationCode}
                webAuthnAvailable={canUseWebAuthnForStepUp}
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
            </>
          ) : null}
          {failure ? (
            <Notice tone="error">{errorMessage(failure)}</Notice>
          ) : null}
          <DialogActions>
            <Button type="button" disabled={running} onClick={closeAction}>
              {t('management.cancel')}
            </Button>
            <Button
              type="submit"
              variant={action?.kind === 'remove' ? 'danger' : 'primary'}
              disabled={running}
            >
              {running
                ? action?.kind === 'rename'
                  ? t('webauthn.dialog.rename.running')
                  : t('webauthn.dialog.running')
                : action
                  ? t(`webauthn.dialog.${action.kind}.confirm`)
                  : ''}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </main>
  );
}

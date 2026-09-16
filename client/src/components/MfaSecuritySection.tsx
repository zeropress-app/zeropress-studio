import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Smartphone } from 'lucide-react';
import type { MfaManagementStatusResponse } from '../../../contracts/mfa-management';
import {
  MfaManagementClientError,
  requestMfaManagementStatus,
} from '../lib/mfa-management-client';
import { STUDIO_PATHS } from '../routing/studio-routes';
import {
  Button,
  ButtonLink,
  Callout,
  Notice,
  Panel,
  Spinner,
  StudioIcon,
  StatusPill,
} from './primitives';

type ReadyStatus = Extract<
  MfaManagementStatusResponse,
  { success: true }
>['data'];

type StatusErrorMessageKey =
  | 'mfa.errors.notConfigured'
  | 'mfa.errors.load'
  | 'mfa.errors.timeout'
  | 'mfa.errors.network';

type StatusState =
  | { kind: 'loading' }
  | { kind: 'ready'; data: ReadyStatus }
  | { kind: 'error'; messageKey: StatusErrorMessageKey };

export function MfaSecuritySection(input: {
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('security');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [state, setState] = useState<StatusState>({ kind: 'loading' });
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    {
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  ), [i18n.resolvedLanguage]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ kind: 'loading' });
    void requestMfaManagementStatus(controller.signal)
      .then((response) => {
        if (!active) return;
        if (response.success) {
          setState({ kind: 'ready', data: response.data });
          return;
        }
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setState({
          kind: 'error',
          messageKey: response.error.code === 'MFA_NOT_CONFIGURED'
            ? 'mfa.errors.notConfigured'
            : 'mfa.errors.load',
        });
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        setState({
          kind: 'error',
          messageKey: error instanceof MfaManagementClientError
            && error.code === 'TIMEOUT'
            ? 'mfa.errors.timeout'
            : 'mfa.errors.network',
        });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [input.onSessionEnded, loadAttempt]);

  const ready = state.kind === 'ready' ? state.data : null;

  return (
    <Panel
      title={t('mfa.title')}
      description={t('mfa.description')}
      actions={<StatusPill tone="positive">{t('mfa.required')}</StatusPill>}
    >
      {state.kind === 'loading' ? (
        <div className="account-state" role="status">
          <Spinner size="lg" />
          <div className="account-state-text">
            <strong className="account-state-title">
              {t('mfa.loadingTitle')}
            </strong>
            <p className="account-state-detail">{t('mfa.loadingMessage')}</p>
          </div>
        </div>
      ) : null}

      {state.kind === 'error' ? (
        <Notice
          tone="error"
          title={t('mfa.errors.title')}
          actions={(
            <Button
              type="button"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              {t('loadError.retry')}
            </Button>
          )}
        >
          {t(state.messageKey)}
        </Notice>
      ) : null}

      {ready ? (
        <>
          <div className="account-mfa-grid">
            <article className="account-mfa-card">
              <p className="account-mfa-icon" aria-hidden="true">
                <StudioIcon icon={Smartphone} />
              </p>
              <div className="account-mfa-body">
                <p className="account-mfa-method">
                  {t('mfa.authenticator.method')}
                </p>
                <h3 className="account-mfa-name">
                  {t('mfa.authenticator.title')}
                </h3>
                <p className="account-mfa-detail">
                  {t('mfa.authenticator.configured', {
                    date: dateFormatter.format(
                      new Date(ready.totp.configured_at_iso),
                    ),
                  })}
                </p>
              </div>
              <div className="account-mfa-action">
                <ButtonLink size="sm" to={STUDIO_PATHS.mfaReplace}>
                  {t('mfa.authenticator.action')}
                </ButtonLink>
              </div>
            </article>

            <article className="account-mfa-card">
              <p className="account-mfa-icon" aria-hidden="true">
                <StudioIcon icon={KeyRound} />
              </p>
              <div className="account-mfa-body">
                <p className="account-mfa-method">{t('mfa.webauthn.method')}</p>
                <h3 className="account-mfa-name">{t('mfa.webauthn.title')}</h3>
                <p className="account-mfa-detail">
                  {t('mfa.webauthn.configured', {
                    count: ready.webauthn.credentials.length,
                    max: ready.webauthn.max_credentials,
                  })}
                </p>
              </div>
              <div className="account-mfa-action">
                <ButtonLink size="sm" to={STUDIO_PATHS.webAuthnCredentials}>
                  {t('mfa.webauthn.action')}
                </ButtonLink>
              </div>
            </article>

          </div>
          <div className="account-mfa-note">
            <Callout tone="info">{t('mfa.sessionNote')}</Callout>
          </div>
        </>
      ) : null}
    </Panel>
  );
}

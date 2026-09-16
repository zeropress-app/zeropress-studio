import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import type {
  CurrentSessionSuccess,
  SessionListItem,
} from '../../contracts/session';
import {
  requestRevokeOtherSessions,
  requestRevokeSession,
  requestSessionList,
  SessionClientError,
  type SessionClientErrorCode,
} from './lib/session-client';
import { MfaSecuritySection } from './components/MfaSecuritySection';
import { STUDIO_PATHS } from './routing/studio-routes';
import {
  Button,
  ButtonLink,
  Dialog,
  Notice,
  PageHeader,
  Panel,
  Spinner,
  StatusPill,
} from './components/primitives';

type AccountSession = CurrentSessionSuccess['data'];

type RequestFailure =
  | { kind: 'api' }
  | { kind: 'client'; code: SessionClientErrorCode }
  | { kind: 'unexpected' };

type SessionListState =
  | { kind: 'loading' }
  | {
    kind: 'ready';
    items: SessionListItem[];
    maxSessions: number;
  }
  | { kind: 'error'; failure: RequestFailure };

type Confirmation =
  | { kind: 'session'; item: SessionListItem }
  | { kind: 'others' };

type CompletionNotice =
  | { kind: 'session' }
  | { kind: 'others'; count: number };

function requestFailure(error: unknown): RequestFailure {
  return error instanceof SessionClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

export function AccountSecurityPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
  onSignedOut?: () => void;
}) {
  const { t, i18n } = useTranslation('security');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [list, setList] = useState<SessionListState>({
    kind: 'loading',
  });
  const [confirmation, setConfirmation] =
    useState<Confirmation | null>(null);
  const [running, setRunning] = useState(false);
  const [actionFailure, setActionFailure] =
    useState<RequestFailure | null>(null);
  const [completion, setCompletion] =
    useState<CompletionNotice | null>(null);
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(
    i18n.resolvedLanguage,
    {
      dateStyle: 'medium',
      timeStyle: 'short',
    },
  ), [i18n.resolvedLanguage]);

  useStudioDocumentTitle(t('documentTitle'));

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setList({ kind: 'loading' });

    void requestSessionList(controller.signal)
      .then((response) => {
        if (!active) return;
        if (response.success) {
          setList({
            kind: 'ready',
            items: response.data.items,
            maxSessions: response.data.max_sessions,
          });
          return;
        }
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setList({ kind: 'error', failure: { kind: 'api' } });
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        setList({ kind: 'error', failure: requestFailure(error) });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [input.onSessionEnded, loadAttempt]);

  function openConfirmation(value: Confirmation) {
    setCompletion(null);
    setActionFailure(null);
    setConfirmation(value);
  }

  function actionErrorMessage(failure: RequestFailure | null): string | null {
    if (!failure) return null;
    if (failure.kind === 'api') return t('errors.api');
    if (failure.kind === 'unexpected') return t('errors.unexpected');
    if (failure.code === 'TIMEOUT') return t('errors.timeout');
    if (failure.code === 'NETWORK_ERROR') return t('errors.network');
    return t('errors.invalidResponse');
  }

  async function executeConfirmation() {
    if (!confirmation || running) return;
    setRunning(true);
    setActionFailure(null);
    try {
      if (confirmation.kind === 'session') {
        const response = await requestRevokeSession(
          input.data.csrf_token,
          confirmation.item.id,
        );
        if (!response.success) {
          if (response.error.code === 'AUTHENTICATION_REQUIRED') {
            input.onSessionEnded();
            return;
          }
          setActionFailure({ kind: 'api' });
          return;
        }
        if (response.data.current_session_ended) {
          (input.onSignedOut ?? input.onSessionEnded)();
          return;
        }
        setList((current) => current.kind === 'ready'
          ? {
            ...current,
            items: current.items.filter(
              (item) => item.id !== confirmation.item.id,
            ),
          }
          : current);
        setCompletion({ kind: 'session' });
      } else {
        const response = await requestRevokeOtherSessions(
          input.data.csrf_token,
        );
        if (!response.success) {
          if (response.error.code === 'AUTHENTICATION_REQUIRED') {
            input.onSessionEnded();
            return;
          }
          setActionFailure({ kind: 'api' });
          return;
        }
        setList((current) => current.kind === 'ready'
          ? {
            ...current,
            items: current.items.filter((item) => item.is_current),
          }
          : current);
        setCompletion({
          kind: 'others',
          count: response.data.revoked_count,
        });
      }
      setConfirmation(null);
    } catch (error) {
      setActionFailure(requestFailure(error));
    } finally {
      setRunning(false);
    }
  }

  const readyList = list.kind === 'ready' ? list : null;
  const otherSessionCount = readyList?.items.filter(
    (item) => !item.is_current,
  ).length ?? 0;
  const dialogTitle = confirmation?.kind === 'others'
    ? t('dialog.othersTitle')
    : confirmation?.item.is_current
      ? t('dialog.currentTitle')
      : t('dialog.sessionTitle');
  const dialogDescription = confirmation?.kind === 'others'
    ? t('dialog.othersDescription', { count: otherSessionCount })
    : confirmation?.item.is_current
      ? t('dialog.currentDescription')
      : t('dialog.sessionDescription');
  const errorMessage = actionErrorMessage(actionFailure);

  return (
    <main
      id="studio-main-content"
      aria-labelledby="security-title"
    >
      <PageHeader
        titleId="security-title"
        kicker={t('kicker')}
        title={t('title')}
        description={t('description')}
        actions={otherSessionCount > 0 ? (
          <Button
            type="button"
            variant="danger"
            onClick={() => openConfirmation({ kind: 'others' })}
          >
            {t('sessions.revokeOthers')}
          </Button>
        ) : undefined}
      />

      {completion ? (
        <div className="account-message">
          <Notice tone="success">
            {completion.kind === 'session'
              ? t('notice.sessionRevoked')
              : t('notice.othersRevoked', { count: completion.count })}
          </Notice>
        </div>
      ) : null}

      <div className="account-stack">
        <Panel
          title={t('password.summaryTitle')}
          description={t('password.summaryDescription')}
          actions={(
            <ButtonLink variant="primary" to={STUDIO_PATHS.passwordChange}>
              {t('password.summaryAction')}
            </ButtonLink>
          )}
        />

        <MfaSecuritySection onSessionEnded={input.onSessionEnded} />

        <Panel
          title={t('sessions.title')}
          description={t('sessions.description', {
            count: readyList?.maxSessions ?? 5,
          })}
        >
          {list.kind === 'loading' ? (
            <div className="account-state" role="status">
              <Spinner size="lg" />
              <div className="account-state-text">
                <strong className="account-state-title">
                  {t('loading.title')}
                </strong>
                <p className="account-state-detail">{t('loading.message')}</p>
              </div>
            </div>
          ) : null}

          {list.kind === 'error' ? (
            <Notice
              tone="error"
              title={t('loadError.title')}
              actions={(
                <Button
                  type="button"
                  onClick={() => setLoadAttempt((value) => value + 1)}
                >
                  {t('loadError.retry')}
                </Button>
              )}
            >
              {list.failure.kind === 'api'
                ? t('loadError.message')
                : actionErrorMessage(list.failure)}
            </Notice>
          ) : null}

          {readyList ? (
            <div className="account-session-list">
              {readyList.items.map((item) => {
                const network = [
                  item.network.asn === null ? null : `AS${item.network.asn}`,
                  item.network.as_organization,
                ].filter(
                  (value): value is string => value !== null,
                ).join(' · ');
                return (
                  <article
                    className={item.is_current
                      ? 'account-session account-session-current'
                      : 'account-session'}
                    key={item.id}
                  >
                    <header className="account-session-header">
                      <p className="account-session-heading">
                        {t('sessions.browserSession')}
                        {item.is_current ? (
                          <StatusPill tone="positive">
                            {t('sessions.current')}
                          </StatusPill>
                        ) : null}
                      </p>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={() => openConfirmation({
                          kind: 'session',
                          item,
                        })}
                      >
                        {item.is_current
                          ? t('sessions.revokeCurrent')
                          : t('sessions.revoke')}
                      </Button>
                    </header>
                    <dl className="account-session-meta">
                      <div>
                        <dt>{t('sessions.fields.ipAddress')}</dt>
                        <dd>{item.network.ip_address}</dd>
                      </div>
                      <div>
                        <dt>{t('sessions.fields.network')}</dt>
                        <dd>{network || t('sessions.unavailable')}</dd>
                      </div>
                      <div>
                        <dt>{t('sessions.fields.country')}</dt>
                        <dd>
                          {item.network.country_code
                            ?? t('sessions.unavailable')}
                        </dd>
                      </div>
                      <div>
                        <dt>{t('sessions.fields.created')}</dt>
                        <dd>
                          <time dateTime={item.created_at_iso}>
                            {dateFormatter.format(new Date(item.created_at_iso))}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt>{t('sessions.fields.lastActive')}</dt>
                        <dd>
                          <time dateTime={item.last_seen_at_iso}>
                            {dateFormatter.format(
                              new Date(item.last_seen_at_iso),
                            )}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt>{t('sessions.fields.idleExpiry')}</dt>
                        <dd>
                          <time dateTime={item.idle_expires_at_iso}>
                            {dateFormatter.format(
                              new Date(item.idle_expires_at_iso),
                            )}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt>{t('sessions.fields.absoluteExpiry')}</dt>
                        <dd>
                          <time dateTime={item.absolute_expires_at_iso}>
                            {dateFormatter.format(
                              new Date(item.absolute_expires_at_iso),
                            )}
                          </time>
                        </dd>
                      </div>
                      <div className="account-session-user-agent">
                        <dt>{t('sessions.fields.userAgent')}</dt>
                        <dd>{item.user_agent ?? t('sessions.unavailable')}</dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
              {otherSessionCount === 0 ? (
                <p className="account-no-other-sessions">
                  {t('sessions.noOthers')}
                </p>
              ) : null}
            </div>
          ) : null}
        </Panel>
      </div>

      <Dialog
        open={confirmation !== null}
        onClose={() => {
          setConfirmation(null);
          setActionFailure(null);
        }}
        busy={running}
        kicker={t('dialog.kicker')}
        title={dialogTitle}
        description={dialogDescription}
        actions={(
          <>
            <Button
              type="button"
              disabled={running}
              onClick={() => {
                setConfirmation(null);
                setActionFailure(null);
              }}
            >
              {t('dialog.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={running}
              onClick={() => void executeConfirmation()}
            >
              {running
                ? t('dialog.running')
                : confirmation?.kind === 'others'
                  ? t('dialog.confirmOthers')
                  : t('dialog.confirm')}
            </Button>
          </>
        )}
      >
        {errorMessage ? (
          <div className="account-dialog-notice">
            <Notice tone="error">{errorMessage}</Notice>
          </div>
        ) : null}
      </Dialog>
    </main>
  );
}

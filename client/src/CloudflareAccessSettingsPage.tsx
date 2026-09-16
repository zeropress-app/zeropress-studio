import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cloud, ShieldCheck, ShieldOff } from 'lucide-react';
import type {
  CloudflareAccessSettingsDocument,
} from '../../contracts/cloudflare-access';
import {
  Button,
  Callout,
  Dialog,
  DialogActions,
  Notice,
  Panel,
  Spinner,
  StatusPill,
  StudioIcon,
} from './components/primitives';
import {
  OperationsClientError,
  requestOperationsCloudflareAccessSettings,
  requestOperationsCloudflareAccessUpdate,
} from './lib/operations-client';
import { useBusyChange, type BusyChangeHandler } from './hooks/useBusyChange';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: CloudflareAccessSettingsDocument }
  | { kind: 'error'; message: string };

export function CloudflareAccessManager(input: {
  token: string;
  onSessionEnded: () => void;
  onBusyChange?: BusyChangeHandler;
}) {
  const { t, i18n } = useTranslation('accessSettings');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [pendingMode, setPendingMode] = useState<
    'disabled' | 'required' | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{
    tone: 'success' | 'error';
    message: string;
  } | null>(null);
  useBusyChange(input.onBusyChange, saving);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    setResult(null);
    void requestOperationsCloudflareAccessSettings({
      token: input.token,
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.success) {
          if (response.error.code === 'AUTHENTICATION_REQUIRED') {
            input.onSessionEnded();
            return;
          }
          setState({ kind: 'error', message: t('errors.api') });
          return;
        }
        setState({ kind: 'ready', document: response.data });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        const key = error instanceof OperationsClientError
          ? error.code === 'TIMEOUT' ? 'timeout'
            : error.code === 'NETWORK_ERROR' ? 'network'
              : 'invalidResponse'
          : 'network';
        setState({ kind: 'error', message: t(`errors.${key}`) });
      });
    return () => controller.abort();
  }, [attempt, input.onSessionEnded, input.token, t]);

  async function applyMode() {
    if (state.kind !== 'ready' || pendingMode === null || saving) return;
    setSaving(true);
    setResult(null);
    try {
      const response = await requestOperationsCloudflareAccessUpdate({
        token: input.token,
        request: {
          mode: pendingMode,
          expected_revision: state.document.revision,
        },
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        const key = response.error.code === 'SETTINGS_REVISION_CONFLICT'
          ? 'conflict'
          : response.error.code === 'CLOUDFLARE_ACCESS_NOT_DETECTED'
            ? 'notDetected'
            : response.error.code
                === 'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE'
              ? 'verificationUnavailable'
              : 'api';
        setResult({ tone: 'error', message: t(`errors.${key}`) });
        return;
      }
      const completedMode = pendingMode;
      setState({ kind: 'ready', document: response.data });
      setPendingMode(null);
      setResult({
        tone: 'success',
        message: t(`changed.${completedMode}`),
      });
    } catch (error) {
      const key = error instanceof OperationsClientError
        ? error.code === 'TIMEOUT' ? 'timeout'
          : error.code === 'NETWORK_ERROR' ? 'network'
            : 'invalidResponse'
        : 'network';
      setResult({ tone: 'error', message: t(`errors.${key}`) });
    } finally {
      setSaving(false);
    }
  }

  const document = state.kind === 'ready' ? state.document : null;
  const active = document?.settings.mode === 'required';
  const detected = document?.detected ?? null;
  const enableAvailable = !active
    && document?.detection_state === 'verified'
    && detected !== null;
  const updatedAt = document?.updated_at_iso
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(document.updated_at_iso))
    : null;

  return (
    <>
      <div className="settings-form">
        {state.kind === 'loading' ? (
          <div className="settings-state" role="status">
            <Spinner size="lg" />
            <p className="settings-state-title">{t('loading')}</p>
          </div>
        ) : null}
        {state.kind === 'error' ? (
          <Notice
            tone="error"
            title={t('errors.title')}
            actions={(
              <Button type="button" onClick={() => setAttempt((v) => v + 1)}>
                {t('actions.retry')}
              </Button>
            )}
          >
            {state.message}
          </Notice>
        ) : null}
        {document ? (
          <>
            {result ? <Notice tone={result.tone}>{result.message}</Notice> : null}
            <Panel
              leading={<StudioIcon icon={active ? ShieldCheck : ShieldOff} />}
              kicker={t('status.kicker')}
              title={t('status.title')}
              description={active
                ? t('status.requiredDescription')
                : t('status.disabledDescription')}
              actions={(
                <StatusPill tone={active ? 'positive' : 'neutral'}>
                  {t(active ? 'status.required' : 'status.disabled')}
                </StatusPill>
              )}
            >
              {active && document.settings.mode === 'required' ? (
                <dl className="cloudflare-access-facts">
                  <div>
                    <dt>{t('facts.teamDomain')}</dt>
                    <dd>{new URL(document.settings.issuer).hostname}</dd>
                  </div>
                  <div>
                    <dt>{t('facts.audience')}</dt>
                    <dd><code>{document.settings.audience}</code></dd>
                  </div>
                  <div>
                    <dt>{t('facts.boundOrigin')}</dt>
                    <dd><code>{document.settings.bound_origin}</code></dd>
                  </div>
                  {updatedAt ? (
                    <div>
                      <dt>{t('facts.updated')}</dt>
                      <dd>{updatedAt}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
            </Panel>

            {!active ? (
              <Panel
                leading={<StudioIcon icon={Cloud} />}
                title={t('detection.title')}
                description={t('detection.description')}
              >
                {document.detection_state === 'verified' && detected ? (
                  <>
                    <Callout tone="info" title={t('detection.verified')}>
                      {t('detection.verifiedDescription')}
                    </Callout>
                    <dl className="cloudflare-access-facts">
                      <div>
                        <dt>{t('facts.teamDomain')}</dt>
                        <dd>{detected.team_domain}</dd>
                      </div>
                      <div>
                        <dt>{t('facts.audience')}</dt>
                        <dd><code>{detected.audience}</code></dd>
                      </div>
                      <div>
                        <dt>{t('facts.currentIdentity')}</dt>
                        <dd>{detected.identity_email ?? t('facts.notAvailable')}</dd>
                      </div>
                    </dl>
                  </>
                ) : (
                  <Callout
                    tone={document.detection_state === 'unavailable'
                      ? 'warning'
                      : 'info'}
                    title={t(`detection.${document.detection_state}`)}
                  >
                    {t(`detection.${document.detection_state}Description`)}
                  </Callout>
                )}
              </Panel>
            ) : null}

            <Panel
              title={active ? t('actions.disableTitle') : t('actions.enableTitle')}
              description={active
                ? t('actions.disableDescription')
                : t('actions.enableDescription')}
              actions={(
                <Button
                  type="button"
                  variant={active ? 'danger' : 'primary'}
                  disabled={!active && !enableAvailable}
                  onClick={() => setPendingMode(active ? 'disabled' : 'required')}
                >
                  <StudioIcon icon={active ? ShieldOff : ShieldCheck} />
                  {t(active ? 'actions.disable' : 'actions.enable')}
                </Button>
              )}
            />
          </>
        ) : null}
      </div>

      <Dialog
        open={pendingMode !== null}
        onClose={() => !saving && setPendingMode(null)}
        busy={saving}
        title={pendingMode ? t(`confirm.${pendingMode}.title`) : ''}
        description={pendingMode
          ? t(`confirm.${pendingMode}.description`)
          : undefined}
      >
        <DialogActions>
          <Button type="button" disabled={saving} onClick={() => setPendingMode(null)}>
            {t('actions.cancel')}
          </Button>
          <Button
            type="button"
            variant={pendingMode === 'disabled' ? 'danger' : 'primary'}
            disabled={saving}
            onClick={() => void applyMode()}
          >
            {saving ? t('actions.saving') : t('actions.confirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

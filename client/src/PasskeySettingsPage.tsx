import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { ShieldCheck } from 'lucide-react';
import type { PasskeySettingsDocument } from '../../contracts/passkey-settings';
import type { MfaManagementStatusResponse } from '../../contracts/mfa-management';
import type { ApiErrorCode } from '../../contracts/api';
import { requestPasskeySettings } from './lib/passkey-settings-client';
import { requestMfaManagementAuthorization, requestMfaManagementStatus, requestMfaManagementWebAuthnStepUpOptions, requestMfaManagementWebAuthnStepUpVerification } from './lib/mfa-management-client';
import { SettingsScreen, type SettingsSaveState } from './components/SettingsScreen';
import { StepUpVerification, type StepUpMethod } from './components/StepUpVerification';
import { Button, Dialog, DialogActions, Field, Notice, Panel, StudioIcon, Switch } from './components/primitives';

type Status = Extract<MfaManagementStatusResponse, { success: true }>['data'];
export function PasskeySettingsPage(input: { data: { csrf_token: string }; onSessionEnded: () => void }) {
  const { t, i18n } = useTranslation('security');
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<'loading' | 'ready' | 'error'>('loading');
  const [document, setDocument] = useState<PasskeySettingsDocument | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [save, setSave] = useState<SettingsSaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [method, setMethod] = useState<StepUpMethod>('totp');
  const [code, setCode] = useState('');
  const dirty = Boolean(document && enabled !== document.settings.require_fido_certified_authenticator);
  const busy = save === 'saving';
  useEffect(() => {
    const controller = new AbortController();
    setLoad('loading'); setSave('idle'); setError(null);
    void Promise.all([requestPasskeySettings({ signal: controller.signal }), requestMfaManagementStatus(controller.signal)])
      .then(([policy, auth]) => {
        if (controller.signal.aborted) return;
        if (!policy.success || !auth.success) {
          if ((!policy.success && policy.error.code === 'AUTHENTICATION_REQUIRED') || (!auth.success && auth.error.code === 'AUTHENTICATION_REQUIRED')) input.onSessionEnded();
          setLoad('error'); return;
        }
        setDocument(policy.data); setEnabled(policy.data.settings.require_fido_certified_authenticator); setStatus(auth.data); setLoad('ready');
      }).catch(() => { if (!controller.signal.aborted) setLoad('error'); });
    return () => controller.abort();
  }, [attempt, input.onSessionEnded]);
  function handleError(apiCode: ApiErrorCode) {
    if (apiCode === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
    if (apiCode === 'MFA_STEP_UP_REQUIRED') setStatus((current) => current ? { ...current, step_up: { ...current.step_up, mfa_required: true } } : current);
    if (apiCode === 'SETTINGS_REVISION_CONFLICT') { setSave('conflict'); setOpen(false); }
    else { setSave('idle'); setError(t(apiCode === 'INVALID_CURRENT_PASSWORD' ? 'management.errors.invalidPassword'
      : apiCode === 'INVALID_MFA_CODE' ? 'management.errors.invalidMfa'
      : apiCode === 'MFA_STEP_UP_REQUIRED' ? 'management.errors.stepUpRequired' : 'passkeyPolicy.error')); }
  }
  function close() { if (busy) return; setOpen(false); setPassword(''); setCode(''); setError(null); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!document || !status || busy || !dirty) return;
    setSave('saving'); setError(null);
    try {
      const operation = 'change_passkey_policy' as const;
      let authorization;
      if (status.step_up.mfa_required && method === 'webauthn') {
        const options = await requestMfaManagementWebAuthnStepUpOptions(input.data.csrf_token, { operation, password });
        if (!options.success) { handleError(options.error.code); return; }
        const response = await startAuthentication({ optionsJSON: options.data.options });
        authorization = await requestMfaManagementWebAuthnStepUpVerification(input.data.csrf_token, { operation, challenge_token: options.data.challenge_token, response });
      } else {
        authorization = await requestMfaManagementAuthorization(input.data.csrf_token, { operation, password,
          ...(status.step_up.mfa_required ? { verification: { method: 'totp', code } as const } : {}) });
      }
      if (!authorization.success) { handleError(authorization.error.code); return; }
      const result = await requestPasskeySettings({ csrfToken: input.data.csrf_token, body: {
        settings: { require_fido_certified_authenticator: enabled }, expected_revision: document.revision, management_token: authorization.data.management_token,
      } });
      if (!result.success) { handleError(result.error.code); return; }
      setDocument(result.data); setSave('saved'); setOpen(false); setPassword(''); setCode('');
    } catch { setSave('idle'); setError(t('passkeyPolicy.error')); }
  }
  return <>
    <SettingsScreen navigation="site" copy={{ documentTitle: t('passkeyPolicy.title'), title: t('passkeyPolicy.title'), kicker: 'STUDIO',
      description: t('passkeyPolicy.description'), loading: { title: t('management.loading.title') }, loadError: { title: t('passkeyPolicy.loadError') },
      saved: t('passkeyPolicy.saved'), validation: t('passkeyPolicy.error'), conflict: { title: t('passkeyPolicy.conflict') }, save: t('passkeyPolicy.save') }}
      load={load} save={save} error={open ? null : error} dirty={dirty} canSave={!open} onRetry={() => setAttempt(attempt + 1)}
      reload={{ label: t('passkeyPolicy.reload'), onReload: () => setAttempt(attempt + 1) }}
      onReset={() => { if (document) setEnabled(document.settings.require_fido_certified_authenticator); setSave('idle'); setError(null); }}
      onSubmit={(event) => { event.preventDefault(); if (dirty && !busy) { setError(null); setPassword(''); setCode(''); setOpen(true); } }}>
      <Panel title={t('passkeyPolicy.panelTitle')} leading={<StudioIcon icon={ShieldCheck} />} description={t('passkeyPolicy.scope')}>
        <Switch label={t('passkeyPolicy.label')} description={t('passkeyPolicy.requirement')} checked={enabled} disabled={busy || open} onChange={(value) => { setEnabled(value); setSave('idle'); }} />
        {document && <details className="passkey-metadata-details"><summary>{t('passkeyMetadata.snapshot')}</summary>
          <p>{t('passkeyMetadata.snapshotValue', { number: document.snapshot.mds_no, date: new Intl.DateTimeFormat(i18n.resolvedLanguage, { dateStyle: 'medium' }).format(new Date(document.snapshot.evaluated_at_iso)) })}</p>
          <p>{t('passkeyPolicy.static')}</p>
        </details>}
      </Panel>
    </SettingsScreen>
    <Dialog open={open} onClose={close} busy={busy} title={t('management.authorize.title')} description={t('passkeyPolicy.confirm')}>
      <form className="account-dialog-form" onSubmit={(event) => void submit(event)}>
        <Field label={t('management.authorize.password')}>{(control) => <input {...control} type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} />}</Field>
        {status && <StepUpVerification name="passkey-policy-step-up" required={status.step_up.mfa_required} method={method} onMethodChange={setMethod} code={code} onCodeChange={setCode}
          webAuthnAvailable={browserSupportsWebAuthn() && status.webauthn.credentials.some((credential) => credential.rp_id === status.webauthn.current_rp_id)} disabled={busy}
          copy={{ legend: t('management.authorize.mfaLegend'), notRequired: t('management.authorize.recentMfa'), webauthn: t('management.authorize.webauthn'),
            webauthnPrompt: t('management.authorize.webauthnPrompt'), totp: t('management.authorize.totp'), totpCode: t('management.authorize.totpCode') }} />}
        {error && <Notice tone="error">{error}</Notice>}
        <DialogActions><Button type="button" onClick={close} disabled={busy}>{t('management.cancel')}</Button><Button type="submit" variant="primary" disabled={busy}>{t(busy ? 'management.authorize.running' : 'passkeyPolicy.save')}</Button></DialogActions>
      </form>
    </Dialog>
  </>;
}

import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../contracts/api';
import {
  EDGE_SECURITY_SETTINGS_LIMITS,
  edgeSecuritySettingsInputSchema,
  type EdgeSecuritySettings,
  type EdgeSecuritySettingsDocument,
  type EdgeWriteVerificationMode,
} from '../../contracts/edge-security-settings';
import type { CurrentSessionSuccess } from '../../contracts/session';
import {
  EDGE_WORKER_CONFIGURATION_CATALOG,
} from '../../contracts/worker-configuration';
import {
  Callout,
  ConfigurationReference,
  Field,
  Panel,
} from './components/primitives';
import { SettingsScreen } from './components/SettingsScreen';
import {
  EdgeSecuritySettingsClientError,
  requestEdgeSecuritySettings,
  requestUpdateEdgeSecuritySettings,
  type EdgeSecuritySettingsClientErrorCode,
} from './lib/edge-security-settings-client';

type AccountSession = CurrentSessionSuccess['data'];
type EdgeSecuritySettingsDraft = Omit<
  EdgeSecuritySettings,
  'turnstile_sitekey' | 'ip_address_retention_days'
> & {
  turnstile_sitekey: string;
  ip_address_retention_days: string;
};
type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: EdgeSecuritySettingsClientErrorCode }
  | { kind: 'unexpected' };
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: EdgeSecuritySettingsDocument }
  | { kind: 'error'; failure: Failure };
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'validation' }
  | { kind: 'failed'; failure: Failure };

function toDraft(
  settings: EdgeSecuritySettings,
): EdgeSecuritySettingsDraft {
  return {
    ...settings,
    turnstile_sitekey: settings.turnstile_sitekey ?? '',
    ip_address_retention_days: String(
      settings.ip_address_retention_days,
    ),
  };
}

function toSettings(
  draft: EdgeSecuritySettingsDraft,
): EdgeSecuritySettings | null {
  if (!/^\d+$/u.test(draft.ip_address_retention_days)) return null;
  const parsed = edgeSecuritySettingsInputSchema.safeParse({
    ...draft,
    ip_address_retention_days: Number(draft.ip_address_retention_days),
  });
  return parsed.success ? parsed.data : null;
}

function settingsEqual(
  draft: EdgeSecuritySettingsDraft,
  settings: EdgeSecuritySettings,
): boolean {
  const normalized = toSettings(draft);
  return normalized !== null
    && JSON.stringify(normalized) === JSON.stringify(settings);
}

function requiresTurnstile(draft: EdgeSecuritySettingsDraft): boolean {
  return draft.comment_write_verification_mode === 'turnstile'
    || draft.newsletter_subscribe_verification_mode === 'turnstile'
    || draft.form_submit_verification_mode === 'turnstile';
}

function clientFailure(error: unknown): Failure {
  return error instanceof EdgeSecuritySettingsClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

/**
 * Verification method selector.
 *
 * Comments, Newsletters, and Forms share these two options. Field generates the control ID.
 */
function VerificationModeField(input: {
  label: string;
  description: string;
  value: EdgeWriteVerificationMode;
  disabled: boolean;
  powLabel: string;
  turnstileLabel: string;
  onChange: (value: EdgeWriteVerificationMode) => void;
}) {
  return (
    <Field label={input.label} hint={input.description}>
      {(control) => (
        <select
          {...control}
          value={input.value}
          disabled={input.disabled}
          onChange={(event) => input.onChange(
            event.target.value as EdgeWriteVerificationMode,
          )}
        >
          <option value="pow">{input.powLabel}</option>
          <option value="turnstile">{input.turnstileLabel}</option>
        </select>
      )}
    </Field>
  );
}

export function EdgeSecuritySettingsPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('edgeSecuritySettings');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<EdgeSecuritySettingsDraft | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });

  const settingsDocument = loadState.kind === 'ready'
    ? loadState.document
    : null;
  const normalizedDraft = useMemo(
    () => draft ? toSettings(draft) : null,
    [draft],
  );
  const hasChanges = draft !== null
    && settingsDocument !== null
    && !settingsEqual(draft, settingsDocument.settings);
  const turnstileRequired = draft ? requiresTurnstile(draft) : false;
  const trimmedSitekey = draft?.turnstile_sitekey.trim() ?? '';
  const sitekeyTooLong = [...trimmedSitekey].length
    > EDGE_SECURITY_SETTINGS_LIMITS.turnstileSitekeyCodePoints;
  const sitekeyMissing = turnstileRequired && trimmedSitekey === '';
  const retentionValue = draft
    && /^\d+$/u.test(draft.ip_address_retention_days)
    ? Number(draft.ip_address_retention_days)
    : Number.NaN;
  const retentionInvalid = !Number.isInteger(retentionValue)
    || retentionValue < EDGE_SECURITY_SETTINGS_LIMITS.ipRetentionDaysMinimum
    || retentionValue > EDGE_SECURITY_SETTINGS_LIMITS.ipRetentionDaysMaximum;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setSaveState({ kind: 'idle' });
    void requestEdgeSecuritySettings(controller.signal)
      .then((response) => {
        if (!active) return;
        if (!response.success) {
          if (response.error.code === 'AUTHENTICATION_REQUIRED') {
            input.onSessionEnded();
            return;
          }
          setLoadState({
            kind: 'error',
            failure: { kind: 'api', code: response.error.code },
          });
          return;
        }
        setDraft(toDraft(response.data.settings));
        setLoadState({ kind: 'ready', document: response.data });
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

  function failureMessage(failure: Failure): string {
    if (failure.kind === 'client') {
      if (failure.code === 'TIMEOUT') return t('errors.timeout');
      if (failure.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (failure.kind === 'unexpected') return t('errors.api');
    if (failure.code === 'FORBIDDEN') return t('errors.forbidden');
    if (failure.code === 'VALIDATION_ERROR') return t('errors.validation');
    return t('errors.api');
  }

  function editDraft(
    update: (current: EdgeSecuritySettingsDraft) => EdgeSecuritySettingsDraft,
  ) {
    setDraft((current) => current ? update(current) : current);
    setSaveState((current) => current.kind === 'conflict'
      ? current
      : { kind: 'idle' });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !settingsDocument
      || !draft
      || !hasChanges
      || saveState.kind === 'saving'
      || saveState.kind === 'conflict'
    ) {
      return;
    }
    if (!normalizedDraft) {
      setSaveState({ kind: 'validation' });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      const response = await requestUpdateEdgeSecuritySettings(
        input.data.csrf_token,
        {
          settings: normalizedDraft,
          expected_revision: settingsDocument.revision,
        },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          setSaveState({ kind: 'idle' });
          input.onSessionEnded();
          return;
        }
        if (response.error.code === 'SETTINGS_REVISION_CONFLICT') {
          setSaveState({ kind: 'conflict' });
          return;
        }
        setSaveState(response.error.code === 'VALIDATION_ERROR'
          ? { kind: 'validation' }
          : {
              kind: 'failed',
              failure: { kind: 'api', code: response.error.code },
            });
        return;
      }
      setDraft(toDraft(response.data.settings));
      setLoadState({ kind: 'ready', document: response.data });
      setSaveState({ kind: 'saved' });
    } catch (error) {
      setSaveState({ kind: 'failed', failure: clientFailure(error) });
    }
  }

  const saving = saveState.kind === 'saving';
  const lastSaved = settingsDocument
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(settingsDocument.updated_at_iso))
    : null;

  return (
    <SettingsScreen
      navigation="edge"
      copy={{
        documentTitle: t('documentTitle'),
        kicker: t('kicker'),
        title: t('title'),
        description: t('description'),
        loading: {
          title: t('loading.title'),
          description: t('loading.description'),
        },
        loadError: {
          title: t('loadError.title'),
          description: t('loadError.description'),
        },
        saved: t('state.saved'),
        validation: t('errors.validation'),
        conflict: {
          title: t('errors.conflictTitle'),
          description: t('errors.conflictDescription'),
        },
        save: t('actions.save'),
      }}
      load={loadState.kind === 'ready' && !draft ? 'loading' : loadState.kind}
      onRetry={() => setLoadAttempt((value) => value + 1)}
      loadErrorDetail={loadState.kind === 'error'
        ? failureMessage(loadState.failure)
        : null}
      save={saveState.kind === 'failed' ? 'idle' : saveState.kind}
      error={saveState.kind === 'failed'
        ? failureMessage(saveState.failure)
        : null}
      reload={{
        label: t('errors.reload'),
        onReload: () => setLoadAttempt((value) => value + 1),
      }}
      dirty={hasChanges}
      canSave={normalizedDraft !== null}
      statusDetail={lastSaved ? t('state.lastSaved', { date: lastSaved }) : null}
      onReset={() => {
        if (settingsDocument) setDraft(toDraft(settingsDocument.settings));
        setSaveState({ kind: 'idle' });
      }}
      onSubmit={(event) => void save(event)}
    >
      {draft ? (
        <>
          <Panel
            layout="split"
            title={t('verification.title')}
            description={t('verification.description')}
          >
            <div className="settings-fields">
              <VerificationModeField
                label={t('fields.commentMode.label')}
                description={t('fields.commentMode.description')}
                value={draft.comment_write_verification_mode}
                disabled={saving}
                powLabel={t('fields.modeOptions.pow')}
                turnstileLabel={t('fields.modeOptions.turnstile')}
                onChange={(value) => editDraft((current) => ({
                  ...current,
                  comment_write_verification_mode: value,
                }))}
              />
              <VerificationModeField
                label={t('fields.newsletterMode.label')}
                description={t('fields.newsletterMode.description')}
                value={draft.newsletter_subscribe_verification_mode}
                disabled={saving}
                powLabel={t('fields.modeOptions.pow')}
                turnstileLabel={t('fields.modeOptions.turnstile')}
                onChange={(value) => editDraft((current) => ({
                  ...current,
                  newsletter_subscribe_verification_mode: value,
                }))}
              />
              <VerificationModeField
                label={t('fields.formMode.label')}
                description={t('fields.formMode.description')}
                value={draft.form_submit_verification_mode}
                disabled={saving}
                powLabel={t('fields.modeOptions.pow')}
                turnstileLabel={t('fields.modeOptions.turnstile')}
                onChange={(value) => editDraft((current) => ({
                  ...current,
                  form_submit_verification_mode: value,
                }))}
              />
            </div>
          </Panel>

          <Panel
            layout="split"
            title={t('turnstile.title')}
            description={t('turnstile.description')}
          >
            <div className="settings-fields">
              <Field
                label={t('fields.sitekey.label')}
                hint={t('fields.sitekey.description')}
                error={sitekeyMissing || sitekeyTooLong
                  ? (sitekeyTooLong
                      ? t('fields.sitekey.errorLength')
                      : t('fields.sitekey.errorRequired'))
                  : undefined}
              >
                {(control) => (
                  <input
                    {...control}
                    value={draft.turnstile_sitekey}
                    maxLength={
                      EDGE_SECURITY_SETTINGS_LIMITS.turnstileSitekeyCodePoints
                    }
                    placeholder={t('fields.sitekey.placeholder')}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={saving}
                    onChange={(event) => editDraft((current) => ({
                      ...current,
                      turnstile_sitekey: event.target.value,
                    }))}
                  />
                )}
              </Field>
              <Callout tone="warning" title={t('turnstile.secretTitle')}>
                <div className="settings-worker-configuration">
                  <ConfigurationReference
                    name="TURNSTILE_SECRET_KEY"
                    kind={EDGE_WORKER_CONFIGURATION_CATALOG
                      .TURNSTILE_SECRET_KEY.kind}
                  />
                  <p>{t('turnstile.secretDescription')}</p>
                </div>
              </Callout>
            </div>
          </Panel>

          <Panel
            layout="split"
            title={t('retention.title')}
            description={t('retention.description')}
          >
            <div className="settings-fields">
              <Field
                label={t('fields.retentionDays.label')}
                hint={t('fields.retentionDays.description')}
                error={retentionInvalid
                  ? t('fields.retentionDays.error')
                  : undefined}
              >
                {(control) => (
                  <input
                    {...control}
                    type="number"
                    inputMode="numeric"
                    min={EDGE_SECURITY_SETTINGS_LIMITS.ipRetentionDaysMinimum}
                    max={EDGE_SECURITY_SETTINGS_LIMITS.ipRetentionDaysMaximum}
                    step="1"
                    value={draft.ip_address_retention_days}
                    disabled={saving}
                    onChange={(event) => editDraft((current) => ({
                      ...current,
                      ip_address_retention_days: event.target.value,
                    }))}
                  />
                )}
              </Field>
            </div>
          </Panel>
        </>
      ) : null}
    </SettingsScreen>
  );
}

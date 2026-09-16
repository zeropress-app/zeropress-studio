import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../contracts/api';
import {
  materializeNewsletterSettingsDefaults,
  normalizeNewsletterSettings,
  type NewsletterSettings,
  type NewsletterSettingsDocument,
} from '../../contracts/newsletter-settings';
import type { CurrentSessionSuccess } from '../../contracts/session';
import {
  Field,
  Panel,
  Switch,
  SwitchGroup,
} from './components/primitives';
import { SettingsScreen } from './components/SettingsScreen';
import {
  NewsletterSettingsClientError,
  requestNewsletterSettings,
  requestUpdateNewsletterSettings,
  type NewsletterSettingsClientErrorCode,
} from './lib/newsletter-settings-client';

type AccountSession = CurrentSessionSuccess['data'];
type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: NewsletterSettingsClientErrorCode }
  | { kind: 'unexpected' };
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: NewsletterSettingsDocument }
  | { kind: 'error'; failure: Failure };
type SaveState =
  | { kind: 'idle' | 'saving' | 'saved' | 'validation' | 'conflict' }
  | { kind: 'failed'; failure: Failure };

function clientFailure(error: unknown): Failure {
  return error instanceof NewsletterSettingsClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

function equal(left: NewsletterSettings, right: NewsletterSettings): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function NewsletterSettingsPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('newsletterSettings');
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [draft, setDraft] = useState<NewsletterSettings>(
    materializeNewsletterSettingsDefaults(),
  );
  const settingsDocument = loadState.kind === 'ready' ? loadState.document : null;
  const normalized = useMemo(() => normalizeNewsletterSettings(draft), [draft]);
  const hasChanges = settingsDocument !== null
    && !equal(draft, settingsDocument.settings);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setSaveState({ kind: 'idle' });
    void requestNewsletterSettings(controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({ kind: 'error', failure: { kind: 'api', code: response.error.code } });
        return;
      }
      setDraft({ ...response.data.settings });
      setLoadState({ kind: 'ready', document: response.data });
    }).catch((error) => {
      if (!active || controller.signal.aborted) return;
      setLoadState({ kind: 'error', failure: clientFailure(error) });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, input.onSessionEnded]);

  function edit<K extends keyof NewsletterSettings>(
    key: K,
    value: NewsletterSettings[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaveState((current) => current.kind === 'conflict'
      ? current
      : { kind: 'idle' });
  }

  function failureMessage(failure: Failure): string {
    if (failure.kind === 'client') {
      if (failure.code === 'TIMEOUT') return t('errors.timeout');
      if (failure.code === 'NETWORK_ERROR') return t('errors.network');
      return t('errors.invalidResponse');
    }
    if (failure.kind === 'api' && failure.code === 'FORBIDDEN') {
      return t('errors.forbidden');
    }
    return t('errors.api');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settingsDocument || !hasChanges || saveState.kind === 'saving' || saveState.kind === 'conflict') return;
    if (!normalized) {
      setSaveState({ kind: 'validation' });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      const response = await requestUpdateNewsletterSettings(
        input.data.csrf_token,
        { settings: draft, expected_revision: settingsDocument.revision },
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
        if (response.error.code === 'VALIDATION_ERROR') {
          setSaveState({ kind: 'validation' });
          return;
        }
        setSaveState({ kind: 'failed', failure: { kind: 'api', code: response.error.code } });
        return;
      }
      setDraft({ ...response.data.settings });
      setLoadState({ kind: 'ready', document: response.data });
      setSaveState({ kind: 'saved' });
    } catch (error) {
      setSaveState({ kind: 'failed', failure: clientFailure(error) });
    }
  }

  const fieldInvalid = normalized === null;
  const lastSaved = settingsDocument?.updated_at_iso
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(settingsDocument.updated_at_iso))
    : null;

  const saving = saveState.kind === 'saving';
  return (
    <SettingsScreen
      navigation="site"
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
      load={loadState.kind}
      onRetry={() => setAttempt((value) => value + 1)}
      loadErrorDetail={loadState.kind === 'error'
        ? failureMessage(loadState.failure)
        : null}
      save={saveState.kind === 'failed' ? 'idle' : saveState.kind}
      error={saveState.kind === 'failed'
        ? failureMessage(saveState.failure)
        : null}
      reload={{
        label: t('errors.reload'),
        onReload: () => setAttempt((value) => value + 1),
      }}
      dirty={hasChanges}
      canSave={normalized !== null}
      statusDetail={lastSaved
        ? t('state.lastSaved', { date: lastSaved })
        : t('state.defaults')}
      onReset={() => {
        if (settingsDocument) setDraft({ ...settingsDocument.settings });
        setSaveState({ kind: 'idle' });
      }}
      onSubmit={(event) => void save(event)}
    >
      <Panel
        title={t('presentation.title')}
        description={t('presentation.description')}
      >
        <div className="settings-fields">
          <SwitchGroup>
            <Switch
              label={t('fields.enabled.label')}
              description={t('fields.enabled.description')}
              checked={draft.enabled}
              disabled={saving}
              onChange={(enabled) => edit('enabled', enabled)}
            />
          </SwitchGroup>
          <Field
            label={t('fields.title.label')}
            hint={t('fields.title.description')}
          >
            {(control) => (
              <input
                {...control}
                value={draft.title}
                disabled={saving}
                onChange={(event) => edit('title', event.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('fields.description.label')}
            hint={t('fields.description.description')}
          >
            {(control) => (
              <textarea
                {...control}
                rows={4}
                value={draft.description}
                disabled={saving}
                onChange={(event) => edit('description', event.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('fields.buttonLabel.label')}
            hint={t('fields.buttonLabel.description')}
          >
            {(control) => (
              <input
                {...control}
                value={draft.button_label}
                disabled={saving}
                onChange={(event) => edit('button_label', event.target.value)}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        title={t('destination.title')}
        description={t('destination.description')}
      >
        <div className="settings-fields">
          <Field
            label={t('fields.signupUrl.label')}
            hint={t('fields.signupUrl.description')}
            error={fieldInvalid ? t('fields.destinationError') : undefined}
          >
            {(control) => (
              <input
                {...control}
                inputMode="url"
                placeholder="https://example.com/newsletter"
                value={draft.signup_url}
                disabled={saving}
                onChange={(event) => edit('signup_url', event.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('fields.embedUrl.label')}
            hint={t('fields.embedUrl.description')}
            error={fieldInvalid ? t('fields.destinationError') : undefined}
          >
            {(control) => (
              <input
                {...control}
                inputMode="url"
                placeholder="/newsletter/embed"
                value={draft.embed_url}
                disabled={saving}
                onChange={(event) => edit('embed_url', event.target.value)}
              />
            )}
          </Field>
        </div>
      </Panel>
    </SettingsScreen>
  );
}

import {
  useEffect,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../contracts/api';
import type { CurrentSessionSuccess } from '../../contracts/session';
import {
  SUPPORTED_INTERFACE_LOCALES,
  studioInterfaceSettingsSchema,
  type StudioInterfaceSettings,
  type StudioInterfaceSettingsDocument,
} from '../../contracts/studio-interface-settings';
import { Field, Panel } from './components/primitives';
import { SettingsScreen } from './components/SettingsScreen';
import { INTERFACE_LOCALE_METADATA } from './i18n/locale';
import {
  requestStudioInterfaceSettings,
  requestUpdateStudioInterfaceSettings,
  StudioInterfaceSettingsClientError,
  type StudioInterfaceSettingsClientErrorCode,
} from './lib/studio-interface-settings-client';
import { useStudioInterfaceSettings } from './StudioInterfaceSettingsContext';

type Session = CurrentSessionSuccess['data'];
type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: StudioInterfaceSettingsClientErrorCode }
  | { kind: 'unexpected' };
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: StudioInterfaceSettingsDocument }
  | { kind: 'error'; failure: Failure };
type SaveState =
  | 'idle'
  | 'saving'
  | 'saved'
  | 'validation'
  | 'conflict'
  | { kind: 'failed'; failure: Failure };

function settingsEqual(
  left: StudioInterfaceSettings,
  right: StudioInterfaceSettings,
): boolean {
  return left.default_locale === right.default_locale
    && left.enabled_locales.length === right.enabled_locales.length
    && left.enabled_locales.every((locale, index) => (
      locale === right.enabled_locales[index]
    ));
}

function clientFailure(error: unknown): Failure {
  return error instanceof StudioInterfaceSettingsClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

export function StudioInterfaceSettingsPage(input: {
  data: Session;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('interfaceSettings');
  const { applyOrganizationSettings } = useStudioInterfaceSettings();
  const [attempt, setAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<StudioInterfaceSettings>({
    default_locale: 'en',
    enabled_locales: ['en'],
  });
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const document = loadState.kind === 'ready' ? loadState.document : null;
  const dirty = document !== null
    && !settingsEqual(draft, document.settings);
  const valid = studioInterfaceSettingsSchema.safeParse(draft).success;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setSaveState('idle');
    void requestStudioInterfaceSettings(controller.signal)
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
        setDraft({
          default_locale: response.data.settings.default_locale,
          enabled_locales: [...response.data.settings.enabled_locales],
        });
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
  }, [attempt, input.onSessionEnded]);

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

  function updateDefault(locale: StudioInterfaceSettings['default_locale']) {
    setDraft((current) => ({
      default_locale: locale,
      enabled_locales: SUPPORTED_INTERFACE_LOCALES.filter((candidate) => (
        candidate === locale || current.enabled_locales.includes(candidate)
      )),
    }));
    setSaveState('idle');
  }

  function toggleLocale(
    locale: StudioInterfaceSettings['enabled_locales'][number],
    enabled: boolean,
  ) {
    setDraft((current) => ({
      ...current,
      enabled_locales: SUPPORTED_INTERFACE_LOCALES.filter((candidate) => (
        candidate === locale
          ? enabled
          : current.enabled_locales.includes(candidate)
      )),
    }));
    setSaveState('idle');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!document || !dirty || saveState === 'saving' || saveState === 'conflict') {
      return;
    }
    const parsed = studioInterfaceSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setSaveState('validation');
      return;
    }
    setSaveState('saving');
    try {
      const response = await requestUpdateStudioInterfaceSettings(
        input.data.csrf_token,
        {
          settings: parsed.data,
          expected_revision: document.revision,
        },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          setSaveState('idle');
          input.onSessionEnded();
          return;
        }
        if (response.error.code === 'SETTINGS_REVISION_CONFLICT') {
          setSaveState('conflict');
          return;
        }
        if (response.error.code === 'VALIDATION_ERROR') {
          setSaveState('validation');
          return;
        }
        setSaveState({
          kind: 'failed',
          failure: { kind: 'api', code: response.error.code },
        });
        return;
      }
      setDraft({
        default_locale: response.data.settings.default_locale,
        enabled_locales: [...response.data.settings.enabled_locales],
      });
      setLoadState({ kind: 'ready', document: response.data });
      await applyOrganizationSettings(response.data.settings);
      setSaveState('saved');
    } catch (error) {
      setSaveState({ kind: 'failed', failure: clientFailure(error) });
    }
  }

  const lastSaved = document?.updated_at_iso
    ? t('state.lastSaved', {
        date: new Intl.DateTimeFormat(i18n.resolvedLanguage, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(document.updated_at_iso)),
      })
    : null;
  const saveFailure = typeof saveState === 'object'
    ? failureMessage(saveState.failure)
    : null;

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
        validation: t('state.validation'),
        conflict: {
          title: t('conflict.title'),
          description: t('conflict.description'),
        },
        save: t('actions.save'),
      }}
      load={loadState.kind}
      onRetry={() => setAttempt((value) => value + 1)}
      loadErrorDetail={loadState.kind === 'error'
        ? failureMessage(loadState.failure)
        : null}
      save={typeof saveState === 'string' ? saveState : 'idle'}
      error={saveFailure}
      reload={{
        label: t('conflict.reload'),
        onReload: () => setAttempt((value) => value + 1),
      }}
      dirty={dirty}
      canSave={valid}
      statusDetail={lastSaved}
      onReset={() => {
        if (!document) return;
        setDraft({
          default_locale: document.settings.default_locale,
          enabled_locales: [...document.settings.enabled_locales],
        });
        setSaveState('idle');
      }}
      onSubmit={(event) => void save(event)}
    >
      <Panel
        title={t('fields.defaultLocale.title')}
        description={t('fields.defaultLocale.description')}
      >
        <div className="settings-fields">
          <Field label={t('fields.defaultLocale.label')}>
            {(control) => (
              <select
                {...control}
                value={draft.default_locale}
                onChange={(event) => updateDefault(
                  event.target.value as StudioInterfaceSettings[
                    'default_locale'
                  ],
                )}
              >
                {SUPPORTED_INTERFACE_LOCALES.map((locale) => (
                  <option value={locale} key={locale}>
                    {INTERFACE_LOCALE_METADATA[locale].nativeLabel}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        title={t('fields.enabledLocales.title')}
        description={t('fields.enabledLocales.description')}
      >
        <fieldset className="interface-locale-fieldset">
          <legend className="visually-hidden">
            {t('fields.enabledLocales.legend')}
          </legend>
          <div className="interface-locale-grid">
            {SUPPORTED_INTERFACE_LOCALES.map((locale) => {
              const isDefault = locale === draft.default_locale;
              return (
                <label className="interface-locale-option" key={locale}>
                  <input
                    type="checkbox"
                    checked={draft.enabled_locales.includes(locale)}
                    disabled={isDefault}
                    onChange={(event) => toggleLocale(
                      locale,
                      event.target.checked,
                    )}
                  />
                  <span>{INTERFACE_LOCALE_METADATA[locale].nativeLabel}</span>
                  <code>{locale}</code>
                  {isDefault ? (
                    <small className="interface-locale-default-badge">
                      {t('fields.enabledLocales.defaultBadge')}
                    </small>
                  ) : null}
                </label>
              );
            })}
          </div>
        </fieldset>
      </Panel>
    </SettingsScreen>
  );
}

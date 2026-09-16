import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Globe, MapPin } from 'lucide-react';
import type { ApiErrorCode } from '../../contracts/api';
import {
  GENERAL_SETTINGS_DEFAULTS,
  normalizeSiteDescription,
  normalizeSiteLocale,
  normalizeSiteOrigin,
  normalizeSiteTimezone,
  normalizeSiteTitle,
  type GeneralSettings,
  type GeneralSettingsRecoveryPlan,
  type GeneralSettingsSuccess,
} from '../../contracts/general-settings';
import type { CurrentSessionSuccess } from '../../contracts/session';
import {
  GeneralSettingsClientError,
  requestGeneralSettings,
  requestRepairGeneralSettings,
  requestUpdateGeneralSettings,
  type GeneralSettingsClientErrorCode,
} from './lib/general-settings-client';
import { Button, Callout, Field, Panel, StudioIcon } from './components/primitives';
import { SettingsScreen } from './components/SettingsScreen';
import { SettingsRecoveryDialog } from './components/SettingsRecoveryDialog';
import {
  describeSiteLocale,
  describeSiteTimezone,
  readBrowserLocalizationDefaults,
} from './lib/site-localization';
import type { StudioSiteIdentity } from './StudioSiteIdentityContext';

type AccountSession = CurrentSessionSuccess['data'];
type SettingsDocument = GeneralSettingsSuccess['data'];
type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: GeneralSettingsClientErrorCode }
  | { kind: 'unexpected' };
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: SettingsDocument }
  | { kind: 'incomplete'; recovery: GeneralSettingsRecoveryPlan }
  | { kind: 'error'; failure: Failure };
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'validation' }
  | { kind: 'failed'; failure: Failure };
type RecoveryState =
  | { kind: 'closed' }
  | { kind: 'ready' }
  | { kind: 'running' }
  | { kind: 'failed'; failure: Failure };

const LOCALE_SUGGESTIONS = [
  'en-US',
  'ko-KR',
  'ja-JP',
  'zh-CN',
  'zh-TW',
  'de-DE',
  'es-ES',
  'fr-FR',
] as const;

function clientFailure(error: unknown): Failure {
  return error instanceof GeneralSettingsClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

function timezoneSuggestions(): string[] {
  let supported: string[] = [];
  try {
    supported = Intl.supportedValuesOf('timeZone');
  } catch {
    // The text field remains usable when a browser lacks the suggestion API.
  }
  let browserTimezone = '';
  try {
    browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    // UTC remains available as the safe fallback suggestion.
  }
  return [...new Set([
    'UTC',
    browserTimezone,
    ...supported,
  ].filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function settingsEqual(left: GeneralSettings, right: GeneralSettings): boolean {
  return left.title === right.title
    && left.description === right.description
    && left.url === right.url
    && left.locale === right.locale
    && left.timezone === right.timezone;
}

export function GeneralSettingsPage(input: {
  data: AccountSession;
  onSiteIdentityChanged?: (identity: StudioSiteIdentity) => void;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('settings');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<GeneralSettings>({
    ...GENERAL_SETTINGS_DEFAULTS,
  });
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [recoveryState, setRecoveryState] = useState<RecoveryState>({
    kind: 'closed',
  });
  const timezones = useMemo(timezoneSuggestions, []);

  const settingsDocument = loadState.kind === 'ready'
    ? loadState.document
    : null;
  const hasChanges = settingsDocument !== null
    && !settingsEqual(draft, settingsDocument.settings);
  const localeListId = useId();
  const timezoneListId = useId();
  const browserDefaultsId = useId();
  // Format display names and example times in the administrator's Studio language.
  // Using the site's locale could show a language the administrator cannot read.
  const displayLocale = i18n.resolvedLanguage ?? 'en';
  const localeDescription = useMemo(
    () => describeSiteLocale(draft.locale, displayLocale),
    [draft.locale, displayLocale],
  );
  const timezoneDescription = useMemo(
    () => describeSiteTimezone(draft.timezone, displayLocale),
    [draft.timezone, displayLocale],
  );
  const browserDefaults = useMemo(readBrowserLocalizationDefaults, []);
  const browserDefaultsApplied = browserDefaults !== null
    && draft.locale === browserDefaults.locale
    && draft.timezone === browserDefaults.timezone;
  // Omit supplementary text for invalid input; error is the authoritative guidance.
  const localeNote = localeDescription.canonical === null
    ? undefined
    : t(
      localeDescription.displayName === null
        ? (localeDescription.normalized
          ? 'localization.localeNoteNormalizedUnnamed'
          : 'localization.localeNoteUnnamed')
        : (localeDescription.normalized
          ? 'localization.localeNoteNormalized'
          : 'localization.localeNote'),
      {
        value: localeDescription.canonical,
        name: localeDescription.displayName ?? '',
      },
    );
  const timezoneNote = timezoneDescription.canonical === null
    ? undefined
    : t(
      timezoneDescription.sample === null
        || timezoneDescription.offsetLabel === null
        ? (timezoneDescription.normalized
          ? 'localization.timezoneNoteNormalizedPlain'
          : 'localization.timezoneNotePlain')
        : (timezoneDescription.normalized
          ? 'localization.timezoneNoteNormalized'
          : 'localization.timezoneNote'),
      {
        value: timezoneDescription.canonical,
        offset: timezoneDescription.offsetLabel ?? '',
        sample: timezoneDescription.sample ?? '',
      },
    );
  const validity = useMemo(() => ({
    title: normalizeSiteTitle(draft.title) !== null,
    description: normalizeSiteDescription(draft.description) !== null,
    url: normalizeSiteOrigin(draft.url) !== null,
    locale: normalizeSiteLocale(draft.locale) !== null,
    timezone: normalizeSiteTimezone(draft.timezone) !== null,
  }), [draft]);
  const formValid = Object.values(validity).every(Boolean);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setSaveState({ kind: 'idle' });
    setRecoveryState({ kind: 'closed' });
    void requestGeneralSettings(controller.signal)
      .then((response) => {
        if (!active) return;
        if (!response.success) {
          if (response.error.code === 'AUTHENTICATION_REQUIRED') {
            input.onSessionEnded();
            return;
          }
          setLoadState(
            response.error.code === 'SITE_SETTINGS_INCOMPLETE'
              && 'recovery' in response.error
            ? { kind: 'incomplete', recovery: response.error.recovery }
            : {
                kind: 'error',
                failure: { kind: 'api', code: response.error.code },
              },
          );
          return;
        }
        setDraft({ ...response.data.settings });
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

  function updateDraft<K extends keyof GeneralSettings>(
    key: K,
    value: GeneralSettings[K],
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
    if (failure.kind === 'unexpected') return t('errors.api');
    if (failure.code === 'FORBIDDEN') return t('errors.forbidden');
    if (failure.code === 'SITE_SETTINGS_DATA_INVALID') {
      return t('recovery.unavailable');
    }
    if (failure.code === 'SETTINGS_RECOVERY_CONFLICT') {
      return t('recovery.conflict');
    }
    if (failure.code === 'VALIDATION_ERROR') return t('errors.validation');
    return t('errors.api');
  }

  async function repairMissingSettings() {
    if (
      loadState.kind !== 'incomplete'
      || recoveryState.kind === 'running'
    ) return;
    setRecoveryState({ kind: 'running' });
    try {
      const response = await requestRepairGeneralSettings(
        input.data.csrf_token,
        {
          expected_revision: loadState.recovery.expected_revision,
          missing_fields: loadState.recovery.missing_fields,
        },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setRecoveryState({
          kind: 'failed',
          failure: { kind: 'api', code: response.error.code },
        });
        return;
      }
      setDraft({ ...response.data.settings });
      setLoadState({ kind: 'ready', document: response.data });
      input.onSiteIdentityChanged?.({
        title: response.data.settings.title,
        url: response.data.settings.url,
      });
      setRecoveryState({ kind: 'closed' });
      setSaveState({ kind: 'saved' });
    } catch (error) {
      setRecoveryState({ kind: 'failed', failure: clientFailure(error) });
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !settingsDocument
      || !hasChanges
      || saveState.kind === 'saving'
      || saveState.kind === 'conflict'
    ) {
      return;
    }
    if (!formValid) {
      setSaveState({ kind: 'validation' });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      const response = await requestUpdateGeneralSettings(
        input.data.csrf_token,
        {
          settings: draft,
          expected_revision: settingsDocument.revision,
        },
      );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          // The authenticated route remains mounted while the session is
          // restored, so do not leave the form permanently busy.
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
        } else {
          setSaveState({
            kind: 'failed',
            failure: { kind: 'api', code: response.error.code },
          });
        }
        return;
      }
      setDraft({ ...response.data.settings });
      setLoadState({ kind: 'ready', document: response.data });
      input.onSiteIdentityChanged?.({
        title: response.data.settings.title,
        url: response.data.settings.url,
      });
      setSaveState({ kind: 'saved' });
    } catch (error) {
      setSaveState({ kind: 'failed', failure: clientFailure(error) });
    }
  }

  function reloadLatest() {
    setLoadAttempt((value) => value + 1);
  }

  const saving = saveState.kind === 'saving';
  const lastSaved = settingsDocument?.updated_at_iso
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(settingsDocument.updated_at_iso))
    : null;
  const recovery = loadState.kind === 'incomplete'
    ? loadState.recovery
    : null;
  const recoveryEntries = recovery?.missing_fields.map((field) => ({
    field: t(`fields.${field}.label`),
    value: recovery.proposed_settings[field] || t('recovery.emptyValue'),
  })) ?? [];

  return (<>
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
      load={loadState.kind === 'incomplete' ? 'error' : loadState.kind}
      onRetry={reloadLatest}
      loadErrorDetail={loadState.kind === 'incomplete'
        ? t('recovery.incomplete')
        : loadState.kind === 'error' ? failureMessage(loadState.failure) : null}
      loadErrorAction={recovery ? {
        label: t('recovery.open'),
        onClick: () => setRecoveryState({ kind: 'ready' }),
      } : undefined}
      save={saveState.kind === 'failed' ? 'idle' : saveState.kind}
      error={saveState.kind === 'failed'
        ? failureMessage(saveState.failure)
        : null}
      reload={{ label: t('errors.reload'), onReload: reloadLatest }}
      dirty={hasChanges}
      canSave={formValid}
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
        title={t('identity.title')}
        description={t('identity.description')}
      >
        <div className="settings-fields">
          <Field
            label={t('fields.title.label')}
            hint={t('fields.title.description')}
            error={validity.title ? undefined : t('fields.title.error')}
          >
            {(control) => (
              <input
                {...control}
                required
                value={draft.title}
                disabled={saving}
                onChange={(event) => updateDraft('title', event.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('fields.description.label')}
            hint={t('fields.description.description')}
            error={validity.description
              ? undefined
              : t('fields.description.error')}
          >
            {(control) => (
              <textarea
                {...control}
                rows={4}
                value={draft.description}
                disabled={saving}
                onChange={(event) => updateDraft(
                  'description',
                  event.target.value,
                )}
              />
            )}
          </Field>
          <Field
            label={t('fields.url.label')}
            hint={t('fields.url.description')}
            error={validity.url ? undefined : t('fields.url.error')}
          >
            {(control) => (
              <input
                {...control}
                type="url"
                inputMode="url"
                placeholder={t('fields.url.placeholder')}
                value={draft.url}
                disabled={saving}
                onChange={(event) => updateDraft('url', event.target.value)}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        title={t('localization.title')}
        description={t('localization.description')}
        footer={browserDefaults === null ? undefined : (
          <div className="settings-localization-actions">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={saving || browserDefaultsApplied}
              aria-describedby={browserDefaultsId}
              onClick={() => setDraft((current) => ({
                ...current,
                locale: browserDefaults.locale,
                timezone: browserDefaults.timezone,
              }))}
            >
              <StudioIcon icon={Globe} />
              {t('localization.useBrowserDefaults')}
            </Button>
            <span id={browserDefaultsId} className="settings-localization-detected">
              {t('localization.browserDefaults', {
                locale: browserDefaults.locale,
                timezone: browserDefaults.timezone,
              })}
            </span>
          </div>
        )}
      >
        <div className="settings-localization">
          <div className="settings-fields settings-fields-split">
            <Field
              label={t('fields.locale.label')}
              hint={t('fields.locale.description')}
              note={localeNote}
              error={validity.locale ? undefined : t('fields.locale.error')}
            >
              {(control) => (
                <>
                  <input
                    {...control}
                    list={localeListId}
                    autoComplete="off"
                    placeholder={t('fields.locale.placeholder')}
                    value={draft.locale}
                    disabled={saving}
                    onChange={(event) => updateDraft(
                      'locale',
                      // Whitespace is never valid in either field. Trim it so values copied
                      // from documents or tables do not immediately become invalid.
                      event.target.value.trim(),
                    )}
                  />
                  <datalist id={localeListId}>
                    {LOCALE_SUGGESTIONS.map((locale) => (
                      <option key={locale} value={locale} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
            <Field
              label={t('fields.timezone.label')}
              hint={t('fields.timezone.description')}
              note={timezoneNote}
              error={validity.timezone ? undefined : t('fields.timezone.error')}
            >
              {(control) => (
                <>
                  <input
                    {...control}
                    list={timezoneListId}
                    autoComplete="off"
                    placeholder={t('fields.timezone.placeholder')}
                    value={draft.timezone}
                    disabled={saving}
                    onChange={(event) => updateDraft(
                      'timezone',
                      event.target.value.trim(),
                    )}
                  />
                  <datalist id={timezoneListId}>
                    {timezones.map((timezone) => (
                      <option key={timezone} value={timezone} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
          </div>
          {localeDescription.unknown ? (
            <Callout tone="warning">
              {t('localization.unknownLocale')}
            </Callout>
          ) : null}
          {timezoneDescription.kind === 'fixed_offset' ? (
            <Callout tone="info">
              {timezoneDescription.suggestedZone === null
                ? t('localization.fixedOffset')
                : t(
                  timezoneDescription.suggestedZoneObservesDaylightSaving
                    ? 'localization.fixedOffsetDaylightSaving'
                    : 'localization.fixedOffsetSuggestion',
                  { zone: timezoneDescription.suggestedZone },
                )}
              {timezoneDescription.suggestedZone === null ? null : (
                <div className="settings-localization-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={saving}
                    onClick={() => updateDraft(
                      'timezone',
                      timezoneDescription.suggestedZone ?? '',
                    )}
                  >
                    <StudioIcon icon={MapPin} />
                    {t('localization.useSuggestedZone')}
                  </Button>
                </div>
              )}
            </Callout>
          ) : null}
        </div>
      </Panel>
    </SettingsScreen>
    <SettingsRecoveryDialog
      open={recovery !== null && recoveryState.kind !== 'closed'}
      title={t('recovery.title')}
      description={t('recovery.description')}
      entries={recoveryEntries}
      failure={recoveryState.kind === 'failed'
        ? failureMessage(recoveryState.failure)
        : null}
      busy={recoveryState.kind === 'running'}
      cancelLabel={t('recovery.cancel')}
      confirmLabel={t('recovery.confirm')}
      busyLabel={t('recovery.running')}
      onClose={() => setRecoveryState({ kind: 'closed' })}
      onConfirm={() => void repairMissingSettings()}
    />
  </>);
}

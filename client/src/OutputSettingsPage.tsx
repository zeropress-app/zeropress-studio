import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../contracts/api';
import {
  materializeOutputSettingsDefaults,
  outputSettingsInputSchema,
  PREVIEW_DATETIME_STYLES,
  type OutputSettings,
  type OutputSettingsSuccess,
} from '../../contracts/output-settings';
import type { CurrentSessionSuccess } from '../../contracts/session';
import {
  Callout,
  Field,
  Panel,
  Switch,
  SwitchGroup,
} from './components/primitives';
import { SettingsScreen } from './components/SettingsScreen';
import { describeDatetimeStylePreview } from './lib/datetime-style-preview';
import {
  OutputSettingsClientError,
  requestOutputSettings,
  requestUpdateOutputSettings,
  type OutputSettingsClientErrorCode,
} from './lib/output-settings-client';

type AccountSession = CurrentSessionSuccess['data'];
type SettingsDocument = OutputSettingsSuccess['data'];
type OutputSettingsDraft = Omit<OutputSettings, 'posts_per_page'> & {
  posts_per_page: string;
  footer: {
    copyright_text: string;
    attribution: boolean;
  };
};
type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: OutputSettingsClientErrorCode }
  | { kind: 'unexpected' };
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: SettingsDocument }
  | { kind: 'error'; failure: Failure };
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'validation' }
  | { kind: 'failed'; failure: Failure };

function toDraft(settings: OutputSettings): OutputSettingsDraft {
  return {
    expose_generator: settings.expose_generator,
    search: { ...settings.search },
    feed: { ...settings.feed },
    archive: { ...settings.archive },
    posts_per_page: String(settings.posts_per_page),
    date_style: settings.date_style,
    time_style: settings.time_style,
    footer: {
      copyright_text: settings.footer.copyright_text ?? '',
      attribution: settings.footer.attribution,
    },
    robots: { ...settings.robots },
  };
}

function toSettings(draft: OutputSettingsDraft): OutputSettings | null {
  if (!/^\d+$/u.test(draft.posts_per_page)) return null;
  const postsPerPage = Number(draft.posts_per_page);
  const parsed = outputSettingsInputSchema.safeParse({
    expose_generator: draft.expose_generator,
    search: draft.search,
    feed: draft.feed,
    archive: draft.archive,
    posts_per_page: postsPerPage,
    date_style: draft.date_style,
    time_style: draft.time_style,
    footer: draft.footer,
    robots: draft.robots,
  });
  return parsed.success ? parsed.data : null;
}

function settingsEqual(
  draft: OutputSettingsDraft,
  settings: OutputSettings,
): boolean {
  const normalized = toSettings(draft);
  return normalized !== null
    && normalized.expose_generator === settings.expose_generator
    && normalized.search.enabled === settings.search.enabled
    && normalized.feed.enabled === settings.feed.enabled
    && normalized.archive.enabled === settings.archive.enabled
    && normalized.posts_per_page === settings.posts_per_page
    && normalized.date_style === settings.date_style
    && normalized.time_style === settings.time_style
    && normalized.footer.copyright_text === settings.footer.copyright_text
    && normalized.footer.attribution === settings.footer.attribution
    && normalized.robots.allow_indexing === settings.robots.allow_indexing;
}

function clientFailure(error: unknown): Failure {
  return error instanceof OutputSettingsClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}


export function OutputSettingsPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('outputSettings');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<OutputSettingsDraft>(
    toDraft(materializeOutputSettingsDefaults()),
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });

  const settingsDocument = loadState.kind === 'ready'
    ? loadState.document
    : null;
  const normalizedDraft = useMemo(() => toSettings(draft), [draft]);
  const formValid = normalizedDraft !== null;
  const hasChanges = settingsDocument !== null
    && !settingsEqual(draft, settingsDocument.settings);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setSaveState({ kind: 'idle' });
    void requestOutputSettings(controller.signal)
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

  function editDraft(
    update: (current: OutputSettingsDraft) => OutputSettingsDraft,
  ) {
    setDraft(update);
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
    if (failure.code === 'VALIDATION_ERROR') return t('errors.validation');
    return t('errors.api');
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
    if (!normalizedDraft) {
      setSaveState({ kind: 'validation' });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      const response = await requestUpdateOutputSettings(
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
      setDraft(toDraft(response.data.settings));
      setLoadState({ kind: 'ready', document: response.data });
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
  // Show the format produced by the two selections. This does not read the site's
  // locale or timezone, so it remains independent of the General Settings document.
  const datetimePreview = describeDatetimeStylePreview({
    dateStyle: draft.date_style,
    timeStyle: draft.time_style,
  });
  // Display the formatted example separately as code instead of interpolating it
  // into translated prose. The value stays visible without splitting a sentence.
  const datetimePreviewCaption = datetimePreview.kind === 'sample'
    ? t('fields.datetimePreview.basis')
    : datetimePreview.kind === 'omitted'
      ? t('fields.datetimePreview.omitted')
      : undefined;

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
      onRetry={reloadLatest}
      loadErrorDetail={loadState.kind === 'error'
        ? failureMessage(loadState.failure)
        : null}
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
        if (settingsDocument) setDraft(toDraft(settingsDocument.settings));
        setSaveState({ kind: 'idle' });
      }}
      onSubmit={(event) => void save(event)}
    >
      <Panel
        title={t('pagination.title')}
        description={t('pagination.description')}
      >
        <div className="settings-fields">
          <Field
            label={t('fields.postsPerPage.label')}
            hint={t('fields.postsPerPage.description')}
            error={formValid ? undefined : t('fields.postsPerPage.error')}
          >
            {(control) => (
              <input
                {...control}
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                required
                value={draft.posts_per_page}
                disabled={saving}
                onChange={(event) => editDraft((current) => ({
                  ...current,
                  posts_per_page: event.target.value,
                }))}
              />
            )}
          </Field>
          <div className="settings-fields settings-fields-split">
            <Field
              label={t('fields.dateStyle.label')}
              hint={t('fields.dateStyle.description')}
            >
              {(control) => (
                <select
                  {...control}
                  value={draft.date_style}
                  disabled={saving}
                  onChange={(event) => editDraft((current) => ({
                    ...current,
                    date_style: event.target
                      .value as OutputSettings['date_style'],
                  }))}
                >
                  {PREVIEW_DATETIME_STYLES.map((style) => (
                    <option key={style} value={style}>
                      {t(`fields.styles.${style}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field
              label={t('fields.timeStyle.label')}
              hint={t('fields.timeStyle.description')}
            >
              {(control) => (
                <select
                  {...control}
                  value={draft.time_style}
                  disabled={saving}
                  onChange={(event) => editDraft((current) => ({
                    ...current,
                    time_style: event.target
                      .value as OutputSettings['time_style'],
                  }))}
                >
                  {PREVIEW_DATETIME_STYLES.map((style) => (
                    <option key={style} value={style}>
                      {t(`fields.styles.${style}`)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          {datetimePreviewCaption === undefined ? null : (
            <Callout
              tone="info"
              title={t('fields.datetimePreview.title')}
            >
              <div className="settings-datetime-preview">
                {datetimePreview.kind === 'sample' ? (
                  <code className="settings-datetime-sample">
                    {datetimePreview.text}
                  </code>
                ) : null}
                <span>{datetimePreviewCaption}</span>
              </div>
            </Callout>
          )}
        </div>
      </Panel>

      <Panel
        title={t('features.title')}
        description={t('features.description')}
      >
        <SwitchGroup>
          <Switch
            label={t('fields.search.label')}
            description={t('fields.search.description')}
            checked={draft.search.enabled}
            disabled={saving}
            onChange={(enabled) => editDraft((current) => ({
              ...current,
              search: { enabled },
            }))}
          />
          <Switch
            label={t('fields.feed.label')}
            description={t('fields.feed.description')}
            checked={draft.feed.enabled}
            disabled={saving}
            onChange={(enabled) => editDraft((current) => ({
              ...current,
              feed: { enabled },
            }))}
          />
          <Switch
            label={t('fields.archive.label')}
            description={t('fields.archive.description')}
            checked={draft.archive.enabled}
            disabled={saving}
            onChange={(enabled) => editDraft((current) => ({
              ...current,
              archive: { enabled },
            }))}
          />
          {!draft.feed.enabled || !draft.archive.enabled ? (
            <Callout tone="warning">{t('features.menuNotice')}</Callout>
          ) : null}
        </SwitchGroup>
      </Panel>

      <Panel
        title={t('footer.title')}
        description={t('footer.description')}
      >
        <div className="settings-fields">
          <Field
            label={t('fields.footerCopyright.label')}
            hint={t('fields.footerCopyright.description')}
          >
            {(control) => (
              <textarea
                {...control}
                value={draft.footer.copyright_text}
                disabled={saving}
                onChange={(event) => editDraft((current) => ({
                  ...current,
                  footer: {
                    ...current.footer,
                    copyright_text: event.target.value,
                  },
                }))}
              />
            )}
          </Field>
          <SwitchGroup>
            <Switch
              label={t('fields.footerAttribution.label')}
              description={t('fields.footerAttribution.description')}
              checked={draft.footer.attribution}
              disabled={saving}
              onChange={(attribution) => editDraft((current) => ({
                ...current,
                footer: { ...current.footer, attribution },
              }))}
            />
          </SwitchGroup>
        </div>
      </Panel>

      <Panel
        title={t('visibility.title')}
        description={t('visibility.description')}
      >
        <SwitchGroup>
          <Switch
            label={t('fields.indexing.label')}
            description={t('fields.indexing.description')}
            checked={draft.robots.allow_indexing}
            disabled={saving}
            onChange={(allowIndexing) => editDraft((current) => ({
              ...current,
              robots: { allow_indexing: allowIndexing },
            }))}
          />
          <Switch
            label={t('fields.generator.label')}
            description={t('fields.generator.description')}
            checked={draft.expose_generator}
            disabled={saving}
            onChange={(exposeGenerator) => editDraft((current) => ({
              ...current,
              expose_generator: exposeGenerator,
            }))}
          />
        </SwitchGroup>
      </Panel>
    </SettingsScreen>
  );
}

import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../contracts/api';
import {
  materializeRoutingSettingsDefaults,
  routingSettingsInputSchema,
  type RoutingPageOption,
  type RoutingSettings,
  type RoutingSettingsDocument,
  type RoutingSettingsRecoveryPlan,
} from '../../contracts/routing-settings';
import type { CurrentSessionSuccess } from '../../contracts/session';
import {
  Button,
  Field,
  Notice,
  Panel,
  Switch,
  SwitchGroup,
} from './components/primitives';
import { SettingsScreen } from './components/SettingsScreen';
import { SettingsRecoveryDialog } from './components/SettingsRecoveryDialog';
import {
  requestRepairRoutingSettings,
  requestRoutingPageOptions,
  requestRoutingSettings,
  requestUpdateRoutingSettings,
  RoutingSettingsClientError,
  type RoutingSettingsClientErrorCode,
} from './lib/routing-settings-client';

type AccountSession = CurrentSessionSuccess['data'];
type RoutingFrontPageDraft = {
  type: RoutingSettings['front_page']['type'];
  page_id: string;
  html: string;
};
type RoutingSettingsDraft = {
  permalinks: RoutingSettings['permalinks'];
  front_page: RoutingFrontPageDraft;
  post_index: RoutingSettings['post_index'];
};
type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: RoutingSettingsClientErrorCode }
  | { kind: 'unexpected' };
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: RoutingSettingsDocument }
  | { kind: 'incomplete'; recovery: RoutingSettingsRecoveryPlan }
  | { kind: 'error'; failure: Failure };
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'validation' }
  | { kind: 'front_page_missing' }
  | { kind: 'failed'; failure: Failure };
type OptionsState =
  | { kind: 'loading'; items: RoutingPageOption[] }
  | { kind: 'ready'; items: RoutingPageOption[] }
  | { kind: 'error'; items: RoutingPageOption[] };
type RecoveryState =
  | { kind: 'closed' }
  | { kind: 'ready' }
  | { kind: 'running' }
  | { kind: 'failed'; failure: Failure };

function toDraft(settings: RoutingSettings): RoutingSettingsDraft {
  return {
    permalinks: { ...settings.permalinks },
    front_page: settings.front_page.type === 'page'
      ? { type: 'page', page_id: settings.front_page.page_id, html: '' }
      : settings.front_page.type === 'standalone_html'
        ? { type: 'standalone_html', page_id: '', html: settings.front_page.html }
        : { type: 'theme_index', page_id: '', html: '' },
    post_index: { ...settings.post_index },
  };
}

function draftSettingsSource(draft: RoutingSettingsDraft) {
  return {
    permalinks: draft.permalinks,
    front_page: draft.front_page.type === 'page'
      ? { type: 'page', page_id: draft.front_page.page_id }
      : draft.front_page.type === 'standalone_html'
        ? { type: 'standalone_html', html: draft.front_page.html }
        : { type: 'theme_index' },
    post_index: draft.post_index,
  };
}

function parseDraft(draft: RoutingSettingsDraft) {
  return routingSettingsInputSchema.safeParse(draftSettingsSource(draft));
}

function settingsEqual(
  draft: RoutingSettingsDraft,
  settings: RoutingSettings,
): boolean {
  return JSON.stringify(draftSettingsSource(draft)) === JSON.stringify(settings);
}

function selectedPageId(frontPage: RoutingFrontPageDraft): string {
  return frontPage.type === 'page' ? frontPage.page_id : '';
}

function clientFailure(error: unknown): Failure {
  return error instanceof RoutingSettingsClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}


export function RoutingSettingsPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('routingSettings');
  const frontPageGroupId = useId();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<RoutingSettingsDraft>(
    toDraft(materializeRoutingSettingsDefaults()),
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [recoveryState, setRecoveryState] = useState<RecoveryState>({
    kind: 'closed',
  });
  const [pageSearch, setPageSearch] = useState('');
  const [optionsState, setOptionsState] = useState<OptionsState>({
    kind: 'loading',
    items: [],
  });

  const parsedDraft = useMemo(() => parseDraft(draft), [draft]);
  const settingsDocument = loadState.kind === 'ready'
    ? loadState.document
    : null;
  const hasChanges = settingsDocument !== null
    && !settingsEqual(draft, settingsDocument.settings);
  const rootCollision = draft.front_page.type !== 'theme_index'
    && draft.post_index.enabled
    && draft.post_index.path.trim() === '/';
  const invalidPaths = useMemo(() => new Set(
    parsedDraft.success
      ? []
      : parsedDraft.error.issues.map((issue) => issue.path.join('.')),
  ), [parsedDraft]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setSaveState({ kind: 'idle' });
    setRecoveryState({ kind: 'closed' });
    setOptionsState({ kind: 'loading', items: [] });
    void requestRoutingSettings(controller.signal)
      .then(async (response) => {
        if (!active) return;
        if (!response.success) {
          if (response.error.code === 'AUTHENTICATION_REQUIRED') {
            input.onSessionEnded();
            return;
          }
          setLoadState(
            response.error.code === 'SITE_ROUTING_SETTINGS_INCOMPLETE'
              && 'recovery' in response.error
              ? { kind: 'incomplete', recovery: response.error.recovery }
              : {
                  kind: 'error',
                  failure: { kind: 'api', code: response.error.code },
                },
          );
          return;
        }
        const nextDraft = toDraft(response.data.settings);
        setDraft(nextDraft);
        setLoadState({ kind: 'ready', document: response.data });
        try {
          const options = await requestRoutingPageOptions({
            selectedPageId: selectedPageId(nextDraft.front_page) || undefined,
            signal: controller.signal,
          });
          if (!active) return;
          if (!options.success) {
            if (options.error.code === 'AUTHENTICATION_REQUIRED') {
              input.onSessionEnded();
              return;
            }
            setOptionsState({ kind: 'error', items: [] });
            return;
          }
          setOptionsState({ kind: 'ready', items: options.data.items });
        } catch {
          if (!active || controller.signal.aborted) return;
          setOptionsState({ kind: 'error', items: [] });
        }
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
    update: (current: RoutingSettingsDraft) => RoutingSettingsDraft,
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
    if (failure.code === 'SITE_ROUTING_SETTINGS_DATA_INVALID') {
      return t('recovery.unavailable');
    }
    if (failure.code === 'SETTINGS_RECOVERY_CONFLICT') {
      return t('recovery.conflict');
    }
    if (failure.code === 'VALIDATION_ERROR') return t('errors.validation');
    return t('errors.api');
  }

  async function searchPages() {
    if (optionsState.kind === 'loading' || pageSearch.length > 200) return;
    const previousItems = optionsState.items;
    setOptionsState({ kind: 'loading', items: previousItems });
    try {
      const response = await requestRoutingPageOptions({
        search: pageSearch,
        selectedPageId: selectedPageId(draft.front_page) || undefined,
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setOptionsState({ kind: 'error', items: previousItems });
        return;
      }
      setOptionsState({ kind: 'ready', items: response.data.items });
    } catch {
      setOptionsState({ kind: 'error', items: previousItems });
    }
  }

  async function repairMissingSettings() {
    if (
      loadState.kind !== 'incomplete'
      || recoveryState.kind === 'running'
    ) return;
    setRecoveryState({ kind: 'running' });
    try {
      const response = await requestRepairRoutingSettings(
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
      const nextDraft = toDraft(response.data.settings);
      setDraft(nextDraft);
      setLoadState({ kind: 'ready', document: response.data });
      setSaveState({ kind: 'saved' });
      setRecoveryState({ kind: 'closed' });
      setOptionsState({ kind: 'loading', items: [] });
      const options = await requestRoutingPageOptions({
        selectedPageId: selectedPageId(nextDraft.front_page) || undefined,
      });
      if (!options.success) {
        if (options.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setOptionsState({ kind: 'error', items: [] });
        return;
      }
      setOptionsState({ kind: 'ready', items: options.data.items });
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
    ) return;
    if (!parsedDraft.success) {
      setSaveState({ kind: 'validation' });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      const response = await requestUpdateRoutingSettings(
        input.data.csrf_token,
        {
          settings: parsedDraft.data,
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
        } else if (response.error.code === 'ROUTING_FRONT_PAGE_NOT_FOUND') {
          setSaveState({ kind: 'front_page_missing' });
        } else if (response.error.code === 'VALIDATION_ERROR') {
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

  const saving = saveState.kind === 'saving';
  const lastSaved = settingsDocument?.updated_at_iso
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(settingsDocument.updated_at_iso))
    : null;
  const patternFields = ['posts', 'pages', 'categories', 'tags'] as const;
  const recovery = loadState.kind === 'incomplete'
    ? loadState.recovery
    : null;
  const recoveryEntries = recovery?.missing_fields.map((field) => ({
    field: t(`recovery.fields.${field}`),
    value: JSON.stringify(recovery.proposed_settings[field], null, 2),
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
      onRetry={() => setLoadAttempt((value) => value + 1)}
      loadErrorDetail={loadState.kind === 'incomplete'
        ? t('recovery.incomplete')
        : loadState.kind === 'error' ? failureMessage(loadState.failure) : null}
      loadErrorAction={recovery ? {
        label: t('recovery.open'),
        onClick: () => setRecoveryState({ kind: 'ready' }),
      } : undefined}
      save={saveState.kind === 'failed' || saveState.kind === 'front_page_missing'
        ? 'idle'
        : saveState.kind}
      error={saveState.kind === 'failed'
        ? failureMessage(saveState.failure)
        : saveState.kind === 'front_page_missing'
          ? t('errors.frontPageMissing')
          : null}
      reload={{
        label: t('errors.reload'),
        onReload: () => setLoadAttempt((value) => value + 1),
      }}
      dirty={hasChanges}
      canSave={parsedDraft.success}
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
        title={t('permalinks.title')}
        description={t('permalinks.description')}
      >
        <div className="settings-fields">
          <Field
            label={t('fields.outputStyle.label')}
            hint={t('fields.outputStyle.description')}
          >
            {(control) => (
              <select
                {...control}
                value={draft.permalinks.output_style}
                disabled={saving}
                onChange={(event) => editDraft((current) => ({
                  ...current,
                  permalinks: {
                    ...current.permalinks,
                    output_style: event.target
                      .value as RoutingSettings['permalinks']['output_style'],
                  },
                }))}
              >
                <option value="directory">
                  {t('fields.outputStyle.directory')}
                </option>
                <option value="html-extension">
                  {t('fields.outputStyle.htmlExtension')}
                </option>
              </select>
            )}
          </Field>
          <div className="settings-fields settings-fields-split">
            {patternFields.map((field) => {
              const invalid = invalidPaths.has(`permalinks.${field}`);
              return (
                <Field
                  key={field}
                  label={t(`fields.${field}.label`)}
                  hint={t(`fields.${field}.description`)}
                  error={invalid ? t('validation.pattern') : undefined}
                >
                  {(control) => (
                    <input
                      {...control}
                      value={draft.permalinks[field]}
                      placeholder={t(`fields.${field}.placeholder`)}
                      spellCheck="false"
                      required
                      disabled={saving}
                      onChange={(event) => editDraft((current) => ({
                        ...current,
                        permalinks: {
                          ...current.permalinks,
                          [field]: event.target.value,
                        },
                      }))}
                    />
                  )}
                </Field>
              );
            })}
          </div>
        </div>
      </Panel>

      <Panel
        title={t('homepage.title')}
        description={t('homepage.description')}
      >
        <div className="settings-fields">
          <fieldset
            className="routing-front-page-options"
            aria-labelledby={frontPageGroupId}
          >
            <legend id={frontPageGroupId} className="visually-hidden">
              {t('homepage.title')}
            </legend>
            <label>
              <input
                type="radio"
                name="front-page-type"
                value="theme_index"
                checked={draft.front_page.type === 'theme_index'}
                disabled={saving}
                onChange={() => editDraft((current) => ({
                  ...current,
                  front_page: { ...current.front_page, type: 'theme_index' },
                }))}
              />
              <span>
                <strong className="routing-option-title">
                  {t('homepage.themeIndex')}
                </strong>
                <small className="routing-option-detail">
                  {t('homepage.themeIndexDescription')}
                </small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="front-page-type"
                value="page"
                checked={draft.front_page.type === 'page'}
                disabled={saving}
                onChange={() => editDraft((current) => ({
                  ...current,
                  front_page: {
                    ...current.front_page,
                    type: 'page',
                    page_id: current.front_page.page_id
                      || optionsState.items[0]?.id
                      || '',
                  },
                }))}
              />
              <span>
                <strong className="routing-option-title">
                  {t('homepage.page')}
                </strong>
                <small className="routing-option-detail">
                  {t('homepage.pageDescription')}
                </small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="front-page-type"
                value="standalone_html"
                checked={draft.front_page.type === 'standalone_html'}
                disabled={saving}
                onChange={() => editDraft((current) => ({
                  ...current,
                  front_page: { ...current.front_page, type: 'standalone_html' },
                }))}
              />
              <span>
                <strong className="routing-option-title">
                  {t('homepage.standalone')}
                </strong>
                <small className="routing-option-detail">
                  {t('homepage.standaloneDescription')}
                </small>
              </span>
            </label>
          </fieldset>
          {draft.front_page.type === 'page' ? (
            <>
              <div className="routing-page-search">
                <Field
                  label={t('fields.pageSearch.label')}
                  hint={optionsState.kind === 'loading'
                    ? t('fields.pageSearch.loading')
                    : undefined}
                  error={optionsState.kind === 'error'
                    ? t('fields.pageSearch.error')
                    : undefined}
                >
                  {(control) => (
                    <input
                      {...control}
                      type="search"
                      maxLength={200}
                      value={pageSearch}
                      placeholder={t('fields.pageSearch.placeholder')}
                      disabled={saving}
                      onChange={(event) => setPageSearch(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        void searchPages();
                      }}
                    />
                  )}
                </Field>
                <Button
                  type="button"
                  disabled={saving || optionsState.kind === 'loading'}
                  onClick={() => void searchPages()}
                >
                  {t('fields.pageSearch.action')}
                </Button>
              </div>
              <Field
                label={t('fields.pageSelection.label')}
                hint={optionsState.kind === 'ready'
                  && optionsState.items.length === 0
                  ? t('homepage.noPages')
                  : undefined}
                error={invalidPaths.has('front_page.page_id')
                  ? t('validation.pageRequired')
                  : undefined}
              >
                {(control) => (
                  <select
                    {...control}
                    value={draft.front_page.page_id}
                    required
                    disabled={saving || optionsState.kind === 'loading'}
                    onChange={(event) => editDraft((current) => ({
                      ...current,
                      front_page: {
                        ...current.front_page,
                        type: 'page',
                        page_id: event.target.value,
                      },
                    }))}
                  >
                    <option value="">
                      {t('fields.pageSelection.placeholder')}
                    </option>
                    {optionsState.items.map((page) => (
                      <option key={page.id} value={page.id}>
                        {`${page.title} — /${page.path}/`}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </>
          ) : null}
          {draft.front_page.type === 'standalone_html' ? (
            <>
              <div className="settings-editor">
                <Field
                  label={t('fields.standaloneHtml.label')}
                  hint={t('fields.standaloneHtml.description')}
                  error={invalidPaths.has('front_page.html')
                    ? t('validation.standaloneHtml')
                    : undefined}
                >
                  {(control) => (
                    <textarea
                      {...control}
                      value={draft.front_page.html}
                      spellCheck="false"
                      required
                      disabled={saving}
                      onChange={(event) => editDraft((current) => ({
                        ...current,
                        front_page: {
                          ...current.front_page,
                          type: 'standalone_html',
                          html: event.target.value,
                        },
                      }))}
                    />
                  )}
                </Field>
              </div>
              <Notice tone="warning">{t('homepage.standaloneNotice')}</Notice>
            </>
          ) : null}
        </div>
      </Panel>

      <Panel
        title={t('postIndex.title')}
        description={t('postIndex.description')}
      >
        <div className="settings-fields">
          <SwitchGroup>
            <Switch
              label={t('fields.postIndexEnabled.label')}
              description={t('fields.postIndexEnabled.description')}
              checked={draft.post_index.enabled}
              disabled={saving}
              onChange={(enabled) => editDraft((current) => ({
                ...current,
                post_index: { ...current.post_index, enabled },
              }))}
            />
            <Switch
              label={t('fields.postIndexPaginate.label')}
              description={t('fields.postIndexPaginate.description')}
              checked={draft.post_index.paginate}
              disabled={saving || !draft.post_index.enabled}
              onChange={(paginate) => editDraft((current) => ({
                ...current,
                post_index: { ...current.post_index, paginate },
              }))}
            />
          </SwitchGroup>
          <Field
            label={t('fields.postIndexPath.label')}
            hint={t('fields.postIndexPath.description')}
            error={invalidPaths.has('post_index.path')
              ? (rootCollision
                  ? t('validation.rootCollision')
                  : t('validation.postIndexPath'))
              : undefined}
          >
            {(control) => (
              <input
                {...control}
                value={draft.post_index.path}
                placeholder={t('fields.postIndexPath.placeholder')}
                spellCheck="false"
                required
                disabled={saving}
                onChange={(event) => editDraft((current) => ({
                  ...current,
                  post_index: { ...current.post_index, path: event.target.value },
                }))}
              />
            )}
          </Field>
        </div>
      </Panel>
    </SettingsScreen>
    <SettingsRecoveryDialog
      open={recovery !== null && recoveryState.kind !== 'closed'}
      title={t('recovery.title')}
      description={t('recovery.description')}
      entries={recoveryEntries}
      impact={t('recovery.impact')}
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

import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../contracts/api';
import {
  CUSTOM_HTML_SLOT_MAX_CODE_POINTS,
  customCodeSettingsSchema,
  materializeCustomCodeSettingsDefaults,
  type CustomCodeSettings,
  type CustomCodeSettingsDocument,
} from '../../contracts/custom-code-settings';
import {
  Callout,
  Field,
  Panel,
  Switch,
  SwitchGroup,
} from './components/primitives';
import { LazyMonacoSourceEditor } from './components/LazyMonacoSourceEditor';
import { SettingsScreen } from './components/SettingsScreen';
import {
  CustomCodeSettingsClientError,
  requestCustomCodeSettings,
  requestUpdateCustomCodeSettings,
  type CustomCodeSettingsClientErrorCode,
} from './lib/custom-code-settings-client';

type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: CustomCodeSettingsClientErrorCode }
  | { kind: 'unexpected' };
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: CustomCodeSettingsDocument }
  | { kind: 'error'; failure: Failure };
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'validation' }
  | { kind: 'failed'; failure: Failure };
type HtmlSlot = 'head_end' | 'body_end';

function clientFailure(error: unknown): Failure {
  return error instanceof CustomCodeSettingsClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

function codePointLength(value: string): number {
  return [...value].length;
}

function hasVisibleSource(value: string): boolean {
  return /\S/u.test(value);
}

export function CustomCodeSettingsPage(input: {
  data: { csrf_token: string };
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('customCodeSettings');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<CustomCodeSettings>(
    materializeCustomCodeSettingsDefaults(),
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });

  const settingsDocument = loadState.kind === 'ready'
    ? loadState.document
    : null;
  const hasChanges = settingsDocument !== null
    && JSON.stringify(draft) !== JSON.stringify(settingsDocument.settings);
  const headCount = useMemo(
    () => codePointLength(draft.custom_html.head_end.content),
    [draft.custom_html.head_end.content],
  );
  const bodyCount = useMemo(
    () => codePointLength(draft.custom_html.body_end.content),
    [draft.custom_html.body_end.content],
  );
  const formValid = useMemo(
    () => customCodeSettingsSchema.safeParse(draft).success,
    [draft],
  );
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage),
    [i18n.resolvedLanguage],
  );
  const formattedLimit = numberFormatter.format(
    CUSTOM_HTML_SLOT_MAX_CODE_POINTS,
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setSaveState({ kind: 'idle' });
    void requestCustomCodeSettings(controller.signal)
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
        setDraft(structuredClone(response.data.settings));
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

  function edit(next: CustomCodeSettings) {
    setDraft(next);
    setSaveState((current) => current.kind === 'conflict'
      ? current
      : { kind: 'idle' });
  }

  function editHtmlSlot(
    slot: HtmlSlot,
    update: Partial<CustomCodeSettings['custom_html'][HtmlSlot]>,
  ) {
    edit({
      ...draft,
      custom_html: {
        ...draft.custom_html,
        [slot]: { ...draft.custom_html[slot], ...update },
      },
    });
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
    if (failure.code === 'PAYLOAD_TOO_LARGE') {
      return t('errors.payloadTooLarge');
    }
    return t('errors.api');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      !settingsDocument
      || !hasChanges
      || saveState.kind === 'saving'
      || saveState.kind === 'conflict'
    ) return;
    const parsed = customCodeSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setSaveState({ kind: 'validation' });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      const response = await requestUpdateCustomCodeSettings(
        input.data.csrf_token,
        {
          settings: parsed.data,
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
          return;
        }
        setSaveState({
          kind: 'failed',
          failure: { kind: 'api', code: response.error.code },
        });
        return;
      }
      setDraft(structuredClone(response.data.settings));
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
  const htmlSlots = [
    {
      key: 'head_end' as const,
      count: headCount,
      title: t('html.headEnd.title'),
      description: t('html.headEnd.description'),
    },
    {
      key: 'body_end' as const,
      count: bodyCount,
      title: t('html.bodyEnd.title'),
      description: t('html.bodyEnd.description'),
    },
  ];
  const editorCopy = {
    loading: t('editor.loading'),
    failedTitle: t('editor.failedTitle'),
    failedDescription: t('editor.failedDescription'),
    retry: t('editor.retry'),
  };

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
      canSave={formValid}
      statusDetail={lastSaved
        ? t('state.lastSaved', { date: lastSaved })
        : t('state.defaults')}
      onReset={() => {
        if (settingsDocument) {
          setDraft(structuredClone(settingsDocument.settings));
        }
        setSaveState({ kind: 'idle' });
      }}
      onSubmit={(event) => void save(event)}
    >
      {/* Persistent guidance about the code's effects, rather than a save result. */}
      <Callout tone="warning" title={t('trust.title')}>
        {t('trust.description')}
      </Callout>

      <Panel
        title={t('css.title')}
        description={t('css.description')}
      >
        <div className="settings-fields">
          <SwitchGroup>
            <Switch
              label={t('css.enabled')}
              description={draft.custom_css.enabled
                ? t('css.enabledDescription')
                : t('css.disabledDescription')}
              checked={draft.custom_css.enabled}
              disabled={saving}
              onChange={(enabled) => edit({
                ...draft,
                custom_css: { ...draft.custom_css, enabled },
              })}
            />
          </SwitchGroup>
          <div className="settings-editor">
            <Field
              label={t('css.editorLabel')}
              hint={[
                t('css.editorDescription'),
                draft.custom_css.enabled
                  && !hasVisibleSource(draft.custom_css.content)
                  ? t('css.blankEnabled')
                  : null,
              ].filter(Boolean).join(' ')}
            >
              {(control) => (
                <LazyMonacoSourceEditor
                  id={control.id}
                  describedBy={control['aria-describedby']}
                  invalid={control['aria-invalid']}
                  value={draft.custom_css.content}
                  documentType="css"
                  disabled={saving}
                  label={t('css.editorLabel')}
                  fallbackRows={16}
                  copy={editorCopy}
                  onChange={(content) => edit({
                    ...draft,
                    custom_css: {
                      ...draft.custom_css,
                      content,
                    },
                  })}
                />
              )}
            </Field>
          </div>
        </div>
      </Panel>

      {htmlSlots.map((slot) => {
        const value = draft.custom_html[slot.key];
        const overLimit = slot.count > CUSTOM_HTML_SLOT_MAX_CODE_POINTS;
        const blankEnabled = value.enabled
          && !hasVisibleSource(value.content);
        return (
          <Panel
            key={slot.key}
            title={t('html.panelTitle', { slot: slot.title })}
            description={slot.description}
            actions={(
              <span
                className={overLimit
                  ? 'settings-counter settings-counter-over'
                  : 'settings-counter'}
              >
                {t('html.counter', {
                  count: slot.count,
                  limit: formattedLimit,
                })}
              </span>
            )}
          >
            <div className="settings-fields">
              <SwitchGroup>
                <Switch
                  label={t('html.include', { slot: slot.title })}
                  description={value.enabled
                    ? t('html.enabledDescription')
                    : t('html.disabledDescription')}
                  checked={value.enabled}
                  disabled={saving}
                  onChange={(enabled) => editHtmlSlot(slot.key, { enabled })}
                />
              </SwitchGroup>
              <div className="settings-editor">
                <Field
                  label={t('html.editorLabel', { slot: slot.title })}
                  hint={[
                    t('html.editorDescription', { limit: formattedLimit }),
                    blankEnabled ? t('html.blankEnabled') : null,
                  ].filter(Boolean).join(' ')}
                  error={overLimit
                    ? t('html.limitError', { limit: formattedLimit })
                    : undefined}
                >
                  {(control) => (
                    <LazyMonacoSourceEditor
                      id={control.id}
                      describedBy={control['aria-describedby']}
                      invalid={control['aria-invalid']}
                      value={value.content}
                      documentType="html"
                      disabled={saving}
                      label={t('html.editorLabel', { slot: slot.title })}
                      fallbackRows={14}
                      copy={editorCopy}
                      onChange={(content) => editHtmlSlot(slot.key, {
                        content,
                      })}
                    />
                  )}
                </Field>
              </div>
            </div>
          </Panel>
        );
      })}
    </SettingsScreen>
  );
}

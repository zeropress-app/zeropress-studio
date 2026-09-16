import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../contracts/api';
import {
  materializeMediaSettingsDefaults,
  mediaSettingsInputSchema,
  type MediaSettings,
  type MediaSettingsSuccess,
} from '../../contracts/media-settings';
import { Field, Panel } from './components/primitives';
import { SettingsScreen } from './components/SettingsScreen';
import {
  MediaSettingsClientError,
  type MediaSettingsClientErrorCode,
  requestMediaSettings,
  requestUpdateMediaSettings,
} from './lib/media-settings-client';

type Document = MediaSettingsSuccess['data'];
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: Document }
  | { kind: 'error' };
type SaveState = 'idle' | 'saving' | 'saved' | 'validation' | 'conflict';

export function MediaSettingsPage(input: {
  data: { csrf_token: string };
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('mediaSettings');
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [draft, setDraft] = useState<MediaSettings>(
    materializeMediaSettingsDefaults(),
  );
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [failure, setFailure] = useState<
    ApiErrorCode | MediaSettingsClientErrorCode | null
  >(null);
  const parsedDraft = useMemo(
    () => mediaSettingsInputSchema.safeParse(draft),
    [draft],
  );
  const settingsDocument = loadState.kind === 'ready' ? loadState.document : null;
  const hasChanges = settingsDocument !== null
    && JSON.stringify(draft) !== JSON.stringify(settingsDocument.settings);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setFailure(null);
    setSaveState('idle');
    void requestMediaSettings(controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({ kind: 'error' });
        return;
      }
      setDraft({ ...response.data.settings });
      setLoadState({ kind: 'ready', document: response.data });
    }).catch(() => {
      if (active && !controller.signal.aborted) setLoadState({ kind: 'error' });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [input.onSessionEnded, loadAttempt]);

  function edit(update: Partial<MediaSettings>) {
    setDraft((current) => ({ ...current, ...update }));
    setSaveState('idle');
    setFailure(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settingsDocument || !hasChanges || saveState === 'saving') return;
    if (!parsedDraft.success) {
      setSaveState('validation');
      return;
    }
    setSaveState('saving');
    setFailure(null);
    try {
      const response = await requestUpdateMediaSettings(
        input.data.csrf_token,
        {
          settings: parsedDraft.data,
          expected_revision: settingsDocument.revision,
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
        setFailure(response.error.code);
        setSaveState(response.error.code === 'VALIDATION_ERROR'
          ? 'validation'
          : 'idle');
        return;
      }
      setDraft({ ...response.data.settings });
      setLoadState({ kind: 'ready', document: response.data });
      setSaveState('saved');
    } catch (error) {
      setFailure(error instanceof MediaSettingsClientError
        ? error.code
        : 'INVALID_RESPONSE');
      setSaveState('idle');
    }
  }

  const errorMessage = failure === 'FORBIDDEN'
    ? t('errors.forbidden')
    : failure === 'TIMEOUT'
        ? t('errors.timeout')
        : failure === 'NETWORK_ERROR'
          ? t('errors.network')
          : failure === 'INVALID_RESPONSE'
            ? t('errors.invalidResponse')
            : failure
              ? t('errors.api')
              : null;

  return (
    <SettingsScreen
      navigation="site"
      copy={{
        documentTitle: t('documentTitle'),
        kicker: t('kicker'),
        title: t('title'),
        description: t('description'),
        loading: { title: t('loading') },
        loadError: { title: t('loadError') },
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
      save={saveState}
      error={errorMessage}
      dirty={hasChanges}
      onReset={() => {
        if (settingsDocument) setDraft({ ...settingsDocument.settings });
        setSaveState('idle');
        setFailure(null);
      }}
      onSubmit={save}
    >
      <Panel
        title={t('section.title')}
        description={t('section.description')}
      >
        <div className="settings-fields">
          <Field
            label={t('fields.origin.label')}
            hint={t('fields.origin.description')}
          >
            {(control) => (
              <input
                {...control}
                type="url"
                inputMode="url"
                maxLength={2048}
                placeholder={t('fields.origin.placeholder')}
                value={draft.media_origin}
                disabled={saveState === 'saving'}
                onChange={(event) => edit({ media_origin: event.target.value })}
              />
            )}
          </Field>
          <Field
            label={t('fields.mode.label')}
            hint={t('fields.mode.description')}
          >
            {(control) => (
              <select
                {...control}
                value={draft.media_delivery_mode}
                disabled={saveState === 'saving'}
                onChange={(event) => edit({
                  media_delivery_mode: event.target
                    .value as MediaSettings['media_delivery_mode'],
                })}
              >
                <option value="none">{t('fields.mode.none')}</option>
                <option value="media_domain">
                  {t('fields.mode.mediaDomain')}
                </option>
              </select>
            )}
          </Field>
        </div>
      </Panel>
    </SettingsScreen>
  );
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  PUBLISHING_DEFAULTS,
  githubFileUrl,
  githubTokenUrl,
  parseGithubFileUrl,
  targetFromSettings,
  updatePublishingSettingsSchema,
  testPublishingConnectionSchema,
  type PublishingSettings,
  type PublishingSettingsDocument,
} from '../../contracts/publishing';
import {
  SettingsScreen,
  type SettingsSaveState,
} from './components/SettingsScreen';
import {
  Button,
  ButtonLink,
  Field,
  Notice,
  Panel,
  StudioIcon,
  Switch,
} from './components/primitives';
import {
  PublishingClientError,
  publishingErrorKey,
  requestPublishingSettings,
  requestUpdatePublishingSettings,
  requestTestPublishingConnection,
} from './lib/publishing-client';

export function PublishingSettingsPage(input: {
  data: { csrf_token: string };
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('publishing');
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<'loading' | 'error' | 'ready'>('loading');
  const [document, setDocument] = useState<PublishingSettingsDocument | null>(
    null,
  );
  const [draft, setDraft] = useState<PublishingSettings>({
    ...PUBLISHING_DEFAULTS,
  });
  const [fileUrl, setFileUrl] = useState('');
  const [manual, setManual] = useState(false);
  const [urlResolved, setUrlResolved] = useState(true);
  const [token, setToken] = useState('');
  const [removeToken, setRemoveToken] = useState(false);
  const [save, setSave] = useState<SettingsSaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<'idle' | 'running' | 'success'>('idle');
  const mounted = useRef(true);
  const connection = useRef<AbortController | null>(null);
  function restore(settings: PublishingSettings) {
    setDraft({ ...settings });
    setFileUrl(githubFileUrl(targetFromSettings(settings)));
    setUrlResolved(true);
    if (
      !githubFileUrl(settings) &&
      Object.values(targetFromSettings(settings)).some(Boolean)
    )
      setManual(true);
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      connection.current?.abort();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoad('loading');
    setError(null);
    setSave('idle');
    setTest('idle');
    void requestPublishingSettings(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.success) {
          if (result.error.code === 'AUTHENTICATION_REQUIRED')
            input.onSessionEnded();
          else {
            setError(result.error.code);
            setLoad('error');
          }
          return;
        }
        setDocument(result.data);
        restore(result.data.settings);
        setToken('');
        setRemoveToken(false);
        setLoad('ready');
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof PublishingClientError
              ? cause.code
              : 'INTERNAL_ERROR',
          );
          setLoad('error');
        }
      });
    return () => controller.abort();
  }, [attempt, input.onSessionEnded]);
  const parsedUrl = parseGithubFileUrl(fileUrl);
  const invalidUrl = !manual && Boolean(fileUrl) && !parsedUrl;
  const needsResolution = !manual && !urlResolved && Boolean(fileUrl);
  const credential = removeToken
    ? { action: 'remove' as const }
    : token
      ? { action: 'replace' as const, value: token }
      : { action: 'preserve' as const };
  const tokenAvailable =
    !removeToken && Boolean(token || document?.token_configured);
  const update = {
    settings: draft,
    credential,
    expected_revision: document?.revision ?? '',
    ...(needsResolution ? { file_url: fileUrl } : {}),
  };
  const testBody = {
    ...(!manual
      ? { file_url: fileUrl }
      : { target: targetFromSettings(draft) }),
    ...(token ? { credential: token } : {}),
    expected_revision: document?.revision ?? '',
  };
  const busy = save === 'saving' || test === 'running';
  const dirty = Boolean(
    document &&
    (JSON.stringify(draft) !== JSON.stringify(document.settings) ||
      needsResolution ||
      invalidUrl ||
      token ||
      removeToken),
  );
  function edited() {
    connection.current?.abort();
    setTest('idle');
    setError(null);
    setSave((state) => (state === 'conflict' ? state : 'idle'));
  }
  function handleError(code: string) {
    if (code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
    else if (code === 'SETTINGS_REVISION_CONFLICT') setSave('conflict');
    else setError(code);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || save === 'conflict') return;
    const parsed = updatePublishingSettingsSchema.safeParse(update);
    if (
      invalidUrl ||
      !parsed.success ||
      ((draft.enabled || needsResolution) && !tokenAvailable)
    ) {
      setSave('validation');
      return;
    }
    setSave('saving');
    setError(null);
    setTest('idle');
    try {
      const result = await requestUpdatePublishingSettings(
        input.data.csrf_token,
        parsed.data,
      );
      if (!mounted.current) return;
      if (result.success) {
        setDocument(result.data);
        restore(result.data.settings);
        setToken('');
        setRemoveToken(false);
        setSave('saved');
      } else {
        setSave('idle');
        handleError(result.error.code);
      }
    } catch (cause) {
      if (mounted.current) {
        setSave('idle');
        handleError(
          cause instanceof PublishingClientError
            ? cause.code
            : 'INTERNAL_ERROR',
        );
      }
    }
  }
  async function testConnection() {
    const parsed = testPublishingConnectionSchema.safeParse(testBody);
    if (!parsed.success || invalidUrl || busy || !tokenAvailable) return;
    const controller = new AbortController();
    connection.current = controller;
    setTest('running');
    setError(null);
    try {
      const result = await requestTestPublishingConnection(
        input.data.csrf_token,
        parsed.data,
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted) return;
      if (result.success) {
        setDraft((current) => ({ ...current, ...result.data.target }));
        setUrlResolved(true);
        setTest('success');
      } else {
        setTest('idle');
        handleError(result.error.code);
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setTest('idle');
        handleError(
          cause instanceof PublishingClientError
            ? cause.code
            : 'INTERNAL_ERROR',
        );
      }
    }
  }
  return (
    <SettingsScreen
      navigation="site"
      copy={{
        documentTitle: t('settings.title'),
        kicker: t('settings.kicker'),
        title: t('settings.title'),
        description: t('settings.description'),
        loading: { title: t('loading') },
        loadError: { title: t('loadError') },
        saved: t('settings.saved'),
        validation: t('settings.validation'),
        conflict: { title: t('errors.settingsConflict') },
        save: t('settings.save'),
      }}
      load={load}
      onRetry={() => setAttempt((value) => value + 1)}
      loadErrorDetail={error ? t(`errors.${publishingErrorKey(error)}`) : null}
      save={save}
      dirty={dirty}
      canSave={
        !busy &&
        !invalidUrl &&
        updatePublishingSettingsSchema.safeParse(update).success &&
        (!(draft.enabled || needsResolution) || tokenAvailable)
      }
      error={
        load === 'ready' && error
          ? t(`errors.${publishingErrorKey(error)}`)
          : null
      }
      reload={{
        label: t('retry'),
        onReload: () => {
          edited();
          setAttempt((value) => value + 1);
        },
      }}
      onReset={() => {
        if (document) {
          edited();
          restore(document.settings);
          setToken('');
          setRemoveToken(false);
        }
      }}
      onSubmit={(event) => void submit(event)}
    >
      <Panel title="GitHub" layout="split">
        <div className="settings-fields">
          <Switch
            label={t('settings.enabled')}
            checked={draft.enabled}
            disabled={busy}
            onChange={(enabled) => {
              edited();
              setDraft((value) => ({ ...value, enabled }));
            }}
          />
          {!manual ? (
            <Field
              label={t('settings.fileUrl')}
              hint={t('settings.fileUrlHint')}
              error={invalidUrl ? t('errors.urlInvalid') : undefined}
            >
              {(control) => (
                <input
                  {...control}
                  type="text"
                  inputMode="url"
                  value={fileUrl}
                  disabled={busy}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(event) => {
                    edited();
                    const value = event.target.value;
                    setFileUrl(value);
                    setUrlResolved(false);
                    const parsed = parseGithubFileUrl(value);
                    setDraft((current) => ({
                      ...current,
                      ...(parsed
                        ? {
                            owner: parsed.owner,
                            repo: parsed.repo,
                            branch: parsed.segments[0]!,
                            path: parsed.segments.slice(1).join('/'),
                          }
                        : { owner: '', repo: '', branch: '', path: '' }),
                    }));
                  }}
                />
              )}
            </Field>
          ) : null}
          {(['owner', 'repo', 'branch', 'path'] as const).map((key) => (
            <Field key={key} label={t(`settings.${key}`)}>
              {(control) => (
                <input
                  {...control}
                  value={draft[key]}
                  readOnly={!manual}
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    edited();
                    setDraft((value) => ({
                      ...value,
                      [key]: event.target.value,
                    }));
                  }}
                />
              )}
            </Field>
          ))}
          <Switch
            label={t('settings.manual')}
            checked={manual}
            disabled={busy}
            density="inline"
            onChange={(value) => {
              edited();
              setManual(value);
              if (!value) {
                setFileUrl(githubFileUrl(draft));
                setUrlResolved(false);
              }
            }}
          />
          <Field
            label={t('settings.token')}
            hint={t('settings.tokenHint')}
            note={
              document?.token_configured ? t('settings.tokenStored') : undefined
            }
          >
            {(control) => (
              <input
                {...control}
                type="password"
                value={token}
                autoComplete="new-password"
                disabled={busy || removeToken}
                onChange={(event) => {
                  edited();
                  setToken(event.target.value);
                }}
              />
            )}
          </Field>
          <div>
            <ButtonLink
              to={githubTokenUrl(draft.owner)}
              variant="secondary"
              external
            >
              {t('settings.createToken')}
              <StudioIcon icon={ExternalLink} />
            </ButtonLink>
          </div>
          {document?.token_configured ? (
            <Switch
              label={t('settings.removeToken')}
              checked={removeToken}
              density="inline"
              disabled={busy}
              onChange={(value) => {
                edited();
                setRemoveToken(value);
                setToken('');
              }}
            />
          ) : null}
          <Button
            type="button"
            disabled={
              busy ||
              invalidUrl ||
              !tokenAvailable ||
              save === 'conflict' ||
              !testPublishingConnectionSchema.safeParse(testBody).success
            }
            onClick={() => void testConnection()}
          >
            {t(test === 'running' ? 'settings.testing' : 'settings.test')}
          </Button>
          {test === 'success' ? (
            <Notice tone="success">{t('settings.testSuccess')}</Notice>
          ) : null}
        </div>
      </Panel>
    </SettingsScreen>
  );
}

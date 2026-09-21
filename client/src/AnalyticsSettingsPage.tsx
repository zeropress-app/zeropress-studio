import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  ANALYTICS_DEFAULTS,
  updateAnalyticsSettingsSchema,
  testAnalyticsConnectionSchema,
  type AnalyticsSettings,
  type AnalyticsSettingsDocument,
} from '../../contracts/analytics';
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
import { requestGeneralSettings } from './lib/general-settings-client';
import {
  CLOUDFLARE_ANALYTICS_SITES_URL,
  CLOUDFLARE_ANALYTICS_TOKEN_URL,
  createAnalyticsDashboardUrl,
  parseAnalyticsDashboardUrl,
} from './lib/analytics-dashboard-url';
import {
  AnalyticsClientError,
  analyticsErrorKey,
  requestAnalyticsSettings,
  requestUpdateAnalyticsSettings,
  requestTestAnalyticsConnection,
} from './lib/analytics-client';
import './screens/analytics.css';

export function AnalyticsSettingsPage(input: {
  data: { csrf_token: string };
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('analytics');
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<'loading' | 'error' | 'ready'>('loading');
  const [document, setDocument] = useState<AnalyticsSettingsDocument | null>(
    null,
  );
  const [draft, setDraft] = useState<AnalyticsSettings>({
    ...ANALYTICS_DEFAULTS,
  });
  const [dashboardUrl, setDashboardUrl] = useState('');
  const [manualIds, setManualIds] = useState(false);
  const [token, setToken] = useState('');
  const [removeToken, setRemoveToken] = useState(false);
  const [target, setTarget] = useState('');
  const [save, setSave] = useState<SettingsSaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<
    'idle' | 'running' | 'data_found' | 'no_data'
  >('idle');
  const connection = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  function restoreDraft(settings: AnalyticsSettings) {
    const url = createAnalyticsDashboardUrl(settings);
    setDraft({ ...settings });
    setDashboardUrl(url);
    if (!url && (settings.account_id || settings.site_tag)) setManualIds(true);
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
    let active = true;
    setLoad('loading');
    setError(null);
    setSave('idle');
    void Promise.all([
      requestAnalyticsSettings(controller.signal),
      requestGeneralSettings(controller.signal),
    ])
      .then(([settings, general]) => {
        if (!active) return;
        if (!settings.success || !general.success) {
          const code = !settings.success
            ? settings.error.code
            : !general.success
              ? general.error.code
              : 'INTERNAL_ERROR';
          if (code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
          else {
            setError(code);
            setLoad('error');
          }
          return;
        }
        setDocument(settings.data);
        restoreDraft(settings.data.settings);
        setToken('');
        setRemoveToken(false);
        setTarget(
          general.data.settings.url
            ? `${new URL(general.data.settings.url).hostname} · ${general.data.settings.timezone}`
            : '',
        );
        setLoad('ready');
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(
            cause instanceof AnalyticsClientError
              ? cause.code
              : 'INTERNAL_ERROR',
          );
          setLoad('error');
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, input.onSessionEnded]);
  const urlIds = parseAnalyticsDashboardUrl(dashboardUrl);
  const invalidUrl =
    !manualIds &&
    !urlIds &&
    Boolean(dashboardUrl || draft.account_id || draft.site_tag);
  const dirty = Boolean(
    document &&
    (JSON.stringify(draft) !== JSON.stringify(document.settings) ||
      invalidUrl ||
      token ||
      removeToken),
  );
  const credential = removeToken
    ? { action: 'remove' as const }
    : token
      ? { action: 'replace' as const, value: token }
      : { action: 'preserve' as const };
  const update = {
    settings: draft,
    credential,
    expected_revision: document?.revision ?? '',
  };
  const tokenAvailable =
    !removeToken && Boolean(token || document?.token_configured);
  const busy = save === 'saving' || test === 'running';
  const testBody = {
    account_id: draft.account_id,
    site_tag: draft.site_tag,
    ...(token ? { credential: token } : {}),
  };
  function edited() {
    connection.current?.abort();
    setTest('idle');
    setError(null);
    setSave((state) => (state === 'conflict' ? state : 'idle'));
  }
  function reset() {
    if (!document) return;
    edited();
    restoreDraft(document.settings);
    setToken('');
    setRemoveToken(false);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || save === 'conflict') return;
    const parsed = updateAnalyticsSettingsSchema.safeParse(update);
    if (invalidUrl || !parsed.success || (draft.enabled && !tokenAvailable)) {
      setSave('validation');
      return;
    }
    setSave('saving');
    setError(null);
    setTest('idle');
    try {
      const result = await requestUpdateAnalyticsSettings(
        input.data.csrf_token,
        parsed.data,
      );
      if (!mounted.current) return;
      if (result.success) {
        setDocument(result.data);
        restoreDraft(result.data.settings);
        setToken('');
        setRemoveToken(false);
        setSave('saved');
      } else if (result.error.code === 'AUTHENTICATION_REQUIRED')
        input.onSessionEnded();
      else if (result.error.code === 'SETTINGS_REVISION_CONFLICT')
        setSave('conflict');
      else {
        setSave('idle');
        setError(result.error.code);
      }
    } catch (cause) {
      if (mounted.current) {
        setSave('idle');
        setError(
          cause instanceof AnalyticsClientError ? cause.code : 'INTERNAL_ERROR',
        );
      }
    }
  }
  async function testConnection() {
    const parsed = testAnalyticsConnectionSchema.safeParse(testBody);
    if (invalidUrl || !parsed.success || !tokenAvailable || busy) return;
    connection.current?.abort();
    const controller = new AbortController();
    connection.current = controller;
    setTest('running');
    setError(null);
    try {
      const result = await requestTestAnalyticsConnection(
        input.data.csrf_token,
        parsed.data,
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted) return;
      if (result.success) setTest(result.data.status);
      else {
        setTest('idle');
        if (result.error.code === 'AUTHENTICATION_REQUIRED')
          input.onSessionEnded();
        else setError(result.error.code);
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setTest('idle');
        setError(
          cause instanceof AnalyticsClientError ? cause.code : 'INTERNAL_ERROR',
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
        conflict: {
          title: t('settings.conflict'),
          description: t('settings.conflictDescription'),
        },
        save: t('settings.save'),
      }}
      load={load}
      loadErrorDetail={error ? t(`errors.${analyticsErrorKey(error)}`) : null}
      onRetry={() => setAttempt((value) => value + 1)}
      save={save}
      dirty={dirty}
      canSave={
        !busy &&
        !invalidUrl &&
        updateAnalyticsSettingsSchema.safeParse(update).success &&
        (!draft.enabled || tokenAvailable)
      }
      error={
        load === 'ready' && error
          ? t(`errors.${analyticsErrorKey(error)}`)
          : null
      }
      reload={{
        label: t('retry'),
        onReload: () => {
          edited();
          setAttempt((value) => value + 1);
        },
      }}
      onReset={reset}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <Panel title="Cloudflare Web Analytics" layout="split">
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
          {!manualIds ? (
            <>
              <Field
                label={t('settings.dashboardUrl')}
                hint={t('settings.dashboardUrlHint')}
                error={
                  invalidUrl ? t('settings.dashboardUrlInvalid') : undefined
                }
              >
                {(control) => (
                  <input
                    {...control}
                    type="text"
                    inputMode="url"
                    value={dashboardUrl}
                    disabled={busy}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    onChange={(event) => {
                      edited();
                      const value = event.target.value;
                      setDashboardUrl(value);
                      const ids = parseAnalyticsDashboardUrl(value);
                      if (ids) setDraft((current) => ({ ...current, ...ids }));
                    }}
                  />
                )}
              </Field>
              <div>
                <ButtonLink
                  to={CLOUDFLARE_ANALYTICS_SITES_URL}
                  variant="secondary"
                  external
                >
                  {t('settings.selectSite')}
                  <StudioIcon icon={ExternalLink} />
                </ButtonLink>
              </div>
            </>
          ) : null}
          {(['account_id', 'site_tag'] as const).map((key) => (
            <Field key={key} label={t(`settings.${key}`)}>
              {(control) => (
                <input
                  {...control}
                  value={manualIds || urlIds ? draft[key] : ''}
                  readOnly={!manualIds}
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
            label={t('settings.manualIds')}
            checked={manualIds}
            disabled={busy}
            density="inline"
            onChange={(manual) => {
              setManualIds(manual);
              if (!manual) setDashboardUrl(createAnalyticsDashboardUrl(draft));
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
              to={CLOUDFLARE_ANALYTICS_TOKEN_URL}
              variant="secondary"
              external
            >
              {t('settings.createToken')}
              <StudioIcon icon={ExternalLink} />
            </ButtonLink>
          </div>
          {document?.token_configured ? (
            <Field label={t('settings.removeToken')}>
              {(control) => (
                <input
                  {...control}
                  type="checkbox"
                  checked={removeToken}
                  disabled={busy}
                  onChange={(event) => {
                    edited();
                    setRemoveToken(event.target.checked);
                    setToken('');
                  }}
                />
              )}
            </Field>
          ) : null}
          <p className="analytics-context">
            {target || t('errors.siteMissing')}
          </p>
          <Button
            type="button"
            disabled={
              busy ||
              invalidUrl ||
              !target ||
              !tokenAvailable ||
              !testAnalyticsConnectionSchema.safeParse(testBody).success
            }
            onClick={() => {
              void testConnection();
            }}
          >
            {t(test === 'running' ? 'settings.testing' : 'settings.test')}
          </Button>
          {test === 'data_found' || test === 'no_data' ? (
            <Notice tone={test === 'data_found' ? 'success' : 'info'}>
              {t(`settings.${test}`)}
            </Notice>
          ) : null}
        </div>
      </Panel>
    </SettingsScreen>
  );
}

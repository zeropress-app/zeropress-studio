import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';
import type { ApiErrorCode } from '../../contracts/api';
import {
  areCommentSettingsEqual,
  COMMENT_SETTINGS_DEFAULTS,
  normalizeCommentApiBaseUrl,
  normalizeSupabaseProjectUrl,
  normalizeSupabasePublishableKey,
  type CommentRequestSecurityResource,
  type CommentSettings,
  type CommentSettingsDocument,
} from '../../contracts/comment-settings';
import type { CurrentSessionSuccess } from '../../contracts/session';
import {
  Button,
  Callout,
  Dialog,
  Field,
  InlineStatus,
  Notice,
  Panel,
  StatusPill,
  Switch,
  SwitchGroup,
} from './components/primitives';
import { SettingsScreen } from './components/SettingsScreen';
import {
  CommentSettingsClientError,
  requestCommentRequestSecurity,
  requestCommentSettings,
  requestResetCommentRequestSecurity,
  requestRotateCommentRequestSecurity,
  requestUpdateCommentSettings,
  type CommentSettingsClientErrorCode,
} from './lib/comment-settings-client';
import { requestGeneralSettings } from './lib/general-settings-client';

type AccountSession = CurrentSessionSuccess['data'];
type EditableSupabaseAuth = Omit<
  CommentSettings['auth'],
  'project_url' | 'publishable_key'
> & {
  project_url: string;
  publishable_key: string;
};
type EditableSettings = Omit<CommentSettings, 'api_base_url' | 'auth'> & {
  api_base_url: string;
  auth: EditableSupabaseAuth;
};
type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: CommentSettingsClientErrorCode }
  | { kind: 'unexpected' };
type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      document: CommentSettingsDocument;
      siteUrl: string;
      generalSettingsAvailable: boolean;
    }
  | { kind: 'error'; failure: Failure };
type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'validation' }
  | { kind: 'failed'; failure: Failure };
type RequestSecurityState =
  | { kind: 'loading' }
  | { kind: 'ready'; resource: CommentRequestSecurityResource }
  | { kind: 'error'; failure: Failure };
type RequestSecurityAction = 'rotate' | 'reset';
type RequestSecurityActionState =
  | { kind: 'idle' }
  | { kind: 'running'; action: RequestSecurityAction }
  | { kind: 'completed'; action: RequestSecurityAction }
  | { kind: 'failed'; action: RequestSecurityAction; failure: Failure };

const EMPTY_DRAFT: EditableSettings = {
  ...COMMENT_SETTINGS_DEFAULTS,
  api_base_url: '',
  threading: { ...COMMENT_SETTINGS_DEFAULTS.threading },
  moderation: { ...COMMENT_SETTINGS_DEFAULTS.moderation },
  auth: {
    ...COMMENT_SETTINGS_DEFAULTS.auth,
    project_url: '',
    publishable_key: '',
  },
};

function editable(settings: CommentSettings): EditableSettings {
  return {
    ...settings,
    api_base_url: settings.api_base_url ?? '',
    threading: { ...settings.threading },
    moderation: { ...settings.moderation },
    auth: {
      ...settings.auth,
      project_url: settings.auth.project_url ?? '',
      publishable_key: settings.auth.publishable_key ?? '',
    },
  };
}

function normalizedDraft(settings: EditableSettings): CommentSettings | null {
  const trimmedApiBaseUrl = settings.api_base_url.trim();
  const apiBaseUrl = trimmedApiBaseUrl
    ? normalizeCommentApiBaseUrl(trimmedApiBaseUrl)
    : null;
  const trimmedProjectUrl = settings.auth.project_url.trim();
  const trimmedPublishableKey = settings.auth.publishable_key.trim();
  const projectUrl = trimmedProjectUrl
    ? normalizeSupabaseProjectUrl(trimmedProjectUrl)
    : null;
  const publishableKey = trimmedPublishableKey
    ? normalizeSupabasePublishableKey(trimmedPublishableKey)
    : null;
  if (trimmedApiBaseUrl && apiBaseUrl === null) return null;
  if (
    (trimmedProjectUrl && projectUrl === null)
    || (trimmedPublishableKey && publishableKey === null)
    || (projectUrl === null) !== (publishableKey === null)
    || (settings.auth.enabled
      && (projectUrl === null || publishableKey === null))
  ) return null;
  if (
    !Number.isInteger(settings.per_page)
    || settings.per_page < 1
    || settings.per_page > 100
    || !Number.isInteger(settings.threading.max_depth)
    || settings.threading.max_depth < 2
    || settings.threading.max_depth > 10
  ) return null;
  return {
    enabled: settings.enabled,
    provider: 'zeropress',
    api_base_url: apiBaseUrl,
    per_page: settings.per_page,
    order: settings.order,
    threading: { ...settings.threading },
    moderation: { ...settings.moderation },
    auth: {
      enabled: settings.auth.enabled,
      provider: 'supabase',
      project_url: projectUrl,
      publishable_key: publishableKey,
    },
  };
}

type SupabaseDashboardGuidance = {
  urlConfigurationUrl: string;
  jwtKeysUrl: string;
  siteUrl: string | null;
  redirectUrl: string | null;
};

function createSupabaseDashboardGuidance(
  projectUrlValue: string,
  siteUrlValue: string,
): SupabaseDashboardGuidance | null {
  const normalized = normalizeSupabaseProjectUrl(projectUrlValue.trim());
  if (!normalized) return null;

  const projectUrl = new URL(normalized);
  const projectMatch = /^([a-z0-9]{20})\.supabase\.co$/u.exec(
    projectUrl.hostname,
  );
  if (projectUrl.protocol !== 'https:' || projectUrl.port || !projectMatch) {
    return null;
  }

  const dashboardBase = `https://supabase.com/dashboard/project/${encodeURIComponent(projectMatch[1])}`;
  let siteUrl: string | null = null;
  try {
    const candidate = new URL(siteUrlValue);
    if (
      ['http:', 'https:'].includes(candidate.protocol)
      && candidate.username === ''
      && candidate.password === ''
      && candidate.search === ''
      && candidate.hash === ''
    ) {
      const pathname = candidate.pathname.replace(/\/+$/u, '');
      siteUrl = `${candidate.origin}${pathname === '/' ? '' : pathname}`;
    }
  } catch {
    // A missing canonical Site URL is handled by the setup guidance below.
  }

  return {
    urlConfigurationUrl: `${dashboardBase}/auth/url-configuration`,
    jwtKeysUrl: `${dashboardBase}/settings/jwt`,
    siteUrl,
    redirectUrl: siteUrl ? `${siteUrl}/**` : null,
  };
}

function clientFailure(error: unknown): Failure {
  return error instanceof CommentSettingsClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

function CommentRequestSecurityDialog(input: {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  busyLabel: string;
  busy: boolean;
  destructive: boolean;
  failureMessage: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      busy={input.busy}
      onClose={input.onClose}
      title={input.title}
      description={input.description}
      initialFocusRef={cancelRef}
      actions={(
        <>
          <Button
            ref={cancelRef}
            type="button"
            disabled={input.busy}
            onClick={input.onClose}
          >
            {input.cancelLabel}
          </Button>
          <Button
            type="button"
            variant={input.destructive ? 'danger' : 'primary'}
            disabled={input.busy}
            onClick={input.onConfirm}
          >
            {input.busy ? input.busyLabel : input.confirmLabel}
          </Button>
        </>
      )}
    >
      {input.failureMessage ? (
        <div className="settings-dialog-body">
          <Notice tone="error">{input.failureMessage}</Notice>
        </div>
      ) : null}
    </Dialog>
  );
}

export function CommentSettingsPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { hash } = useLocation();
  const apiBaseUrlRef = useRef<HTMLInputElement>(null);
  const { t, i18n } = useTranslation('settings');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<EditableSettings>({ ...EMPTY_DRAFT });
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [requestSecurityLoadAttempt, setRequestSecurityLoadAttempt] =
    useState(0);
  const [requestSecurityState, setRequestSecurityState] =
    useState<RequestSecurityState>({ kind: 'loading' });
  const [requestSecurityAction, setRequestSecurityAction] =
    useState<RequestSecurityActionState>({ kind: 'idle' });
  const [requestSecurityDialog, setRequestSecurityDialog] =
    useState<RequestSecurityAction | null>(null);

  const settingsDocument = loadState.kind === 'ready'
    ? loadState.document
    : null;
  useEffect(() => {
    if (hash === '#comment-api' && loadState.kind === 'ready') {
      apiBaseUrlRef.current?.focus();
    }
  }, [hash, loadState.kind]);
  const normalized = useMemo(() => normalizedDraft(draft), [draft]);
  const apiBaseInvalid = draft.api_base_url.trim() !== ''
    && normalizeCommentApiBaseUrl(draft.api_base_url.trim()) === null;
  const perPageInvalid = !Number.isInteger(draft.per_page)
    || draft.per_page < 1
    || draft.per_page > 100;
  const maxDepthInvalid = !Number.isInteger(draft.threading.max_depth)
    || draft.threading.max_depth < 2
    || draft.threading.max_depth > 10;
  const trimmedSupabaseProjectUrl = draft.auth.project_url.trim();
  const trimmedSupabasePublishableKey = draft.auth.publishable_key.trim();
  const supabaseProjectUrlInvalid = trimmedSupabaseProjectUrl !== ''
    && normalizeSupabaseProjectUrl(trimmedSupabaseProjectUrl) === null;
  const supabasePublishableKeyInvalid = trimmedSupabasePublishableKey !== ''
    && normalizeSupabasePublishableKey(trimmedSupabasePublishableKey) === null;
  const supabasePairIncomplete = Boolean(trimmedSupabaseProjectUrl)
    !== Boolean(trimmedSupabasePublishableKey);
  const supabaseEnabledIncomplete = draft.auth.enabled
    && (!trimmedSupabaseProjectUrl || !trimmedSupabasePublishableKey);
  const supabaseDashboardGuidance = loadState.kind === 'ready'
    ? createSupabaseDashboardGuidance(
        draft.auth.project_url,
        loadState.siteUrl,
      )
    : null;
  const hasChanges = settingsDocument !== null
    && normalized !== null
    && !areCommentSettingsEqual(normalized, settingsDocument.settings);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setSaveState({ kind: 'idle' });
    void Promise.all([
      requestCommentSettings(controller.signal),
      requestGeneralSettings(controller.signal).catch(() => null),
    ]).then(([commentsResponse, generalResponse]) => {
      if (!active) return;
      if (!commentsResponse.success) {
        if (commentsResponse.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({
          kind: 'error',
          failure: { kind: 'api', code: commentsResponse.error.code },
        });
        return;
      }
      if (
        generalResponse
        && !generalResponse.success
        && generalResponse.error.code === 'AUTHENTICATION_REQUIRED'
      ) {
        input.onSessionEnded();
        return;
      }
      const generalSettingsAvailable = generalResponse?.success === true;
      setDraft(editable(commentsResponse.data.settings));
      setLoadState({
        kind: 'ready',
        document: commentsResponse.data,
        siteUrl: generalSettingsAvailable
          ? generalResponse.data.settings.url
          : '',
        generalSettingsAvailable,
      });
    }).catch((error) => {
      if (!active || controller.signal.aborted) return;
      setLoadState({ kind: 'error', failure: clientFailure(error) });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [input.onSessionEnded, loadAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setRequestSecurityState({ kind: 'loading' });
    setRequestSecurityAction({ kind: 'idle' });
    void requestCommentRequestSecurity(controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setRequestSecurityState({
          kind: 'error',
          failure: { kind: 'api', code: response.error.code },
        });
        return;
      }
      setRequestSecurityState({ kind: 'ready', resource: response.data });
    }).catch((error) => {
      if (!active || controller.signal.aborted) return;
      setRequestSecurityState({
        kind: 'error',
        failure: clientFailure(error),
      });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [input.onSessionEnded, requestSecurityLoadAttempt]);

  function updateDraft<K extends keyof EditableSettings>(
    key: K,
    value: EditableSettings[K],
  ) {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaveState((current) => current.kind === 'conflict'
      ? current
      : { kind: 'idle' });
  }

  function updateAuth(value: Partial<EditableSupabaseAuth>) {
    setDraft((current) => ({
      ...current,
      auth: { ...current.auth, ...value },
    }));
    setSaveState((current) => current.kind === 'conflict'
      ? current
      : { kind: 'idle' });
  }

  function failureMessage(failure: Failure): string {
    if (failure.kind === 'client') {
      if (failure.code === 'TIMEOUT') return t('comments.errors.timeout');
      if (failure.code === 'NETWORK_ERROR') return t('comments.errors.network');
      return t('comments.errors.invalidResponse');
    }
    if (failure.kind === 'unexpected') return t('comments.errors.api');
    if (failure.code === 'FORBIDDEN') return t('comments.errors.forbidden');
    if (failure.code === 'COMMENT_REQUEST_SECURITY_REVISION_CONFLICT') {
      return t('comments.requestSecurity.errors.conflict');
    }
    if (failure.code === 'COMMENT_REQUEST_SECURITY_NOT_ROTATABLE') {
      return t('comments.requestSecurity.errors.notRotatable');
    }
    if (failure.code === 'VALIDATION_ERROR') {
      return t('comments.errors.validation');
    }
    return t('comments.errors.api');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settingsDocument || saveState.kind === 'saving') return;
    if (!normalized) {
      setSaveState({ kind: 'validation' });
      return;
    }
    setSaveState({ kind: 'saving' });
    try {
      const response = await requestUpdateCommentSettings(
        input.data.csrf_token,
        {
          settings: normalized,
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
      setDraft(editable(response.data.settings));
      setLoadState((current) => current.kind === 'ready'
        ? { ...current, document: response.data }
        : current);
      setSaveState({ kind: 'saved' });
      // A settings write is allowed to initialize a genuinely missing Edge
      // keyset. Refresh the independently revisioned lifecycle resource so the
      // card never keeps showing the pre-save snapshot.
      setRequestSecurityLoadAttempt((current) => current + 1);
    } catch (error) {
      setSaveState({ kind: 'failed', failure: clientFailure(error) });
    }
  }

  async function mutateRequestSecurity(action: RequestSecurityAction) {
    if (
      requestSecurityState.kind !== 'ready'
      || requestSecurityAction.kind === 'running'
    ) return;
    setRequestSecurityAction({ kind: 'running', action });
    try {
      const request = {
        expected_revision: requestSecurityState.resource.revision,
      };
      const response = action === 'rotate'
        ? await requestRotateCommentRequestSecurity(
            input.data.csrf_token,
            request,
          )
        : await requestResetCommentRequestSecurity(
            input.data.csrf_token,
            request,
          );
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        const failure: Failure = {
          kind: 'api',
          code: response.error.code,
        };
        if (
          response.error.code === 'COMMENT_REQUEST_SECURITY_REVISION_CONFLICT'
          || response.error.code === 'COMMENT_REQUEST_SECURITY_NOT_ROTATABLE'
        ) {
          // The displayed keyset snapshot can no longer authorize another
          // mutation. Close the confirmation and require an explicit reload
          // instead of allowing a repeated request with the stale revision.
          setRequestSecurityState({ kind: 'error', failure });
          setRequestSecurityAction({ kind: 'idle' });
          setRequestSecurityDialog(null);
          return;
        }
        setRequestSecurityAction({
          kind: 'failed',
          action,
          failure,
        });
        return;
      }
      setRequestSecurityState({ kind: 'ready', resource: response.data });
      setRequestSecurityAction({ kind: 'completed', action });
      setRequestSecurityDialog(null);
    } catch (error) {
      setRequestSecurityAction({
        kind: 'failed',
        action,
        failure: clientFailure(error),
      });
    }
  }

  const lastSaved = settingsDocument?.updated_at_iso
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(settingsDocument.updated_at_iso))
    : null;
  const requestSecurityResource = requestSecurityState.kind === 'ready'
    ? requestSecurityState.resource
    : null;
  const requestSecurityCreated = requestSecurityResource?.current_key
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(requestSecurityResource.current_key.created_at_iso))
    : null;
  const requestSecurityBusy = requestSecurityAction.kind === 'running';
  const requestSecurityDialogFailure = requestSecurityAction.kind === 'failed'
    && requestSecurityAction.action === requestSecurityDialog
    ? failureMessage(requestSecurityAction.failure)
    : null;
  const requestSecurityDialogKind = requestSecurityDialog === 'rotate'
    ? 'rotate'
    : requestSecurityDialog === 'reset' && requestSecurityResource
      ? requestSecurityResource.status === 'missing'
        ? 'initialize'
        : requestSecurityResource.status === 'invalid'
          ? 'recover'
          : 'reset'
      : null;

  const saving = saveState.kind === 'saving';
  const reload = () => setLoadAttempt((value) => value + 1);
  return (
    <SettingsScreen
      navigation="edge"
      copy={{
        documentTitle: t('comments.documentTitle'),
        kicker: t('comments.kicker'),
        title: t('comments.title'),
        description: t('comments.description'),
        loading: {
          title: t('comments.loading.title'),
          description: t('comments.loading.description'),
        },
        loadError: {
          title: t('comments.loadError.title'),
          description: t('comments.loadError.description'),
        },
        saved: t('comments.state.saved'),
        validation: t('comments.errors.validation'),
        conflict: {
          title: t('comments.errors.conflictTitle'),
          description: t('comments.errors.conflictDescription'),
        },
        save: t('comments.actions.save'),
      }}
      load={loadState.kind}
      onRetry={reload}
      loadErrorDetail={loadState.kind === 'error'
        ? failureMessage(loadState.failure)
        : null}
      save={saveState.kind === 'failed' ? 'idle' : saveState.kind}
      error={saveState.kind === 'failed'
        ? failureMessage(saveState.failure)
        : null}
      reload={{ label: t('comments.errors.reload'), onReload: reload }}
      dirty={hasChanges}
      canSave={normalized !== null}
      statusDetail={lastSaved
        ? t('comments.state.lastSaved', { date: lastSaved })
        : null}
      onReset={() => {
        if (!settingsDocument) return;
        setDraft(editable(settingsDocument.settings));
        setSaveState({ kind: 'idle' });
      }}
      onSubmit={(event) => void save(event)}
    >
      <Panel
        layout="split"
        title={t('comments.runtime.title')}
        description={t('comments.runtime.description')}
      >
        <div className="settings-fields">
          {loadState.kind === 'ready'
            && !loadState.generalSettingsAvailable ? (
              <Callout tone="warning">
                {t('comments.errors.generalSettingsUnavailable')}
              </Callout>
            ) : null}
          <SwitchGroup>
            <Switch
              label={t('comments.fields.enabled.label')}
              description={t('comments.fields.enabled.description')}
              checked={draft.enabled}
              disabled={saving}
              onChange={(enabled) => updateDraft('enabled', enabled)}
            />
          </SwitchGroup>
          <div id="comment-api">
            <Field
              label={t('comments.fields.apiBaseUrl.label')}
              hint={t('comments.fields.apiBaseUrl.description')}
              error={apiBaseInvalid
                ? t('comments.fields.apiBaseUrl.error')
                : undefined}
            >
              {(control) => (
                <input
                  {...control}
                  ref={apiBaseUrlRef}
                  className="studio-field-input"
                  value={draft.api_base_url}
                  placeholder="https://edge.example.com/api"
                  disabled={saving}
                  onChange={(event) => updateDraft(
                    'api_base_url',
                    event.target.value,
                  )}
                />
              )}
            </Field>
          </div>
          <div className="settings-fields settings-fields-split">
            <Field
              label={t('comments.fields.perPage.label')}
              hint={t('comments.fields.perPage.description')}
              error={perPageInvalid
                ? t('comments.fields.perPage.error')
                : undefined}
            >
              {(control) => (
                <input
                  {...control}
                  type="number"
                  min={1}
                  max={100}
                  value={draft.per_page}
                  disabled={saving}
                  onChange={(event) => updateDraft(
                    'per_page',
                    Number(event.target.value),
                  )}
                />
              )}
            </Field>
            <Field label={t('comments.fields.order.label')}>
              {(control) => (
                <select
                  {...control}
                  value={draft.order}
                  disabled={saving}
                  onChange={(event) => updateDraft(
                    'order',
                    event.target.value as CommentSettings['order'],
                  )}
                >
                  <option value="desc">{t('comments.fields.order.desc')}</option>
                  <option value="asc">{t('comments.fields.order.asc')}</option>
                </select>
              )}
            </Field>
          </div>
        </div>
      </Panel>

      <Panel
        layout="split"
        title={t('comments.threading.title')}
        description={t('comments.threading.description')}
      >
        <div className="settings-fields">
          <SwitchGroup>
            <Switch
              label={t('comments.fields.threading.label')}
              description={t('comments.fields.threading.description')}
              checked={draft.threading.enabled}
              disabled={saving}
              onChange={(enabled) => updateDraft('threading', {
                ...draft.threading,
                enabled,
              })}
            />
          </SwitchGroup>
          <Field
            label={t('comments.fields.maxDepth.label')}
            hint={t('comments.fields.maxDepth.description')}
            error={maxDepthInvalid
              ? t('comments.fields.maxDepth.error')
              : undefined}
          >
            {(control) => (
              <input
                {...control}
                type="number"
                min={2}
                max={10}
                value={draft.threading.max_depth}
                disabled={saving}
                onChange={(event) => updateDraft('threading', {
                  ...draft.threading,
                  max_depth: Number(event.target.value),
                })}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        layout="split"
        title={t('comments.moderation.title')}
        description={t('comments.moderation.description')}
      >
        <SwitchGroup>
          <Switch
            label={t('comments.fields.requireApproval.label')}
            description={t('comments.fields.requireApproval.description')}
            checked={draft.moderation.require_approval}
            disabled={saving}
            onChange={(requireApproval) => updateDraft('moderation', {
              require_approval: requireApproval,
            })}
          />
        </SwitchGroup>
      </Panel>

      <Panel
        layout="split"
        title={t('comments.auth.title')}
        description={t('comments.auth.description')}
      >
        <div className="settings-fields">
          <SwitchGroup>
            <Switch
              label={t('comments.auth.enabled.label')}
              description={t('comments.auth.enabled.description')}
              checked={draft.auth.enabled}
              disabled={saving}
              onChange={(enabled) => updateAuth({ enabled })}
            />
          </SwitchGroup>
          <Field
            label={t('comments.auth.projectUrl.label')}
            hint={t('comments.auth.projectUrl.description')}
            error={supabaseProjectUrlInvalid
              ? t('comments.auth.projectUrl.error')
              : undefined}
          >
            {(control) => (
              <input
                {...control}
                value={draft.auth.project_url}
                placeholder="https://example.supabase.co"
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
                onChange={(event) => updateAuth({
                  project_url: event.target.value,
                })}
              />
            )}
          </Field>
          <Field
            label={t('comments.auth.publishableKey.label')}
            hint={t('comments.auth.publishableKey.description')}
            error={supabasePublishableKeyInvalid
              ? t('comments.auth.publishableKey.error')
              : undefined}
          >
            {(control) => (
              <input
                {...control}
                value={draft.auth.publishable_key}
                placeholder="sb_publishable_..."
                autoComplete="off"
                spellCheck={false}
                disabled={saving}
                onChange={(event) => updateAuth({
                  publishable_key: event.target.value,
                })}
              />
            )}
          </Field>
          {supabasePairIncomplete || supabaseEnabledIncomplete ? (
            <Notice tone="error">
              {supabasePairIncomplete
                ? t('comments.auth.errors.pair')
                : t('comments.auth.errors.enabled')}
            </Notice>
          ) : null}
          {/*
           * Warn that only the public key belongs here. Use a notice because no action is
           * required.
           */}
          <Notice tone="warning" title={t('comments.auth.security.title')}>
            {`${t('comments.auth.security.description')} ${t('comments.auth.security.jwt')}`}
          </Notice>
          {supabaseDashboardGuidance ? (
            <div
              className="comment-auth-guidance"
              data-testid="supabase-hosted-project-guidance"
            >
              <strong className="comment-auth-guidance-title">
                {t('comments.auth.guidance.title')}
              </strong>
              <ol>
                <li>
                  <a
                    href={supabaseDashboardGuidance.urlConfigurationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('comments.auth.guidance.urlConfiguration')}
                  </a>
                  {supabaseDashboardGuidance.siteUrl
                    && supabaseDashboardGuidance.redirectUrl ? (
                      <p>{t('comments.auth.guidance.redirectConfigured', {
                        siteUrl: supabaseDashboardGuidance.siteUrl,
                        redirectUrl: supabaseDashboardGuidance.redirectUrl,
                      })}</p>
                    ) : (
                      <p>{t('comments.auth.guidance.redirectMissing')}</p>
                    )}
                </li>
                <li>
                  <a
                    href={supabaseDashboardGuidance.jwtKeysUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t('comments.auth.guidance.jwtKeys')}
                  </a>
                  <p>{t('comments.auth.guidance.jwtDescription')}</p>
                </li>
              </ol>
            </div>
          ) : null}
        </div>
      </Panel>

      <Panel
        layout="split"
        title={t('comments.requestSecurity.title')}
        description={t('comments.requestSecurity.description')}
      >
        <div className="settings-fields">
          {requestSecurityState.kind === 'loading' ? (
            <InlineStatus>
              {t('comments.requestSecurity.loading')}
            </InlineStatus>
          ) : null}
          {requestSecurityState.kind === 'error' ? (
            <Notice
              tone="error"
              actions={(
                <Button
                  type="button"
                  onClick={() => setRequestSecurityLoadAttempt(
                    (value) => value + 1,
                  )}
                >
                  {t('comments.requestSecurity.actions.reload')}
                </Button>
              )}
            >
              {failureMessage(requestSecurityState.failure)}
            </Notice>
          ) : null}
          {requestSecurityResource ? (
            <>
              <div className="settings-keyset">
                <div className="settings-keyset-heading">
                  <strong className="settings-keyset-label">
                    {t('comments.requestSecurity.status.label')}
                  </strong>
                  <StatusPill
                    tone={requestSecurityResource.status === 'valid'
                      ? 'positive'
                      : requestSecurityResource.status === 'missing'
                        ? 'attention'
                        : 'critical'}
                  >
                    {t(`comments.requestSecurity.status.${requestSecurityResource.status}`)}
                  </StatusPill>
                </div>
                {requestSecurityResource.status === 'valid' ? (
                  <dl className="settings-keyset-detail">
                    <div>
                      <dt>{t('comments.requestSecurity.currentKey')}</dt>
                      <dd>
                        <code>{requestSecurityResource.current_key?.kid}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>{t('comments.requestSecurity.created')}</dt>
                      <dd>{requestSecurityCreated ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>{t('comments.requestSecurity.previousKeys')}</dt>
                      <dd>{t('comments.requestSecurity.previousSummary', {
                        active:
                          requestSecurityResource.previous_keys.active_count,
                        total: requestSecurityResource.previous_keys.total_count,
                      })}</dd>
                    </div>
                  </dl>
                ) : (
                  <p className="settings-keyset-note">
                    {t(`comments.requestSecurity.statusDescription.${requestSecurityResource.status}`)}
                  </p>
                )}
              </div>

              {requestSecurityAction.kind === 'completed' ? (
                <Notice tone="success">
                  {t(`comments.requestSecurity.completed.${requestSecurityAction.action}`)}
                </Notice>
              ) : null}

              {/* Place the rotation policy before the controls because deployment order matters. */}
              <Notice
                tone="info"
                title={t('comments.requestSecurity.policy.title')}
              >
                {t('comments.requestSecurity.policy.description')}
              </Notice>

              <div className="settings-action-row">
                <Button
                  type="button"
                  disabled={requestSecurityBusy
                    || requestSecurityResource.status !== 'valid'}
                  onClick={() => {
                    setRequestSecurityAction({ kind: 'idle' });
                    setRequestSecurityDialog('rotate');
                  }}
                >
                  {t('comments.requestSecurity.actions.rotate')}
                </Button>
                <Button
                  type="button"
                  variant={requestSecurityResource.status === 'missing'
                    ? 'secondary'
                    : 'danger'}
                  disabled={requestSecurityBusy}
                  onClick={() => {
                    setRequestSecurityAction({ kind: 'idle' });
                    setRequestSecurityDialog('reset');
                  }}
                >
                  {t(`comments.requestSecurity.actions.${
                    requestSecurityResource.status === 'missing'
                      ? 'initialize'
                      : requestSecurityResource.status === 'invalid'
                        ? 'recover'
                        : 'reset'
                  }`)}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </Panel>

      {requestSecurityDialog && requestSecurityDialogKind ? (
        <CommentRequestSecurityDialog
          title={t(`comments.requestSecurity.dialog.${requestSecurityDialogKind}.title`)}
          description={t(`comments.requestSecurity.dialog.${requestSecurityDialogKind}.description`)}
          confirmLabel={t(`comments.requestSecurity.dialog.${requestSecurityDialogKind}.confirm`)}
          cancelLabel={t('comments.requestSecurity.dialog.cancel')}
          busyLabel={t('comments.requestSecurity.dialog.running')}
          busy={requestSecurityBusy}
          destructive={requestSecurityDialogKind === 'reset'
            || requestSecurityDialogKind === 'recover'}
          failureMessage={requestSecurityDialogFailure}
          onClose={() => {
            if (requestSecurityBusy) return;
            setRequestSecurityDialog(null);
            setRequestSecurityAction({ kind: 'idle' });
          }}
          onConfirm={() => void mutateRequestSecurity(requestSecurityDialog)}
        />
      ) : null}
    </SettingsScreen>
  );
}

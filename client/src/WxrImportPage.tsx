import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ApiErrorCode } from '../../contracts/api';
import {
  normalizeSiteOrigin,
  type GeneralSettings,
  type GeneralSettingsSuccess,
} from '../../contracts/general-settings';
import type {
  WxrCoreImportChunkSuccess,
  WxrImportPhase,
  WxrImportRowFailureCode,
} from '../../contracts/wxr-import';
import {
  ROUTING_SETTINGS_INITIAL_REVISION,
  type RoutingSettings,
  type RoutingSettingsDocument,
} from '../../contracts/routing-settings';
import {
  GeneralSettingsClientError,
  requestGeneralSettings,
} from './lib/general-settings-client';
import {
  createWxrCoreImportChunks,
  requestWxrCoreImportChunk,
  requestWxrImportSettingsFinalize,
  WxrImportClientError,
  type WxrImportClientErrorCode,
} from './lib/wxr-import-client';
import {
  requestRoutingSettings,
  RoutingSettingsClientError,
} from './lib/routing-settings-client';
import {
  parseWxrCoreImportFile,
  WxrCoreParseError,
  type WxrCoreImportPlan,
  type WxrCoreParseErrorCode,
  type WxrMediaStrategy,
} from './wxr/wxr-core-parser';
import {
  Button,
  DataTable,
  Field,
  Notice,
  PageHeader,
  Panel,
  Spinner,
  StatusPill,
} from './components/primitives';
import { useEdgeIntegration } from './EdgeIntegrationContext';
import {
  useStudioDocumentTitle,
  type StudioSiteIdentity,
} from './StudioSiteIdentityContext';

const PHASES: readonly WxrImportPhase[] = [
  'authors',
  'categories',
  'tags',
  'media',
  'posts',
  'pages',
  'menus',
  'comments',
];
const SITE_SETTING_KEYS = [
  'title',
  'description',
  'locale',
  'timezone',
] as const;

type SiteSettingKey = typeof SITE_SETTING_KEYS[number];
type ImportStep = WxrImportPhase | 'site_settings';
type SettingsDocument = GeneralSettingsSuccess['data'];
type SiteUrlChoice = 'current' | 'source' | 'custom';
type PermalinkChoice = 'current' | 'inferred';

type Failure =
  | { kind: 'parse'; code: WxrCoreParseErrorCode }
  | { kind: 'client'; code: WxrImportClientErrorCode }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'unexpected' };

type PhaseResult = {
  processed: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  failures: Array<{
    chunk: number;
    row: number;
    key: string;
    code: WxrImportRowFailureCode;
  }>;
};

type ImportProgress = {
  stepsCompleted: number;
  stepsTotal: number;
  currentPhase: ImportStep;
  results: Record<WxrImportPhase, PhaseResult>;
  siteSettingsResult: 'pending' | 'updated' | 'unchanged';
  routingSettingsResult: 'pending' | 'updated' | 'unchanged';
};

type SiteSettingsLoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'ready';
      generalDocument: SettingsDocument;
      routingDocument: RoutingSettingsDocument;
    }
  | { kind: 'error'; failure: Failure };

type PreparedSiteSettings =
  | { valid: false }
  | { valid: true; settings: GeneralSettings };

type PreparedRoutingSettings = {
  settings: RoutingSettings;
};

function emptyPhaseResult(): PhaseResult {
  return {
    processed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    failures: [],
  };
}

function emptyResults(): Record<WxrImportPhase, PhaseResult> {
  return {
    authors: emptyPhaseResult(),
    categories: emptyPhaseResult(),
    tags: emptyPhaseResult(),
    media: emptyPhaseResult(),
    posts: emptyPhaseResult(),
    pages: emptyPhaseResult(),
    menus: emptyPhaseResult(),
    comments: emptyPhaseResult(),
  };
}

function addChunkResult(
  current: Record<WxrImportPhase, PhaseResult>,
  data: WxrCoreImportChunkSuccess['data'],
  chunk: number,
): Record<WxrImportPhase, PhaseResult> {
  const prior = current[data.phase];
  return {
    ...current,
    [data.phase]: {
      processed: prior.processed + data.processed,
      created: prior.created + data.created,
      updated: prior.updated + data.updated,
      unchanged: prior.unchanged + data.unchanged,
      skipped: prior.skipped,
      failed: prior.failed + data.failed,
      failures: [
        ...prior.failures,
        ...data.failures.map((failure) => ({
          chunk,
          row: failure.row_index + 1,
          key: failure.key,
          code: failure.code,
        })),
      ],
    },
  };
}

function parseFailure(error: unknown): Failure {
  if (error instanceof WxrCoreParseError) {
    return { kind: 'parse', code: error.code };
  }
  if (error instanceof WxrImportClientError) {
    return { kind: 'client', code: error.code };
  }
  if (error instanceof GeneralSettingsClientError) {
    return { kind: 'client', code: error.code };
  }
  if (error instanceof RoutingSettingsClientError) {
    return { kind: 'client', code: error.code };
  }
  return { kind: 'unexpected' };
}

function hasInferredPermalinks(plan: WxrCoreImportPlan): boolean {
  const inferred = plan.source.permalinks;
  return inferred.output_style !== null
    || inferred.posts !== null
    || inferred.pages !== null;
}

function materializeInferredPermalinks(
  plan: WxrCoreImportPlan,
  current: RoutingSettings['permalinks'],
): RoutingSettings['permalinks'] {
  const inferred = plan.source.permalinks;
  return {
    ...current,
    output_style: inferred.output_style ?? current.output_style,
    posts: inferred.posts ?? current.posts,
    pages: inferred.pages ?? current.pages,
  };
}

function prepareRoutingSettings(input: {
  plan: WxrCoreImportPlan;
  document: RoutingSettingsDocument;
  choice: PermalinkChoice;
}): PreparedRoutingSettings {
  const settings: RoutingSettings = {
    ...input.document.settings,
    permalinks: { ...input.document.settings.permalinks },
  };
  if (input.choice === 'inferred') {
    settings.permalinks = materializeInferredPermalinks(
      input.plan,
      input.document.settings.permalinks,
    );
  }
  return {
    settings,
  };
}

function prepareSiteSettings(input: {
  plan: WxrCoreImportPlan;
  document: SettingsDocument;
  selected: Record<SiteSettingKey, boolean>;
  urlChoice: SiteUrlChoice;
  customUrl: string;
}): PreparedSiteSettings {
  const candidate = input.plan.source.site_settings;
  const settings: GeneralSettings = { ...input.document.settings };
  if (input.selected.title && candidate.title !== null) {
    settings.title = candidate.title;
  }
  if (input.selected.description && candidate.description !== null) {
    settings.description = candidate.description;
  }
  if (input.selected.locale && candidate.locale !== null) {
    settings.locale = candidate.locale;
  }
  if (input.selected.timezone && candidate.timezone !== null) {
    settings.timezone = candidate.timezone;
  }
  if (input.urlChoice === 'source') {
    if (candidate.url === null) return { valid: false };
    settings.url = candidate.url.origin;
  } else if (input.urlChoice === 'custom') {
    const normalized = normalizeSiteOrigin(input.customUrl);
    if (!normalized) return { valid: false };
    settings.url = normalized;
  }
  return {
    valid: true,
    settings,
  };
}

export function WxrImportPage(input: {
  data: { csrf_token: string };
  onSiteIdentityChanged?: (identity: StudioSiteIdentity) => void;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('wxrImport');
  const {
    mode: edgeIntegrationMode,
    databaseState: edgeDatabaseState,
  } = useEdgeIntegration();
  const edgeCommentsAvailable = edgeIntegrationMode === 'enabled'
    && edgeDatabaseState === 'ready';
  const fileInputId = useId();
  const externalStrategyId = useId();
  const r2StrategyId = useId();
  const currentUrlId = useId();
  const sourceUrlId = useId();
  const customUrlId = useId();
  const currentPermalinksId = useId();
  const inferredPermalinksId = useId();
  const siteSettingsFieldId = useId();
  const mediaStrategies = [
    { value: 'external', id: externalStrategyId },
    { value: 'r2', id: r2StrategyId },
  ] as const satisfies ReadonlyArray<{ value: WxrMediaStrategy; id: string }>;
  const confirmationId = useId();
  const parseGeneration = useRef(0);
  const importController = useRef<AbortController | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mediaStrategy, setMediaStrategy] = useState<WxrMediaStrategy>('external');
  const [mediaFrom, setMediaFrom] = useState('');
  const [plan, setPlan] = useState<WxrCoreImportPlan | null>(null);
  const [parsing, setParsing] = useState(false);
  const [settingsLoadAttempt, setSettingsLoadAttempt] = useState(0);
  const [settingsLoadState, setSettingsLoadState] = useState<SiteSettingsLoadState>({
    kind: 'idle',
  });
  const [selectedSiteSettings, setSelectedSiteSettings] = useState<
    Record<SiteSettingKey, boolean>
  >({
    title: false,
    description: false,
    locale: false,
    timezone: false,
  });
  const [siteUrlChoice, setSiteUrlChoice] = useState<SiteUrlChoice>('current');
  const [customSiteUrl, setCustomSiteUrl] = useState('');
  const [permalinkChoice, setPermalinkChoice] = useState<PermalinkChoice>('current');
  const [confirmed, setConfirmed] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [completed, setCompleted] = useState(false);
  const importing = progress !== null && !completed && failure === null;

  useStudioDocumentTitle(t('documentTitle'));

  useEffect(() => {
    if (!importing) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [importing]);

  useEffect(() => () => {
    parseGeneration.current += 1;
    importController.current?.abort();
  }, []);

  useEffect(() => {
    if (!plan) {
      setSettingsLoadState({ kind: 'idle' });
      return;
    }
    const controller = new AbortController();
    let active = true;
    setSettingsLoadState({ kind: 'loading' });
    void Promise.all([
      requestGeneralSettings(controller.signal),
      requestRoutingSettings(controller.signal),
    ])
      .then(([generalResponse, routingResponse]) => {
        if (!active) return;
        const errorResponse = !generalResponse.success
          ? generalResponse
          : !routingResponse.success
            ? routingResponse
            : null;
        if (errorResponse) {
          if (errorResponse.error.code === 'AUTHENTICATION_REQUIRED') {
            input.onSessionEnded();
            return;
          }
          setSettingsLoadState({
            kind: 'error',
            failure: { kind: 'api', code: errorResponse.error.code },
          });
          return;
        }
        if (!generalResponse.success || !routingResponse.success) return;
        const candidate = plan.source.site_settings;
        setSelectedSiteSettings({
          title: candidate.title !== null,
          description: candidate.description !== null,
          locale: candidate.locale !== null,
          timezone: candidate.timezone !== null,
        });
        setSiteUrlChoice(
          generalResponse.data.settings.url
            ? 'current'
            : candidate.url
              ? 'source'
              : 'current',
        );
        setCustomSiteUrl(
          generalResponse.data.settings.url || candidate.url?.origin || '',
        );
        setPermalinkChoice(
          routingResponse.data.revision === ROUTING_SETTINGS_INITIAL_REVISION
            && hasInferredPermalinks(plan)
            ? 'inferred'
            : 'current',
        );
        setSettingsLoadState({
          kind: 'ready',
          generalDocument: generalResponse.data,
          routingDocument: routingResponse.data,
        });
      })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        setSettingsLoadState({ kind: 'error', failure: parseFailure(error) });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [input.onSessionEnded, plan, settingsLoadAttempt]);

  const chunks = useMemo(
    () => (plan ? createWxrCoreImportChunks(plan).filter(
      (chunk) => edgeCommentsAvailable
        || chunk.phase !== 'comments',
    ) : []),
    [edgeCommentsAvailable, plan],
  );
  const preparedSiteSettings = useMemo(() => (
    plan && settingsLoadState.kind === 'ready'
      ? prepareSiteSettings({
          plan,
          document: settingsLoadState.generalDocument,
          selected: selectedSiteSettings,
          urlChoice: siteUrlChoice,
          customUrl: customSiteUrl,
        })
      : null
  ), [
    customSiteUrl,
    plan,
    selectedSiteSettings,
    settingsLoadState,
    siteUrlChoice,
  ]);
  const preparedRoutingSettings = useMemo(() => (
    plan && settingsLoadState.kind === 'ready'
      ? prepareRoutingSettings({
          plan,
          document: settingsLoadState.routingDocument,
          choice: permalinkChoice,
        })
      : null
  ), [permalinkChoice, plan, settingsLoadState]);
  const inferredPermalinkPreview = useMemo(() => (
    plan && settingsLoadState.kind === 'ready'
      ? materializeInferredPermalinks(
          plan,
          settingsLoadState.routingDocument.settings.permalinks,
        )
      : null
  ), [plan, settingsLoadState]);

  async function prepareFile(
    selected: File | null,
    strategy: WxrMediaStrategy,
    sourcePrefix: string,
  ) {
    const generation = parseGeneration.current + 1;
    parseGeneration.current = generation;
    setFile(selected);
    setPlan(null);
    setFailure(null);
    setProgress(null);
    setCompleted(false);
    setConfirmed(false);
    if (!selected) {
      setParsing(false);
      return;
    }
    setParsing(true);
    try {
      const parsed = await parseWxrCoreImportFile(selected, {
        mediaStrategy: strategy,
        mediaFrom: sourcePrefix,
      });
      if (parseGeneration.current !== generation) return;
      setPlan(parsed);
    } catch (error) {
      if (parseGeneration.current !== generation) return;
      setFailure(parseFailure(error));
    } finally {
      if (parseGeneration.current === generation) setParsing(false);
    }
  }

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    await prepareFile(
      event.target.files?.[0] ?? null,
      mediaStrategy,
      mediaFrom,
    );
  }

  function changeMediaStrategy(value: WxrMediaStrategy) {
    setMediaStrategy(value);
    if (file) void prepareFile(file, value, mediaFrom);
  }

  function applyMediaPrefix() {
    if (file && mediaStrategy === 'r2') {
      void prepareFile(file, mediaStrategy, mediaFrom);
    }
  }

  async function runImport() {
    if (
      !plan
      || !confirmed
      || importing
      || settingsLoadState.kind !== 'ready'
      || !preparedSiteSettings?.valid
      || !preparedRoutingSettings
    ) return;
    const controller = new AbortController();
    importController.current = controller;
    const generalDocument = settingsLoadState.generalDocument;
    const routingDocument = settingsLoadState.routingDocument;
    const totalSteps = chunks.length + 1;
    let results = emptyResults();
    if (!edgeCommentsAvailable) {
      results = {
        ...results,
        comments: {
          ...results.comments,
          skipped: plan.rows.comments.length,
        },
      };
    }
    setFailure(null);
    setCompleted(false);
    setProgress({
      stepsCompleted: 0,
      stepsTotal: totalSteps,
      currentPhase: chunks[0]?.phase ?? 'site_settings',
      results,
      siteSettingsResult: 'pending',
      routingSettingsResult: 'pending',
    });
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        setProgress({
          stepsCompleted: index,
          stepsTotal: totalSteps,
          currentPhase: chunk.phase,
          results,
          siteSettingsResult: 'pending',
          routingSettingsResult: 'pending',
        });
        const response = await requestWxrCoreImportChunk({
          csrfToken: input.data.csrf_token,
          request: chunk,
          signal: controller.signal,
        });
        if (!response.success) {
          if (response.error.code === 'AUTHENTICATION_REQUIRED') {
            input.onSessionEnded();
            return;
          }
          setFailure({ kind: 'api', code: response.error.code });
          return;
        }
        results = addChunkResult(results, response.data, index + 1);
        setProgress({
          stepsCompleted: index + 1,
          stepsTotal: totalSteps,
          currentPhase: chunk.phase,
          results,
          siteSettingsResult: 'pending',
          routingSettingsResult: 'pending',
        });
      }
      setProgress({
        stepsCompleted: chunks.length,
        stepsTotal: totalSteps,
        currentPhase: 'site_settings',
        results,
        siteSettingsResult: 'pending',
        routingSettingsResult: 'pending',
      });
      const response = await requestWxrImportSettingsFinalize({
        csrfToken: input.data.csrf_token,
        request: {
          general_settings: {
            settings: preparedSiteSettings.settings,
            expected_revision: generalDocument.revision,
          },
          routing_settings: {
            settings: preparedRoutingSettings.settings,
            expected_revision: routingDocument.revision,
          },
        },
        signal: controller.signal,
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setFailure({ kind: 'api', code: response.error.code });
        return;
      }
      setSettingsLoadState({
        kind: 'ready',
        generalDocument: response.data.general_settings.document,
        routingDocument: response.data.routing_settings.document,
      });
      const appliedGeneralSettings =
        response.data.general_settings.document.settings;
      input.onSiteIdentityChanged?.({
        title: appliedGeneralSettings.title,
        url: appliedGeneralSettings.url,
      });
      setProgress({
        stepsCompleted: totalSteps,
        stepsTotal: totalSteps,
        currentPhase: 'site_settings',
        results,
        siteSettingsResult: response.data.general_settings.result,
        routingSettingsResult: response.data.routing_settings.result,
      });
      setCompleted(true);
    } catch (error) {
      if (!controller.signal.aborted) setFailure(parseFailure(error));
    } finally {
      importController.current = null;
    }
  }

  function failureMessage(value: Failure): string {
    if (value.kind === 'parse') return t(`errors.parse.${value.code}`);
    if (value.kind === 'client') return t(`errors.client.${value.code}`);
    if (value.kind === 'api') {
      if (value.code === 'FORBIDDEN') return t('errors.forbidden');
      if (value.code === 'PAYLOAD_TOO_LARGE') return t('errors.payloadTooLarge');
      if (value.code === 'SETTINGS_REVISION_CONFLICT') {
        return t('errors.settingsConflict');
      }
      if (value.code === 'ROUTING_FRONT_PAGE_NOT_FOUND') {
        return t('errors.frontPageConflict');
      }
      if (value.code === 'EDGE_TARGET_PROJECTION_PENDING') {
        return t('errors.commentTargetsPending');
      }
      if (value.code === 'EDGE_INTEGRATION_UNAVAILABLE') {
        return t('errors.edgeUnavailable');
      }
      if (value.code === 'VALIDATION_ERROR') {
        return t('errors.settingsValidation');
      }
      return t('errors.api');
    }
    return t('errors.unexpected');
  }

  const totalFailures = progress
    ? PHASES.reduce((sum, phase) => sum + progress.results[phase].failed, 0)
    : 0;
  const progressPercent = progress
    ? Math.round((progress.stepsCompleted / progress.stepsTotal) * 100)
    : 0;
  const number = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage),
    [i18n.resolvedLanguage],
  );

  return (
    <main
      id="studio-main-content"
      aria-labelledby="wxr-import-title"
    >
      <PageHeader
        titleId="wxr-import-title"
        kicker={t('kicker')}
        title={t('title')}
        description={t('description')}
        actions={<span className="wxr-version">{t('version')}</span>}
      />
      <div className="wxr-flow">
        <Panel title={t('file.title')} description={t('file.description')}>
          <fieldset className="wxr-strategy" disabled={parsing || importing}>
            <legend className="wxr-strategy-legend">
              {t('mediaStrategy.title')}
            </legend>
            <p className="wxr-strategy-description">
              {t('mediaStrategy.description')}
            </p>
            {mediaStrategies.map(({ value, id }) => (
              <div className="wxr-strategy-option" key={value}>
                <input
                  id={id}
                  type="radio"
                  name="wxr-media-strategy"
                  aria-describedby={`${id}-description`}
                  checked={mediaStrategy === value}
                  onChange={() => changeMediaStrategy(value)}
                />
                <div className="wxr-strategy-option-text">
                  <label className="wxr-strategy-option-label" htmlFor={id}>
                    {t(`mediaStrategy.${value}.title`)}
                  </label>
                  <p
                    className="wxr-strategy-option-description"
                    id={`${id}-description`}
                  >
                    {t(`mediaStrategy.${value}.description`)}
                  </p>
                </div>
              </div>
            ))}
            {mediaStrategy === 'r2' ? (
              <div className="wxr-prefix-field">
                <Field
                  label={t('mediaStrategy.mediaFrom.label')}
                  hint={t('mediaStrategy.mediaFrom.hint')}
                >
                  {(control) => (
                    <input
                      {...control}
                      type="url"
                      maxLength={2048}
                      value={mediaFrom}
                      placeholder={t('mediaStrategy.mediaFrom.placeholder')}
                      onChange={(event) => setMediaFrom(event.target.value)}
                      onBlur={applyMediaPrefix}
                    />
                  )}
                </Field>
              </div>
            ) : null}
          </fieldset>

          <label className="wxr-file-picker" htmlFor={fileInputId}>
            <span className="wxr-file-picker-name">
              {file ? file.name : t('file.empty')}
            </span>
            <strong className="wxr-file-picker-action">
              {t(file ? 'file.replace' : 'file.choose')}
            </strong>
            <input
              id={fileInputId}
              type="file"
              accept=".xml,application/xml,text/xml"
              aria-label={t('file.inputLabel')}
              disabled={parsing || importing}
              onChange={(event) => void selectFile(event)}
            />
          </label>
          {file ? (
            <small className="wxr-file-meta">
              {t('file.size', { size: number.format(file.size) })}
            </small>
          ) : null}
          {parsing ? (
            <div className="wxr-inline-status" role="status">
              <Spinner size="lg" />
              <div className="wxr-inline-status-text">
                <strong className="wxr-inline-status-title">
                  {t('parsing.title')}
                </strong>
                <p className="wxr-inline-status-detail">
                  {t('parsing.description')}
                </p>
              </div>
            </div>
          ) : null}
        </Panel>

        {failure && !progress ? (
          <Notice tone="error" title={t('errors.title')}>
            {failureMessage(failure)}
          </Notice>
        ) : null}

        {plan ? (
          <>
            {!edgeCommentsAvailable && plan.rows.comments.length > 0 ? (
                <Notice tone="info" title={t(
                  edgeIntegrationMode === 'disabled'
                    ? 'edgeDisabled.title'
                    : 'edgeUnavailable.title',
                )}>
                  {t(edgeIntegrationMode === 'disabled'
                    ? 'edgeDisabled.description'
                    : 'edgeUnavailable.description', {
                    count: plan.rows.comments.length,
                  })}
                </Notice>
              ) : null}
            <Panel
              title={t('preflight.title')}
              description={t('preflight.description')}
              actions={(
                <dl className="wxr-source">
                  <div className="wxr-source-row">
                    <dt>{t('preflight.site')}</dt>
                    <dd>{plan.source.site_title || t('preflight.unknown')}</dd>
                  </div>
                  <div className="wxr-source-row">
                    <dt>{t('preflight.url')}</dt>
                    <dd>{plan.source.site_url || t('preflight.unknown')}</dd>
                  </div>
                  <div className="wxr-source-row">
                    <dt>{t('preflight.mediaStrategy')}</dt>
                    <dd>{t(`mediaStrategy.${plan.source.media_strategy}.title`)}</dd>
                  </div>
                  {plan.source.media_strategy === 'r2' ? (
                    <div className="wxr-source-row">
                      <dt>{t('preflight.mediaFrom')}</dt>
                      <dd>{plan.source.media_from}</dd>
                    </div>
                  ) : null}
                </dl>
              )}
            >
              <dl className="wxr-counts">
                {PHASES.map((phase) => (
                  <div className="wxr-count" key={phase}>
                    <dt>{t(`phases.${phase}`)}</dt>
                    <dd>{number.format(plan.rows[phase].length)}</dd>
                  </div>
                ))}
              </dl>
            </Panel>

            <Panel
              title={t('editorCompatibility.title')}
              description={t('editorCompatibility.description')}
            >
              <dl className="wxr-counts">
                <div className="wxr-count">
                  <dt>{t('editorCompatibility.visual')}</dt>
                  <dd>{number.format(plan.editor_compatibility.visual)}</dd>
                </div>
                <div className="wxr-count">
                  <dt>{t('editorCompatibility.source')}</dt>
                  <dd>{number.format(plan.editor_compatibility.source)}</dd>
                </div>
              </dl>
              {plan.editor_compatibility.source_fallbacks.length > 0 ? (
                <ul className="wxr-warnings">
                  {plan.editor_compatibility.source_fallbacks.map((fallback) => (
                    <li className="wxr-warning" key={fallback.reason}>
                      <p className="wxr-warning-heading">
                        <span className="wxr-warning-label">
                          {t(`editorCompatibility.reasons.${fallback.reason}`)}
                        </span>
                        <span className="wxr-warning-count">
                          {number.format(fallback.count)}
                        </span>
                      </p>
                      {fallback.affected.length > 0 ? (
                        <small className="wxr-warning-affected">
                          {fallback.affected.join(', ')}
                        </small>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Panel>

            <Panel
              title={t('siteSettings.title')}
              description={t('siteSettings.description')}
            >
              {settingsLoadState.kind === 'loading' ? (
                <div className="wxr-inline-status" role="status">
                  <Spinner />
                  <div className="wxr-inline-status-text">
                    <strong className="wxr-inline-status-title">
                      {t('siteSettings.loading.title')}
                    </strong>
                    <p className="wxr-inline-status-detail">
                      {t('siteSettings.loading.description')}
                    </p>
                  </div>
                </div>
              ) : null}

              {settingsLoadState.kind === 'error' ? (
                <Notice
                  tone="error"
                  title={t('siteSettings.loadError.title')}
                  actions={(
                    <Button
                      type="button"
                      onClick={() => setSettingsLoadAttempt((value) => value + 1)}
                    >
                      {t('siteSettings.loadError.retry')}
                    </Button>
                  )}
                >
                  {failureMessage(settingsLoadState.failure)}
                </Notice>
              ) : null}

              {settingsLoadState.kind === 'ready' ? (
                <fieldset
                  className="wxr-site-settings"
                  disabled={progress !== null}
                >
                  <legend className="visually-hidden">
                    {t('siteSettings.selectionLegend')}
                  </legend>
                  <div className="wxr-setting-options">
                    {SITE_SETTING_KEYS.map((key) => {
                      const current = settingsLoadState.generalDocument.settings[key];
                      const candidate = plan.source.site_settings[key];
                      const available = candidate !== null;
                      const id = `${siteSettingsFieldId}-${key}`;
                      return (
                        <label className="wxr-setting-option" htmlFor={id} key={key}>
                          <input
                            id={id}
                            type="checkbox"
                            checked={selectedSiteSettings[key]}
                            disabled={!available || progress !== null}
                            onChange={(event) => setSelectedSiteSettings((value) => ({
                              ...value,
                              [key]: event.target.checked,
                            }))}
                          />
                          <span className="wxr-setting-option-content">
                            <strong className="wxr-setting-option-title">
                              {t(`siteSettings.fields.${key}`)}
                            </strong>
                            <span className="wxr-setting-comparison">
                              <span>
                                {t('siteSettings.current')}: {' '}
                                <b className="wxr-setting-value">
                                  {current || t('siteSettings.empty')}
                                </b>
                              </span>
                              <span>
                                {t('siteSettings.source')}: {' '}
                                <b className="wxr-setting-value">
                                  {candidate === ''
                                    ? t('siteSettings.empty')
                                    : candidate ?? t('siteSettings.unavailable')}
                                </b>
                              </span>
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  <div className="wxr-site-url">
                    <h3 className="wxr-site-url-title">
                      {t('siteSettings.url.title')}
                    </h3>
                    <p className="wxr-site-url-description">
                      {t('siteSettings.url.description')}
                    </p>
                    <div className="wxr-url-options">
                      <label className="wxr-strategy-option" htmlFor={currentUrlId}>
                        <input
                          id={currentUrlId}
                          type="radio"
                          name="wxr-site-url"
                          aria-labelledby={`${currentUrlId}-label`}
                          aria-describedby={`${currentUrlId}-description`}
                          checked={siteUrlChoice === 'current'}
                          onChange={() => setSiteUrlChoice('current')}
                        />
                        <span className="wxr-strategy-option-text">
                          <strong
                            className="wxr-strategy-option-label"
                            id={`${currentUrlId}-label`}
                          >
                            {t('siteSettings.url.current.title')}
                          </strong>
                          <span
                            className="wxr-strategy-option-description"
                            id={`${currentUrlId}-description`}
                          >
                            {settingsLoadState.generalDocument.settings.url
                              || t('siteSettings.empty')}
                          </span>
                        </span>
                      </label>
                      <label className="wxr-strategy-option" htmlFor={sourceUrlId}>
                        <input
                          id={sourceUrlId}
                          type="radio"
                          name="wxr-site-url"
                          aria-labelledby={`${sourceUrlId}-label`}
                          aria-describedby={`${sourceUrlId}-description`}
                          checked={siteUrlChoice === 'source'}
                          disabled={plan.source.site_settings.url === null}
                          onChange={() => setSiteUrlChoice('source')}
                        />
                        <span className="wxr-strategy-option-text">
                          <strong
                            className="wxr-strategy-option-label"
                            id={`${sourceUrlId}-label`}
                          >
                            {t('siteSettings.url.source.title')}
                          </strong>
                          <span
                            className="wxr-strategy-option-description"
                            id={`${sourceUrlId}-description`}
                          >
                            {plan.source.site_settings.url === null
                              ? t('siteSettings.url.source.unavailable')
                              : plan.source.site_settings.url.origin}
                          </span>
                        </span>
                      </label>
                      <label className="wxr-strategy-option" htmlFor={customUrlId}>
                        <input
                          id={customUrlId}
                          type="radio"
                          name="wxr-site-url"
                          aria-labelledby={`${customUrlId}-label`}
                          aria-describedby={`${customUrlId}-description`}
                          checked={siteUrlChoice === 'custom'}
                          onChange={() => setSiteUrlChoice('custom')}
                        />
                        <span className="wxr-strategy-option-text">
                          <strong
                            className="wxr-strategy-option-label"
                            id={`${customUrlId}-label`}
                          >
                            {t('siteSettings.url.custom.title')}
                          </strong>
                          <span
                            className="wxr-strategy-option-description"
                            id={`${customUrlId}-description`}
                          >
                            {t('siteSettings.url.custom.description')}
                          </span>
                        </span>
                      </label>
                    </div>
                    {siteUrlChoice === 'custom' ? (
                      <div className="wxr-custom-url-field">
                        <Field
                          label={t('siteSettings.url.custom.label')}
                          error={preparedSiteSettings?.valid === false
                            ? t('siteSettings.url.custom.error')
                            : undefined}
                        >
                          {(control) => (
                            <input
                              {...control}
                              type="url"
                              maxLength={2048}
                              value={customSiteUrl}
                              placeholder="https://example.com"
                              onChange={(event) => setCustomSiteUrl(event.target.value)}
                            />
                          )}
                        </Field>
                      </div>
                    ) : null}
                  </div>

                  <div className="wxr-site-url">
                    <h3 className="wxr-site-url-title">
                      {t('siteSettings.permalinks.title')}
                    </h3>
                    <p className="wxr-site-url-description">
                      {t('siteSettings.permalinks.description')}
                    </p>
                    <div className="wxr-url-options">
                      <label
                        className="wxr-strategy-option"
                        htmlFor={currentPermalinksId}
                      >
                        <input
                          id={currentPermalinksId}
                          type="radio"
                          name="wxr-permalinks"
                          aria-labelledby={`${currentPermalinksId}-label`}
                          aria-describedby={`${currentPermalinksId}-description`}
                          checked={permalinkChoice === 'current'}
                          onChange={() => setPermalinkChoice('current')}
                        />
                        <span className="wxr-strategy-option-text">
                          <strong
                            className="wxr-strategy-option-label"
                            id={`${currentPermalinksId}-label`}
                          >
                            {t('siteSettings.permalinks.current.title')}
                          </strong>
                          <span
                            className="wxr-permalink-values"
                            id={`${currentPermalinksId}-description`}
                          >
                            <span>
                              {t('siteSettings.permalinks.outputStyle')}: {' '}
                              <b className="wxr-permalink-value">
                                {t(`siteSettings.permalinks.styles.${settingsLoadState.routingDocument.settings.permalinks.output_style}`)}
                              </b>
                            </span>
                            <span>
                              {t('siteSettings.permalinks.posts')}: {' '}
                              <b className="wxr-permalink-value">
                                {settingsLoadState.routingDocument.settings.permalinks.posts}
                              </b>
                            </span>
                            <span>
                              {t('siteSettings.permalinks.pages')}: {' '}
                              <b className="wxr-permalink-value">
                                {settingsLoadState.routingDocument.settings.permalinks.pages}
                              </b>
                            </span>
                          </span>
                        </span>
                      </label>
                      <label
                        className="wxr-strategy-option"
                        htmlFor={inferredPermalinksId}
                      >
                        <input
                          id={inferredPermalinksId}
                          type="radio"
                          name="wxr-permalinks"
                          aria-labelledby={`${inferredPermalinksId}-label`}
                          aria-describedby={`${inferredPermalinksId}-description`}
                          checked={permalinkChoice === 'inferred'}
                          disabled={!hasInferredPermalinks(plan)}
                          onChange={() => setPermalinkChoice('inferred')}
                        />
                        <span className="wxr-strategy-option-text">
                          <strong
                            className="wxr-strategy-option-label"
                            id={`${inferredPermalinksId}-label`}
                          >
                            {t('siteSettings.permalinks.inferred.title')}
                          </strong>
                          <span
                            className="wxr-permalink-values"
                            id={`${inferredPermalinksId}-description`}
                          >
                            {hasInferredPermalinks(plan)
                              && inferredPermalinkPreview ? (
                              <>
                                <span>
                                  {t('siteSettings.permalinks.outputStyle')}: {' '}
                                  <b className="wxr-permalink-value">
                                    {t(`siteSettings.permalinks.styles.${inferredPermalinkPreview.output_style}`)}
                                  </b>
                                </span>
                                <span>
                                  {t('siteSettings.permalinks.posts')}: {' '}
                                  <b className="wxr-permalink-value">
                                    {inferredPermalinkPreview.posts}
                                  </b>
                                </span>
                                <span>
                                  {t('siteSettings.permalinks.pages')}: {' '}
                                  <b className="wxr-permalink-value">
                                    {inferredPermalinkPreview.pages}
                                  </b>
                                </span>
                              </>
                            ) : t('siteSettings.permalinks.inferred.unavailable')}
                          </span>
                        </span>
                      </label>
                    </div>
                    <small className="wxr-site-url-description">
                      {t('siteSettings.permalinks.preserved')}
                    </small>
                  </div>
                </fieldset>
              ) : null}
            </Panel>

            <div className="wxr-scope-grid">
              <Panel title={t('scope.title')} description={t('scope.description')}>
                <ul className="wxr-list">
                  <li>{t('scope.settings')}</li>
                  <li>{t('scope.mediaFiles')}</li>
                </ul>
              </Panel>
              <Panel
                title={t('policy.title')}
                description={t('policy.description')}
              >
                <ul className="wxr-list">
                  <li>{t('policy.ids')}</li>
                  <li>{t('policy.repeat')}</li>
                  <li>{t('policy.dependencies')}</li>
                </ul>
              </Panel>
            </div>

            {plan.warnings.length > 0 ? (
              <Panel
                title={t('warnings.title')}
                description={t('warnings.description')}
                actions={(
                  <StatusPill tone="attention">
                    {number.format(plan.warnings.reduce(
                      (sum, warning) => sum + warning.count,
                      0,
                    ))}
                  </StatusPill>
                )}
              >
                <ul className="wxr-warnings">
                  {plan.warnings.map((warning) => (
                    <li className="wxr-warning" key={warning.code}>
                      <p className="wxr-warning-heading">
                        <span className="wxr-warning-label">
                          {t(`warnings.codes.${warning.code}`)}
                        </span>
                        <span className="wxr-warning-count">
                          {number.format(warning.count)}
                        </span>
                      </p>
                      {warning.affected.length > 0 ? (
                        <small className="wxr-warning-affected">
                          {warning.affected.join(', ')}
                        </small>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            {!progress ? (
              <Panel
                title={t('confirmation.title')}
                description={t('confirmation.description', {
                  chunks: chunks.length,
                })}
                footer={(
                  <Button
                    type="button"
                    variant="primary"
                    disabled={
                      !confirmed
                      || settingsLoadState.kind !== 'ready'
                      || preparedSiteSettings?.valid !== true
                      || preparedRoutingSettings === null
                    }
                    onClick={() => void runImport()}
                  >
                    {t('actions.import')}
                  </Button>
                )}
              >
                <div className="wxr-acknowledge">
                  <input
                    id={confirmationId}
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  <label className="wxr-acknowledge-label" htmlFor={confirmationId}>
                    {t('confirmation.label')}
                  </label>
                </div>
              </Panel>
            ) : null}
          </>
        ) : null}

        {progress ? (
          <Panel
            title={completed ? t('result.title') : t('progress.title')}
            description={completed
              ? t('result.description', { failures: totalFailures })
              : t('progress.description', {
                  phase: t(`phases.${progress.currentPhase}`),
                  completed: progress.stepsCompleted,
                  total: progress.stepsTotal,
                })}
            actions={(
              <strong className="wxr-progress-percent">{progressPercent}%</strong>
            )}
          >
            <div
              className="wxr-progress-track"
              role="progressbar"
              aria-label={t('progress.label')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPercent}
            >
              <span
                className="wxr-progress-fill"
                style={{ width: `${progressPercent}%` }}
              />
            </div>

            <DataTable caption={t('result.tableLabel')} minWidthPx={600} stacked>
              <thead>
                <tr>
                  <th scope="col">{t('result.phase')}</th>
                  <th scope="col">{t('result.created')}</th>
                  <th scope="col">{t('result.updated')}</th>
                  <th scope="col">{t('result.unchanged')}</th>
                  <th scope="col">{t('result.skipped')}</th>
                  <th scope="col">{t('result.failed')}</th>
                </tr>
              </thead>
              <tbody>
                {PHASES.map((phase) => {
                  const result = progress.results[phase];
                  return (
                    <tr key={phase}>
                      <th scope="row">{t(`phases.${phase}`)}</th>
                      <td data-label={t('result.created')}>
                        {number.format(result.created)}
                      </td>
                      <td data-label={t('result.updated')}>
                        {number.format(result.updated)}
                      </td>
                      <td data-label={t('result.unchanged')}>
                        {number.format(result.unchanged)}
                      </td>
                      <td data-label={t('result.skipped')}>
                        {number.format(result.skipped)}
                      </td>
                      <td data-label={t('result.failed')}>
                        {number.format(result.failed)}
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <th scope="row">{t('phases.site_settings')}</th>
                  <td data-label={t('result.created')}>0</td>
                  <td data-label={t('result.updated')}>
                    {progress.siteSettingsResult === 'updated' ? '1' : '0'}
                  </td>
                  <td data-label={t('result.unchanged')}>
                    {progress.siteSettingsResult === 'unchanged' ? '1' : '0'}
                  </td>
                  <td data-label={t('result.skipped')}>0</td>
                  <td data-label={t('result.failed')}>0</td>
                </tr>
                <tr>
                  <th scope="row">{t('phases.routing_settings')}</th>
                  <td data-label={t('result.created')}>0</td>
                  <td data-label={t('result.updated')}>
                    {progress.routingSettingsResult === 'updated' ? '1' : '0'}
                  </td>
                  <td data-label={t('result.unchanged')}>
                    {progress.routingSettingsResult === 'unchanged' ? '1' : '0'}
                  </td>
                  <td data-label={t('result.skipped')}>0</td>
                  <td data-label={t('result.failed')}>0</td>
                </tr>
              </tbody>
            </DataTable>

            {failure ? (
              <div className="wxr-result-notice">
                <Notice
                  tone="error"
                  title={t('errors.interrupted')}
                  actions={(
                    <Button
                      type="button"
                      onClick={() => {
                        setProgress(null);
                        setFailure(null);
                        setCompleted(false);
                        setSettingsLoadAttempt((value) => value + 1);
                      }}
                    >
                      {t('actions.retry')}
                    </Button>
                  )}
                >
                  {failureMessage(failure)}
                </Notice>
              </div>
            ) : null}

            {completed && totalFailures > 0 ? (
              <details className="wxr-failure-list">
                <summary>
                  {t('result.failureDetails', { count: totalFailures })}
                </summary>
                <ul className="wxr-failures">
                  {PHASES.flatMap((phase) => progress.results[phase].failures
                    .map((item) => (
                      <li key={`${phase}:${item.chunk}:${item.row}:${item.key}`}>
                        <strong className="wxr-failure-label">
                          {t(`phases.${phase}`)} · {item.key}
                        </strong>
                        <span className="wxr-failure-reason">
                          {t(`rowFailures.${item.code}`)}
                        </span>
                      </li>
                    )))}
                </ul>
              </details>
            ) : null}

            {completed ? (
              <div className="wxr-result-actions">
                <Button
                  type="button"
                  onClick={() => {
                    setProgress(null);
                    setCompleted(false);
                    setConfirmed(false);
                  }}
                >
                  {t('actions.reviewAgain')}
                </Button>
              </div>
            ) : null}
          </Panel>
        ) : null}
      </div>
    </main>
  );
}

import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Clock3,
  Copy,
  Download,
  FileJson,
  RefreshCw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import type { ApiErrorCode } from '../../contracts/api';
import type {
  PreviewDataExportDocument,
  PreviewDataSummary,
} from '../../contracts/preview-data';
import {
  PreviewDataClientError,
  requestPreviewData,
  requestPreviewDataSummary,
  type PreviewDataClientErrorCode,
} from './lib/preview-data-client';
import {
  Button,
  InlineStatus,
  Notice,
  PageHeader,
  Panel,
  StudioIcon,
  useStudioToast,
} from './components/primitives';

type Failure =
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: PreviewDataClientErrorCode }
  | { kind: 'unexpected' };
type SummaryState =
  | { kind: 'loading' }
  | { kind: 'ready'; summary: PreviewDataSummary }
  | { kind: 'error'; failure: Failure };
type GenerationState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; document: PreviewDataExportDocument }
  | { kind: 'error'; failure: Failure };
type CopyState = 'idle' | 'copied' | 'failed';

function clientFailure(error: unknown): Failure {
  return error instanceof PreviewDataClientError
    ? { kind: 'client', code: error.code }
    : { kind: 'unexpected' };
}

function downloadFilename(generatedAt: string): string {
  const safeTimestamp = generatedAt.replace(/:/gu, '-');
  return `zeropress-preview-data-${safeTimestamp}.json`;
}

function summarizeDocument(
  document: PreviewDataExportDocument,
): PreviewDataSummary {
  return {
    authors: document.preview_data.content.authors.length,
    posts: document.preview_data.content.posts.length,
    pages: document.preview_data.content.pages.length,
    categories: document.preview_data.content.categories.length,
    tags: document.preview_data.content.tags.length,
    menus: Object.keys(document.preview_data.menus ?? {}).length,
  };
}

export function PreviewDataPage(input: {
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('previewData');
  const [summaryAttempt, setSummaryAttempt] = useState(0);
  const [summaryState, setSummaryState] = useState<SummaryState>({
    kind: 'loading',
  });
  const [generationAttempt, setGenerationAttempt] = useState(0);
  const [generationState, setGenerationState] = useState<GenerationState>({
    kind: 'idle',
  });
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [generationCompleted, setGenerationCompleted] = useState(false);

  useStudioDocumentTitle(t('documentTitle'));
  useStudioToast({
    id: 'preview-data-generation',
    tone: 'success',
    message: generationCompleted ? t('actions.generated') : null,
  });
  useStudioToast({
    id: 'preview-data-copy',
    tone: 'success',
    message: copyState === 'copied' ? t('actions.copied') : null,
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    // StrictMode's development-only effect replay cancels the first scheduled task during cleanup.
    const startId = window.setTimeout(() => {
      void requestPreviewDataSummary(controller.signal)
        .then((response) => {
          if (!active) return;
          if (!response.success) {
            if (response.error.code === 'AUTHENTICATION_REQUIRED') {
              input.onSessionEnded();
              return;
            }
            setSummaryState({
              kind: 'error',
              failure: { kind: 'api', code: response.error.code },
            });
            return;
          }
          setSummaryState({ kind: 'ready', summary: response.data });
        })
        .catch((error) => {
          if (!active || controller.signal.aborted) return;
          setSummaryState({ kind: 'error', failure: clientFailure(error) });
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(startId);
      controller.abort();
    };
  }, [summaryAttempt, input.onSessionEnded]);

  useEffect(() => {
    if (generationAttempt === 0) return undefined;
    const controller = new AbortController();
    let active = true;
    const startId = window.setTimeout(() => {
      void requestPreviewData(controller.signal)
        .then((response) => {
          if (!active) return;
          if (!response.success) {
            if (response.error.code === 'AUTHENTICATION_REQUIRED') {
              input.onSessionEnded();
              return;
            }
            setGenerationState({
              kind: 'error',
              failure: { kind: 'api', code: response.error.code },
            });
            return;
          }
          setGenerationState({ kind: 'ready', document: response.data });
          setGenerationCompleted(true);
        })
        .catch((error) => {
          if (!active || controller.signal.aborted) return;
          setGenerationState({
            kind: 'error',
            failure: clientFailure(error),
          });
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(startId);
      controller.abort();
    };
  }, [generationAttempt, input.onSessionEnded]);

  const exportDocument = generationState.kind === 'ready'
    ? generationState.document
    : null;
  const json = useMemo(() => exportDocument
    ? `${JSON.stringify(exportDocument.preview_data, null, 2)}\n`
    : '', [exportDocument]);

  function generationFailureMessage(failure: Failure): string {
    if (failure.kind === 'client') {
      if (failure.code === 'TIMEOUT') return t('error.timeout');
      if (failure.code === 'NETWORK_ERROR') return t('error.network');
      return t('error.invalidResponse');
    }
    if (failure.kind === 'api' && failure.code === 'FORBIDDEN') {
      return t('error.forbidden');
    }
    return t('error.api');
  }

  function summaryFailureMessage(failure: Failure): string {
    if (failure.kind === 'client') {
      if (failure.code === 'TIMEOUT') return t('summary.timeout');
      if (failure.code === 'NETWORK_ERROR') return t('summary.network');
      return t('summary.invalidResponse');
    }
    if (failure.kind === 'api' && failure.code === 'FORBIDDEN') {
      return t('error.forbidden');
    }
    return t('summary.api');
  }

  async function copyJson() {
    setCopyState('idle');
    if (!json || !navigator.clipboard?.writeText) {
      setCopyState('failed');
      return;
    }
    try {
      await navigator.clipboard.writeText(json);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  function downloadJson() {
    if (!exportDocument || !json) return;
    const url = URL.createObjectURL(new Blob([json], {
      type: 'application/json;charset=utf-8',
    }));
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = downloadFilename(
      exportDocument.preview_data.generated_at,
    );
    anchor.hidden = true;
    window.document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function generate() {
    if (generationState.kind === 'loading') return;
    setGenerationCompleted(false);
    setCopyState('idle');
    setGenerationState({ kind: 'loading' });
    setGenerationAttempt((value) => value + 1);
  }

  function retrySummary() {
    if (summaryState.kind === 'loading') return;
    setSummaryState({ kind: 'loading' });
    setSummaryAttempt((value) => value + 1);
  }

  const generatedAt = exportDocument
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(new Date(exportDocument.preview_data.generated_at))
    : null;
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(i18n.resolvedLanguage),
    [i18n.resolvedLanguage],
  );
  const summary = exportDocument
    ? summarizeDocument(exportDocument)
    : summaryState.kind === 'ready'
      ? summaryState.summary
      : null;
  const contentCounts = summary ? [
    ['authors', summary.authors],
    ['posts', summary.posts],
    ['pages', summary.pages],
    ['categories', summary.categories],
    ['tags', summary.tags],
    ['menus', summary.menus],
  ] as const : [];

  const panelActions = exportDocument ? (
    <>
      <Button type="button" onClick={generate}>
        <StudioIcon icon={RefreshCw} className="preview-data-action-icon" />
        {t('actions.refresh')}
      </Button>
      <Button type="button" onClick={() => void copyJson()}>
        <StudioIcon icon={Copy} className="preview-data-action-icon" />
        {t('actions.copy')}
      </Button>
      <Button type="button" variant="primary" onClick={downloadJson}>
        <StudioIcon icon={Download} className="preview-data-action-icon" />
        {t('actions.download')}
      </Button>
    </>
  ) : (
    <Button
      type="button"
      variant="primary"
      disabled={generationState.kind === 'loading'}
      aria-busy={generationState.kind === 'loading'}
      onClick={generate}
    >
      <StudioIcon icon={RefreshCw} className="preview-data-action-icon" />
      {generationState.kind === 'error'
        ? t('error.retry')
        : t('actions.generate')}
    </Button>
  );

  return (
    <main
      id="studio-main-content"
      className="preview-data-page"
      aria-labelledby="preview-data-title"
    >
      <PageHeader
        titleId="preview-data-title"
        kicker={t('kicker')}
        title={t('title')}
        description={t('description')}
      />

      <Panel
        leading={<StudioIcon icon={FileJson} />}
        title={t('export.title')}
        description={exportDocument
          ? t('export.readyDescription')
          : t('export.description')}
        actions={panelActions}
      >
        <div className="preview-data-result">
          {generationState.kind === 'loading' ? (
            <div className="preview-data-progress">
              <InlineStatus size="lg">{t('loading.title')}</InlineStatus>
              <p className="preview-data-progress-detail">
                {t('loading.description')}
              </p>
            </div>
          ) : null}

          {generationState.kind === 'error' ? (
            <Notice tone="error" title={t('error.title')}>
              {generationFailureMessage(generationState.failure)}{' '}
              {t('error.description')}
            </Notice>
          ) : null}

          {copyState === 'failed' ? (
            <Notice tone="error">{t('actions.copyFailed')}</Notice>
          ) : null}

          {exportDocument ? (
            <>
              <dl className="preview-data-generated">
                <div>
                  <dt>
                    <StudioIcon
                      icon={Clock3}
                      className="preview-data-generated-icon"
                    />
                    {t('generated.label')}
                  </dt>
                  <dd>{generatedAt}</dd>
                </div>
              </dl>

              {exportDocument.validation.warnings.length > 0 ? (
                <Notice
                  tone="warning"
                  title={t('warnings.title', {
                    count: exportDocument.validation.warnings.length,
                  })}
                >
                  <ul className="preview-data-warnings">
                    {exportDocument.validation.warnings.map((warning) => (
                      <li
                        className="preview-data-warning"
                        key={`${warning.code}:${warning.path}`}
                      >
                        <strong className="preview-data-warning-code">
                          {warning.code}
                        </strong>
                        <span className="preview-data-warning-path">
                          {warning.path || t('warnings.documentRoot')}
                        </span>
                        <p className="preview-data-warning-message">
                          {warning.message}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
            </>
          ) : null}

          <section
            className="preview-data-summary"
            aria-labelledby="preview-data-summary-title"
          >
            <h3
              className="preview-data-summary-title"
              id="preview-data-summary-title"
            >
              {exportDocument ? t('content.title') : t('content.scopeTitle')}
            </h3>

            {!exportDocument && summaryState.kind === 'loading' ? (
              <InlineStatus>{t('summary.loading')}</InlineStatus>
            ) : null}

            {!exportDocument && summaryState.kind === 'error' ? (
              <Notice
                tone="warning"
                title={t('summary.errorTitle')}
                actions={(
                  <Button type="button" onClick={retrySummary}>
                    <StudioIcon
                      icon={RefreshCw}
                      className="preview-data-action-icon"
                    />
                    {t('summary.retry')}
                  </Button>
                )}
              >
                {summaryFailureMessage(summaryState.failure)}{' '}
                {t('summary.errorDescription')}
              </Notice>
            ) : null}

            {summary ? (
              <dl className="preview-data-counts">
                {contentCounts.map(([key, count]) => (
                  <div className="preview-data-count" key={key}>
                    <dt>{t(`content.${key}`)}</dt>
                    <dd>{numberFormatter.format(count)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </section>
        </div>
      </Panel>
    </main>
  );
}

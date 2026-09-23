import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw, Settings2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PreparedPreviewData } from '../../../contracts/preview-data';
import {
  githubFileUrl,
  type PublishingStatus,
  type PublishingResult,
  type PublishingTarget,
  type PublishRequest,
} from '../../../contracts/publishing';
import {
  PublishingClientError,
  publishingErrorKey,
  requestPublish,
  requestPublishingStatus,
} from '../lib/publishing-client';
import {
  Button,
  ButtonLink,
  Dialog,
  Notice,
  Panel,
  Spinner,
  StudioIcon,
} from './primitives';
import { UnsavedChangesGuard } from './UnsavedChangesGuard';
import './publishing.css';

type PreparedData = Pick<PreparedPreviewData, 'data_hash'>;

export function PublishingPanel(input: {
  csrfToken: string;
  prepared: PreparedData | null;
  onPrepare: () => void;
  onPublishingChange: (busy: boolean) => void;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('publishing');
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<PublishingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{
    data: PublishingResult;
    prepared: PreparedData;
    revision: string;
  } | null>(null);
  const [checkedPreparation, setCheckedPreparation] = useState<PreparedData | null>(null);
  const [outdatedPreparation, setOutdatedPreparation] = useState<PreparedData | null>(null);
  const [confirmation, setConfirmation] = useState<{
    request: PublishRequest;
    target: PublishingTarget;
    prepared: PreparedData;
  } | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const publishing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setConfirmation(null);
  }, [input.prepared]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void requestPublishingStatus(controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        if (response.success) {
          setStatus(response.data);
          setCheckedPreparation(input.prepared);
        } else if (response.error.code === 'AUTHENTICATION_REQUIRED')
          input.onSessionEnded();
        else {
          setError(response.error.code);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(
            cause instanceof PublishingClientError
              ? cause.code
              : 'INTERNAL_ERROR',
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt, input.prepared, input.onSessionEnded]);
  async function publish() {
    if (
      publishing.current ||
      !confirmation ||
      !canPublish ||
      confirmation.prepared !== input.prepared ||
      !status?.enabled ||
      !status.configured ||
      loading ||
      error
    )
      return;
    publishing.current = true;
    setBusy(true);
    input.onPublishingChange(true);
    setError(null);
    setOutcome(null);
    try {
      const response = await requestPublish(
        input.csrfToken,
        confirmation.request,
      );
      if (!mounted.current) return;
      if (response.success) {
        setOutcome({
          data: response.data,
          prepared: confirmation.prepared,
          revision: confirmation.request.expected_revision,
        });
        setStatus({ ...status, file: response.data.file });
      } else if (response.error.code === 'AUTHENTICATION_REQUIRED')
        input.onSessionEnded();
      else if (response.error.code === 'PUBLISHING_DATA_CHANGED') {
        setOutdatedPreparation(confirmation.prepared);
      } else {
        setError(response.error.code);
      }
    } catch {
      // Once POST is sent, a transport failure cannot prove that GitHub rejected it.
      if (mounted.current) {
        setError('PUBLISHING_RESULT_UNKNOWN');
      }
    } finally {
      publishing.current = false;
      if (mounted.current) {
        setBusy(false);
        input.onPublishingChange(false);
        setConfirmation(null);
      }
    }
  }
  const result = outcome?.prepared === input.prepared &&
    outcome?.revision === status?.revision &&
    outcome?.data.file.blob_sha === status?.file?.blob_sha
    ? outcome?.data : null;
  const file = status?.file ?? result?.file;
  const connected = Boolean(status?.enabled && status.configured);
  const stale = Boolean(input.prepared && outdatedPreparation === input.prepared);
  const unchanged = Boolean(
    input.prepared && file?.metadata_status === 'valid' &&
    file.data_hash === input.prepared.data_hash,
  );
  const canPublish = Boolean(
    connected && input.prepared && file && !loading && !error &&
    checkedPreparation === input.prepared && !stale && !unchanged,
  );
  const preparationState = !input.prepared
    ? 'notPrepared'
    : stale
      ? 'stale'
      : checkedPreparation !== input.prepared
        ? 'checking'
        : unchanged
          ? 'unchanged'
          : file?.metadata_status === 'valid' ? 'changed' : 'baseline';
  return (
    <Panel
      leading={<StudioIcon icon={Upload} />}
      title={t('panel.title')}
      description={t('panel.description')}
    >
      <div className="publishing-content">
        {loading ? (
          <p role="status">
            <Spinner /> {t('loading')}
          </p>
        ) : null}
        {!loading && !error && status && !connected ? (
          <Notice
            tone="info"
            title={status.configured ? t('panel.disabled') : undefined}
          >
            {t(status.configured ? 'panel.enableHint' : 'panel.notConfigured')}
          </Notice>
        ) : null}
        {error ? (
          <Notice
            tone={error === 'PUBLISHING_RESULT_UNKNOWN' ? 'warning' : 'error'}
            title={t(
              error === 'PUBLISHING_RESULT_UNKNOWN'
                ? 'panel.unknown'
                : 'panel.failed',
            )}
          >
            {t(`errors.${publishingErrorKey(error)}`)}
          </Notice>
        ) : null}
        {result && result.outcome !== 'unchanged' ? (
          <Notice tone="success">{t(`outcome.${result.outcome}`)}</Notice>
        ) : null}
        {!loading && !error && connected && (!result || result.outcome === 'unchanged' || stale) ? (
          <Notice tone="info">{t(`readiness.${preparationState}`)}</Notice>
        ) : null}
        {file ? (
          <dl className="publishing-details">
            <div>
              <dt>{t('panel.target')}</dt>
              <dd>
                <a
                  href={githubFileUrl(file.target)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {file.target.owner}/{file.target.repo} · {file.target.branch}{' '}
                  · {file.target.path}
                  <StudioIcon icon={ExternalLink} />
                </a>
              </dd>
            </div>
            <div>
              <dt>{t('panel.latest')}</dt>
              <dd>
                <a
                  href={file.commit.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <time dateTime={file.commit.committed_at_iso}>
                    {new Intl.DateTimeFormat(i18n.resolvedLanguage, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(file.commit.committed_at_iso))}
                  </time>{' '}
                  · {file.commit.sha.slice(0, 7)}
                  <StudioIcon icon={ExternalLink} />
                </a>
              </dd>
            </div>
          </dl>
        ) : null}
        <div className="publishing-actions">
          {connected ? (
            <Button
              type="button"
              variant={canPublish ? 'primary' : 'secondary'}
              disabled={busy || !canPublish}
              aria-busy={busy}
              onClick={() => {
                if (canPublish && status?.file && input.prepared) {
                  setConfirmation({
                    request: {
                      expected_revision: status.revision,
                      expected_data_hash: input.prepared.data_hash,
                      expected_blob_sha: status.file.blob_sha,
                    },
                    prepared: input.prepared,
                    target: status.file.target,
                  });
                }
              }}
            >
              {busy ? <Spinner /> : <StudioIcon icon={Upload} />}
              {t(busy ? 'panel.publishing' : 'panel.publish')}
            </Button>
          ) : null}
          {stale ? (
            <Button type="button" disabled={busy} onClick={input.onPrepare}>
              <StudioIcon icon={RefreshCw} />
              {t('readiness.prepareAgain')}
            </Button>
          ) : null}
          {connected || error ? (
            <Button
              type="button"
              disabled={busy || loading}
              onClick={() => setAttempt((value) => value + 1)}
            >
              <StudioIcon icon={RefreshCw} />
              {t('retry')}
            </Button>
          ) : null}
          <ButtonLink
            to="/settings/site/publishing"
            variant="secondary"
          >
            <StudioIcon icon={Settings2} />
            {t('panel.settings')}
          </ButtonLink>
        </div>
      </div>
      <Dialog
        open={confirmation !== null}
        onClose={() => setConfirmation(null)}
        title={t('confirmation.title')}
        description={t('confirmation.description')}
        busy={busy}
        initialFocusRef={cancelRef}
        actions={
          <>
            <Button
              ref={cancelRef}
              type="button"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              {t('confirmation.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy || loading || Boolean(error) || !canPublish}
              aria-busy={busy}
              onClick={() => void publish()}
            >
              {busy ? <Spinner /> : <StudioIcon icon={Upload} />}
              {t(busy ? 'panel.publishing' : 'panel.publish')}
            </Button>
          </>
        }
      >
        {confirmation ? (
          <dl className="publishing-details publishing-confirmation-target">
            <div>
              <dt>{t('settings.repo')}</dt>
              <dd>
                {confirmation.target.owner}/{confirmation.target.repo}
              </dd>
            </div>
            <div>
              <dt>{t('settings.branch')}</dt>
              <dd>{confirmation.target.branch}</dd>
            </div>
            <div>
              <dt>{t('settings.path')}</dt>
              <dd>{confirmation.target.path}</dd>
            </div>
          </dl>
        ) : null}
      </Dialog>
      <UnsavedChangesGuard
        active={busy}
        copy={{
          kicker: t('panel.title'),
          title: t('leaving.title'),
          description: t('leaving.description'),
          stay: t('leaving.stay'),
          leave: t('leaving.leave'),
        }}
      />
    </Panel>
  );
}

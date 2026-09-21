import { useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  githubFileUrl,
  type PublishingStatus,
  type PublishingResult,
  type PublishingTarget,
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

export function PublishingPanel(input: {
  csrfToken: string;
  onSessionEnded: () => void;
}) {
  const { t, i18n } = useTranslation('publishing');
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<PublishingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublishingResult | null>(null);
  const [confirmation, setConfirmation] = useState<{
    revision: string;
    target: PublishingTarget;
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
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void requestPublishingStatus(controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        if (response.success) setStatus(response.data);
        else if (response.error.code === 'AUTHENTICATION_REQUIRED')
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
  }, [attempt, input.onSessionEnded]);
  async function publish() {
    if (
      publishing.current ||
      !confirmation ||
      !status?.enabled ||
      !status.configured ||
      loading ||
      error
    )
      return;
    publishing.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await requestPublish(
        input.csrfToken,
        confirmation.revision,
      );
      if (!mounted.current) return;
      if (response.success) {
        setResult(response.data);
        setStatus({ ...status, file: response.data.file });
      } else if (response.error.code === 'AUTHENTICATION_REQUIRED')
        input.onSessionEnded();
      else {
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
        setConfirmation(null);
      }
    }
  }
  const file = status?.file ?? result?.file;
  const canPublish = Boolean(status?.enabled && status.configured);
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
        {!loading && !error && status && !canPublish ? (
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
        {result ? (
          <Notice tone="success">{t(`outcome.${result.outcome}`)}</Notice>
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
          {canPublish ? (
            <Button
              type="button"
              variant="primary"
              disabled={busy || loading || Boolean(error) || !status?.file}
              aria-busy={busy}
              onClick={() => {
                if (status?.file) {
                  setConfirmation({
                    revision: status.revision,
                    target: status.file.target,
                  });
                }
              }}
            >
              {busy ? <Spinner /> : <StudioIcon icon={Upload} />}
              {t(busy ? 'panel.publishing' : 'panel.publish')}
            </Button>
          ) : null}
          {canPublish || error ? (
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
            variant={
              !loading && status && !canPublish ? 'primary' : 'secondary'
            }
          >
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

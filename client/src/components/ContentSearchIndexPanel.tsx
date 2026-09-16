import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, SearchCheck } from 'lucide-react';
import {
  CONTENT_SEARCH_REBUILD_CONFIRMATION,
  type ContentSearchIndexStatus,
} from '../../../contracts/content-search-index';
import {
  OperationsClientError,
  requestContentSearchIndexRebuildStart,
  requestContentSearchIndexRebuildStep,
} from '../lib/operations-client';
import { useBusyChange, type BusyChangeHandler } from '../hooks/useBusyChange';
import {
  Button,
  Callout,
  Dialog,
  DialogActions,
  Field,
  Notice,
  Panel,
  Spinner,
  StatusPill,
  StudioIcon,
} from './primitives';

type Props = {
  token: string;
  status: ContentSearchIndexStatus;
  refreshStatus: () => Promise<void>;
  headingLevel?: 2 | 3;
  onBusyChange?: BusyChangeHandler;
};

type Message = {
  tone: 'success' | 'error';
  text: string;
} | null;

function totalProcessed(status: ContentSearchIndexStatus): number {
  return status.processed_posts + status.processed_pages;
}

function totalRows(status: ContentSearchIndexStatus): number {
  return status.total_posts + status.total_pages;
}

export function ContentSearchIndexPanel(props: Props) {
  const { t } = useTranslation('operations');
  const [current, setCurrent] = useState(props.status);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  useBusyChange(props.onBusyChange, busy);

  useEffect(() => setCurrent(props.status), [props.status]);

  async function finishSteps(initial: ContentSearchIndexStatus) {
    let state = initial;
    while (
      state.state === 'in_progress'
      && state.operation_id
      && state.phase
    ) {
      const response = await requestContentSearchIndexRebuildStep({
        token: props.token,
        request: {
          operation_id: state.operation_id,
          expected_phase: state.phase,
          expected_post_public_id_cursor: state.post_public_id_cursor,
          expected_page_public_id_cursor: state.page_public_id_cursor,
        },
      });
      if (!response.success) {
        setMessage({
          tone: 'error',
          text: t('contentSearchIndex.errors.api', {
            code: response.error.code,
          }),
        });
        return;
      }
      state = response.data.content_search_index;
      setCurrent(state);
    }
    if (state.state === 'ready') {
      setMessage({ tone: 'success', text: t('contentSearchIndex.completed') });
    }
  }

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      busy
      || confirmation !== CONTENT_SEARCH_REBUILD_CONFIRMATION
    ) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await requestContentSearchIndexRebuildStart({
        token: props.token,
        request: {
          administrator_email: email,
          administrator_password: password,
          confirmation,
        },
      });
      if (!response.success) {
        setMessage({
          tone: 'error',
          text: t('contentSearchIndex.errors.api', {
            code: response.error.code,
          }),
        });
        return;
      }
      setDialogOpen(false);
      setPassword('');
      setConfirmation('');
      setCurrent(response.data.content_search_index);
      await finishSteps(response.data.content_search_index);
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof OperationsClientError
          ? t('contentSearchIndex.errors.client', { code: error.code })
          : t('contentSearchIndex.errors.unexpected'),
      });
    } finally {
      await props.refreshStatus().catch(() => undefined);
      setBusy(false);
    }
  }

  async function resume() {
    if (busy || current.state !== 'in_progress') return;
    setBusy(true);
    setMessage(null);
    try {
      await finishSteps(current);
    } catch (error) {
      setMessage({
        tone: 'error',
        text: error instanceof OperationsClientError
          ? t('contentSearchIndex.errors.client', { code: error.code })
          : t('contentSearchIndex.errors.unexpected'),
      });
    } finally {
      await props.refreshStatus().catch(() => undefined);
      setBusy(false);
    }
  }

  const processed = totalProcessed(current);
  const total = totalRows(current);
  const progress = total === 0
    ? current.state === 'ready' ? 100 : 0
    : Math.min(100, Math.round((processed / total) * 100));

  return (
    <>
      <Panel
        headingLevel={props.headingLevel ?? 3}
        leading={<StudioIcon icon={SearchCheck} />}
        kicker={t('contentSearchIndex.level')}
        title={t('contentSearchIndex.title')}
        description={t('contentSearchIndex.description')}
      >
        <div className="operations-content-card">
          <Callout
            tone={current.state === 'ready'
              ? 'success'
              : current.state === 'unavailable'
                ? 'error'
                : 'warning'}
            title={t(`contentSearchIndex.states.${current.state}`)}
          >
            {t(`contentSearchIndex.guidance.${current.state}`)}
          </Callout>
          <div className="operations-summary">
            <p className="operations-summary-card">
              <span className="operations-summary-label">
                {t('contentSearchIndex.metrics.posts')}
              </span>
              <strong className="operations-summary-value">
                {current.processed_posts} / {current.total_posts}
              </strong>
            </p>
            <p className="operations-summary-card">
              <span className="operations-summary-label">
                {t('contentSearchIndex.metrics.pages')}
              </span>
              <strong className="operations-summary-value">
                {current.processed_pages} / {current.total_pages}
              </strong>
            </p>
            <p className="operations-summary-card">
              <span className="operations-summary-label">
                {t('contentSearchIndex.metrics.progress')}
              </span>
              <strong className="operations-summary-value">{progress}%</strong>
            </p>
          </div>
          {current.phase ? (
            <p>
              <StatusPill tone="attention">
                {t(`contentSearchIndex.phases.${current.phase}`)}
              </StatusPill>
            </p>
          ) : null}
          {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
          <div className="operations-actions">
            {busy ? (
              <span>
                <Spinner /> {t('contentSearchIndex.running')}
              </span>
            ) : null}
            {current.available && current.state === 'in_progress' ? (
              <>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void resume()}
                >
                  <StudioIcon className="operations-button-icon" icon={RefreshCw} />
                  {t('contentSearchIndex.resume')}
                </Button>
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => setDialogOpen(true)}
                >
                  <StudioIcon className="operations-button-icon" icon={RefreshCw} />
                  {t('contentSearchIndex.restart')}
                </Button>
              </>
            ) : current.available && current.state !== 'unavailable' ? (
              <Button
                type="button"
                disabled={busy}
                onClick={() => setDialogOpen(true)}
              >
                <StudioIcon className="operations-button-icon" icon={RefreshCw} />
                {current.state === 'ready'
                  ? t('contentSearchIndex.rebuild')
                  : t('contentSearchIndex.start')}
              </Button>
            ) : null}
          </div>
        </div>
      </Panel>

      <Dialog
        open={dialogOpen}
        onClose={() => {
          if (!busy) setDialogOpen(false);
        }}
        busy={busy}
        title={t('contentSearchIndex.dialog.title')}
        description={t('contentSearchIndex.dialog.description')}
      >
        <form className="operations-dialog-form" onSubmit={start} noValidate>
          <Field label={t('credentials.email')}>
            {(control) => (
              <input
                {...control}
                type="email"
                autoComplete="username"
                value={email}
                maxLength={254}
                disabled={busy}
                required
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('credentials.password')}>
            {(control) => (
              <input
                {...control}
                type="password"
                autoComplete="current-password"
                value={password}
                maxLength={1024}
                disabled={busy}
                required
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </Field>
          <Field
            label={t('contentSearchIndex.confirmation')}
            labelAdornment={(
              <code className="operations-code">
                {CONTENT_SEARCH_REBUILD_CONFIRMATION}
              </code>
            )}
          >
            {(control) => (
              <input
                {...control}
                type="text"
                autoComplete="off"
                value={confirmation}
                disabled={busy}
                required
                onChange={(event) => setConfirmation(event.target.value)}
              />
            )}
          </Field>
          <Callout tone="info">
            {t('contentSearchIndex.dialog.impact')}
          </Callout>
          <DialogActions>
            <Button
              type="button"
              disabled={busy}
              onClick={() => setDialogOpen(false)}
            >
              {t('confirmation.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={busy
                || !email
                || !password
                || confirmation !== CONTENT_SEARCH_REBUILD_CONFIRMATION}
            >
              <StudioIcon className="operations-button-icon" icon={RefreshCw} />
              {t('contentSearchIndex.start')}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  );
}

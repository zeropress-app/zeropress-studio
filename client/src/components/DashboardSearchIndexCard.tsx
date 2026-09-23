import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, RefreshCw, SearchCheck, Wrench, X } from 'lucide-react';
import type { ContentSearchIndexStatus } from '../../../contracts/content-search-index';
import {
  ContentSearchIndexClientError,
  requestContentSearchIndex,
  requestContentSearchIndexRebuild,
} from '../lib/content-search-index-client';
import { Button, ButtonLink, Dialog, Spinner, StudioIcon } from './primitives';
import { DashboardRuntimeRow } from './DashboardRuntimeRow';

type IndexState = ContentSearchIndexStatus['state'];
type SearchFailure = 'failed' | 'connection' | 'changed' | 'notAvailable' | 'access';

function errorKey(error: unknown): SearchFailure {
  if (!(error instanceof ContentSearchIndexClientError)) return 'failed';
  switch (error.code) {
    case 'NETWORK_ERROR':
    case 'TIMEOUT': return 'connection';
    case 'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT': return 'changed';
    case 'CONTENT_SEARCH_INDEX_REBUILD_NOT_AVAILABLE': return 'notAvailable';
    case 'FORBIDDEN':
    case 'CSRF_VALIDATION_FAILED': return 'access';
    default: return 'failed';
  }
}

export function DashboardSearchIndexCard(input: {
  initialState: IndexState;
  csrfToken: string;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('dashboard');
  const { initialState, onSessionEnded } = input;
  const [status, setStatus] = useState<ContentSearchIndexStatus | null>(null);
  const [state, setState] = useState(initialState);
  const [loading, setLoading] = useState(initialState !== 'ready');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SearchFailure | null>(null);
  const [confirm, setConfirm] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const running = useRef(false);

  const acceptStatus = useCallback((value: ContentSearchIndexStatus) => {
    setStatus(value);
    setState(value.state);
    if (value.state === 'ready') setError(null);
  }, []);

  const readStatus = useCallback(async (signal: AbortSignal) => {
    const value = await requestContentSearchIndex(signal);
    if (!signal.aborted) acceptStatus(value);
    return value;
  }, [acceptStatus]);

  const handleFailure = useCallback((cause: unknown) => {
    if (cause instanceof ContentSearchIndexClientError
      && cause.code === 'AUTHENTICATION_REQUIRED') {
      onSessionEnded();
      return;
    }
    setError(errorKey(cause));
  }, [onSessionEnded]);

  const refresh = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      await readStatus(signal);
    } catch (cause) {
      if (signal.aborted) return;
      setStatus(null);
      setState('unavailable');
      handleFailure(cause);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [handleFailure, readStatus]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    if (initialState !== 'ready') void refresh(controller.signal);
    return () => controller.abort();
  }, [initialState, refresh]);

  async function rebuild(resume: boolean) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || running.current || loading || !status?.available) return;
    running.current = true;
    setBusy(true);
    setConfirm(false);
    setError(null);
    try {
      let current = resume ? status : await requestContentSearchIndexRebuild({
        csrfToken: input.csrfToken, signal,
      });
      if (signal.aborted) return;
      acceptStatus(current);
      while (current.state === 'in_progress' && !signal.aborted) {
        if (!current.operation_id || !current.phase) {
          throw new ContentSearchIndexClientError('INVALID_RESPONSE');
        }
        current = await requestContentSearchIndexRebuild({
          csrfToken: input.csrfToken,
          signal,
          step: {
            operation_id: current.operation_id,
            expected_phase: current.phase,
            expected_post_public_id_cursor: current.post_public_id_cursor,
            expected_page_public_id_cursor: current.page_public_id_cursor,
          },
        });
        if (signal.aborted) return;
        acceptStatus(current);
      }
    } catch (cause) {
      if (signal.aborted) return;
      handleFailure(cause);
      if (cause instanceof ContentSearchIndexClientError
        && cause.code === 'AUTHENTICATION_REQUIRED') return;
      // A failed response can follow a committed batch. Read the checkpoint;
      // never retry a mutation automatically or restart the rebuild.
      try {
        await readStatus(signal);
      } catch (readError) {
        if (signal.aborted) return;
        setStatus(null);
        setState('unavailable');
        handleFailure(readError);
      }
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  const blocked = status && !status.available
    && (state === 'rebuild_required' || state === 'in_progress');
  const showRefresh = state === 'unavailable' || blocked || (error && state !== 'ready');
  return (
    <>
      <DashboardRuntimeRow
        icon={SearchCheck}
        label={t('runtime.contentSearch')}
        state={busy ? 'in_progress' : state}
        actions={state === 'ready' ? undefined : (
          <>
            {state === 'rebuild_required' ? (
              <Button type="button" size="sm"
                disabled={loading || busy || !status?.available}
                onClick={() => setConfirm(true)}>
                {busy ? <Spinner /> : <StudioIcon icon={RefreshCw} className="dashboard-action-icon" />}
                {t(busy ? 'searchIndex.running' : 'searchIndex.start')}
              </Button>
            ) : null}
            {state === 'in_progress' ? (
              <Button type="button" size="sm" disabled={loading || busy || !status?.available}
                aria-busy={busy} onClick={() => void rebuild(true)}>
                {busy ? <Spinner /> : <StudioIcon icon={Play} className="dashboard-action-icon" />}
                {t(busy ? 'searchIndex.running' : 'searchIndex.continue')}
              </Button>
            ) : null}
            {state === 'recovery_required' ? (
              <ButtonLink size="sm" to="/system/operations/database">
                <StudioIcon icon={Wrench} className="dashboard-action-icon" />
                {t('searchIndex.operations')}
              </ButtonLink>
            ) : null}
            {showRefresh ? (
              <Button type="button" size="sm" disabled={busy || loading} onClick={() => {
                if (lifetime.current) void refresh(lifetime.current.signal);
              }}>
                <StudioIcon icon={RefreshCw} className="dashboard-action-icon" />
                {t('searchIndex.refresh')}
              </Button>
            ) : null}
          </>
        )}
      >
        {state === 'in_progress' && status ? (
          <p className="dashboard-runtime-detail" role="status">{t('searchIndex.processed', {
            posts: status.processed_posts, pages: status.processed_pages,
          })}{status.phase ? ` · ${t(`searchIndex.phases.${status.phase}`)}` : ''}</p>
        ) : null}
        {busy ? <p className="dashboard-runtime-detail">{t('searchIndex.runningHint')}</p> : null}
        {state === 'recovery_required' ? (
          <p className="dashboard-runtime-detail">{t('searchIndex.recoveryHint')}</p>
        ) : null}
        {blocked ? (
          <p className="dashboard-runtime-detail">{t('searchIndex.errors.notAvailable')}</p>
        ) : null}
        {error ? (
          <p className="dashboard-runtime-error" role="alert">{t(`searchIndex.errors.${error}`)}</p>
        ) : null}
      </DashboardRuntimeRow>
      <Dialog open={confirm} onClose={() => setConfirm(false)}
        title={t('searchIndex.confirmTitle')}
        description={t('searchIndex.confirmDescription')}
        initialFocusRef={cancelRef}
        actions={(
          <>
            <Button ref={cancelRef} type="button" onClick={() => setConfirm(false)}>
              <StudioIcon icon={X} className="dashboard-action-icon" />
              {t('searchIndex.cancel')}
            </Button>
            <Button type="button" variant="primary" onClick={() => void rebuild(false)}>
              <StudioIcon icon={RefreshCw} className="dashboard-action-icon" />
              {t('searchIndex.start')}
            </Button>
          </>
        )}
      />
    </>
  );
}

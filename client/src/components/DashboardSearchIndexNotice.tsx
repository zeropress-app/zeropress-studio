import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContentSearchIndexStatus } from '../../../contracts/content-search-index';
import {
  ContentSearchIndexClientError,
  requestContentSearchIndex,
  requestContentSearchIndexRebuild,
} from '../lib/content-search-index-client';
import { Button, ButtonLink, Dialog, Notice, Spinner } from './primitives';

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

export function DashboardSearchIndexNotice(input: {
  initialState: IndexState;
  csrfToken: string;
  onSessionEnded: () => void;
  onStateChange: (state: IndexState) => void;
}) {
  const { t } = useTranslation('dashboard');
  const { initialState, onSessionEnded, onStateChange } = input;
  const [status, setStatus] = useState<ContentSearchIndexStatus | null>(null);
  const [state, setState] = useState(initialState);
  const [loading, setLoading] = useState(initialState !== 'ready');
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState<SearchFailure | null>(null);
  const [confirm, setConfirm] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const running = useRef(false);

  const acceptStatus = useCallback((value: ContentSearchIndexStatus) => {
    setStatus(value);
    setState(value.state);
    onStateChange(value.state);
  }, [onStateChange]);

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
      onStateChange('unavailable');
      handleFailure(cause);
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [handleFailure, onStateChange, readStatus]);

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
      if (!signal.aborted) setCompleted(current.state === 'ready');
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
        onStateChange('unavailable');
        handleFailure(readError);
      }
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  if (state === 'ready' && !completed) return null;
  const title = busy ? 'running' : state;
  return (
    <>
      <Notice
        tone={state === 'ready' ? 'success'
          : state === 'unavailable' || error ? 'error' : 'warning'}
        title={t(`searchIndex.titles.${title}`)}
        actions={(
          <>
            {state === 'rebuild_required' ? (
              <Button type="button" variant="primary"
                disabled={loading || busy || !status?.available}
                onClick={() => setConfirm(true)}>
                {t('searchIndex.start')}
              </Button>
            ) : null}
            {state === 'in_progress' ? (
              <Button type="button" disabled={loading || busy || !status?.available}
                aria-busy={busy} onClick={() => void rebuild(true)}>
                {busy ? <Spinner /> : null}
                {t(busy ? 'searchIndex.running' : 'searchIndex.continue')}
              </Button>
            ) : null}
            {state === 'recovery_required' ? (
              <ButtonLink to="/system/operations/database">
                {t('searchIndex.operations')}
              </ButtonLink>
            ) : null}
            {state !== 'ready' ? (
              <Button type="button" disabled={busy || loading} onClick={() => {
                if (lifetime.current) void refresh(lifetime.current.signal);
              }}>{t('searchIndex.refresh')}</Button>
            ) : null}
          </>
        )}
      >
        <p>{t(`searchIndex.descriptions.${title}`)}</p>
        {state === 'in_progress' && status ? (
          <p>{t('searchIndex.processed', {
            posts: status.processed_posts, pages: status.processed_pages,
          })}{status.phase ? ` · ${t(`searchIndex.phases.${status.phase}`)}` : ''}</p>
        ) : null}
        {status && !status.available
          && (state === 'rebuild_required' || state === 'in_progress') ? (
            <p>{t('searchIndex.errors.notAvailable')}</p>
          ) : null}
        {error && state !== 'unavailable' ? (
          <p>{t(`searchIndex.errors.${error}`)}</p>
        ) : null}
      </Notice>
      <Dialog open={confirm} onClose={() => setConfirm(false)}
        title={t('searchIndex.confirmTitle')}
        description={t('searchIndex.confirmDescription')}
        initialFocusRef={cancelRef}
        actions={(
          <>
            <Button ref={cancelRef} type="button" onClick={() => setConfirm(false)}>
              {t('searchIndex.cancel')}
            </Button>
            <Button type="button" variant="primary" onClick={() => void rebuild(false)}>
              {t('searchIndex.start')}
            </Button>
          </>
        )}
      />
    </>
  );
}

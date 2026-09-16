import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ApiErrorCode, ApiErrorResponse } from '../../../contracts/api';
import type {
  ContentRevisionList,
  RestoreContentRevisionRequest,
} from '../../../contracts/content-revisions';
import {
  normalizePostContentSnapshot,
  type PostContentSnapshot,
} from '../../../contracts/post-autosaves';
import type { PostRevisionDocument } from '../../../contracts/post-revisions';
import {
  normalizePageContentSnapshot,
  type PageContentSnapshot,
} from '../../../contracts/page-autosaves';
import type { PageRevisionDocument } from '../../../contracts/page-revisions';
import {
  ContentSnapshotComparison,
  type ContentSnapshotComparisonCopy,
  type NormalizedContentSnapshot,
} from './ContentSnapshotComparison';
import {
  Button,
  Dialog,
  EmptyState,
  Field,
  Notice,
} from './primitives';

type RevisionSnapshot = PostContentSnapshot | PageContentSnapshot;
type RevisionDocument = PostRevisionDocument | PageRevisionDocument;
type RevisionListResponse =
  | { success: true; data: ContentRevisionList }
  | ApiErrorResponse;
type RevisionDetailResponse =
  | { success: true; data: RevisionDocument }
  | ApiErrorResponse;
type RevisionRestoreResponse =
  | { success: true; data: unknown }
  | ApiErrorResponse;

type Copy = ContentSnapshotComparisonCopy & {
  title: string;
  description: string;
  close: string;
  loading: string;
  loadError: string;
  noHistory: string;
  olderRevision: string;
  newerRevision: string;
  current: string;
  restore: string;
  restoreConfirmTitle: string;
  restoreConfirmDescription: string;
  restoreCancel: string;
  restoreConfirm: string;
  restoring: string;
  restoreError: string;
  revisionConflict: string;
  revisionNotFound: string;
  restoreUnavailable: string;
};

function normalizeRevisionSnapshot(
  snapshot: RevisionSnapshot,
): NormalizedContentSnapshot {
  return snapshot.content_type === 'post'
    ? normalizePostContentSnapshot(snapshot)
    : normalizePageContentSnapshot(snapshot);
}

function apiFailureMessage(code: ApiErrorCode, copy: Copy): string {
  if (code === 'POST_REVISION_CONFLICT' || code === 'PAGE_REVISION_CONFLICT') {
    return copy.revisionConflict;
  }
  if (
    code === 'POST_SAVED_REVISION_NOT_FOUND'
    || code === 'PAGE_SAVED_REVISION_NOT_FOUND'
    || code === 'POST_NOT_FOUND'
    || code === 'PAGE_NOT_FOUND'
  ) return copy.revisionNotFound;
  if (
    code === 'POST_SLUG_CONFLICT'
    || code === 'PAGE_SLUG_CONFLICT'
    || code === 'AUTHOR_NOT_FOUND'
    || code === 'TAXONOMY_TERM_NOT_FOUND'
    || code === 'MEDIA_NOT_FOUND'
    || code === 'PAGE_PARENT_NOT_FOUND'
    || code === 'PAGE_PARENT_CYCLE'
    || code === 'PAGE_HAS_CHILDREN'
    || code === 'PAGE_IS_FRONT_PAGE'
  ) return copy.restoreUnavailable;
  return copy.restoreError;
}

export function ContentRevisionHistoryDialog(input: {
  copy: Copy;
  formatDate: (iso: string) => string;
  onClose: () => void;
  onRestored: () => void;
  onSessionEnded: () => void;
  requestList: (signal: AbortSignal) => Promise<RevisionListResponse>;
  requestDetail: (
    revisionId: string,
    signal: AbortSignal,
  ) => Promise<RevisionDetailResponse>;
  requestRestore: (
    revisionId: string,
    request: RestoreContentRevisionRequest,
  ) => Promise<RevisionRestoreResponse>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(input.onClose);
  onCloseRef.current = input.onClose;
  const copyRef = useRef(input.copy);
  copyRef.current = input.copy;
  const onSessionEndedRef = useRef(input.onSessionEnded);
  onSessionEndedRef.current = input.onSessionEnded;
  const requestListRef = useRef(input.requestList);
  requestListRef.current = input.requestList;
  const requestDetailRef = useRef(input.requestDetail);
  requestDetailRef.current = input.requestDetail;
  const [list, setList] = useState<ContentRevisionList | null>(null);
  const [leftRevision, setLeftRevision] = useState('');
  const [rightRevision, setRightRevision] = useState('');
  const [documents, setDocuments] = useState<RevisionDocument[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const restoringRef = useRef(restoring);
  restoringRef.current = restoring;

  // The Dialog primitive owns focus trapping, Escape handling, and scroll locking.
  // Dialog's busy state blocks Escape while restoration is in progress.

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void requestListRef.current(controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          onSessionEndedRef.current();
          return;
        }
        setError(apiFailureMessage(response.error.code, copyRef.current));
        return;
      }
      setList(response.data);
      setRightRevision(response.data.current_revision);
      setLeftRevision(
        response.data.items.find((item) => !item.current)?.revision_id
          ?? response.data.current_revision,
      );
    }).catch(() => {
      if (!controller.signal.aborted) setError(copyRef.current.loadError);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!leftRevision || !rightRevision) return;
    const controller = new AbortController();
    setComparisonLoading(true);
    setDocuments(null);
    setError(null);
    const ids = leftRevision === rightRevision
      ? [leftRevision]
      : [leftRevision, rightRevision];
    void Promise.all(ids.map((revisionId) => (
      requestDetailRef.current(revisionId, controller.signal)
    ))).then((responses) => {
      if (controller.signal.aborted) return;
      const failure = responses.find((response) => !response.success);
      if (failure && !failure.success) {
        if (failure.error.code === 'AUTHENTICATION_REQUIRED') {
          onSessionEndedRef.current();
          return;
        }
        setError(apiFailureMessage(failure.error.code, copyRef.current));
        return;
      }
      const values = responses.flatMap((response) => (
        response.success ? [response.data] : []
      ));
      setDocuments(leftRevision === rightRevision
        ? [values[0], values[0]]
        : values);
    }).catch(() => {
      if (!controller.signal.aborted) setError(copyRef.current.loadError);
    }).finally(() => {
      if (!controller.signal.aborted) setComparisonLoading(false);
    });
    return () => controller.abort();
  }, [leftRevision, rightRevision]);

  const normalizedSnapshots = useMemo(() => (
    documents?.[0] && documents[1]
      ? [
          normalizeRevisionSnapshot(documents[0].snapshot),
          normalizeRevisionSnapshot(documents[1].snapshot),
        ] as const
      : null
  ), [documents]);
  async function restoreRevision() {
    if (
      restoring
      || !list
      || leftRevision === list.current_revision
    ) return;
    setRestoring(true);
    setError(null);
    try {
      const response = await input.requestRestore(leftRevision, {
        expected_revision: list.current_revision,
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setError(apiFailureMessage(response.error.code, input.copy));
        setConfirmRestore(false);
        return;
      }
      input.onRestored();
    } catch {
      setError(input.copy.restoreError);
      setConfirmRestore(false);
    } finally {
      setRestoring(false);
    }
  }

  return (
    <Dialog
      open
      size="wide"
      onClose={input.onClose}
      busy={restoring}
      title={input.copy.title}
      description={input.copy.description}
      initialFocusRef={closeRef}
      actions={(
        <>
          {!confirmRestore ? (
            <Button
              type="button"
              disabled={
                restoring
                || !list
                || !leftRevision
                || leftRevision === list.current_revision
              }
              onClick={() => setConfirmRestore(true)}
            >
              {input.copy.restore}
            </Button>
          ) : null}
          <Button
            ref={closeRef}
            type="button"
            disabled={restoring}
            onClick={input.onClose}
          >
            {input.copy.close}
          </Button>
        </>
      )}
    >
      <div className="content-revision-body">
        {loading ? (
          <p className="content-revision-state" role="status">
            {input.copy.loading}
          </p>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}

        {list ? (
          <>
            {list.items.length === 1 ? (
              <EmptyState title={input.copy.noHistory} />
            ) : null}
            <div className="content-revision-selectors">
              <Field label={input.copy.olderRevision}>
                {(control) => (
                  <select
                    {...control}
                    value={leftRevision}
                    disabled={restoring}
                    onChange={(event) => {
                      setLeftRevision(event.target.value);
                      setConfirmRestore(false);
                    }}
                  >
                    {list.items.map((item) => (
                      <option key={item.revision_id} value={item.revision_id}>
                        {input.formatDate(item.saved_at_iso)} · {item.title}
                        {item.current ? ` · ${input.copy.current}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={input.copy.newerRevision}>
                {(control) => (
                  <select
                    {...control}
                    value={rightRevision}
                    disabled={restoring}
                    onChange={(event) => setRightRevision(event.target.value)}
                  >
                    {list.items.map((item) => (
                      <option key={item.revision_id} value={item.revision_id}>
                        {input.formatDate(item.saved_at_iso)} · {item.title}
                        {item.current ? ` · ${input.copy.current}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
          </>
        ) : null}

        {comparisonLoading ? (
          <p className="content-revision-state" role="status">
            {input.copy.loading}
          </p>
        ) : null}
        {documents?.[0] && documents[1] && normalizedSnapshots ? (
          <ContentSnapshotComparison
            left={normalizedSnapshots[0]}
            right={normalizedSnapshots[1]}
            leftLabel={input.copy.olderRevision}
            rightLabel={input.copy.newerRevision}
            comparisonKey={`${leftRevision}:${rightRevision}`}
            copy={input.copy}
          />
        ) : null}

        {confirmRestore ? (
          <Notice
            tone="warning"
            title={input.copy.restoreConfirmTitle}
            actions={(
              <>
                <Button
                  type="button"
                  size="sm"
                  disabled={restoring}
                  onClick={() => setConfirmRestore(false)}
                >
                  {input.copy.restoreCancel}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  disabled={restoring}
                  onClick={() => void restoreRevision()}
                >
                  {restoring
                    ? input.copy.restoring
                    : input.copy.restoreConfirm}
                </Button>
              </>
            )}
          >
            {input.copy.restoreConfirmDescription}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
}

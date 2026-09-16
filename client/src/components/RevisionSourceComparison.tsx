import {
  Component,
  Suspense,
  lazy,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import type { RevisionDiffDocumentType } from '../editor/monaco-revision-diff';
import type { RevisionDiffPresentationSource } from '../editor/revision-diff-presentation';
import { Button, Field, Notice, Spinner } from './primitives';

const LazyMonacoRevisionDiff = lazy(async () => {
  const module = await import('./MonacoRevisionDiff');
  return { default: module.MonacoRevisionDiff };
});

type Copy = {
  diffLabel: string;
  diffLoading: string;
  diffUnavailable: string;
  diffRetry: string;
  leftSource: string;
  rightSource: string;
};

function RevisionSourceFallback(input: {
  copy: Copy;
  original: string;
  modified: string;
}) {
  return (
    <div className="content-revision-sources">
      <Field label={input.copy.leftSource}>
        {(control) => (
          <textarea {...control} readOnly value={input.original} />
        )}
      </Field>
      <Field label={input.copy.rightSource}>
        {(control) => (
          <textarea {...control} readOnly value={input.modified} />
        )}
      </Field>
    </div>
  );
}

class RevisionDiffErrorBoundary extends Component<{
  fallback: ReactNode;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Source fallback remains available and restoring never depends on Monaco.
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function RevisionSourceComparison(input: {
  copy: Copy;
  original: string;
  modified: string;
  originalDocumentType: RevisionDiffDocumentType;
  modifiedDocumentType: RevisionDiffDocumentType;
  originalEditorMode: RevisionDiffPresentationSource['editorMode'];
  modifiedEditorMode: RevisionDiffPresentationSource['editorMode'];
  originalEditorProfile: RevisionDiffPresentationSource['editorProfile'];
  modifiedEditorProfile: RevisionDiffPresentationSource['editorProfile'];
}) {
  const [attempt, setAttempt] = useState(0);
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);

  const fallback = (
    <div className="content-revision-diff-fallback">
      <Notice
        tone="warning"
        actions={(
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setRuntimeUnavailable(false);
              setAttempt((value) => value + 1);
            }}
          >
            {input.copy.diffRetry}
          </Button>
        )}
      >
        {input.copy.diffUnavailable}
      </Notice>
      <RevisionSourceFallback
        copy={input.copy}
        original={input.original}
        modified={input.modified}
      />
    </div>
  );

  if (runtimeUnavailable) return fallback;
  return (
    <RevisionDiffErrorBoundary key={attempt} fallback={fallback}>
      <Suspense fallback={(
        <div className="content-revision-diff-loading" role="status">
          <span className="content-revision-diff-loading-inner">
            <Spinner />
            {input.copy.diffLoading}
          </span>
        </div>
      )}>
        <LazyMonacoRevisionDiff
          original={input.original}
          modified={input.modified}
          originalDocumentType={input.originalDocumentType}
          modifiedDocumentType={input.modifiedDocumentType}
          originalEditorMode={input.originalEditorMode}
          modifiedEditorMode={input.modifiedEditorMode}
          originalEditorProfile={input.originalEditorProfile}
          modifiedEditorProfile={input.modifiedEditorProfile}
          originalLabel={input.copy.leftSource}
          modifiedLabel={input.copy.rightSource}
          comparisonLabel={input.copy.diffLabel}
          onUnavailable={() => setRuntimeUnavailable(true)}
        />
      </Suspense>
    </RevisionDiffErrorBoundary>
  );
}

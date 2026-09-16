import {
  Component,
  Suspense,
  lazy,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import type { MonacoDocumentType } from '../editor/monaco-runtime';
import { Button, Field, Notice, Spinner } from './primitives';

const LazyMonacoProposalDiff = lazy(async () => {
  const module = await import('./MonacoProposalDiff');
  return { default: module.MonacoProposalDiff };
});

class ProposalDiffErrorBoundary extends Component<{
  fallback: ReactNode;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The editable textarea fallback retains the complete proposal.
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function AiPostEditComparison(input: {
  original: string;
  modified: string;
  documentType: MonacoDocumentType;
  resetEpoch: number;
  copy: {
    comparisonLabel: string;
    originalLabel: string;
    modifiedLabel: string;
    loading: string;
    unavailable: string;
    retry: string;
  };
  onChange: (value: string) => void;
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
            {input.copy.retry}
          </Button>
        )}
      >
        {input.copy.unavailable}
      </Notice>
      <div className="content-revision-sources">
        <Field label={input.copy.originalLabel}>
          {(control) => (
            <textarea {...control} readOnly value={input.original} />
          )}
        </Field>
        <Field label={input.copy.modifiedLabel}>
          {(control) => (
            <textarea
              {...control}
              value={input.modified}
              onChange={(event) => input.onChange(event.target.value)}
            />
          )}
        </Field>
      </div>
    </div>
  );
  if (runtimeUnavailable) return fallback;
  return (
    <ProposalDiffErrorBoundary
      key={`${attempt}:${input.resetEpoch}`}
      fallback={fallback}
    >
      <Suspense fallback={(
        <div className="content-revision-diff-loading" role="status">
          <span className="content-revision-diff-loading-inner">
            <Spinner />
            {input.copy.loading}
          </span>
        </div>
      )}>
        <LazyMonacoProposalDiff
          original={input.original}
          initialModified={input.modified}
          documentType={input.documentType}
          originalLabel={input.copy.originalLabel}
          modifiedLabel={input.copy.modifiedLabel}
          comparisonLabel={input.copy.comparisonLabel}
          resetEpoch={input.resetEpoch}
          onChange={input.onChange}
          onUnavailable={() => setRuntimeUnavailable(true)}
        />
      </Suspense>
    </ProposalDiffErrorBoundary>
  );
}

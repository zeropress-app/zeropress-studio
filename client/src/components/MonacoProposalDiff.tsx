import { useEffect, useRef } from 'react';
import type { MonacoDocumentType } from '../editor/monaco-runtime';
import { createMonacoProposalDiff } from '../editor/monaco-proposal-diff';

export function MonacoProposalDiff(input: {
  original: string;
  initialModified: string;
  documentType: MonacoDocumentType;
  originalLabel: string;
  modifiedLabel: string;
  comparisonLabel: string;
  resetEpoch: number;
  onChange: (value: string) => void;
  onUnavailable: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialModifiedRef = useRef(input.initialModified);
  const onChangeRef = useRef(input.onChange);
  const onUnavailableRef = useRef(input.onUnavailable);
  initialModifiedRef.current = input.initialModified;
  onChangeRef.current = input.onChange;
  onUnavailableRef.current = input.onUnavailable;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    try {
      const handle = createMonacoProposalDiff({
        container,
        original: input.original,
        modified: initialModifiedRef.current,
        documentType: input.documentType,
        originalLabel: input.originalLabel,
        modifiedLabel: input.modifiedLabel,
        onChange: (value) => onChangeRef.current(value),
        onComputationUnavailable: () => onUnavailableRef.current(),
      });
      return () => handle.dispose();
    } catch {
      onUnavailableRef.current();
      return undefined;
    }
  }, [
    input.documentType,
    input.modifiedLabel,
    input.original,
    input.originalLabel,
    input.resetEpoch,
  ]);

  return (
    <div
      ref={containerRef}
      className="content-revision-diff-editor"
      role="region"
      aria-label={input.comparisonLabel}
    />
  );
}

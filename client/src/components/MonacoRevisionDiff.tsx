import { useEffect, useRef } from 'react';
import {
  createMonacoRevisionDiff,
  type RevisionDiffDocumentType,
} from '../editor/monaco-revision-diff';
import {
  prepareRevisionDiffPresentation,
  type RevisionDiffPresentationSource,
} from '../editor/revision-diff-presentation';

export function MonacoRevisionDiff(input: {
  original: string;
  modified: string;
  originalDocumentType: RevisionDiffDocumentType;
  modifiedDocumentType: RevisionDiffDocumentType;
  originalEditorMode: RevisionDiffPresentationSource['editorMode'];
  modifiedEditorMode: RevisionDiffPresentationSource['editorMode'];
  originalEditorProfile: RevisionDiffPresentationSource['editorProfile'];
  modifiedEditorProfile: RevisionDiffPresentationSource['editorProfile'];
  originalLabel: string;
  modifiedLabel: string;
  comparisonLabel: string;
  onUnavailable: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onUnavailableRef = useRef(input.onUnavailable);
  onUnavailableRef.current = input.onUnavailable;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    try {
      const presentation = prepareRevisionDiffPresentation({
        original: {
          content: input.original,
          documentType: input.originalDocumentType,
          editorMode: input.originalEditorMode,
          editorProfile: input.originalEditorProfile,
        },
        modified: {
          content: input.modified,
          documentType: input.modifiedDocumentType,
          editorMode: input.modifiedEditorMode,
          editorProfile: input.modifiedEditorProfile,
        },
      });
      const handle = createMonacoRevisionDiff({
        container,
        original: presentation.original,
        modified: presentation.modified,
        originalDocumentType: input.originalDocumentType,
        modifiedDocumentType: input.modifiedDocumentType,
        originalLabel: input.originalLabel,
        modifiedLabel: input.modifiedLabel,
        onComputationUnavailable: () => onUnavailableRef.current(),
      });
      return () => handle.dispose();
    } catch {
      onUnavailableRef.current();
      return undefined;
    }
  }, [
    input.modified,
    input.modifiedDocumentType,
    input.modifiedEditorMode,
    input.modifiedEditorProfile,
    input.modifiedLabel,
    input.original,
    input.originalDocumentType,
    input.originalEditorMode,
    input.originalEditorProfile,
    input.originalLabel,
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

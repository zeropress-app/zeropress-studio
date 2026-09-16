import { useRef } from 'react';
import {
  ContentSnapshotComparison,
  type ContentSnapshotComparisonCopy,
  type NormalizedContentSnapshot,
} from './ContentSnapshotComparison';
import {
  Button,
  Dialog,
  Notice,
} from './primitives';

/**
 * Compares the canonical editor snapshot with one already-loaded recovery
 * autosave. Opening and closing the dialog is deliberately read-only: restore
 * and discard remain explicit choices in the recovery notice.
 */
export function ContentAutosaveComparisonDialog(input: {
  title: string;
  description: string;
  closeLabel: string;
  staleDescription: string;
  isStale: boolean;
  savedLabel: string;
  autosaveLabel: string;
  comparisonKey: string;
  savedSnapshot: NormalizedContentSnapshot;
  autosaveSnapshot: NormalizedContentSnapshot;
  copy: ContentSnapshotComparisonCopy;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open
      size="wide"
      onClose={input.onClose}
      title={input.title}
      description={input.description}
      initialFocusRef={closeRef}
      actions={(
        <Button ref={closeRef} type="button" onClick={input.onClose}>
          {input.closeLabel}
        </Button>
      )}
    >
      <div className="content-revision-body">
        {input.isStale ? (
          <Notice tone="warning">{input.staleDescription}</Notice>
        ) : null}
        <ContentSnapshotComparison
          left={input.savedSnapshot}
          right={input.autosaveSnapshot}
          leftLabel={input.savedLabel}
          rightLabel={input.autosaveLabel}
          comparisonKey={input.comparisonKey}
          copy={input.copy}
        />
      </div>
    </Dialog>
  );
}

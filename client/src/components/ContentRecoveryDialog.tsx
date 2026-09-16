import { useRef } from 'react';
import {
  Button,
  Dialog,
  Notice,
} from './primitives';

type ContentRecoveryPromptProps = {
  title: string;
  description: string;
  staleDescription: string;
  isStale: boolean;
  updatedLabel: string;
  discardLabel: string;
  restoreLabel: string;
  compareLabel?: string;
  discardingLabel: string;
  busy: boolean;
  error: string | null;
  onDiscard: () => void;
  onRestore: () => void;
  onCompare?: () => void;
};

/**
 * Confirm recovery of an autosaved draft.
 *
 * Require either discarding or restoring the draft before closing. Keep busy enabled to prevent
 * Escape from bypassing that choice.
 */
export function ContentRecoveryDialog(input: ContentRecoveryPromptProps) {
  const restoreRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open
      // Require a discard or restore decision before closing.
      busy
      onClose={() => {}}
      title={input.title}
      description={input.description}
      initialFocusRef={restoreRef}
      actions={(
        <>
          {input.onCompare && input.compareLabel ? (
            <Button
              type="button"
              disabled={input.busy}
              onClick={input.onCompare}
            >
              {input.compareLabel}
            </Button>
          ) : null}
          <Button
            type="button"
            disabled={input.busy}
            onClick={input.onDiscard}
          >
            {input.busy ? input.discardingLabel : input.discardLabel}
          </Button>
          <Button
            ref={restoreRef}
            type="button"
            variant="primary"
            disabled={input.busy}
            onClick={input.onRestore}
          >
            {input.restoreLabel}
          </Button>
        </>
      )}
    >
      <div className="content-recovery-body">
        {input.isStale ? (
          <Notice tone="warning">{input.staleDescription}</Notice>
        ) : null}
        <p className="content-recovery-updated">{input.updatedLabel}</p>
        {input.error ? (
          <Notice tone="error">{input.error}</Notice>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * Existing content always opens from its canonical saved revision. A recovery
 * copy is presented as a deliberate, non-modal choice above the locked editor
 * so simply visiting the route cannot replace authored state.
 */
export function ContentRecoveryNotice(input: ContentRecoveryPromptProps) {
  return (
    <Notice
      tone={input.isStale ? 'warning' : 'info'}
      title={input.title}
      actions={(
        <>
          {input.onCompare && input.compareLabel ? (
            <Button
              type="button"
              disabled={input.busy}
              onClick={input.onCompare}
            >
              {input.compareLabel}
            </Button>
          ) : null}
          <Button
            type="button"
            disabled={input.busy}
            onClick={input.onDiscard}
          >
            {input.busy ? input.discardingLabel : input.discardLabel}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={input.busy}
            onClick={input.onRestore}
          >
            {input.restoreLabel}
          </Button>
        </>
      )}
    >
      <div className="content-recovery-inline">
        <p>{input.description}</p>
        {input.isStale ? (
          <p className="content-recovery-stale">{input.staleDescription}</p>
        ) : null}
        <p className="content-recovery-updated">{input.updatedLabel}</p>
        {input.error ? (
          <span className="content-recovery-error" role="alert">
            {input.error}
          </span>
        ) : null}
      </div>
    </Notice>
  );
}

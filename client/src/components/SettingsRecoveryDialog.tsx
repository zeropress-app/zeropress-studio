import { useRef } from 'react';
import {
  Button,
  Dialog,
  Notice,
} from './primitives';

export type SettingsRecoveryEntry = {
  field: string;
  value: string;
};

export function SettingsRecoveryDialog(input: {
  open: boolean;
  title: string;
  description: string;
  entries: readonly SettingsRecoveryEntry[];
  impact?: string;
  failure?: string | null;
  busy: boolean;
  cancelLabel: string;
  confirmLabel: string;
  busyLabel: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={input.open}
      onClose={input.onClose}
      busy={input.busy}
      title={input.title}
      description={input.description}
      initialFocusRef={cancelRef}
      actions={(
        <>
          <Button
            ref={cancelRef}
            type="button"
            disabled={input.busy}
            onClick={input.onClose}
          >
            {input.cancelLabel}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={input.busy}
            onClick={input.onConfirm}
          >
            {input.busy ? input.busyLabel : input.confirmLabel}
          </Button>
        </>
      )}
    >
      <div className="settings-dialog-body settings-stack">
        <dl className="settings-summary-list">
          {input.entries.map((entry) => (
            <div key={entry.field}>
              <dt>{entry.field}</dt>
              <dd>
                <code className="settings-recovery-value">{entry.value}</code>
              </dd>
            </div>
          ))}
        </dl>
        {input.impact ? (
          <Notice tone="warning">{input.impact}</Notice>
        ) : null}
        {input.failure ? (
          <Notice tone="error">{input.failure}</Notice>
        ) : null}
      </div>
    </Dialog>
  );
}

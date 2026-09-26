import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dialog } from '../components/primitives';

export function useDiscardChangesDialog(input: {
  open: boolean;
  dirty: boolean;
  busy: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('common');
  const [confirming, setConfirming] = useState(false);
  const keepEditingRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!input.open) setConfirming(false);
  }, [input.open]);

  function requestClose() {
    if (input.busy) return;
    if (input.dirty) setConfirming(true);
    else input.onClose();
  }

  const confirmation = (
    <Dialog
      open={input.open && confirming}
      onClose={() => setConfirming(false)}
      busy={input.busy}
      title={t('discardChanges.title')}
      description={t('discardChanges.description')}
      initialFocusRef={keepEditingRef}
      actions={<>
        <Button ref={keepEditingRef} type="button" disabled={input.busy}
          onClick={() => setConfirming(false)}>
          {t('discardChanges.keepEditing')}
        </Button>
        <Button type="button" variant="danger" disabled={input.busy}
          onClick={() => {
            if (input.busy) return;
            setConfirming(false);
            input.onClose();
          }}>
          {t('discardChanges.discard')}
        </Button>
      </>}
    />
  );

  return { requestClose, confirmation };
}

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';
import { Button, Dialog } from '../components/primitives';

export function OperationsActivityGuard({ active }: { active: boolean }) {
  const { t } = useTranslation('operations');
  const stayRef = useRef<HTMLButtonElement>(null);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (
    active
    && (
      currentLocation.pathname !== nextLocation.pathname
      || currentLocation.search !== nextLocation.search
      || currentLocation.hash !== nextLocation.hash
    )
  ));

  useEffect(() => {
    if (!active) return;
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [active]);

  useEffect(() => {
    if (active || blocker.state !== 'blocked') return;
    blocker.reset();
  }, [active, blocker]);

  const stay = () => {
    if (blocker.state === 'blocked') blocker.reset();
  };

  return (
    <Dialog
      open={blocker.state === 'blocked'}
      onClose={stay}
      kicker={t('activityGuard.kicker')}
      title={t('activityGuard.title')}
      description={t('activityGuard.description')}
      initialFocusRef={stayRef}
      actions={(
        <Button ref={stayRef} type="button" variant="primary" onClick={stay}>
          {t('activityGuard.stay')}
        </Button>
      )}
    />
  );
}

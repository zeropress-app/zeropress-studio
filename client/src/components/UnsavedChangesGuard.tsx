import {
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  UNSAFE_DataRouterContext,
  useBlocker,
  useNavigate,
} from 'react-router';
import {
  Button,
  Dialog,
  Notice,
} from './primitives';

type UnsavedChangesGuardProps = {
  active: boolean;
  onLeave?: () => boolean | Promise<boolean>;
  onDiscard?: () => boolean | Promise<boolean>;
  copy: {
    kicker: string;
    title: string;
    description: string;
    stay: string;
    leave: string;
    discard?: string;
    leaving?: string;
    leaveError?: string;
    discarding?: string;
    discardError?: string;
  };
};

function useBeforeUnloadWarning(active: boolean) {
  useEffect(() => {
    if (!active) return;
    function beforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [active]);
}

function GuardDialog(input: UnsavedChangesGuardProps & {
  open: boolean;
  onStay: () => void;
  onProceed: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [runningAction, setRunningAction] = useState<'leave' | 'discard' | null>(
    null,
  );
  const [failedAction, setFailedAction] = useState<'leave' | 'discard' | null>(
    null,
  );
  const busy = runningAction !== null;

  useEffect(() => {
    if (input.open) return;
    setRunningAction(null);
    setFailedAction(null);
  }, [input.open]);

  async function runAction(
    kind: 'leave' | 'discard',
    action: (() => boolean | Promise<boolean>) | undefined,
  ) {
    setRunningAction(kind);
    setFailedAction(null);
    let mayLeave = false;
    try {
      mayLeave = await (action?.() ?? true);
    } catch {
      mayLeave = false;
    }
    if (!mayLeave) {
      setRunningAction(null);
      setFailedAction(kind);
      return;
    }
    input.onProceed();
  }

  return (
    <Dialog
      open={input.open}
      onClose={input.onStay}
      busy={busy}
      kicker={input.copy.kicker}
      title={input.copy.title}
      description={input.copy.description}
      initialFocusRef={cancelRef}
      actions={(
        <>
          <Button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={input.onStay}
          >
            {input.copy.stay}
          </Button>
          {input.onDiscard && input.copy.discard ? (
            <Button
              type="button"
              variant="danger"
              disabled={busy}
              onClick={() => void runAction('discard', input.onDiscard)}
            >
              {runningAction === 'discard'
                ? input.copy.discarding ?? input.copy.discard
                : input.copy.discard}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => void runAction('leave', input.onLeave)}
          >
            {runningAction === 'leave'
              ? input.copy.leaving ?? input.copy.leave
              : input.copy.leave}
          </Button>
        </>
      )}
    >
      {failedAction ? (
        <div className="content-editor-dialog-notice">
          <Notice tone="error">
            {failedAction === 'discard'
              ? input.copy.discardError ?? input.copy.leaveError
              : input.copy.leaveError}
          </Notice>
        </div>
      ) : null}
    </Dialog>
  );
}

function DataRouterUnsavedChangesGuard(input: UnsavedChangesGuardProps) {
  useBeforeUnloadWarning(input.active);
  const blocker = useBlocker(input.active);

  return (
    <GuardDialog
      {...input}
      open={blocker.state === 'blocked'}
      onStay={() => {
        if (blocker.state === 'blocked') blocker.reset();
      }}
      onProceed={() => {
        if (blocker.state === 'blocked') blocker.proceed();
      }}
    />
  );
}

function LegacyUnsavedChangesGuard(input: UnsavedChangesGuardProps) {
  const navigate = useNavigate();
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(
    null,
  );
  useBeforeUnloadWarning(input.active);

  useEffect(() => {
    if (!input.active) {
      setPendingNavigation(null);
      return;
    }
    function interceptLink(event: MouseEvent) {
      if (
        event.defaultPrevented
        || event.button !== 0
        || event.metaKey
        || event.ctrlKey
        || event.shiftKey
        || event.altKey
        || !(event.target instanceof Element)
      ) return;
      const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
      if (
        !anchor
        || anchor.target && anchor.target !== '_self'
        || anchor.hasAttribute('download')
      ) return;
      const target = new URL(anchor.href, window.location.href);
      const current = new URL(window.location.href);
      if (
        target.origin !== current.origin
        || (
          target.pathname === current.pathname
          && target.search === current.search
        )
      ) return;
      event.preventDefault();
      event.stopPropagation();
      setPendingNavigation(
        `${target.pathname}${target.search}${target.hash}`,
      );
    }
    document.addEventListener('click', interceptLink, true);
    return () => document.removeEventListener('click', interceptLink, true);
  }, [input.active]);

  return (
    <GuardDialog
      {...input}
      open={pendingNavigation !== null}
      onStay={() => setPendingNavigation(null)}
      onProceed={() => {
        const target = pendingNavigation;
        setPendingNavigation(null);
        if (target !== null) navigate(target);
      }}
    />
  );
}

export function UnsavedChangesGuard(input: UnsavedChangesGuardProps) {
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  return dataRouter
    ? <DataRouterUnsavedChangesGuard {...input} />
    : <LegacyUnsavedChangesGuard {...input} />;
}

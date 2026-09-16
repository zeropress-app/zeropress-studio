import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export const INITIAL_CHECKING_REVEAL_DELAY_MS = 2_000;
export const INITIAL_CHECKING_MIN_VISIBLE_MS = 1_000;

export type InitialCheckingPhase = 'hidden' | 'checking' | 'resolved';

type InitialCheckingContextValue = {
  delayElapsed: boolean;
  checkingRevealed: boolean;
  minimumVisibleElapsed: boolean;
  revealChecking: (restartMinimum?: boolean) => void;
};

const immediateCheckingContext: InitialCheckingContextValue = {
  delayElapsed: true,
  checkingRevealed: false,
  minimumVisibleElapsed: true,
  revealChecking: () => undefined,
};

const InitialCheckingContext = createContext<InitialCheckingContextValue>(
  immediateCheckingContext,
);

/**
 * Share one visual waiting clock across the asynchronous stages of initial Studio entry. Requests
 * start immediately; this provider controls only when the waiting screen appears.
 */
export function InitialCheckingProvider(input: { children: ReactNode }) {
  const startedAt = useRef(Date.now());
  const checkingRevealedAt = useRef<number | null>(null);
  const minimumTimer = useRef<number | null>(null);
  const [delayElapsed, setDelayElapsed] = useState(false);
  const [checkingRevealed, setCheckingRevealed] = useState(false);
  const [minimumVisibleElapsed, setMinimumVisibleElapsed] = useState(false);

  useEffect(() => {
    const remaining = Math.max(
      0,
      INITIAL_CHECKING_REVEAL_DELAY_MS - (Date.now() - startedAt.current),
    );
    const timer = window.setTimeout(() => setDelayElapsed(true), remaining);
    return () => window.clearTimeout(timer);
  }, []);

  const revealChecking = useCallback((restartMinimum = false) => {
    if (!restartMinimum && checkingRevealedAt.current !== null) return;
    checkingRevealedAt.current = Date.now();
    setCheckingRevealed(true);
    if (minimumTimer.current !== null) return;
    setMinimumVisibleElapsed(false);
    minimumTimer.current = window.setTimeout(() => {
      minimumTimer.current = null;
      setMinimumVisibleElapsed(true);
    }, INITIAL_CHECKING_MIN_VISIBLE_MS);
  }, []);

  useEffect(() => () => {
    if (minimumTimer.current !== null) {
      window.clearTimeout(minimumTimer.current);
    }
  }, []);

  const value = useMemo<InitialCheckingContextValue>(() => ({
    delayElapsed,
    checkingRevealed,
    minimumVisibleElapsed,
    revealChecking,
  }), [
    checkingRevealed,
    delayElapsed,
    minimumVisibleElapsed,
    revealChecking,
  ]);

  return (
    <InitialCheckingContext.Provider value={value}>
      {input.children}
    </InitialCheckingContext.Provider>
  );
}

/**
 * Skip Checking if pending resolves within two seconds. Once shown, keep it visible for at least
 * 1,000ms. Use immediate for user-initiated rechecks.
 */
export function useInitialCheckingPhase(
  pending: boolean,
  immediate = false,
): InitialCheckingPhase {
  const context = useContext(InitialCheckingContext);
  const shouldReveal = pending && (immediate || context.delayElapsed);

  useLayoutEffect(() => {
    if (shouldReveal) context.revealChecking(immediate);
  }, [context.revealChecking, immediate, shouldReveal]);

  if (shouldReveal) return 'checking';
  if (pending && context.checkingRevealed) return 'checking';
  if (context.checkingRevealed && !context.minimumVisibleElapsed) {
    return 'checking';
  }
  return pending ? 'hidden' : 'resolved';
}

/** Keep only the pre-paint background visible while announcing progress to assistive technology. */
export function InitialCheckingPlaceholder(input: { label: string }) {
  return (
    <div className="auth-shell auth-shell-pending" aria-busy="true">
      <p
        className="visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {input.label}
      </p>
    </div>
  );
}

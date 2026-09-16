import { useEffect, useState } from 'react';
import type { PasswordBreachAssessment } from '../../../contracts/password-breach';
import { requestPasswordBreachCheck } from '../lib/password-breach-client';

const PASSWORD_BREACH_DEBOUNCE_MS = 350;

export type PasswordBreachCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | PasswordBreachAssessment;

export function passwordBreachAllowsSubmission(
  state: PasswordBreachCheckState,
): boolean {
  // The Worker repeats the authoritative check on the final mutation. A user
  // can continue while the advisory UI check is idle or in flight; only a
  // completed hit blocks the client action.
  return state.status !== 'hit';
}

export function usePasswordBreachCheck(input: {
  password: string;
  enabled: boolean;
}): PasswordBreachCheckState {
  const [state, setState] = useState<PasswordBreachCheckState>({
    status: 'idle',
  });

  useEffect(() => {
    if (!input.enabled) {
      setState({ status: 'idle' });
      return;
    }

    const controller = new AbortController();
    let active = true;
    setState({ status: 'checking' });
    const timeoutId = window.setTimeout(() => {
      void requestPasswordBreachCheck(input.password, controller.signal)
        .then((assessment) => {
          if (active) setState(assessment);
        })
        .catch(() => {
          if (active && !controller.signal.aborted) {
            setState({ status: 'unavailable', source: 'hibp' });
          }
        });
    }, PASSWORD_BREACH_DEBOUNCE_MS);

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [input.enabled, input.password]);

  return state;
}

import { useEffect } from 'react';

export type BusyChangeHandler = (active: boolean) => void;

/**
 * Reports only the caller-owned work state and always releases it on unmount.
 * The callback is optional so operation panels remain reusable outside the
 * routed Operations workspace.
 */
export function useBusyChange(
  onBusyChange: BusyChangeHandler | undefined,
  active: boolean,
) {
  useEffect(() => {
    onBusyChange?.(active);
    return () => onBusyChange?.(false);
  }, [active, onBusyChange]);
}

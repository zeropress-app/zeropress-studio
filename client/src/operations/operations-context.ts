import { useCallback, useEffect, useRef } from 'react';
import { useOutletContext } from 'react-router';
import type { DatabaseUpgradeStatus } from '../../../contracts/database-upgrade';
import type { OperationsStatusData } from '../../../contracts/operations';

export type OperationsOutletContext = {
  token: string;
  status: OperationsStatusData;
  operationalAccess: boolean;
  refreshDatabaseUpgradeStatus: () => Promise<DatabaseUpgradeStatus>;
  refreshStatus: () => Promise<void>;
  endOperationalSession: () => void;
  setActivity: (key: string, active: boolean) => void;
  beginActivity: (key: string) => () => void;
};

export function useOperationsContext(): OperationsOutletContext {
  return useOutletContext<OperationsOutletContext>();
}

export function useOperationsActivity(key: string) {
  const { beginActivity } = useOperationsContext();
  const releaseRef = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, [beginActivity, key]);

  return useCallback((active: boolean) => {
    if (active) {
      releaseRef.current ??= beginActivity(key);
      return;
    }
    releaseRef.current?.();
    releaseRef.current = null;
  }, [beginActivity, key]);
}

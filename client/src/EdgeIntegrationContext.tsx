import {
  createContext,
  useContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type { EdgeIntegrationMode } from '../../contracts/session';
import type { EdgeDatabaseRuntimeState } from '../../contracts/edge-runtime';

type EdgeIntegrationContextValue = {
  mode: EdgeIntegrationMode;
  databaseState: EdgeDatabaseRuntimeState;
  setMode: Dispatch<SetStateAction<EdgeIntegrationMode>>;
  setDatabaseState: Dispatch<SetStateAction<EdgeDatabaseRuntimeState>>;
};

const EdgeIntegrationContext = createContext<EdgeIntegrationContextValue>({
  // AuthenticatedApplication always replaces this value. The inert default
  // keeps isolated component previews and tests deterministic.
  mode: 'enabled',
  databaseState: 'ready',
  setMode: () => undefined,
  setDatabaseState: () => undefined,
});

export function EdgeIntegrationProvider(input: {
  value: EdgeIntegrationContextValue;
  children: ReactNode;
}) {
  return (
    <EdgeIntegrationContext.Provider value={input.value}>
      {input.children}
    </EdgeIntegrationContext.Provider>
  );
}

export function useEdgeIntegration(): EdgeIntegrationContextValue {
  return useContext(EdgeIntegrationContext);
}

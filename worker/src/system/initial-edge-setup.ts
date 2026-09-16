import type { EdgeDatabaseStatus } from '../../../contracts/edge-database-lifecycle';
import {
  inspectEdgeDatabaseLifecycle,
  installEdgeDatabase,
} from '../edge-database/lifecycle';

export type InitialEdgeSetupResult =
  | { status: 'installed' }
  | {
      status: 'skipped_nonempty';
      existingState: Exclude<
        EdgeDatabaseStatus['state'],
        'uninstalled' | 'unavailable'
      >;
    };

export class InitialEdgeSetupError extends Error {
  constructor(
    public readonly reason:
      | 'edge_db_binding_missing'
      | 'edge_kv_binding_missing'
      | 'database_unavailable'
      | 'install_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'InitialEdgeSetupError';
  }
}

export type PrepareInitialEdgeSetup = (
  input: {
    edgeDb?: D1Database;
    edgeKv?: KVNamespace;
  },
) => Promise<InitialEdgeSetupResult>;

/**
 * A fresh Studio may initialize only an application-empty Edge D1. Any
 * existing application catalog is preserved for explicit lifecycle review.
 */
export async function prepareInitialEdgeSetup(input: {
  edgeDb?: D1Database;
  edgeKv?: KVNamespace;
  inspect?: typeof inspectEdgeDatabaseLifecycle;
  install?: typeof installEdgeDatabase;
}): Promise<InitialEdgeSetupResult> {
  if (!input.edgeDb) {
    throw new InitialEdgeSetupError(
      'edge_db_binding_missing',
      'The EDGE_DB binding is unavailable during initial installation.',
    );
  }
  const edgeDb = input.edgeDb;
  const inspect = input.inspect ?? inspectEdgeDatabaseLifecycle;
  const install = input.install ?? installEdgeDatabase;
  let before: EdgeDatabaseStatus;
  try {
    before = await inspect({ edgeDb, siteMode: 'initial' });
  } catch (cause) {
    throw new InitialEdgeSetupError(
      'database_unavailable',
      'The Edge database cannot be inspected during initial installation.',
      { cause },
    );
  }

  if (before.state === 'unavailable') {
    throw new InitialEdgeSetupError(
      'database_unavailable',
      'The Edge database cannot be inspected during initial installation.',
    );
  }
  if (before.state !== 'uninstalled') {
    return {
      status: 'skipped_nonempty',
      existingState: before.state,
    };
  }
  if (!input.edgeKv) {
    throw new InitialEdgeSetupError(
      'edge_kv_binding_missing',
      'The EDGE_KV binding is unavailable during initial installation.',
    );
  }

  try {
    await install({ edgeDb });
    return { status: 'installed' };
  } catch (cause) {
    // D1 may have committed the atomic install batch even when its response
    // was lost. A canonical ready state is the successful retry boundary.
    try {
      const after = await inspect({ edgeDb, siteMode: 'initial' });
      if (after.state === 'ready') return { status: 'installed' };
    } catch {
      // Preserve the installation error as the primary operator diagnostic.
    }
    throw new InitialEdgeSetupError(
      'install_failed',
      'The Edge database did not converge to the ready state.',
      { cause },
    );
  }
}

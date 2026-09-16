import { StudioOperationalError } from '../lib/operational-error';
import type { Env } from '../types';

export function requireEdgeDatabase(env: Env): D1Database {
  if (!env.EDGE_DB) {
    throw new StudioOperationalError(
      'COMMENT_EDGE_DATABASE_NOT_CONFIGURED',
      {
        metadata: {
          component: 'worker_binding',
          resource: 'EDGE_DB',
          action: 'resolve_comment_edge_database',
        },
      },
    );
  }
  return env.EDGE_DB;
}

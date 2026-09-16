import type { Context } from 'hono';
import { errorResponse } from '../lib/http';
import { logStudioOperationalError } from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  inspectEdgeDatabaseRuntimeState,
} from '../edge-database/runtime-state';
import { edgeHealthFailure } from './edge-integration-health';
import { readEdgeIntegrationModeFailClosed } from './edge-services-repository';

export async function requireEdgeIntegrationReady(
  c: Context<StudioHonoEnvironment>,
  readMode: typeof readEdgeIntegrationModeFailClosed =
    readEdgeIntegrationModeFailClosed,
  inspectRuntime: typeof inspectEdgeDatabaseRuntimeState =
    inspectEdgeDatabaseRuntimeState,
): Promise<Response | null> {
  const mode = await readMode({ db: c.env.DB });
  if (mode !== 'enabled') {
    return errorResponse(c, 409, 'EDGE_INTEGRATION_DISABLED');
  }

  const runtime = await inspectRuntime({ edgeDb: c.env.EDGE_DB });
  if (runtime.state === 'ready') return null;
  if (runtime.state === 'upgrade_required') {
    return errorResponse(c, 409, 'EDGE_DATABASE_UPGRADE_REQUIRED');
  }
  if (runtime.state === 'recovery_required') {
    return errorResponse(c, 409, 'EDGE_DATABASE_RECOVERY_REQUIRED');
  }
  logStudioOperationalError(edgeHealthFailure({
    reason: runtime.reason === 'binding_missing'
      ? 'edge_db_binding_missing'
      : 'database_unavailable',
  }), {
    method: c.req.method,
    pathname: new URL(c.req.url).pathname,
  });
  return errorResponse(c, 503, 'EDGE_INTEGRATION_UNAVAILABLE');
}

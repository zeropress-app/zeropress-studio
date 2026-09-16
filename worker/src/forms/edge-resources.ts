import { StudioOperationalError } from '../lib/operational-error';
import type { Env } from '../types';

export function requireFormsEdgeDatabase(env: Env): D1Database {
  if (!env.EDGE_DB) {
    throw new StudioOperationalError('FORM_EDGE_DATABASE_NOT_CONFIGURED', {
      metadata: {
        component: 'worker_binding',
        resource: 'EDGE_DB',
        action: 'resolve_form_edge_database',
      },
    });
  }
  return env.EDGE_DB;
}

export function requireFormsEdgeKv(env: Env): KVNamespace {
  if (!env.EDGE_KV) {
    throw new StudioOperationalError('FORM_EDGE_CACHE_NOT_CONFIGURED', {
      metadata: {
        component: 'worker_binding',
        resource: 'EDGE_KV',
        action: 'resolve_form_edge_cache',
      },
    });
  }
  return env.EDGE_KV;
}

export async function invalidateFormInfoCache(input: {
  edgeKv: KVNamespace;
  slug: string;
}): Promise<void> {
  try {
    // This key must stay byte-for-byte aligned with ZeroPress Edge.
    await input.edgeKv.delete(`form-info:v2:${input.slug}`);
  } catch (error) {
    throw new StudioOperationalError('FORM_EDGE_CACHE_INVALIDATION_FAILED', {
      cause: error,
      metadata: {
        resource: 'EDGE_KV',
        action: 'invalidate_form_info',
      },
    });
  }
}

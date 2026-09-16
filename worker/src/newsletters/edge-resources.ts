import { StudioOperationalError } from '../lib/operational-error';
import type { Env } from '../types';

export function requireNewsletterEdgeDatabase(env: Env): D1Database {
  if (!env.EDGE_DB) {
    throw new StudioOperationalError('NEWSLETTER_EDGE_DATABASE_NOT_CONFIGURED', {
      metadata: {
        component: 'worker_binding',
        resource: 'EDGE_DB',
        action: 'resolve_newsletter_edge_database',
      },
    });
  }
  return env.EDGE_DB;
}

export function requireNewsletterEdgeKv(env: Env): KVNamespace {
  if (!env.EDGE_KV) {
    throw new StudioOperationalError('NEWSLETTER_EDGE_CACHE_NOT_CONFIGURED', {
      metadata: {
        component: 'worker_binding',
        resource: 'EDGE_KV',
        action: 'resolve_newsletter_edge_cache',
      },
    });
  }
  return env.EDGE_KV;
}

export async function invalidateNewsletterInfoCache(input: {
  edgeKv: KVNamespace;
  slug: string;
}): Promise<void> {
  try {
    await input.edgeKv.delete(`newsletter-info:v1:${input.slug}`);
  } catch (error) {
    throw new StudioOperationalError('NEWSLETTER_EDGE_CACHE_INVALIDATION_FAILED', {
      cause: error,
      metadata: {
        resource: 'EDGE_KV',
        action: 'invalidate_newsletter_info',
      },
    });
  }
}

import type { SystemStatusData } from '../../contracts/system';
import type { DetectedCloudflareAccess } from '../../contracts/cloudflare-access';
import type { SessionNetworkMetadata } from './auth/session-network-metadata';
import type { EdgeMailQueueMessage } from '../../contracts/edge-mail-queue';

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  AI?: Ai;
  EDGE_DB?: D1Database;
  EDGE_KV?: KVNamespace;
  MAIL_QUEUE?: Queue<EdgeMailQueueMessage>;
  MEDIA_BUCKET?: R2Bucket;
  KV: KVNamespace;
  AUTH_ROUTE_RATE_LIMITER: RateLimiter;
  AI_REQUEST_RATE_LIMITER?: RateLimiter;
  STUDIO_SITE_MODE?: string;
  STUDIO_INSTALL_TOKEN?: string;
  STUDIO_AUTH_SECRET?: string;
  STUDIO_OPERATIONS_ALLOWED_IPS?: string;
  STUDIO_OPERATIONS_TOKEN?: string;
}

export interface StudioVariables {
  systemStatus: SystemStatusData;
  sessionNetworkMetadata?: SessionNetworkMetadata;
  cloudflareAccessIdentity?: DetectedCloudflareAccess;
}

export type StudioHonoEnvironment = {
  Bindings: Env;
  Variables: StudioVariables;
};

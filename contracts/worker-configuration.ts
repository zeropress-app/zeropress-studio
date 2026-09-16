/**
 * Recommended storage types for Worker deployment settings.
 *
 * Cloudflare exposes both plaintext variables and secrets as env.NAME values,
 * so a running Worker cannot detect how a value was stored. This catalog is
 * ZeroPress's deployment contract for operators, not a runtime detection result.
 */
export type WorkerConfigurationKind =
  | 'plain_variable'
  | 'worker_secret';

export type DeploymentConfigurationKind =
  | WorkerConfigurationKind
  | 'resource_binding';

type WorkerConfigurationDefinition = {
  kind: WorkerConfigurationKind;
};

type ResourceBindingDefinition = {
  kind: 'resource_binding';
};

export const STUDIO_WORKER_CONFIGURATION_CATALOG = {
  STUDIO_SITE_MODE: { kind: 'plain_variable' },
  STUDIO_AUTH_SECRET: { kind: 'worker_secret' },
  STUDIO_INSTALL_TOKEN: { kind: 'worker_secret' },
  STUDIO_OPERATIONS_ALLOWED_IPS: { kind: 'plain_variable' },
  STUDIO_OPERATIONS_TOKEN: { kind: 'worker_secret' },
} as const satisfies Record<string, WorkerConfigurationDefinition>;

export type StudioWorkerConfigurationName =
  keyof typeof STUDIO_WORKER_CONFIGURATION_CATALOG;

export const STUDIO_RESOURCE_BINDING_CATALOG = {
  DB: { kind: 'resource_binding' },
  AI: { kind: 'resource_binding' },
  EDGE_DB: { kind: 'resource_binding' },
  EDGE_KV: { kind: 'resource_binding' },
  MEDIA_BUCKET: { kind: 'resource_binding' },
  KV: { kind: 'resource_binding' },
  AUTH_ROUTE_RATE_LIMITER: { kind: 'resource_binding' },
  AI_REQUEST_RATE_LIMITER: { kind: 'resource_binding' },
} as const satisfies Record<string, ResourceBindingDefinition>;

export type StudioResourceBindingName =
  keyof typeof STUDIO_RESOURCE_BINDING_CATALOG;

/** Configuration contract for the separately deployed public ZeroPress Edge Worker. */
export const EDGE_WORKER_CONFIGURATION_CATALOG = {
  EDGE_MAINTENANCE_MODE: { kind: 'plain_variable' },
  COMMENTS_ENABLED: { kind: 'plain_variable' },
  FORMS_ENABLED: { kind: 'plain_variable' },
  NEWSLETTER_ENABLED: { kind: 'plain_variable' },
  TURNSTILE_SECRET_KEY: { kind: 'worker_secret' },
} as const satisfies Record<string, WorkerConfigurationDefinition>;

export type EdgeWorkerConfigurationName =
  keyof typeof EDGE_WORKER_CONFIGURATION_CATALOG;

import { z } from 'zod';
import { STUDIO_WORKER_SECRET_STATES } from './worker-secret';

export const studioSiteModeSchema = z.enum([
  'initial',
  'operational',
  'maintenance',
  'recovery',
]);

const schemaVersion = z.number().int().nonnegative();
const targetSchemaVersion = z.number().int().positive();

export const databaseStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('uninstalled'),
    target_schema_version: targetSchemaVersion,
  }).strict(),
  z.object({
    state: z.literal('ready'),
    schema_version: schemaVersion,
    target_schema_version: targetSchemaVersion,
  }).strict(),
  z.object({
    state: z.literal('upgrade_required'),
    schema_version: schemaVersion,
    target_schema_version: targetSchemaVersion,
  }).strict(),
  z.object({
    state: z.literal('update_in_progress'),
    schema_version: schemaVersion,
    target_schema_version: targetSchemaVersion,
  }).strict(),
  z.object({
    state: z.literal('recovery_required'),
    schema_version: schemaVersion.nullable(),
    target_schema_version: targetSchemaVersion,
  }).strict(),
  z.object({
    state: z.literal('newer_than_code'),
    schema_version: schemaVersion,
    target_schema_version: targetSchemaVersion,
  }).strict(),
  z.object({
    state: z.literal('unsupported'),
    schema_version: schemaVersion,
    target_schema_version: targetSchemaVersion,
  }).strict(),
  z.object({
    state: z.literal('unmanaged'),
  }).strict(),
  z.object({
    state: z.literal('unavailable'),
  }).strict(),
]);

export const systemBlockedReasonSchema = z.enum([
  'SITE_MODE_MISSING',
  'SITE_MODE_INVALID',
  'INSTALL_TOKEN_NOT_CONFIGURED',
  'INSTALL_TOKEN_STILL_CONFIGURED',
  'AUTH_SECRET_NOT_CONFIGURED',
  'DATABASE_UNINSTALLED',
  'DATABASE_UNMANAGED',
  'DATABASE_UNAVAILABLE',
  'DATABASE_SCHEMA_STATE_INVALID',
  'DATABASE_UPGRADE_REQUIRED',
  'DATABASE_NEWER_THAN_CODE',
  'DATABASE_UNSUPPORTED',
]);

export const systemAccessSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('installation'),
  }).strict(),
  z.object({
    state: z.literal('activation_required'),
  }).strict(),
  z.object({
    state: z.literal('operational'),
  }).strict(),
  z.object({
    state: z.literal('maintenance'),
  }).strict(),
  z.object({
    state: z.literal('recovery'),
  }).strict(),
  z.object({
    state: z.literal('blocked'),
    reason: systemBlockedReasonSchema,
  }).strict(),
]);

export const installationConfigurationSchema = z.object({
  site_mode: z.literal('initial'),
  auth_secret: z.enum(STUDIO_WORKER_SECRET_STATES),
  install_token: z.enum(STUDIO_WORKER_SECRET_STATES),
}).strict();

export const systemStatusDataSchema = z.object({
  // Older Worker deployments may not report their package version.
  studio_version: z.string().trim().min(1).optional(),
  site_mode: studioSiteModeSchema.nullable(),
  database: databaseStatusSchema,
  access: systemAccessSchema,
  installation_configuration: installationConfigurationSchema.nullable(),
}).strict();

// Request-scoped discovery only. "available" does not authenticate a token or
// grant a Studio session; protected Operations requests recheck every boundary.
// In operational mode, setup details require an active administrator session.
export const operationsSetupConfigurationSchema = z.discriminatedUnion('allowed_ips', [
  z.object({
    allowed_ips: z.enum(['missing', 'invalid']),
    token: z.enum(STUDIO_WORKER_SECRET_STATES),
    // Only the requesting connection, never the configured allowlist.
    client_ip: z.union([z.ipv4(), z.ipv6()]).nullable(),
  }).strict(),
  z.object({
    allowed_ips: z.literal('valid'),
    token: z.enum(['missing', 'invalid']),
  }).strict(),
]);

export const operationsEntrySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('available') }).strict(),
  z.object({ state: z.literal('not_found') }).strict(),
  z.object({
    state: z.literal('setup_required'),
    configuration: operationsSetupConfigurationSchema,
  }).strict(),
]);

export const systemStatusResponseSchema = z.object({
  success: z.literal(true),
  data: systemStatusDataSchema.extend({ operations: operationsEntrySchema }),
}).strict();

export type StudioSiteMode = z.infer<typeof studioSiteModeSchema>;
export type DatabaseStatus = z.infer<typeof databaseStatusSchema>;
export type SystemBlockedReason = z.infer<typeof systemBlockedReasonSchema>;
export type SystemAccess = z.infer<typeof systemAccessSchema>;
export type InstallationConfiguration = z.infer<
  typeof installationConfigurationSchema
>;
export type SystemStatusData = z.infer<typeof systemStatusDataSchema>;
export type OperationsSetupConfiguration = z.infer<
  typeof operationsSetupConfigurationSchema
>;
export type SystemStatusResponse = z.infer<typeof systemStatusResponseSchema>;

import { z } from 'zod';
import { apiErrorSchema } from './api';
import { edgeIntegrationModeSchema } from './session';
import { settingsRevisionSchema } from './settings-revision';

export const edgeIntegrationSettingsSchema = z.object({
  mode: edgeIntegrationModeSchema,
}).strict();

export const edgeIntegrationEffectiveStateSchema = z.enum([
  'disabled',
  'ready',
  'projection_pending',
  'reconciliation_required',
  'unavailable',
]);

export const edgeIntegrationUnavailableReasonSchema = z.enum([
  'edge_db_binding_missing',
  'edge_kv_binding_missing',
  'database_unavailable',
  'schema_incomplete',
  'seed_incomplete',
  'target_mismatch',
  'database_uninstalled',
  'database_adoption_required',
  'database_upgrade_required',
  'database_recovery_required',
  'database_unmanaged',
  'database_newer_than_code',
]);

const pendingCountSchema = z.number().int().nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const edgeServicesDocumentSchema = z.object({
  settings: edgeIntegrationSettingsSchema,
  effective_state: edgeIntegrationEffectiveStateSchema,
  pending_target_events: pendingCountSchema,
  unavailable_reason: edgeIntegrationUnavailableReasonSchema.optional(),
  revision: settingsRevisionSchema,
  updated_at_iso: z.iso.datetime({ offset: true }),
}).strict();

export const edgeServicesSuccessSchema = z.object({
  success: z.literal(true),
  data: edgeServicesDocumentSchema,
}).strict();

export const edgeServicesResponseSchema = z.union([
  edgeServicesSuccessSchema,
  apiErrorSchema,
]);

export const updateEdgeServicesRequestSchema = z.object({
  settings: edgeIntegrationSettingsSchema,
  expected_revision: settingsRevisionSchema,
}).strict();

export const drainEdgeProjectionsRequestSchema = z.object({}).strict();

export const drainEdgeProjectionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    processed_events: pendingCountSchema,
    remaining_events: pendingCountSchema,
  }).strict(),
}).strict();

export const drainEdgeProjectionsResponseSchema = z.union([
  drainEdgeProjectionsSuccessSchema,
  apiErrorSchema,
]);

export type EdgeIntegrationSettings = z.infer<
  typeof edgeIntegrationSettingsSchema
>;
export type EdgeServicesDocument = z.infer<
  typeof edgeServicesDocumentSchema
>;
export type EdgeIntegrationUnavailableReason = z.infer<
  typeof edgeIntegrationUnavailableReasonSchema
>;

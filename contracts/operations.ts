import { z } from 'zod';
import { apiErrorSchema } from './api';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './password-policy';
import {
  mfaEnrollmentProofSchema,
  mfaEnrollmentSetupResponseSchema,
} from './mfa';
import { databaseStatusSchema, studioSiteModeSchema } from './system';
import { databaseTransferAvailabilitySchema } from './database-backup';
import { databaseUpgradeStatusSchema } from './database-upgrade';
import { STUDIO_WORKER_SECRET_STATES } from './worker-secret';
import { edgeIntegrationModeSchema } from './session';
import { edgeDatabaseStatusSchema } from './edge-database-lifecycle';
import {
  edgeServicesDocumentSchema,
} from './edge-services';
import { settingsRevisionSchema } from './settings-revision';
import {
  edgeTargetReconciliationStatusSchema,
} from './edge-target-reconciliation';
import { contentSearchIndexStatusSchema } from './content-search-index';
import { cloudflareAccessRecoveryStatusSchema } from './cloudflare-access';

const operationsSecretEnvironmentStateSchema = z.enum([
  ...STUDIO_WORKER_SECRET_STATES,
  'must_be_removed',
]);

export const operationsActionSchema = z.enum([
  'clear_site_content',
  'reset_studio',
  'uninstall_studio',
]);

export const operationsConfirmation = {
  clear_site_content: 'CLEAR SITE CONTENT',
  reset_studio: 'RESET STUDIO',
  uninstall_studio: 'UNINSTALL STUDIO',
} as const satisfies Record<
  z.infer<typeof operationsActionSchema>,
  string
>;

export const administratorRecoveryConfirmation =
  'RECOVER ADMINISTRATOR';

export const administratorRecoveryBootstrapConfirmation =
  'CREATE RECOVERY ADMINISTRATOR';

export const operationsEdgeIntegrationConfirmation = {
  enabled: 'ENABLE EDGE INTEGRATION',
  disabled: 'DISABLE EDGE INTEGRATION',
} as const;

const plainEnvironmentEntrySchema = z.object({
  name: z.enum([
    'STUDIO_SITE_MODE',
    'STUDIO_OPERATIONS_ALLOWED_IPS',
  ]),
  exposure: z.literal('value'),
  expected_storage: z.literal('plain_variable'),
  configured: z.boolean(),
  value: z.string().nullable(),
}).strict();

const secretEnvironmentEntrySchema = z.object({
  name: z.enum([
    'STUDIO_INSTALL_TOKEN',
    'STUDIO_OPERATIONS_TOKEN',
    'STUDIO_AUTH_SECRET',
  ]),
  exposure: z.literal('presence'),
  expected_storage: z.literal('worker_secret'),
  state: operationsSecretEnvironmentStateSchema,
}).strict();

export const operationsEnvironmentEntrySchema = z.discriminatedUnion(
  'exposure',
  [
    plainEnvironmentEntrySchema,
    secretEnvironmentEntrySchema,
  ],
);

const operationAvailabilitySchema = z.object({
  available: z.boolean(),
  requires_maintenance: z.boolean(),
  confirmation: z.string(),
}).strict();

export const operationsStatusDataSchema = z.object({
  site_mode: studioSiteModeSchema.nullable(),
  database: databaseStatusSchema,
  current_ip: z.string(),
  allowed_ips: z.array(z.string()),
  environment: z.array(operationsEnvironmentEntrySchema),
  bindings: z.object({
    DB: z.object({ bound: z.literal(true) }).strict(),
    EDGE_DB: z.object({ bound: z.boolean() }).strict(),
    EDGE_KV: z.object({ bound: z.boolean() }).strict(),
    MEDIA_BUCKET: z.object({ bound: z.boolean() }).strict(),
    KV: z.object({ bound: z.literal(true) }).strict(),
    AUTH_ROUTE_RATE_LIMITER: z.object({ bound: z.literal(true) }).strict(),
  }).strict(),
  actions: z.object({
    clear_site_content: operationAvailabilitySchema,
    reset_studio: operationAvailabilitySchema,
    uninstall_studio: operationAvailabilitySchema,
    recover_administrator: operationAvailabilitySchema,
  }).strict(),
  database_transfer: databaseTransferAvailabilitySchema,
  database_upgrade: databaseUpgradeStatusSchema,
  edge_integration: z.object({
    mode: edgeIntegrationModeSchema,
    document: edgeServicesDocumentSchema.nullable(),
    change_available: z.boolean(),
  }).strict(),
  edge_database: edgeDatabaseStatusSchema,
  edge_target_reconciliation: edgeTargetReconciliationStatusSchema,
  content_search_index: contentSearchIndexStatusSchema,
  cloudflare_access: cloudflareAccessRecoveryStatusSchema,
}).strict();

export const operationsStatusSuccessSchema = z.object({
  success: z.literal(true),
  data: operationsStatusDataSchema,
}).strict();

export const operationsStatusResponseSchema = z.union([
  operationsStatusSuccessSchema,
  apiErrorSchema,
]);

export const operationsRequestSchema = z.object({
  administrator_email: z.string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(254)),
  administrator_password: z.string().min(1).max(1024),
  confirmation: z.string().max(128),
}).strict();

const rowsByTableSchema = z.record(
  z.string(),
  z.number().int().nonnegative(),
);

export const operationsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: operationsActionSchema,
    status: z.literal('completed'),
    effects: z.object({
      deleted_rows: rowsByTableSchema,
      inserted_rows: rowsByTableSchema,
      updated_rows: rowsByTableSchema,
    }).strict(),
    resources: z.object({
      studio: z.literal('completed'),
      edge: z.enum(['completed', 'skipped_disabled', 'not_applicable']),
    }).strict(),
  }).strict(),
}).strict();

export const operationsResponseSchema = z.union([
  operationsSuccessSchema,
  apiErrorSchema,
]);

const operationsEdgeIntegrationCredentialsShape = {
  administrator_email: z.string().trim().toLowerCase()
    .pipe(z.email().max(254)),
  administrator_password: z.string().min(1).max(1024),
  expected_revision: settingsRevisionSchema,
};

export const operationsEdgeIntegrationUpdateRequestSchema =
  z.discriminatedUnion('mode', [
    z.object({
      ...operationsEdgeIntegrationCredentialsShape,
      mode: z.literal('enabled'),
      confirmation: z.literal(
        operationsEdgeIntegrationConfirmation.enabled,
      ),
    }).strict(),
    z.object({
      ...operationsEdgeIntegrationCredentialsShape,
      mode: z.literal('disabled'),
      confirmation: z.literal(
        operationsEdgeIntegrationConfirmation.disabled,
      ),
    }).strict(),
  ]);

export const operationsEdgeIntegrationUpdateSuccessSchema = z.object({
  success: z.literal(true),
  data: edgeServicesDocumentSchema,
}).strict();

export const operationsEdgeIntegrationUpdateResponseSchema = z.union([
  operationsEdgeIntegrationUpdateSuccessSchema,
  apiErrorSchema,
]);

export const uninstallPreviewSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('uninstall_studio'),
    expected_effects: z.object({
      deleted_rows: rowsByTableSchema,
    }).strict(),
  }).strict(),
}).strict();

export const uninstallPreviewResponseSchema = z.union([
  uninstallPreviewSuccessSchema,
  apiErrorSchema,
]);

export const recoverableAdministratorSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/u),
  email: z.email().max(254),
  name: z.string().min(2).max(100),
  status: z.enum(['active', 'inactive', 'pending']),
  mfa_configured: z.boolean(),
}).strict();

export const administratorRecoveryModeSchema = z.enum([
  'existing_administrator',
  'bootstrap_administrator',
]);

export const administratorRecoveryStatusSuccessSchema = z.object({
  success: z.literal(true),
  data: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('existing_administrator'),
      administrators: z.array(recoverableAdministratorSchema).min(1),
      confirmation: z.literal(administratorRecoveryConfirmation),
    }).strict(),
    z.object({
      mode: z.literal('bootstrap_administrator'),
      administrators: z.tuple([]),
      confirmation: z.literal(administratorRecoveryBootstrapConfirmation),
    }).strict(),
  ]),
}).strict();

export const administratorRecoveryStatusResponseSchema = z.union([
  administratorRecoveryStatusSuccessSchema,
  apiErrorSchema,
]);

export const administratorRecoveryRequestSchema = z.object({
  administrator_id: z.string().regex(/^[0-9a-f]{32}$/u),
  new_password: z.string()
    .min(PASSWORD_MIN_LENGTH)
    .max(PASSWORD_MAX_LENGTH),
  reset_mfa: z.boolean(),
  confirmation: z.literal(administratorRecoveryConfirmation),
}).strict();

export const administratorRecoverySuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('recover_administrator'),
    status: z.literal('completed'),
    mfa_reset: z.boolean(),
  }).strict(),
}).strict();

export const administratorRecoveryResponseSchema = z.union([
  administratorRecoverySuccessSchema,
  apiErrorSchema,
]);

export const administratorRecoveryBootstrapMfaSetupRequestSchema = z.object({
  administrator_email: z.string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(254)),
}).strict();

export const administratorRecoveryBootstrapMfaSetupResponseSchema =
  mfaEnrollmentSetupResponseSchema;

export const administratorRecoveryBootstrapRequestSchema = z.object({
  administrator_name: z.string().trim().min(2).max(100),
  administrator_email: z.string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(254)),
  new_password: z.string()
    .min(PASSWORD_MIN_LENGTH)
    .max(PASSWORD_MAX_LENGTH),
  backup_acknowledged: z.literal(true),
  mfa: mfaEnrollmentProofSchema,
  confirmation: z.literal(administratorRecoveryBootstrapConfirmation),
}).strict();

export const administratorRecoveryBootstrapSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('bootstrap_recovery_administrator'),
    status: z.literal('completed'),
    mfa_enrolled: z.literal(true),
  }).strict(),
}).strict();

export const administratorRecoveryBootstrapResponseSchema = z.union([
  administratorRecoveryBootstrapSuccessSchema,
  apiErrorSchema,
]);

export type OperationsAction = z.infer<typeof operationsActionSchema>;
export type OperationsEnvironmentEntry = z.infer<
  typeof operationsEnvironmentEntrySchema
>;
export type OperationsStatusData = z.infer<typeof operationsStatusDataSchema>;
export type OperationsStatusResponse = z.infer<
  typeof operationsStatusResponseSchema
>;
export type OperationsRequest = z.infer<typeof operationsRequestSchema>;
export type OperationsSuccess = z.infer<typeof operationsSuccessSchema>;
export type OperationsResponse = z.infer<typeof operationsResponseSchema>;
export type OperationsEdgeIntegrationUpdateRequest = z.infer<
  typeof operationsEdgeIntegrationUpdateRequestSchema
>;
export type OperationsEdgeIntegrationUpdateResponse = z.infer<
  typeof operationsEdgeIntegrationUpdateResponseSchema
>;
export type UninstallPreviewSuccess = z.infer<
  typeof uninstallPreviewSuccessSchema
>;
export type UninstallPreviewResponse = z.infer<
  typeof uninstallPreviewResponseSchema
>;
export type RecoverableAdministrator = z.infer<
  typeof recoverableAdministratorSchema
>;
export type AdministratorRecoveryMode = z.infer<
  typeof administratorRecoveryModeSchema
>;
export type AdministratorRecoveryStatusSuccess = z.infer<
  typeof administratorRecoveryStatusSuccessSchema
>;
export type AdministratorRecoveryStatusResponse = z.infer<
  typeof administratorRecoveryStatusResponseSchema
>;
export type AdministratorRecoveryRequest = z.infer<
  typeof administratorRecoveryRequestSchema
>;
export type AdministratorRecoverySuccess = z.infer<
  typeof administratorRecoverySuccessSchema
>;
export type AdministratorRecoveryResponse = z.infer<
  typeof administratorRecoveryResponseSchema
>;
export type AdministratorRecoveryBootstrapMfaSetupRequest = z.infer<
  typeof administratorRecoveryBootstrapMfaSetupRequestSchema
>;
export type AdministratorRecoveryBootstrapMfaSetupResponse = z.infer<
  typeof administratorRecoveryBootstrapMfaSetupResponseSchema
>;
export type AdministratorRecoveryBootstrapRequest = z.infer<
  typeof administratorRecoveryBootstrapRequestSchema
>;
export type AdministratorRecoveryBootstrapSuccess = z.infer<
  typeof administratorRecoveryBootstrapSuccessSchema
>;
export type AdministratorRecoveryBootstrapResponse = z.infer<
  typeof administratorRecoveryBootstrapResponseSchema
>;

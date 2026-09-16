import { z } from 'zod';
import { apiErrorSchema } from './api';
import { databaseUpgradeStepSchema } from './database-upgrade';

export const EDGE_DATABASE_SCHEMA_VERSION = 1;
export const EDGE_DATABASE_INSTALL_CONFIRMATION = 'INSTALL EDGE DATABASE';
export const EDGE_DATABASE_ADOPT_CONFIRMATION = 'ADOPT EDGE DATABASE';
export const EDGE_DATABASE_UPGRADE_CONFIRMATION = 'UPGRADE EDGE DATABASE';
export const EDGE_DATABASE_UNINSTALL_CONFIRMATION =
  'UNINSTALL EDGE DATABASE';

const schemaVersionSchema = z.number().int().positive();
const operationIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);

export const edgeDatabaseStateSchema = z.enum([
  'uninstalled',
  'adoption_required',
  'ready',
  'upgrade_required',
  'in_progress',
  'recovery_required',
  'unmanaged',
  'newer_than_code',
  'unavailable',
]);

export const edgeDatabaseStatusSchema = z.object({
  state: edgeDatabaseStateSchema,
  current_schema_version: schemaVersionSchema.nullable(),
  target_schema_version: z.literal(EDGE_DATABASE_SCHEMA_VERSION),
  operation_id: operationIdSchema.nullable(),
  next_upgrade_steps: z.array(databaseUpgradeStepSchema),
  install_available: z.boolean(),
  adopt_available: z.boolean(),
  upgrade_available: z.boolean(),
}).strict();

const administratorCredentialsShape = {
  administrator_email: z.string().trim().toLowerCase()
    .pipe(z.email().max(254)),
  administrator_password: z.string().min(1).max(1024),
};

export const edgeDatabaseInstallRequestSchema = z.object({
  ...administratorCredentialsShape,
  empty_database_acknowledged: z.literal(true),
  public_edge_writes_disabled: z.literal(true),
  confirmation: z.literal(EDGE_DATABASE_INSTALL_CONFIRMATION),
}).strict();

export const edgeDatabaseAdoptRequestSchema = z.object({
  ...administratorCredentialsShape,
  backup_acknowledged: z.literal(true),
  public_edge_writes_disabled: z.literal(true),
  confirmation: z.literal(EDGE_DATABASE_ADOPT_CONFIRMATION),
}).strict();

export const edgeDatabaseUpgradeStartRequestSchema = z.object({
  ...administratorCredentialsShape,
  backup_acknowledged: z.literal(true),
  public_edge_writes_disabled: z.literal(true),
  confirmation: z.literal(EDGE_DATABASE_UPGRADE_CONFIRMATION),
}).strict();

export const edgeDatabaseUpgradeStepRequestSchema = z.object({
  operation_id: operationIdSchema,
  step_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/u),
  confirmation: z.literal(EDGE_DATABASE_UPGRADE_CONFIRMATION),
}).strict();

export const edgeDatabaseUninstallRequestSchema = z.object({
  ...administratorCredentialsShape,
  backup_acknowledged: z.literal(true),
  public_edge_writes_disabled: z.literal(true),
  pending_mail_acknowledged: z.literal(true),
  confirmation: z.literal(EDGE_DATABASE_UNINSTALL_CONFIRMATION),
}).strict();

const edgeDatabaseDeletedRowsSchema = z.record(
  z.string().regex(/^EDGE_DB\.[a-z][a-z0-9_]*$/u),
  z.number().int().nonnegative(),
);

export const edgeDatabaseUninstallPreviewSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('uninstall_edge_database'),
    expected_effects: z.object({
      deleted_rows: edgeDatabaseDeletedRowsSchema,
    }).strict(),
  }).strict(),
}).strict();

export const edgeDatabaseUninstallPreviewResponseSchema = z.union([
  edgeDatabaseUninstallPreviewSuccessSchema,
  apiErrorSchema,
]);

export const edgeDatabaseUninstallSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('uninstall_edge_database'),
    status: z.literal('completed'),
    effects: z.object({
      deleted_rows: edgeDatabaseDeletedRowsSchema,
    }).strict(),
  }).strict(),
}).strict();

export const edgeDatabaseUninstallResponseSchema = z.union([
  edgeDatabaseUninstallSuccessSchema,
  apiErrorSchema,
]);

export const edgeDatabaseMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.enum([
      'install_edge_database',
      'adopt_edge_database',
      'upgrade_edge_database',
    ]),
    status: z.enum(['completed', 'started', 'in_progress']),
    operation_id: operationIdSchema.nullable(),
    current_schema_version: schemaVersionSchema,
    target_schema_version: z.literal(EDGE_DATABASE_SCHEMA_VERSION),
    next_step: databaseUpgradeStepSchema.nullable(),
  }).strict(),
}).strict();

export const edgeDatabaseMutationResponseSchema = z.union([
  edgeDatabaseMutationSuccessSchema,
  apiErrorSchema,
]);

export type EdgeDatabaseStatus = z.infer<typeof edgeDatabaseStatusSchema>;
export type EdgeDatabaseInstallRequest = z.infer<
  typeof edgeDatabaseInstallRequestSchema
>;
export type EdgeDatabaseAdoptRequest = z.infer<
  typeof edgeDatabaseAdoptRequestSchema
>;
export type EdgeDatabaseUpgradeStartRequest = z.infer<
  typeof edgeDatabaseUpgradeStartRequestSchema
>;
export type EdgeDatabaseUpgradeStepRequest = z.infer<
  typeof edgeDatabaseUpgradeStepRequestSchema
>;
export type EdgeDatabaseUninstallRequest = z.infer<
  typeof edgeDatabaseUninstallRequestSchema
>;
export type EdgeDatabaseUninstallPreviewResponse = z.infer<
  typeof edgeDatabaseUninstallPreviewResponseSchema
>;
export type EdgeDatabaseUninstallResponse = z.infer<
  typeof edgeDatabaseUninstallResponseSchema
>;
export type EdgeDatabaseMutationResponse = z.infer<
  typeof edgeDatabaseMutationResponseSchema
>;

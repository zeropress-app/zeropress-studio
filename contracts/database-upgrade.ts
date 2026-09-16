import { z } from 'zod';
import { apiErrorSchema } from './api';

export const DATABASE_UPGRADE_CONFIRMATION =
  'UPGRADE STUDIO DATABASE';
export const DATABASE_UPGRADE_MAX_BATCH_STATEMENTS = 900;
export const DATABASE_UPGRADE_MAX_ARTIFACT_STATEMENTS = 892;
export const DATABASE_UPGRADE_MAX_STATEMENT_BYTES = 100_000;

const schemaVersionSchema = z.number().int().positive();
const observedSchemaVersionSchema = z.number().int().nonnegative();
const operationIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const upgradeStepIdSchema = z.string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,127}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const databaseUpgradeStepSchema = z.object({
  id: upgradeStepIdSchema,
  from_version: schemaVersionSchema,
  to_version: schemaVersionSchema,
  sha256: sha256Schema,
  statement_count: z.number().int().positive()
    .max(DATABASE_UPGRADE_MAX_ARTIFACT_STATEMENTS),
}).strict().refine(
  (value) => value.to_version === value.from_version + 1,
  { message: 'Schema upgrade steps must advance exactly one version.' },
);

const upgradeStatusBase = {
  target_schema_version: schemaVersionSchema,
  confirmation: z.literal(DATABASE_UPGRADE_CONFIRMATION),
};

const upToDateStatusSchema = z.object({
  state: z.literal('up_to_date'),
  current_schema_version: schemaVersionSchema,
  ...upgradeStatusBase,
  available: z.literal(false),
  operation_id: z.null(),
  steps: z.tuple([]),
}).strict().refine(
  (value) => value.current_schema_version === value.target_schema_version,
  { message: 'An up-to-date schema must equal the target version.' },
);

const upgradeRequiredStatusSchema = z.object({
  state: z.literal('upgrade_required'),
  current_schema_version: schemaVersionSchema,
  ...upgradeStatusBase,
  available: z.boolean(),
  operation_id: z.null(),
  steps: z.array(databaseUpgradeStepSchema).min(1),
}).strict();

const upgradeInProgressStatusSchema = z.object({
  state: z.literal('in_progress'),
  current_schema_version: schemaVersionSchema,
  ...upgradeStatusBase,
  available: z.boolean(),
  operation_id: operationIdSchema,
  steps: z.array(databaseUpgradeStepSchema).min(1),
}).strict();

export const databaseUpgradeUnavailableReasonSchema = z.enum([
  'site_mode',
  'database_uninstalled',
  'database_unmanaged',
  'database_unavailable',
  'recovery_required',
  'newer_than_code',
  'unsupported',
  'artifact_chain_invalid',
]);

const upgradeUnavailableStatusSchema = z.object({
  state: z.literal('unavailable'),
  current_schema_version: observedSchemaVersionSchema.nullable(),
  ...upgradeStatusBase,
  available: z.literal(false),
  operation_id: z.null(),
  steps: z.tuple([]),
  reason: databaseUpgradeUnavailableReasonSchema,
}).strict();

export const databaseUpgradeStatusSchema = z.discriminatedUnion('state', [
  upToDateStatusSchema,
  upgradeRequiredStatusSchema,
  upgradeInProgressStatusSchema,
  upgradeUnavailableStatusSchema,
]);

const administratorCredentialsShape = {
  administrator_email: z.string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(254)),
  administrator_password: z.string().min(1).max(1024),
};

export const databaseUpgradeStartRequestSchema = z.object({
  ...administratorCredentialsShape,
  backup_acknowledged: z.literal(true),
  confirmation: z.literal(DATABASE_UPGRADE_CONFIRMATION),
}).strict();

export const databaseUpgradeStepRequestSchema = z.object({
  operation_id: operationIdSchema,
  step_id: upgradeStepIdSchema,
  confirmation: z.literal(DATABASE_UPGRADE_CONFIRMATION),
}).strict();

export const databaseUpgradeStartSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('upgrade_studio_database'),
    status: z.literal('started'),
    operation_id: operationIdSchema,
    current_schema_version: schemaVersionSchema,
    target_schema_version: schemaVersionSchema,
    next_step: databaseUpgradeStepSchema,
  }).strict(),
}).strict();

export const databaseUpgradeStepProgressSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('upgrade_studio_database'),
    status: z.literal('in_progress'),
    operation_id: operationIdSchema,
    applied_step: databaseUpgradeStepSchema,
    current_schema_version: schemaVersionSchema,
    target_schema_version: schemaVersionSchema,
    next_step: databaseUpgradeStepSchema,
  }).strict(),
}).strict();

export const databaseUpgradeCompletedSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('upgrade_studio_database'),
    status: z.literal('completed'),
    operation_id: z.null(),
    applied_step: databaseUpgradeStepSchema,
    current_schema_version: schemaVersionSchema,
    target_schema_version: schemaVersionSchema,
    next_step: z.null(),
  }).strict(),
}).strict();

export const databaseUpgradeStartResponseSchema = z.union([
  databaseUpgradeStartSuccessSchema,
  apiErrorSchema,
]);

export const databaseUpgradeStepResponseSchema = z.union([
  databaseUpgradeStepProgressSuccessSchema,
  databaseUpgradeCompletedSuccessSchema,
  apiErrorSchema,
]);

export type DatabaseUpgradeStep = z.infer<
  typeof databaseUpgradeStepSchema
>;
export type DatabaseUpgradeStatus = z.infer<
  typeof databaseUpgradeStatusSchema
>;
export type DatabaseUpgradeStartRequest = z.infer<
  typeof databaseUpgradeStartRequestSchema
>;
export type DatabaseUpgradeStepRequest = z.infer<
  typeof databaseUpgradeStepRequestSchema
>;
export type DatabaseUpgradeStartSuccess = z.infer<
  typeof databaseUpgradeStartSuccessSchema
>;
export type DatabaseUpgradeStepSuccess = z.infer<
  typeof databaseUpgradeStepProgressSuccessSchema
> | z.infer<typeof databaseUpgradeCompletedSuccessSchema>;
export type DatabaseUpgradeStartResponse = z.infer<
  typeof databaseUpgradeStartResponseSchema
>;
export type DatabaseUpgradeStepResponse = z.infer<
  typeof databaseUpgradeStepResponseSchema
>;

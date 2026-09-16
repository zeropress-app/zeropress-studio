import { z } from 'zod';
import {
  DATABASE_UPGRADE_CONFIRMATION,
  DATABASE_UPGRADE_MAX_ARTIFACT_STATEMENTS,
  DATABASE_UPGRADE_MAX_BATCH_STATEMENTS,
  DATABASE_UPGRADE_MAX_STATEMENT_BYTES,
  type DatabaseUpgradeStartRequest,
  type DatabaseUpgradeStartSuccess,
  type DatabaseUpgradeStatus,
  type DatabaseUpgradeStep,
  type DatabaseUpgradeStepRequest,
  type DatabaseUpgradeStepSuccess,
} from '../../../contracts/database-upgrade';
import { splitSqlStatements } from '../../../contracts/sql-statements';
import type {
  DatabaseStatus,
  StudioSiteMode,
} from '../../../contracts/system';
import {
  MIN_SUPPORTED_STUDIO_SCHEMA_VERSION,
  STUDIO_SCHEMA_VERSION,
} from './schema-version';
import {
  STUDIO_SCHEMA_UPGRADE_ARTIFACTS,
  type StudioSchemaUpgradeArtifact,
} from './schema-upgrade-artifacts';
import {
  DATABASE_RESTORE_JOURNAL_TABLE,
  SCHEMA_UPGRADE_GUARD_TABLE,
} from './schema-upgrade-state';
import {
  parseStoredOperationsInitiator,
  type OperationsInitiator,
} from '../operations/initiator';

export { SCHEMA_UPGRADE_GUARD_TABLE } from './schema-upgrade-state';

const textEncoder = new TextEncoder();
const artifactIdPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const operationIdPattern = /^[0-9a-f]{32}$/u;
const forbiddenTransactionPattern = /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|VACUUM|ATTACH|DETACH)\b/iu;
const runnerOwnedObjectPattern = new RegExp(
  `\\b(?:zeropress_schema_state|${SCHEMA_UPGRADE_GUARD_TABLE})\\b`,
  'iu',
);

const lifecycleRowSchema = z.object({
  schema_version: z.number().int().nonnegative(),
  lifecycle_state: z.enum(['ready', 'installing', 'upgrading', 'failed']),
  target_schema_version: z.number().int().positive().nullable(),
  active_operation_id: z.string().nullable(),
}).strict();

type LifecycleRow = z.infer<typeof lifecycleRowSchema>;

export type StudioSchemaUpgradePlan = {
  steps: Array<{
    descriptor: DatabaseUpgradeStep;
    artifact: StudioSchemaUpgradeArtifact;
    statements: string[];
  }>;
};

export type SchemaUpgradeServiceIssue =
  | 'not_available'
  | 'state_conflict';

export class SchemaUpgradeServiceError extends Error {
  constructor(
    public readonly issue: SchemaUpgradeServiceIssue,
    message: string,
  ) {
    super(message);
    this.name = 'SchemaUpgradeServiceError';
  }
}

export class SchemaUpgradeArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaUpgradeArtifactError';
  }
}

function stripLeadingSqlTrivia(sql: string): string {
  let offset = 0;
  while (offset < sql.length) {
    const whitespace = /^\s+/u.exec(sql.slice(offset));
    if (whitespace) {
      offset += whitespace[0].length;
      continue;
    }
    if (sql.startsWith('--', offset)) {
      const lineEnd = sql.indexOf('\n', offset + 2);
      return lineEnd === -1
        ? ''
        : stripLeadingSqlTrivia(sql.slice(lineEnd + 1));
    }
    if (sql.startsWith('/*', offset)) {
      const commentEnd = sql.indexOf('*/', offset + 2);
      return commentEnd === -1
        ? ''
        : stripLeadingSqlTrivia(sql.slice(commentEnd + 2));
    }
    break;
  }
  return sql.slice(offset);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function createSchemaUpgradeArtifactSha256(
  sql: string,
): Promise<string> {
  const encoded = textEncoder.encode(sql);
  const owned = new Uint8Array(encoded);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    owned.buffer,
  )));
}

function createOperationId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

function assertRegistryStructure(input: {
  artifacts: readonly StudioSchemaUpgradeArtifact[];
  targetVersion: number;
}): Map<number, StudioSchemaUpgradeArtifact> {
  if (!Number.isInteger(input.targetVersion) || input.targetVersion < 1) {
    throw new SchemaUpgradeArtifactError(
      'The Studio target schema version is invalid.',
    );
  }
  const ids = new Set<string>();
  const byFromVersion = new Map<number, StudioSchemaUpgradeArtifact>();
  for (const artifact of input.artifacts) {
    if (
      !artifactIdPattern.test(artifact.id)
      || !Number.isInteger(artifact.fromVersion)
      || artifact.fromVersion < 1
      || artifact.toVersion !== artifact.fromVersion + 1
      || artifact.toVersion > input.targetVersion
      || !sha256Pattern.test(artifact.sha256)
      || ids.has(artifact.id)
      || byFromVersion.has(artifact.fromVersion)
    ) {
      throw new SchemaUpgradeArtifactError(
        'The Studio schema upgrade registry is invalid.',
      );
    }
    ids.add(artifact.id);
    byFromVersion.set(artifact.fromVersion, artifact);
  }
  return byFromVersion;
}

async function validateArtifact(
  artifact: StudioSchemaUpgradeArtifact,
): Promise<{ descriptor: DatabaseUpgradeStep; statements: string[] }> {
  if (await createSchemaUpgradeArtifactSha256(artifact.sql)
    !== artifact.sha256) {
    throw new SchemaUpgradeArtifactError(
      `Schema upgrade artifact ${artifact.id} has an invalid checksum.`,
    );
  }
  let statements: string[];
  try {
    statements = splitSqlStatements(artifact.sql);
  } catch (error) {
    throw new SchemaUpgradeArtifactError(
      `Schema upgrade artifact ${artifact.id} is not valid SQL: ${
        error instanceof Error ? error.message : 'unknown tokenizer error'
      }`,
    );
  }
  if (
    statements.length === 0
    || statements.length > DATABASE_UPGRADE_MAX_ARTIFACT_STATEMENTS
    || statements.length + 8 > DATABASE_UPGRADE_MAX_BATCH_STATEMENTS
  ) {
    throw new SchemaUpgradeArtifactError(
      `Schema upgrade artifact ${artifact.id} exceeds the D1 statement budget.`,
    );
  }
  for (const statement of statements) {
    if (textEncoder.encode(statement).byteLength
      > DATABASE_UPGRADE_MAX_STATEMENT_BYTES) {
      throw new SchemaUpgradeArtifactError(
        `Schema upgrade artifact ${artifact.id} contains an oversized statement.`,
      );
    }
    if (forbiddenTransactionPattern.test(stripLeadingSqlTrivia(statement))) {
      throw new SchemaUpgradeArtifactError(
        `Schema upgrade artifact ${artifact.id} contains transaction-control SQL.`,
      );
    }
    if (runnerOwnedObjectPattern.test(statement)) {
      throw new SchemaUpgradeArtifactError(
        `Schema upgrade artifact ${artifact.id} modifies runner-owned state.`,
      );
    }
  }
  return {
    descriptor: {
      id: artifact.id,
      from_version: artifact.fromVersion,
      to_version: artifact.toVersion,
      sha256: artifact.sha256,
      statement_count: statements.length,
    },
    statements,
  };
}

export async function createStudioSchemaUpgradePlan(input: {
  fromVersion: number;
  targetVersion: number;
  artifacts?: readonly StudioSchemaUpgradeArtifact[];
}): Promise<StudioSchemaUpgradePlan> {
  if (
    !Number.isInteger(input.fromVersion)
    || input.fromVersion < 1
    || input.fromVersion > input.targetVersion
  ) {
    throw new SchemaUpgradeArtifactError(
      'The Studio schema upgrade source version is invalid.',
    );
  }
  const artifacts = input.artifacts ?? STUDIO_SCHEMA_UPGRADE_ARTIFACTS;
  const byFromVersion = assertRegistryStructure({
    artifacts,
    targetVersion: input.targetVersion,
  });
  const steps: StudioSchemaUpgradePlan['steps'] = [];
  for (
    let version = input.fromVersion;
    version < input.targetVersion;
    version += 1
  ) {
    const artifact = byFromVersion.get(version);
    if (!artifact) {
      throw new SchemaUpgradeArtifactError(
        `The Studio schema upgrade path is missing version ${version} -> ${version + 1}.`,
      );
    }
    const validated = await validateArtifact(artifact);
    steps.push({ artifact, ...validated });
  }
  return { steps };
}

async function readLifecycleRow(db: D1Database): Promise<LifecycleRow | null> {
  const row = await db.prepare(`
    SELECT
      schema_version,
      lifecycle_state,
      target_schema_version,
      active_operation_id
    FROM zeropress_schema_state
    WHERE id = 1
    LIMIT 1
  `).bind().first<unknown>();
  if (row === null) return null;
  const parsed = lifecycleRowSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

async function guardTableExists(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).bind(SCHEMA_UPGRADE_GUARD_TABLE).first<{ present?: unknown }>();
  return row?.present === 1;
}

async function restoreJournalExists(db: D1Database): Promise<boolean> {
  const row = await db.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).bind(DATABASE_RESTORE_JOURNAL_TABLE).first<{ present?: unknown }>();
  return row?.present === 1;
}

function unavailableStatus(input: {
  currentVersion: number | null;
  targetVersion: number;
  reason: Extract<DatabaseUpgradeStatus, { state: 'unavailable' }>['reason'];
}): DatabaseUpgradeStatus {
  return {
    state: 'unavailable',
    current_schema_version: input.currentVersion,
    target_schema_version: input.targetVersion,
    available: false,
    operation_id: null,
    steps: [],
    confirmation: DATABASE_UPGRADE_CONFIRMATION,
    reason: input.reason,
  };
}

export async function inspectStudioSchemaUpgrade(input: {
  db: D1Database;
  siteMode: StudioSiteMode | null;
  databaseStatus?: DatabaseStatus;
  targetVersion?: number;
  minimumSupportedVersion?: number;
  artifacts?: readonly StudioSchemaUpgradeArtifact[];
}): Promise<DatabaseUpgradeStatus> {
  const targetVersion = input.targetVersion ?? STUDIO_SCHEMA_VERSION;
  const minimumSupportedVersion = input.minimumSupportedVersion
    ?? MIN_SUPPORTED_STUDIO_SCHEMA_VERSION;
  if (input.databaseStatus) {
    switch (input.databaseStatus.state) {
      case 'uninstalled':
        return unavailableStatus({
          currentVersion: null,
          targetVersion,
          reason: 'database_uninstalled',
        });
      case 'unmanaged':
        return unavailableStatus({
          currentVersion: null,
          targetVersion,
          reason: 'database_unmanaged',
        });
      case 'unavailable':
        return unavailableStatus({
          currentVersion: null,
          targetVersion,
          reason: 'database_unavailable',
        });
      case 'recovery_required':
        return unavailableStatus({
          currentVersion: input.databaseStatus.schema_version,
          targetVersion,
          reason: 'recovery_required',
        });
      case 'newer_than_code':
        return unavailableStatus({
          currentVersion: input.databaseStatus.schema_version,
          targetVersion,
          reason: 'newer_than_code',
        });
      case 'unsupported':
        return unavailableStatus({
          currentVersion: input.databaseStatus.schema_version,
          targetVersion,
          reason: 'unsupported',
        });
      case 'ready':
      case 'upgrade_required':
      case 'update_in_progress':
        break;
    }
  }
  const row = await readLifecycleRow(input.db);
  if (!row) {
    return unavailableStatus({
      currentVersion: null,
      targetVersion,
      reason: 'database_uninstalled',
    });
  }
  const currentVersion = row.schema_version;
  if (await restoreJournalExists(input.db)) {
    return unavailableStatus({
      currentVersion,
      targetVersion,
      reason: 'recovery_required',
    });
  }
  if (row.lifecycle_state === 'ready') {
    if (row.target_schema_version !== null || row.active_operation_id !== null) {
      return unavailableStatus({
        currentVersion,
        targetVersion,
        reason: 'recovery_required',
      });
    }
    if (currentVersion < minimumSupportedVersion) {
      return unavailableStatus({
        currentVersion,
        targetVersion,
        reason: 'unsupported',
      });
    }
    if (currentVersion > targetVersion) {
      return unavailableStatus({
        currentVersion,
        targetVersion,
        reason: 'newer_than_code',
      });
    }
    if (currentVersion === targetVersion) {
      return {
        state: 'up_to_date',
        current_schema_version: currentVersion,
        target_schema_version: targetVersion,
        available: false,
        operation_id: null,
        steps: [],
        confirmation: DATABASE_UPGRADE_CONFIRMATION,
      };
    }
    try {
      const plan = await createStudioSchemaUpgradePlan({
        fromVersion: currentVersion,
        targetVersion,
        artifacts: input.artifacts,
      });
      return {
        state: 'upgrade_required',
        current_schema_version: currentVersion,
        target_schema_version: targetVersion,
        available: input.siteMode === 'maintenance',
        operation_id: null,
        steps: plan.steps.map(({ descriptor }) => descriptor),
        confirmation: DATABASE_UPGRADE_CONFIRMATION,
      };
    } catch (error) {
      if (!(error instanceof SchemaUpgradeArtifactError)) throw error;
      return unavailableStatus({
        currentVersion,
        targetVersion,
        reason: 'artifact_chain_invalid',
      });
    }
  }

  if (
    row.lifecycle_state !== 'upgrading'
    || row.target_schema_version !== targetVersion
    || !operationIdPattern.test(row.active_operation_id ?? '')
    || currentVersion >= targetVersion
    || !await guardTableExists(input.db)
  ) {
    return unavailableStatus({
      currentVersion,
      targetVersion,
      reason: 'recovery_required',
    });
  }
  try {
    const plan = await createStudioSchemaUpgradePlan({
      fromVersion: currentVersion,
      targetVersion,
      artifacts: input.artifacts,
    });
    return {
      state: 'in_progress',
      current_schema_version: currentVersion,
      target_schema_version: targetVersion,
      available: input.siteMode === 'maintenance',
      operation_id: row.active_operation_id!,
      steps: plan.steps.map(({ descriptor }) => descriptor),
      confirmation: DATABASE_UPGRADE_CONFIRMATION,
    };
  } catch (error) {
    if (!(error instanceof SchemaUpgradeArtifactError)) throw error;
    return unavailableStatus({
      currentVersion,
      targetVersion,
      reason: 'artifact_chain_invalid',
    });
  }
}

const createGuardTableSql = `
  CREATE TABLE ${SCHEMA_UPGRADE_GUARD_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    operation_id TEXT NOT NULL
      CHECK (
        length(operation_id) = 32
        AND operation_id NOT GLOB '*[^0-9a-f]*'
      ),
    step_id TEXT NOT NULL
      CHECK (
        length(step_id) BETWEEN 1 AND 128
        AND step_id = trim(step_id)
      ),
    initiated_by_user_id TEXT NOT NULL
      CHECK (
        length(initiated_by_user_id) = 32
        AND initiated_by_user_id NOT GLOB '*[^0-9a-f]*'
      ),
    initiated_by_user_email TEXT NOT NULL
      CHECK (
        length(initiated_by_user_email) BETWEEN 3 AND 254
        AND initiated_by_user_email = lower(initiated_by_user_email)
        AND initiated_by_user_email = trim(initiated_by_user_email)
      ),
    validation_count INTEGER NOT NULL DEFAULT 0
      CHECK (validation_count = 0)
  )
`;

export async function startStudioSchemaUpgrade(input: {
  db: D1Database;
  request: DatabaseUpgradeStartRequest;
  targetVersion?: number;
  minimumSupportedVersion?: number;
  artifacts?: readonly StudioSchemaUpgradeArtifact[];
  now?: Date;
  createOperationId?: () => string;
  initiator: OperationsInitiator;
  beforeBatch?: (details: {
    fromVersion: number;
    targetVersion: number;
    stepCount: number;
  }) => void;
}): Promise<DatabaseUpgradeStartSuccess['data']> {
  const targetVersion = input.targetVersion ?? STUDIO_SCHEMA_VERSION;
  const minimumSupportedVersion = input.minimumSupportedVersion
    ?? MIN_SUPPORTED_STUDIO_SCHEMA_VERSION;
  const state = await readLifecycleRow(input.db);
  if (
    !state
    || state.lifecycle_state !== 'ready'
    || state.target_schema_version !== null
    || state.active_operation_id !== null
    || state.schema_version < minimumSupportedVersion
    || state.schema_version >= targetVersion
    || await restoreJournalExists(input.db)
  ) {
    throw new SchemaUpgradeServiceError(
      'not_available',
      'The Studio database is not available for a new schema upgrade.',
    );
  }
  const plan = await createStudioSchemaUpgradePlan({
    fromVersion: state.schema_version,
    targetVersion,
    artifacts: input.artifacts,
  });
  const operationId = (input.createOperationId ?? createOperationId)();
  if (!operationIdPattern.test(operationId)) {
    throw new TypeError('The generated schema upgrade operation ID is invalid.');
  }
  const nowIso = (input.now ?? new Date()).toISOString();
  input.beforeBatch?.({
    fromVersion: state.schema_version,
    targetVersion,
    stepCount: plan.steps.length,
  });
  try {
    await input.db.batch([
      input.db.prepare(createGuardTableSql),
      input.db.prepare(`
        INSERT INTO ${SCHEMA_UPGRADE_GUARD_TABLE} (
          id, operation_id, step_id, initiated_by_user_id,
          initiated_by_user_email, validation_count
        )
        VALUES (
          1,
          COALESCE((
            SELECT ?
            FROM zeropress_schema_state
            WHERE id = 1
              AND schema_version = ?
              AND lifecycle_state = 'ready'
              AND target_schema_version IS NULL
              AND active_operation_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM sqlite_schema
                WHERE type = 'table'
                  AND name = '${DATABASE_RESTORE_JOURNAL_TABLE}'
              )
          ), ''),
          'start',
          ?,
          ?,
          0
        )
      `).bind(
        operationId,
        state.schema_version,
        input.initiator.userId,
        input.initiator.userEmail,
      ),
      input.db.prepare(`
        UPDATE zeropress_schema_state
        SET lifecycle_state = 'upgrading',
            target_schema_version = ?,
            active_operation_id = ?,
            updated_at_iso = ?
        WHERE id = 1
          AND schema_version = ?
          AND lifecycle_state = 'ready'
          AND target_schema_version IS NULL
          AND active_operation_id IS NULL
      `).bind(
        targetVersion,
        operationId,
        nowIso,
        state.schema_version,
      ),
    ]);
  } catch (error) {
    const latest = await readLifecycleRow(input.db).catch(() => null);
    if (
      latest
      && (
        latest.schema_version !== state.schema_version
        || latest.lifecycle_state !== 'ready'
        || latest.active_operation_id !== null
      )
    ) {
      throw new SchemaUpgradeServiceError(
        'state_conflict',
        'The Studio schema lifecycle changed before upgrade start.',
      );
    }
    throw error;
  }
  const committed = await readLifecycleRow(input.db);
  if (
    !committed
    || committed.schema_version !== state.schema_version
    || committed.lifecycle_state !== 'upgrading'
    || committed.target_schema_version !== targetVersion
    || committed.active_operation_id !== operationId
  ) {
    throw new Error('The Studio schema upgrade start could not be verified.');
  }
  return {
    operation: 'upgrade_studio_database',
    status: 'started',
    operation_id: operationId,
    current_schema_version: state.schema_version,
    target_schema_version: targetVersion,
    next_step: plan.steps[0]!.descriptor,
  };
}

export async function readStudioSchemaUpgradeInitiator(input: {
  db: D1Database;
  operationId: string;
}): Promise<OperationsInitiator> {
  const row = await input.db.prepare(`
    SELECT initiated_by_user_id, initiated_by_user_email
    FROM ${SCHEMA_UPGRADE_GUARD_TABLE}
    WHERE id = 1 AND operation_id = ?
    LIMIT 1
  `).bind(input.operationId).first<{
    initiated_by_user_id?: unknown;
    initiated_by_user_email?: unknown;
  }>();
  if (!row) {
    throw new SchemaUpgradeServiceError(
      'state_conflict',
      'The Studio schema upgrade initiator is unavailable.',
    );
  }
  const initiator = parseStoredOperationsInitiator({
    userId: row.initiated_by_user_id,
    userEmail: row.initiated_by_user_email,
  });
  if (!initiator) {
    throw new SchemaUpgradeServiceError(
      'state_conflict',
      'The Studio schema upgrade initiator is unavailable.',
    );
  }
  return initiator;
}

export async function applyNextStudioSchemaUpgrade(input: {
  db: D1Database;
  request: DatabaseUpgradeStepRequest;
  targetVersion?: number;
  artifacts?: readonly StudioSchemaUpgradeArtifact[];
  now?: Date;
  beforeBatch?: (step: DatabaseUpgradeStep) => void;
}): Promise<DatabaseUpgradeStepSuccess['data']> {
  const targetVersion = input.targetVersion ?? STUDIO_SCHEMA_VERSION;
  const state = await readLifecycleRow(input.db);
  if (
    !state
    || state.lifecycle_state !== 'upgrading'
    || state.target_schema_version !== targetVersion
    || state.active_operation_id !== input.request.operation_id
    || state.schema_version >= targetVersion
    || !await guardTableExists(input.db)
  ) {
    throw new SchemaUpgradeServiceError(
      'state_conflict',
      'The Studio schema upgrade state does not match this request.',
    );
  }
  const plan = await createStudioSchemaUpgradePlan({
    fromVersion: state.schema_version,
    targetVersion,
    artifacts: input.artifacts,
  });
  const step = plan.steps[0]!;
  if (step.descriptor.id !== input.request.step_id) {
    throw new SchemaUpgradeServiceError(
      'state_conflict',
      'The requested Studio schema upgrade step is not next.',
    );
  }
  const completed = step.descriptor.to_version === targetVersion;
  const nowIso = (input.now ?? new Date()).toISOString();
  input.beforeBatch?.(step.descriptor);
  try {
    await input.db.batch([
      input.db.prepare('PRAGMA defer_foreign_keys = TRUE'),
      input.db.prepare(`
        UPDATE ${SCHEMA_UPGRADE_GUARD_TABLE}
        SET step_id = ?,
            validation_count = CASE
              WHEN operation_id = ? AND EXISTS (
            SELECT 1
            FROM zeropress_schema_state
            WHERE id = 1
              AND schema_version = ?
              AND lifecycle_state = 'upgrading'
              AND target_schema_version = ?
              AND active_operation_id = ?
              ) THEN 0
              ELSE 1
            END
        WHERE id = 1
      `).bind(
        step.descriptor.id,
        input.request.operation_id,
        step.descriptor.from_version,
        targetVersion,
        input.request.operation_id,
      ),
      input.db.prepare(`
        INSERT INTO ${SCHEMA_UPGRADE_GUARD_TABLE} (
          id, operation_id, step_id, initiated_by_user_id,
          initiated_by_user_email, validation_count
        )
        SELECT 1, '', '', '', '', 1
        WHERE NOT EXISTS (
          SELECT 1 FROM ${SCHEMA_UPGRADE_GUARD_TABLE} WHERE id = 1
        )
      `),
      ...step.statements.map((statement) => input.db.prepare(statement)),
      input.db.prepare(`
        UPDATE ${SCHEMA_UPGRADE_GUARD_TABLE}
        SET validation_count = (
          SELECT COUNT(*) FROM pragma_foreign_key_check
        )
        WHERE id = 1
      `),
      input.db.prepare(`
        UPDATE zeropress_schema_state
        SET schema_version = ?,
            lifecycle_state = ?,
            target_schema_version = ?,
            active_operation_id = ?,
            updated_at_iso = ?
        WHERE id = 1
          AND schema_version = ?
          AND lifecycle_state = 'upgrading'
          AND target_schema_version = ?
          AND active_operation_id = ?
      `).bind(
        step.descriptor.to_version,
        completed ? 'ready' : 'upgrading',
        completed ? null : targetVersion,
        completed ? null : input.request.operation_id,
        nowIso,
        step.descriptor.from_version,
        targetVersion,
        input.request.operation_id,
      ),
      ...(completed
        ? [input.db.prepare(`DROP TABLE ${SCHEMA_UPGRADE_GUARD_TABLE}`)]
        : [input.db.prepare(`
            UPDATE ${SCHEMA_UPGRADE_GUARD_TABLE}
            SET step_id = ?
            WHERE id = 1 AND operation_id = ?
          `).bind(plan.steps[1]!.descriptor.id, input.request.operation_id)]),
    ]);
  } catch (error) {
    const latest = await readLifecycleRow(input.db).catch(() => null);
    if (
      latest
      && (
        latest.schema_version !== state.schema_version
        || latest.lifecycle_state !== 'upgrading'
        || latest.active_operation_id !== input.request.operation_id
      )
    ) {
      throw new SchemaUpgradeServiceError(
        'state_conflict',
        'The Studio schema lifecycle changed before the requested step.',
      );
    }
    throw error;
  }
  const committed = await readLifecycleRow(input.db);
  if (
    !committed
    || committed.schema_version !== step.descriptor.to_version
    || committed.lifecycle_state !== (completed ? 'ready' : 'upgrading')
    || committed.target_schema_version !== (completed ? null : targetVersion)
    || committed.active_operation_id
      !== (completed ? null : input.request.operation_id)
  ) {
    throw new Error('The Studio schema upgrade step could not be verified.');
  }
  if (completed) {
    return {
      operation: 'upgrade_studio_database',
      status: 'completed',
      operation_id: null,
      applied_step: step.descriptor,
      current_schema_version: step.descriptor.to_version,
      target_schema_version: targetVersion,
      next_step: null,
    };
  }
  return {
    operation: 'upgrade_studio_database',
    status: 'in_progress',
    operation_id: input.request.operation_id,
    applied_step: step.descriptor,
    current_schema_version: step.descriptor.to_version,
    target_schema_version: targetVersion,
    next_step: plan.steps[1]!.descriptor,
  };
}

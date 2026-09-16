import { z } from 'zod';
import {
  DATABASE_UPGRADE_MAX_ARTIFACT_STATEMENTS,
  DATABASE_UPGRADE_MAX_BATCH_STATEMENTS,
  DATABASE_UPGRADE_MAX_STATEMENT_BYTES,
  type DatabaseUpgradeStep,
} from '../../../contracts/database-upgrade';
import {
  EDGE_DATABASE_ADOPT_CONFIRMATION,
  EDGE_DATABASE_INSTALL_CONFIRMATION,
  EDGE_DATABASE_UPGRADE_CONFIRMATION,
  type EdgeDatabaseStatus,
} from '../../../contracts/edge-database-lifecycle';
import { splitSqlStatements } from '../../../contracts/sql-statements';
import type { StudioSiteMode } from '../../../contracts/system';
import {
  parseStoredOperationsInitiator,
  type OperationsInitiator,
} from '../operations/initiator';
import {
  EDGE_DATABASE_BASELINE_SQL,
  EDGE_DATABASE_INSTALL_ARTIFACTS,
  EDGE_DATABASE_MINIMUM_SCHEMA_VERSION,
  EDGE_DATABASE_RESTORE_JOURNAL_TABLE,
  EDGE_DATABASE_SCHEMA_STATE_TABLE,
  EDGE_DATABASE_SEED_SQL,
  EDGE_DATABASE_SUPPORTED_SCHEMA_CATALOGS,
  EDGE_DATABASE_TARGET_SCHEMA_VERSION,
  EDGE_DATABASE_UNINSTALL_ARTIFACT,
  EDGE_DATABASE_UPGRADE_ARTIFACTS,
  EDGE_DATABASE_UPGRADE_GUARD_TABLE,
  type EdgeDatabaseUpgradeArtifact,
} from './schema-artifacts';

const encoder = new TextEncoder();
const operationIdPattern = /^[0-9a-f]{32}$/u;
const artifactIdPattern = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const forbiddenTransactionPattern = /^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PRAGMA|VACUUM|ATTACH|DETACH)\b/iu;
const runnerOwnedObjectPattern = new RegExp(
  `\\b(?:${EDGE_DATABASE_SCHEMA_STATE_TABLE}|${EDGE_DATABASE_UPGRADE_GUARD_TABLE})\\b`,
  'iu',
);
const createUpgradeGuardSql = `
  CREATE TABLE ${EDGE_DATABASE_UPGRADE_GUARD_TABLE} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    operation_id TEXT NOT NULL CHECK (
      length(operation_id) = 32
      AND operation_id NOT GLOB '*[^0-9a-f]*'
    ),
    step_id TEXT NOT NULL CHECK (
      length(step_id) BETWEEN 1 AND 128
      AND step_id NOT GLOB '*[^a-z0-9_-]*'
    ),
    initiated_by_user_id TEXT NOT NULL CHECK (
      length(initiated_by_user_id) = 32
      AND initiated_by_user_id NOT GLOB '*[^0-9a-f]*'
    ),
    initiated_by_user_email TEXT NOT NULL CHECK (
      length(initiated_by_user_email) BETWEEN 3 AND 254
      AND initiated_by_user_email = lower(initiated_by_user_email)
      AND initiated_by_user_email = trim(initiated_by_user_email)
    )
  )
`;

const lifecycleRowSchema = z.object({
  schema_version: z.number().int().positive(),
  lifecycle_state: z.enum(['ready', 'installing', 'upgrading', 'failed']),
  target_schema_version: z.number().int().positive().nullable(),
  active_operation_id: z.string().nullable(),
}).strict();

type SchemaObject = {
  type: 'table' | 'index' | 'trigger' | 'view';
  name: string;
  sql: string;
};

type CatalogRow = {
  type?: unknown;
  name?: unknown;
  sql?: unknown;
};

export type EdgeDatabaseUpgradePlan = Array<{
  artifact: EdgeDatabaseUpgradeArtifact;
  descriptor: DatabaseUpgradeStep;
  statements: string[];
}>;

export type EdgeDatabaseUninstallInspection = {
  deletedRows: Record<string, number>;
};

export class EdgeDatabaseLifecycleError extends Error {
  constructor(
    public readonly issue:
      | 'not_available'
      | 'state_conflict'
      | 'artifact_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'EdgeDatabaseLifecycleError';
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function createEdgeSchemaArtifactSha256(
  sql: string,
): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(sql),
  )));
}

function createOperationId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/;\s*$/u, '').replace(/\s+/gu, ' ');
}

function isInternalObject(name: string): boolean {
  return name.startsWith('sqlite_')
    || name.startsWith('_cf_')
    || name.startsWith('d1_');
}

function schemaObjectFromStatement(statement: string): SchemaObject | null {
  const match = /^\s*CREATE\s+(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([a-z][a-z0-9_]*)"|([a-z][a-z0-9_]*))/iu
    .exec(statement);
  if (!match) return null;
  return {
    type: match[1]!.toLowerCase() as SchemaObject['type'],
    name: (match[2] ?? match[3])!.toLowerCase(),
    sql: normalizeSql(statement),
  };
}

const expectedManagedCatalog = splitSqlStatements(EDGE_DATABASE_BASELINE_SQL)
  .map(schemaObjectFromStatement)
  .filter((value): value is SchemaObject => value !== null)
  .sort((left, right) => (
    left.type.localeCompare(right.type, 'en')
    || left.name.localeCompare(right.name, 'en')
  ));

const expectedLegacyCatalog = expectedManagedCatalog.filter(
  ({ name }) => name !== EDGE_DATABASE_SCHEMA_STATE_TABLE,
);

function parseCatalog(rows: CatalogRow[]): SchemaObject[] | null {
  const parsed: SchemaObject[] = [];
  for (const row of rows) {
    if (
      !['table', 'index', 'trigger', 'view'].includes(String(row.type))
      || typeof row.name !== 'string'
      || typeof row.sql !== 'string'
    ) return null;
    if (isInternalObject(row.name)) continue;
    parsed.push({
      type: row.type as SchemaObject['type'],
      name: row.name,
      sql: normalizeSql(row.sql),
    });
  }
  return parsed.sort((left, right) => (
    left.type.localeCompare(right.type, 'en')
    || left.name.localeCompare(right.name, 'en')
  ));
}

function catalogsEqual(
  actual: readonly SchemaObject[],
  expected: readonly SchemaObject[],
): boolean {
  return actual.length === expected.length
    && actual.every((item, index) => {
      const wanted = expected[index];
      return wanted?.type === item.type
        && wanted.name === item.name
        && wanted.sql === item.sql;
    });
}

async function createSchemaCatalogSha256(
  catalog: readonly SchemaObject[],
): Promise<string> {
  const serialized = JSON.stringify(catalog.map(({ type, name, sql }) => ({
    type,
    name,
    sql,
  })));
  return createEdgeSchemaArtifactSha256(serialized);
}

async function resolveManagedCatalogVersion(
  catalog: readonly SchemaObject[],
): Promise<number | null> {
  const sha256 = await createSchemaCatalogSha256(catalog);
  const matches = EDGE_DATABASE_SUPPORTED_SCHEMA_CATALOGS.filter(
    (candidate) => candidate.sha256 === sha256,
  );
  return matches.length === 1 ? matches[0]!.schemaVersion : null;
}

async function readCatalog(db: D1Database): Promise<SchemaObject[] | null> {
  const result = await db.prepare(`
    SELECT type, name, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND sql IS NOT NULL
    ORDER BY type, name
  `).all<CatalogRow>();
  return parseCatalog(result.results ?? []);
}

async function readSeedState(db: D1Database) {
  const row = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM edge_comment_settings WHERE id = 1
      ) AS comments_row,
      (SELECT COUNT(*) FROM edge_runtime_settings WHERE id = 1
      ) AS runtime_row,
      (SELECT COUNT(*) FROM edge_mail_settings WHERE id = 1
      ) AS mail_row,
      (SELECT COUNT(*) FROM newsletter_lists WHERE slug = 'default'
      ) AS newsletter_row,
      (SELECT COUNT(*) FROM edge_comment_settings
        WHERE id = 1
          AND api_base_url IS NULL
          AND comments_enabled = 1
          AND require_approval = 1
          AND per_page = 50
          AND sort_order = 'desc'
          AND thread_comments = 1
          AND thread_comments_depth = 2
          AND request_secrets_json IS NULL
          AND auth_enabled = 0
          AND supabase_project_url IS NULL
          AND supabase_publishable_key IS NULL
      ) AS comments_seed,
      (SELECT COUNT(*) FROM edge_runtime_settings
        WHERE id = 1
          AND comment_write_verification_mode = 'pow'
          AND newsletter_subscribe_verification_mode = 'pow'
          AND form_submit_verification_mode = 'pow'
          AND turnstile_sitekey IS NULL
          AND ip_address_retention_days = 30
      ) AS runtime_seed,
      (SELECT COUNT(*) FROM edge_mail_settings
        WHERE id = 1
          AND newsletter_confirmation_enabled = 0
      ) AS mail_seed,
      (SELECT COUNT(*) FROM newsletter_lists
        WHERE slug = 'default'
          AND title = 'Newsletter'
          AND description IS NULL
          AND status = 'active'
      ) AS newsletter_seed
  `).first<Record<string, unknown>>();
  return row;
}

async function hasRequiredSeedRows(db: D1Database): Promise<boolean> {
  const row = await readSeedState(db);
  return row?.comments_row === 1
    && row.runtime_row === 1
    && row.mail_row === 1
    && row.newsletter_row === 1;
}

async function hasCanonicalAdoptionSeeds(db: D1Database): Promise<boolean> {
  const row = await readSeedState(db);
  return row?.comments_seed === 1
    && row.runtime_seed === 1
    && row.mail_seed === 1
    && row.newsletter_seed === 1;
}

async function readLifecycleRow(db: D1Database) {
  const row = await db.prepare(`
    SELECT schema_version, lifecycle_state, target_schema_version,
           active_operation_id
    FROM ${EDGE_DATABASE_SCHEMA_STATE_TABLE}
    WHERE id = 1
    LIMIT 1
  `).first<unknown>();
  if (row === null) return null;
  const parsed = lifecycleRowSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

function status(input: Partial<EdgeDatabaseStatus> & {
  state: EdgeDatabaseStatus['state'];
  siteMode: StudioSiteMode | null;
}): EdgeDatabaseStatus {
  const maintenance = input.siteMode === 'maintenance';
  const upgradeMode = maintenance || input.siteMode === 'operational';
  return {
    state: input.state,
    current_schema_version: input.current_schema_version ?? null,
    target_schema_version: EDGE_DATABASE_TARGET_SCHEMA_VERSION,
    operation_id: input.operation_id ?? null,
    next_upgrade_steps: input.next_upgrade_steps ?? [],
    install_available: maintenance && input.state === 'uninstalled',
    adopt_available: maintenance && input.state === 'adoption_required',
    upgrade_available: upgradeMode && (
      input.state === 'upgrade_required' || input.state === 'in_progress'
    ),
  };
}

export async function inspectEdgeDatabaseLifecycle(input: {
  edgeDb?: D1Database;
  siteMode: StudioSiteMode | null;
  targetVersion?: number;
  artifacts?: readonly EdgeDatabaseUpgradeArtifact[];
}): Promise<EdgeDatabaseStatus> {
  if (!input.edgeDb) return status({ state: 'unavailable', siteMode: input.siteMode });
  const db = input.edgeDb;
  let catalog: SchemaObject[] | null;
  try {
    catalog = await readCatalog(db);
  } catch {
    return status({ state: 'unavailable', siteMode: input.siteMode });
  }
  if (catalog === null) {
    return status({ state: 'unmanaged', siteMode: input.siteMode });
  }
  if (catalog.length === 0) {
    return status({ state: 'uninstalled', siteMode: input.siteMode });
  }
  if (catalog.some(({ name }) => name === EDGE_DATABASE_RESTORE_JOURNAL_TABLE)) {
    return status({ state: 'recovery_required', siteMode: input.siteMode });
  }
  const upgradeGuards = catalog.filter(
    ({ name }) => name === EDGE_DATABASE_UPGRADE_GUARD_TABLE,
  );
  if (
    upgradeGuards.length > 1
    || (
      upgradeGuards.length === 1
      && (
        upgradeGuards[0]!.type !== 'table'
        || upgradeGuards[0]!.sql !== normalizeSql(createUpgradeGuardSql)
      )
    )
  ) return status({ state: 'recovery_required', siteMode: input.siteMode });
  const hasUpgradeGuard = upgradeGuards.length === 1;
  const stableCatalog = hasUpgradeGuard
    ? catalog.filter(({ name }) => name !== EDGE_DATABASE_UPGRADE_GUARD_TABLE)
    : catalog;
  if (catalogsEqual(stableCatalog, expectedLegacyCatalog)) {
    if (hasUpgradeGuard) {
      return status({ state: 'recovery_required', siteMode: input.siteMode });
    }
    try {
      return status({
        state: await hasCanonicalAdoptionSeeds(db)
          ? 'adoption_required'
          : 'unmanaged',
        siteMode: input.siteMode,
      });
    } catch {
      return status({ state: 'unmanaged', siteMode: input.siteMode });
    }
  }
  let catalogVersion: number | null;
  try {
    catalogVersion = await resolveManagedCatalogVersion(stableCatalog);
  } catch {
    return status({ state: 'unavailable', siteMode: input.siteMode });
  }
  if (catalogVersion === null) {
    return status({
      state: hasUpgradeGuard ? 'recovery_required' : 'unmanaged',
      siteMode: input.siteMode,
    });
  }
  let row: Awaited<ReturnType<typeof readLifecycleRow>>;
  try {
    row = await readLifecycleRow(db);
    if (!row) {
      return status({ state: 'recovery_required', siteMode: input.siteMode });
    }
  } catch {
    return status({ state: 'recovery_required', siteMode: input.siteMode });
  }
  if (row.schema_version !== catalogVersion) {
    return status({
      state: 'recovery_required',
      siteMode: input.siteMode,
      current_schema_version: row.schema_version,
    });
  }
  const targetVersion = input.targetVersion ?? EDGE_DATABASE_TARGET_SCHEMA_VERSION;
  if (hasUpgradeGuard) {
    if (
      row.lifecycle_state !== 'upgrading'
      || row.target_schema_version !== targetVersion
      || !operationIdPattern.test(row.active_operation_id ?? '')
      || row.schema_version >= targetVersion
    ) {
      return status({
        state: 'recovery_required', siteMode: input.siteMode,
        current_schema_version: row.schema_version,
      });
    }
    try {
      const plan = await createEdgeDatabaseUpgradePlan({
        fromVersion: row.schema_version,
        targetVersion,
        artifacts: input.artifacts,
      });
      return status({
        state: 'in_progress', siteMode: input.siteMode,
        current_schema_version: row.schema_version,
        operation_id: row.active_operation_id,
        next_upgrade_steps: plan.map(({ descriptor }) => descriptor),
      });
    } catch {
      return status({
        state: 'recovery_required', siteMode: input.siteMode,
        current_schema_version: row.schema_version,
      });
    }
  }
  try {
    if (!await hasRequiredSeedRows(db)) {
      return status({
        state: 'recovery_required', siteMode: input.siteMode,
        current_schema_version: row.schema_version,
      });
    }
  } catch {
    return status({
      state: 'recovery_required', siteMode: input.siteMode,
      current_schema_version: row.schema_version,
    });
  }
  if (row.lifecycle_state === 'failed') {
    return status({
      state: 'recovery_required',
      siteMode: input.siteMode,
      current_schema_version: row.schema_version,
    });
  }
  if (row.lifecycle_state === 'ready') {
    if (
      hasUpgradeGuard
      || row.target_schema_version !== null
      || row.active_operation_id !== null
    ) {
      return status({
        state: 'recovery_required', siteMode: input.siteMode,
        current_schema_version: row.schema_version,
      });
    }
    if (row.schema_version > targetVersion) {
      return status({
        state: 'newer_than_code', siteMode: input.siteMode,
        current_schema_version: row.schema_version,
      });
    }
    if (row.schema_version < EDGE_DATABASE_MINIMUM_SCHEMA_VERSION) {
      return status({
        state: 'unmanaged', siteMode: input.siteMode,
        current_schema_version: row.schema_version,
      });
    }
    if (row.schema_version === targetVersion) {
      return status({
        state: 'ready', siteMode: input.siteMode,
        current_schema_version: row.schema_version,
      });
    }
    try {
      const plan = await createEdgeDatabaseUpgradePlan({
        fromVersion: row.schema_version,
        targetVersion,
        artifacts: input.artifacts,
      });
      return status({
        state: 'upgrade_required', siteMode: input.siteMode,
        current_schema_version: row.schema_version,
        next_upgrade_steps: plan.map(({ descriptor }) => descriptor),
      });
    } catch {
      return status({
        state: 'recovery_required', siteMode: input.siteMode,
        current_schema_version: row.schema_version,
      });
    }
  }
  return status({
    state: 'recovery_required', siteMode: input.siteMode,
    current_schema_version: row.schema_version,
  });
}

function stripLeadingTrivia(sql: string): string {
  return sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/u, '');
}

async function validateArtifact(artifact: EdgeDatabaseUpgradeArtifact) {
  if (
    !artifactIdPattern.test(artifact.id)
    || artifact.toVersion !== artifact.fromVersion + 1
    || !sha256Pattern.test(artifact.sha256)
    || await createEdgeSchemaArtifactSha256(artifact.sql) !== artifact.sha256
  ) throw new EdgeDatabaseLifecycleError('artifact_invalid', 'Invalid Edge upgrade artifact.');
  const statements = splitSqlStatements(artifact.sql);
  if (
    statements.length === 0
    || statements.length > DATABASE_UPGRADE_MAX_ARTIFACT_STATEMENTS
    || statements.length + 4 > DATABASE_UPGRADE_MAX_BATCH_STATEMENTS
  ) throw new EdgeDatabaseLifecycleError('artifact_invalid', 'Invalid Edge upgrade statement count.');
  for (const statement of statements) {
    if (
      encoder.encode(statement).byteLength > DATABASE_UPGRADE_MAX_STATEMENT_BYTES
      || forbiddenTransactionPattern.test(stripLeadingTrivia(statement))
      || runnerOwnedObjectPattern.test(statement)
    ) throw new EdgeDatabaseLifecycleError('artifact_invalid', 'Unsafe Edge upgrade artifact.');
  }
  return statements;
}

export async function validateEdgeInstallArtifacts(): Promise<string[]> {
  const statements: string[] = [];
  for (const artifact of EDGE_DATABASE_INSTALL_ARTIFACTS) {
    if (await createEdgeSchemaArtifactSha256(artifact.sql) !== artifact.sha256) {
      throw new EdgeDatabaseLifecycleError('artifact_invalid', `Invalid checksum: ${artifact.id}`);
    }
    statements.push(...splitSqlStatements(artifact.sql));
  }
  if (statements.length > DATABASE_UPGRADE_MAX_BATCH_STATEMENTS) {
    throw new EdgeDatabaseLifecycleError('artifact_invalid', 'Edge install exceeds the D1 statement budget.');
  }
  return statements;
}

export async function validateEdgeUninstallArtifact(): Promise<Array<{
  table: string;
  statement: string;
}>> {
  const artifact = EDGE_DATABASE_UNINSTALL_ARTIFACT;
  if (
    !artifactIdPattern.test(artifact.id)
    || !sha256Pattern.test(artifact.sha256)
    || await createEdgeSchemaArtifactSha256(artifact.sql) !== artifact.sha256
  ) {
    throw new EdgeDatabaseLifecycleError(
      'artifact_invalid',
      'Invalid Edge uninstall artifact.',
    );
  }
  const expectedTables = expectedManagedCatalog
    .filter(({ type }) => type === 'table')
    .map(({ name }) => name)
    .sort();
  const statements = splitSqlStatements(artifact.sql);
  if (
    statements.length === 0
    || statements.length > DATABASE_UPGRADE_MAX_BATCH_STATEMENTS
  ) {
    throw new EdgeDatabaseLifecycleError(
      'artifact_invalid',
      'Invalid Edge uninstall statement count.',
    );
  }
  const parsed = statements.map((statement) => {
    const match = /^DROP\s+TABLE\s+([a-z][a-z0-9_]*)$/iu.exec(
      stripLeadingTrivia(statement).trim(),
    );
    if (!match) {
      throw new EdgeDatabaseLifecycleError(
        'artifact_invalid',
        'Unsafe Edge uninstall artifact.',
      );
    }
    return { table: match[1]!.toLowerCase(), statement };
  });
  if (
    new Set(parsed.map(({ table }) => table)).size !== parsed.length
    || parsed.map(({ table }) => table).sort().join('\n')
      !== expectedTables.join('\n')
    || parsed.at(-1)?.table !== EDGE_DATABASE_SCHEMA_STATE_TABLE
  ) {
    throw new EdgeDatabaseLifecycleError(
      'artifact_invalid',
      'Edge uninstall tables do not match the managed schema.',
    );
  }
  return parsed;
}

function parseUninstallCount(value: unknown, table: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new EdgeDatabaseLifecycleError(
      'state_conflict',
      `Invalid Edge uninstall row count for ${table}.`,
    );
  }
  return Number(value);
}

async function requireReadyEdgeDatabaseForUninstall(
  edgeDb: D1Database,
): Promise<Array<{ table: string; statement: string }>> {
  const status = await inspectEdgeDatabaseLifecycle({
    edgeDb,
    siteMode: 'maintenance',
  });
  if (status.state !== 'ready') {
    throw new EdgeDatabaseLifecycleError(
      'not_available',
      'Edge database uninstall requires a ready managed schema.',
    );
  }
  return validateEdgeUninstallArtifact();
}

export async function inspectEdgeDatabaseUninstall(input: {
  edgeDb: D1Database;
}): Promise<EdgeDatabaseUninstallInspection> {
  const artifact = await requireReadyEdgeDatabaseForUninstall(input.edgeDb);
  const results = await input.edgeDb.batch(artifact.map(({ table }) =>
    input.edgeDb.prepare(
      `SELECT COUNT(*) AS row_count FROM "${table}"`,
    )));
  const deletedRows: Record<string, number> = {};
  artifact.forEach(({ table }, index) => {
    const row = results[index]?.results?.[0] as
      | { row_count?: unknown }
      | undefined;
    deletedRows[`EDGE_DB.${table}`] = parseUninstallCount(
      row?.row_count,
      table,
    );
  });
  return { deletedRows };
}

export async function uninstallEdgeDatabase(input: {
  edgeDb: D1Database;
}): Promise<EdgeDatabaseUninstallInspection> {
  const artifact = await requireReadyEdgeDatabaseForUninstall(input.edgeDb);
  const countStatements = artifact.map(({ table }) => input.edgeDb.prepare(
    `SELECT COUNT(*) AS row_count FROM "${table}"`,
  ));
  const results = await input.edgeDb.batch([
    ...countStatements,
    ...artifact.map(({ statement }) => input.edgeDb.prepare(statement)),
  ]);
  const deletedRows: Record<string, number> = {};
  artifact.forEach(({ table }, index) => {
    const row = results[index]?.results?.[0] as
      | { row_count?: unknown }
      | undefined;
    deletedRows[`EDGE_DB.${table}`] = parseUninstallCount(
      row?.row_count,
      table,
    );
  });
  const after = await inspectEdgeDatabaseLifecycle({
    edgeDb: input.edgeDb,
    siteMode: 'maintenance',
  });
  if (after.state !== 'uninstalled') {
    throw new EdgeDatabaseLifecycleError(
      'state_conflict',
      'Edge uninstall did not converge to uninstalled.',
    );
  }
  return { deletedRows };
}

export async function createEdgeDatabaseUpgradePlan(input: {
  fromVersion: number;
  targetVersion: number;
  artifacts?: readonly EdgeDatabaseUpgradeArtifact[];
}): Promise<EdgeDatabaseUpgradePlan> {
  const artifacts = input.artifacts ?? EDGE_DATABASE_UPGRADE_ARTIFACTS;
  const byVersion = new Map<number, EdgeDatabaseUpgradeArtifact>();
  const ids = new Set<string>();
  for (const artifact of artifacts) {
    if (ids.has(artifact.id) || byVersion.has(artifact.fromVersion)) {
      throw new EdgeDatabaseLifecycleError('artifact_invalid', 'Duplicate Edge upgrade artifact.');
    }
    ids.add(artifact.id);
    byVersion.set(artifact.fromVersion, artifact);
  }
  const plan: EdgeDatabaseUpgradePlan = [];
  for (let version = input.fromVersion; version < input.targetVersion; version += 1) {
    const artifact = byVersion.get(version);
    if (!artifact || artifact.toVersion !== version + 1) {
      throw new EdgeDatabaseLifecycleError('artifact_invalid', 'Missing Edge upgrade artifact.');
    }
    const statements = await validateArtifact(artifact);
    plan.push({
      artifact,
      statements,
      descriptor: {
        id: artifact.id,
        from_version: artifact.fromVersion,
        to_version: artifact.toVersion,
        sha256: artifact.sha256,
        statement_count: statements.length,
      },
    });
  }
  return plan;
}

export async function installEdgeDatabase(input: {
  edgeDb: D1Database;
}): Promise<void> {
  const before = await inspectEdgeDatabaseLifecycle({
    edgeDb: input.edgeDb,
    siteMode: 'maintenance',
  });
  if (before.state !== 'uninstalled') {
    throw new EdgeDatabaseLifecycleError('not_available', EDGE_DATABASE_INSTALL_CONFIRMATION);
  }
  const statements = await validateEdgeInstallArtifacts();
  await input.edgeDb.batch(statements.map((statement) =>
    input.edgeDb.prepare(statement)));
  const after = await inspectEdgeDatabaseLifecycle({
    edgeDb: input.edgeDb,
    siteMode: 'maintenance',
  });
  if (after.state !== 'ready') {
    throw new EdgeDatabaseLifecycleError('state_conflict', 'Edge install did not converge to ready.');
  }
}

export async function adoptEdgeDatabase(input: {
  edgeDb: D1Database;
  now?: Date;
}): Promise<void> {
  const before = await inspectEdgeDatabaseLifecycle({
    edgeDb: input.edgeDb,
    siteMode: 'maintenance',
  });
  if (before.state !== 'adoption_required') {
    throw new EdgeDatabaseLifecycleError('not_available', EDGE_DATABASE_ADOPT_CONFIRMATION);
  }
  const stateStatement = splitSqlStatements(EDGE_DATABASE_BASELINE_SQL)
    .find((statement) => normalizeSql(statement).startsWith(
      `CREATE TABLE ${EDGE_DATABASE_SCHEMA_STATE_TABLE}`,
    ));
  if (!stateStatement) {
    throw new EdgeDatabaseLifecycleError('artifact_invalid', 'Missing Edge lifecycle table artifact.');
  }
  await input.edgeDb.batch([
    input.edgeDb.prepare(stateStatement),
    input.edgeDb.prepare(`
      INSERT INTO ${EDGE_DATABASE_SCHEMA_STATE_TABLE} (
        id, schema_version, lifecycle_state, target_schema_version,
        active_operation_id, updated_at_iso
      ) VALUES (1, ?, 'ready', NULL, NULL, ?)
    `).bind(EDGE_DATABASE_TARGET_SCHEMA_VERSION, (input.now ?? new Date()).toISOString()),
  ]);
  const after = await inspectEdgeDatabaseLifecycle({
    edgeDb: input.edgeDb,
    siteMode: 'maintenance',
  });
  if (after.state !== 'ready') {
    throw new EdgeDatabaseLifecycleError('state_conflict', 'Edge adoption did not converge to ready.');
  }
}

export async function startEdgeDatabaseUpgrade(input: {
  edgeDb: D1Database;
  targetVersion?: number;
  artifacts?: readonly EdgeDatabaseUpgradeArtifact[];
  now?: Date;
  createOperationId?: () => string;
  initiator: OperationsInitiator;
}) {
  const targetVersion = input.targetVersion ?? EDGE_DATABASE_TARGET_SCHEMA_VERSION;
  const inspected = await inspectEdgeDatabaseLifecycle({
    edgeDb: input.edgeDb,
    siteMode: 'maintenance',
    targetVersion,
    artifacts: input.artifacts,
  });
  const state = await readLifecycleRow(input.edgeDb);
  if (inspected.state === 'in_progress' && (
    state?.lifecycle_state === 'upgrading'
    && state.target_schema_version === targetVersion
    && operationIdPattern.test(state.active_operation_id ?? '')
    && state.schema_version < targetVersion
  )) {
    const resumedPlan = await createEdgeDatabaseUpgradePlan({
      fromVersion: state.schema_version,
      targetVersion,
      artifacts: input.artifacts,
    });
    const next = resumedPlan[0];
    if (!next) {
      throw new EdgeDatabaseLifecycleError('state_conflict', 'Edge upgrade has no resumable step.');
    }
    return {
      operationId: state.active_operation_id!,
      currentVersion: state.schema_version,
      targetVersion,
      nextStep: next.descriptor,
    };
  }
  if (
    inspected.state !== 'upgrade_required'
    || !state
    || state.lifecycle_state !== 'ready'
    || state.schema_version >= targetVersion
  ) {
    throw new EdgeDatabaseLifecycleError('not_available', EDGE_DATABASE_UPGRADE_CONFIRMATION);
  }
  const plan = await createEdgeDatabaseUpgradePlan({
    fromVersion: state.schema_version,
    targetVersion,
    artifacts: input.artifacts,
  });
  const operationId = (input.createOperationId ?? createOperationId)();
  const first = plan[0];
  if (!first) throw new EdgeDatabaseLifecycleError('not_available', 'No Edge upgrade step.');
  await input.edgeDb.batch([
    input.edgeDb.prepare(createUpgradeGuardSql),
    input.edgeDb.prepare(`
      INSERT INTO ${EDGE_DATABASE_UPGRADE_GUARD_TABLE} (
        id, operation_id, step_id,
        initiated_by_user_id, initiated_by_user_email
      ) VALUES (1, ?, ?, ?, ?)
    `).bind(
      operationId,
      first.artifact.id,
      input.initiator.userId,
      input.initiator.userEmail,
    ),
    input.edgeDb.prepare(`
      UPDATE ${EDGE_DATABASE_SCHEMA_STATE_TABLE}
      SET lifecycle_state = 'upgrading', target_schema_version = ?,
          active_operation_id = ?, updated_at_iso = ?
      WHERE id = 1 AND schema_version = ? AND lifecycle_state = 'ready'
    `).bind(targetVersion, operationId, (input.now ?? new Date()).toISOString(), state.schema_version),
  ]);
  return { operationId, currentVersion: state.schema_version, targetVersion, nextStep: first.descriptor };
}

export async function readEdgeDatabaseUpgradeInitiator(input: {
  edgeDb: D1Database;
  operationId: string;
}): Promise<OperationsInitiator> {
  const row = await input.edgeDb.prepare(`
    SELECT initiated_by_user_id, initiated_by_user_email
    FROM ${EDGE_DATABASE_UPGRADE_GUARD_TABLE}
    WHERE id = 1 AND operation_id = ?
    LIMIT 1
  `).bind(input.operationId).first<{
    initiated_by_user_id?: unknown;
    initiated_by_user_email?: unknown;
  }>();
  if (!row) {
    throw new EdgeDatabaseLifecycleError(
      'state_conflict',
      'The Edge database upgrade initiator is unavailable.',
    );
  }
  const initiator = parseStoredOperationsInitiator({
    userId: row.initiated_by_user_id,
    userEmail: row.initiated_by_user_email,
  });
  if (!initiator) {
    throw new EdgeDatabaseLifecycleError(
      'state_conflict',
      'The Edge database upgrade initiator is unavailable.',
    );
  }
  return initiator;
}

export async function applyNextEdgeDatabaseUpgrade(input: {
  edgeDb: D1Database;
  operationId: string;
  stepId: string;
  targetVersion?: number;
  artifacts?: readonly EdgeDatabaseUpgradeArtifact[];
  now?: Date;
}) {
  const targetVersion = input.targetVersion ?? EDGE_DATABASE_TARGET_SCHEMA_VERSION;
  const inspected = await inspectEdgeDatabaseLifecycle({
    edgeDb: input.edgeDb,
    siteMode: 'maintenance',
    targetVersion,
    artifacts: input.artifacts,
  });
  if (
    inspected.state !== 'in_progress'
    || inspected.operation_id !== input.operationId
    || inspected.next_upgrade_steps[0]?.id !== input.stepId
  ) {
    throw new EdgeDatabaseLifecycleError(
      'state_conflict',
      'Edge upgrade lifecycle inspection changed.',
    );
  }
  const state = await readLifecycleRow(input.edgeDb);
  if (
    !state
    || state.lifecycle_state !== 'upgrading'
    || state.target_schema_version !== targetVersion
    || state.active_operation_id !== input.operationId
  ) throw new EdgeDatabaseLifecycleError('state_conflict', 'Edge upgrade operation changed.');
  const plan = await createEdgeDatabaseUpgradePlan({
    fromVersion: state.schema_version,
    targetVersion,
    artifacts: input.artifacts,
  });
  const current = plan[0];
  if (!current || current.artifact.id !== input.stepId) {
    throw new EdgeDatabaseLifecycleError('state_conflict', 'Unexpected Edge upgrade step.');
  }
  const completed = current.artifact.toVersion === targetVersion;
  const next = plan[1] ?? null;
  await input.edgeDb.batch([
    input.edgeDb.prepare(`
      INSERT INTO ${EDGE_DATABASE_UPGRADE_GUARD_TABLE} (
        id, operation_id, step_id,
        initiated_by_user_id, initiated_by_user_email
      )
      SELECT 1, NULL, NULL, NULL, NULL
      WHERE NOT EXISTS (
        SELECT 1 FROM ${EDGE_DATABASE_UPGRADE_GUARD_TABLE} WHERE id = 1
      )
    `),
    input.edgeDb.prepare(`
      UPDATE ${EDGE_DATABASE_UPGRADE_GUARD_TABLE}
      SET step_id = CASE
        WHEN operation_id = ? AND step_id = ? THEN step_id
        ELSE NULL
      END
      WHERE id = 1
    `).bind(input.operationId, input.stepId),
    ...current.statements.map((statement) => input.edgeDb.prepare(statement)),
    input.edgeDb.prepare(`
      UPDATE ${EDGE_DATABASE_SCHEMA_STATE_TABLE}
      SET schema_version = ?, lifecycle_state = ?, target_schema_version = ?,
          active_operation_id = ?, updated_at_iso = ?
      WHERE id = 1 AND schema_version = ? AND lifecycle_state = 'upgrading'
        AND active_operation_id = ?
    `).bind(
      current.artifact.toVersion,
      completed ? 'ready' : 'upgrading',
      completed ? null : targetVersion,
      completed ? null : input.operationId,
      (input.now ?? new Date()).toISOString(),
      state.schema_version,
      input.operationId,
    ),
    completed
      ? input.edgeDb.prepare(`DROP TABLE ${EDGE_DATABASE_UPGRADE_GUARD_TABLE}`)
      : input.edgeDb.prepare(`
          UPDATE ${EDGE_DATABASE_UPGRADE_GUARD_TABLE}
          SET step_id = ? WHERE id = 1 AND operation_id = ?
        `).bind(next!.artifact.id, input.operationId),
  ]);
  return {
    completed,
    currentVersion: current.artifact.toVersion,
    targetVersion,
    nextStep: next?.descriptor ?? null,
  };
}

// Kept referenced so the vendored seed remains part of the compile-time
// contract even when only the combined installer path consumes it.
void EDGE_DATABASE_SEED_SQL;

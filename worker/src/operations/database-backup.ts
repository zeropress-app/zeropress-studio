import {
  DATABASE_BACKUP_INSERT_TARGET_BYTES,
  DATABASE_RESTORE_MAX_ROWS_PER_CHUNK,
  databaseBackupManifestSchema,
  createSchemaFingerprint,
  createManifestSha256,
  createStatementChainSha256,
  validateDatabaseBackupSchemaCatalog,
  serializeDatabaseBackupArtifact,
  type DatabaseBackupManifest,
  type DatabaseBackupManagedVirtualTable,
  type DatabaseBackupMode,
  type DatabaseBackupSchemaObject,
  type DatabaseBackupTable,
  type DatabaseBackupTarget,
  type DatabaseRestoreChunkRequest,
  type DatabaseRestoreFinalizeRequest,
  type DatabaseRestoreStartRequest,
  type DatabaseRestoreValue,
  type FingerprintedSchemaObject,
} from '../../../contracts/database-backup';
import {
  DATABASE_RESTORE_JOURNAL_TABLE,
  SCHEMA_UPGRADE_GUARD_TABLE,
} from '../system/schema-upgrade-state';
import {
  parseStoredOperationsInitiator,
  type OperationsInitiator,
} from './initiator';

const utf8Encoder = new TextEncoder();
const QUERY_BATCH_SIZE = 80;
const ROW_PAGE_SIZE = 200;
const MAX_EXPORT_D1_STATEMENTS = 900;
const MAX_RESTORE_REQUEST_D1_STATEMENTS = 950;
const RESERVED_VALIDATION_PREFIX = 'zeropress_restore_validation_';
const RESTORE_JOURNAL_TABLE = DATABASE_RESTORE_JOURNAL_TABLE;
const MAX_RESTORE_VALUE_BYTES = 2_000_000;

type SchemaObjectRow = {
  type: unknown;
  name: unknown;
  table_name: unknown;
  sql: unknown;
};

type TableColumnRow = {
  name: unknown;
  pk: unknown;
};

export type DatabaseSchemaSnapshot = {
  objects: FingerprintedSchemaObject[];
  tables: FingerprintedSchemaObject[];
  managedVirtualTables: DatabaseBackupManagedVirtualTable[];
  fingerprint: string;
};

export type DatabaseBackupExport = {
  sql: string;
  filename: string;
  manifest: DatabaseBackupManifest;
};

export type DatabaseRestoreResult = {
  database: DatabaseBackupTarget;
  mode: 'structure_and_data' | 'data_only';
  restoredTables: DatabaseBackupTable[];
  restoredStatementCount: number;
  schemaFingerprint: string;
  initiator: OperationsInitiator | null;
};

export type DatabaseRestoreStartResult = {
  database: DatabaseBackupTarget;
  mode: 'structure_and_data' | 'data_only';
  restoreId: string;
  expectedChunkCount: number;
};

export type DatabaseRestoreChunkResult = {
  database: DatabaseBackupTarget;
  restoreId: string;
  acceptedChunk: number;
  nextChunk: number;
  replayed: boolean;
};

export type DatabaseBackupServiceIssue =
  | 'not_available'
  | 'target_mismatch'
  | 'schema_mismatch'
  | 'state_conflict'
  | 'unsupported_restore_mode'
  | 'limit_exceeded';

export class DatabaseBackupServiceError extends Error {
  constructor(
    public readonly issue: DatabaseBackupServiceIssue,
    message: string,
  ) {
    super(message);
    this.name = 'DatabaseBackupServiceError';
  }
}

function quotedIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(identifier)) {
    throw new TypeError('The database contains an unsupported identifier.');
  }
  if (
    identifier.startsWith(RESERVED_VALIDATION_PREFIX)
    || identifier === RESTORE_JOURNAL_TABLE
    || identifier === SCHEMA_UPGRADE_GUARD_TABLE
  ) {
    throw new TypeError('The database contains a reserved identifier.');
  }
  return `"${identifier}"`;
}

function stripFinalSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/u, '');
}

function isApplicationObjectName(name: string): boolean {
  return !name.startsWith('sqlite_')
    && !name.startsWith('_cf_')
    && !name.startsWith('d1_')
    && name !== RESTORE_JOURNAL_TABLE
    && name !== SCHEMA_UPGRADE_GUARD_TABLE;
}

const MANAGED_FTS5_TABLE_NAMES = new Set([
  'post_search_fts',
  'page_search_fts',
]);

function fts5ShadowTables(name: string): string[] {
  return [
    `${name}_config`,
    `${name}_content`,
    `${name}_data`,
    `${name}_docsize`,
    `${name}_idx`,
  ].sort();
}

function managedVirtualTableFromObject(
  object: FingerprintedSchemaObject,
): DatabaseBackupManagedVirtualTable | null {
  const match = /^CREATE\s+VIRTUAL\s+TABLE\s+"?([a-z][a-z0-9_]*)"?\s+USING\s+([a-z][a-z0-9_]*)\b/iu.exec(
    object.sql,
  );
  if (!match) return null;
  const name = match[1]?.toLowerCase();
  const module = match[2]?.toLowerCase();
  if (
    !name
    || module !== 'fts5'
    || !MANAGED_FTS5_TABLE_NAMES.has(name)
    || object.type !== 'table'
    || object.name !== name
  ) {
    throw new TypeError('The database contains an unsupported virtual table.');
  }
  return {
    name,
    module: 'fts5',
    shadow_tables: fts5ShadowTables(name),
  };
}

function parseSchemaObject(row: SchemaObjectRow): FingerprintedSchemaObject {
  if (
    (row.type !== 'table'
      && row.type !== 'index'
      && row.type !== 'trigger'
      && row.type !== 'view')
    || typeof row.name !== 'string'
    || typeof row.table_name !== 'string'
    || typeof row.sql !== 'string'
  ) {
    throw new TypeError('D1 returned malformed sqlite_schema metadata.');
  }
  quotedIdentifier(row.name);
  quotedIdentifier(row.table_name);
  return {
    type: row.type,
    name: row.name,
    table_name: row.table_name,
    sql: stripFinalSemicolon(row.sql),
  };
}

export async function readDatabaseSchemaSnapshot(
  db: D1Database,
  options: { allowEmpty?: boolean } = {},
): Promise<DatabaseSchemaSnapshot> {
  const result = await db.prepare(`
    SELECT
      type,
      name,
      tbl_name AS table_name,
      sql
    FROM sqlite_schema
    WHERE sql IS NOT NULL
      AND type IN ('table', 'index', 'trigger', 'view')
    ORDER BY type, name
  `).all<SchemaObjectRow>();
  if (!Array.isArray(result.results)) {
    throw new TypeError('D1 returned an invalid sqlite_schema result.');
  }
  const rawObjects = result.results
    .filter((row) =>
      typeof row.name === 'string' && isApplicationObjectName(row.name))
    .map(parseSchemaObject);
  const managedVirtualTables = rawObjects
    .map(managedVirtualTableFromObject)
    .filter((entry): entry is DatabaseBackupManagedVirtualTable =>
      entry !== null)
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const managedShadowNames = new Set(
    managedVirtualTables.flatMap(({ shadow_tables }) => shadow_tables),
  );
  for (const shadowName of managedShadowNames) {
    if (!rawObjects.some((object) =>
      object.type === 'table' && object.name === shadowName)) {
      throw new TypeError('A managed virtual table is missing a shadow table.');
    }
  }
  const objects = rawObjects.filter((object) =>
    !managedShadowNames.has(object.name));
  const virtualNames = new Set(managedVirtualTables.map(({ name }) => name));
  const tables = objects.filter((object) =>
    object.type === 'table' && !virtualNames.has(object.name));
  if (tables.length === 0 && options.allowEmpty !== true) {
    throw new DatabaseBackupServiceError(
      'not_available',
      'The selected database has no application schema to transfer.',
    );
  }
  return {
    objects,
    tables,
    managedVirtualTables,
    fingerprint: await createSchemaFingerprint(objects),
  };
}

async function readStudioSchemaVersion(
  db: D1Database,
  snapshot: DatabaseSchemaSnapshot,
): Promise<number | null> {
  if (!snapshot.tables.some(({ name }) => name === 'zeropress_schema_state')) {
    return null;
  }
  let row: { schema_version?: unknown } | null;
  try {
    row = await db.prepare(`
      SELECT schema_version
      FROM zeropress_schema_state
      WHERE id = 1
      LIMIT 1
    `).first<{ schema_version?: unknown }>();
  } catch {
    // A recovery backup must still be possible when this optional lifecycle
    // annotation cannot be read from an otherwise exportable schema.
    return null;
  }
  return typeof row?.schema_version === 'number'
    && Number.isInteger(row.schema_version)
    && row.schema_version >= 0
    ? row.schema_version
    : null;
}

async function readTableCounts(
  db: D1Database,
  tables: readonly FingerprintedSchemaObject[],
): Promise<DatabaseBackupTable[]> {
  const counts: DatabaseBackupTable[] = [];
  for (let offset = 0; offset < tables.length; offset += QUERY_BATCH_SIZE) {
    const chunk = tables.slice(offset, offset + QUERY_BATCH_SIZE);
    const results = await db.batch(chunk.map(({ name }) => db.prepare(
      `SELECT COUNT(*) AS row_count FROM ${quotedIdentifier(name)}`,
    )));
    for (const [index, result] of results.entries()) {
      const row = result.results?.[0] as { row_count?: unknown } | undefined;
      const rowCount = row?.row_count;
      if (
        typeof rowCount !== 'number'
        || !Number.isSafeInteger(rowCount)
        || rowCount < 0
      ) {
        throw new TypeError('D1 returned an invalid table row count.');
      }
      counts.push({ name: chunk[index]!.name, row_count: rowCount });
    }
  }
  return counts;
}

async function readTableColumns(
  db: D1Database,
  table: string,
): Promise<{ names: string[]; orderBy: string }> {
  const result = await db.prepare(
    `PRAGMA table_info(${quotedIdentifier(table)})`,
  ).all<TableColumnRow>();
  if (!Array.isArray(result.results) || result.results.length === 0) {
    throw new TypeError('D1 returned invalid table-column metadata.');
  }
  const columns = result.results.map((row) => {
    if (typeof row.name !== 'string') {
      throw new TypeError('D1 returned an invalid column name.');
    }
    quotedIdentifier(row.name);
    const pk = typeof row.pk === 'number' && Number.isInteger(row.pk)
      ? row.pk
      : 0;
    return { name: row.name, pk };
  });
  const primaryKey = columns
    .filter(({ pk }) => pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map(({ name }) => quotedIdentifier(name));
  return {
    names: columns.map(({ name }) => name),
    orderBy: primaryKey.length > 0 ? primaryKey.join(', ') : 'rowid',
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function toBytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function sqlValue(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('D1 returned a non-finite numeric value.');
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError('D1 returned an integer outside JavaScript safe range.');
    }
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') {
    if (value.includes('\u0000')) {
      return `CAST(X'${bytesToHex(utf8Encoder.encode(value))}' AS TEXT)`;
    }
    return `'${value.replace(/'/gu, "''")}'`;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return `X'${bytesToHex(toBytes(value))}'`;
  }
  if (
    Array.isArray(value)
    && value.every((entry) =>
      typeof entry === 'number'
      && Number.isInteger(entry)
      && entry >= 0
      && entry <= 255)
  ) {
    return `X'${bytesToHex(Uint8Array.from(value))}'`;
  }
  throw new TypeError('D1 returned an unsupported SQL value.');
}

async function appendTableInserts(input: {
  db: D1Database;
  table: FingerprintedSchemaObject;
  expectedRows: number;
  statements: string[];
  contentSearchState?: {
    postCount: number;
    pageCount: number;
    updatedAtIso: string;
  };
}): Promise<void> {
  if (input.expectedRows === 0) return;
  const columns = await readTableColumns(input.db, input.table.name);
  const columnSql = columns.names.map(quotedIdentifier).join(', ');
  const prefix = `INSERT INTO ${quotedIdentifier(input.table.name)} (${columnSql}) VALUES `;
  let current = '';
  let readRows = 0;

  for (let offset = 0; offset < input.expectedRows; offset += ROW_PAGE_SIZE) {
    const result = await input.db.prepare(`
      SELECT *
      FROM ${quotedIdentifier(input.table.name)}
      ORDER BY ${columns.orderBy}
      LIMIT ? OFFSET ?
    `).bind(ROW_PAGE_SIZE, offset).all<Record<string, unknown>>();
    if (!Array.isArray(result.results)) {
      throw new TypeError('D1 returned an invalid table-data result.');
    }
    for (const selectedRow of result.results) {
      const row = input.table.name === 'content_search_index_state'
          && input.contentSearchState
        ? {
            ...selectedRow,
            state: 'rebuild_required',
            reason: 'database_restore',
            phase: null,
            operation_id: null,
            post_public_id_cursor: 0,
            page_public_id_cursor: 0,
            processed_posts: 0,
            processed_pages: 0,
            total_posts: input.contentSearchState.postCount,
            total_pages: input.contentSearchState.pageCount,
            started_at_iso: null,
            initiated_by_user_id: null,
            initiated_by_user_email: null,
            updated_at_iso: input.contentSearchState.updatedAtIso,
          }
        : selectedRow;
      const tuple = `(${columns.names.map((name) => {
        if (!Object.hasOwn(row, name)) {
          throw new TypeError('D1 omitted a selected table column.');
        }
        return sqlValue(row[name]);
      }).join(', ')})`;
      const candidate = current.length === 0
        ? `${prefix}${tuple}`
        : `${current}, ${tuple}`;
      if (
        current.length > 0
        && utf8Encoder.encode(candidate).byteLength
          > DATABASE_BACKUP_INSERT_TARGET_BYTES
      ) {
        input.statements.push(current);
        current = `${prefix}${tuple}`;
      } else {
        current = candidate;
      }
      readRows += 1;
    }
  }
  if (readRows !== input.expectedRows) {
    throw new Error('The database changed while the SQL backup was generated.');
  }
  if (current.length > 0) input.statements.push(current);
}

function objectDropStatement(object: FingerprintedSchemaObject): string {
  return `DROP ${object.type.toUpperCase()} IF EXISTS ${quotedIdentifier(object.name)}`;
}

function referencedTables(sql: string): string[] {
  const references: string[] = [];
  for (const match of sql.matchAll(
    /\bREFERENCES\s+(?:"([a-z][a-z0-9_]*)"|([a-z][a-z0-9_]*))/giu,
  )) {
    const name = match[1] ?? match[2];
    if (name) references.push(name.toLowerCase());
  }
  return references;
}

function dependencyOrderedTableDrops(
  tables: readonly FingerprintedSchemaObject[],
): FingerprintedSchemaObject[] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const outgoing = new Map<string, Set<string>>();
  const incomingCount = new Map(tables.map((table) => [table.name, 0]));
  for (const table of tables) {
    const parents = new Set(
      referencedTables(table.sql).filter((name) =>
        name !== table.name && byName.has(name)),
    );
    outgoing.set(table.name, parents);
    for (const parent of parents) {
      incomingCount.set(parent, (incomingCount.get(parent) ?? 0) + 1);
    }
  }
  const ready = [...tables]
    .filter((table) => incomingCount.get(table.name) === 0)
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const ordered: FingerprintedSchemaObject[] = [];
  while (ready.length > 0) {
    const table = ready.shift()!;
    ordered.push(table);
    for (const parent of outgoing.get(table.name) ?? []) {
      const next = (incomingCount.get(parent) ?? 0) - 1;
      incomingCount.set(parent, next);
      if (next === 0) {
        ready.push(byName.get(parent)!);
        ready.sort((left, right) => left.name.localeCompare(right.name, 'en'));
      }
    }
  }
  if (ordered.length !== tables.length) {
    const included = new Set(ordered.map(({ name }) => name));
    ordered.push(...tables
      .filter(({ name }) => !included.has(name))
      .sort((left, right) => left.name.localeCompare(right.name, 'en')));
  }
  return ordered;
}

function orderedDrops(objects: readonly FingerprintedSchemaObject[]): string[] {
  const weight: Record<FingerprintedSchemaObject['type'], number> = {
    view: 0,
    trigger: 1,
    index: 2,
    table: 3,
  };
  const secondary = objects
    .filter(({ type }) => type !== 'table')
    .sort((left, right) =>
      weight[left.type] - weight[right.type]
      || right.name.localeCompare(left.name, 'en'));
  const tables = dependencyOrderedTableDrops(
    objects.filter(({ type }) => type === 'table'),
  );
  return [...secondary, ...tables].map(objectDropStatement);
}

function schemaCatalog(
  objects: readonly FingerprintedSchemaObject[],
): DatabaseBackupSchemaObject[] {
  return objects.map(({ type, name, table_name }) => ({
    type,
    name,
    table_name,
  }));
}

function backupFilename(input: {
  database: DatabaseBackupTarget;
  mode: DatabaseBackupMode;
  now: Date;
}): string {
  return `zeropress-${input.database}-${input.mode}-${input.now
    .toISOString()
    .replace(/[:.]/gu, '-')}.sql`;
}

export async function exportDatabaseBackup(input: {
  db: D1Database;
  database: DatabaseBackupTarget;
  mode: DatabaseBackupMode;
  now?: Date;
}): Promise<DatabaseBackupExport> {
  const now = input.now ?? new Date();
  const snapshot = await readDatabaseSchemaSnapshot(input.db);
  const orderedTables = dependencyOrderedTableDrops(snapshot.tables).reverse();
  const studioSchemaVersion = input.database === 'studio'
    ? await readStudioSchemaVersion(input.db, snapshot)
    : null;
  const tables = await readTableCounts(input.db, orderedTables);
  const tableCounts = new Map(tables.map(({ name, row_count }) => [
    name,
    row_count,
  ]));
  if (
    input.database === 'studio'
    && orderedTables.some(({ name }) => name === 'content_search_index_state')
    && input.mode !== 'structure_only'
    && tableCounts.get('content_search_index_state') !== 1
  ) {
    throw new DatabaseBackupServiceError(
      'not_available',
      'The Studio content-search lifecycle singleton is malformed.',
    );
  }
  const estimatedD1Statements = (
    // Initial/final schema reads and optional Studio lifecycle annotations.
    2 + (input.database === 'studio' ? 2 : 0)
    // Initial and final table-count statements.
    + tables.length * 2
    + (input.mode === 'structure_only'
      ? 0
      : tables.length + tables.reduce(
          (total, table) => total + Math.ceil(table.row_count / ROW_PAGE_SIZE),
          0,
        ))
  );
  if (estimatedD1Statements > MAX_EXPORT_D1_STATEMENTS) {
    throw new DatabaseBackupServiceError(
      'limit_exceeded',
      'The logical export would exceed the per-invocation D1 safety budget.',
    );
  }
  const statements: string[] = [];
  statements.push('PRAGMA defer_foreign_keys = TRUE');

  if (input.mode !== 'data_only') {
    for (const statement of orderedDrops(snapshot.objects)) {
      statements.push(statement);
    }
    for (const object of orderedTables) {
      statements.push(object.sql);
    }
    const logicalTableNames = new Set(orderedTables.map(({ name }) => name));
    for (const object of snapshot.objects
      .filter(({ type, name }) =>
        type === 'table' && !logicalTableNames.has(name))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      statements.push(object.sql);
    }
  } else {
    for (const table of [...orderedTables].reverse()) {
      statements.push(`DELETE FROM ${quotedIdentifier(table.name)}`);
    }
  }

  if (input.mode !== 'structure_only') {
    for (const table of orderedTables) {
      await appendTableInserts({
        db: input.db,
        table,
        expectedRows: tableCounts.get(table.name) ?? 0,
        statements,
        contentSearchState: input.database === 'studio'
          ? {
              postCount: tableCounts.get('posts') ?? 0,
              pageCount: tableCounts.get('pages') ?? 0,
              updatedAtIso: now.toISOString(),
            }
          : undefined,
      });
    }
  }

  if (input.mode !== 'data_only') {
    for (const object of snapshot.objects.filter(({ type }) => type !== 'table')) {
      statements.push(object.sql);
    }
  }

  const finalSnapshot = await readDatabaseSchemaSnapshot(input.db);
  const finalTableByName = new Map(
    finalSnapshot.tables.map((table) => [table.name, table]),
  );
  const finalTables = await readTableCounts(
    input.db,
    orderedTables.map((table) => finalTableByName.get(table.name) ?? table),
  );
  const finalStudioSchemaVersion = input.database === 'studio'
    ? await readStudioSchemaVersion(input.db, finalSnapshot)
    : null;
  if (
    finalSnapshot.fingerprint !== snapshot.fingerprint
    || JSON.stringify(finalTables) !== JSON.stringify(tables)
    || finalStudioSchemaVersion !== studioSchemaVersion
  ) {
    throw new Error('The database changed while the SQL backup was generated.');
  }

  const manifest: DatabaseBackupManifest = {
    format: 'zeropress-studio-sql-backup',
    format_version: 2,
    database: input.database,
    mode: input.mode,
    exported_at_iso: now.toISOString(),
    schema_fingerprint: snapshot.fingerprint,
    studio_schema_version: studioSchemaVersion,
    schema_objects: schemaCatalog(snapshot.objects),
    tables,
    managed_virtual_tables: snapshot.managedVirtualTables,
  };
  const footer = {
    manifest_sha256: await createManifestSha256(manifest),
    statement_count: statements.length,
    statement_chain_sha256: await createStatementChainSha256(statements),
  };
  const sql = serializeDatabaseBackupArtifact({ manifest, footer, statements });
  return {
    sql,
    filename: backupFilename({
      database: input.database,
      mode: input.mode,
      now,
    }),
    manifest,
  };
}

function createValidationTableName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${RESERVED_VALIDATION_PREFIX}${bytesToHex(bytes)}`;
}

function applicationSchemaCountSql(
  validationTable: string,
  manifest: DatabaseBackupManifest,
): string {
  const shadowExclusions = manifest.format_version === 2
    ? manifest.managed_virtual_tables
      .flatMap(({ shadow_tables }) => shadow_tables)
      .map((name) => `      AND name != '${name}'`)
      .join('\n')
    : '';
  return `
    SELECT COUNT(*)
    FROM sqlite_schema
    WHERE sql IS NOT NULL
      AND type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_cf_%'
      AND name NOT LIKE 'd1_%'
      AND name != '${validationTable}'
      AND name != '${RESTORE_JOURNAL_TABLE}'
      AND name != '${SCHEMA_UPGRADE_GUARD_TABLE}'
${shadowExclusions}
  `;
}

function validationStatements(input: {
  db: D1Database;
  manifest: DatabaseBackupManifest;
  validationTable: string;
}): D1PreparedStatement[] {
  if (!/^zeropress_restore_validation_[0-9a-f]{16}$/u.test(
    input.validationTable,
  )) {
    throw new TypeError('Invalid generated restore validation identifier.');
  }
  const validation = `"${input.validationTable}"`;
  return [
    input.db.prepare(`
      CREATE TABLE ${validation} (
        passed INTEGER NOT NULL CHECK (passed = 1)
      )
    `),
    input.db.prepare(`
      INSERT INTO ${validation} (passed)
      SELECT CASE WHEN (${applicationSchemaCountSql(
        input.validationTable,
        input.manifest,
      )}) = ?
        THEN 1 ELSE 0 END
    `).bind(input.manifest.schema_objects.length),
    ...input.manifest.schema_objects.map((object) => input.db.prepare(`
      INSERT INTO ${validation} (passed)
      SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM sqlite_schema
        WHERE type = ?
          AND name = ?
          AND tbl_name = ?
          AND sql IS NOT NULL
      ) THEN 1 ELSE 0 END
    `).bind(object.type, object.name, object.table_name)),
    ...input.manifest.tables.map((table) => input.db.prepare(`
      INSERT INTO ${validation} (passed)
      SELECT CASE WHEN (
        SELECT COUNT(*) FROM ${quotedIdentifier(table.name)}
      ) = ? THEN 1 ELSE 0 END
    `).bind(table.row_count)),
    input.db.prepare(`
      INSERT INTO ${validation} (passed)
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM pragma_foreign_key_check
      ) THEN 1 ELSE 0 END
    `),
    input.db.prepare(`DROP TABLE ${validation}`),
  ];
}

type RestoreJournalRow = {
  restore_id: unknown;
  artifact_digest: unknown;
  database_name: unknown;
  mode: unknown;
  manifest_json: unknown;
  manifest_sha256: unknown;
  secondary_sha256: unknown;
  artifact_statement_count: unknown;
  expected_chunk_count: unknown;
  next_chunk: unknown;
  initiated_by_user_id: unknown;
  initiated_by_user_email: unknown;
};

type RestoreJournal = {
  restoreId: string;
  artifactDigest: string;
  database: DatabaseBackupTarget;
  mode: 'structure_and_data' | 'data_only';
  manifest: DatabaseBackupManifest;
  manifestSha256: string;
  secondarySha256: string;
  artifactStatementCount: number;
  expectedChunkCount: number;
  nextChunk: number;
  initiator: OperationsInitiator | null;
};

function restoreId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

function isCreateTableStatement(statement: string): boolean {
  return /^CREATE\s+(?:VIRTUAL\s+)?TABLE\s+/iu.test(statement);
}

function isCreateSecondaryStatement(statement: string): boolean {
  return /^CREATE\s+(?:(?:UNIQUE\s+)?INDEX|TRIGGER|VIEW)\s+/iu.test(
    statement,
  );
}

function ensureSchemaStatementSize(statements: readonly string[]): void {
  if (statements.some((statement) => utf8Encoder.encode(statement).byteLength > 100_000)) {
    throw new DatabaseBackupServiceError(
      'limit_exceeded',
      'A schema statement exceeds the D1 SQL statement limit.',
    );
  }
}

function ensureRestoreRequestStatementBudget(statementCount: number): void {
  if (statementCount > MAX_RESTORE_REQUEST_D1_STATEMENTS) {
    throw new DatabaseBackupServiceError(
      'limit_exceeded',
      'One restore phase exceeds the per-request D1 statement budget.',
    );
  }
}

function restoreChunkCountRange(manifest: DatabaseBackupManifest): {
  minimum: number;
  maximum: number;
} {
  return {
    minimum: manifest.tables.reduce(
    (total, table) => total + Math.ceil(
      table.row_count / DATABASE_RESTORE_MAX_ROWS_PER_CHUNK,
    ),
    0,
    ),
    maximum: manifest.tables.reduce(
      (total, table) => total + table.row_count,
      0,
    ),
  };
}

function restoreJournalCreateSql(): string {
  return `
    CREATE TABLE "${RESTORE_JOURNAL_TABLE}" (
      restore_id TEXT PRIMARY KEY CHECK (length(restore_id) = 32),
      artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 64),
      database_name TEXT NOT NULL CHECK (database_name IN ('studio', 'edge')),
      mode TEXT NOT NULL CHECK (mode IN ('structure_and_data', 'data_only')),
      manifest_json TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
      secondary_sha256 TEXT NOT NULL CHECK (length(secondary_sha256) = 64),
      artifact_statement_count INTEGER NOT NULL CHECK (artifact_statement_count > 0),
      expected_chunk_count INTEGER NOT NULL CHECK (expected_chunk_count >= 0),
      next_chunk INTEGER NOT NULL DEFAULT 0
        CHECK (next_chunk >= 0 AND next_chunk <= expected_chunk_count),
      initiated_by_user_id TEXT CHECK (
        initiated_by_user_id IS NULL OR (
          length(initiated_by_user_id) = 32
          AND initiated_by_user_id NOT GLOB '*[^0-9a-f]*'
        )
      ),
      initiated_by_user_email TEXT CHECK (
        initiated_by_user_email IS NULL OR (
          length(initiated_by_user_email) BETWEEN 3 AND 254
          AND initiated_by_user_email = lower(initiated_by_user_email)
          AND initiated_by_user_email = trim(initiated_by_user_email)
        )
      ),
      created_at_iso TEXT NOT NULL,
      updated_at_iso TEXT NOT NULL,
      CHECK (
        (initiated_by_user_id IS NULL) =
        (initiated_by_user_email IS NULL)
      )
    )
  `;
}

async function readRestoreJournal(db: D1Database): Promise<RestoreJournal | null> {
  const exists = await db.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).bind(RESTORE_JOURNAL_TABLE).first<{ present?: unknown }>();
  if (exists?.present !== 1) return null;
  const row = await db.prepare(`
    SELECT
      restore_id,
      artifact_digest,
      database_name,
      mode,
      manifest_json,
      manifest_sha256,
      secondary_sha256,
      artifact_statement_count,
      expected_chunk_count,
      next_chunk,
      initiated_by_user_id,
      initiated_by_user_email
    FROM "${RESTORE_JOURNAL_TABLE}"
    LIMIT 1
  `).first<RestoreJournalRow>();
  if (!row) return null;
  if (
    typeof row.restore_id !== 'string'
    || typeof row.artifact_digest !== 'string'
    || (row.database_name !== 'studio' && row.database_name !== 'edge')
    || (row.mode !== 'structure_and_data' && row.mode !== 'data_only')
    || typeof row.manifest_json !== 'string'
    || typeof row.manifest_sha256 !== 'string'
    || typeof row.secondary_sha256 !== 'string'
    || typeof row.artifact_statement_count !== 'number'
    || !Number.isInteger(row.artifact_statement_count)
    || typeof row.expected_chunk_count !== 'number'
    || !Number.isInteger(row.expected_chunk_count)
    || typeof row.next_chunk !== 'number'
    || !Number.isInteger(row.next_chunk)
  ) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'The database restore journal is malformed.',
    );
  }
  let manifest: DatabaseBackupManifest;
  try {
    manifest = databaseBackupManifestSchema.parse(JSON.parse(row.manifest_json));
  } catch {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'The database restore journal manifest is malformed.',
    );
  }
  if (await createManifestSha256(manifest) !== row.manifest_sha256) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'The database restore journal manifest checksum is invalid.',
    );
  }
  if (
    manifest.mode === 'structure_only'
    || manifest.database !== row.database_name
    || manifest.mode !== row.mode
  ) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'The database restore journal manifest does not match its state.',
    );
  }
  return {
    restoreId: row.restore_id,
    artifactDigest: row.artifact_digest,
    database: row.database_name,
    mode: row.mode,
    manifest,
    manifestSha256: row.manifest_sha256,
    secondarySha256: row.secondary_sha256,
    artifactStatementCount: row.artifact_statement_count,
    expectedChunkCount: row.expected_chunk_count,
    nextChunk: row.next_chunk,
    initiator: parseStoredOperationsInitiator({
      userId: row.initiated_by_user_id,
      userEmail: row.initiated_by_user_email,
    }),
  };
}

export async function readDatabaseRestoreInitiator(
  db: D1Database,
): Promise<OperationsInitiator | null> {
  return (await readRestoreJournal(db))?.initiator ?? null;
}

export async function isDatabaseRestoreInProgress(
  db: D1Database,
): Promise<boolean> {
  return (await readRestoreJournal(db)) !== null;
}

function requireMatchingJournal(input: {
  journal: RestoreJournal | null;
  database: DatabaseBackupTarget;
  restoreId: string;
  artifactDigest: string;
}): RestoreJournal {
  const journal = input.journal;
  if (
    !journal
    || journal.database !== input.database
    || journal.restoreId !== input.restoreId
    || journal.artifactDigest !== input.artifactDigest
  ) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'The database restore state does not match this request.',
    );
  }
  return journal;
}

export async function startDatabaseRestore(input: {
  db: D1Database;
  database: DatabaseBackupTarget;
  request: DatabaseRestoreStartRequest;
  requireReadyStudioLifecycle?: boolean;
  initiator?: OperationsInitiator | null;
  beforeBatch?: () => void;
}): Promise<DatabaseRestoreStartResult> {
  const { request } = input;
  if (
    request.database !== input.database
    || request.manifest.database !== input.database
  ) {
    throw new DatabaseBackupServiceError(
      'target_mismatch',
      'The selected D1 binding does not match the backup target.',
    );
  }
  if (request.manifest.mode === 'structure_only') {
    throw new DatabaseBackupServiceError(
      'unsupported_restore_mode',
      'Structure-only artifacts are export-only in Studio.',
    );
  }
  if (await createManifestSha256(request.manifest) !== request.manifest_sha256) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'The restore manifest checksum does not match the request.',
    );
  }
  const chunkRange = restoreChunkCountRange(request.manifest);
  if (
    request.expected_chunk_count < chunkRange.minimum
    || request.expected_chunk_count > chunkRange.maximum
  ) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'The restore chunk count does not match the manifest.',
    );
  }
  if (request.manifest.mode === 'structure_and_data') {
    const expectedTableStatements = request.manifest.tables.length
      + (request.manifest.format_version === 2
        ? request.manifest.managed_virtual_tables.length
        : 0);
    if (
      request.table_statements.length !== expectedTableStatements
      || !request.table_statements.every(isCreateTableStatement)
      || !request.secondary_statements.every(isCreateSecondaryStatement)
    ) {
      throw new DatabaseBackupServiceError(
        'state_conflict',
        'The restore schema statement phases are invalid.',
      );
    }
    await validateDatabaseBackupSchemaCatalog(
      request.manifest,
      [...request.table_statements, ...request.secondary_statements],
    );
  } else if (
    request.table_statements.length !== 0
    || request.secondary_statements.length !== 0
  ) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'A data-only restore cannot provide schema statements.',
    );
  }
  ensureSchemaStatementSize([
    ...request.table_statements,
    ...request.secondary_statements,
  ]);
  ensureRestoreRequestStatementBudget(
    (input.requireReadyStudioLifecycle ? 8 : 5)
    + request.secondary_statements.length
    + request.manifest.schema_objects.length
    + request.manifest.tables.length,
  );

  const current = await readDatabaseSchemaSnapshot(input.db, {
    allowEmpty: request.manifest.mode === 'structure_and_data',
  });
  if (
    request.manifest.mode === 'data_only'
    && current.fingerprint !== request.manifest.schema_fingerprint
  ) {
    throw new DatabaseBackupServiceError(
      'schema_mismatch',
      'A data-only backup requires an exact current schema match.',
    );
  }

  const id = restoreId();
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    input.db.prepare('PRAGMA defer_foreign_keys = TRUE'),
  ];
  let lifecycleValidationTable: string | null = null;
  if (input.requireReadyStudioLifecycle) {
    lifecycleValidationTable = createValidationTableName();
    statements.push(
      input.db.prepare(`
        CREATE TABLE "${lifecycleValidationTable}" (
          passed INTEGER NOT NULL CHECK (passed = 1)
        )
      `),
      input.db.prepare(`
        INSERT INTO "${lifecycleValidationTable}" (passed)
        VALUES (COALESCE((
          SELECT 1
          FROM zeropress_schema_state
          WHERE id = 1
            AND lifecycle_state = 'ready'
            AND target_schema_version IS NULL
            AND active_operation_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM sqlite_schema
              WHERE type = 'table'
                AND name = '${SCHEMA_UPGRADE_GUARD_TABLE}'
            )
        ), 0))
      `),
    );
  }
  statements.push(
    input.db.prepare(`DROP TABLE IF EXISTS "${RESTORE_JOURNAL_TABLE}"`),
  );
  if (request.manifest.mode === 'structure_and_data') {
    statements.push(...orderedDrops(current.objects).map((statement) =>
      input.db.prepare(statement)));
    statements.push(...request.table_statements.map((statement) =>
      input.db.prepare(statement)));
  } else {
    const currentByName = new Map(current.tables.map((table) => [table.name, table]));
    const manifestOrder = request.manifest.tables.map((table) =>
      currentByName.get(table.name)!).filter(Boolean);
    for (const table of [...manifestOrder].reverse()) {
      statements.push(input.db.prepare(
        `DELETE FROM ${quotedIdentifier(table.name)}`,
      ));
    }
  }
  const secondarySha256 = await createStatementChainSha256(
    request.secondary_statements,
  );
  statements.push(
    input.db.prepare(restoreJournalCreateSql()),
    input.db.prepare(`
      INSERT INTO "${RESTORE_JOURNAL_TABLE}" (
        restore_id,
        artifact_digest,
        database_name,
        mode,
        manifest_json,
        manifest_sha256,
        secondary_sha256,
        artifact_statement_count,
        expected_chunk_count,
        next_chunk,
        initiated_by_user_id,
        initiated_by_user_email,
        created_at_iso,
        updated_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).bind(
      id,
      request.artifact_digest,
      input.database,
      request.manifest.mode,
      JSON.stringify(request.manifest),
      request.manifest_sha256,
      secondarySha256,
      request.artifact_statement_count,
      request.expected_chunk_count,
      input.initiator?.userId ?? null,
      input.initiator?.userEmail ?? null,
      now,
      now,
    ),
  );
  if (lifecycleValidationTable) {
    statements.push(input.db.prepare(
      `DROP TABLE "${lifecycleValidationTable}"`,
    ));
  }
  ensureRestoreRequestStatementBudget(statements.length);
  input.beforeBatch?.();
  await input.db.batch(statements);
  return {
    database: input.database,
    mode: request.manifest.mode,
    restoreId: id,
    expectedChunkCount: request.expected_chunk_count,
  };
}

function decodeBase64(value: string): ArrayBuffer {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'A restore chunk contains malformed binary data.',
    );
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  if (bytes.byteLength > MAX_RESTORE_VALUE_BYTES) {
    throw new DatabaseBackupServiceError(
      'limit_exceeded',
      'A restore value exceeds the D1 value-size limit.',
    );
  }
  return bytes.buffer;
}

function bindRestoreValue(value: DatabaseRestoreValue): unknown {
  if (typeof value === 'string') {
    if (utf8Encoder.encode(value).byteLength > MAX_RESTORE_VALUE_BYTES) {
      throw new DatabaseBackupServiceError(
        'limit_exceeded',
        'A restore value exceeds the D1 value-size limit.',
      );
    }
    return value;
  }
  if (value !== null && typeof value === 'object') {
    return decodeBase64(value.base64);
  }
  return value;
}

export async function applyDatabaseRestoreChunk(input: {
  db: D1Database;
  database: DatabaseBackupTarget;
  request: DatabaseRestoreChunkRequest;
}): Promise<DatabaseRestoreChunkResult> {
  if (input.request.database !== input.database) {
    throw new DatabaseBackupServiceError(
      'target_mismatch',
      'The restore chunk target does not match the selected D1 binding.',
    );
  }
  const journal = requireMatchingJournal({
    journal: await readRestoreJournal(input.db),
    database: input.database,
    restoreId: input.request.restore_id,
    artifactDigest: input.request.artifact_digest,
  });
  if (input.request.chunk_index < journal.nextChunk) {
    return {
      database: input.database,
      restoreId: journal.restoreId,
      acceptedChunk: input.request.chunk_index,
      nextChunk: journal.nextChunk,
      replayed: true,
    };
  }
  if (
    input.request.chunk_index !== journal.nextChunk
    || input.request.chunk_index >= journal.expectedChunkCount
  ) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'Restore chunks must be applied in order.',
    );
  }
  const expectedTable = journal.manifest.tables.find(
    (table) => table.name === input.request.table,
  );
  if (!expectedTable) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'The restore chunk table is not present in the manifest.',
    );
  }
  const tableColumns = await readTableColumns(input.db, input.request.table);
  if (JSON.stringify(tableColumns.names) !== JSON.stringify(input.request.columns)) {
    throw new DatabaseBackupServiceError(
      'schema_mismatch',
      'The restore chunk columns do not match the target table.',
    );
  }
  if (input.request.rows.some((row) => row.length !== input.request.columns.length)) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'A restore chunk row does not match its column list.',
    );
  }
  const countRow = await input.db.prepare(
    `SELECT COUNT(*) AS row_count FROM ${quotedIdentifier(input.request.table)}`,
  ).first<{ row_count?: unknown }>();
  const currentCount = countRow?.row_count;
  if (
    typeof currentCount !== 'number'
    || !Number.isSafeInteger(currentCount)
    || currentCount < 0
    || currentCount + input.request.rows.length > expectedTable.row_count
  ) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'The restore chunk would exceed the manifest row count.',
    );
  }
  const placeholders = input.request.columns.map(() => '?').join(', ');
  const insertSql = `INSERT INTO ${quotedIdentifier(input.request.table)} (${input.request.columns.map(quotedIdentifier).join(', ')}) VALUES (${placeholders})`;
  const nextChunk = journal.nextChunk + 1;
  const statements: D1PreparedStatement[] = [
    input.db.prepare('PRAGMA defer_foreign_keys = TRUE'),
    ...input.request.rows.map((row) => input.db.prepare(insertSql).bind(
      ...row.map(bindRestoreValue),
    )),
    input.db.prepare(`
      UPDATE "${RESTORE_JOURNAL_TABLE}"
      SET next_chunk = CASE
            WHEN next_chunk = ? THEN ?
            ELSE expected_chunk_count + 1
          END,
          updated_at_iso = ?
      WHERE restore_id = ?
        AND artifact_digest = ?
    `).bind(
      journal.nextChunk,
      nextChunk,
      new Date().toISOString(),
      journal.restoreId,
      journal.artifactDigest,
    ),
  ];
  await input.db.batch(statements);
  const updated = requireMatchingJournal({
    journal: await readRestoreJournal(input.db),
    database: input.database,
    restoreId: journal.restoreId,
    artifactDigest: journal.artifactDigest,
  });
  if (updated.nextChunk !== nextChunk) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'The restore journal did not advance with the data chunk.',
    );
  }
  return {
    database: input.database,
    restoreId: journal.restoreId,
    acceptedChunk: input.request.chunk_index,
    nextChunk,
    replayed: false,
  };
}

export async function finalizeDatabaseRestore(input: {
  db: D1Database;
  database: DatabaseBackupTarget;
  request: DatabaseRestoreFinalizeRequest;
}): Promise<DatabaseRestoreResult> {
  if (input.request.database !== input.database) {
    throw new DatabaseBackupServiceError(
      'target_mismatch',
      'The restore finalization target does not match the selected D1 binding.',
    );
  }
  const journal = requireMatchingJournal({
    journal: await readRestoreJournal(input.db),
    database: input.database,
    restoreId: input.request.restore_id,
    artifactDigest: input.request.artifact_digest,
  });
  if (
    input.request.expected_chunk_count !== journal.expectedChunkCount
    || journal.nextChunk !== journal.expectedChunkCount
  ) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'The restore cannot be finalized before every data chunk is applied.',
    );
  }
  const secondarySha256 = await createStatementChainSha256(
    input.request.secondary_statements,
  );
  if (secondarySha256 !== journal.secondarySha256) {
    throw new DatabaseBackupServiceError(
      'state_conflict',
      'The final schema statements do not match the restore start request.',
    );
  }
  ensureSchemaStatementSize(input.request.secondary_statements);

  const current = await readDatabaseSchemaSnapshot(input.db);
  if (journal.mode === 'structure_and_data') {
    if (!input.request.secondary_statements.every(isCreateSecondaryStatement)) {
      throw new DatabaseBackupServiceError(
        'state_conflict',
        'The final restore schema contains an unsupported statement.',
      );
    }
    await validateDatabaseBackupSchemaCatalog(
      journal.manifest,
      [
        ...current.objects
          .filter((object) => object.type === 'table')
          .map((table) => table.sql),
        ...input.request.secondary_statements,
      ],
    );
  } else if (
    input.request.secondary_statements.length !== 0
    || current.fingerprint !== journal.manifest.schema_fingerprint
  ) {
    throw new DatabaseBackupServiceError(
      'schema_mismatch',
      'The data-only restore target schema changed during restore.',
    );
  }

  const validationTable = createValidationTableName();
  const statements = [
    input.db.prepare('PRAGMA defer_foreign_keys = TRUE'),
    ...input.request.secondary_statements.map((statement) =>
      input.db.prepare(statement)),
    ...validationStatements({
      db: input.db,
      manifest: journal.manifest,
      validationTable,
    }),
    input.db.prepare(`DROP TABLE "${RESTORE_JOURNAL_TABLE}"`),
  ];
  ensureRestoreRequestStatementBudget(statements.length);
  await input.db.batch(statements);

  const restoredSnapshot = await readDatabaseSchemaSnapshot(input.db);
  if (restoredSnapshot.fingerprint !== journal.manifest.schema_fingerprint) {
    throw new Error('The restored database schema verification failed.');
  }
  return {
    database: input.database,
    mode: journal.mode,
    restoredTables: journal.manifest.tables,
    restoredStatementCount: journal.artifactStatementCount,
    schemaFingerprint: restoredSnapshot.fingerprint,
    initiator: journal.initiator,
  };
}

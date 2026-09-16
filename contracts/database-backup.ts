import { z } from 'zod';
import { splitSqlStatements } from './sql-statements';
import { apiErrorSchema } from './api';

export const DATABASE_BACKUP_FORMAT = 'zeropress-studio-sql-backup';
export const DATABASE_BACKUP_FORMAT_VERSION = 2;
export const DATABASE_RESTORE_CONFIRMATION = 'RESTORE DATABASE';

export const DATABASE_BACKUP_INSERT_TARGET_BYTES = 80_000;
export const DATABASE_RESTORE_MAX_ROWS_PER_CHUNK = 40;
export const DATABASE_RESTORE_MAX_CHUNK_BYTES = 6 * 1024 * 1024;
export const DATABASE_RESTORE_MAX_SCHEMA_STATEMENTS = 500;

export const databaseBackupTargetSchema = z.enum(['studio', 'edge']);
export const databaseBackupModeSchema = z.enum([
  'structure_and_data',
  'structure_only',
  'data_only',
]);
export const databaseRestoreModeSchema = z.enum([
  'structure_and_data',
  'data_only',
]);

const administratorCredentialsShape = {
  administrator_email: z.string()
    .trim()
    .toLowerCase()
    .pipe(z.email().max(254))
    .optional(),
  administrator_password: z.string().min(1).max(1024).optional(),
};

function credentialsArePaired(value: {
  administrator_email?: string;
  administrator_password?: string;
}): boolean {
  return (value.administrator_email === undefined)
    === (value.administrator_password === undefined);
}

export const databaseBackupRequestSchema = z.object({
  database: databaseBackupTargetSchema,
  mode: databaseBackupModeSchema,
  ...administratorCredentialsShape,
}).strict().refine(credentialsArePaired, {
  message: 'Administrator credentials must be provided together.',
});

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const restoreIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);

export const databaseRestoreStartRequestSchema = z.object({
  database: databaseBackupTargetSchema,
  manifest: z.lazy(() => databaseBackupManifestSchema),
  manifest_sha256: sha256Schema,
  artifact_digest: sha256Schema,
  artifact_statement_count: z.number().int().positive(),
  expected_chunk_count: z.number().int().nonnegative(),
  table_statements: z.array(z.string().trim().min(1))
    .max(DATABASE_RESTORE_MAX_SCHEMA_STATEMENTS),
  secondary_statements: z.array(z.string().trim().min(1))
    .max(DATABASE_RESTORE_MAX_SCHEMA_STATEMENTS),
  confirmation: z.literal(DATABASE_RESTORE_CONFIRMATION),
  ...administratorCredentialsShape,
}).strict().refine(credentialsArePaired, {
  message: 'Administrator credentials must be provided together.',
});

export const databaseRestoreBlobValueSchema = z.object({
  type: z.literal('blob'),
  base64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
}).strict();

export const databaseRestoreValueSchema = z.union([
  z.null(),
  z.string(),
  z.number().finite(),
  databaseRestoreBlobValueSchema,
]);

export const databaseRestoreChunkRequestSchema = z.object({
  database: databaseBackupTargetSchema,
  restore_id: restoreIdSchema,
  artifact_digest: sha256Schema,
  chunk_index: z.number().int().nonnegative(),
  table: z.string().regex(/^[a-z][a-z0-9_]*$/u),
  columns: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/u)).min(1),
  rows: z.array(z.array(databaseRestoreValueSchema))
    .min(1)
    .max(DATABASE_RESTORE_MAX_ROWS_PER_CHUNK),
}).strict();

export const databaseRestoreFinalizeRequestSchema = z.object({
  database: databaseBackupTargetSchema,
  restore_id: restoreIdSchema,
  artifact_digest: sha256Schema,
  expected_chunk_count: z.number().int().nonnegative(),
  secondary_statements: z.array(z.string().trim().min(1))
    .max(DATABASE_RESTORE_MAX_SCHEMA_STATEMENTS),
}).strict();

const safeIdentifierSchema = z.string().regex(/^[a-z][a-z0-9_]*$/u);
const schemaObjectTypeSchema = z.enum([
  'table',
  'index',
  'trigger',
  'view',
]);

export const databaseBackupSchemaObjectSchema = z.object({
  type: schemaObjectTypeSchema,
  name: safeIdentifierSchema,
  table_name: safeIdentifierSchema,
}).strict();

export const databaseBackupTableSchema = z.object({
  name: safeIdentifierSchema,
  row_count: z.number().int().nonnegative(),
}).strict();

export const databaseBackupManagedVirtualTableSchema = z.object({
  name: safeIdentifierSchema,
  module: z.literal('fts5'),
  shadow_tables: z.array(safeIdentifierSchema).min(1),
}).strict();

const databaseBackupManifestBodyShape = {
  database: databaseBackupTargetSchema,
  mode: databaseBackupModeSchema,
  exported_at_iso: z.iso.datetime({ offset: true }),
  schema_fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  studio_schema_version: z.number().int().nonnegative().nullable(),
  schema_objects: z.array(databaseBackupSchemaObjectSchema),
  tables: z.array(databaseBackupTableSchema).min(1),
};

export const databaseBackupManifestV1Schema = z.object({
  format: z.literal(DATABASE_BACKUP_FORMAT),
  format_version: z.literal(1),
  ...databaseBackupManifestBodyShape,
}).strict();

export const databaseBackupManifestV2Schema = z.object({
  format: z.literal(DATABASE_BACKUP_FORMAT),
  format_version: z.literal(DATABASE_BACKUP_FORMAT_VERSION),
  ...databaseBackupManifestBodyShape,
  managed_virtual_tables: z.array(databaseBackupManagedVirtualTableSchema),
}).strict();

export const databaseBackupManifestSchema = z.discriminatedUnion(
  'format_version',
  [databaseBackupManifestV1Schema, databaseBackupManifestV2Schema],
);

export const databaseBackupFooterSchema = z.object({
  manifest_sha256: sha256Schema,
  statement_count: z.number().int().positive(),
  statement_chain_sha256: sha256Schema,
}).strict();

export const databaseRestoreStartSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('restore_database'),
    status: z.literal('started'),
    database: databaseBackupTargetSchema,
    mode: databaseRestoreModeSchema,
    restore_id: restoreIdSchema,
    next_chunk: z.literal(0),
    expected_chunk_count: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const databaseRestoreChunkSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('restore_database'),
    status: z.literal('in_progress'),
    database: databaseBackupTargetSchema,
    restore_id: restoreIdSchema,
    accepted_chunk: z.number().int().nonnegative(),
    next_chunk: z.number().int().nonnegative(),
    replayed: z.boolean(),
  }).strict(),
}).strict();

export const databaseRestoreSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    operation: z.literal('restore_database'),
    status: z.literal('completed'),
    database: databaseBackupTargetSchema,
    mode: databaseRestoreModeSchema,
    restored_tables: z.array(databaseBackupTableSchema),
    restored_statement_count: z.number().int().positive(),
    schema_fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  }).strict(),
}).strict();

export const databaseRestoreResponseSchema = z.union([
  databaseRestoreSuccessSchema,
  apiErrorSchema,
]);

export const databaseRestoreStartResponseSchema = z.union([
  databaseRestoreStartSuccessSchema,
  apiErrorSchema,
]);

export const databaseRestoreChunkResponseSchema = z.union([
  databaseRestoreChunkSuccessSchema,
  apiErrorSchema,
]);

export const databaseTransferAvailabilitySchema = z.object({
  requires_administrator_credentials: z.boolean(),
  export_modes: z.tuple([
    z.literal('structure_and_data'),
    z.literal('structure_only'),
    z.literal('data_only'),
  ]),
  restore_modes: z.tuple([
    z.literal('structure_and_data'),
    z.literal('data_only'),
  ]),
  restore_confirmation: z.literal(DATABASE_RESTORE_CONFIRMATION),
  databases: z.object({
    studio: z.object({
      bound: z.literal(true),
      export_available: z.boolean(),
      restore_available: z.boolean(),
    }).strict(),
    edge: z.object({
      bound: z.boolean(),
      export_available: z.boolean(),
      restore_available: z.boolean(),
    }).strict(),
  }).strict(),
}).strict();

export type DatabaseBackupTarget = z.infer<
  typeof databaseBackupTargetSchema
>;
export type DatabaseBackupMode = z.infer<typeof databaseBackupModeSchema>;
export type DatabaseRestoreMode = z.infer<typeof databaseRestoreModeSchema>;
export type DatabaseBackupRequest = z.infer<
  typeof databaseBackupRequestSchema
>;
export type DatabaseRestoreStartRequest = z.infer<
  typeof databaseRestoreStartRequestSchema
>;
export type DatabaseRestoreChunkRequest = z.infer<
  typeof databaseRestoreChunkRequestSchema
>;
export type DatabaseRestoreFinalizeRequest = z.infer<
  typeof databaseRestoreFinalizeRequestSchema
>;
export type DatabaseRestoreValue = z.infer<typeof databaseRestoreValueSchema>;
export type DatabaseBackupSchemaObject = z.infer<
  typeof databaseBackupSchemaObjectSchema
>;
export type DatabaseBackupTable = z.infer<typeof databaseBackupTableSchema>;
export type DatabaseBackupManagedVirtualTable = z.infer<
  typeof databaseBackupManagedVirtualTableSchema
>;
export type DatabaseBackupManifest = z.infer<
  typeof databaseBackupManifestSchema
>;
export type DatabaseBackupFooter = z.infer<
  typeof databaseBackupFooterSchema
>;
export type DatabaseRestoreSuccess = z.infer<
  typeof databaseRestoreSuccessSchema
>;
export type DatabaseRestoreStartSuccess = z.infer<
  typeof databaseRestoreStartSuccessSchema
>;
export type DatabaseRestoreChunkSuccess = z.infer<
  typeof databaseRestoreChunkSuccessSchema
>;
export type DatabaseRestoreResponse = z.infer<
  typeof databaseRestoreResponseSchema
>;
export type DatabaseRestoreStartResponse = z.infer<
  typeof databaseRestoreStartResponseSchema
>;
export type DatabaseRestoreChunkResponse = z.infer<
  typeof databaseRestoreChunkResponseSchema
>;
export type DatabaseTransferAvailability = z.infer<
  typeof databaseTransferAvailabilitySchema
>;

const MANIFEST_PREFIX = '-- zeropress-backup-manifest: ';
const FOOTER_PREFIX = '-- zeropress-backup-footer: ';
const utf8Encoder = new TextEncoder();
const STUDIO_MANAGED_VIRTUAL_TABLES = new Set([
  'post_search_fts',
  'page_search_fts',
]);

export type DatabaseBackupArtifactInspection = {
  manifest: DatabaseBackupManifest;
  footer: DatabaseBackupFooter;
  statements: string[];
  sizeBytes: number;
};

export type DatabaseBackupArtifactIssue =
  | 'invalid_artifact'
  | 'limit_exceeded'
  | 'unsupported_restore_mode';

export class DatabaseBackupArtifactError extends Error {
  constructor(
    public readonly issue: DatabaseBackupArtifactIssue,
    message: string,
  ) {
    super(message);
    this.name = 'DatabaseBackupArtifactError';
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(value: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const owned = new Uint8Array(new ArrayBuffer(value.byteLength));
  owned.set(value);
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', owned.buffer)),
  );
}

export async function createStatementChainSha256(
  statements: readonly string[],
): Promise<string> {
  let previous: Uint8Array<ArrayBuffer> = new Uint8Array(
    new ArrayBuffer(32),
  );
  for (const statement of statements) {
    const statementBytes = utf8Encoder.encode(`${statement};`);
    const chained = new Uint8Array(previous.byteLength + statementBytes.byteLength);
    chained.set(previous, 0);
    chained.set(statementBytes, previous.byteLength);
    previous = hexToBytes(await sha256Hex(chained));
  }
  return bytesToHex(previous);
}

export async function createManifestSha256(
  manifest: DatabaseBackupManifest,
): Promise<string> {
  return sha256Hex(utf8Encoder.encode(JSON.stringify(manifest)));
}

export type FingerprintedSchemaObject = DatabaseBackupSchemaObject & {
  sql: string;
};

export async function createSchemaFingerprint(
  objects: readonly FingerprintedSchemaObject[],
): Promise<string> {
  const canonical = [...objects]
    .map((object) => ({
      type: object.type,
      name: object.name,
      table_name: object.table_name,
      sql: object.sql.trim().replace(/;\s*$/u, ''),
    }))
    .sort((left, right) =>
      left.type.localeCompare(right.type, 'en')
      || left.name.localeCompare(right.name, 'en'));
  return sha256Hex(utf8Encoder.encode(JSON.stringify(canonical)));
}

export function serializeDatabaseBackupArtifact(input: {
  manifest: DatabaseBackupManifest;
  footer: DatabaseBackupFooter;
  statements: readonly string[];
}): string {
  return [
    `${MANIFEST_PREFIX}${JSON.stringify(input.manifest)}`,
    '-- Generated by ZeroPress Studio. Review before external execution.',
    '',
    ...input.statements.map((statement) => `${statement};`),
    '',
    `${FOOTER_PREFIX}${JSON.stringify(input.footer)}`,
    '',
  ].join('\n');
}

function parseMarker<T>(
  line: string | undefined,
  prefix: string,
  schema: z.ZodType<T>,
): T {
  if (!line?.startsWith(prefix)) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The ZeroPress SQL backup marker is missing.',
    );
  }
  try {
    const raw = JSON.parse(line.slice(prefix.length)) as unknown;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new TypeError('Invalid marker payload.');
    return parsed.data;
  } catch (error) {
    if (error instanceof DatabaseBackupArtifactError) throw error;
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The ZeroPress SQL backup marker is malformed.',
    );
  }
}

function ensureUniqueManifestEntries(manifest: DatabaseBackupManifest): void {
  const tableNames = manifest.tables.map(({ name }) => name);
  const virtualTableNames = manifest.format_version === 2
    ? manifest.managed_virtual_tables.map(({ name }) => name)
    : [];
  const shadowTableNames = manifest.format_version === 2
    ? manifest.managed_virtual_tables.flatMap(({ shadow_tables }) =>
        shadow_tables)
    : [];
  const objectKeys = manifest.schema_objects.map(
    ({ type, name }) => `${type}:${name}`,
  );
  if (
    new Set(tableNames).size !== tableNames.length
    || new Set(virtualTableNames).size !== virtualTableNames.length
    || new Set(shadowTableNames).size !== shadowTableNames.length
    || new Set(objectKeys).size !== objectKeys.length
  ) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The ZeroPress SQL backup manifest contains duplicate entries.',
    );
  }
  if (
    [...tableNames, ...virtualTableNames, ...shadowTableNames,
      ...manifest.schema_objects.flatMap(
      ({ name, table_name }) => [name, table_name],
    )].some((name) =>
      name.startsWith('sqlite_')
      || name.startsWith('d1_')
      || name.startsWith('zeropress_restore_validation_')
      || name === 'zeropress_restore_journal')
  ) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The ZeroPress SQL backup manifest contains a reserved identifier.',
    );
  }
  const schemaTables = new Set(
    manifest.schema_objects
      .filter(({ type }) => type === 'table')
      .map(({ name }) => name),
  );
  const logicalSchemaTables = new Set(
    [...schemaTables].filter((name) => !virtualTableNames.includes(name)),
  );
  if (
    logicalSchemaTables.size !== tableNames.length
    || tableNames.some((name) => !logicalSchemaTables.has(name))
    || virtualTableNames.some((name) => !schemaTables.has(name))
    || shadowTableNames.some((name) => schemaTables.has(name))
  ) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The backup table and schema-object catalogs do not match.',
    );
  }
  if (manifest.format_version === 2) {
    const knownShadows = new Set<string>();
    for (const virtual of manifest.managed_virtual_tables) {
      const expected = [
        `${virtual.name}_config`,
        `${virtual.name}_content`,
        `${virtual.name}_data`,
        `${virtual.name}_docsize`,
        `${virtual.name}_idx`,
      ];
      if (
        virtual.module !== 'fts5'
        || manifest.database !== 'studio'
        || !STUDIO_MANAGED_VIRTUAL_TABLES.has(virtual.name)
        || JSON.stringify([...virtual.shadow_tables].sort())
          !== JSON.stringify(expected.sort())
      ) {
        throw new DatabaseBackupArtifactError(
          'invalid_artifact',
          'The backup contains an unsupported managed virtual table.',
        );
      }
      for (const shadow of virtual.shadow_tables) {
        if (knownShadows.has(shadow)) {
          throw new DatabaseBackupArtifactError(
            'invalid_artifact',
            'The backup virtual-table catalog contains duplicate shadows.',
          );
        }
        knownShadows.add(shadow);
      }
    }
  }
}

type StatementKind =
  | 'pragma'
  | 'drop'
  | 'create_table'
  | 'insert'
  | 'delete'
  | 'create_secondary';

function classifyStatement(statement: string): StatementKind | null {
  if (/^PRAGMA\s+defer_foreign_keys\s*=\s*TRUE$/iu.test(statement)) {
    return 'pragma';
  }
  if (/^DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\s+IF\s+EXISTS\s+"?[a-z][a-z0-9_]*"?$/iu.test(statement)) {
    return 'drop';
  }
  if (/^CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/iu.test(statement)) {
    return 'create_table';
  }
  if (/^CREATE\s+(?:(?:UNIQUE\s+)?INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?/iu.test(statement)) {
    return 'create_secondary';
  }
  if (/^INSERT\s+INTO\s+"?[a-z][a-z0-9_]*"?\s*\(/iu.test(statement)) {
    return 'insert';
  }
  if (/^DELETE\s+FROM\s+"?[a-z][a-z0-9_]*"?$/iu.test(statement)) {
    return 'delete';
  }
  return null;
}

function validateStatementSequence(
  mode: DatabaseBackupMode,
  statements: readonly string[],
): void {
  if (classifyStatement(statements[0] ?? '') !== 'pragma') {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The backup does not begin with the required deferred-FK policy.',
    );
  }

  const allowed = mode === 'structure_and_data'
    ? new Set<StatementKind>([
        'pragma', 'drop', 'create_table', 'insert', 'create_secondary',
      ])
    : mode === 'structure_only'
      ? new Set<StatementKind>([
          'pragma', 'drop', 'create_table', 'create_secondary',
        ])
      : new Set<StatementKind>(['pragma', 'delete', 'insert']);
  const phaseOrder = mode === 'data_only'
    ? new Map<StatementKind, number>([
        ['pragma', 0], ['delete', 1], ['insert', 2],
      ])
    : new Map<StatementKind, number>([
        ['pragma', 0], ['drop', 1], ['create_table', 2], ['insert', 3],
        ['create_secondary', 4],
      ]);

  let phase = -1;
  for (const statement of statements) {
    const kind = classifyStatement(statement);
    if (!kind || !allowed.has(kind)) {
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        'The backup contains an unsupported SQL statement.',
      );
    }
    const nextPhase = phaseOrder.get(kind);
    if (nextPhase === undefined || nextPhase < phase) {
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        'The backup SQL statement phases are out of order.',
      );
    }
    phase = nextPhase;
  }
}

function unquoteSafeIdentifier(value: string): string {
  return value.startsWith('"') ? value.slice(1, -1) : value;
}

function extractCreatedSchemaObject(
  statement: string,
): FingerprintedSchemaObject | null {
  const identifier = '("[a-z][a-z0-9_]*"|[a-z][a-z0-9_]*)';
  const table = new RegExp(
    `^CREATE\\s+(?:VIRTUAL\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}(?=\\s|\\()`,
    'iu',
  ).exec(statement);
  if (table?.[1]) {
    const name = unquoteSafeIdentifier(table[1]);
    return { type: 'table', name, table_name: name, sql: statement };
  }
  const index = new RegExp(
    `^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}\\s+ON\\s+${identifier}(?=\\s|\\()`,
    'iu',
  ).exec(statement);
  if (index?.[1] && index[2]) {
    return {
      type: 'index',
      name: unquoteSafeIdentifier(index[1]),
      table_name: unquoteSafeIdentifier(index[2]),
      sql: statement,
    };
  }
  const trigger = new RegExp(
    `^CREATE\\s+TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}[\\s\\S]*?\\bON\\s+${identifier}(?=\\s|\\b)`,
    'iu',
  ).exec(statement);
  if (trigger?.[1] && trigger[2]) {
    return {
      type: 'trigger',
      name: unquoteSafeIdentifier(trigger[1]),
      table_name: unquoteSafeIdentifier(trigger[2]),
      sql: statement,
    };
  }
  const view = new RegExp(
    `^CREATE\\s+VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}(?=\\s)`,
    'iu',
  ).exec(statement);
  if (view?.[1]) {
    const name = unquoteSafeIdentifier(view[1]);
    return { type: 'view', name, table_name: name, sql: statement };
  }
  return null;
}

export async function validateDatabaseBackupSchemaCatalog(
  manifest: DatabaseBackupManifest,
  statements: readonly string[],
): Promise<void> {
  ensureUniqueManifestEntries(manifest);
  if (manifest.mode === 'data_only') return;
  const virtualStatements = statements.filter((statement) =>
    /^CREATE\s+VIRTUAL\s+TABLE\s+/iu.test(statement));
  if (manifest.format_version === 1 && virtualStatements.length > 0) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'Backup format v1 cannot contain managed virtual tables.',
    );
  }
  if (manifest.format_version === 2) {
    const actualVirtualTables = virtualStatements.map((statement) => {
      const match = /^CREATE\s+VIRTUAL\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z][a-z0-9_]*)"?\s+USING\s+([a-z][a-z0-9_]*)\b/iu.exec(
        statement,
      );
      if (!match?.[1] || match[2]?.toLowerCase() !== 'fts5') {
        throw new DatabaseBackupArtifactError(
          'invalid_artifact',
          'The backup contains an unsupported virtual-table declaration.',
        );
      }
      return match[1].toLowerCase();
    }).sort();
    const expectedVirtualTables = manifest.managed_virtual_tables
      .map(({ name }) => name)
      .sort();
    if (JSON.stringify(actualVirtualTables) !== JSON.stringify(
      expectedVirtualTables,
    )) {
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        'The backup virtual-table declarations do not match its manifest.',
      );
    }
  }
  const created = statements
    .map(extractCreatedSchemaObject)
    .filter((object): object is FingerprintedSchemaObject => object !== null);
  const actualCatalog = created
    .map(({ type, name, table_name }) => ({ type, name, table_name }))
    .sort((left, right) =>
      left.type.localeCompare(right.type, 'en')
      || left.name.localeCompare(right.name, 'en'));
  const expectedCatalog = [...manifest.schema_objects]
    .sort((left, right) =>
      left.type.localeCompare(right.type, 'en')
      || left.name.localeCompare(right.name, 'en'));
  if (JSON.stringify(actualCatalog) !== JSON.stringify(expectedCatalog)) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The backup SQL schema does not match its manifest catalog.',
    );
  }
  if (await createSchemaFingerprint(created) !== manifest.schema_fingerprint) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The backup SQL schema fingerprint does not match its manifest.',
    );
  }
}

export async function inspectDatabaseBackupArtifact(
  sql: string,
): Promise<DatabaseBackupArtifactInspection> {
  const sizeBytes = utf8Encoder.encode(sql).byteLength;
  const normalized = sql.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const lines = normalized.split('\n');
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  let lastIndex = lines.length - 1;
  while (lastIndex >= 0 && lines[lastIndex]?.trim().length === 0) {
    lastIndex -= 1;
  }
  const manifest = parseMarker(
    lines[firstIndex],
    MANIFEST_PREFIX,
    databaseBackupManifestSchema,
  );
  const footer = parseMarker(
    lines[lastIndex],
    FOOTER_PREFIX,
    databaseBackupFooterSchema,
  );
  ensureUniqueManifestEntries(manifest);
  if (await createManifestSha256(manifest) !== footer.manifest_sha256) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The SQL backup manifest checksum does not match its contents.',
    );
  }

  const body = lines
    .slice(firstIndex + 1, lastIndex)
    .join('\n');
  let statements: string[];
  try {
    statements = splitSqlStatements(body);
  } catch {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The SQL backup contains malformed SQL text.',
    );
  }
  if (statements.length === 0) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The SQL backup does not contain any SQL statements.',
    );
  }
  if (footer.statement_count !== statements.length) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The SQL backup statement count does not match its footer.',
    );
  }
  if (
    await createStatementChainSha256(statements)
    !== footer.statement_chain_sha256
  ) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The SQL backup checksum does not match its contents.',
    );
  }
  validateStatementSequence(manifest.mode, statements);
  await validateDatabaseBackupSchemaCatalog(manifest, statements);

  return { manifest, footer, statements, sizeBytes };
}

export type DatabaseRestoreTableData = {
  table: string;
  columns: string[];
  rows: DatabaseRestoreValue[][];
};

export type DatabaseRestorePlan = {
  manifest: DatabaseBackupManifest;
  footer: DatabaseBackupFooter;
  artifactDigest: string;
  tableStatements: string[];
  secondaryStatements: string[];
  tables: DatabaseRestoreTableData[];
  rowCount: number;
  chunkCount: number;
};

export type PlannedDatabaseRestoreChunk = DatabaseRestoreTableData & {
  chunkIndex: number;
};

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const value = (first << 16) | (second << 8) | third;
    output += alphabet[(value >>> 18) & 63];
    output += alphabet[(value >>> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : '=';
    output += index + 2 < bytes.length ? alphabet[value & 63] : '=';
  }
  return output;
}

function decodeHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/iu.test(value)) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The backup contains an invalid hexadecimal SQL value.',
    );
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function parseSqlString(input: string, start: number): {
  value: string;
  next: number;
} {
  let value = '';
  for (let index = start + 1; index < input.length; index += 1) {
    const character = input[index]!;
    if (character !== "'") {
      value += character;
      continue;
    }
    if (input[index + 1] === "'") {
      value += "'";
      index += 1;
      continue;
    }
    return { value, next: index + 1 };
  }
  throw new DatabaseBackupArtifactError(
    'invalid_artifact',
    'The backup contains an unterminated SQL string value.',
  );
}

function parseRestoreValue(input: string, start: number): {
  value: DatabaseRestoreValue;
  next: number;
} {
  if (input[start] === "'") return parseSqlString(input, start);

  const remainder = input.slice(start);
  const nullMatch = /^NULL\b/iu.exec(remainder);
  if (nullMatch) return { value: null, next: start + nullMatch[0].length };

  const textHexMatch = /^CAST\s*\(\s*X'([0-9a-f]*)'\s+AS\s+TEXT\s*\)/iu.exec(
    remainder,
  );
  if (textHexMatch?.[1] !== undefined) {
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        decodeHex(textHexMatch[1]),
      );
    } catch (error) {
      if (error instanceof DatabaseBackupArtifactError) throw error;
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        'The backup contains invalid UTF-8 text bytes.',
      );
    }
    return { value: decoded, next: start + textHexMatch[0].length };
  }

  const blobMatch = /^X'([0-9a-f]*)'/iu.exec(remainder);
  if (blobMatch?.[1] !== undefined) {
    return {
      value: { type: 'blob', base64: bytesToBase64(decodeHex(blobMatch[1])) },
      next: start + blobMatch[0].length,
    };
  }

  const numberMatch = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?/iu.exec(
    remainder,
  );
  if (numberMatch) {
    const value = Number(numberMatch[0]);
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        'The backup contains a numeric value outside the supported range.',
      );
    }
    return { value, next: start + numberMatch[0].length };
  }

  throw new DatabaseBackupArtifactError(
    'invalid_artifact',
    'The backup contains an unsupported SQL value.',
  );
}

function parseInsertStatement(statement: string): DatabaseRestoreTableData {
  const header = /^INSERT\s+INTO\s+"([a-z][a-z0-9_]*)"\s*\(([^)]*)\)\s+VALUES\s+/iu.exec(
    statement,
  );
  if (!header?.[1] || header[2] === undefined) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The backup contains a non-canonical INSERT statement.',
    );
  }
  const columns = header[2].split(',').map((raw) => {
    const match = /^\s*"([a-z][a-z0-9_]*)"\s*$/u.exec(raw);
    if (!match?.[1]) {
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        'The backup INSERT contains a non-canonical column identifier.',
      );
    }
    return match[1];
  });
  if (columns.length === 0 || new Set(columns).size !== columns.length) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The backup INSERT contains an invalid column list.',
    );
  }

  const rows: DatabaseRestoreValue[][] = [];
  let cursor = header[0].length;
  const skipWhitespace = () => {
    while (/\s/u.test(statement[cursor] ?? '')) cursor += 1;
  };
  while (cursor < statement.length) {
    skipWhitespace();
    if (statement[cursor] !== '(') {
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        'The backup INSERT contains a malformed row tuple.',
      );
    }
    cursor += 1;
    const row: DatabaseRestoreValue[] = [];
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      skipWhitespace();
      const parsed = parseRestoreValue(statement, cursor);
      row.push(parsed.value);
      cursor = parsed.next;
      skipWhitespace();
      if (columnIndex + 1 < columns.length) {
        if (statement[cursor] !== ',') {
          throw new DatabaseBackupArtifactError(
            'invalid_artifact',
            'The backup INSERT row has an invalid value count.',
          );
        }
        cursor += 1;
      }
    }
    skipWhitespace();
    if (statement[cursor] !== ')') {
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        'The backup INSERT row has an invalid value count.',
      );
    }
    cursor += 1;
    rows.push(row);
    skipWhitespace();
    if (cursor === statement.length) break;
    if (statement[cursor] !== ',') {
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        'The backup INSERT has trailing SQL text.',
      );
    }
    cursor += 1;
  }
  if (rows.length === 0) {
    throw new DatabaseBackupArtifactError(
      'invalid_artifact',
      'The backup INSERT does not contain any rows.',
    );
  }
  return { table: header[1], columns, rows };
}

function comparableRestoreIdentity(value: DatabaseRestoreValue): string | null {
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number') return `n:${value}`;
  return null;
}

function orderSelfReferencingRows(
  table: DatabaseRestoreTableData,
): DatabaseRestoreTableData {
  const idIndex = table.columns.indexOf('id');
  const parentIndex = table.columns.indexOf('parent_id');
  if (idIndex < 0 || parentIndex < 0 || table.rows.length < 2) return table;

  const rowById = new Map<string, DatabaseRestoreValue[]>();
  for (const row of table.rows) {
    const id = comparableRestoreIdentity(row[idIndex]!);
    if (id === null || rowById.has(id)) return table;
    rowById.set(id, row);
  }
  const ordered: DatabaseRestoreValue[][] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        `The backup contains a cyclic ${table.table}.parent_id relationship.`,
      );
    }
    const row = rowById.get(id)!;
    visiting.add(id);
    const parent = comparableRestoreIdentity(row[parentIndex]!);
    if (parent !== null && rowById.has(parent)) visit(parent);
    visiting.delete(id);
    visited.add(id);
    ordered.push(row);
  };
  for (const id of rowById.keys()) visit(id);
  return { ...table, rows: ordered };
}

export async function createDatabaseRestorePlan(
  inspection: DatabaseBackupArtifactInspection,
): Promise<DatabaseRestorePlan> {
  if (inspection.manifest.mode === 'structure_only') {
    throw new DatabaseBackupArtifactError(
      'unsupported_restore_mode',
      'Structure-only artifacts are export-only in Studio.',
    );
  }
  const tableStatements = inspection.manifest.mode === 'structure_and_data'
    ? inspection.statements.filter((statement) =>
        classifyStatement(statement) === 'create_table')
    : [];
  const secondaryStatements = inspection.manifest.mode === 'structure_and_data'
    ? inspection.statements.filter((statement) =>
        classifyStatement(statement) === 'create_secondary')
    : [];
  const byTable = new Map<string, DatabaseRestoreTableData>();
  for (const statement of inspection.statements) {
    if (classifyStatement(statement) !== 'insert') continue;
    const parsed = parseInsertStatement(statement);
    const existing = byTable.get(parsed.table);
    if (!existing) {
      byTable.set(parsed.table, parsed);
      continue;
    }
    if (JSON.stringify(existing.columns) !== JSON.stringify(parsed.columns)) {
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        `The backup uses inconsistent columns for table ${parsed.table}.`,
      );
    }
    existing.rows.push(...parsed.rows);
  }

  const manifestTables = new Map(
    inspection.manifest.tables.map((table, index) => [table.name, { ...table, index }]),
  );
  for (const table of byTable.keys()) {
    if (!manifestTables.has(table)) {
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        'The backup contains data for a table outside its manifest.',
      );
    }
  }
  for (const expected of inspection.manifest.tables) {
    if ((byTable.get(expected.name)?.rows.length ?? 0) !== expected.row_count) {
      throw new DatabaseBackupArtifactError(
        'invalid_artifact',
        `The backup row count for table ${expected.name} does not match its manifest.`,
      );
    }
  }
  const tables = [...byTable.values()]
    .sort((left, right) =>
      manifestTables.get(left.table)!.index - manifestTables.get(right.table)!.index)
    .map(orderSelfReferencingRows);
  const rowCount = tables.reduce((total, table) => total + table.rows.length, 0);
  const plan: DatabaseRestorePlan = {
    manifest: inspection.manifest,
    footer: inspection.footer,
    artifactDigest: inspection.footer.statement_chain_sha256,
    tableStatements,
    secondaryStatements,
    tables,
    rowCount,
    chunkCount: 0,
  };
  plan.chunkCount = createDatabaseRestoreChunks(plan).length;
  return plan;
}

export function createDatabaseRestoreChunks(
  plan: DatabaseRestorePlan,
): PlannedDatabaseRestoreChunk[] {
  const chunks: PlannedDatabaseRestoreChunk[] = [];
  for (const table of plan.tables) {
    let rows: DatabaseRestoreValue[][] = [];
    const flush = () => {
      if (rows.length === 0) return;
      chunks.push({
        table: table.table,
        columns: [...table.columns],
        rows,
        chunkIndex: chunks.length,
      });
      rows = [];
    };
    for (const row of table.rows) {
      const candidate = [...rows, row];
      const candidateBytes = utf8Encoder.encode(JSON.stringify(candidate)).byteLength;
      if (
        rows.length > 0
        && (
          candidate.length > DATABASE_RESTORE_MAX_ROWS_PER_CHUNK
          || candidateBytes > DATABASE_RESTORE_MAX_CHUNK_BYTES - 128 * 1024
        )
      ) {
        flush();
      }
      rows.push(row);
    }
    flush();
  }
  return chunks;
}

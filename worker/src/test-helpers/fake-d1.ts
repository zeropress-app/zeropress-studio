import { STUDIO_SCHEMA_VERSION } from '../system/schema-version';

export const READY_SCHEMA_STATE = {
  id: 1,
  schema_version: STUDIO_SCHEMA_VERSION,
  lifecycle_state: 'ready',
  target_schema_version: null,
  active_operation_id: null,
  updated_at_iso: '2026-07-29T00:00:00.000Z',
} as const;

type FakeD1Options = {
  tables?: string[];
  schemaState?: unknown;
  tableQueryError?: unknown;
  stateQueryError?: unknown;
  edgeIntegrationMode?: 'enabled' | 'disabled';
  contentSearchState?: unknown;
};

export function createFakeD1(options: FakeD1Options = {}) {
  let tables = options.tables ?? ['users', 'zeropress_schema_state'];
  let schemaState = Object.hasOwn(options, 'schemaState')
    ? options.schemaState
    : READY_SCHEMA_STATE;
  let prepareCallCount = 0;

  const database = {
    prepare(query: string) {
      prepareCallCount += 1;

      if (query.includes('FROM sqlite_schema')) {
        const statement = {
          bind() {
            return statement;
          },
          async all() {
            if (options.tableQueryError !== undefined) {
              throw options.tableQueryError;
            }
            return {
              success: true,
              results: tables.map((name) => ({ name })),
              meta: {},
            };
          },
          async first() {
            if (options.tableQueryError !== undefined) {
              throw options.tableQueryError;
            }
            return tables.includes('zeropress_restore_journal')
              ? { present: 1 }
              : null;
          },
        };
        return statement;
      }

      if (query.includes('FROM zeropress_schema_state')) {
        return {
          bind() {
            return {
              async first() {
                if (options.stateQueryError !== undefined) {
                  throw options.stateQueryError;
                }
                if (
                  schemaState
                  && typeof schemaState === 'object'
                  && query.includes('SELECT\n      schema_version,')
                ) {
                  const row = schemaState as Record<string, unknown>;
                  return {
                    schema_version: row.schema_version,
                    lifecycle_state: row.lifecycle_state,
                    target_schema_version: row.target_schema_version,
                    active_operation_id: row.active_operation_id,
                  };
                }
                return schemaState ?? null;
              },
            };
          },
        };
      }

      if (
        query.includes('FROM studio_settings')
        && query.includes('WHERE key IN')
      ) {
        let bindings: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) {
            bindings = values;
            return statement;
          },
          async all() {
            const updatedAtIso = '2026-08-01T00:00:00.000Z';
            if (bindings.includes('cloudflare_access_requirement')) {
              return {
                success: true,
                results: [
                  {
                    key: 'cloudflare_access_requirement',
                    value: JSON.stringify({
                      mode: 'disabled',
                      issuer: null,
                      audience: null,
                      bound_origin: null,
                      verified_at_iso: null,
                    }),
                    type: 'json',
                    updated_at_iso: updatedAtIso,
                  },
                  {
                    key: 'cloudflare_access_revision',
                    value: 'c'.repeat(32),
                    type: 'string',
                    updated_at_iso: updatedAtIso,
                  },
                ],
                meta: {},
              };
            }
            return {
              success: true,
              results: [
                {
                  key: 'edge_integration_mode',
                  value: options.edgeIntegrationMode ?? 'enabled',
                  type: 'string',
                  updated_at_iso: updatedAtIso,
                },
                {
                  key: 'edge_integration_revision',
                  value: 'e'.repeat(32),
                  type: 'string',
                  updated_at_iso: updatedAtIso,
                },
              ],
              meta: {},
            };
          },
        };
        return statement;
      }

      if (query.includes('FROM content_search_index_state')) {
        const statement = {
          bind() {
            return statement;
          },
          async first() {
            return options.contentSearchState ?? {
              state: 'ready',
              reason: null,
              phase: null,
              operation_id: null,
              post_public_id_cursor: 0,
              page_public_id_cursor: 0,
              processed_posts: 0,
              processed_pages: 0,
              total_posts: 0,
              total_pages: 0,
              started_at_iso: null,
              updated_at_iso: '2026-08-01T00:00:00.000Z',
            };
          },
        };
        return statement;
      }

      if (query.includes('FROM edge_comment_target_reconciliation_state')) {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          },
        };
      }

      throw new Error('Unexpected fake D1 query');
    },
  } as unknown as D1Database;

  return {
    database,
    getPrepareCallCount: () => prepareCallCount,
    setTables(nextTables: string[]) {
      tables = [...nextTables];
    },
    setSchemaState(nextSchemaState: unknown) {
      schemaState = nextSchemaState;
    },
  };
}

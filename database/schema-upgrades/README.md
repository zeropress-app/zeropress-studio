# Studio schema upgrade artifacts

Studio database upgrades use a forward-only transition catalog. Each
registered transition advances one schema version and runs atomically.

The current target and minimum supported versions are defined in
[schema-version.ts](../../worker/src/system/schema-version.ts).
The [fresh-install baseline](../install/001_baseline.sql) contains the complete
schema for a new installation.

Use the [Studio DB upgrade flow](../../docs/maintenance-and-recovery.md#forward-only-studio-db-upgrade)
to upgrade an existing database. These artifacts are not standalone SQL scripts
or Wrangler D1 migrations.

[`001_to_002_audit_logs.sql`](001_to_002_audit_logs.sql) adds audit storage
without modifying existing application rows. The transition registry includes
its SHA-256 checksum.

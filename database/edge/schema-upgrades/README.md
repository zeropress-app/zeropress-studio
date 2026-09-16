# Edge schema upgrade artifacts

Edge database upgrades use the forward-only transitions registered in the
[schema contract](../schema-contract.json). Each registered transition advances
one schema version and runs atomically through Studio.

Use the [Edge database lifecycle tools](../../../docs/maintenance-and-recovery.md#edge-database-lifecycle-and-target-reconciliation)
to upgrade an existing database. These artifacts are not standalone SQL scripts
or Wrangler D1 migrations.

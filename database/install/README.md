# Fresh-install artifact

[`001_baseline.sql`](001_baseline.sql) contains the complete schema for a new
Studio database. Fresh installation uses this artifact directly; existing
installations use the [schema upgrade flow](../schema-upgrades/README.md).
The current target and minimum supported versions are defined in
[schema-version.ts](../../worker/src/system/schema-version.ts).

Use the Studio installer after backing up any existing resources. Do not apply
the SQL manually or use `wrangler d1 migrations`. See
[Quick Start](https://studio.zeropress.dev/getting-started/) for deployment
configuration and installation steps, or the
[local development guide](../../README.md#local-development).

## Installation

Installation requires an uninstalled Studio database and a verified TOTP
factor for the initial administrator. The schema, administrator account, MFA
factor, system roles, and ready lifecycle state are committed in one atomic
D1 batch.

The installer also inspects the separately bound Edge database. An empty Edge
database is installed automatically when the required bindings are available;
an existing Edge database is preserved. See
[Edge database lifecycle](../../docs/maintenance-and-recovery.md#edge-database-lifecycle-and-target-reconciliation)
for the resulting integration state and post-install operations.

## Data ownership

Studio D1 owns accounts, authored content, Media metadata, site settings, and
the journals used by its lifecycle tools. Public comments, Forms, and
Newsletter data belong to the separate Edge database. Media objects reside in
R2 or at external URLs; SQL backups contain their metadata, not their bytes.

For data deletion and preservation rules, use the
[Maintenance & Recovery guide](../../docs/maintenance-and-recovery.md#operations).
For backups, including search-index rebuilding after restore, use
[D1 SQL backup and restore](../../docs/maintenance-and-recovery.md#d1-sql-backup-and-restore).

# Maintenance & Recovery

Open `/system/operations` for Worker configuration, database lifecycle tools,
backups, and administrator recovery. Operations uses a separate IP allowlist
and token. In `operational` mode, an active Studio administrator session is
also required.

## Access boundary

Operations is disabled until both values are configured:

| Variable | Type | Requirement |
| --- | --- | --- |
| `STUDIO_OPERATIONS_ALLOWED_IPS` | Plaintext | Comma-separated exact IPv4 or IPv6 addresses; remove the variable to disable Operations |
| `STUDIO_OPERATIONS_TOKEN` | Secret | 32–256 printable ASCII characters (U+0021–U+007E), without spaces |

CIDR ranges are not supported. Deployed requests use Cloudflare's
`CF-Connecting-IP`; local development accepts loopback requests. If the
allowlist needs configuration, the entry guide shows the current connection
IP when available. Refresh it after a network or VPN change. Requests outside
a valid allowlist receive a not-found response before any credential form.

Use an operations token independent of the install token, for example:

```bash
openssl rand -hex 32
```

The entry guide can also generate a token locally. Store a secure copy and add
it to the Worker configuration yourself; the guide does not save it for you.
Keep this token after installation. Operations holds entered credentials only
in page memory; reloading or leaving Operations locks it again.

Destructive operations require administrator password re-verification, the
exact confirmation phrase shown in the dialog, and a final confirmation.
Maintenance and recovery modes do not require a normal Studio session.
Administrator recovery, recovery-mode SQL transfer, and Cloudflare Access
recovery use the operations token and IP boundary when account credentials
cannot be used. Their requirements are described below.

If Cloudflare Access blocks the request before it reaches Studio, correct its
outer policy first. To recover Studio's own Access requirement, use the
[Cloudflare Access recovery procedure](cloudflare-access.md#recovery-and-origin-changes).

## Resolved environment

Operations shows the current site mode, bindings, database states, schema
versions, and action availability. Secrets are shown only as valid, missing,
or invalid; their values are never returned.

After installation, delete the `STUDIO_INSTALL_TOKEN` binding. An empty value
still counts as configured and blocks normal Studio access. Keep
`STUDIO_AUTH_SECRET` when reusing the database; see
[administrator recovery](#recover-administrator-access) if it is lost or rotated.

The Studio Edge integration setting is independent of the public Edge
Worker's maintenance mode. Disabling integration stops Studio's use of Edge;
it does not stop public Edge requests. Use `EDGE_MAINTENANCE_MODE=true` on the
public Worker when those requests must be paused.

## Edge database lifecycle and target reconciliation

`EDGE_DB` has its own schema lifecycle. Operations reports whether it needs
installation, adoption, upgrade, reconciliation, or recovery.

During initial Studio installation, an empty Edge application catalog is
installed automatically when `EDGE_KV` is bound, and Studio integration is
then enabled. A non-empty Edge database is preserved without writes and
integration starts disabled; the completion screen reports this. An
unavailable required binding or database blocks Studio installation.

After installation, the following actions require a current, ready Studio
database and administrator re-verification:

| Action | Studio mode | Purpose |
| --- | --- | --- |
| Install Edge database | `maintenance` | Install the canonical schema into an empty application catalog |
| Adopt Edge database | `maintenance` | Register a matching unversioned schema and canonical seeds without changing business data |
| Upgrade Edge database | `operational` or `maintenance` | Apply the supported consecutive schema upgrades |
| Reconcile comment targets | `maintenance` | Align Edge targets with Studio Posts and Pages and review orphan targets |

Before these actions, pause the public Edge Worker with
`EDGE_MAINTENANCE_MODE=true`. Adoption, upgrade, and reconciliation require a
reviewed Edge SQL backup. Follow the confirmation shown by Operations.

The supported Edge schema and artifacts are defined by the reviewed
[Edge contract](../database/edge/schema-contract.json). Managed databases may
retain authored settings; adoption's canonical-seed check does not require
subsequent settings to remain at installation defaults.

An incompatible or non-ready Edge database pauses Edge-backed Studio features
and causes the mail consumer to retry messages. Studio-native content and
account management remain available. Edge lifecycle actions do not change
Worker variables or enable Studio integration automatically.

### Reconcile comment targets

Reconciliation processes pending projections and compares Studio content with
Edge comment targets. Review targets that exist only in Edge before purging
them: deleting a target also deletes its comments. Changed or revived targets
are skipped.

Resume an interrupted operation from Operations. Repeated steps are safe;
cancelling removes the operation record but preserves completed projections.
Completion requires no pending projections or unreviewed orphan targets and
matching Studio/Edge targets. Enable integration only after Edge Services
reports that it is ready.

### Upgrade when the mail Queue contract changes

1. Pause public Edge writes with `EDGE_MAINTENANCE_MODE=true`.
2. Let the compatible Studio consumer drain existing Queue messages before
   deploying a consumer with an incompatible message contract.
3. Deploy the reviewed Studio and Edge releases, retain an Edge SQL backup,
   and run or resume the Edge upgrade from Operations.
4. If reconciliation is required, switch Studio to `maintenance` and complete
   the target review.
5. Verify Edge Services and mail compatibility, return Studio to `operational`,
   enable integration, and set `EDGE_MAINTENANCE_MODE=false`.

Once the Edge database is ready, the consumer discards malformed or
incompatible messages. A database upgrade does not migrate queued messages.

## Content-search index rebuild

A logical restore or schema upgrade may mark Post/Page search as
`rebuild_required`. Normal lists remain usable, but search is unavailable
until the derived index is rebuilt.

With a current ready Studio schema in `maintenance` or `recovery` mode, open
the database tools, re-verify an active administrator, and confirm
**REBUILD CONTENT SEARCH**. Resume an interrupted rebuild from its reported
state, or explicitly restart it.
Completion verifies index integrity against the canonical Posts and Pages.

Rebuild cannot overlap schema upgrade, logical restore, Clear Content, Reset,
Uninstall, or Edge target reconciliation. See
[Content search](content-search.md) for search behavior and index details.

## D1 SQL backup and restore

Studio DB and Edge DB produce separate SQL artifacts. Back up R2 objects
separately: SQL contains Media metadata, not object bytes. These backups do
not form an atomic snapshot across resources.

| Studio mode | Export | Restore |
| --- | --- | --- |
| `operational` | Readable Edge DB only, with a current ready Studio DB and administrator re-verification | Unavailable |
| `maintenance` | Available databases, with administrator re-verification | Available targets, with administrator re-verification |
| `recovery` | Available databases, using the operations token and IP boundary | Available targets, using the operations token and IP boundary |

A readable Studio DB can be exported while an upgrade is required. Starting a
Studio DB restore in maintenance mode requires the current ready schema.
For an uninstalled Studio DB or unavailable administrator credentials, switch
to recovery mode. The dashboard reports availability for each target.

Data-bearing artifacts contain private account, credential, MFA, email, IP,
and session records. Store and transfer them securely; the integrity checksum
is not encryption.

### Export

Choose the target database and one of these formats:

| Mode | Use |
| --- | --- |
| `structure_and_data` | Schema and rows; recommended for a portable restore |
| `structure_only` | Schema inspection; cannot be restored by Studio |
| `data_only` | Restore rows into a target with an exactly matching schema fingerprint |

Before exporting Edge, set the public Worker to `EDGE_MAINTENANCE_MODE=true`
and pause other writers. Studio's site mode does not stop them. The exporter
rechecks schema and row counts but cannot hold a single snapshot across all
reads.

Logical export preflights a 900-D1-statement budget defined in the
[exporter](../worker/src/operations/database-backup.ts). This is Studio's
internal budget; deployment limits also apply. See
[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Use Studio's logical backup for Studio DB. Native D1 export
[does not support virtual tables](https://developers.cloudflare.com/d1/best-practices/import-export-data/),
including Studio's FTS5 indexes. Native export may be used for a separate Edge
database without virtual tables.

### Restore

1. Open a generated artifact and review its target and mode. Studio validates
   its manifest, schema fingerprint, and checksum before execution.
2. Keep the required site mode and credentials available, enter
   **RESTORE DATABASE**, and confirm execution. Restore replaces the selected
   target's data.
3. Wait for completion. Rows are sent in bounded chunks; final schema,
   row-count, and foreign-key verification must succeed.
4. Once the restored schema is ready, rebuild Studio content search when
   required and return to operational mode.

Generated format v2 and supported v1 artifacts can be restored. Arbitrary or
modified SQL files are rejected. Studio search-index rows are excluded from
backups; canonical Post/Page content is restored and the index must be rebuilt.

A failed request rolls back that request, not earlier completed chunks. If
restoration is interrupted, keep maintenance or recovery mode and restart
from the same reviewed artifact. A partial restore is never reported as
complete. A maintenance-mode Studio restore already in progress can restart
using its operation record and the token/IP boundary, because account data
may be partially restored.

Restore does not change site mode or restore R2 objects. A backup may also
restore a Cloudflare Access requirement tied to an old hostname; use
[Access recovery](cloudflare-access.md#recovery-and-origin-changes) before
enabling it on a new verified hostname.

## Worker rollback and database compatibility

`DATABASE_NEWER_THAN_CODE` means the stored Studio schema version is higher
than the running Worker supports. The entry screen shows the running Studio
release, stored schema version, and schema version required by the Worker.
Older Workers may display **Not reported** for their release version.

A [Worker rollback](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
does not undo database upgrades. Return to a deployment that supports the
stored schema, or deploy a compatible release. If the mismatch is unexpected,
check the Worker's `DB` binding. After deployment, use **Check after deployment**.

Keep the database; do not reinstall it or edit its schema version to bypass
compatibility checks. Schema versions and Studio release numbers are independent.

## Forward-only Studio DB upgrade

When Operations reports `upgrade_required`, retain a Studio SQL backup and
switch to `maintenance`. If administrator credentials need recovery, complete
[administrator recovery](#recover-administrator-access) first, then return to
maintenance for the upgrade.

Review the displayed steps, acknowledge the backup, re-verify an active
administrator, and enter **UPGRADE STUDIO DATABASE**. The runner applies the
supported consecutive artifacts from the stored schema to the version required
by the Worker. See [schema-version.ts](../worker/src/system/schema-version.ts)
for the current target and support floor.

Each step is atomic. On interruption, reopen Operations and resume the
reported remaining steps. A failed step leaves the schema at its preceding
committed version. Do not apply upgrade SQL manually or guess which step ran.
A schema upgrade and logical restore cannot run together.

Once the upgrade completes and the lifecycle is ready, return to `operational`.
Retain the pre-upgrade backup until service is restored. The upgrade does not
change site mode itself.

Fresh installations use the consolidated baseline instead of this flow.
See the [schema upgrade catalog](../database/schema-upgrades/README.md) for the
supported transitions.

## Operations

Clear Content, Reset Studio, and Uninstall Studio are blocked while Edge target
reconciliation or content-search rebuilding is in progress. Complete the active
operation, or explicitly cancel reconciliation, before continuing.

### Recover administrator access

Available in `recovery` mode with a ready schema or a supported
`upgrade_required` source schema. Normal sign-in remains blocked in this mode.

Select an administrator, provide a new password that passes the password
policy, and confirm **RECOVER ADMINISTRATOR**. Recovery reactivates the account,
clears lockout state, changes its password, and invalidates existing sessions
and authentication continuations.

Preserve MFA if a usable authenticator remains. **Reset MFA** removes TOTP,
Passkeys, and security keys, and requires fresh TOTP enrollment after the next
password check. Recovery never enables password-only authentication.

If no administrator remains, Operations offers new-administrator setup. Retain
a Studio DB backup, provide an unused email and strong password, verify a new
TOTP factor, and confirm **CREATE RECOVERY ADMINISTRATOR**. Existing users and
content are preserved; this does not promote an existing account.

After recovery, complete any required schema upgrade in maintenance mode,
then return to `operational` and verify MFA sign-in. Rotate or disable the
operations token when recovery is complete.

`STUDIO_AUTH_SECRET` is stored separately from D1. Losing or rotating it
invalidates sealed authentication tokens and makes existing TOTP material
unreadable. A usable current-host WebAuthn credential can authorize TOTP
replacement; otherwise reset the affected administrator's MFA through recovery.

### Clear site content

Available in `operational` or `maintenance` mode with a current ready Studio
database. The Edge requirements and effects are listed
[below](#edge-effects-for-clear-and-reset).

Clear Content removes all authored and imported Posts, Pages, Authors,
Categories, Tags, Menus, Media metadata and collections, autosaves, revisions,
and generated content state. Protected default Menu IDs are included.

It preserves users, roles, credentials, authentication attempt counters,
Studio settings, site settings, Custom Code, and Widgets. Two settings change
because their referenced content is deleted: a Page Front Page returns to the
theme index, and Site Branding Media selections are cleared. Permalink and
Post-index choices are preserved. Public Post/Page ID counters are preserved
so deleted IDs are not reused.

### Reset Studio

Available only in `maintenance` mode with a current ready Studio database.
The Edge requirements and effects are listed
[below](#edge-effects-for-clear-and-reset).

Reset removes the same content as Clear Content, plus site settings, Custom
Code, Widgets, authentication attempt counters, sessions, pending account
setup tokens, and authentication challenges. It deletes every user except the
administrator verified for the operation and recreates the three system roles.

The preserved administrator is active, unlocked, and assigned only the
administrator role; their identity, password, and enrolled MFA remain.
The schema, public Post/Page ID counters, and Studio-level settings, including
Edge integration and Cloudflare Access, are preserved. Verify sign-in after
returning to operational mode.

### Edge effects for Clear and Reset

With Studio Edge integration enabled, Clear Content and Reset require a ready
Edge integration and perform the following Edge work before changing Studio
content. With integration disabled, they skip Edge entirely. The confirmation
and completion screens show whether Edge is included.

| Edge data | Clear Content | Reset Studio |
| --- | --- | --- |
| Comment targets and comments | Delete all | Delete all |
| Comment presentation settings | Preserve | Restore defaults |
| Comment request secrets and Supabase authentication settings | Preserve | Preserve |
| Newsletter subscribers, subscriptions, submitted field values, and delivery records | Delete all | Delete all |
| Newsletter lists and field definitions | Preserve | Delete all; create one empty active `default` list |
| Newsletter suppressions | Preserve | Delete all |
| Newsletter confirmation delivery | Preserve | Disable |
| Form submissions and submitted values | Delete all | Delete all |
| Form definitions, fields, and notification recipients | Preserve | Delete all; no default Form is created |

These operations span separate D1 databases and are not atomic across both.
If Studio fails after Edge work completes, the failure includes
`completed_resource=EDGE_DB`. Keep both backups and retry the same action;
completed Edge deletions are safe to repeat.

### R2 cleanup after Clear or Reset

Before deleting Media metadata, Studio records managed object keys under
`uploads/` and `imported/` for deletion. It attempts cleanup after the database
work and retains failures for the daily operational-mode scheduler. A missing
bucket binding leaves cleanup pending until the correct binding is restored.
External HTTP(S) objects are never physically deleted.

### Uninstall Edge database

Available in `maintenance` mode with ready Studio and managed Edge schemas,
Studio Edge integration disabled, and no target reconciliation in progress.

Retain an Edge SQL backup, set `EDGE_MAINTENANCE_MODE=true` on the public Worker,
and review pending mail Queue work. Re-verify an administrator, enter
**UNINSTALL EDGE DATABASE**, review the table counts, and confirm execution.
Unknown or mismatched tables block removal. The managed Edge schema and rows
are removed in one atomic batch.

This leaves the D1 resource, Worker bindings and variables, KV entries, R2
objects, Queue messages and consumers, and Studio DB in place. Queue work is
not drained by uninstall. Review these resources before reinstalling through
the Edge lifecycle tools.

### Uninstall Studio

Available in `maintenance` mode with a current ready Studio schema. Re-verify
an administrator, review the table-count preview, and confirm execution.
Unknown or missing tables block removal. The Studio schema and rows are
removed in one atomic batch, and the completion report lists the removed
tables and their row counts. Final counts may differ from the preview.

Uninstall preserves the Cloudflare D1 resource, Worker configuration, all R2
objects, and the separate Edge database. Pending R2 cleanup records are removed
with the Studio schema; uninstall does not execute those deletions. Stop or
clean up public Edge services separately if needed.

To reinstall, configure `STUDIO_SITE_MODE=initial` and a new
`STUDIO_INSTALL_TOKEN`, redeploy the configuration, and use the normal installer.

## Logs and backup boundary

Operations logs record the start and completion or failure of database work.
Authenticated mutations include the verified initiating administrator's ID and
email; token-only recovery operations do not. These logs remain available
outside D1. See the [operational log catalog](operational-log-catalog.md) for
codes and the [logging policy](operational-log-policy.md) for privacy rules.

Retain the relevant Studio DB, Edge DB, and R2 backups until the operation
completes and service is restored. Destructive operations do not create a backup
or roll back changes to other resources automatically.

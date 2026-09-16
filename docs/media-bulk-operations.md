# Media bounded bulk operations

Bulk media editing and deletion process explicitly selected items on the current
screen. Like collection moves, they do not support unbounded operations across all
search results.

## Limits and API

- `POST /api/media/bulk-operations`
- Each request accepts up to 50 unique Media IDs with expected revisions.
- `update_metadata` supplies each row's `filename` and image `alt` independently.
- `delete` permanently removes Media metadata. Rows referenced by Post/Page featured
  images, Author avatars, or Site Branding are skipped as `in_use`; references are
  not automatically detached.
- Results preserve request order as `updated | unchanged | conflict | skipped`.
  Conflicted or skipped rows stay selected in the UI.

Collection moves retain the atomic contract of `/api/media/collection-moves`, with
a limit of 100 items. Metadata editing leaves collection, source, MIME type,
dimensions, and duration unchanged, preserving the type invariants of restrictive
references.

## Deletion and object lifecycle

- External Media deletion removes only D1 metadata and preserves the external object.
- For canonical R2 Media under `uploads/` or `imported/`, the Media DELETE and
  `media_object_deletions` enqueue run in the same `DB.batch()`.
- If the R2 binding is unavailable, affected rows are skipped as
  `managed_storage_unavailable`; external rows continue processing.
- After commit, object deletion runs as a best-effort background task. The durable
  queue and daily maintenance retry failures and lost responses.
- URLs written directly in content are not Media ID references and are neither
  inspected nor changed.

## UI

Users can select up to 50 items on the current server page. Collection moves,
per-item metadata editing, and deletion share the selection toolbar. Destructive
deletion requires an impact summary and confirmation dialog. A screen-reader
notice announces result counts, and only unresolved rows remain selected.

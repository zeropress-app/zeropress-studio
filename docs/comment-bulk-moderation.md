# Comment bounded bulk moderation

Bulk moderation processes comments selected on the current server page. It uses
the same permissions, optimistic concurrency, target-scoped cache invalidation,
and cycle-safe subtree deletion policy as single-comment moderation.

## Public API

```text
POST /api/comments/bulk-moderation
```

A request accepts up to 50 unique `{id, expected_updated_at_iso}` entries. It does
not implicitly process every row matching a filter.

```json
{
  "operation": "set_status",
  "status": "approved",
  "items": [
    {
      "id": "0123456789abcdef0123456789abcdef",
      "expected_updated_at_iso": "2026-08-20T00:00:00.000Z"
    }
  ]
}
```

`status` is one of `approved`, `pending`, `spam`, or `trash`. Permanent deletion
uses `operation: "delete_permanently"` and does not accept `status`.

## Results and concurrency

Results preserve input order:

- `updated`: the status changed or the selected subtree was deleted.
- `unchanged`: the comment already has the requested status; its revision stays unchanged.
- `conflict`: `updated_at` changed after selection.
- `skipped/not_found`: the comment is missing or was deleted as part of an earlier selected subtree.
- `skipped/not_in_trash`: the current row is not eligible for permanent deletion.

The same-status check precedes revision conflict detection, so retrying after a
lost response does not produce an unnecessary write. Retrying permanent deletion
returns `not_found` for an already deleted root.

## Edge atomicity

After preflight checks, comment writes and `edge_comment_targets` cache revision
updates run in one `EDGE_DB.batch()`. Target IDs are deduplicated so each target's
cache revision changes only once per request.

Permanent deletion starts a target-scoped recursive CTE from each selected Trash
root and expands descendants with `UNION`. It terminates even with malformed cycles
and does not delete comments belonging to a different Post/Page target with the
same numeric ID. For overlapping subtrees, the first processed root reports the
actual deleted row count; a later root already removed returns `not_found`.

## UI

`/comments` supports individual selection and selecting all 50 items on the current
server page. Changing the filter, target, search, or page clears selection. The
permanent-delete action appears only when every selected comment is in Trash and
requires a separate destructive confirmation. Conflicts and reviewable skips stay
selected; completed or missing rows are removed from selection.

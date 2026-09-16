# Post/Page bounded bulk lifecycle

Bulk lifecycle operations change selected documents to `draft`, `published`, or
`trash`. Each document receives the same permission, revision, and reference
integrity checks as a single-document status change.

## Scope

Supported behavior:

- Explicitly select documents on the current Post or Page list page.
- Change selected documents to `draft`, `published`, or `trash`.
- Recheck each row's permissions, current revision, and restrictive references.
- Update the canonical row, saved revision, FTS row, and Edge target outbox within
  the same boundary as a single-document write.
- Report updated, already at the target status, revision conflict, or skipped by
  policy for each document.

These operations do not include:

- Selecting all search results or every page.
- Bulk permanent deletion.
- Scheduled publishing or future publication timestamps.
- Bulk editing fields such as title, Author, parent, taxonomy, or comment permission.
- Deleting or automatically restoring autosaves.

Permanent deletion uses a single-document request with an expected revision.

## API contract

Posts and Pages use separate domain endpoints:

```text
POST /api/posts/bulk-lifecycle
POST /api/pages/bulk-lifecycle
```

The request is a closed object containing the target canonical status rather than
a UI action name.

```ts
{
  target_status: "draft" | "published" | "trash";
  items: Array<{
    id: string;
    expected_revision: string;
  }>;
}
```

- IDs in `items` must be unique.
- The request limit is `10` documents.
- The API does not accept filter, search, or `all` selectors.

The response preserves selection order:

```ts
{
  target_status: "draft" | "published" | "trash";
  results: Array<
    | {
        id: string;
        outcome: "updated" | "unchanged";
        status: "draft" | "published" | "trash";
        revision: string;
      }
    | { id: string; outcome: "conflict" }
    | {
        id: string;
        outcome: "skipped";
        reason: "not_found" | "front_page_protected" | "has_children";
      }
  >;
  summary: {
    requested: number;
    updated: number;
    unchanged: number;
    conflict: number;
    skipped: number;
  };
}
```

Posts outside the caller's Author scope and missing Posts both return
`skipped/not_found`, preventing disclosure of another Author's documents. The Page
endpoint requires `pages.manage`. Unknown database results and service errors fail
the request rather than becoming fabricated per-row `failed` results. Idempotent
retries safely handle documents that were already committed.

## Revisions and retries

Each row is processed in this order:

1. The current user's permissions and Author scope determine access.
2. A status that already equals `target_status` returns `unchanged`, even if
   the revision differs.
3. A different status with a stale `expected_revision` returns `conflict`.
4. The status changes if the domain constraints allow it.

The same-status check avoids creating another revision when retrying after a lost
response. It also prevents a stale client from overwriting a newer document that
has not reached the target status. After a conflict, review the latest document
before retrying the change.

Changed rows preserve the previous canonical snapshot as a saved revision and
receive a new revision. `published_at_iso` is set on first publication and retained
through later draft/Trash transitions. Rows already at the target status leave
the canonical revision, history, FTS, and outbox unchanged.

## Atomicity and derived state

Each document change is an independent atomic domain write rather than part of an
all-or-nothing request transaction. One protected Front Page or Page with children
does not block the entire selection. The same request can be retried after a lost
response to converge on the requested state.

Each `updated` row's atomic write includes:

- A revision-guarded canonical status, revision, and timestamp update.
- The previous snapshot's saved revision and retention processing.
- Replacement of the derived FTS row for the new canonical revision.
- A projection outbox entry based on the persisted target when Edge integration is enabled.

Bulk lifecycle operations preserve autosaves for ongoing edits.

An unexpected D1 error stops later rows and returns a request-level error. Retry-safe
evaluation handles earlier commits without guessing whether an uncertain row
succeeded.

## Domain constraints

Posts follow the single-document policy:

- `admin` and `editor` process Posts within `posts.manage` scope.
- `author` processes only Posts linked to their own Author at request time.

Pages report these cases as `skipped` and continue processing other rows:

- Moving the selected Front Page to draft or Trash: `front_page_protected`.
- Moving a Page with direct children to Trash: `has_children`.

Lifecycle requests do not modify Page hierarchy, parent, or slug. Publishing and
moving to draft do not depend on whether children exist; the current Front Page
must remain published.

## Using bulk actions

Select up to 10 documents on the current Post or Page list, then choose Publish,
Move to draft, or Move to Trash. Each action asks for confirmation. Changing the
filter, search, status tab, or page clears the selection.

After processing, the list and status counts refresh. Updated and unchanged
documents leave the selection; conflicts and skipped documents remain available
in the results panel.

Front Page protection results link to URLs & Homepage settings. Results for
Pages with children link to the relevant Page editor.

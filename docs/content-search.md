# Post and Page content search

Studio provides administrator-facing Post and Page search through derived,
contentful FTS5 tables. Canonical Post/Page rows remain the authority;
the index can always be discarded and rebuilt without changing authored data.

## Indexed content

Post search indexes title, slug, excerpt, and reader-visible body text. Page
search uses the same four fields. Autosaves and saved revisions are not separate
results. Draft, published, and Trash rows are indexed so the existing status,
author-scope, and pagination filters can be applied after the FTS candidate is
resolved.

The body projection follows the stored document type:

- HTML preserves decoded text nodes and removes tags, attributes, comments, and
  `script`/`style`/`template` contents;
- Markdown preserves rendered labels and text while removing markup, link
  destinations, and the same hidden HTML contents;
- plaintext removes control characters and collapses whitespace.

No body truncation is applied while indexing. The FTS rowid is the canonical
Post or Page public ID and its unindexed revision must equal the source row.

## Query semantics

The existing `GET /api/posts?search=...` and `GET /api/pages?search=...`
endpoints accept a trimmed query of at most 200 UTF-16 code units. Unicode
letters and digits form tokens. Internal `.`, `_`, and `-` and technology names
such as `C++` and `C#` are retained; presentation punctuation is a separator.
Case-insensitive duplicate tokens are removed.

Every remaining token is required, even when there are many tokens or they
occur in different fields. Studio never switches a long query to phrase mode,
silently truncates it, or forwards user-authored `AND`, `OR`, `NEAR`, column,
quote, or wildcard syntax to SQLite. Tokens of at least three code points are
individually quoted for FTS `MATCH`. One- and two-code-point tokens use bound
`instr(lower(...), lower(?))` checks; when no longer token exists, this
intentionally scans only the derived FTS content table.

Long-token results use BM25 weights title 8, slug 5, excerpt 3, and body 1.
Short-token-only results use the equivalent field priority. Ties use
`updated_at_iso DESC, id ASC`. Search-free lists retain their default ordering
and do not read the index lifecycle singleton.

Only an excerpt/body hit produces `search_match`. It is plain text, limited to
320 UTF-16 code units, with at most 32 UTF-16 highlight ranges. React creates
the `<mark>` elements; the API never returns snippet HTML. Title and slug hits
use the already-visible table cells and return a null context.

## Atomic writes and rebuild

Changed Post/Page create, update, revision restore, autosave Draft promotion,
and WXR import place the canonical mutation and FTS delete/insert in the same
D1 batch. A failed batch leaves neither side changed. No-op saves and unchanged
WXR rows do not rewrite the index. Canonical delete triggers remove the derived
row during permanent delete, Clear content, Reset, and Uninstall.

Fresh installations seed an empty index as `ready`. A logical restore,
or an upgrade that invalidates derived search data, sets
`content_search_index_state` to `rebuild_required`. In operational mode, an
administrator can select **Rebuild search index** on the Dashboard. No
Operations token or IP configuration is needed. Lists, editing, and imports
remain available; search resumes after verification completes.

Keep the Dashboard open to advance the rebuild. If you leave or lose the
connection, choose **Continue rebuild** to resume from the saved checkpoint.
Concurrent edits and imports update their index entries atomically; a rebuild
batch cannot overwrite a newer content revision. The Dashboard shows processed
counts rather than a percentage because content can change during the run.

Maintenance & Recovery also provides rebuild, forced restart, and recovery
with a current ready schema in maintenance or recovery mode. It requires the
Operations boundary, administrator re-verification, and **REBUILD CONTENT SEARCH**.
Use that path when the index reports `recovery_required`.

Both paths share one checkpoint. Start recreates the FTS tables and delete
triggers. Steps process Posts, then Pages, in public-ID batches of five. The
operation ID, phase, and cursors use compare-and-swap checks to prevent stale
requests from repeating work. Completion requires exact row count, canonical
revision parity, zero orphan rows, and both FTS integrity checks.

A search against any non-ready state returns
`CONTENT_SEARCH_INDEX_NOT_READY`; an FTS service failure returns
`CONTENT_SEARCH_INDEX_UNAVAILABLE`. Both are 503 responses; an administrator can check the Dashboard
or use Maintenance & Recovery for a forced rebuild. Search input with no semantic token returns the 400
`CONTENT_SEARCH_QUERY_INVALID` response. Queries and snippets are never logged.

## Logical backup

Studio/Edge logical backup format v2 adds an explicit managed-virtual-table
catalog. In Studio backups, the FTS declarations and delete triggers remain
part of the schema fingerprint, while FTS shadow tables and derived rows are
excluded from schema/data catalogs and row export. Unknown virtual tables or
modules are rejected. Format-v1 artifacts remain restorable.

Every exported content-search singleton is materialized as
`rebuild_required`. A structure-and-data restore therefore creates empty FTS
tables and restores canonical content; a data-only restore uses the canonical
delete triggers to clear old index rows. Complete a checkpointed rebuild after
either restore. Cloudflare documents that D1 export does not support virtual
tables, so Studio logical backup is the supported current-schema path: [D1 import and
export limitations](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

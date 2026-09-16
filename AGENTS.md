# ZeroPress Studio Agent Guide

## Scope and Sources of Truth

- This repository must build and test independently. Do not depend on a parent
  workspace, a sibling checkout, or another project's source files.
- Read [README.md](README.md), the relevant [docs/](docs/), and the READMEs under
  [database/](database/) before changing product or database contracts. Update
  the affected tests and documentation with the implementation.
- Keep this guide limited to instructions that cannot be inferred from code.
  Link to product documentation; omit implementation walkthroughs, development
  plans, and execution records.

## Change Boundaries

- Do not change the package version unless explicitly requested.
- Do not deploy Workers, publish packages, change Cloudflare resources, or
  execute SQL against local or remote D1. Prepare changes for human review.
- Database setup and recovery use Studio's supported lifecycle flows. Do not
  prescribe direct SQL execution or Wrangler D1 migrations, add a top-level
  `migrations/` directory, or configure `migrations_dir`.
- Edge owns the canonical Edge schema contract and SQL artifacts. Keep
  Studio's reviewed copies under `database/edge/` byte-identical, with
  checksums and tests updated together.

## Verification

Run checks appropriate to the change. For code changes, follow the
[validation commands](README.md#validation) and [E2E guide](e2e/README.md).
Build and E2E share output, so run them sequentially. E2E must remain isolated
from developer data and remote resources.

Use `npm run deploy:dry-run` for deployment validation; `npm run deploy`
performs a real deployment.

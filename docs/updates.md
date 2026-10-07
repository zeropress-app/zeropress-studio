# Updating Studio

Choose GitHub Actions to prepare an update PR, or the local command to prepare
a commit on a new branch. Both use fixed release tags such as `v0.7.3`. For the
first update, provide the release tag your installation is based on. Later
updates read it and its source commit from `.zeropress/upstream.json`.

Keep your installation repository's default branch aligned with the production
branch selected in Cloudflare Workers Builds. Review the upstream changes and
any required database or Edge steps before
merging. The configured Cloudflare deployment runs after the merge.

## GitHub Actions

Deploy to Cloudflare does not copy GitHub workflows. Clone your installation
repository, enter its directory, and install the bundled workflow:

```sh
node scripts/install-update-studio.mjs
git add .github/workflows/update-studio.yml
git commit -m "ci: add Studio update workflow"
git push
```

The installer needs only Node.js. It creates `.github/workflows/update-studio.yml`
from `scripts/templates/update-studio.yml`; it does not overwrite a different
existing workflow. Commit and push it to the repository's default branch.

In **Settings → Actions → General → Workflow permissions**, enable **Allow
GitHub Actions to create and approve pull requests**. Organization policies may
restrict this setting. The workflow requests the repository permissions it
needs; it does not require a personal access token or Cloudflare credentials.

Then use **Actions → Update Studio → Run workflow**. Enter the target release
and, for your first update, the installed release. The workflow creates a PR
after validation. An existing open update PR is reused; changes on an update
branch are never force-pushed away.

GitHub may ask you to approve CI runs on the generated PR. The updater's own
validation has already completed before it creates the PR.

## Local command

In a clone of your installation repository, switch to its default branch and
synchronize it with `origin`. Staged, unstaged, and untracked changes must be
committed or preserved before updating. Ignored local environment and data
files can remain in place.

For a guided update, run the command without arguments in a terminal:

```sh
npm ci
node scripts/update-studio.mjs
```

On the first update, confirm the installed release suggested from `package.json`.
Later updates use `.zeropress/upstream.json` automatically. Enter the fixed
release tag to install. The command shows validation progress, then the version
change, changed file count, and whether database or Edge contract files changed.
Enter `y` to create the update branch and commit. The default answer is **No**;
declining, pressing Ctrl+C, or closing input at a prompt cancels without changing
the installation checkout.

For explicit execution, for example from `v0.7.2` to `v0.7.3`:

```sh
node scripts/update-studio.mjs local --from v0.7.2 --target v0.7.3
```

Choose your actual installed and target release tags. Omit `--from` after the
first update. `main`, `latest`, and downgrades are not accepted as update targets.
Explicit execution does not prompt. Running without arguments in CI or with
redirected input/output prints usage guidance and exits with an error.

The command prepares and validates an isolated copy, then creates and checks
out a branch such as `studio-update/261004-1050-a1b2c3` and commits the update.
It uses your Git identity, commit hooks, and signing configuration. It does not
pull, push, open a PR, or merge automatically. Review the commit, push the new
branch, and merge it into the default branch when ready.

Conflict or validation failures leave the original checkout unchanged. If a
Git hook or signing step prevents the final commit, the update remains on its
new branch for you to inspect and finish. Browser installation is not automatic;
if E2E reports a missing browser, run the displayed installation command and
retry. See the [E2E guide](../e2e/README.md#running-the-tests).

## Older installations

If these commands are missing, copy `scripts/update-studio.mjs` from a reviewed
Studio release. For GitHub Actions, also copy `scripts/install-update-studio.mjs`
and `scripts/templates/update-studio.yml` from the same release. Commit and push
these files before using the updater.

## What the update preserves

The updater applies the difference between two upstream releases to your
installation. It supports repositories created by Deploy to Cloudflare without
a shared Git history. Changes to different parts of a file can be merged;
conflicting customizations stop preparation without modifying your branch.

Your `wrangler.jsonc`, local environment files, and installed GitHub workflows
are preserved. A release that changes Wrangler configuration values requires a
manual update. Formatting and comments alone do not block an update. If an
installed workflow needs changes, review and apply the target release's workflow
manually before retrying. The Update Studio workflow is distributed in
`scripts/templates/update-studio.yml`. Uninstalled workflows are not required
for local updates.

Both update paths require dependency installation, Wrangler formatting checks,
tests, typecheck, a deployment dry run, and isolated local E2E to pass before
creating the update commit or PR.

## Database and Edge compatibility

A code update does not upgrade a database or update the Edge Worker. When
database artifacts or the Edge mail contract change, the updater highlights
the required review. Follow [Maintenance & Recovery](maintenance-and-recovery.md)
for backups, maintenance, and supported upgrades. Package versions do not need
to match between Studio and Edge; their database and Queue contracts must be
compatible.

To update manually, apply the release changes while retaining your installation
configuration, then run the [validation commands](../README.md#validation)
before deployment. If `.zeropress/upstream.json` already exists, record the
reviewed release tag and its full upstream commit there as part of that update.
Worker rollback does not reverse database upgrades; use the documented
[compatibility guidance](maintenance-and-recovery.md#worker-rollback-and-database-compatibility).

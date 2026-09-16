# Studio browser E2E

Playwright tests cover installation, authentication, account activation,
Operations, configuration errors, authoring, and responsive navigation through
the built Studio Worker. See [specs/](specs/) for individual scenarios.

## Running the tests

```sh
npm run test:e2e
npm run test:e2e:ui
```

`npm run test:e2e` and `npm run test:e2e:ui` check the required browsers before
building the local Worker. By default, UI mode needs Chromium for its window
and Headless Shell for tests. If a browser is missing, the command stops and
shows the installation command. Install before the first run or when prompted
after a Playwright update:

```sh
npx playwright install chromium
```

## Local environment

The public root `wrangler.jsonc` is sufficient. Tests use isolated local
resources and generated credentials, without remote bindings or the normal
development database, R2 data, or `.dev.vars` values.

Temporary state lives under ignored `.wrangler/e2e/` and is removed when the
suite exits normally. Tests use local ports `4198` (preparation server), `4299`
(template installation), and `4199` (test Worker).

Both commands build the `local-preview` Worker and share `dist/` with ordinary
builds. Run them sequentially, keep those ports free, and run `npm run build`
again before deployment.

## Artifact privacy

The default reporter retains only spec basename/line, status, retry count and
duration in `playwright-report/summary.json`. Raw error messages, call logs,
steps, stdout/stderr, screenshots, videos, traces and HTML reports are not
retained by the default reporter.

Playwright can create a temporary `error-context.md` containing the DOM even
with tracing disabled. Ordinary E2E removes per-test output after the run.
Wrangler diagnostic logs live under disposable `.wrangler/e2e`, not
the developer's global log directory. Treat these directories as private while
running; an OS kill can interrupt cleanup. Before sharing artifacts after an
interrupted run, remove only the harness's `.wrangler/e2e`, `.wrangler/e2e-ui`,
and `test-results` directories once its processes have stopped. Only
`playwright-report/summary.json` is sanitized for sharing; raw artifacts and
old HTML reports may contain private data.

For local diagnosis or visual QA, use `npm run test:e2e:ui`. Actions and page
snapshots remain available under `.wrangler/e2e-ui/session-*` until the UI
closes. Closing the window or stopping the command with Ctrl+C removes that
session's output after Playwright exits. These records can contain credentials;
do not screen-record/export the session without review. `--reporter=list` is
an explicit local diagnostic override and can print raw assertion values.

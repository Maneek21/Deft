# Gate G experiment and acceptance tools

These fixtures exercise proposed boundaries. They do not implement or certify the production App platform. Internal decisions and execution reports live outside this repository.

- `experiences/`: loopback browser egress and bounded interaction experiment.
- `runtime/`: separate-process recovery experiment with independent synthetic host/provider ledgers.
- `public/`: transaction/claim experiment on an explicitly assigned disposable PostgreSQL database.
- `required-tests.json`: reviewed inventory including 90 App Kit and 56 focused platform unit tests, the selected legacy-MCP cutover-on and ancestry profiles, Runtime/public/installed journeys, and bounded private sync, owner-read, scheduler, authenticated HTTP, and CRM compatibility profiles. This is not the complete Gate G matrix; remaining database, browser, recovery, and compound profiles require separate evidence.
- `verify-upgrade.mjs`: read-only retained-data fingerprints and schema snapshots for the assigned disposable PostgreSQL cluster. Capture a tracked predecessor before candidate upgrades, compare retained columns afterward, and compare candidate fresh/upgrade schemas separately.

## Capture and check test execution

From the relevant package, pass reporter flags **before** test file arguments:

```text
pnpm exec tsx --test --test-concurrency=1 --test-reporter=spec --test-reporter-destination=stdout --test-reporter=../../scripts/gate-g/acceptance-reporter.mjs --test-reporter-destination=<absolute-evidence-path> test/*.test.ts
```

App Kit must first be built. Its packed consumer tests require `npm_execpath` to name the matching pinned pnpm CLI and the pinned dependencies to be available in that CLI's offline cache. A bare `pnpm exec` does not establish `npm_execpath` on every host. The ordinary `pnpm --filter @deft/app-kit test` remains the standard suite command, but appending reporter flags after its test glob does not capture reporter output on the tested tsx version. Do not replace a missing capture with a green console summary.

From the repository root:

```text
node scripts/gate-g/check-evidence.mjs scripts/gate-g/required-tests.json app-kit <absolute-evidence-path>
node --test scripts/gate-g/check-evidence.test.mjs
```

The checker requires every inventoried case exactly once, exact source paths rooted in the current checkout, no failures/skips/todos/cancellations, matching execution counts, and a final runner summary. Failed or truncated output fails closed. Additional executed tests must also pass. The JSONL reporter omits test stdout and error details; retain a separate console log for diagnosis.

This checks execution completeness, not authenticity: JSONL is not a signed attestation. Record the source revision, fixture hashes/diff, runtime versions, command, environment profile and reviewer alongside evidence. A rerun or source change requires a new evidence record. Required cases must never be removed merely to make a gate green.

The private-reader and scheduler inventories name their nested boundary cases as
well as the parent test. A passing parent does not cover an omitted child. Use
the exact synthetic database guards described by each profile and matching
`DATABASE_URL`/`DEFT_TEST_DATABASE_URL`; a wrong target produces skipped tests and
must fail evidence checking. The resource-sync and owner-reader HTTP profiles
cover host surfaces; they do not certify an installed Experience broker, sharing,
or public access. The separate `experience-exposure-http` profile covers explicit
session-bound private-field consent and bounded delivery. Its focused cases still
require independent packed Worker/browser evidence and the remaining authority
matrix.

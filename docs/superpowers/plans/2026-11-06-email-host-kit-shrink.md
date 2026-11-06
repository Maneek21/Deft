# Email Host and Kit Shrink Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** proposed, 2026-11-06. This is a plan only. No stage may remove code until the user approves that stage.

**Goal:** Cut the Host and Kit boundary allowlist from 1,277 exceptions to 437 by 2027-01-12, leaving only permanent history and data or wire compatibility that needs its own decision.

**Architecture:** Each stage deletes one group of exceptions, grouped by what its removal depends on. Stages lower a checked-in ceiling, so the gate shrinks the coupling instead of only stopping growth. Retained data, keys and historical migrations are never touched by this plan.

**Tech Stack:** TypeScript, Hono, Next.js, Drizzle, `scripts/check-app-boundary.mjs`, `@deft/app-kit` tarballs built by `release.yml`.

**Spec:** [App-neutral Host and Author Kit boundaries](../../plans/2026-10-20-app-neutral-host-and-author-kit.md), with [installed Email boundary](../../decisions/2026-10-14-installed-email-boundary.md), [Kit domain ownership](../../decisions/2026-10-20-kit-domain-ownership.md) and [native source ownership](../../decisions/2026-10-20-native-source-ownership.md).

**Evidence:** [Record-level burn-down report](../../reports/2026-11-06-email-boundary-burn-down.json). All counts here come from `release/email-ready-20261104` at `6bf020ebdcd280abdd2ef21d4e13a491f03cbb5a`, the head of open PR #424, where the checker reports `1277 exact findings, 1277 exceptions, 0 errors`.

## Global Constraints

- Start nothing until Stage 0 is complete. Stage 0 is outside this plan's work.
- Do not edit historical migrations, drop tables, or retire keys. Removing UI is not deleting data.
- Do not weaken a security, audience or authority check to make a removal pass. Unknown legacy mappings fail closed.
- Delete allowlist records only when the code goes. Never regenerate the baseline. Any added record needs a reason, owner and review, as `docs/app-boundary-gate.md` requires.
- Kit `0.1.0-alpha.44` is reserved for the removal in Stage 6. Published Kit archives stay immutable.
- Each stage is one PR off current master, and it lowers `max_exceptions` in `scripts/app-boundary-ceiling.json` to that stage's target.
- Run the checker on a clean Kit build: delete `packages/app-kit/dist`, then run `pnpm --filter @deft/app-kit build`.

## Review Focus

1. **Stale `dist` in a packed Kit.** `tsc` does not delete old output and `files` ships all of `dist`, so a dirty build could publish removed facades. The tarball must contain no `compatibility.js` (Stage 6).
2. **Lost side effect of the Kit root import.** Today `@deft/app-kit` registers the sandbox profile as a side effect. After alpha.44 it must register nothing, and tests that relied on it must opt in explicitly (Stage 6).
3. **A private copy reaching a shared answer** after the Knowledge caller switch, especially legacy rows with no v2 association. These must behave exactly as before or fail closed (Stage 7).
4. **Old citation links after adoption retires.** Stored `/apps/source/native-email/...` links must show an unavailable state, keep the excerpt, and leak no locator (Stage 9).
5. **Rollback past the dual Calendar reader.** A Host older than the Stage 5 merge cannot be a rollback target for new recurring rows, so the minimum rollback build must be recorded (Stage 5).

---

## Where things stand

| Measure | Count on the audited tree |
| --- | --- |
| Allowlist records / occurrences / files | 1,277 / 1,966 / 267 |
| Email-named API source files | 35 |
| Email-named web files | 5 (4 pages and 1 fixture) |
| Email-named DB schema files / upgrade files | 19 / 30 |
| Retained `email_*` tables | 40 |
| `examples/apps/email` tracked files | 221 |
| Deprecated Kit names in `compatibility.ts` and `example-compatibility.ts` | 35 |

### Corrections to the starting brief

- **`examples/apps/email` is not pinned to alpha.32.** Its `package.json` and lockfile use `link:../../../packages/app-kit`, so it tracks the workspace Kit. "alpha32" is only a stale README line. This matters: any Kit removal breaks the example immediately, so it must go first.
- **Web count is 5, not 7.** The other brief counts reproduce.
- **Plan C is further along than "unfinished".** Contracts and adapters merged in #381, #383, #386, #390, #391, #393 and #394. What is left is switching callers. #397 does this for Calendar, but it has been idle since 2026-10-20 and now conflicts with the release tree in `apps/api/src/routes/dashboard.ts`.
- **Plan D's Email migration is already done.** `deft-email` on its release branch uses none of the deprecated names, and owns its copies in `runtime/domain`. The remaining users of deprecated names are in this repository.
- **Not all of `examples/email/*` can go.** See "Kit release" below.

### What keeps the retained mail code alive

Runtime imports only, from `apps/api/src/index.ts`, `server.ts` and `workers/index.ts`:

| Entry point | Neutral callers | Files only it keeps alive |
| --- | --- | --- |
| `routes/email-native-adoption-source.ts` | `index.ts` | 20 files, the route included |
| `email-knowledge-visibility.ts`, `email-knowledge-citations.ts` | `agent-runner`, `native-wiki-owner`, `retrieve-context`, `routes/wiki` | 2 |
| `email-calendar-projection.ts` | `routes/calendar`, `routes/dashboard` | 1 |
| `email-mailbox-key-references.ts` | `host-source-storage` | 1 (retained custody owner) |

That accounts for 24 of the 35 files. The other 11 have no runtime path from production: 10 are removed in Stage 3, and `email-calendar-invitation.ts` follows the Calendar helper in Stage 9.

## Allowlist grouped by what removal depends on

| Bucket | Records | Removal depends on | Stage |
| --- | ---: | --- | --- |
| N1 Neutral wording and fixtures | 99 | Nothing. Comments, Host copy and test strings. | S2 (6 Kit lines in S6) |
| D1 Unreachable transport | 91 | Nothing at runtime. Needs type cleanup only. | S3 |
| E1 Example test imports | 3 | D1 removing the fourth importing test | S4 |
| C1 Calendar callers | 23 | Rebased #397 (4 records), then the adoption retirement (19) | S5, S9 |
| K1 Kit compatibility graph | 237 | Plan D removal: S4, then alpha.44 | S6 |
| K2 Kit parity fixtures | 8 | Plan D removal: corpus already owned by `deft-email` | S6 |
| C2 Knowledge callers | 13 | Plan C caller switch with parity proof | S7 |
| R1 Adoption and recovery | 368 | S5, S7, the data inventory and a go decision | S9 |
| W1 Wire spellings | 67 | Serialized contracts such as `mailbox_list`, used by installed Apps. Kit export removal cannot clear these. | S10 decision |
| R2 Custody and storage owner | 28 | Key and data retirement | S11 decision |
| R3 Schema and tables | 144 | Separately authorized data retirement | S11 decision |
| X1 Frozen protocol fixture | 1 | Protocol 1/2 retirement, not scheduled | Kept |
| P1 Historical migrations and lineage | 153 | Never removed | Permanent |
| P2 ICS interoperability | 8 | Never removed (`Outlook` as a calendar client) | Permanent |
| P3 Reviewed tooling and gate fixtures | 34 | Never removed; re-review on change | Permanent |
| **Total** | **1,277** | | |

The existing milestone labels hide two things. 680 records say only "to be removed by plan C/D", though they split across nine different buckets. And K2 mixes in 3 records that follow the retained stores (moved to R1) and 3 generic loaders or gate fixtures (moved to P3).

## Sequence and dates

Dates are target merge dates. They assume Stage 0 finishes by 2026-11-10. If it slips, every later date moves by the same number of working days. The 14-day Kit notice, the 14-day Knowledge hold and the 30-day retention notice are minimums and are never shortened.

| Stage | Work | Target | Hard dependency | Records after |
| --- | --- | --- | --- | ---: |
| S0 | #424 merged, Host and Kit alpha.43 released, Email bumped, Gmail smoke passed | 2026-11-10 | None | 1,277 |
| S1 | Burn-down baseline, ceiling, alpha.44 notice | 2026-11-11 | S0 | 1,277 |
| S2 | Neutral wording and fixtures | 2026-11-13 | S1 | 1,184 |
| S3 | Delete unreachable transport code | 2026-11-17 | S1 | 1,093 |
| S4 | Remove `examples/apps/email` | 2026-11-19 | S3 | 1,090 |
| S5 | Calendar caller switch (rebased #397) | 2026-11-20 | S1 | 1,086 |
| S6 | Kit `0.1.0-alpha.44` | Merge 2026-11-24, release 2026-11-25 | S4, 14-day notice | 837 |
| S7 | Knowledge caller switch | 2026-12-04 | S1 | 824 |
| S8 | Retained-data inventory and adoption decision | 2026-12-11 | S5, S7 released | 824 |
| S9 | Adoption and recovery retirement | 2027-01-12 | S8 go, 14-day hold, 30-day notice | 437 |
| S10 | Wire spelling decision, no removal | 2027-02-02 | S9 | 437 |
| S11 | Custody and schema retirement review, no removal | 2027-03-02 | S9 | 437 |

S2, S3, S5 and S7 do not depend on each other and can run in parallel. The running totals assume the order above. Each stage removes the same number of records whichever order they merge in. S6 nets 249 because it adds up to 2 reviewed fixture records.

After S9, `apps/api/src` has one email-named file, the retained custody owner. The 437 left are 195 permanent, 172 custody and schema, 67 wire spellings, and 3 sandbox-related fixture records.

## `examples/apps/email`: remove it

**Decision: remove it completely in Stage 4. Do not reduce it to a fixture.**

A minimal fixture is not actually minimal. The Host tests pull in 54 of its modules. Even after Stage 3, `connection-http.mjs` alone drags in 47 modules, `mailparser` and `nodemailer`, and three of those modules still import deprecated Kit names, so keeping them would block alpha.44. Those tests check Host behavior, so a small neutral adapter proves the same thing. The example's own 75 test files are not run by any CI job, so removing them loses no CI coverage.

| Dependent | Reference | Stage 4 action |
| --- | --- | --- |
| `.github/workflows/ci.yml:215-216` | Step "Install locked active Email test dependencies" | Delete the step |
| `.github/workflows/email-preview-stack.yml:201` | Install line in the "Build current SDK..." step | Delete the line and keep the Kit build |
| `apps/api/test/email-imap-native-host.test.ts:9-15` | 4 provider imports | Already deleted in Stage 3 |
| `apps/api/test/app-experience-targets-http-db.test.ts:176-177` | `connection-http.mjs`, `custody-encrypted.mjs` | Use a neutral fixture adapter |
| `apps/api/test/app-experience-current-run-output-http-db.test.ts:5` | `triage-receipt-ui.mjs` (16 lines) | Copy the parser into a test fixture |
| `apps/api/test/app-attachment-pdf-http-db.test.ts:11` | `synthetic-brief.pdf` | Move it, byte-identical |
| `scripts/stage-email-runtime-bundle.mjs:65` | Reads the example; nothing calls this script | Delete the script |
| `.github/codeql-reviewed-false-positives.json` | 14 findings, 40 path mentions | Remove the entries; `scripts/codeql-reviewed-findings.test.mjs` must pass |
| `scripts/app-boundary-allowlist.json` | 7 import records | 4 go in S3, 3 in S4 |

Historical docs under `docs/superpowers/experiments`, `docs/history` and `docs/reports` keep their paths, as they describe past commits. `test:email-preview-api` and the mailbox predecessor database are **not** example dependencies: that script runs the entire API suite, and the predecessor database serves the retained store tests. They stay until Stage 9.

## Kit release: `0.1.0-alpha.44`

**`@deft/app-kit` `0.1.0-alpha.44` is the "next breaking Kit alpha".** It ships no earlier than 2026-11-25, in the first Host release after Stage 6 merges. That is expected to be Host `0.3.0-preview.142`, if #424 ships as preview.141 and no other Host release comes first.

Alpha.43 cannot be that release. It has to ship right after #424 so Email can bump, the in-repo example and 6 Host tests still use the deprecated names, and no notice has been given.

| Surface | alpha.44 |
| --- | --- |
| `compatibility.ts`: 26 names on root and `/experience` | **Removed** |
| `example-compatibility.ts`: 9 sandbox names on root | **Removed** |
| `checkDeftAppDeveloperContract` override in root and `examples/email/index.ts` | **Removed**; root uses the core version |
| `examples/email/{safe-compose-html,mailbox-list,native-compose-raster}.ts` | **Removed**; production owner is `deft-email`, and only Kit tests import them here |
| `examples/email/{sandbox,templates,register,cli}.ts` and the 3 subpath exports | **Kept**, opt-in only |
| Root `.` and `/experience` entry points | Kept as aliases of `/core` and `/experience/core` |

The kept sandbox files are not a missed removal. The compatibility notices name that subpath as the replacement, and it is needed to rebuild the frozen Protocol 1 proof in `examples/connected-resource-campaigns-app`, checked by `phase5-proof-package-determinism.test.ts`. The 2026-10-14 decision puts Protocol 1/2 retirement out of scope because it would change Campaigns and CRM behavior. Once the root stops importing it and Stage 6 makes one narrow checker change, the checker no longer scans that subpath, so all 237 K1 records still go. No Kit release is named for the sandbox files because Protocol 1/2 retirement has no date.

If an urgent Kit release must ship first, it takes alpha.44, this removal becomes alpha.45, and the plan, README and notice are updated the same day. Additive Kit work otherwise waits for alpha.45.

## Decisions needed from the user

| # | Decision | Recommendation | Needed by |
| --- | --- | --- | --- |
| 1 | Approve this plan and each removal stage | Approve S1 to S7 as a batch | 2026-11-10 |
| 2 | Remove the 3 mail modules from the example subpath in alpha.44 | Yes. The deprecation text points legacy tooling there, so the notice must say this plainly. | 2026-11-11 |
| 3 | Keep the sandbox subpath until Protocol 1/2 retires, and let test-only imports of it skip traversal | Yes. Without the checker change, 45 sandbox records stay and S6 ends at 882. | 2026-11-11 |
| 4 | Retire adoption and recovery reads | Decide at S8 from the inventory | 2026-12-11 |
| 5 | Keep or replace `mailbox_list` and other wire spellings | Decide at S10; leaning keep until a future App Protocol | 2027-02-02 |

---

### Stage 0: Release gate (not part of this work)

**Target:** 2026-11-10

- [ ] Confirm #424 is merged and the Host release is deployed.
- [ ] Confirm Kit `0.1.0-alpha.43` is published and Email has bumped its pin (Deft-email PR #31).
- [ ] Confirm the demo.deft.ing smoke test with a real Gmail account passed.
- [ ] Re-run the checker on master. If the count is not 1,277, regenerate the report and update every target in this plan before Stage 1.

**Completion evidence:** Release links, and checker output on the merged commit.

### Stage 1: Burn-down baseline and alpha.44 notice

**Files:**
- Create: `scripts/app-boundary-ceiling.json`
- Modify: `scripts/check-app-boundary.mjs`, `scripts/check-app-boundary.test.mjs`, `scripts/app-boundary-allowlist.json`
- Modify: `docs/app-boundary-gate.md`, `packages/app-kit/README.md`, `CHANGELOG.md`

**Interfaces:**
- Produces: `validateAllowlistCeiling(entries: object[], ceiling: { max_exceptions: number }): string[]`, the `--summary` flag printing `<count>\t<milestone>`, and milestones starting with the bucket ID (`N1`, `D1`, and so on). All later stages depend on these.

- [ ] **Step 1: Write failing tests** in `check-app-boundary.test.mjs`: `fails when exceptions exceed the ceiling` asserts one error for 3 entries against `{max_exceptions: 2}`, and `summary groups exceptions by milestone` asserts one line per milestone with its count.
- [ ] **Step 2: Run `pnpm test:app-boundary`.** Expected: both new tests fail.
- [ ] **Step 3: Implement** `validateAllowlistCeiling` and `--summary`, and create the ceiling file with `{ "max_exceptions": 1277 }`.
- [ ] **Step 4: Rewrite each record's `milestone`** from the report as `<bucket>: <stage> of docs/superpowers/plans/2026-11-06-email-host-kit-shrink.md`. Leave `reason` and every identity field alone. The checker does not include `milestone` in the record identity, so no finding changes.
- [ ] **Step 5: Update `docs/app-boundary-gate.md`** rule 3 to the new milestone form, and document the ceiling.
- [ ] **Step 6: Publish the notice** in the Kit README and `CHANGELOG.md`: alpha.44 removes the listed names and the 3 subpath modules, not before 2026-11-25, and consumers should use `/core` and the `deft-email` modules. Do not edit the `@deprecated` lines, because that would change the context digests for no gain.
- [ ] **Step 7: Rewrite issue #382** to link this plan and list the buckets.
- [ ] **Step 8: Run `pnpm test:app-boundary` and `node scripts/check-app-boundary.mjs --summary`.** Expected: tests pass, and the bucket totals match the table above.
- [ ] **Step 9: Commit.**

**Completion evidence:** `App boundary: 1277 exact findings, 1277 exceptions, 0 errors.`, `--summary` output matching the bucket table, the notice merged by 2026-11-11, and #382 updated. Records after: 1,277.

### Stage 2: Neutral wording and fixtures

**Files:** The 40 non-Kit files listed under `N1-neutral-wording-and-fixtures` in the report, mainly `apps/web/src/lib/*.test.ts`, plus these source lines:
- `apps/api/src/lib/agent-action-proposals.ts:1196`, `agent-approval-resolver.ts:971`, `app-experience-exposure.ts:985`, `app-integration-notification-service.ts:26`, `app-integration-source-publication.ts:15`, `native-wiki-owner.ts:110`
- `apps/api/src/lib/calendar-invitation.ts:33,57,125`: rename local `mailbox()` to `calendarAddressValue()`
- `apps/web/src/components/apps/experience-background-refresh-review.tsx:7`: "mailbox metadata" becomes "account metadata"
- `apps/web/src/lib/fixtures/email-e2-2-app-navigation.json`: rename to `app-navigation-fixture.json` and update its importers

- [ ] **Step 1: Replace mail wording** with neutral words in the listed comments, Host copy and test strings. Keep every serialized value, API field and `mailbox_list` spelling as it is; those are W1.
- [ ] **Step 2: Delete exactly the N1 records** for those lines, and set the ceiling to 1,184.
- [ ] **Step 3: Run** `pnpm --filter @deft/app-kit build`, `node scripts/check-app-boundary.mjs`, `pnpm --filter @deft/api typecheck`, `cd apps/web && npx tsc --noEmit`, and the changed web and API tests. Expected: no failures, and no assertion loosened.
- [ ] **Step 4: Commit.**

**Completion evidence:** Checker reports 1184 with 0 errors. `--summary` shows N1 at 6, all of them Kit lines. The diff changes no runtime logic beyond the rename and the copy. Records after: 1,184.

### Stage 3: Delete unreachable transport code

**Files:**
- Delete from `apps/api/src/lib/`: `email-draft-sync-contract.ts`, `email-folder-management-contract.ts`, `email-graph-send-contract.ts`, `email-imap-alias-contract.ts`, `email-imap-custody.ts`, `email-imap-host.ts`, `email-native-connection-contract.ts`, `email-native-connection-retained.ts`, `email-public-address.ts`, `email-smtp-host.ts`
- Delete from `apps/api/test/`: `email-imap-custody.test.ts`, `email-imap-host.test.ts`, `email-imap-native-host.test.ts`, `email-smtp-host.test.ts`
- Modify: `apps/api/src/lib/email-native-adapter-contract.ts`, `apps/api/src/lib/web-push.ts`, `apps/api/test/web-push-policy.test.ts`

- [ ] **Step 1: Re-prove reachability** with `pnpm exec node scripts/audit-email-reachability.mjs <full commit sha>`. If any listed file has a runtime importer outside the list, stop and report it.
- [ ] **Step 2: Write the failing test** `retained email attention rows never push` in `web-push-policy.test.ts`: a `source_type: 'email'` item is skipped with no database read.
- [ ] **Step 3: Run the test.** Expected: FAIL.
- [ ] **Step 4: Confirm nothing creates `email` attention items.** A search of the audited tree found no producer, and the `native-email-notification-dispatch` job has no handler. If a producer exists, stop and report it. Otherwise replace `emailNotificationPushStillCurrent` with a fail-closed skip in `web-push.ts`.
- [ ] **Step 5: Delete the listed files** and remove their type imports from `email-native-adapter-contract.ts`, keeping only the types still used by retained stores.
- [ ] **Step 6: Delete the 91 D1 records** and set the ceiling to 1,093.
- [ ] **Step 7: Run** API typecheck, `web-push-policy.test.ts`, `pnpm test:app-boundary` and the checker. Expected: all pass with 1093 and 0 errors.
- [ ] **Step 8: Commit.**

**Completion evidence:** Checker reports 1093 with 0 errors, the reachability audit lists no deleted file, the full API CI job is green, and `--summary` shows D1 at 0. Records after: 1,093.

### Stage 4: Remove `examples/apps/email`

**Depends on:** Stage 3, which removes the test that imports 4 of its providers.

**Files:**
- Create: `apps/api/test/fixtures/app-connection-fixture-adapter.ts`, `apps/api/test/fixtures/run-receipt-parser.ts`
- Move: `examples/apps/email/fixtures/launch-stage0/synthetic-brief.pdf` to `apps/api/test/fixtures/synthetic-brief.pdf`
- Modify: the three tests and the CI lines in the table above, and `.github/codeql-reviewed-false-positives.json`
- Delete: `examples/apps/email/`, `scripts/stage-email-runtime-bundle.mjs`

**Interfaces:**
- Produces: `createFixtureConnectionAdapter(input: { assertCurrent: (context: AppConnectionContext) => Promise<unknown> }): AppConnectionAdapter`, an in-memory adapter with status, begin, callback and disconnect, and `readTriageReceipt(run)` with the same behavior as the example's parser.

- [ ] **Step 1: Check Email coverage.** `createAppConnectionAdapter` and `readTriageReceipt` do not exist under those names in `deft-email`. Confirm where its Runtime covers verified-alias and OAuth behavior. If it does not, open a `deft-email` issue before deleting.
- [ ] **Step 2: Change `app-experience-targets-http-db.test.ts`** to use the fixture adapter. Keep these Host assertions: denied nominations never reach the adapter, projection pins match, `recheck()` runs, and credentials and cookies are stripped. Drop only the Gmail URL assertions.
- [ ] **Step 3: Point the receipt and PDF tests** at the new fixtures. The PDF's SHA-256 must remain `7dcd3e988227137bbea91d996b903482a80f1f49ca3fdebd5ad6db9242b6669f`.
- [ ] **Step 4: Run the three tests.** Expected: PASS while the example is still present.
- [ ] **Step 5: Delete the example, the staging script and the two CI install lines.** Remove its CodeQL entries, delete the 3 E1 records, and set the ceiling to 1,090.
- [ ] **Step 6: Run** `node scripts/codeql-reviewed-findings.test.mjs`, `git grep -n "examples/apps/email" -- apps packages scripts .github package.json` and the checker. Expected: tests pass, the grep is empty, and the checker reports 1090 with 0 errors.
- [ ] **Step 7: Commit.**

**Completion evidence:** Green full CI with no example install step, an empty grep, and the matching PDF hash. Records after: 1,090.

### Stage 5: Calendar caller switch

**Files:** Rebase #397 (`refactor/native-calendar-source-reader`): `apps/api/src/lib/native-calendar-source.ts`, `apps/api/src/routes/calendar.ts`, `apps/api/src/routes/dashboard.ts`, `apps/api/src/lib/email-mailbox-key-references.ts`, `apps/api/test/native-calendar-source.test.ts`, `apps/api/test/email-calendar-projection.test.ts`, `docs/decisions/2026-10-20-native-source-ownership.md`

- [ ] **Step 1: Rebase #397 on master** and resolve the `dashboard.ts` conflict by keeping both sides' behavior.
- [ ] **Step 2: Run** `native-calendar-source.test.ts` and `email-calendar-projection.test.ts` against disposable PostgreSQL. Expected: PASS for org and owner isolation, revoked membership, absent runtime, pre-window masters, DST, EXDATE, moved and cancelled exceptions, all-day ends, native edits, and unknown or mixed models.
- [ ] **Step 3: Compare a `pg_dump`/`pg_restore` snapshot** of legacy rows, including event and occurrence IDs and ciphertext key references, as the #397 proof did.
- [ ] **Step 4: Update the allowlist:** delete the 4 caller records in `calendar.ts` and `dashboard.ts`, re-review the changed `email-mailbox-key-references.ts` digest, and set the ceiling to 1,086.
- [ ] **Step 5: Record the merge commit** as the minimum rollback build in `native-source-ownership.md`, then merge.

**Completion evidence:** Checker reports 1086 with 0 errors, the snapshot comparison is clean, and `git grep -n "email-calendar-projection" -- apps/api/src/routes` is empty. The helper stays until Stage 9. Records after: 1,086 if merged in table order.

### Stage 6: Kit `0.1.0-alpha.44`

**Depends on:** Stage 4, and 14 days since the Stage 1 notice.

**Files:**
- Delete: `packages/app-kit/src/compatibility.ts`, `example-compatibility.ts`, `examples/email/{safe-compose-html,mailbox-list,native-compose-raster}.ts`
- Delete tests: `packages/app-kit/test/{mailbox-list,native-compose-budget,native-compose-raster,native-safe-compose-images,native-safe-compose-links,safe-compose-html}.test.ts`, `test/fixtures/alpha38-39-mail-consumer.ts`
- Modify: `packages/app-kit/src/{index,experience-sdk,core,app-data}.ts`, `examples/email/index.ts`, `package.json`, `README.md`
- Modify tests: `packed-transition.test.ts`, `safe-rich-text.security.test.ts`, `protocol-v1.test.ts`, `protocol-v2.test.ts`, `developer-contract.test.ts`
- Create: `apps/api/test/fixtures/historical-sandbox-profile.ts`, `packages/app-kit/test/fixtures/sandbox-example.ts`
- Modify: `scripts/check-app-boundary.mjs`, `scripts/check-app-boundary.test.mjs`, `docs/app-boundary-gate.md`
- Modify: the 6 Host tests named in Step 4, and any other test that relied on the root's side effect

**Interfaces:**
- Consumes: `@deft/app-kit/examples/email`, reduced to the sandbox contract and templates. Importing it registers the sandbox profile.
- Produces: `DEFT_APP_KIT_VERSION = '0.1.0-alpha.44'`, with the `versions` list in `core.ts` still accepting alpha.43 and older.

- [ ] **Step 1: Write failing tests** in `packed-transition.test.ts`: `alpha44 tarball has no compatibility files` asserts the packed file list has no `compatibility.js` or `example-compatibility.js`; `root import registers no private interface` asserts the sandbox contract is unregistered after importing only the root; `register preload still builds the frozen proof` asserts the opt-in path works; `removed names fail for an old consumer` asserts that compiling the alpha.38/39 fixture reports missing exports.
- [ ] **Step 2: Run** `pnpm --filter @deft/app-kit test`. Expected: the new tests fail.
- [ ] **Step 3: Narrow the checker.** Today a test's import of any Kit path is queued for a full scan, so importing the sandbox example from a test would pull all 45 sandbox-side records back in. Add `test-only import of an optional example is reported but not traversed` and keep `workspace subpath, TS path alias and neutral wrapper cannot hide optional imports` passing, then stop the reference-only branch from following `packages/app-kit/(src|dist)/examples/`. Host and core imports are still traversed and still rejected. Update `docs/app-boundary-gate.md`.
- [ ] **Step 4: Migrate sandbox users to one fixture per package.** `historical-sandbox-profile.ts` re-exports the sandbox names from `@deft/app-kit/examples/email` for `app-automation-definition-service`, `app-origin-run-cutover-db`, `app-origin-run-lifecycle-db`, `app-public-service-db`, `app-run-attempt-runner` and `crm-public-lifecycle-db`. `sandbox-example.ts` does the same for Kit's `protocol-v1`, `protocol-v2` and `developer-contract` tests. Root imports of other names can stay, because root remains a valid alias. Any test that relied on the root's side effect fails here and moves to the fixture too.
- [ ] **Step 5: Remove the facades,** the root override and the 3 modules. Make `safe-rich-text.security.test.ts` compare against frozen vectors instead of the deleted modules. Reword the Kit N1 comment in `app-data.ts`.
- [ ] **Step 6: Set the version** to alpha.44 and update the README.
- [ ] **Step 7: Delete `packages/app-kit/dist`, rebuild,** and run the Kit tests. Expected: PASS.
- [ ] **Step 8: Certify the packed tarball in `deft-email`** by running its app and Runtime tests against the file. Do not bump Email's pin. Expected: PASS, as Email uses none of the removed names.
- [ ] **Step 9: Update the allowlist:** delete 237 K1, 8 K2 and 6 N1 records, add at most 2 reviewed `email-import` records for the two fixtures, and set the ceiling to 837. The `compatibility-facade-import` rule and its fixtures stay as a regression guard.
- [ ] **Step 10: Merge, then release** through `release.yml` on or after 2026-11-25. Confirm the release carries the alpha.44 tarball with its source commit, digest and integrity record.
- [ ] **Step 11: Add an addendum** to `2026-10-20-kit-domain-ownership.md` naming the release.

**Completion evidence:** Checker reports 837 with 0 errors on a clean build; the tarball listing contains no facades; the Email certification run passes; `phase5-proof-package-determinism.test.ts` passes; published release assets are linked. **Rollback:** consumers pin alpha.43. No wire format or Host data changes. Records after: 837.

### Stage 7: Knowledge caller switch

**Files:**
- Modify: `apps/api/src/lib/agent-runner.ts:445`, `native-wiki-owner.ts:65,141`, `retrieve-context.ts:1156`, `wiki-visibility.ts:36-37`, `apps/api/src/routes/wiki.ts:832`, `apps/web/src/app/(app)/knowledge/page.tsx`
- Delete: `apps/api/src/lib/email-knowledge-visibility.ts`, `email-knowledge-citations.ts`
- Rename: `apps/api/test/email-knowledge-audience-db.test.ts` to `native-knowledge-audience-db.test.ts`

**Interfaces:**
- Consumes: `appSourceKnowledgeAudienceCondition` from `native-knowledge-source.ts`, and `hostRetainedSourceStorage.knowledge.{origins,decorateCitations,sourceUrl}`.

- [ ] **Step 1: Write a parity test** in `native-knowledge-audience-db.test.ts`: `native audience returns the same pages as the retained condition` compares page ID sets on seeded rows across cross-org, cross-user, revoked membership, revoked employee, private copy in a personal agent DM, private copy in a shared answer, a space capture in another space, and a legacy row with no v2 association.
- [ ] **Step 2: Run it** against disposable PostgreSQL. Expected: PASS. If the sets differ, stop. A wider native result is a bug, and a narrower one needs a reviewed reason.
- [ ] **Step 3: Switch the four callers** and read origins from `hostRetainedSourceStorage.knowledge`. Use Host-provided citation labels on the Knowledge page. Enable no new producer.
- [ ] **Step 4: Delete the two shims,** and trim the parity test to the native condition with frozen expected IDs.
- [ ] **Step 5: Delete the 13 C2 records,** add a reviewed record only where a retained value must move into the storage owner, and set the ceiling to 824 plus any such additions.
- [ ] **Step 6: Run** API typecheck, the renamed test, `retrieve-context` and wiki tests, and the checker.
- [ ] **Step 7: Commit, and include this stage in a Host release.** The 14-day hold counts from that release.

**Completion evidence:** Parity output, checker at 824 with 0 errors, and `git grep -n "emailKnowledge" -- apps/api/src` matching only retained storage owner files. Records after: 824.

### Stage 8: Retained-data inventory and adoption decision

**Files:**
- Create: `apps/api/src/scripts/report-retained-source-inventory.ts`, `docs/reports/2026-12-11-retained-source-inventory.json`, `docs/decisions/2026-12-11-retained-adoption-retirement.md`

**Interfaces:**
- Produces: `reportRetainedSourceInventory(): Promise<Array<{ org_hash: string; table: string; rows: number; newest_at: string | null }>>`, read-only, with no content, addresses or raw org IDs.

- [ ] **Step 1: Write the test** `inventory reports counts only`, asserting the output keys above and no message content, on seeded rows.
- [ ] **Step 2: Implement it** to cover all 40 retained tables, and run it on demo.deft.ing and every known deployment.
- [ ] **Step 3: Measure `/api/email-adoption` use** from access logs over the previous 30 days.
- [ ] **Step 4: Write the decision record** covering who still reads retained data, whether anyone needs an export, and the go or no-go criteria.
- [ ] **Step 5: Get the user's decision.** If go, publish the operator notice in release notes and `docs/self-hosting.md`, which starts the 30-day window. If no-go, record what would change it and stop here at 824.

**Completion evidence:** Merged inventory and decision record, the user's decision quoted in the record, and the notice link if go. Records after: 824.

### Stage 9: Adoption and recovery retirement

**Depends on:** S5, S7 released at least 14 days earlier, an S8 go decision, and 30 days since the notice. Requires explicit user approval at merge.

**Files:**
- Delete from `apps/api/src/lib/`: the 21 remaining `email-*` files in R1 and C1 (everything `email-*` except `email-mailbox-key-references.ts`), and `apps/api/src/routes/email-native-adoption-source.ts`
- Delete: `apps/web/src/app/(app)/apps/recovery/native-email/`, `apps/source/native-email/`, `email/`
- Delete tests: all remaining `apps/api/test/email-*.test.ts` except `email-mailbox-key-references.test.ts`, and `apps/api/test/fixtures/email-mailbox-database.ts`
- Modify: `apps/api/src/index.ts`, `apps/api/src/lib/email-mailbox-key-references.ts`, `apps/web/src/components/apps/integrations/source-open.tsx`, `apps/api/src/lib/calendar-invitation-attendees.ts`, `native-calendar-invitation-create.ts`
- Modify CI: `.github/workflows/ci.yml` (predecessor container steps), `.github/workflows/email-preview-stack.yml`, `package.json`, `.gitattributes`
- Rename: `scripts/email-preview-api-tests.mjs`, `email-preview-test-databases.mjs` and its test, and `email-preview-api-isolation.json` to `scripts/api-ci-*`; `test:email-preview-api` to `test:api-ci`
- Delete: `tsconfig.email-stage34.json`

- [ ] **Step 1: Write failing tests:** `retained source link resolves to unavailable` asserts a stored `/apps/source/native-email/<id>` citation keeps its excerpt, shows an unavailable state, and exposes no locator; `custody inventory still refuses retirement` asserts key retirement is still refused with no live reader.
- [ ] **Step 2: Run them.** Expected: the first fails.
- [ ] **Step 3: Check `/email/connections/callback`** against deployed OAuth client settings. Nothing in Deft or Email references it, and Email's setup docs use `/apps/connections/callback`. If a client still uses it, keep a one-line redirect.
- [ ] **Step 4: Remove the route mount** and make retained links resolve to unavailable through the storage owner.
- [ ] **Step 5: Delete the listed code,** and reword `EMAIL_INVITATION_*` errors. Keep the stored `email_invitation` metadata reader in the storage owner.
- [ ] **Step 6: Remove the predecessor database steps,** rename the CI scripts, and update the partition assertion in the runner.
- [ ] **Step 7: Delete 368 R1 and 19 C1 records.** Add a reviewed record only for a stored value moved into the storage owner, and set the ceiling to 437 plus any such additions.
- [ ] **Step 8: Run** full CI, a restore test on a database with representative legacy rows, and the checker.
- [ ] **Step 9: Commit.**

**Completion evidence:** Checker at 437 with 0 errors. `git ls-files apps/api/src | grep -i email` lists only `email-mailbox-key-references.ts`. The restore test confirms all 40 tables, their rows and key references are unchanged. **Rollback:** revert the PR. Tables and keys are untouched, so the reader returns intact. Records after: 437.

### Stage 10: Wire spelling decision (no removal)

**Files:** Create `docs/decisions/2027-02-02-app-wire-spellings.md`; modify the W1 milestones in `scripts/app-boundary-allowlist.json`.

- [ ] **Step 1: Inventory the 67 records** (`mailbox_list`, `MailboxControl`, the triage-options provider spellings, `destination.mailbox`, `record-intake` to/cc/bcc) and which installed Apps serialize them. Email's `app/record-ui.mjs` does today.
- [ ] **Step 2: Decide** between keeping them until a future App Protocol, or adding neutral aliases in a later Kit. Installed packages keep the old spelling, so the Host must accept it either way, and an alias alone removes no records.
- [ ] **Step 3: Relabel W1 milestones** with the outcome.

**Completion evidence:** Decision record merged, and W1 relabeled. Records after: 437.

### Stage 11: Custody and schema retirement review (no removal)

**Files:** Create `docs/decisions/2027-03-02-retained-data-retirement.md`.

- [ ] **Step 1: Review the S8 inventory** again, and decide whether to retire retained data at all.
- [ ] **Step 2: If yes, write a separate plan** with its own backup, restore, rollback and key-retirement gates. This plan authorizes none of that work.

**Completion evidence:** Decision record merged. R2 and R3 (172 records) stay until a separately approved plan completes. If that happens and W1 is also retired, the floor is about 200 records, nearly all permanent history.

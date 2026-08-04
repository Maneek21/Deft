# Deft GitHub Security and Code-Scanning Report

| Field | Value |
|---|---|
| Prepared | 30 July 2026 |
| Repository | [Maneek21/Deft](https://github.com/Maneek21/Deft) |
| GitHub snapshot | `master` at `df9b606f05e35833af07af0f37d6a581f5c21f55` |
| Scope | All 54 open findings shown by GitHub Security and quality: 40 CodeQL code-scanning alerts and 14 Dependabot alerts |
| Review type | Alert triage, static source/configuration review, local remediation, and verification |

## Remediation update — 4 August 2026

The original 54-item inventory below remains the reconciliation baseline. A live authenticated GitHub check on 4 August found that remote `master` is still the same commit, but Dependabot has added three alerts since the report was prepared:

| Live source | 30 July | 4 August | Change |
|---|---:|---:|---:|
| CodeQL code scanning | 40 | 40 | 0 |
| Dependabot | 14 | 17 | +3 |
| **GitHub open total** | **54** | **57** | **+3** |

The new GitHub items are:

| Alert | Severity | Package / vulnerable range | Advisory | Local resolution |
|---|---|---|---|---|
| [#23](https://github.com/Maneek21/Deft/security/dependabot/23) | High | `brace-expansion >=4.0.0 <5.0.8` | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | Lockfile resolves the affected branch to `5.0.9`; the older branch is separately held at `1.1.18`. |
| [#24](https://github.com/Maneek21/Deft/security/dependabot/24) | Medium | `ip-address >=10.1.1 <=10.2.0` | [GHSA-22jq-vg5j-6vgg](https://github.com/advisories/GHSA-22jq-vg5j-6vgg) | Lockfile resolves `ip-address@10.4.0`. |
| [#25](https://github.com/Maneek21/Deft/security/dependabot/25) | Medium | `ip-address >=10.1.1 <=10.2.1` | [GHSA-4xrf-jv44-h6hh](https://github.com/advisories/GHSA-4xrf-jv44-h6hh) | Lockfile resolves `ip-address@10.4.0`. |

The local remediation also includes newer patched floors for advisories discovered by `pnpm audit` before GitHub created alerts for them.

The resumed local patch set now covers the original 54 alerts, the three new GitHub alerts, and the higher-priority authorization/privacy findings discovered during review. Both the production-only and full dependency audits currently report zero advisories. GitHub still shows every remote alert open because these changes are unpushed; fixed CodeQL and Dependabot dispositions can only be confirmed after a branch is pushed and GitHub completes its rescans.

## Local remediation disposition

“Addressed locally” below means the relevant source, test, configuration, or lockfile change exists in this working tree. It does not mean GitHub has closed the remote alert.

| Area | Local disposition | Remaining closure step |
|---|---|---|
| Original 40 CodeQL alerts | All 40 alert locations are covered by shared parser, exact-match, command-boundary, path-containment, log-redaction, identity, socket-filter, or validation fixes and focused regressions. No alert was dismissed. | Push a reviewed branch and let CodeQL rescan it; investigate any residual alert individually. |
| Original 14 Dependabot alerts | The final dependency graph resolves patched versions for every affected package. | Push and wait for GitHub's dependency-graph refresh. |
| New Dependabot #23–#25 | Patched locally through split `brace-expansion` override floors and `ip-address@10.4.0`. | Push and wait for GitHub's dependency-graph refresh. |
| Manual findings A1–A4 | Recap, cross-reference, runtime authorization, and report-path issues are fixed locally. Follow-up review also closed clone authorization, clip task-ID redaction, reminder visibility, and migration-correlation gaps. | Completed locally: 19/19 DB-backed authorization/privacy tests passed on a disposable PostgreSQL 16 + pgvector database. |
| Historical cached content | Upgrade `0.2.0-preview.4` redacts legacy cross-reference excerpts, tightly correlated generated comments, cached message reminders/notifications, and restricted-task-derived clip summaries. | Deploy through `pnpm db:upgrade`; do not use raw `drizzle-kit push` for this upgrade. |

Resolved dependency versions in the local lockfile include Next.js / `eslint-config-next 16.3.0`, Hono `4.12.34`, `@hono/node-server 2.0.12`, Engine.IO `6.6.9`, `fast-uri 3.1.5`, Sharp `0.35.3`, `body-parser 2.3.0`, `postcss 8.5.25`, `ip-address 10.4.0`, and the safe `brace-expansion` branches `1.1.18` and `5.0.9`.

Verification completed locally:

- frozen pnpm install;
- production and full `pnpm audit --audit-level low`: zero known vulnerabilities;
- API and web typechecks, web lint, and a production Next.js build with 40/40 static pages;
- 63 focused parser, presentation, audit, path, reset, and upgrade regressions with zero failures;
- 19/19 DB-backed authorization/privacy tests on a disposable PostgreSQL 16 + pgvector 0.8.2 database;
- 8/8 direct `0.2.0-preview.4` redaction/preservation assertions inside a rolled-back transaction;
- production Docker image build on Linux/Alpine with Next.js 16.3.0, TypeScript, and 40/40 generated pages;
- isolated production runtime: API health and web login 200, Next image optimization 200 PNG, Sharp 0.35.3/libvips 8.18.3 native transform, and authenticated Socket.IO polling plus WebSocket connections;
- the affected five-test upgrade subset re-passed after the final migration-correlation change;
- final API typecheck and `git diff --check` passed.

All planned local environment gates are now closed. The DB tests used a uniquely named `--rm` pgvector container with no shared network or volume. The Docker smoke exposed and fixed a Windows-checkout CRLF failure in `scripts/docker-entrypoint.sh`; a narrow `.gitattributes` rule now enforces LF for that entrypoint. The cold Docker dependency layer also gained a persistent BuildKit pnpm-store cache and extended fetch timeout after registry socket resets. Exact validation containers, networks, and anonymous volumes were removed after the run. CI remains the authoritative clean-host confirmation before merge.

## Executive summary of the 30 July baseline

The GitHub badge count of **54** is correct, but it does not represent 54 independent, equally exploitable vulnerabilities.

| Source | High | Medium / Moderate | Low | Open total |
|---|---:|---:|---:|---:|
| CodeQL code scanning | 38 | 2 | 0 | 40 |
| Dependabot | 7 | 6 | 1 | 14 |
| **Total** | **45** | **8** | **1** | **54** |

The most important conclusions are:

1. **The manual review found a P0 cross-tenant recap authorization bypass that GitHub did not report.** `POST /api/spaces/:spaceId/recap` does not reject a missing membership row and does not scope its message or space queries by `org_id`.
2. **The cross-reference pipeline has P1 read- and write-time visibility gaps that GitHub did not report.** The API can expose restricted task metadata and private note/message context, while the worker can persist and post private note/DM excerpts into linked tasks.
3. **The runtime diagnostics and certification route family has P1 role-gate gaps.** Ordinary organization members can retrieve runtime setup and certification details, mutate certification state, or enqueue a channel test despite the UI’s intended owner/admin boundary.
4. **CodeQL alert #15 is a real P1 stored copy/paste command-injection risk.** Any authenticated organization member can set an employee name that is later interpolated into a copyable shell command using incomplete quoting.
5. **CodeQL alert #32 sits beside a real P1 system-message spoofing flaw.** Any user-authored message beginning with ✓, ✔, ✖, or ⚠ is styled as a system message.
6. **Dependabot alert #9 is the clearest currently applicable dependency vulnerability.** Deft exposes Socket.IO with polling enabled and is locked to vulnerable `engine.io@6.6.6`, allowing unauthenticated connection-exhaustion DoS.
7. **No direct XSS/RCE sink was found for the 20 “Incomplete multi-character sanitization” alerts.** Their current outputs are React text, JSON, notifications, LLM data, or DOMPurify-sanitized HTML. They are still correctness, trust-boundary, and maintainability problems.
8. **Ten CodeQL alerts are confined to tests or audit scripts.** None is a production exploit; several still reveal weak test isolation or audit filtering.
9. **One open dependency PR can remove 12 of 14 Dependabot alerts.** [PR #197](https://github.com/Maneek21/Deft/pull/197) is mergeable and showed 8/8 checks passing at review time. Its lockfile resolves patched Next.js, Hono, `fast-uri`, and `body-parser`, but still contains vulnerable `engine.io@6.6.6` and `sharp@0.34.5`.

GitHub’s severity is the scanner/advisory severity. The priorities below are contextual:

- **P0:** cross-tenant or critical authorization failure; fix immediately.
- **P1:** exploitable or materially misleading security boundary; fix before release.
- **P2:** real defect or vulnerable runtime dependency with bounded/currently inactive exposure.
- **P3:** low-risk correctness, test, audit, or defense-in-depth work.

## Original recommended action order

1. **Fix authorization first**
   - Require tenant-scoped space membership on the recap route.
   - Add visibility-aware prechecks and filtered joins to all three cross-reference endpoints; prevent the worker from copying private note/DM excerpts into tasks and clean up previously leaked rows/comments.
   - Enforce the intended owner/admin gate across the agent runtime diagnostics, certification, and channel-test route family.
2. **Fix the two high-value CodeQL-adjacent trust flaws**
   - Replace the generated Hermes shell string with structured argv/stdin or a prompt file.
   - Remove glyph-based system-message detection; trust only server-controlled metadata/identity.
3. **Patch dependencies**
   - Merge either the grouped [PR #197](https://github.com/Maneek21/Deft/pull/197) or carefully selected non-overlapping narrow PRs.
   - Set durable root `pnpm.overrides` floors of `engine.io: ^6.6.7` and `sharp: ^0.35.3`, regenerate the lockfile, and test both Socket.IO transports plus the Next.js image/build path.
4. **Replace regex HTML-to-text conversion**
   - Harden `apps/api/src/lib/plain-text.ts` and `apps/web/src/lib/strip-html.ts` first.
   - Migrate inline copies to a parser-based rich-content-to-text function.
   - Keep DOMPurify at actual HTML-rendering sinks.
5. **Clean up test/audit findings and dismiss only defensible false positives**
   - Fix no-op replacements and fail-open fetch mocks.
   - Narrow audit noise filters.
   - Record explicit dismissal rationales for findings that are not security decisions.

## Additional security findings not included in GitHub’s 54

These were discovered while tracing the alerted code. They are not extra GitHub alerts and are kept separate to preserve the 54-item reconciliation.

### A1 — P0: recap route cross-tenant IDOR

**Location:** `apps/api/src/routes/recap.ts:9-66`

`POST /api/spaces/:spaceId/recap` queries `space_members`, but a missing row is converted to `lastRead = new Date(0)` instead of returning 404/403. Both message queries filter by `space_id` but not `messages.org_id`, and the space lookup is not scoped by `spaces.org_id`.

If an authenticated attacker knows another space UUID:

- with an AI provider available, up to 100 unauthorized messages are sent for summarization and a content-derived summary is returned;
- without AI, message counts and author names are still returned.

**Required fix:** load the space through a tenant-scoped membership join, return 404 when not visible, add `org_id` predicates to both message queries, reuse the authorized space row, and add same-org non-member plus cross-tenant regression tests for both AI and no-AI branches.

### A2 — P1: cross-reference read and write visibility bypasses

**Locations:** `apps/api/src/routes/cross-references.ts`, `apps/api/src/routes/daily-notes.ts`, and `apps/api/src/workers/handlers/cross-reference.ts`

All three GET endpoints need authorization repair:

- `GET /api/tasks/:taskId/references` does not verify target-task visibility and returns note/message previews without note visibility or space membership. It also returns `cross_references.context` unconditionally.
- `GET /api/notes/:noteId/references` does not verify source-note visibility and returns linked task metadata and `context` without restricted-task filtering.
- `GET /api/messages/:messageId/references` does not verify source-message tenant, deletion state, or space membership and returns linked task metadata and `context` without restricted-task filtering.

There is also a write-time breach. Daily notes default to private but still enqueue cross-reference processing. The worker accepts note or message content, stores a source excerpt in `cross_references.context`, and posts another excerpt as a task comment without verifying source visibility, source-space membership, or target-task visibility. A private note or DM that mentions a task key can therefore disclose content to task viewers and write into a task the source author may not be allowed to see.

**Required fix:** authorize both the source and target before inserting a cross-reference or posting a comment; return 404 after visibility-aware API prechecks; enforce tenant, deletion, note-sharing, space-membership, and restricted-task rules in joins; suppress every source-derived field—including `context`—when the source is not visible; and audit/remove previously leaked `cross_references.context` and generated task comments. Test cross-tenant IDs, membership revocation, private notes/DMs, restricted tasks, deleted rows, and poisoned/stale relation rows.

### A3 — P1: runtime diagnostics and certification routes lack their intended admin gate

**Location:** `apps/api/src/routes/agent-employees.ts:1867-2318`

The following endpoints check only `employee.org_id`, not the caller’s role:

- `GET /api/agent-employees/:id/developer` returns runtime setup, certification nonce/status, channel metadata, recent MCP/cooperative/channel diagnostics, and copyable commands.
- `GET /api/agent-employees/:id/certification` also returns `runtime_setup`, including the CodeQL #15 command.
- `POST /api/agent-employees/:id/certification/start`, `/check`, and `/reset` mutate certification records or employee status.
- `POST /api/agent-employees/:id/channel-test/start` enqueues an agent-channel event.

The frontend explicitly expects non-admin callers to receive `403`. Raw bearer tokens are not returned, but ordinary members can still access privileged operational context and drive certification/channel state. Separately, both `PUT /:id` and `PATCH /:id` let any authenticated organization member set `employee.name`, which supplies CodeQL #15; an admin gate is defense in depth, not the injection fix.

**Required fix:** enforce one server-side owner/admin guard consistently across this route family, return 404/403 consistently, and add member/admin/owner tests for every read and mutation listed above.

### A4 — P3 hardening: report run ID can escape its intended filename shape

**Location:** `scripts/reports/demo-claim-certification.ts`

`DEFT_DEMO_CERT_RUN_ID` contributes to report paths without a conservative filename allowlist. It is operator-controlled rather than web-user-controlled, so this is not a production exploit, but it should be restricted and resolved paths should be asserted beneath the reports directory.

## CodeQL overview

| Rule family | Rule ID | Alerts | GitHub severity | Contextual result |
|---|---|---:|---|---|
| Incomplete multi-character sanitization | `js/incomplete-multi-character-sanitization` | 20 (#17–#36) | High | No current XSS/RCE sink found; correctness, AI-boundary, trust, and authorization-adjacent issues |
| Incomplete URL substring sanitization | `js/incomplete-url-substring-sanitization` | 8 (#3–#10) | High | Tests/audits only; weak mocks/filters, not production URL authorization |
| Double escaping or unescaping | `js/double-escaping` | 4 (#11–#14) | High | Real one-layer decoding/correctness defects; no current unsanitized HTML sink found |
| Clear-text logging | `js/clear-text-logging` | 4 (#37–#40) | High | Mostly environment-taint false positives with limited path/URL disclosure |
| Incomplete string escaping or encoding | `js/incomplete-sanitization` | 2 (#15–#16) | High | #15 real copy/paste command injection; #16 latent Windows quoting hazard |
| Replacement of a substring with itself | `js/identity-replacement` | 2 (#1–#2) | Medium | No-op test code |

## CodeQL alert-by-alert review

### Alerts #1–#10 — tests and audit scripts

| Alert | Location | Assessment | Recommended closure |
|---|---|---|---|
| [#1](https://github.com/Maneek21/Deft/security/code-scanning/1) | `apps/api/test/embed-content.test.ts:111` | `raw.replace(/^\[/, '[')` replaces `[` with itself. Real no-op test correctness issue; no runtime impact. | **P3 Fix with #2:** use `JSON.parse(raw)` and assert the resulting array shape. |
| [#2](https://github.com/Maneek21/Deft/security/code-scanning/2) | `apps/api/test/embed-content.test.ts:111` | `.replace(/\]$/, ']')` is the matching no-op at the same line. | **P3 Fix with #1.** |
| [#3](https://github.com/Maneek21/Deft/security/code-scanning/3) | `apps/api/test/github-pr-merged-task-close.test.ts:237` | `content.includes(url)` checks a fixed fixture URL; it is not a host allowlist, redirect, navigation, or fetch. Security false positive, but the assertion is weak. | **P3:** replace it with exact full-string equality against the expected comment; otherwise dismiss as false positive with the test-only rationale. |
| [#4](https://github.com/Maneek21/Deft/security/code-scanning/4) | `apps/api/test/memory-extract-embed-enqueue.test.ts:83` | A global fetch mock uses `url.includes('anthropic.com')` and delegates unknown hosts to real fetch. No production exposure, but a wrong host can be mocked and unexpected requests can escape to the network. | **P3 Fix:** parse the URL, exact-match `api.anthropic.com`, and throw on every unexpected fetch. |
| [#5](https://github.com/Maneek21/Deft/security/code-scanning/5) | `apps/api/test/memory-extract-no-agent-memory.test.ts:67` | Same fail-open Anthropic mock pattern as #4. | **P3 Fix with #4.** |
| [#6](https://github.com/Maneek21/Deft/security/code-scanning/6) | `apps/api/test/oneone-prep-commitments.test.ts:107` | Same substring-based Anthropic mock routing. Test-only, but it can hide a wrong endpoint or permit real network use. | **P3 Fix:** use a shared exact-host, fail-closed fetch mock. |
| [#7](https://github.com/Maneek21/Deft/security/code-scanning/7) | `apps/api/test/oneone-prep-commitments.test.ts:111` | OpenAI/OpenRouter mock uses substring checks. The sibling `openrouter.ai` check has the same flaw even though GitHub did not create a second alert. | **P3 Fix:** exact-match a set containing `api.openai.com` and `openrouter.ai`; throw on unknown hosts. |
| [#8](https://github.com/Maneek21/Deft/security/code-scanning/8) | `docs/superpowers/audits/chat-mobile/audit.ts:205` | Audit suppresses any failing response URL containing `socket.io`. It is not a production URL authorization decision, but unrelated failures can be hidden. | **P3 Fix:** compare the configured Socket.IO origin—`NEXT_PUBLIC_WS_URL` can differ from the API origin—and normalize the pathname so only `/socket.io` or `/socket.io/` is suppressed; otherwise remove the suppression. |
| [#9](https://github.com/Maneek21/Deft/security/code-scanning/9) | `docs/superpowers/audits/palette-cmds-smoke.audit.ts:115` | Console-text filter suppresses any message containing `fonts.googleapis.com`; it only affects audit logging, not pass/fail or a security decision. | **P3:** narrow/remove the filter, then dismiss as false positive if CodeQL still flags the logging-only pattern. |
| [#10](https://github.com/Maneek21/Deft/security/code-scanning/10) | `docs/superpowers/audits/slash-menu-smoke.audit.ts:256` | Same logging-only font-warning filter as #9. | **P3 Fix/dismiss with #9.** |

### Alerts #11–#16 — decoding and command construction

| Alert | Location | Assessment | Recommended closure |
|---|---|---|---|
| [#11](https://github.com/Maneek21/Deft/security/code-scanning/11) | `apps/api/src/lib/mcp-tools/wiki-create.ts:97` | Sequentially decodes `&amp;` before `&lt;`/`&gt;`, so nested entities can be decoded twice after tags were removed. Output is persisted in wiki titles, summaries, and excerpts. No current unsanitized HTML sink was found. | **P2 Fix:** use a shared parser/single-pass entity decoder and add nested-entity regression tests. |
| [#12](https://github.com/Maneek21/Deft/security/code-scanning/12) | `apps/api/src/lib/plain-text.ts:7` | Same cascading decode in a high-fan-out helper used by observation, extraction, blocked alerts, replies, memory, and knowledge. Real data-integrity defect. | **P2 Fix first:** harden the shared server helper and replace the remaining inline/local duplicates. |
| [#13](https://github.com/Maneek21/Deft/security/code-scanning/13) | `apps/web/src/components/task-detail.tsx:440` | Activity-diff conversion can double-decode nested entities, producing inaccurate diff lines. Result is rendered as escaped React text. | **P3 Fix:** structural HTML-to-lines parsing with one-layer decoding. |
| [#14](https://github.com/Maneek21/Deft/security/code-scanning/14) | `apps/web/src/lib/strip-html.ts:7` | Shared preview helper double-decodes entity-shaped user content. Current callers render the result as React text, not raw HTML. | **P3 Fix:** harden the shared web helper and test nested entities. |
| [#15](https://github.com/Maneek21/Deft/security/code-scanning/15) | `apps/api/src/routes/agent-employees.ts:840` | **Real P1 stored copy/paste command injection.** Any authenticated organization member can set `employee.name` through `PUT` or `PATCH`; the value reaches a displayed `hermes chat -q "..."` command. In relevant double-quoted shells, `$()` and backticks can execute directly, and a backslash-plus-quote sequence can defeat the attempted quoting so later metacharacters become active. A victim must copy/run the command. One displayed string cannot be assumed safe across POSIX shells, PowerShell, and CMD. | **P1 Fix before release:** do not return an executable shell string containing the prompt; return structured argv plus prompt data and use stdin or a prompt file. If copyable commands remain, generate and test distinct per-shell forms. Add adversarial tests and apply the A3 role gates as defense in depth. |
| [#16](https://github.com/Maneek21/Deft/security/code-scanning/16) | `scripts/pilot-preflight.ts:343` | Windows wrapper constructs `cmd.exe /c` text using POSIX-like `\"`. Current call sites pass only fixed tokens and numeric ports, so no present injection path was found. | **P3 Fix/latent:** invoke the pnpm entry point without a shell or use a tested Windows command-line builder; otherwise document/dismiss the current-call-graph false positive. |

### Alerts #17–#36 — incomplete multi-character sanitization

GitHub assigns this rule a generic High severity. In current Deft sinks, none of these 20 findings is directly executable XSS/RCE. The rows below distinguish the regex warning from adjacent issues found in the same code.

| Alert | Location | Assessment | Recommended closure |
|---|---|---|---|
| [#17](https://github.com/Maneek21/Deft/security/code-scanning/17) | `apps/api/src/routes/cross-references.ts:73` | Regex output is returned in JSON; `note_preview` is not currently rendered by the task-detail references UI. **Adjacent P1:** task backlinks can return private note previews and stored `context` because the queries ignore tenant, deletion, and note visibility. | **P1 auth fix; P3 conversion:** enforce visible-note and visible-task rules, suppress all source-derived fields when hidden, then use the hardened server plain-text helper. |
| [#18](https://github.com/Maneek21/Deft/security/code-scanning/18) | `apps/api/src/routes/cross-references.ts:86` | Regex output is JSON/React text. **Adjacent P1:** endpoint does not verify source-message space membership or target-task visibility. | **P1 auth fix; P3 conversion:** enforce message-space and task visibility, then normalize through the shared helper. |
| [#19](https://github.com/Maneek21/Deft/security/code-scanning/19) | `apps/api/src/routes/daily-notes.ts:19` | The regex itself only pre-checks for a task identifier before enqueuing the original content. **Adjacent P1:** daily notes default private, but the downstream worker can store and post their excerpts to a referenced task without source/target visibility checks. | **P1 authorization fix; P3 conversion:** enforce source and target visibility before enqueue/processing, never publish private excerpts, use hardened `toPlainText`, and add private-note plus malformed-rich-text tests. |
| [#20](https://github.com/Maneek21/Deft/security/code-scanning/20) | `apps/api/src/routes/recap.ts:69` | Regex output becomes LLM data and sanitized markdown output, not raw HTML. Member content can influence summaries regardless of tags. **Adjacent P0:** route lacks effective tenant/space authorization. | **P0 auth fix; P2 AI/conversion:** authorize first, tenant-scope all queries, separate static instructions from untrusted conversation data, and use hardened plain text. |
| [#21](https://github.com/Maneek21/Deft/security/code-scanning/21) | `apps/api/src/routes/messages.ts:588` | Produces a notification body rendered as React text. Low notification/cosmetic integrity issue, not XSS. | **P3 Fix:** use hardened server plain text, then truncate. |
| [#22](https://github.com/Maneek21/Deft/security/code-scanning/22) | `apps/api/src/workers/handlers/clip-process.ts:83` | Thread/messages plus user-controlled task and space titles/names/descriptions and `user_name` are interpolated into the **system prompt** for clip summarization. No XSS and no tools, but workspace text can influence stored summary fields. | **P2 Fix:** keep the system prompt static; pass every dynamic workspace value as structured untrusted user data and schema-validate all returned fields. |
| [#23](https://github.com/Maneek21/Deft/security/code-scanning/23) | `apps/api/src/workers/handlers/cross-reference.ts:39` | Parsed text drives `PREFIX-N` detection and generated comments. DOMPurify protects the current HTML sink, but malformed HTML can cause spurious/missed references. **Adjacent P1:** the worker stores and posts private note/DM excerpts without source/target visibility checks. | **P1 authorization fix; P3 conversion:** authorize both source and target before writes, eliminate/historically clean leaked excerpts, use structural text extraction, and generate plain-text excerpts. |
| [#24](https://github.com/Maneek21/Deft/security/code-scanning/24) | `apps/api/src/workers/handlers/task-extract.ts:229` | Preview becomes untrusted trigger context for an employee agent. No HTML sink; indirect prompt injection is inherent to untrusted message data, not specifically this regex. | **P2 Fix:** use hardened `toPlainText`, retain provenance, label the field untrusted, and keep trigger data separate from instructions. |
| [#25](https://github.com/Maneek21/Deft/security/code-scanning/25) | `apps/api/src/workers/handlers/task-extract.ts:271` | Message text becomes an LLM extraction prompt. Output only queues an approval; `autoAccepted` is false. | **P2 Fix:** structured/delimited untrusted input, Zod and length validation, hardened plain text, and retain approval. |
| [#26](https://github.com/Maneek21/Deft/security/code-scanning/26) | `apps/web/src/app/(app)/notes/page.tsx:78` | Fallback HTML stripping feeds note previews/search and is rendered as React text. Preview/search correctness issue, not XSS. | **P3 Fix:** remove the local duplicate and structurally parse fallback HTML while retaining TipTap JSON traversal. |
| [#27](https://github.com/Maneek21/Deft/security/code-scanning/27) | `apps/web/src/components/pinned-messages.tsx:74` | Latest pinned-message preview is a JSX text child. Cosmetic false positive. | **P3 Fix:** use the hardened shared web helper. |
| [#28](https://github.com/Maneek21/Deft/security/code-scanning/28) | `apps/web/src/components/pinned-messages.tsx:117` | Pinned-message dropdown preview is a JSX text child. Cosmetic false positive. | **P3 Fix with #27.** |
| [#29](https://github.com/Maneek21/Deft/security/code-scanning/29) | `apps/web/src/components/saved-messages.tsx:45` | Saved-message preview is rendered as escaped React text. Cosmetic false positive. | **P3 Fix:** delete the local duplicate and use the shared web helper. |
| [#30](https://github.com/Maneek21/Deft/security/code-scanning/30) | `apps/web/src/components/scheduled-panel.tsx:54` | Scheduled-message preview is rendered as escaped React text. Cosmetic false positive. | **P3 Fix:** use the shared web helper. |
| [#31](https://github.com/Maneek21/Deft/security/code-scanning/31) | `apps/web/src/components/space-chat.tsx:735` | Text feeds user-invoked “Save to knowledge.” No XSS, but malformed markup can pollute knowledge/search; arbitrary plain text remains untrusted model data. | **P2 Fix:** normalize server-side, preserve provenance, and treat retrieved knowledge as untrusted. |
| [#32](https://github.com/Maneek21/Deft/security/code-scanning/32) | `apps/web/src/components/space-chat.tsx:1408` | The regex itself is not an XSS sink. **Adjacent P1:** a leading ✓/✔/✖/⚠ makes any member’s message look system-authored by suppressing the normal avatar/author row. | **P1 Fix:** remove content-based trust; require server-controlled `metadata.kind === 'system_note'` or a dedicated system identity. |
| [#33](https://github.com/Maneek21/Deft/security/code-scanning/33) | `apps/web/src/components/space-chat.tsx:1635` | Quote text is later interpolated into an HTML string, but current message rendering applies DOMPurify. No current stored XSS; higher-risk construction hygiene. | **P2 Fix:** build a structured TipTap blockquote/text nodes or HTML-escape normalized text and author before serialization. |
| [#34](https://github.com/Maneek21/Deft/security/code-scanning/34) | `apps/web/src/components/space-chat.tsx:1687` | Client-derived reminder text is persisted and later rendered as React text. Low stored-content correctness issue. | **P2 Fix:** send `source_message_id`; after validating its tenant, deletion state, and caller space membership, derive normalized text server-side. Otherwise normalize through the hardened helper before POST. |
| [#35](https://github.com/Maneek21/Deft/security/code-scanning/35) | `apps/web/src/components/task-detail.tsx:436` | Activity diff structurally approximates HTML with regex and later entity decoding. Diff is escaped React text; counts/lines can be wrong. | **P3 Fix:** parser-based HTML-to-lines with intentional block boundaries and one-layer entity handling. |
| [#36](https://github.com/Maneek21/Deft/security/code-scanning/36) | `apps/web/src/components/space-chat.tsx:2569` | Message edit-history preview is a JSX text child. Malformed markup may make the preview confusing but cannot execute. | **P3 Fix:** shared hardened rich-content-to-text helper, then truncate. |

### Alerts #37–#40 — clear-text logging

All four sinks write to stdout—the operator’s terminal or captured CI/automation output—not Deft’s application database logs.

| Alert | Location | Assessment | Recommended closure |
|---|---|---|---|
| [#37](https://github.com/Maneek21/Deft/security/code-scanning/37) | `scripts/reports/demo-claim-certification.ts:607` | Logs an absolute HTML report path derived partly from `DEFT_DEMO_CERT_RUN_ID`; it does not log the test password, token, or report contents. Possible workstation-path/run-ID disclosure. | **P3 Harden/dismiss:** validate run ID, assert the path remains under `reports`, and log only a safe relative filename. |
| [#38](https://github.com/Maneek21/Deft/security/code-scanning/38) | `scripts/reports/demo-claim-certification.ts:608` | Same as #37 for the JSON report pathname. | **P3 Harden/dismiss with #37.** |
| [#39](https://github.com/Maneek21/Deft/security/code-scanning/39) | `scripts/selfhost-reset.ts:408` | Logs `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, and `NEXT_PUBLIC_WS_URL`. These are public-by-design, but syntactically valid misconfigured URLs could contain credentials or query tokens. | **P3 Harden/dismiss:** parse and reject/redact userinfo, query, and fragment; log only safe origins after validation. |
| [#40](https://github.com/Maneek21/Deft/security/code-scanning/40) | `scripts/selfhost-reset.ts:434` | Logs a post-reset signup URL from `NEXT_PUBLIC_APP_URL`. Same public-value contract and credential-bearing/query-token residual risk as #39. | **P3 Harden/dismiss with #39.** |

## Dependabot overview

At the original 30 July snapshot, all 14 were runtime-dependency alerts in `pnpm-lock.yaml`.

The scores below reproduce GitHub’s advisory data. The Next.js and Sharp advisories use CVSS v4.0; the Engine.IO, `fast-uri`, Hono, and `body-parser` advisories use CVSS v3.1, so equal-looking numbers are not perfectly comparable across versions.

Resolution paths reviewed on 30 July:

- [PR #196](https://github.com/Maneek21/Deft/pull/196) narrowly updates Next.js `16.2.10 → 16.2.11` and showed 8/8 checks passing.
- [PR #195](https://github.com/Maneek21/Deft/pull/195) narrowly updates direct `@hono/node-server` `2.0.8 → 2.0.10`. It showed 7/8 checks passing; Dependency Review failed because the lockfile still contains vulnerable transitive `@hono/node-server@1.19.15`. It fixes Dependabot #12 but not #11 and is not a standalone merge-ready security fix.
- [PR #197](https://github.com/Maneek21/Deft/pull/197) was a grouped 37-package candidate that showed 8/8 checks passing and removed most of the original vulnerable graph, but it retained vulnerable Engine.IO and Sharp versions. The implemented local remediation supersedes that candidate with Next.js `16.3.0`, only `@hono/node-server@2.0.12`, `fast-uri@3.1.5`, `body-parser@2.3.0`, Engine.IO `6.6.9`, and Sharp `0.35.3`.

Therefore, merging #197 should resolve **12 of 14** open Dependabot alerts after GitHub refreshes the dependency graph. It does not resolve Dependabot #9 or #14. Do not merge overlapping dependency PRs blindly; choose a reviewed path and close superseded PRs.

If a narrow Hono-only path is preferred, combine PR #195 with an MCP SDK update to `@modelcontextprotocol/sdk ^1.30.0` (or another verified change that removes the 1.x Hono copy), regenerate the lockfile, and rerun Dependency Review.

### Dependabot alert-by-alert review

| Alert | Severity / score | Package: current → fixed | Advisory | Deft applicability | Recommended closure |
|---|---|---|---|---|---|
| [#22](https://github.com/Maneek21/Deft/security/dependabot/22) | High 8.3 | `next 16.2.10 → >=16.2.11` | [CVE-2026-64642 / GHSA-6gpp-xcg3-4w24](https://github.com/advisories/GHSA-6gpp-xcg3-4w24) | Middleware/proxy bypass requires App Router + Turbopack + a single `i18n.locales` entry. Deft has App Router but no i18n config or middleware authorization path. Not currently reachable. | **P2 update:** PR #196 or #197. Continue enforcing authorization in API/data paths. |
| [#21](https://github.com/Maneek21/Deft/security/dependabot/21) | High 8.3 | `next 16.2.10 → >=16.2.11` | [CVE-2026-64645 / GHSA-p9j2-gv94-2wf4](https://github.com/advisories/GHSA-p9j2-gv94-2wf4) | SSRF/open redirect requires a dynamic request-controlled hostname in `rewrites()`/`redirects()`. Deft defines neither. Not currently reachable. | **P2 update with #22.** |
| [#16](https://github.com/Maneek21/Deft/security/dependabot/16) | High 8.3 | `next 16.2.10 → >=16.2.11` | [CVE-2026-64649 / GHSA-89xv-2m56-2m9x](https://github.com/advisories/GHSA-89xv-2m56-2m9x) | Server Action SSRF on custom servers. Deft has no `use server` action and runs `next start`, not a custom Next server. Not currently reachable. | **P2 update with #22.** |
| [#15](https://github.com/Maneek21/Deft/security/dependabot/15) | High 8.2 | `next 16.2.10 → >=16.2.11` | [CVE-2026-64641 / GHSA-m99w-x7hq-7vfj](https://github.com/advisories/GHSA-m99w-x7hq-7vfj) | App Router DoS requires at least one Server Action. No Server Actions were found. | **P2 update with #22.** |
| [#9](https://github.com/Maneek21/Deft/security/dependabot/9) | High 7.5 | `engine.io 6.6.6 → >=6.6.7` | [CVE-2026-59725 / GHSA-r635-g3xr-vw7x](https://github.com/advisories/GHSA-r635-g3xr-vw7x) | **Applicable.** The API exposes Socket.IO, the server retains default polling support, and the web client explicitly allows `['websocket', 'polling']`. Malformed unauthenticated polling POSTs can exhaust connections/resources. | **P1 update now:** force/refresh `engine.io >=6.6.7` within Socket.IO’s compatible range; test polling, WebSocket, reconnect, rate limits, and proxy timeouts. |
| [#13](https://github.com/Maneek21/Deft/security/dependabot/13) | High 7.5 | `fast-uri 3.1.3 → >=3.1.4` | [CVE-2026-16221 / GHSA-v2hh-gcrm-f6hx](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx) | Present through Ajv/MCP schema handling and a root override. Static review found no Deft host-policy or SSRF decision that consumes this parser’s result, so no exploitable chain was identified; connected MCP schemas keep the conclusion conditional. | **Resolved locally:** keep the root override at `^3.1.5`; lockfile resolves `3.1.5`. |
| [#14](https://github.com/Maneek21/Deft/security/dependabot/14) | High 7.0 | `sharp 0.34.5 → >=0.35.0` | [GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj); inherited CVE-2026-33327, -33328, -35590, -35591 | The only identified application image call sites use trusted repository-owned brand PNGs; no `images.remotePatterns` or untrusted optimizer/Sharp input route was found. Current remote exposure appears low, but the vulnerable binary remains shipped. | **P2 update separately:** target advisory-recommended `sharp@0.35.3`, verify Next compatibility/build/image smoke tests, and block risky formats if an immediate upgrade is impossible. PR #197 does not fix it. |
| [#19](https://github.com/Maneek21/Deft/security/dependabot/19) | Moderate 6.3 | `next 16.2.10 → >=16.2.11` | [CVE-2026-64643 / GHSA-955p-x3mx-jcvp](https://github.com/advisories/GHSA-955p-x3mx-jcvp) | Discloses Server Action/`use cache` endpoints. Neither feature was found. | **P2 update with #22;** continue authenticating inside every server boundary. |
| [#18](https://github.com/Maneek21/Deft/security/dependabot/18) | Moderate 6.3 | `next 16.2.10 → >=16.2.11` | [CVE-2026-64647 / GHSA-4633-3j49-mh5q](https://github.com/advisories/GHSA-4633-3j49-mh5q) | Cache confusion requires server-side request-body fetches with non-UTF-8 charsets. No matching path was found. | **P2 update with #22.** |
| [#17](https://github.com/Maneek21/Deft/security/dependabot/17) | Moderate 6.3 | `next 16.2.10 → >=16.2.11` | [CVE-2026-64644 / GHSA-q8wf-6r8g-63ch](https://github.com/advisories/GHSA-q8wf-6r8g-63ch) | Image optimizer DoS requires configured remote images. Deft has no `remotePatterns` and only uses `next/image` for local brand PNGs. | **P2 update with #22.** |
| [#20](https://github.com/Maneek21/Deft/security/dependabot/20) | Moderate 6.0 | `next 16.2.10 → >=16.2.11` | [CVE-2026-64648 / GHSA-68g3-v927-f742](https://github.com/advisories/GHSA-68g3-v927-f742) | Cache confusion requires `fetch(new Request(init), aDifferentInit)` in an App Router server path. No such fetch was found. | **P2 update with #22.** |
| [#11](https://github.com/Maneek21/Deft/security/dependabot/11) | Moderate 5.9 | `@hono/node-server 1.19.14 (transitive) → >=2.0.5` | [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) | Direct server copy is 2.0.8 and already past this fix, but the reviewed master lockfile also has transitive 1.19.14 through the MCP SDK. Deft does not call `serveStatic`; the MCP package imports only client transports. Current exploit path is inactive. | **P2 update:** PR #197 removes the 1.x copy and resolves only 2.0.12. A narrow path must also update the MCP SDK, not just merge #195. |
| [#12](https://github.com/Maneek21/Deft/security/dependabot/12) | Moderate 5.3 | `@hono/node-server 2.0.8 → >=2.0.10` | [GHSA-9mqv-5hh9-4cgg](https://github.com/advisories/GHSA-9mqv-5hh9-4cgg) | Direct 2.0.8 is affected, but Deft does not use Hono’s `upgradeWebSocket`; it attaches Socket.IO separately. Current exploit path is inactive. | **P2 update:** PR #197 fixes both Hono alerts. PR #195 fixes this alert only and must be paired with an MCP SDK/lockfile cleanup for #11. |
| [#10](https://github.com/Maneek21/Deft/security/dependabot/10) | Low 3.7 | `body-parser 2.2.2 → >=2.3.0` | [CVE-2026-12590 / GHSA-v422-hmwv-36x6](https://github.com/advisories/GHSA-v422-hmwv-36x6) | Transitive through Express/MCP SDK. Deft does not directly configure `body-parser` or a dynamic `limit`, so the vulnerable condition is inactive. | **P3 update:** PR #197 resolves 2.3.0; keep request-size validation explicit at Deft ingress. |

## Consolidated remediation plan

### Workstream 1 — authorization and tenant isolation

- Fix recap route membership and `org_id` scoping.
- Fix all cross-reference source/target visibility checks before reads and writes; include `cross_references.context` and remediate historical leaked contexts/comments.
- Restore the owner/admin gate across developer diagnostics, certification reads/mutations, and channel-test start.
- Add negative tests for cross-tenant UUIDs, private spaces/notes/DMs, restricted tasks, membership revocation, deleted rows, stale relation rows, and member access to every privileged runtime endpoint.

### Workstream 2 — trusted UI and shell boundaries

- Make system-message identity server-authoritative.
- Stop constructing executable shell commands from user-controlled strings.
- Return structured commands/argv and use stdin/prompt files where possible.
- Test `$()`, backticks, CR/LF, quotes, backslashes, ampersands, pipes, and PowerShell/CMD-specific metacharacters.

### Workstream 3 — dependencies

- Pin Next.js and `eslint-config-next` to `16.3.0`, use Hono `^4.12.34`, `@hono/node-server ^2.0.12`, and `@modelcontextprotocol/sdk ^1.30.0`.
- Keep durable workspace override floors for `engine.io ^6.6.7`, `fast-uri ^3.1.5`, `sharp ^0.35.3`, `body-parser ^2.3.0`, `postcss ^8.5.23`, `ip-address ^10.3.1`, and the two safe `brace-expansion` branches.
- Run typecheck, build, API tests, Socket.IO polling/WebSocket smoke tests, Next image tests, and then re-check the GitHub dependency graph.

### Workstream 4 — one rich-content-to-text implementation per runtime

- Replace regex tag deletion and cascading entity replacement with parser-based extraction.
- Preserve intentional TipTap block boundaries, Deft mentions, and `[[file:...]]` markers.
- Keep HTML sanitization at real rendering sinks; plain-text conversion is not a replacement for DOMPurify.
- Add a shared adversarial corpus: nested/malformed tags, quoted `>` attributes, comments, script/style nodes, nested entities, mentions, file markers, and malformed TipTap content.

### Workstream 5 — tests, audits, and documented dismissals

- Remove identity replacements.
- Make fetch mocks exact-host and fail closed.
- Make audit filters exact-origin/path or exact known-message filters.
- Dismiss only after recording why the code is not making a security decision and why no production sink exists.

## Verification and exit criteria

1. Authorization regression tests pass for the recap route; all cross-reference reads and worker writes; and every developer, certification, and channel-test route listed in A3. Member calls fail while intended admin/owner calls pass.
2. Existing `cross_references.context` and generated comments are audited, and any private note/DM excerpts already disclosed to task viewers are removed or redacted.
3. User-authored glyph-prefixed messages cannot acquire system styling.
4. Generated runtime setup cannot invoke shell evaluation or expansion from any employee field: execution uses exact argv plus stdin/prompt data, with no executable prompt-bearing shell string. POSIX, PowerShell, and CMD regression cases include `$()`, backticks, CR/LF, quotes, and backslashes.
5. Nested entities decode exactly once in alerts #11–#14; persisted and preview text matches the expected literal content; React escaping remains intact; and TipTap boundaries, mentions, and file markers are preserved.
6. Lockfile contains at least:
   - `next 16.3.0` and `eslint-config-next 16.3.0`
   - `hono >= 4.12.34`
   - `@hono/node-server >= 2.0.12` with no vulnerable transitive copy
   - `engine.io >= 6.6.7`
   - `fast-uri >= 3.1.5`
   - `sharp >= 0.35.3`
   - `body-parser >= 2.3.0`
   - `postcss >= 8.5.23`
   - `ip-address >= 10.3.1`
   - `brace-expansion 1.1.18` and `>= 5.0.9` for the two dependency branches
7. Typecheck, build, API tests, Socket.IO transport smokes, and Next image smokes pass.
8. Audit/report scripts either validate and safely log relative paths/origins or have alert-specific false-positive dismissals; stdout contains no credentials, query tokens, or unsafe absolute report paths.
9. CodeQL is rerun on `master`; fixed alerts close automatically and any remaining dismissals have item-specific rationale.
10. GitHub Security and quality is rechecked after dependency-graph refresh rather than assuming a merged lockfile immediately closes alerts.

## Methodology and limitations

- Every open GitHub code-scanning and Dependabot item was inventoried from the authenticated repository security pages.
- CodeQL rule details and each alerted source location were reviewed against the same commit as GitHub’s `master`.
- Dependency versions were reconciled with `package.json`, `pnpm-lock.yaml`, `pnpm why`, current feature/config usage, and the open Dependabot PRs.
- PR #197’s head lockfile was checked directly to distinguish the 12 alerts it resolves from the two it leaves open.
- This is a static source/configuration review, not exploitation against a deployed instance. “Not currently reachable” means the required code/config precondition was not found at the reviewed commit; it is not permission to leave vulnerable packages indefinitely.

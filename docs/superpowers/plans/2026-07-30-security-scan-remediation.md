# GitHub Security Scan Remediation Plan

**Date:** 2026-07-30
**Resumed and updated:** 2026-08-04
**Baseline:** `master` at `df9b606f05e35833af07af0f37d6a581f5c21f55`
**Scope:** Original 40 CodeQL + 14 Dependabot alerts, three Dependabot alerts added by 2026-08-04, and the higher-priority findings discovered during source review.
**Status:** Local remediation, DB/migration validation, and production Docker/runtime smokes complete; remote closure remains.

## Goal

Close every actionable alert by fixing the shared root cause, retain a specific dismissal rationale only where no production security decision exists, and leave the repository with regression coverage and patched dependency floors.

Existing unrelated worktree changes in `README.md`, `apps/api/src/lib/queues.ts`, `apps/web/next-env.d.ts`, and report media are out of scope and must remain untouched.

## Alert-to-workstream map

| Workstream | Findings | Exit condition |
|---|---|---|
| Authorization and tenant isolation | A1, A2, A3; CodeQL #17–#20, #23, #34 | Tenant, membership, visibility, deletion, and role tests pass for every affected read and write |
| Trusted shell and UI identity | CodeQL #15, #32, #33 | No prompt-bearing executable shell string; user content cannot acquire system identity; quoted content is structured |
| Rich content to plain text | CodeQL #11–#14, #17–#31, #35–#36 | One parser-based implementation per runtime; exactly-once entity decoding; no alerted tag-deletion regex remains |
| Test and audit correctness | CodeQL #1–#10, #16, #37–#40; A4 | Exact assertions and host/path matching, fail-closed mocks, safe process spawning, contained paths, redacted logs |
| Runtime dependencies | Original 14 plus live #23–#25 and audit-detected advisories | Lockfile contains only patched versions and durable workspace-level override floors |
| Verification and GitHub closure | All findings | Focused regressions, typecheck, build, test suite, dependency audit, and GitHub rescans pass |

## Execution sequence

### 1. Fix critical authorization and privacy boundaries

1. Require an organization-scoped membership join before the recap route reads any space or message.
2. Authorize both source and target for every cross-reference read and worker write.
3. Stop storing source excerpts in `cross_references.context` and stop copying private note/DM text into task comments.
4. Apply one owner/admin guard to runtime diagnostics, certification reads/mutations, and channel-test start.
5. Derive reminder previews only after server-side message tenant, deletion, and membership checks.

### 2. Fix executable and trusted-presentation boundaries

1. Keep certification prompts separate from executable commands; use an interactive command with fixed argv.
2. Base system-message presentation only on server-controlled metadata or identity.
3. Construct quote/blockquote content as structured rich-text nodes instead of interpolated HTML.

### 3. Replace fragile rich-text conversion

1. Introduce a shared structural HTML-to-text scanner with exactly-once entity decoding.
2. Use it from the API and web preview helpers.
3. Replace the alerted inline tag-deletion and cascading entity replacements.
4. Preserve TipTap block boundaries, mentions, and file-marker behavior where required.
5. Add nested-entity, malformed-tag, quoted-delimiter, script/style, and block-boundary tests.

### 4. Repair tests, audits, command spawning, and logs

1. Remove identity replacements and make the PR-comment assertion exact.
2. Route test fetches by exact parsed hostname and reject every unexpected network request.
3. Match Socket.IO audit noise by configured origin plus normalized exact path.
4. Match only the known Google Fonts CSP warning.
5. Avoid constructing a Windows `cmd.exe` command string from arguments.
6. Validate report run IDs, prove resolved paths remain below `reports`, and log only safe relative descriptions.
7. Never echo raw configured URLs; describe or redact sensitive components.

### 5. Patch all vulnerable dependencies

1. Upgrade direct packages to Next.js `16.3.0`, `eslint-config-next 16.3.0`, Hono `^4.12.34`, `@hono/node-server ^2.0.12`, and `@modelcontextprotocol/sdk ^1.30.0`.
2. Move pnpm overrides to `pnpm-workspace.yaml`, the location honored by the repository’s pnpm version.
3. Enforce floors for `@hono/node-server ^2.0.12`, `body-parser ^2.3.0`, `engine.io ^6.6.7`, `fast-uri ^3.1.5`, Hono `^4.12.34`, `ip-address ^10.3.1`, `postcss ^8.5.23`, `sharp ^0.35.3`, and safe version-specific `brace-expansion` branches.
4. Regenerate the lockfile and prove that no vulnerable version remains.

### 6. Verify and close

1. Run focused unit/integration tests for every changed security boundary.
2. Run workspace typecheck, lint where available, API tests, web build, Socket.IO transport smokes, and image/build smokes.
3. Run a lockfile/version audit and `pnpm audit`.
4. Re-run CodeQL and Dependabot after the changes reach GitHub.
5. Dismiss only residual scanner findings with an alert-specific explanation showing the code is test/audit-only and makes no production security decision.

## Required regression cases

- Same-org non-member and cross-tenant recap IDs return 404 and disclose no message metadata.
- Private note, DM, deleted source, membership revocation, restricted task, and stale cross-reference rows disclose nothing and create no task comment.
- Ordinary members receive 403 from every runtime diagnostics/certification/channel-test endpoint; owners/admins retain intended access.
- Ordinary members cannot create or clone agent employees, and every supplied space/project/MCP reference belongs to the current organization.
- Space-visible clips keep working while restricted linked-task identifiers and derived task summaries remain hidden from unauthorized viewers.
- Employee names containing `$()`, backticks, quotes, backslashes, CR/LF, ampersands, and pipes never enter an executable shell string.
- Glyph-prefixed user messages retain normal user attribution.
- Nested entities decode once; quoted `>` attributes do not terminate tags; script/style content is omitted; block boundaries remain stable.
- Test fetch mocks reject lookalike hosts and all unexpected egress.
- Report run IDs cannot traverse paths or use Windows reserved device names.
- stdout contains no raw credential-bearing URLs, query tokens, or unsafe absolute report paths.
- Lockfile contains no vulnerable Next, Hono/node-server, Engine.IO, Fast URI, Sharp, body-parser, PostCSS, `ip-address`, or `brace-expansion` version.

## Completion record

Completed locally:

- all 40 CodeQL alert locations remediated through shared root-cause fixes and focused regressions;
- all 17 currently open Dependabot alerts represented by patched versions in the final dependency graph, with both full and production audits reporting zero advisories;
- authorization, tenant isolation, current-visibility, trusted-presentation, command construction, path/log safety, and historical content-redaction fixes implemented;
- frozen install, API/web typechecks, web lint, production web build, 63 focused regressions, 19/19 DB-backed privacy tests, 8/8 direct migration data assertions, a Linux/Alpine production image build, API/web/Sharp/image/Socket.IO runtime smokes, the final five-test migration subset, and `git diff --check` passed;
- Docker validation also fixed and reverified the production entrypoint's LF contract and made interrupted pnpm image installs cache-assisted and retry-resumable through a BuildKit store cache and extended fetch timeout.

Remaining before remote closure:

1. Deploy upgrade `0.2.0-preview.4` through `pnpm db:upgrade` on applicable installations.
2. Push a reviewed branch and wait for CI, CodeQL, and GitHub's dependency-graph refresh. GitHub still reports 40 CodeQL and 17 Dependabot alerts on unchanged remote `master`; no alert has been dismissed.

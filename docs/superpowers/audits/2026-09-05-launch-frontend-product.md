# Frontend and product launch audit — September 5, 2026

## Scope and decision

This is a review, not a source change. Findings target GitHub `master` at `7355c90a0ab5630b839440e8e25133b63853835c`, inspected through `git show` and the immutable archive in `tmp/launch-audit-2026-09-05/current`. The original local checkout is 157 commits behind that revision; findings from its source were rechecked against the archive. Existing worktree changes were preserved.

Immutable source anchors: [Notes persistence](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/web/src/app/%28app%29/notes/page.tsx#L294), [request retry and session interception](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/web/src/lib/api.ts#L76), [login destination](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/web/src/lib/auth-context.tsx#L111), [file authorization](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/middleware/auth.ts#L27), and [web CI selection](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/.github/workflows/ci.yml#L33).

The product has substantial implemented breadth and meaningful production-image smoke coverage. The human workspace still has correctness gaps that should be fixed before a public preview launch: Notes can silently lose pending body edits, failed saves can appear successful, ordinary failed logins enter session-expiry handling, and the shared client can repeat non-idempotent writes. Launch as a clearly bounded public preview after fixing these and certifying the core journeys below. Current evidence does not justify a stable-v1 reliability claim.

Read `README.md`, `CONTRIBUTING.md`, current limitations, the roadmap, relevant App delivery/certification records, web AGENTS, and installed Next 16.3.1 error-handling/accessibility documentation. No independent security audit, full cross-browser certification, or production load benchmark is implied.

## Confirmed current-head findings

### P1 — Saving a title or icon can cancel an unsaved note body

In `apps/web/src/app/(app)/notes/page.tsx:294`, body edits schedule a PATCH after 600ms. At lines 338–347, `markSaved()` calls `clearSavedTimers()`, which cancels that pending body timer. Title edits save after 500ms at lines 468–482 and call `markSaved()` on success; `persistNoteUpdate()` does the same for icon, pin, and visibility edits at lines 349–358.

Reproduction: edit the body, then immediately edit the title; advance through both debounce periods. Only the title PATCH is issued, while the UI state becomes `saved`. The same loss occurs when an icon/visibility write succeeds before the body timer. A reload discards the body edit because it was never sent.

The deterministic production-callback probe reproduced both cases at the audited revision. The real production-built Next/React/TipTap UI also reproduced body→title at 1440×900 and 390×844: only a title PATCH reached the mocked API, its stored body stayed unchanged, and both screenshots visibly show Saved beside the unsaved body. Fix by managing pending content writes separately from the saved-status timer, and serialize/coalesce note mutations so one successful field write cannot cancel another field's dirty state. Add persistence assertions after reload for body→title, body→icon, body→visibility, rapid switching, and delayed/out-of-order responses.

### P1 — HTTP failures still mark note content as Saved

`apps/web/src/app/(app)/notes/page.tsx:299` awaits `api.patch()` but never checks `response.ok`; line 300 marks the content saved even for HTTP 403/413/429/500. The client returns those HTTP responses normally. The production callback probe returned HTTP 500 and observed `saving → saved`.

The production browser reproduction returned HTTP 500 for the body PATCH and visibly showed Saved at both desktop and mobile sizes, while the mocked API retained the original content. `apps/web/src/components/canvas-panel.tsx:57` has the same failure pattern: it awaits a PATCH without checking the response, clears `saving`, and displays `Last edited Just now`. Its network rejection path also lacks a local catch/retry state. The Canvas variant is source-confirmed but was not separately browser-reproduced in this audit.

Fix with explicit success checking, a visible failed/unsaved state, retry, retained dirty content, and navigation handling. Test 403, 413, 429, 500, offline/reconnect, navigation during debounce, and a response arriving after the user edits again. A successful POST or initial rendered note is insufficient persistence evidence.

### P1 — The shared client retries non-idempotent writes after ambiguous failures

`apps/web/src/lib/api.ts:76` retries any fetch TypeError twice, regardless of method; lines 110, 142–146, and 192–196 use it for POSTs and uploads. If a server commits and its response is lost, the same user action can execute again. The unmodified client was exercised with a fake transport that commits the first request then throws a network TypeError: one `api.post('/api/events', …)` produced two committed creates.

This is not merely hypothetical absent server deduplication: `apps/web/src/components/calendar/create-event-modal.tsx:67` submits a native event without an idempotency key and `apps/api/src/routes/events.ts:51` inserts a new row on every accepted request. Task/project/comment/upload flows should also be inventoried.

Restrict automatic retries to reads or operations with an enforced idempotency contract. For other writes, surface the uncertain outcome and reconcile before retrying. Add transport-level tests for response loss after commit; ordinary server-500 tests do not exercise this condition.

### P2 — A wrong password is treated as an expired workspace session

`apps/web/src/lib/auth-context.tsx:112` submits login through the shared client. `apps/web/src/lib/api.ts:115–130` treats every 401 as an expired access token, including `/api/auth/login`; without a refresh token it stores the current `/login` pathname and navigates to `/login?expired=1`. The real client reproduction confirmed both values.

This loses the login form/error presentation and poisons the next login destination: `auth-context.tsx:120–125` consumes the saved `/login` destination after successful login. `apps/web/src/app/login/page.tsx` has no authenticated-user redirect to repair that destination. The actual browser confirmed that the wrong password clears the email form, then a correct password stores the successful access token but still leaves the user on `/login`. Separate unauthenticated auth endpoints from access-token refresh interception, and reject authentication pages as post-login destinations. Test wrong password → correct password, expired real session → refresh, revoked refresh, refresh stampedes, and a bookmarked detail URL with query parameters.

### P2 — Uploaded images in Notes use an unauthenticated image request

`apps/web/src/app/(app)/notes/page.tsx:282–284` and `317–319` insert an ordinary image with a direct `/api/files/{id}` URL after upload. Notes uses the base TipTap Image extension at line 256, without the protected-file loader. `apps/api/src/index.ts:184` mounts auth before the file routes at line 198; `apps/api/src/middleware/auth.ts:27–30` requires an Authorization bearer header. A normal `<img src>` does not acquire the token in localStorage.

The actual production browser requested the persisted image with no Authorization header, received the mocked equivalent of `NO_TOKEN`, and displayed a broken image at both sizes. An HTTPS fixture origin was used so the test independently exercises missing authentication rather than the app's HTTP cross-origin image CSP restriction. The repository already has an authenticated Blob/object-URL path in `apps/web/src/components/protected-file.tsx` and `apps/web/src/lib/protected-file.ts`. Bring persisted editor images under an equivalent file-ID-aware loader while preserving authorization and revocation. Do not make file URLs public or put bearer tokens into saved HTML. Test paste/upload → render → reload, sharing with permitted and denied users, file deletion, and exports containing images.

## Other directly inspectable gaps

- **Legacy setup presents actions that do nothing.** `apps/web/src/app/setup/page.tsx:111` wires “Send Invites” to `next`; the workspace-name input likewise only changes local state. Space/project calls swallow failures at lines 33/43, and the completion PATCH uses `onboarding_completed` at line 50 while the current welcome flow uses `/api/auth/onboarding`. Current signup routes to `/setup-ai`, so classify this as stale reachable product surface rather than a demonstrated first-signup blocker. Remove/redirect the unused route or finish it; do not advertise it.
- **Invited-member onboarding advances despite failure.** `apps/web/src/app/welcome/page.tsx:39–77` swallows profile/message/completion failures and can mark `first_message_sent` after an unsuccessful message response. If completion fails, the app layout can send the member back to welcome. This needs a real invited-member negative-path test.
- **Recoverability is inconsistent.** No route `error.tsx` or `global-error.tsx` exists under current `apps/web/src/app`. Some core fetches only stop their loader or ignore HTTP failures; for example Calendar at `apps/web/src/app/(app)/calendar/page.tsx:88–98` does not render a load error/retry. A successful build cannot certify these states.
- **Accessibility is partly implemented, not uniformly applied.** Shared `AppDialog` traps Tab and has dialog semantics, but `apps/web/src/components/calendar/create-event-modal.tsx:94–160` uses a custom overlay without dialog semantics/focus trap, several labels are not programmatically connected to inputs, and its close icon has no accessible name. Audit concrete core dialogs, not only presence of an accessible primitive.
- **Mobile evidence needs inner-container checks.** Open PR #317 adds `min-w-0` to the App card and verifies its scrolling ancestor as well as document overflow. The current product smoke checks only document overflow, which can miss clipping inside the app shell. Merge/certify the focused fix, then extend the same measurement to core editors/dialogs.
- **Public positioning lags current implementation.** `docs/current-limitations.md` still says last reviewed July 16. The roadmap lists already-implemented release/browser/security workflows as future work. Refresh these from the exact release commit, retaining real limits and distinguishing supported preview surfaces from later App tracks.

## Existing test strengths and gaps

There are 31 web `.test.ts` files at this revision. Main CI's focused-web step explicitly executes five: huddle state, socket lifecycle, space-socket lifecycle, module collection navigation, and Apps contracts (`.github/workflows/ci.yml:33–40`). Many useful existing tests for editor commands, responsive layout, calendar math, task views, protected files, and App automation/navigation are not in that step. The audit coordinator separately ran all web pure tests: 114 passed. This is good regression evidence for those contracts; it does not cover rendered mutation races.

`scripts/product-browser-smoke.mjs` genuinely exercises production-image login, a single rendered chat message, task creation/status, approval/destination verification, settings navigation, and Contacts collection tabs. It then visits eight routes at 390×844 and checks document overflow. It uses Chromium only, and the core smoke does not persist/reload Notes, invite a new member, fail a save, renew an expired session, use a mobile keyboard, or assert inaccessible content after revocation.

The newer Phase 6 and Track A browser certifications are deeper for Apps: governed action→Inbox→Run/receipt, package upgrade, scheduled automation, management controls, error counting, and desktop/mobile evidence. Preserve those gates. Their depth does not establish equivalently deep core human-workspace coverage. Historical one-off audit scripts should be checked before reuse; e.g. `docs/superpowers/audits/gap-fixes.audit.ts:279` expects a browser confirm dialog for note deletion, while current Notes uses a timed Undo UI.

## Launch test and work roadmap

| Timing | Required result | Completion evidence |
|---|---|---|
| First 24h | Fix Notes dirty-state loss/false success, mutation retries, and login 401 handling; certify PR #317 and dependency security PR #318 | Focused red→green regressions at the release commit; browser reload proves persisted Notes and one server write per user action |
| Next 24h | Certify first owner and invited member; no-AI core workflows; protected uploads/images; private spaces/tasks/notes; real approval→destination | Fresh disposable deployment, two real sessions, owner/member/guest roles, desktop 1440×900 plus390×844 and narrow 360px, screenshots and persisted API evidence |
| Next 24–48h | Failure/recovery sweep and cross-browser core paths | Chromium, Firefox, WebKit; keyboard-only dialogs; offline/lost response, 429/500, token expiration, server restart, revoked access, large/invalid uploads, reconnect without duplicate message |
| Release freeze | One consolidated production-image pass on the immutable candidate, fix only regressions, refresh public limits | Required CI and App gates green; matching source/image digest; documented operator recovery proof from the parallel release audit; no unresolved P1 data-loss findings |
| First preview week | Controlled pilot on real team traffic; focus fixes by observed incidents | Error/latency/backlog observations, daily triage, notes/chat/task persistence checks, operator restore rehearsal, public known-issues update |

Keep the coming-days scope to the existing self-hosted human workspace plus the exact certified agent/App capabilities. Do not make later isolated UI/runtime/public-ingress tracks a launch prerequisite or imply they are shipped merely because plans exist. Huddles need real-device media permission, reconnect, and two-user audio tests before a broad call-quality promise; the current smoke only proves the start control does not request microphone access on render.

## Fresh evidence and limits

- `node tmp/launch-audit-2026-09-05/frontend-repro.mjs`: exited 1 intentionally because all five expected correctness invariants failed. Reads the immutable snapshot, executes the unmodified client and AST-extracted actual callbacks, mocks only network/browser storage/timers. No HTTP or database writes occur.
- Browser reproduction command: `$env:DEFT_AUDIT_WEB_URL='http://127.0.0.1:4390'; node tmp/launch-audit-2026-09-05/frontend-browser-repro.mjs`. It ran against the successfully production-built current-head Next server, with every API request intercepted. It exited 1: eight correctness assertions failed (image, body/title, and HTTP 500 at two sizes, plus two login scenarios); both uncaught-page-error checks passed. This demonstrates why page-error-free smoke is insufficient. The initial development-server attempts timed out during parallel compilation; those are environment limitations, not product findings.
- [Browser results JSON](../../../tmp/launch-audit-2026-09-05/frontend-browser/results.json), [desktop body/title screenshot](../../../tmp/launch-audit-2026-09-05/frontend-browser/notes-body-title-1440.png), [mobile failed-save screenshot](../../../tmp/launch-audit-2026-09-05/frontend-browser/notes-http500-390.png), [broken image screenshot](../../../tmp/launch-audit-2026-09-05/frontend-browser/notes-protected-image-1440.png), [successful login still on login page](../../../tmp/launch-audit-2026-09-05/frontend-browser/login-correct-after-wrong.png). Screenshots were visually inspected. These are real rendered frontend tests against mocked server responses; they do not claim real database or provider execution.
- Broad typecheck/build/API/DB/release outcomes belong to the coordinator's consolidated audit. This report does not independently claim they passed.
- No production source was changed. This report and audit-only probes are the intended additions; original AGENTS/CLAUDE edits and other pre-existing untracked work remain untouched.


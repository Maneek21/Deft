# Defty Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository each work package is executed by **Codex** using the protocol in "Execution protocol" below.

**Goal:** Close Defty's verified privacy holes, make every Defty failure visible and non-duplicating, and stop passive capture from destroying or leaking knowledge.

**Architecture:** Nine work packages (WP1–WP9) in three waves. Each package is one branch, one worktree, one Codex implementation run, one Codex read-only review, one Claude verification pass and one PR. Packages in the same wave never touch the same file.

**Tech Stack:** Hono API + PostgreSQL queue workers (`apps/api`), Drizzle (`packages/db`), Next.js (`apps/web`), `node:test` via `tsx --test`.

**Spec:** [`docs/superpowers/audits/2026-10-22-defty-failure-audit.md`](../audits/2026-10-22-defty-failure-audit.md). Finding IDs (A01, B02, …) refer to it; line-level evidence is in `docs/superpowers/audits/2026-10-22-defty-failure-audit/codex-*.md`.

## Decisions required before Wave 1

| # | Decision | Recommended default | Affects |
|---|---|---|---|
| D1 | Legacy `/api/agent/conversations*` routes (9 handlers, no web/package/script caller): remove or harden? | **Remove.** The web chat uses spaces/messages and the queued reply worker. AGENTS.md forbids parallel agent-only conversation paths. Removing the routes also removes A01, A02, A10, A12, A13 and A14. | WP1 |
| D2 | Should org trust level govern Defty chat writes (E08)? | **No — chat stays proposal-only.** Fix the settings copy so trust is described as governing background and automation runs only. This is the smaller and safer change. | WP9 |
| D2b | Defty's mandate | **Settled by owner (2026-10-22):** Defty does not manage agent employees, MCP connections, triggers or agent economics. Chat-to-task runs only when Defty is invoked; passive extraction stays off. | WP1, WP7 |
| D3 | Memory upsert uniqueness (B09) needs a schema migration. | Defer to its own reviewed migration plan, per AGENTS.md. Not in this plan. | — |
| D4 | Restart the local `deftv03test-postgres-1` container for live verification? | Ask at final verification only. | Final pass |

## Global Constraints

- Preserve tenant isolation. Every new or changed query filters on `org_id` plus the resource's existing visibility helper: `visibleWikiPageCondition(userId)` (`apps/api/src/lib/wiki-visibility.ts`), `visibleTaskCondition(userId)` / `unrestrictedTaskCondition()` (`apps/api/src/lib/task-visibility.ts`), and space membership through `space_members`.
- Fail closed. A read tool that cannot establish the requester's identity returns `{ error, code: 'FORBIDDEN' }` and never falls back to org-wide results.
- Keep error shapes as `{ error: string, code: string }`. No stack traces, provider bodies or keys in replies, SSE or logs shown to users.
- No schema migrations in this plan. If a package finds it needs one, it stops and reports.
- No new production dependencies.
- Tests use `node:test` + `node:assert/strict` under `apps/api/test/*.test.ts`. Name each test after the finding ID, for example `test('B02 search_blockers excludes DMs the requester is not in', …)`.
- DB-backed tests run only through `pnpm --filter @deft/api test <files>` with `DEFT_TEST_DATABASE_URL` pointing at a disposable database. Never use the app database.
- Do not modify `packages/shared/node_modules`, run `pnpm install` against the main checkout, or touch files outside the package's listed files without reporting why.

## Review Focus

- **Guest and removed-member requesters.** Anyone whose `space_members` row was deleted must lose Defty access to that space's messages, wiki, standups and actions immediately. Tests: WP2 Task 2.1 and WP3 Task 3.1.
- **One user in two organizations.** Defty must never mix memories, tasks or calendar events across organizations. Test: WP3 Task 3.2.
- **Provider misconfiguration on a fresh install.** A wrong key or unknown model must produce one visible Defty reply naming the problem and pointing to Settings → AI, not three silent retries. Test: WP5 Task 5.1.
- **Retries after partial success.** A worker crash or post-commit error must never post a second reply or create a second task. Tests: WP5 Task 5.2 and WP6 Task 6.2.
- **Non-English and non-agriculture workspaces.** Non-Latin queries must retrieve results, and generic policy decisions must be capturable. Tests: WP7 Task 7.2 and WP8 Task 8.2.

---

## Execution protocol (Codex workflow)

Every package follows these steps. `<wp>` is for example `defty-wp2-action-authz`.

1. **Worktree:** `git worktree add C:/tmp/deft-<wp>-20261022 -b codex/<wp>-20261022 master`, then `pnpm install --frozen-lockfile --offline` inside the worktree.
2. **Implement (Codex, workspace-write):** the brief is the "Global Constraints" section plus the package's section of this plan, verbatim.
   ```bash
   CX=$(ls -t "/c/Users/Osheen Pradhan/AppData/Local/OpenAI/Codex/bin/"*/codex.exe | head -1)
   "$CX" exec --skip-git-repo-check --color never -C "C:/tmp/deft-<wp>-20261022" \
     -s workspace-write -o "$SCRATCH/<wp>.impl.md" - < "$SCRATCH/<wp>.brief.txt"
   ```
   Add to every brief: *"pnpm is at `C:\Users\Osheen Pradhan\AppData\Roaming\npm\pnpm.cmd`. If you cannot reach the test database, write the tests anyway and say so. Commit nothing."*
3. **Review (Codex, read-only, fresh run):** brief = the package section plus `git -C <worktree> diff master`. Ask for correctness bugs, missed call sites of the same pattern, and tests that would pass on unfixed code. Use `-s read-only`.
4. **Verify (Claude):** run the package's focused tests and then the full Defty suite against the disposable DB (`deft-defty-audit-db`, `127.0.0.1:55520`). Packages share this DB, so run them one at a time. Then run `pnpm --filter @deft/api exec tsc -p tsconfig.json --noEmit`, and for web packages `pnpm --filter @deft/web typecheck` plus a rendered check at 1440×900 and 375×812.
5. **Ship:** commit with the package's message, push, open a PR, and bind it with the ccd_pr tools.

The full Defty suite command:

```bash
cd apps/api && FILES=$(ls test | grep -i -E "defty|agent|capture|approval|mcp-|memory|receipt|observe|task-extract|blocked|standup|meeting-prep|classifier|retrieve|dispatch|mention|work-intent" | grep -E "\.test\.ts$" | sed 's#^#test/#' | tr '\n' ' ') && DEFT_TEST_DATABASE_URL=postgres://deft:deft@127.0.0.1:55520/deft_test pnpm test $FILES
```

Baseline: 506/506 pass on `2d478aee`.

## Waves and file ownership

| Wave | Package | Owns (exclusive within the wave) |
|---|---|---|
| 1 | WP1 Retire legacy conversation API | `routes/agent.ts` lines for `/conversations*` only, `lib/agent-stream-loop.ts`, `test/agent-actions-routes.test.ts` |
| 1 | WP3 Defty read authorization | `lib/agent-context.ts`, `lib/agent-runner.ts`, `lib/retrieve-context.ts`, `workers/handlers/agent-reply.ts` (conversationId plumbing only) |
| 1 | WP4 Capture and standup safety | `lib/standup-automation.ts`, `workers/handlers/chat-knowledge-batch.ts`, `lib/defty-capture.ts`, `lib/chat-observation.ts` |
| 1 | WP9 Web truthfulness (non-card) | `apps/web/src/app/(app)/settings/{ai,agent}/page.tsx`, `rich-composer.tsx`, `mention-autocomplete.tsx`, `lib/quick-actions.ts`, `app/(app)/layout.tsx`, `dashboard/starter-cards.tsx`, `space-chat.tsx`, `thread-panel.tsx`, `lib/agent-approval-copy.ts`, `lib/space-socket.ts`, signup page / auth client |
| 2 | WP2 Action governance authorization (after WP1 merges) | `routes/agent.ts` (actions/undo/settings), `routes/dashboard.ts`, `lib/module-action-visibility.ts`, `lib/agent-actions.ts` (permission checks only) |
| 2 | WP5 Reply lifecycle (after WP3) | `workers/handlers/agent-reply.ts`, `lib/agent-action-proposals.ts`, `routes/messages.ts`, `lib/dispatch-agent-message.ts`, `lib/mcp-tools/human.ts`, `lib/agent-llm.ts`, `workers/index.ts`, new `lib/defty-failure-reply.ts` |
| 2 | WP8 Capture completeness (after WP4) | `chat-knowledge-batch.ts`, `workers/index.ts` (schedule constant only; coordinate with WP5), `defty-capture.ts`, `automation-synthesis.ts`, `meeting-prep-automation.ts`, `automation-runs.ts`, `routes/dashboard.ts` (standup lookup; coordinate with WP2) |
| 3 | WP6 Durable, truthful approvals (after WP2) | `lib/agent-actions.ts`, `routes/agent.ts` (approve/reject/undo), `lib/agent-approval-resolver.ts`, `lib/agent-action-confirmation.ts`, `lib/attention.ts`, `lib/task-bundle.ts`, `web/components/agent-action-card.tsx`, `web/lib/agent-action-presentation.ts`, `dashboard/lib/shared.tsx` |
| 3 | WP7 Tool contracts and retrieval quality (after WP3) | `lib/agent-tools.ts`, `lib/agent-context.ts`, `lib/agent-runner.ts`, `lib/retrieve-context.ts`, `lib/embed.ts`, `scripts/templates/defty/*.md` |

Wave 2 overlaps: WP5 and WP8 both touch `workers/index.ts`, and WP2 and WP8 both touch `routes/dashboard.ts`. Land WP2 and WP5 first, then rebase WP8.

Wave 3 overlaps:
- WP6 Task 6.2 (C04) and WP7 both edit `lib/agent-context.ts`, and WP6 Task 6.2 also edits `workers/handlers/agent-reply.ts`. Land WP7 first, then rebase WP6. WP6.1 and WP6.3 can proceed in parallel with WP7.
- WP9 Task 9.1's admin-only trust controls consume WP2 Task 2.3. If WP9 lands first, ship the save-truthfulness fix alone and add the control gating as a follow-up commit after WP2.

---

## WP1 — Retire the legacy conversation API (D1) · Wave 1

Fixes A01, A02, A10, A12, A13, A14. Codex lane: implement.

### Task 1.1: Unmount `/api/agent/conversations*`

**Files:**
- Modify: `apps/api/src/routes/agent.ts` — delete the handlers at `:664` GET list, `:708` POST, `:747` GET one, `:776` PATCH, `:797` DELETE, `:822` GET messages, `:919` POST messages, `:993` continue, `:1224` trace.json, and any helpers that only they use (history loader `:415-650`).
- Modify or delete: `apps/api/src/lib/agent-stream-loop.ts`, only if nothing else imports it (`rg "agent-stream-loop" apps packages`).
- Modify: `apps/api/test/agent-actions-routes.test.ts:827` (the only caller).
- Create: `apps/api/test/agent-legacy-conversations-removed.test.ts`

**Interfaces:**
- Produces: no `/api/agent/conversations` routes. `/api/agent/actions*`, `/api/agent/settings` and the action routes are unchanged.

- [ ] **Step 1: Write the failing test.** `test('A01 legacy conversation routes are not mounted', …)` mounts `agentRoutes` on a Hono app, as the existing route tests do. For each of `GET /conversations`, `POST /conversations/<uuid>/messages` and `DELETE /conversations/<uuid>`, it asserts status `404` **and** that the `messages` and `spaces` row counts for the fixture org are unchanged.
- [ ] **Step 2: Run it.** `pnpm test test/agent-legacy-conversations-removed.test.ts` → FAIL (`POST` returns 200 and inserts a row).
- [ ] **Step 3:** Delete the handlers and orphaned helpers. Replace the test at `agent-actions-routes.test.ts:827` with an equivalent assertion against the space-messages path, or delete it if it only covered the legacy route. Note which in the PR.
- [ ] **Step 4:** Run the new test plus the full Defty suite → PASS. Run `tsc --noEmit` → clean, with no unused imports left.
- [ ] **Step 5: Commit** `fix(agent): remove legacy agent conversation API (A01, A02)`.

### Task 1.2: Remove superintendent tools (outside Defty's mandate)

Managing agent employees, MCP connections, triggers and agent economics is **not Defty's job**. `SUPERINTENDENT_TOOLS` (`list_agent_employees`, `manage_agent_employee`, `get_agent_activity`, `get_agent_economics`, `manage_mcp_connection`, `manage_triggers`, at `agent-tools.ts:1081`) are reachable only through the legacy route being removed in Task 1.1 (`routes/agent.ts:509`). Remove them with it rather than move them.

**Files:** `apps/api/src/lib/agent-tools.ts:1081-1215`, the matching handlers in `apps/api/src/lib/agent-context.ts`, and references in `apps/api/src/lib/agent-approval.ts`. Before deleting a handler, confirm with `rg` that the admin UI or the agent-employee routes do not import it. Keep any shared helper they use.

- [ ] **Step 1: Write the failing test** `Defty tool list contains no superintendent tool names`. It asserts that none of the six names appear in `AGENT_TOOLS`, `ACTION_TOOLS`, or any exported tool array.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Delete the definitions, handlers and approval mappings.
- [ ] **Step 4:** Run the test plus the full Defty suite → PASS. Run `tsc --noEmit` → clean.
- [ ] **Step 5: Commit** `refactor(defty): remove superintendent tools outside Defty's mandate`.

---

## WP2 — Action governance authorization · Wave 2

Fixes C01, C02, E01, C03, C13, E02. Codex lane: implement.

### Task 2.1: One visibility predicate for every action read and undo

**Files:**
- Modify: `apps/api/src/lib/module-action-visibility.ts` — add `visibleAgentActionSql`.
- Modify: `apps/api/src/routes/agent.ts` — `/actions` list (`:2020`), receipt (`:2060-2075`), undo (`:1878`), and `visibleCaptureActionSql` callers.
- Modify: `apps/api/src/routes/dashboard.ts:894-908`.
- Test: `apps/api/test/agent-action-visibility.test.ts` (new).

**Interfaces:**
- Produces: `visibleAgentActionSql(user: { id: string; org_id: string }): SQL`. A row is visible when `org_id` matches **and** the user is the requester or an explicit reviewer (reuse the existing requester-or-reviewer SQL at `module-action-visibility.ts:81-84`) **and**, for Defty captures, the existing source-space rule from `visibleCaptureActionSql` still holds. Module actions keep `visibleModuleActionSql`.

- [ ] **Step 1: Write failing tests:**
  - `C02 /api/agent/actions hides another member's post_message payload` asserts that member B's response contains no row with A's action id.
  - `E01 dashboard activity omits params of actions B cannot see` asserts that the serialized response does not include A's message body string.
  - `C01 undo by non-requester returns 404 and leaves message undeleted` asserts `messages.is_deleted === false` and `agent_actions.undone_at === null`.
  - `C01 requester undo still works` asserts the message is soft-deleted.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `visibleAgentActionSql` and use it on all four surfaces. Scope the undo mutation's own `WHERE` with `org_id`.
- [ ] **Step 4:** Run the tests plus the existing `agent-actions-routes`, `agent-approval-matrix` and `module-agent-history` → PASS.
- [ ] **Step 5: Commit** `fix(agent): scope action history, dashboard and undo to requester (C01, C02, E01)`.

### Task 2.2: Executors enforce target visibility

**Files:**
- Modify: `apps/api/src/lib/agent-actions.ts` — wiki update `:1787-1806`, canvas `:2600-2625`, thread reply `:2674-2700`, note space `:2804-2828`, note promotion `:2868-2873`.
- Modify: `apps/api/src/workers/handlers/agent-reply.ts:396-402` — note promotion pre-check must use the same predicate.
- Test: `apps/api/test/agent-executor-visibility.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - `C03 update_wiki on another user's personal page fails and content is unchanged`.
  - `C03 canvas/thread/note writes to a non-member space fail`.
  - `C13 member can promote a space-visible note in a shared space`.
  - `C13 promotion fails after membership is removed`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add `visibleWikiPageCondition(userId)` to the wiki lookup, add a `space_members` existence check before canvas, thread and note writes, and make note visibility `user_id = me OR visibility = 'org' OR (visibility = 'space' AND member of notes.space_id)` in both files.
- [ ] **Step 4:** Run → PASS. Run the full Defty suite → PASS.
- [ ] **Step 5: Commit** `fix(agent): enforce target visibility in native executors (C03, C13)`.

### Task 2.3: Trust level is admin-only

**Files:** Modify `apps/api/src/routes/agent.ts` (`PATCH /settings`). Test `apps/api/test/agent-trust-settings-authz.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - `E02 member PATCH /api/agent/settings returns 403 FORBIDDEN and org trust unchanged`.
  - `E02 admin PATCH succeeds`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Call `requireOrgAdminOrOwner(user.org_id, user.id)` from `lib/org-membership.ts`. Map `OrgMembershipError` to `c.json({ error: err.message, code: err.code }, err.status)`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `fix(agent): require admin to change trust level (E02)`.

---

## WP3 — Defty read authorization · Wave 1

Fixes B01/A03, B02, B03, B04, B17, A06/B07, B18. Codex lane: implement.

**Interfaces (all tasks):**
- Consumes: `executeToolCall(toolName, params, orgId, _userId, conversationId?, agentEmployeeId?)` at `agent-context.ts:99`.
- Produces: `_userId` is always the human requester. `conversationId` is the space id of the turn and is never `undefined` from the runner. `retrieveContext` callers always pass `user_id`, and `retrieveContext` throws if `user_id` is missing (fail closed).

### Task 3.1: Wiki, message, task and calendar reads respect visibility

**Files:**
- Modify: `apps/api/src/lib/agent-runner.ts:279-309` (exact-match wiki), `apps/api/src/lib/agent-context.ts` (`search_blockers :1387`, dependencies `:1255-1321`, project progress `:858-875`, `check_calendar :591-610`, `wiki_read :2011`, retrieval calls `:1082, :1466, :1945`), `apps/api/src/lib/retrieve-context.ts:660`.
- Test: `apps/api/test/agent-read-visibility.test.ts` (new).

- [ ] **Step 1: Write failing tests.** Fixture: two members, A and B, with a private space that only A belongs to. Each test plants a canary string in the private resource.
  - `B01 runner exact-match context excludes private-space wiki canary for B`: call the runner's context builder for B and assert the canary is absent; for A, assert it is present.
  - `B01 wiki_read of private page returns FORBIDDEN for B`.
  - `B02 search_blockers excludes DM canary for non-participant`.
  - `B03 get_task_dependencies with foreign-org task id returns not found`.
  - `B03 dependencies of a visible task omit restricted neighbours`.
  - `B04 check_calendar returns only the requester's events`.
  - `B17 check_calendar day window follows the requester's time zone`: for an Asia/Kolkata user on a UTC host, a 01:30 IST event on 2026-10-22 is included for `date: '2026-10-22'`.
  - `B18 search_tasks with unknown assignee_name returns an unresolved-filter error, not all tasks`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add `visibleWikiPageCondition(_userId)`, space-membership `EXISTS` (copy the predicate `search_messages` uses at `agent-context.ts:268-271`), `visibleTaskCondition(_userId)`, and `eq(events.user_id, _userId)`. Compute day bounds from the time zone already resolved in `agent-runner.ts:226-236`, passed in via `params._timeZone`, defaulting to the org time zone. When a filter does not resolve, return `{ error: 'No assignee/project named "<x>"', code: 'UNRESOLVED_FILTER' }`. Make `retrieveContext` require `user_id`.
- [ ] **Step 4:** Run → PASS. Run the full Defty suite → PASS.
- [ ] **Step 5: Commit** `fix(defty): apply requester visibility to every Defty read (B01-B04, B17, B18)`.

### Task 3.2: Memory is org- and conversation-scoped

**Files:** `apps/api/src/lib/agent-context.ts:912-1022` (`remember` / `recall`), `apps/api/src/lib/agent-runner.ts:570-576`, `apps/api/src/workers/handlers/agent-reply.ts` (pass `spaceId` into the runner). Test: `apps/api/test/agent-memory-scope.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - `A06 recall in org B never returns a user memory saved in org A`, using one user who is a member of both fixture orgs.
  - `B07 conversation recall in space X excludes memories saved in DM Y`.
  - `B07 remember with scope conversation and no conversationId returns error`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Start the `recall` conditions with `eq(agentMemory.org_id, orgId)`. The runner passes the turn's space id as `conversationId`. Conversation-scoped `remember` / `recall` without one returns `{ error, code: 'CONVERSATION_REQUIRED' }`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `fix(defty): scope memory to org and conversation (A06, B07)`.

---

## WP4 — Capture and standup safety · Wave 1

Fixes D01, D04, D02, B05/D03, D06. Codex lane: implement.

### Task 4.1: Standups never include restricted tasks or reach non-members

**Files:** `apps/api/src/lib/standup-automation.ts:60-156, 260-270`. Test: `apps/api/test/standup-visibility.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - `D01 standup evidence excludes restricted task titles (provider-free fallback)`: no AI config; assert the posted message omits the restricted title and owner.
  - `D04 standup is emitted to space:<defaultSpaceId>, not org:<orgId>`: stub `getIO()` and assert the room names it receives.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add `unrestrictedTaskCondition()` to all three task queries. Emit to `space:${spaceId}`, the same room `routes/messages.ts` uses for new messages.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `fix(standup): exclude restricted tasks and emit to channel room (D01, D04)`.

### Task 4.2: Passive capture is consent-aware and non-destructive

**Files:** `apps/api/src/workers/handlers/chat-knowledge-batch.ts:488, 527-544, 605-606`, `apps/api/src/lib/defty-capture.ts:628-708, 870-887`, `apps/api/src/lib/chat-observation.ts` (export the directive helper if it is not exported). Test: extend `apps/api/test/defty-capture-dedupe-update.test.ts`, and new `apps/api/test/chat-knowledge-batch-consent.test.ts`.

**Interfaces:** Produces `isKnowledgeOptOut(content: string): boolean`, exported from `chat-observation.ts`. Its phrases are the ones already recognised at `chat-observation.ts:16`.

- [ ] **Step 1: Write failing tests:**
  - `D02 batch skips an episode containing "Do not save this; keep this in chat"`: with and without a provider, assert no `agent_actions` row and no wiki page.
  - `B05 passive refinement never replaces an existing page body`: seed a page with four clauses, run a batch whose episode restates one clause and adds an owner, and assert all four clauses remain in `wiki_pages.content`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Filter opted-out messages out before episode construction and re-check at capture time in `defty-capture.ts`. For passive capture, set `preferUpdate: false`. When a related page matches, create a **proposal** with an appended `## Update <date>` section built from `existing.content + episode` and `autoApprove: false`. Never auto-replace.
- [ ] **Step 4:** Run the new tests plus `defty-capture-dedupe-update` and `defty-storm-enforcement` → PASS.
- [ ] **Step 5: Commit** `fix(capture): honour opt-out and stop destructive auto-updates (D02, B05)`.

### Task 4.3: Invited private-space capture can execute

**Files:** `apps/api/src/lib/mcp-tools/employee-space-access.ts:29-41`. Test: `apps/api/test/employee-space-access-defty.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - `D06 defty_system employee with is_deleted=true is allowed in a private space it is a member of`.
  - `D06 … is denied in one it is not a member of`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Accept `is_deleted = false OR runtime_kind = 'defty_system'`, keeping the membership check unchanged. Mirror `agent-approval-resolver.ts:790-792`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `fix(capture): allow invited Defty system identity in private spaces (D06)`.

---

## WP5 — Reply lifecycle: Defty always answers exactly once · Wave 2

Fixes A04/E07, A05, A07, A08, A09, A11, A15. Codex lane: implement. This package carries the most risk: run the Codex review step at the highest effort.

**Interfaces:**
- Produces: `postDeftyFailureReply(input: { orgId: string; spaceId: string; triggerMessageId: string; threadParentId: string | null; reason: DeftyFailureReason }): Promise<void>` in new `apps/api/src/lib/defty-failure-reply.ts`.
- `type DeftyFailureReason = 'provider_auth' | 'provider_model' | 'rate_limited' | 'timeout' | 'loop_exhausted' | 'internal'`.
- `classifyProviderError(err: unknown): { reason: DeftyFailureReason; retryable: boolean }` in the same file. 401/403 → `provider_auth`, non-retryable. 404 or model-not-found → `provider_model`, non-retryable. 429 → `rate_limited`, retryable. Abort/timeout → `timeout`, retryable. Anything else → `internal`, retryable.
- Reply idempotency key: the reply message's `metadata.reply_to_message_id = triggerMessageId`. It is checked under `pg_advisory_xact_lock(hashtext('defty-reply:' || triggerMessageId))` before inserting.

### Task 5.1: Terminal failures produce one visible reply

**Files:** create `apps/api/src/lib/defty-failure-reply.ts`. Modify `apps/api/src/workers/handlers/agent-reply.ts:1595-1598, 1886-1893` and `apps/api/src/lib/agent-runner.ts:395, 605`. Test: `apps/api/test/defty-failure-reply.test.ts` (new).

- [ ] **Step 1: Write failing tests**, with the provider stubbed through the existing LLM injection seam (`agent-llm.ts`):
  - `A04 401 posts exactly one failure reply mentioning Settings → AI and does not retry`.
  - `A04 429 on the final attempt posts one failure reply; earlier attempts post none`.
  - `A11 eight tool-only iterations post a loop_exhausted reply and persist pending approvals`.
  - `A04 failure reply text contains no provider body or key`: assert the stub's error body string is absent.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** In the handler's catch, call `classifyProviderError`. If the error is non-retryable or this is the last attempt (read the attempt number from the job record), call `postDeftyFailureReply` and return without rethrowing. Otherwise rethrow. The runner returns `{ exhausted: true }` at the iteration bound, and the handler persists pending actions before it checks for text.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `fix(defty): post one visible reply on terminal failure (A04, A11)`.

### Task 5.2: Replies are idempotent per trigger message

**Files:** `apps/api/src/lib/agent-action-proposals.ts:276`, `apps/api/src/workers/handlers/agent-reply.ts:1810-1880`. Test: `apps/api/test/defty-reply-idempotency.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - `A05 replaying the job after the reply commits yields one reply and one approval set`: run the handler twice with the same job data.
  - `A05 a thread-stats failure after commit does not cause a second reply`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Insert the reply under the advisory lock with the existence check. Move the post-commit stats and broadcast into a `try` that logs and does not rethrow.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `fix(defty): make replies idempotent per trigger message (A05)`.

### Task 5.3: Dispatch is durable and shared by UI and MCP

**Files:** `apps/api/src/routes/messages.ts:726-780`, `apps/api/src/lib/dispatch-agent-message.ts`, `apps/api/src/lib/mcp-tools/human.ts:2307-2411`. Test: `apps/api/test/defty-dispatch-parity.test.ts` (new).

**Interfaces:** Produces `dispatchDeftyIfAddressed(tx: DbExecutor, message: { id: string; org_id: string; space_id: string; user_id: string; content: string; thread_parent_id: string | null }): Promise<'enqueued' | 'not_addressed' | 'no_provider_reply_posted'>` in `dispatch-agent-message.ts`. It contains the Defty detection and provider check that currently live in `messages.ts`.

- [ ] **Step 1: Write failing tests:**
  - `A08 MCP message_post into the Defty DM enqueues one agent-reply job`.
  - `A08 MCP send_message mentioning Defty enqueues one job`.
  - `A07 enqueue failure rolls back the message insert`: stub the queue to throw inside the transaction and assert no message row.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Extract the code into `dispatchDeftyIfAddressed`, using the queue's transaction-executor support that `queues.ts` already exposes. Call it from `messages.ts` and from both MCP human tools, inside the same transaction as the message insert.
- [ ] **Step 4:** Run → PASS, plus `agent-mention-detection` and `ensure-defty-dm`.
- [ ] **Step 5: Commit** `fix(defty): durable, shared dispatch for UI and MCP messages (A07, A08)`.

### Task 5.4: Cancellation and chronology

**Files:** `apps/api/src/workers/handlers/agent-reply.ts:1239-1333, 1520`, `apps/api/src/lib/agent-llm.ts:138, 186, 224`. Test: `apps/api/test/defty-reply-cancellation.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - `A09 aborting the job signal before inference resolves prevents persistence`.
  - `A15 history for trigger M1 excludes M2 created after M1`.
  - `A10 a caller signal plus a stalled provider still times out`: use a fake timer and assert rejection.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Thread the worker `signal` into the handler and build `AbortSignal.any([jobSignal, AbortSignal.timeout(60_000)])`. Check `signal.aborted` immediately before persistence. In `agent-llm.ts`, use `AbortSignal.any([p.abortSignal, AbortSignal.timeout(60_000)])` when a caller signal exists. Bound the history queries with `lte(messages.created_at, trigger.created_at)`.
- [ ] **Step 4:** Run → PASS. Run the full Defty suite → PASS.
- [ ] **Step 5: Commit** `fix(defty): honour job cancellation and trigger-bounded history (A09, A10, A15)`.

---

## WP6 — Durable, truthful approvals and undo · Wave 3

Fixes C04–C11, C14, C15, E04, E06, E10. Codex lane: implement. The order is 6.1 → 6.4; each task consumes the previous one's outcome contract.

**Interfaces:**
- Produces: `agent_actions.result.execution = { outcome: 'succeeded' | 'failed' | 'executing'; error?: string; receipt_id?: string }`. This is the single source of truth for cards, confirmations and receipts. It needs no schema change: `result` is already JSON.

### Task 6.1: Execution state recovery and outcome contract (C06, C07, E04)

**Files:** `apps/api/src/routes/agent.ts:1442-1670`, `apps/api/src/lib/agent-actions.ts:1278-1300, 2937-2963`, `apps/api/src/lib/task-bundle.ts:182-258`, `apps/api/src/lib/agent-approval-resolver.ts:674-680, 959-975`. Test: `apps/api/test/agent-execution-recovery.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - `C07 an action stuck executing for more than 5 min is returned to pending by the expiry pass and no effect exists`.
  - `C06 a failed outcome stamp after task insert does not duplicate the task on re-approve`: inject a failure into the stamp.
  - `E04 resolver execution failure stores execution.outcome='failed'`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Commit the task bundle and the outcome stamp in one transaction. Make `create_task` idempotent on `action_id`: look for existing `task_activity` with `metadata.action_id` before inserting. Recover stale `executing` rows in the existing expiry pass.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `fix(agent): recoverable, idempotent native execution (C06, C07, E04)`.

### Task 6.2: Fresh policy, stale-proposal and race safety (C04, C05, C15)

**Files:** `apps/api/src/lib/agent-context.ts:130-137`, `apps/api/src/lib/mcp-tools.ts:135-194`, `apps/api/src/workers/handlers/agent-reply.ts:355-362`, `apps/api/src/lib/agent-actions.ts:1787-1806`, `apps/api/src/routes/agent.ts:1379-1432`, `apps/api/src/lib/attention.ts:688-701`. Test: `apps/api/test/agent-approval-freshness.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - `C04 an MCP tool re-tiered to full mid-turn creates a pending approval and makes zero provider calls`.
  - `C05 approving a wiki proposal after a human edit returns 409 CONFLICT and keeps the human content`.
  - `C15 when reject wins, reviewer history and attention record rejected`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Re-resolve the MCP tier before every invocation. Store `expected_version` with wiki proposals and update with `WHERE version = expected_version`. Write decision artifacts from the resolver's returned transition, not the route's snapshot.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `fix(agent): fresh MCP policy, versioned wiki approvals, race-safe decisions (C04, C05, C15)`.

### Task 6.3: Undo is honest (C08, C09, C10) and receipts are consistent (C11, E10)

**Files:** `apps/api/src/routes/agent.ts:1894-2010, 1542-1572`, `apps/api/src/lib/agent-actions.ts:3322-3394`. Test: `apps/api/test/agent-undo-correctness.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - `C08 undo of close_task reopens the task`.
  - `C08 undo of an unsupported action returns 422 UNDO_UNSUPPORTED and leaves undone_at null`.
  - `C09 undo after a later human status change returns 409 and keeps the human value`.
  - `C10 undo of create_task removes its subtasks`.
  - `C11 auto-executed create_task produces exactly one verifiable receipt`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Use an explicit `UNDOABLE_ACTIONS` map, including the `close_task` and `reopen_task` aliases. Compare current state with the recorded after-state before reverting. Reverse the recorded bundle in one transaction. Add one native terminal receipt hook in `executeAction`'s success path and set `execution.receipt_id`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `fix(agent): truthful undo and receipts for native writes (C08-C11)`.

### Task 6.4: Cards and confirmations show the real outcome (C14, E04, E06, E10)

**Files:** `apps/api/src/lib/agent-action-confirmation.ts:81`, `apps/api/src/routes/agent.ts:123-129`, `apps/web/src/components/agent-action-card.tsx:440, 519-612, 1160-1168`, `apps/web/src/lib/agent-action-presentation.ts:152-232`, `apps/web/src/app/(app)/dashboard/lib/shared.tsx:46`. Tests: `apps/api/test/agent-action-confirmation.test.ts` (extend), `apps/web/src/lib/agent-action-presentation.test.ts` (new or extend).

- [ ] **Step 1: Write failing tests:**
  - `C14 confirmation waits while a sibling is executing and names failed siblings`.
  - `E06 presentation of a task_update patch lists cleared assignee and due date`.
  - `E06 reminder presentation includes time and time zone`.
  - `E10 card offers View receipt only when execution.receipt_id exists`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Render from `execution.outcome`, so `failed` shows as red with the error and a 202 response shows as `executing`. Show every patch field, including removals, and the message body on dashboard approvals.
- [ ] **Step 4:** Run → PASS. Do a rendered check of a failed card and a combined-patch card at 1440×900 and 375×812.
- [ ] **Step 5: Commit** `fix(web): approval cards and confirmations reflect real outcomes (C14, E04, E06, E10)`.

---

## WP7 — Tool contracts and retrieval quality · Wave 3

Fixes B06/C12, B08, B10, B11, B12, B13, B19. Codex lane: implement.

### Task 7.1: Every advertised tool dispatches

**Files:** `apps/api/src/lib/agent-context.ts` (add `read_canvas`, `search_notes`, `read_note` cases that call the implementations currently inside `executeAction` at `agent-actions.ts:2553, 2737, 2774`, with WP2's visibility rules), `apps/api/src/lib/agent-runner.ts:246, 242`. Test: `apps/api/test/agent-tool-dispatch-coverage.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - `B06 every AGENT_TOOLS read name reaches a handler`: iterate `AGENT_TOOLS` minus `ACTION_TOOLS`, call `executeToolCall` with minimal params, and assert the result is never `/^Unknown tool/`.
  - `B08 channel and participant names never appear in the system prompt`: capture the request and assert a hostile space name is only inside the `<workspace_context>` user content.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add the three cases. Move the `#${sc.name}` and participant lists from `systemPrompt` into `buildUntrustedWorkspaceContext`.
- [ ] **Step 4:** Run → PASS, plus `agent-system-prompt` and `agent-untrusted-context`.
- [ ] **Step 5: Commit** `fix(defty): dispatch all advertised read tools; keep names out of system prompt (B06, B08)`.

### Task 7.2: Retrieval finds what exists

**Files:** `apps/api/src/lib/retrieve-context.ts:74, 316, 661, 892, 1057-1071`, `apps/api/src/lib/embed.ts:102-117`, `apps/api/src/lib/agent-context.ts:1100, 1491`, `apps/api/src/lib/agent-runner.ts:257`. Test: `apps/api/test/agent-context-retrieve-context.test.ts` (extend).

- [ ] **Step 1: Write failing tests:**
  - `B11 queries 预算, 東京, बजट reach the wiki branch`.
  - `B10 search_knowledge with space_name returns the page in that space`.
  - `B12 a task with disjoint vocabulary and identical embedding is returned`.
  - `B13 a stalled embed fetch falls back to lexical within 3 s`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Normalise with `/[^\p{L}\p{N}\s]/gu` and delete the duplicate normalisers. Pass `space_id` into retrieval and expose it on `ContextResult`. Union bounded vector candidates (`ORDER BY embedding <=> $q LIMIT 20`, same auth predicates). Give embedding fetches `AbortSignal.timeout(3000)` and fall back to lexical.
- [ ] **Step 4:** Run → PASS. Run the full Defty suite → PASS.
- [ ] **Step 5: Commit** `fix(retrieval): unicode queries, space filters, vector candidates, embed deadline (B10-B13)`.

### Task 7.3: Defty's manuals describe its real job and real tools

The templates (`soul.md`, `user.md`, `agents.md`, `tools.md`) cast Defty as a "superintendent/captain" that watches over the crew and the agent employees. That framing is outside its mandate. They also reference tools that do not exist (B19).

Defty's mandate:
- answer questions from workspace context the asker can see
- draft, create and update tasks, messages, wiki pages and notes **when asked**, through approval cards where policy requires
- remember and capture durable decisions
- run the standup and meeting-prep automations

Chat-to-task happens **only when someone asks Defty**. Passive task extraction is intentionally off (`observe-chat-message.ts:277-290`), so do not re-enable it.

**Files:** `apps/api/src/scripts/templates/defty/{soul,user,agents,tools}.md`, `docs/AGENT-VISION.md` (Defty section), `FEATURES.md` (Defty section, if it implies otherwise). Test: `apps/api/test/defty-template-contract.test.ts` (new).

- [ ] **Step 1: Write failing tests:**
  - `B19 every tool name referenced in defty templates is registered`. It parses backticked `name(` tokens and compares them with the registry exported from `lib/mcp-tools/index.ts`.
  - `defty templates do not assign supervision of agent employees`. It asserts the templates contain none of `superintendent`, `captain`, `crew`, `manage_agent_employee`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Rewrite the templates around the mandate above, using current tool names and parameters (`due_date`, `content`, `caller_employee_slug`). Update the Defty section of `docs/AGENT-VISION.md` to match.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `docs(defty): align Defty persona and manuals with its mandate and real tools (B19)`.

---

## WP8 — Capture completeness and automation idempotency · Wave 2

Fixes B14/D07, B15/D08, B16, D05, D09, D10, D11, D12, D13. Codex lane: implement.

### Task 8.1: Every message is considered once, after it settles

**Files:** `apps/api/src/workers/handlers/chat-knowledge-batch.ts:15-16, 509-568`, `apps/api/src/workers/index.ts:41`. Test: `apps/api/test/chat-knowledge-batch-window.test.ts` (new, fake clock).

- [ ] **Step 1: Write failing tests:**
  - `D07 a message at 09:53 is considered by the 10:00 or the 10:30 run`.
  - `D05 an episode whose latest message is inside the quiet period is deferred, not captured without its correction`.
  - `D07 900 eligible messages are all considered across runs`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Set lookback to `interval + quiet + 10 min` (48 min). Fetch the context first, then drop episodes whose last message is newer than `now - quiet`. Paginate past 800 with a `created_at, id` keyset within the window. Capture dedupe keys already prevent double writes, so keep them.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `fix(capture): close scan gaps and defer unsettled episodes (D05, D07)`.

### Task 8.2: Generic decisions qualify; corrections win

**Files:** `chat-knowledge-batch.ts:103-105, 267-269, 313-324, 392-397`. Test: extend `chat-knowledge-batch-window.test.ts`, or create `chat-knowledge-batch-quality.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - `D08 "Decision: every employee must enable two-factor authentication" is captured`.
  - `B16 in fallback mode, "Correction: delivery is Tuesday" becomes the summary over "delivery is Monday"`.
  - Existing social-noise negatives still pass.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Remove `hasDomainWorkSignal` as an acceptance gate (it may stay as a ranking hint). In the fallback, prefer the last durable item, and an explicit `correction|actually|update:` item over earlier ones.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `fix(capture): accept generic decisions; prefer corrections (D08, B16)`.

### Task 8.3: Automations deliver once, cite sources, and respect cost and org day

**Files:** `apps/api/src/lib/standup-automation.ts:239-283`, `apps/api/src/lib/meeting-prep-automation.ts:279-302`, `apps/api/src/lib/automation-runs.ts`, `apps/api/src/lib/automation-synthesis.ts:5-43`, `apps/api/src/routes/dashboard.ts:17-18, 314-315`, `apps/api/src/lib/defty-capture.ts:277, 578, 618`, `apps/api/src/workers/handlers/observe-chat-message.ts:443`, `apps/api/src/lib/classifier.ts`. Tests: `apps/api/test/automation-delivery-idempotency.test.ts` (new); extend `defty-capture-dedupe-update.test.ts`.

- [ ] **Step 1: Write failing tests:**
  - `D09 reclaiming a delivered-but-unmarked standup run posts no second message`.
  - `D13 synthesis items with empty source_ids are rejected`.
  - `D10 dashboard shows today's standup by org date_key across server midnight`.
  - `D11 exact-title duplicate beyond the 250 newest pages is found`.
  - `D12 with DEFT_PASSIVE_CLASSIFY_DAILY_LIMIT=2, 10 messages make 2 provider calls`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Write output, message and run completion in one transaction, and emit sockets after commit. Use `source_ids: z.array(...).min(1)` with no default. Look up the dashboard standup by `date_key`. Run an exact `lower(title)` lookup before the bounded similarity scan. Add a per-org daily counter for passive classification (env `DEFT_PASSIVE_CLASSIFY_DAILY_LIMIT`, default 500, held in the existing `automation_runs` or rate-limit storage — no new table). When it is exhausted, use the deterministic classifier.
- [ ] **Step 4:** Run → PASS. Run the full Defty suite → PASS.
- [ ] **Step 5: Commit** `fix(automation): idempotent delivery, enforced citations, org-day lookup, passive budget (D09-D13)`.

---

## WP9 — Web truthfulness (outside approval cards) · Wave 1

Fixes E03, E05, E08 copy (D2), E09, E11, E12, E13, E14, E15, plus the signup raw-JSON error. Codex lane: implement. Follow `apps/web/AGENTS.md` and consult the installed Next.js docs before relying on framework behaviour.

### Task 9.1: Settings never lie

**Files:** `apps/web/src/app/(app)/settings/ai/page.tsx:54-104, 470`, `apps/web/src/app/(app)/settings/agent/page.tsx:65, 90, 185-189, 339-343`. Tests: `apps/web/src/lib/*.test.ts` for any extracted pure helpers.

- [ ] **Step 1: Write failing tests** for the extracted pure helpers:
  - `E03 buildReasonRoutePatch(existing, {provider, model}) keeps existing baseUrl when provider is unchanged`.
  - `E05 trust save: displayed value commits only after a 2xx response`. If no pure seam exists, use a rendered check.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:**
  - AI page: use `try/catch/finally`, show an error with Retry, and merge the existing route fields into the patch.
  - Agent page: show an explicit loading or unknown state, check the response status, commit the selection on success, serialise saves, and show the error. Hide or disable the controls for non-admins after WP2.3.
  - Copy (D2): describe trust as governing background and automation runs, and say that chat writes always ask for approval.
- [ ] **Step 4:** Run → PASS. Rendered check at both sizes, with the API stopped → the error and Retry are visible.
- [ ] **Step 5: Commit** `fix(web): settings save truthfully and preserve AI endpoints (E03, E05, E08, E14)`.

### Task 9.2: Chat states are distinguishable and recoverable

**Files:** `apps/web/src/components/space-chat.tsx:684, 696, 900-932, 1458-1462`, `thread-panel.tsx:247, 285-317, 486-489`, `apps/web/src/lib/agent-approval-copy.ts:22-24`, `apps/web/src/lib/space-socket.ts:10`. Test: `apps/web/src/lib/agent-approval-copy.test.ts` (new or extend).

- [ ] **Step 1: Write the failing test** `E09 normalization leaves a human message containing "approve or reject" unchanged`. The function now takes the message's author kind and its own approval link.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:**
  - Apply normalisation only to agent-authored messages that have an attached approval.
  - Separate loading, empty and failed states, and do not clear messages before a successful load.
  - Keep the last approvals when a poll fails.
  - On socket reconnect, refetch the active space and thread and dedupe by id (E15).
- [ ] **Step 4:** Run → PASS. Rendered check: history failure shows an error, not "This is the start…"; after a disconnect and reconnect a pending reply appears exactly once.
- [ ] **Step 5: Commit** `fix(web): honest chat load states, reconnect refetch, scoped approval copy (E09, E13, E15)`.

### Task 9.3: Entry points and keyboard

**Files:** `apps/web/src/components/rich-composer.tsx:248, 486`, `mention-autocomplete.tsx:92-117`, `apps/web/src/lib/quick-actions.ts:136`, `apps/web/src/app/(app)/layout.tsx:433-446`, `dashboard/starter-cards.tsx:140-145`, the signup page and auth client.

- [ ] **Step 1: Write the failing test** `E12 openDeftyDm returns {ok:false, error} when member lookup fails`, on the extracted helper.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:**
  - Intercept Enter and Tab only while autocomplete is open with a selectable item.
  - Return and await a result from the quick action. Dismiss the starter card only after navigation succeeds, and show a toast on error.
  - The auth client reads `res.text()` and parses JSON only when `content-type` is JSON; otherwise it shows "Server error — try again".
- [ ] **Step 4:** Run → PASS. Rendered keyboard check: type `@defty`, press Escape, press Enter, and the message sends once.
- [ ] **Step 5: Commit** `fix(web): composer Enter after Escape, Ask Defty errors, non-JSON auth errors (E11, E12)`.

---

## Final verification (after all packages merge)

- [ ] Full API suite: `DEFT_TEST_DATABASE_URL=… pnpm --filter @deft/api test` (all files, not only Defty) → no new failures relative to `master`.
- [ ] `pnpm typecheck` → clean.
- [ ] Live smoke on a disposable stack (D4) with a real provider key:
  1. Ask Defty a question in its DM.
  2. Mention Defty in a channel.
  3. Set a wrong key and ask again → exactly one failure reply.
  4. Ask about a private-space canary as a non-member → canary absent.
  5. Approve, reject and undo a task.
  6. Post a "do not save" decision → no capture.
  7. Rendered checks at 1440×900 and 375×812.
- [ ] Update `docs/current-limitations.md` for anything deliberately deferred (B09 migration, D2 policy).

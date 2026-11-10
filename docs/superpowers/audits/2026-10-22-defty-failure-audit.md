# Defty Failure Audit

Reviewed October 22, 2026 at `master` `2d478aee`. Scope: Defty, the built-in workspace agent — reply pipeline, context and retrieval, tools/actions/approvals, passive capture and automations, and its web surfaces.

Fix plan: [`docs/superpowers/plans/2026-10-22-defty-hardening.md`](../plans/2026-10-22-defty-hardening.md).

## Method

- Five parallel **read-only Codex** audits (one per subsystem), using the briefs in [`2026-10-22-defty-failure-audit/`](2026-10-22-defty-failure-audit/) (`brief-*.txt`). Full reports with line-level evidence: `codex-*.md` in the same folder.
- Claude re-read the source for the highest-severity claims (marked **Verified** below) before accepting them.
- Ran the existing Defty-related API suite (all `apps/api/test` files matching agent/defty/capture/approval/mcp-/memory/receipt/observe/task-extract/blocked/standup/meeting-prep/classifier/retrieve/dispatch/mention/work-intent) against a disposable pgvector database: **506 / 506 pass**. Every failure below is therefore a gap the current tests do not cover.
- A live probe was attempted against the local `deftv03test` stack; its Postgres container has been exited for two months, so no live Defty run was possible. No provider-backed reply was exercised.

## Headline

Defty's governed-write core (atomic approval claims, employee identity binding, module authorization) is solid. It fails in three systematic ways:

1. **Read paths skip the visibility rules the normal API enforces.** Defty's own tools and automations query by `org_id` only, so private wiki pages, DMs, restricted tasks, other users' calendars and private action payloads reach the model, the reply, standups and the dashboard.
2. **Failures are silent or misreported.** Provider errors, loop exhaustion, enqueue failures and MCP-posted messages leave the user with no reply and no explanation; failed approvals later render as success; undo reports success for actions it never reversed.
3. **Passive capture is destructive and leaky.** Auto-approved "refinements" replace whole wiki pages with one episode, explicit "do not save" is ignored by the batch worker, and the scan window permanently skips messages.

No P0 was established. 30 P1 and ~40 P2 distinct defects after de-duplication.

## Environment defects found during the audit

- `packages/shared/node_modules/{zod,tsx,typescript,@types/node}` were symlinks into a deleted Codex worktree (`Codex/2026-09-14/lo-2/...`), so every API test importing `@deft/shared` failed with `ERR_MODULE_NOT_FOUND`. `pnpm install --frozen-lockfile` reported "Already up to date" and did not repair them; they were recreated as junctions into `node_modules/.pnpm`. Codex worktrees that run `pnpm install` against the main checkout can recur this.
- Signup on the local stack surfaced the raw client error `Unexpected token 'I', "Internal S"... is not valid JSON` when the API returned a plain-text 500 (root cause: the stack's database was down). The web auth client should not parse non-JSON error bodies as JSON.

## P1 findings

IDs map to the raw Codex reports (A = reply pipeline, B = context, C = tools/actions, D = capture, E = frontend). Duplicates are merged under the first ID.

### Privacy and authorization

| ID | Finding | Evidence | Status |
|---|---|---|---|
| A01 | Legacy streaming `POST /api/agent/conversations/:id/messages` inserts into any space ID and sends its full history to the model with no membership check | `routes/agent.ts:919-931`, history `:423-427` | **Verified** |
| A02 | `DELETE /api/agent/conversations/:id` lets any member archive any space they belong to (incl. `#general`) and soft-delete its messages | `routes/agent.ts:797-817` | Codex-traced |
| B01 (=A03) | Private wiki pages reach Defty: runner exact-match lacks `visibleWikiPageCondition`; several retrieval calls omit `user_id`, which disables the visibility predicate; `wiki_read` unchecked | `agent-runner.ts:279-309`, `retrieve-context.ts:660`, `agent-context.ts:1082,1466,1945,2011` | Codex-traced |
| B02 | `search_blockers` returns DM and private-space messages to any member | `agent-context.ts:1387-1395` (org/deleted/time/text only) | **Verified** |
| B03 | Dependency and project-progress tools accept foreign-org task UUIDs and return restricted neighbours | `agent-context.ts:1255-1321, 858-875` | Codex-traced |
| B04 | `check_calendar` returns every org member's personal events; the calendar API filters by `user_id` | `agent-context.ts:591-610` vs `routes/calendar.ts:75-78` | **Verified** |
| A06/B07 | Memory recall is not org-scoped, and channel mentions pass `conversationId = undefined`, so conversation-scoped recall returns memories from other conversations | `agent-context.ts:937-945`, `agent-runner.ts:570-576`, `routes/agent.ts:524` | **Verified** (recall starts from `user_id` only) |
| C01 | Any same-org member can undo another user's private Defty action (e.g. delete their private-space message) | `routes/agent.ts:1878-1981`; `visibleCaptureActionSql` admits all non-capture sources at `:178-181` | **Verified** (predicate) |
| C02/E01 | `/api/agent/actions` and the dashboard activity feed return raw `params`/`result` of every non-module action org-wide | `routes/agent.ts:2020-2027`, `routes/dashboard.ts:894-908`, `module-action-visibility.ts:81-84` | **Verified** (predicate) |
| C03 | Native executors write wiki/canvas/thread/note targets without visibility or membership checks | `agent-actions.ts:1791-1806, 2600-2625, 2674-2700, 2804-2828` | Codex-traced |
| E02 | Any member can change the org-wide trust level (`PATCH /api/agent/settings` has no role check) | `routes/agent.ts:2122-2135` | **Verified** |
| D01 | Daily standups include restricted task titles/owners | `standup-automation.ts:60-72, 88, 109` (no `unrestrictedTaskCondition`) | **Verified** |
| D04 | Standup is broadcast to `org:<id>` socket room, reaching non-members of the target channel | `standup-automation.ts:269` | Codex-traced |
| C04 | MCP tools classified as read at turn start execute without re-checking a tier raised mid-turn | `routes/agent.ts:459-462`, `agent-context.ts:130-137` | Codex-traced |
| E03 | Editing the reasoning model in Settings → AI drops a custom `baseUrl`, silently routing a local endpoint to hosted OpenAI | `settings/ai/page.tsx:470`, `org-ai-config.ts:306-307,412` | Codex-traced |

### Defty not answering, or answering wrongly

| ID | Finding | Evidence | Status |
|---|---|---|---|
| A04/E07 | Bad key, missing model, 429 or timeout: the job retries 3x and then fails with no reply and no visible state | `agent-reply.ts:1891-1893`, `workers/index.ts:405-413`, `messages.ts:726` | **Verified** (rethrow only) |
| A05 | Any error after the reply commits (stats query, crash before queue ack) re-runs the job and posts a second answer | `agent-action-proposals.ts:276`, `agent-reply.ts:1851-1880` | Codex-traced |
| B06/C12 | `read_canvas`, `search_notes`, `read_note` are advertised to the model but dispatch to `Unknown tool` | `agent-tools.ts:727,774,814`; `agent-context.ts:2358` | **Verified** |
| B05/D03 | Passive capture auto-approves "refinements" that replace an entire wiki page body with one episode | `chat-knowledge-batch.ts:488,605-606`, `defty-capture.ts:628-708`, `wiki-create.ts:512-518` | Codex-traced |
| D02 | Batch capture ignores "do not save / keep this in chat" (observer honours it, batch does not) and runs without a provider | `chat-knowledge-batch.ts:527-544,605` vs `chat-observation.ts:16-34` | Codex-traced |
| C05 | Approving a stale wiki proposal overwrites edits made after it was drafted (no version precondition) | `agent-reply.ts:355-362`, `agent-actions.ts:1787-1806` | Codex-traced |
| C06 | Post-commit failure to stamp a `create_task` outcome makes the action retryable and duplicates the task bundle | `task-bundle.ts:182-258`, `routes/agent.ts:1657-1670` | Plausible (needs fault injection) |
| C07 | A crash between claiming approval and executing leaves the action `executing` forever; retries return 202 | `routes/agent.ts:1442-1470` | Codex-traced |
| E04 | An approved-but-failed action renders as green "Task updated" after refresh | `agent-approval-resolver.ts:959-975`, `agent-action-card.tsx:519,603-612` | Codex-traced |
| E05 | Trust-level changes update the UI before the PATCH and swallow failures | `settings/agent/page.tsx:339-343` | Codex-traced |
| E06 | Approval cards omit parts of the write (patch removals, assignee clears, reminder time, message body on dashboard) | `agent-action-card.tsx:440`, `agent-action-presentation.ts:152-232`, `dashboard/lib/shared.tsx:46` | Codex-traced |

## P2 findings (grouped)

- **Reply lifecycle:** enqueue failure after message commit loses the reply (A07); MCP `message_post`/`send_message` to Defty never wakes it (A08); worker timeout/lease loss does not abort the handler, which still publishes (A09); provider deadline replaced by caller signal on streaming (A10); 8-iteration tool loop can end with empty text, which skips the reply and drops pending approvals (A11); legacy stream leaves unmatched tool calls after reject (A12), unbounded history (A13), wrong employee identity across orgs (A14); deferred turns include later messages before their trigger (A15); replies completed while the socket was disconnected are not refetched (E15).
- **Context quality:** channel and participant names are interpolated into the system prompt (B08); user/org memory upsert conflict target includes a nullable column, so updates insert duplicates (B09 — needs a migration); `space_name` filters compare a field that does not exist and drop all results (B10); non-Latin queries are stripped to empty and skip retrieval (B11); vector similarity only reorders lexical hits (B12); stalled embedding endpoint blocks retrieval with no timeout (B13); calendar day bounds use server timezone (B17); unknown assignee/project filters silently broaden results (B18); shipped Defty manuals reference tools and argument names that do not exist (B19).
- **Actions:** undo marks unsupported actions (e.g. `close_task`) undone without reversing them (C08), overwrites later human edits (C09), leaves subtasks of an undone task (C10); ordinary native writes create no receipt while cards offer "View receipt" (C11/E10); shared-space note promotion passes proposal validation but always fails execution (C13); "Done – completed N actions" counts executing/failed siblings (C14); approve/reject race records the losing decision (C15).
- **Capture and automations:** 35-minute lookback minus 8-minute quiet period every 30 minutes leaves a permanent 3-minute gap, plus an 800-message cap with no cursor (B14/D07); hard-coded agriculture/logistics vocabulary rejects generic workplace decisions (B15/D08); fallback picks the first decision, not the correction (B16); the quiet cutoff hides a recent correction while capturing the decision it withdrew (D05); invited private-space capture always fails because the Defty employee row is `is_deleted: true` (D06); standup/meeting-prep retries duplicate posts and notifications (D09); dashboard looks up today's standup by server midnight (D10); dedupe scans only 250 pages (D11); passive classification has no spend ceiling (D12); "grounded" synthesis accepts items with no sources (D13).
- **Web:** Autonomous trust has no effect on chat — chat runs in `chat_mention` mode, which never loads trust (E08, **Verified** at `agent-runner.ts:215-224`); approval-copy normalisation rewrites unrelated human messages (E09); Escape then Enter after a mention does not send (E11); "Ask Defty" can silently do nothing and dismiss onboarding (E12); failed history/approval loads render as an empty conversation (E13); AI settings spins forever if the first load fails (E14).

## Open questions for runtime verification

- Provider-specific behaviour for unmatched tool calls, refusals and incomplete Responses-API outputs (A12, Codex notes on `agent-llm.ts:194-198, 413-432`).
- How much private content has already reached provider requests or stored replies via B01–B04, and how many wiki pages were shortened by B05 (recoverable from `previous_content`).
- C06 and C07 need fault injection; E15 needs a controlled socket disconnect.
- Whether any deployment or external client still depends on the legacy `/api/agent/conversations*` routes. No caller exists in `apps/web`, `packages`, or scripts — only `apps/api/test/agent-actions-routes.test.ts:827`.

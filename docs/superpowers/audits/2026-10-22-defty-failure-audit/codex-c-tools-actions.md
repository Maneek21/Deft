Found **15 defects: seven P1 and eight P2**. Fourteen are confirmed by source tracing; one requires fault injection. No P0 established.

No files were modified, server started, or database accessed. Focused pure tests could not start: pnpm was missing from PATH, and the installed executable returned **“Access is denied.”** Existing database-backed tests were left unrun.

Paths below are relative to the repository root.

**C01 — P1 — Workspace members can undo another user’s private Defty actions**

- **Evidence:** `apps/api/src/routes/agent.ts:1878–1882` authorizes undo using organization plus `visibleActionSql(user)`. At line 181, ordinary actions pass through: `source IS DISTINCT FROM 'defty_capture'`. Line 1981 then executes `db.update(messages).set({ is_deleted: true }).where(eq(messages.id, messageId))`.
- **Failure scenario:** A asks Defty to post in a private space. Same-organization member B obtains the action ID from `/api/agent/actions` and calls its undo endpoint. B deletes the private message despite lacking space membership or authorship. Task deletion and status/assignment reversal have equivalent exposure.
- **Confidence:** **CONFIRMED** — authorization through mutation traced.
- **Fix sketch:** Require undo-specific authority and current target access; organization-scope the mutation itself. **Test:** B’s undo changes neither resource nor `undone_at`; authorized A succeeds; foreign-organization requests fail.

**C02 — P1 — Action history exposes private action payloads organization-wide**

- **Evidence:** `apps/api/src/routes/agent.ts:2020–2027` returns `SELECT agent_actions.*` under `visibleActionSql(user)`. Its private-source checks apply only to `defty_capture` at line 181. `apps/api/src/lib/module-action-visibility.ts:81–83` permits non-module actions. Ordinary streaming actions store raw parameters at `apps/api/src/lib/agent-stream-loop.ts:313–324`; automatic actions use `source: 'auto_execute'` at line 210.
- **Failure scenario:** A creates a private note or submits a private Defty request containing confidential text. B requests `/api/agent/actions` and receives the parameters and recorded states without access to A’s conversation or resource.
- **Confidence:** **CONFIRMED**.
- **Fix sketch:** Apply source-conversation and target-resource visibility to every action projection. Hide or redact rows whose visibility cannot be established. **Test:** Private note/message actions remain inspectable by their requester but reveal no payload to an unrelated member.

**C03 — P1 — Native executors bypass private wiki and space permissions**

- **Evidence:** `apps/api/src/lib/agent-actions.ts:1791` selects wiki pages using organization, slug and deletion state only; line 1806 performs `db.update(wikiPages).set(updates).where(eq(wikiPages.id, existing.id))`. The normal wiki route instead requires `visibleWikiPageCondition(user.id)` at `apps/api/src/routes/wiki.ts:975–981`. Similar missing membership checks exist for canvas writes at `agent-actions.ts:2600–2625`, thread replies at `2674–2700`, and note space IDs at `2804–2828`.
- **Failure scenario:** With Standard trust, A asks Defty to replace B’s personal wiki page using its known slug. The quick-tier action executes through `agent-stream-loop.ts:199–213`, overwriting content A cannot edit through the normal API.
- **Confidence:** **CONFIRMED**. Mention-time checks protect some cases; direct streaming execution reaches the unchecked executor.
- **Fix sketch:** Enforce existing visibility and membership predicates inside the authoritative executor, including linked targets and supplied space IDs. **Test:** Direct and approved execution cannot modify another user’s private page or a nonmember space; authorized controls succeed.

**C04 — P1 — MCP calls classified as reads bypass stricter policy applied during the model turn**

- **Evidence:** `apps/api/src/routes/agent.ts:459–462` builds the action set once: `if (t.isWrite || t.approvalTierMapped !== 'auto' || isDestructiveAction(t.name))`. Non-actions execute immediately at `apps/api/src/lib/agent-stream-loop.ts:333–338`. `apps/api/src/lib/agent-context.ts:130–137` calls `mcpClientManager.executeTool(...)`; `apps/api/src/lib/mcp-tools.ts:135–194` checks availability and disabled/enabled policy, but not current approval tier. The freshness check at `agent-actions.ts:3053–3070` is bypassed.
- **Failure scenario:** Discovery classifies an assigned MCP tool as read/auto. An admin changes its tier to full while the model is thinking. Its eventual call still follows the cached read branch and executes without approval or an action receipt.
- **Confidence:** **CONFIRMED**.
- **Fix sketch:** Resolve current classification before every MCP invocation, including presumed reads, and reject unregistered names. **Test:** Change read/auto to full between discovery and dispatch; assert zero provider calls and a pending approval.

**C05 — P1 — Approving a stale wiki proposal overwrites intervening edits**

- **Evidence:** `apps/api/src/workers/handlers/agent-reply.ts:355–362` freezes `mergeWikiUpdateContent(existingPage.content, ...)` and `resolved_wiki_page_id` into proposal parameters without a version precondition. `apps/api/src/lib/agent-actions.ts:1787–1806` subsequently resolves by slug and unconditionally writes the frozen content.
- **Failure scenario:** Defty drafts an append against wiki version 3. A human edits the page to version 4 before approval. Approval replaces version 4 with the version-3-based proposal, silently losing the human edit. The executor also ignores the frozen page ID if the slug now identifies another page.
- **Confidence:** **CONFIRMED**.
- **Fix sketch:** Bind the proposal to page ID and expected version; conditionally update that version or require fresh review. **Test:** An intervening edit or recycled slug produces a conflict and preserves current content.

**C06 — P1 — A post-commit action-record failure can duplicate task creation on retry**

- **Evidence:** `apps/api/src/lib/task-bundle.ts:182–258` commits task creation before the separate action-record update at `apps/api/src/lib/agent-actions.ts:1278–1300`. The catch at `2937–2963` returns failure. `apps/api/src/routes/agent.ts:1657–1670` then restores `approval_status: 'pending'` with `retryable: true`. Task creation uses `actionId` for activity attribution at `task-bundle.ts:252`, without deduplicating the mutation.
- **Failure scenario:** Task creation commits; a transient failure prevents its outcome stamp; database access recovers for failure handling. The action becomes retryable. Approving again creates another numbered task bundle.
- **Confidence:** **PLAUSIBLE** — the complete failure path is traced; the precise post-commit fault needs injection.
- **Fix sketch:** Commit native effects and their durable action outcome together, with replay protection keyed by action ID. **Test:** Fail only the first outcome stamp, retry approval, and assert one task bundle and an accurate terminal outcome.

**C07 — P1 — An interrupted approval can remain “executing” permanently**

- **Evidence:** `apps/api/src/routes/agent.ts:1458–1470` commits `approval_status: 'approved'` and `lifecycle_state: 'executing'` before calling the executor at line 1511. Retries at `1442–1445` return HTTP 202 whenever that marker remains. Pending listings require `approval_status: 'pending'` at line 1079. There is no native-action recovery corresponding to the module recovery in `agent-approval-resolver.ts:667–679`.
- **Failure scenario:** The API restarts after claiming approval but before execution. No task/message is created; the card leaves pending approvals; every retry says execution is already in progress.
- **Confidence:** **CONFIRMED**.
- **Fix sketch:** Add recoverable execution ownership/state, backed by native mutation idempotency. **Test:** Interrupt immediately before mutation and after mutation but before outcome stamping; recovery must reach a truthful terminal state with exactly one effect.

**C08 — P2 — Undo reports success for actions it never reverses**

- **Evidence:** `apps/api/src/routes/agent.ts:1894–1996` handles only four action names and has no rejecting default. Lines `2006–2010` unconditionally stamp `undone_at` and return `{ success: true }`. `close_task` and `reopen_task` are normalized only locally during execution at `apps/api/src/lib/agent-actions.ts:1056–1061`.
- **Failure scenario:** Defty closes a task. Undo receives the stored `close_task` name, matches no case, leaves the task closed and marks the action undone. Due-date, priority, note, wiki and MCP actions also fall through.
- **Confidence:** **CONFIRMED**.
- **Fix sketch:** Define supported undo actions explicitly; implement aliases and reject unsupported actions before stamping state. **Test:** Close/reopen restores prior status; unsupported undo returns a structured error without changing `undone_at`.

**C09 — P2 — Undo overwrites later human changes**

- **Evidence:** `apps/api/src/routes/agent.ts:1924` writes `status: oldStatus` by task ID without checking current state. Line 1953 does the same for assignee. Recorded after-state is used for logging, not concurrency control.
- **Failure scenario:** Task changes from backlog → Defty’s in-progress → human’s done. Undo resets it to backlog, erasing the human’s later decision.
- **Confidence:** **CONFIRMED**.
- **Fix sketch:** Compare current state/revision with the recorded after-state and transactionally claim undo. Return a conflict when changed. **Test:** Intervening status/assignment changes survive; concurrent undo creates one inverse operation and activity record.

**C10 — P2 — Undoing task creation leaves its subtasks active**

- **Evidence:** `apps/api/src/lib/task-bundle.ts:214–231` creates child tasks with `parent_task_id: parent.id`. `apps/api/src/lib/agent-actions.ts:1285,1296` records those subtasks. Undo at `apps/api/src/routes/agent.ts:1896–1898` deletes only `result.task_id`.
- **Failure scenario:** Defty creates a parent and two subtasks. Undo deletes the parent while both assigned subtasks remain active.
- **Confidence:** **CONFIRMED**.
- **Fix sketch:** Reverse the exact recorded bundle transactionally, with safeguards for later edits. **Test:** Parent and original children are reversed; unrelated tasks and later unrelated descendants remain untouched.

**C11 — P2 — Ordinary native Defty writes skip signed receipt creation**

- **Evidence:** Successful manual approval generates receipts only inside the special-action whitelist at `apps/api/src/routes/agent.ts:1542–1546`. Direct execution at `apps/api/src/lib/agent-actions.ts:3322–3394` generates receipts only for module mutations/task links, then returns. Ordinary `executeAction` execution has no receipt hook.
- **Failure scenario:** A normal Defty `create_task` or `post_message` succeeds through automatic execution or manual approval, but no signed receipt exists even with healthy receipt storage.
- **Confidence:** **CONFIRMED**.
- **Fix sketch:** Add a common native terminal receipt hook with proposer, approver and execution-outcome attribution. **Test:** Automatic execution, manual approval and repeated approval each leave exactly one verifiable receipt.

**C12 — P2 — Advertised canvas and note read tools always dispatch to “Unknown tool”**

- **Evidence:** `apps/api/src/lib/agent-tools.ts:727,774,814` advertises `read_canvas`, `search_notes` and `read_note`. They are absent from `ACTION_TOOLS` at `886–926`, so dispatch uses `executeToolCall`. That dispatcher’s fallback at `apps/api/src/lib/agent-context.ts:2358–2359` returns `Unknown tool: ${toolName}`. Their implementations instead reside inside `executeAction` at `agent-actions.ts:2553,2737,2774`.
- **Failure scenario:** A user asks Defty to read a known note or channel canvas. The model selects the advertised tool and receives an unknown-tool error.
- **Confidence:** **CONFIRMED**.
- **Fix sketch:** Route these implementations through the read dispatcher with authoritative visibility checks. **Test:** Invoke each advertised name through normal dispatch; visible resources succeed and inaccessible resources fail cleanly.

**C13 — P2 — Shared-space note promotion passes proposal validation but cannot execute**

- **Evidence:** `apps/api/src/workers/handlers/agent-reply.ts:396–402` accepts a note when `visibility = 'space'` and the requester is a space member. The executor at `apps/api/src/lib/agent-actions.ts:2868–2873` permits only `notes.user_id = userId OR notes.visibility = 'org'`.
- **Failure scenario:** A requests promotion of another member’s note shared in their common space. Defty creates a valid approval card. Every approval fails with “Note not found or not visible to caller” and returns the proposal to pending.
- **Confidence:** **CONFIRMED**.
- **Fix sketch:** Use one visibility predicate for proposal resolution and execution, rechecking current membership at execution. **Test:** A member can promote the shared note; removing membership before approval prevents promotion.

**C14 — P2 — Completion messages claim unfinished or failed sibling actions succeeded**

- **Evidence:** `apps/api/src/routes/agent.ts:123–129` checks only for pending siblings, then formats every approved sibling. Native actions become approved while still executing at line 1463. Resolver execution failures also retain approved status with an error at `apps/api/src/lib/agent-approval-resolver.ts:959–969`. The formatter says `Done - completed ${summaries.length} approved actions` at `agent-action-confirmation.ts:81`.
- **Failure scenario:** Two sibling approvals execute concurrently. The first succeeds while the second remains executing. Defty announces both completed; the second can subsequently fail. A failed resolver action can likewise be described as a created task.
- **Confidence:** **CONFIRMED**.
- **Fix sketch:** Build confirmation from actual execution outcomes; wait for in-flight siblings and report failures explicitly. **Test:** Suspend one sibling, complete another, then fail the suspended one; no premature or false success message appears.

**C15 — P2 — An approve/reject race records the losing approval as the decision**

- **Evidence:** `apps/api/src/routes/agent.ts:1379–1387` reads a pending snapshot before invoking the resolver. The resolver can return `{ status: 'rejected', message: 'already rejected' }` at `agent-approval-resolver.ts:682–687`. The route excludes only errors, then records `decision: 'approved'` at `agent.ts:1408–1414` and resolves Attention as approved at line 1432. `apps/api/src/lib/attention.ts:688–701` unconditionally upserts the supplied decision.
- **Failure scenario:** Approve reads pending; concurrent reject wins before the approval resolver reads the row. The response/action says rejected, while reviewer history—and potentially Attention—says approved.
- **Confidence:** **CONFIRMED**.
- **Fix sketch:** Have the resolver return the winning transition and write decision artifacts only for that transition. **Test:** Force rejection between the route snapshot and resolver read; action, receipt, reviewer history and Attention must all remain rejected.

**Ranked top five**

1. **C03:** Unauthorized modification of private knowledge and spaces.
2. **C02:** Organization-wide exposure of private action payloads.
3. **C01:** Unauthorized undo of other users’ private actions.
4. **C04:** MCP execution bypasses newly required approval.
5. **C05:** Stale approval silently destroys intervening wiki edits.

**Proposed independent work packages**

| Package | Files touched | Dependencies | Verification |
|---|---|---|---|
| **A. Action privacy and undo authority** — C01–C02 | `routes/agent.ts`, `lib/module-action-visibility.ts`, action-route tests | Independent | Requester/member/guest/admin/foreign-org visibility and undo-denial matrix; assert no denied mutation |
| **B. Authoritative native permissions** — C03, C13 | `lib/agent-actions.ts`, existing wiki/space visibility helpers, `workers/handlers/agent-reply.ts`, mutation tests | Independent | Direct and approved private-resource denial; shared-note promotion and membership-revocation tests |
| **C. Fresh MCP dispatch policy** — C04 | `lib/agent-context.ts`, `agent-stream-loop.ts`, `agent-runner.ts`, `mcp-tools.ts`, trust-boundary tests | Independent | Policy changes between discovery and execution; unregistered-name denial; zero unauthorized provider calls |
| **D. Durable native execution** — C06–C07 | `lib/agent-actions.ts`, `task-bundle.ts`, `routes/agent.ts`, action/resolver tests | Independent; establish terminal-outcome contract for F | Fault injection before/after mutation and stamping; concurrent/repeated approval produces one effect |
| **E. Safe stale-state handling and undo** — C05, C08–C10 | `workers/handlers/agent-reply.ts`, `lib/agent-actions.ts`, `routes/agent.ts`, undo tests; action-card UI for supported undo | Reuse A’s authority and D’s outcome handling | Stale wiki conflict, intervening-edit preservation, alias reversal, complete bundle reversal, unsupported-action rejection |
| **F. Accurate audit and output** — C11, C14–C15 | `routes/agent.ts`, `lib/agent-actions.ts`, `agent-approval-resolver.ts`, `agent-action-confirmation.ts`, `attention.ts`, receipt/confirmation tests | Coordinate with D | One verified receipt per outcome; truthful mixed-result confirmations; consistent approve/reject race artifacts |
| **G. Repair read-tool dispatch** — C12 | `lib/agent-context.ts`, `agent-actions.ts`, dispatcher tests | Independent; coordinate shared permission helpers with B | Every advertised read name has a reachable handler and visibility-denial tests |

A–D and G can begin independently. E should reuse the authorization and execution-state decisions; F should consume the same terminal outcome definition.

**Open questions requiring runtime verification**

- Can a one-shot outcome-stamp failure reproduce C06 while subsequent failure handling succeeds?
- Do forced restarts at each native approval boundary reproduce both the no-effect and uncertain-effect forms of C07?
- Does a live MCP tier change during a model turn reproduce C04? **PLAUSIBLE additional variant:** an unadvertised model-returned MCP name may enter the same immediate-execution branch.
- **PLAUSIBLE:** Does removing a requester strand explicit approver rows, preventing an active admin from resolving the proposal? Member-removal cleanup needs verification.
- **PLAUSIBLE:** After module terminalization commits, can receipt or Attention failures be repaired on retry? Fault injection is needed to establish the remaining recovery gap.
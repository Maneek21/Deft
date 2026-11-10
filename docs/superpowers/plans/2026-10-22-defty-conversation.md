# Defty Conversation Implementation Plan

> **For agentic workers:** Execute with Codex lanes as described in "Execution". Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Defty a participant in team chat. Concretely:
- it reads the room when invoked
- it keeps listening in a thread it has joined
- it asks only real questions and finishes what it started
- it replies like a teammate
- its background understanding works on conversations, not isolated messages

**Architecture:** Four Codex lanes on separate branches from `origin/master` `388f0a0b`, merged into `codex/defty-conversation-20261022`:
- **Lane U** (server: understanding and engagement)
- **Lane W** (web: working indicator and links)
- **Lane B** (background refinement)
- **Lane I** (infrastructure)

Lane U owns every change to the reply worker, runner prompt, compiler and message dispatch. W and B never touch those files.

**Spec / evidence:** [`docs/superpowers/audits/2026-10-22-defty-live-simulation.md`](../audits/2026-10-22-defty-live-simulation.md) (scorecard S1–S12 and background observations), [`codex-h-current-map.md`](../audits/2026-10-22-defty-failure-audit/codex-h-current-map.md), [`codex-f-resolution-current.md`](../audits/2026-10-22-defty-failure-audit/codex-f-resolution-current.md). Defty's mandate: [owner decision](../plans/2026-10-22-defty-hardening.md) D2b. Passive chat-to-task stays **off**. Defty does not manage agent employees.

## Global Constraints

- Preserve tenant isolation and space visibility. Context packs only include messages, members, tasks and projects the **requester** can read.
- All conversation text that enters a prompt is untrusted data. Put it in the existing `buildUntrustedWorkspaceContext` / `<workspace_context>` user content, never in the system prompt.
- No schema migrations. Use existing JSON `metadata` columns for new state.
- Existing Defty tests must keep passing: run the Defty suite (`apps/api/test` files matching `defty|agent|capture|approval|mcp-|memory|receipt|observe|task-extract|blocked|standup|meeting-prep|classifier|retrieve|dispatch|mention|work-intent|chat-`).
- Writes stay governed: every task or status change is still an approval proposal.
- Bounds: context pack ≤ 30 top-level messages, ≤ 400 chars each, ≤ 12,000 chars total. Thread-follow window 30 minutes.

## Review Focus

- **Two humans talking in a thread Defty once answered.** Defty must not butt in. Thread-follow fires only when the human reply comes directly after a Defty message, or answers a pending Defty question, and does not address another person by `@mention`.
- **Private channel context.** A Defty reply in channel A must never quote channel B unless the requester asked for it and can read it.
- **One project vs many.** With exactly one accessible project, never ask "which project?". With several, ask, and name them.
- **Clarification answered without @mention.** The answer must complete the original draft with its original owner, date and source.
- **Verbatim titles.** Any task Defty names appears as `KEY "exact title"`, never paraphrased.

---

## Lane U — understanding and engagement (server)

**Owns:**
- `apps/api/src/workers/handlers/agent-reply.ts`
- `apps/api/src/lib/agent-runner.ts`
- `apps/api/src/lib/agent-action-proposals.ts`
- `apps/api/src/lib/resolve-project-target.ts`
- `apps/api/src/routes/messages.ts`: Defty dispatch only
- `apps/api/src/lib/agent-context.ts`: result formatting only
- the no-provider message path

**Produces, for Lane W:** socket event `agent:working` emitted to room `space:<spaceId>` with payload `{ space_id: string, thread_id: string | null, agent_user_id: string, agent_name: 'Defty', state: 'started' | 'finished', label: string }`. Emitted with `state: 'started'` (label `"Reading the conversation…"`) when the agent-reply job begins processing, and `state: 'finished'` in a `finally` block.

### U1: Room context pack

- [ ] **Test** `room context pack includes preceding channel discussion for a fresh top-level mention`. Seed 5 human messages, then a mention, and assert the runner input's workspace context contains all 5 bodies with author names in chronological order, and excludes messages after the trigger.
- [ ] **Test** `room context pack excludes spaces the requester cannot read and is bounded`. Use 40 messages and assert ≤ 30 are included and total ≤ 12,000 chars.
- [ ] **Implement** `buildRoomContextPack(input: { orgId: string; spaceId: string; threadParentId: string | null; triggerMessageId: string; requesterId: string }): Promise<string | null>` in new `apps/api/src/lib/defty-room-context.ts`. The pack contains:
  - the last ≤ 30 top-level messages before the trigger, with author, relative time and reply count
  - for thread invocations, the whole thread up to the trigger
  - "People in this channel: …"
  - "Projects: …", marking the single accessible project when there is only one
  - any task keys mentioned in the window, with exact title, status and assignee
  
  Wire it into the agent-reply context for **channel and group-DM** invocations through the untrusted context.

### U2: No pointless questions; exact titles; clickable sources; teammate tone

- [ ] **Test** `create task with no project named uses the only accessible project`.
- [ ] **Test** `clarification between tasks lists keys with exact titles`. For example: `DEFT-13 "Review: feat(auth) — server-side logout"` or `DEFT-14 "…"`.
- [ ] **Test** `system prompt instructs verbatim titles, link-style sources and no headings in chat unless a summary is requested`. This is a string assertion on the built prompt.
- [ ] **Implement:**
  - **Project resolution** (resolver and compiler fallback): when no project is named, choose (a) the single project linked to the space, else (b) the single active project visible to the requester, else (c) clarify, naming up to 5 candidate projects.
  - **Prompt rules** for channel/DM replies:
    - conversational, 1–5 sentences or a short list
    - markdown headings only when asked for a summary or report
    - no unrequested extra sections
    - name tasks as `KEY "exact title"`
    - cite messages as markdown links `[Author, time](/chat?space=<spaceId>&message=<messageId>)`, never bare UUIDs
  - **Approval-reply text** states the concrete change, e.g. `Drafted for approval: DEFT-7 "Wire Sentry error tracking" → In progress, assigned to Arjun Rao.`

### U3: Pending clarification continuity

- [ ] **Test** `answer to a Defty clarification completes the original draft`. Flow: "make a task for what Rahul said" in a two-project org → Defty asks which project → the user answers "Deft v1" in the thread. Assert the proposal has Rahul as assignee, the original due date and the original source message.
- [ ] **Implement:** when Defty's reply asks a clarification for an action draft, store `metadata.defty_pending = { kind: 'action_draft', request_message_id, request_text, draft, question, created_at }` on the reply message. On the next agent-reply in the same thread or DM within 30 minutes, load the latest pending Defty message. Give the compiler and runner the original request, the draft and the user's answer. Clear the pending state (`metadata.defty_pending_resolved_at`) when proposals are created.

### U4: Thread follow without @mention

- [ ] **Test** `human reply directly after a Defty message in a channel thread dispatches agent-reply`.
- [ ] **Test** `human reply after another human's message in the same thread does not dispatch`.
- [ ] **Test** `reply that @mentions another human does not dispatch`.
- [ ] **Test** `reply after the 30-minute window does not dispatch`.
- [ ] **Implement** `shouldFollowThread(input: { spaceType: string; parentId: string | null; authorId: string; content: string; mentionsHuman: boolean }): Promise<boolean>` in `routes/messages.ts` (or a helper module). It returns true in a channel or group-DM thread when the newest prior message in that thread is from Defty and less than 30 minutes old, or a `defty_pending` Defty message exists in the thread less than 30 minutes old, and the reply does not structurally mention a human. Dispatch exactly as a mention would.

### U5: Working signal and an honest no-provider message

- [ ] **Test** `agent-reply emits agent:working started then finished`, including on failure.
- [ ] **Test** `empty provider env keys with no org config produce the configure-AI reply`. The reply mentions Settings → AI, not "retry".
- [ ] **Implement** the socket emits per the contract above. Treat empty or whitespace keys as unconfigured wherever provider availability is decided.

---

## Lane W — web: working indicator and links

**Owns:** `apps/web/src/components/space-chat.tsx`, `thread-panel.tsx`, and a new small component if needed. Follow `apps/web/AGENTS.md`.

**Consumes:** the `agent:working` contract above.

- [ ] Show a `Defty is reading the conversation…` row, with the existing typing-indicator styling and an animated dot, in the channel view (when `thread_id` is null or is the thread root shown inline) and in the open thread panel (when `thread_id` matches). Clear it on `finished` or when a Defty `message:new` arrives for that space/thread. Time it out after 120 s.
- [ ] Make in-app relative links in message markdown (`/chat?space=…&message=…`, `/tasks?task=…`) navigate client-side, and confirm they render as links in Defty messages.
- [ ] Unit test the indicator's reducer or state helper (start, finish, message-arrival clear, timeout). Then do a rendered check at desktop and mobile widths.

---

## Lane B — background refinement

**Owns:** `apps/api/src/lib/classifier.ts`, `apps/api/src/workers/handlers/observe-chat-message.ts`, `chat-knowledge-batch.ts`, `apps/api/src/lib/defty-capture.ts`, `blocked-alert.ts`, `chat-observation.ts`.

### B1: Classifier sees the conversation

- [ ] **Tests**, with a stubbed LLM capturing the prompt:
  - `classifier prompt includes up to 6 preceding messages from the same thread/channel`
  - `"Schema review will be done Wednesday EOD" is not blocked` (local and model paths)
  - `a referent-less instruction ("give it to Arjun") is not stored as a decision`
- [ ] **Implement:** pass ≤ 6 preceding readable messages (author: text, ≤ 300 chars) into classification as context, labelled as context and not as the message itself. Tighten the instructions:
  - a commitment with a date is not a blocker
  - a decision must be a self-contained statement naming its subject
  - ephemeral logistics (lunch, CI speed, someone says "on it") are not memorable facts

### B2: Knowledge capture catches real decisions and never destroys pages

- [ ] **Tests:**
  - `"Agreed, demo moves to Friday 3pm" episode is captured as a decision`
  - `generic workplace decision without domain vocabulary is captured`
  - `episode containing "do not save" is skipped`
  - `capture matching an existing page appends a dated update section and keeps existing content`
  - `consecutive 30-minute scans leave no unscanned gap`
- [ ] **Implement:**
  - remove the domain-vocabulary acceptance gate (it may stay as a ranking hint)
  - accept explicit agreement and decision phrasing
  - apply the existing no-save directive helper before episode classification
  - make related-page capture append (existing content plus `## Update <date>`) instead of replacing
  - set the lookback to interval + quiet + 10 minutes

### B3: Blocked alert cites the message that triggered it

- [ ] **Test** `blocked alert for a new blocked message links and quotes that message`.
- [ ] **Implement:** pass the triggering message id and content through to the alert, and use them instead of re-querying an older message.

---

## Lane I — infrastructure

**Owns:** `.gitattributes`, `apps/api/src/scripts/seed-test-org-rich.ts`.

- [ ] Pin `packages/db/scripts/*.sql` and every SHA-256-checked fresh/lineage artifact to `text eol=lf` in `.gitattributes`. Verify with a fresh `core.autocrlf=true` checkout of `packages/db` plus `pnpm db:push-full` against a fresh database.
- [ ] Fix `seed-test-org-rich.ts` for the NOT NULL `task_activity.org_id` (and any further schema drift). Verify by running it after `seed-test-org.ts` on a fresh database.

---

## Execution

1. **Branches and worktrees**, one per lane, from `origin/master`: `C:/tmp/deft-defty-{u,w,b,i}-20261022` on `codex/defty-{understanding,web,background,infra}-20261022`. Run `pnpm install --frozen-lockfile --prefer-offline` and build `@deft/app-kit` in each.
2. **Implementation:** run Codex `exec -s workspace-write -C <worktree>` per lane in parallel. The brief is Global Constraints plus the lane section. Tests requiring a database use `DEFT_TEST_DATABASE_URL=postgres://deft:deft@127.0.0.1:55520/deft_test`.
3. **Review:** a read-only Codex pass per lane on `git diff origin/master`.
4. **Verification:** Claude runs the lane's tests, the Defty suite and the API/web typecheck.
5. **Merge:** merge the lanes into `codex/defty-conversation-20261022` and run the full Defty suite once.
6. **Re-run:** deploy the integration branch to the simulation stack (API 3111, web 3110, fresh `deft_sim` database plus seed). Re-run S1–S12, plus new scenarios for thread-follow, the no-interrupt rule and two projects. Record browser videos of the conversations in the real web UI. Write a before/after report with the videos.

**Verification gate:** the simulation re-run must show:
- **S2, S10:** no pointless project question, and the answer without @mention completes the draft
- **S4:** exact titles
- **S1, S12:** concise
- a visible working indicator
- **background:** no false "blocked" on commitments, the demo decision captured, and the blocked alert citing the right message

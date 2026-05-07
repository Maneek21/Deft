---
title: Agent ↔ Chat Unification — Concept Doc
date: 2026-05-07
status: draft / first-principles revision
author: maneek (with Claude)
---

> **2026-05-07 revision.** Sections 1–7 below are the original survey of three options (keep both / hybrid fold / full fold). On re-read, that survey was constrained by an obsolete CLAUDE.md prohibition (`Don't store agent conversations in the same messages table`) written before Phase 9, when agents and humans had different schemas because agents had different runtimes. They don't anymore. **Section 8 is the revised answer**, derived from first principles: how do humans best use agents, and how do agents best function with humans and other agents? Read that first; sections 1–7 remain as context.

---

# Agent ↔ Chat Unification

## TL;DR

Today Deft has two parallel "agent" surfaces: a dedicated **/agent** hub (conversations, approvals, employee management) and **chat** (where Defty replies to `@deft` mentions and BYOA agents are mentioned but can only respond out-of-band). The friction:

1. **Agents can't initiate.** A BYOA agent that wants to tell a user something has nowhere to put it — there is no `create_dm_with_user` or `start_thread` tool. Heartbeats and triggers queue `agent_actions` but the user-facing output never lands in chat unless the user already started a thread.
2. **Two mental models.** `agent_conversations` + `agentMessages` (Defty's structured turns) lives parallel to `messages` (chat). Same activity, two stores, two UIs.
3. **Approvals split from chat context.** Pending actions live in `/settings/agent` and a sidebar badge. The user has to leave chat to approve "post this message."

This doc maps three options — keep both, fold partially, fold fully — with their feasibility, blast radius, and recommended path. The recommendation is **Option B (Hybrid Fold)**: agents become first-class chat members with DMs and space membership, `agent_conversations` is preserved as an internal execution record (not a UI surface), and the `/agent` route collapses into employee management + a power-user trace viewer.

---

## 1. Current state (post-Phase-9)

### Two surfaces, two stores

| Surface | Backed by | Used for |
|---|---|---|
| **Chat** (`/chat`) | `messages`, `spaces`, `space_members` | Human conversations; `@deft` replies posted by Defty as `deft-agent@system.local`; `@agent-name` mentions for BYOA queue pending work but the user sees only a system stub: *"Mention received. [Agent] is a BYOA agent — check your Claude Code / MCP client."* |
| **Agent** (`/agent`, `/settings/agent`, `/settings/agent-employees`) | `agent_conversations`, `agent_messages`, `agent_actions`, `agent_employees` | Direct chat with Defty (SSE streaming, structured tool blocks, citations, pending-action cards); approval inbox; employee CRUD; webhooks; heartbeats; developer credentials |

### How a message reaches an agent today

- **`@deft` in chat** → `agent-reply` worker → `runAgentQuery` → reply inserted into **`messages`** as the system user → broadcast `message:new`. (Lives in chat. Good.)
- **`@employee` in chat** → `agent-employee-message` worker → row queued in **`agent_actions`** with `action='chat_mention'` → BYOA polls via `poll_pending_work` → BYOA decides what to do. If it calls `deft_post_message`, output lands back in `messages`. If it doesn't, the user sees nothing. (Visible in chat *only* when the agent volunteers a reply.)
- **`/agent` direct chat with Defty** → `runAgentQuery` → turns appended to **`agent_messages`** (NOT `messages`). (Invisible from chat. Lives only in the Agent UI.)
- **Heartbeat / trigger / webhook fire on a BYOA** → `agent_actions` row queued → BYOA polls → may post via tool. No path forces user-visible output; the user has to open the approval inbox to see anything.

### The initiation gap (concretely)

There is **no tool** that lets an agent (Defty or BYOA) create a new conversation with a user from scratch. The agent can:

- Reply in an existing thread (`post_thread_reply`)
- Post into a space it's whitelisted into (`post_message`)

It cannot:

- Open a new DM with a specific user
- Start a fresh thread in a space without an anchoring parent message
- "Knock on the door" — surface a notification that resolves to a real chat thread the user can read and reply to

`agent-employee-trigger` and `agent-employee-heartbeat` enqueue work but produce no chat artifact. The dashboard "Agent Activity" widget is the only place the user might notice that an agent did something autonomously.

### What's already aligned

Several pieces of plumbing already make a fold cheap:

- `deft-agent@system.local` is a real user. Defty already authors `messages` rows. The chat UI doesn't break.
- Each `agent_employee` has a shadow `user_id` (already in the table). Agents *can* be `space_members`. They are participants today; we just don't expose membership UI for them.
- DMs are just `spaces` with `type='dm'` and two `space_members` rows. Nothing structurally prevents the second row from pointing at an agent's shadow user.
- `agent_actions` already carries an approval tier and `approval_status`. Inline approval cards in chat would just be a UI render of the same row that the inbox shows.

The real cost of the fold is in the **tools** (new `start_dm_with_user`, etc.) and **UI semantics** (how do agent-authored messages render, does the sidebar group agent DMs, what happens to `/agent`).

---

## 2. The options

### Option A — Keep both surfaces, patch the initiation gap

**Idea:** Don't unify. Add the missing tools so BYOA agents can initiate, and improve cross-linking between `/agent` and `/chat`.

**Concrete changes:**

- New native tools: `start_dm_with_user(user_id, opening_message)`, `post_to_user_thread(user_id, content)` — both write to `messages` via existing `executeActionDirect`.
- Tool gates: tier-`quick` for first DM to a user (one-click approval), auto-execute for follow-ups in same thread.
- New sidebar section: "Agent threads" listing DMs initiated by agents.
- `agent-employee-heartbeat` and `agent-employee-trigger` get an opinionated default: if the agent's output mentions a specific user or space, the corresponding `messages` row is also written (not just an internal `agent_action`).
- Keep `/agent` hub as-is.

**Pros**
- Smallest blast radius. No schema changes. No removed surfaces.
- Solves the initiation gap directly.
- Power users keep the structured Agent UI (tool calls, citations, model/token telemetry visible).

**Cons**
- Two mental models persist. Users still ask "is this in chat or in /agent?"
- Approvals still live behind a sidebar badge instead of inline at the point of action.
- Adds tools without retiring code paths — net code growth.

**Effort:** Small. ~3–5 files, 1 migration (none required, actually).

---

### Option B — Hybrid Fold ⭐ recommended

**Idea:** Chat is the agent surface for *user-visible* interaction. The Agent UI shrinks to power-user concerns (employee management, structured trace viewer, library). `agent_conversations` stays as an internal execution log, but the user-facing turn is mirrored into `messages` so chat is always the user's view.

**Conceptual model after the fold:**

```
┌──────────────── chat ────────────────┐    ┌────── /agent (power user) ──────┐
│  Spaces                              │    │  Employee management             │
│  DMs (incl. with Defty + employees)  │    │  Webhooks / heartbeats           │
│  Threads                             │    │  Developer credentials           │
│  Inline agent messages (with tool    │    │  Trace viewer (read-only,        │
│    cards + approval prompts)         │    │    structured agent_messages)    │
└──────────────────────────────────────┘    └──────────────────────────────────┘
       ↑                                              ↑
   USER-VISIBLE                                  ADMIN/POWER
```

**Concrete changes:**

#### Backend
- **Agents are first-class space members.** Every `agent_employee` already has a shadow user. Expose them in the Add Member modal, the @-autocomplete, and the DM picker. Defty (`deft-agent@system.local`) gets the same treatment.
- **New tools (BYOA + Defty):** `open_dm_with_user(user_id, opening_message)`, `start_thread_in_space(space_id, opening_message)`. Both write to `messages` and broadcast `message:new`. Both run through the existing approval pipeline.
- **Mirror Defty turns into chat.** When `agent-reply` finishes a turn that resulted from a `/agent` direct chat (not a chat `@mention`), also insert the user-visible reply as a `messages` row in the user's DM with Defty. The structured `agent_messages` row stays for the trace viewer.
- **Inline approval cards.** `messages.metadata.pending_action_id` lets a chat message render with approve/reject buttons that hit the existing `/api/agent-actions/:id/approve|reject` endpoints. Same data, new render site.
- **Initiation through triggers/heartbeat.** When a heartbeat or trigger produces user-targeted output, the worker writes both an `agent_actions` row (audit) *and* a `messages` row in the appropriate DM/space (visibility). Auto-execute vs. pending-approval is determined by the existing trust tier; pending posts render as a system stub *"[Agent] wants to send you a message — review"* with inline approve.

#### Frontend
- Sidebar gets an **"Agents"** subsection under DMs (or interleaved as plain DMs — design call). Defty pinned at top.
- Agent-authored messages render with a subtle agent badge + the agent's avatar. Tool-use blocks render inline as collapsible cards (reuse `AgentChat` components in chat context).
- Approval inbox stays at `/settings/agent` for bulk review, but the **primary** approval surface becomes inline in chat.
- `/agent` hub becomes a thin redirect: top-level nav → "Agent" expands into chat DMs with each agent. The structured conversation history (with full tool call detail, citations, telemetry) stays accessible as a "View structured trace" link on each agent's DM header — opens the existing `AgentChat` component in a side panel or modal.
- Sidebar Agent badge migrates: pending approvals show as unread counts on agent DMs (more legible than a single global badge).

#### Data
- `agent_conversations` + `agent_messages` are **kept**. They're the structured log. The CLAUDE.md prohibition on merging them with `messages` stands — they hold tool blocks, citations, and telemetry that don't fit cleanly in `messages.metadata`.
- New mirroring contract: every user-visible agent turn writes one `messages` row whose `metadata` carries `{ agent_message_id, agent_conversation_id, has_tool_calls }` so the trace viewer can resolve back.

**Pros**
- Solves the initiation gap (agents can DM users).
- One UI for everyday work — chat. The user-visible mental model collapses.
- Power-user surface preserved (structured trace, telemetry, employee mgmt).
- Most existing code paths reused; the work is mostly UI plumbing + 2 new tools + a mirroring write.
- Approvals become contextual (inline in chat) without losing the bulk-review inbox.

**Cons**
- Mirroring write is a place where two stores can drift. Need a clear contract (always write `agent_messages` first, then mirror; if the mirror fails, the trace still exists; reconcile background job).
- Chat sidebar gets noisier if every employee a user can see surfaces as a DM. Need to gate by "has there been activity?" or "user has ever interacted with this agent?".
- BYOA agents that don't call the new initiation tools will still feel passive. Need to update the bundled `deft-mcp-client` skill prompts to nudge agents to DM the user when they have something to say.

**Effort:** Medium. ~10–15 files, 0–1 migration (can be done with metadata fields on existing tables; if we want a `messages.agent_metadata` JSONB column we'd add migration 0061).

---

### Option C — Full Fold

**Idea:** Delete `agent_conversations` + `agent_messages`. Everything an agent says or does is a `messages` row. Approval lives entirely inline. `/agent` route disappears.

**Concrete changes:**

- Migrate `agent_messages` content into `messages.metadata.agent_blocks` (tool calls, citations, model, tokens) for historical agent conversations.
- Drop `agent_conversations` and `agent_messages` tables (or keep as audit-only, write-once).
- All agent endpoints (`/api/agent/chat`, `/api/agent/conversations`, etc.) become thin wrappers over chat endpoints with metadata filters.
- Approval inbox shows messages in pending state, in-place; no separate `/settings/agent` page.
- The `AgentChat` component becomes `SpaceChat` with agent-rendering branches.

**Pros**
- One table. One UI. One mental model. Maximum simplification.
- No mirroring drift risk because there's nothing to mirror.

**Cons**
- **Violates an explicit CLAUDE.md prohibition** ("Don't store agent conversations in the same messages table — separate agent_conversations table"). Reversing it requires conscious agreement that the original concern (messages bloat from tool blocks, ergonomics of mixed schemas) is no longer load-bearing.
- `messages` schema has to swallow tool blocks, citations, telemetry, model identity, token counts. `metadata` JSONB is flexible but search/index patterns get harder.
- Heavy migration. Existing agent conversation history has to be backfilled or quarantined.
- Loses the cleanest possible "agent execution log" — `agent_actions` becomes the only structured record, and it's per-action, not per-turn.
- Power users (developers debugging an agent's reasoning) lose the structured viewer unless we rebuild it on top of `messages.metadata`.

**Effort:** Large. ~25+ files, 2–3 migrations, backfill script, careful release coordination.

---

## 3. Recommendation

**Option B — Hybrid Fold.**

It does what the user wants (chat is the agent surface; agents can initiate), keeps the structural primitives that earned their place (separate `agent_conversations` for tool-call structure and telemetry), and the work is mostly additive: new tools, new mirror-write, UI rebinding. The blast radius is bounded — if any piece misbehaves, we can ship the others without breaking chat.

Option C is tempting but fights an explicit prior decision in CLAUDE.md and introduces schema risk for marginal additional clarity.

Option A leaves the dual-surface problem in place forever.

---

## 4. What "Option B" looks like as a sequence

If the user signs off, the rough order of work:

1. **Initiation tools** (Backend, ~1 day)
   - `open_dm_with_user(user_id, opening_message)` and `start_thread_in_space(space_id, opening_message)` — both Defty-callable + exposed via MCP for BYOA.
   - Approval tier: `quick` for first DM to a user; auto-execute thereafter (per existing trust matrix).
   - Tests: 35-case approval matrix already covers the pattern; add 4–6 new rows.

2. **Mirror Defty user-visible turns into `messages`** (Backend, ~½ day)
   - `agent-reply` and `runAgentQuery` write the user-visible block into `messages` *in addition to* `agent_messages`.
   - For `/agent` direct chats, the mirror target is the user's DM with Defty (auto-create on first turn).

3. **Sidebar exposure of agent DMs** (Frontend, ~½ day)
   - DM list renders agent shadow-users.
   - Defty pinned on first run.
   - Empty-state messaging if the user has no agent DMs yet.

4. **Inline approval cards in chat** (Frontend, ~1 day)
   - When `messages.metadata.pending_action_id` is set, render approve/reject inline.
   - Reuse existing `/api/agent-actions/:id/approve|reject`.
   - Update `usePendingApprovals` to also surface counts as DM unreads.

5. **Heartbeat + trigger user-visible mirroring** (Backend, ~1 day)
   - When an `agent_actions` row resolves to user-targeted output, also write a `messages` row (pending-approval if not auto-execute).
   - Update `agent-employee-trigger.ts` and `agent-employee-heartbeat.ts`.

6. **`/agent` route slimming** (Frontend, ~½ day)
   - Top nav "Agent" expands into employee DMs.
   - Old `/agent` page becomes a redirect to chat.
   - "View structured trace" affordance on each agent DM header opens `AgentChat` in a panel.

7. **Bundled-skill prompt updates** (~½ day)
   - `deft-mcp-client` SKILL.md nudges BYOA agents to DM the user when they have unsolicited output.
   - Heartbeat checklist examples include "DM @user if X."

8. **Telemetry + rollback plan**
   - Feature flag the mirror write so it can be disabled without a deploy if drift is observed.
   - Reconciliation cron: nightly check that every user-visible `agent_messages` turn has a `messages` mirror; emit `mirror_drift` system notification for org admins on drift.

Total: ~5–6 engineer-days of focused work; pieces are independent enough to parallelize across two sessions.

---

## 5. Open questions

1. **Sidebar density.** Does every `agent_employee` show as a DM in the user's sidebar by default, or only after first interaction? Default proposal: only after the user has @mentioned the agent OR the agent has DM'd the user (i.e., a real `messages` row exists between them).
2. **Group spaces.** Should agents be `@channel`-able in public spaces? Today they can be @mentioned but can't post unprompted. Option B doesn't change this; agents only initiate in DMs and threads they were brought into. Worth confirming.
3. **Message authorship attribution.** Agent-authored messages render with the agent's avatar today (no special styling). Should there be a small badge ("AI") on every agent message, even Defty? Probably yes — discoverability + safety.
4. **Trace viewer placement.** Side panel? Modal? Dedicated `/chat/{spaceId}/trace` route? Lightest is a side panel toggled from the DM header.
5. **What happens to `/settings/agent`?** Trust level and approval inbox live here today. Trust level moves to per-employee settings (already exists). Approval inbox stays as a "bulk review" view but is no longer the primary surface; reachable from each agent DM and from the sidebar badge.
6. **Defty's identity.** Does Defty become an `agent_employee` row to unify the model? CLAUDE.md says explicitly *"No `agent_employees` row, no `kind` column, no choice"* — Defty is built-in. Option B preserves this; Defty stays a system user without an `agent_employees` row, but exposes the same DM affordance via the existing `deft-agent@system.local` user.
7. **Cross-org safety.** Agent shadow users are scoped to org. The DM picker must filter by `org_id` (existing pattern). Confirm `/api/members` already does this for agent users.

---

## 6. What we'd NOT do (out of scope)

- Not merging `agent_messages` into `messages`. The structured log stays separate.
- Not removing the approval inbox. It becomes secondary, not deleted.
- Not adding new `kind` columns or runtime branches. Phase 9's BYOA-only model holds.
- Not deploying a feature flag system; the mirror write is gated by a single config switch (`AGENT_CHAT_MIRROR_ENABLED`) for fast rollback.
- Not changing approval matrix semantics. New tools slot into existing tiers.

---

## 7. Decision checkpoint

Before any code lands:

- [ ] User confirms Option B vs A vs C.
- [ ] Open question (1) sidebar density resolved.
- [ ] Open question (3) AI badge resolved.
- [ ] Confirm we're OK with the mirror write as a small, intentional duplication (vs. CLAUDE.md's "no duplication" preference).

If all four green, this becomes a plan via `superpowers:writing-plans` and ships in the order in §4.

---

# 8. Revised answer — Unified Participant Model

The earlier survey was anchored to "we have an agent surface and a chat surface, how should they relate." That framing is wrong. It assumes agents are a *feature* of the workspace. They aren't anymore. Post-Phase-9, the platform is BYOA-only — every agent runs in someone else's runtime. Deft's job isn't to *be* an agent; it's to be the **place where agents and humans meet, talk, and coordinate.**

If we re-derive from that, the architecture clarifies hard.

## 8.1 — How humans best use agents (observed pattern)

Across every product where agents have been adopted at scale, the pattern that wins is consistent:

- **The agent lives where the work is.** Not in a side window. Not behind a "/ai" button. In the same surface the human already inhabits. Cursor put the LLM in the editor. Slack bots succeed when they're channel members, fail when they're modal interruptions.
- **The agent has a name and a face.** It's addressable as a teammate (`@defty`, `@ops-bot`), not invoked as a function (`/ai do_thing`).
- **Conversation is the universal substrate.** Multi-turn, threaded, with history. Not a new mental model.
- **Visibility, then control.** Humans build trust by *seeing* what agents do. Approval friction gets traded down as trust grows.
- **Initiation is bidirectional.** Real assistants surface things you didn't ask for: "deploy is failing", "your 1:1 is in 15."
- **One inbox.** Notifications, mentions, approvals, and agent output all converge. Splitting them creates dropped balls.
- **Multi-agent without remembering which one.** "I want this scheduled" — let the orchestration figure out who handles it; the human shouldn't have to know the org chart of the bots.

The throughline: **the best agent UX is teammate UX.** Agents work best when they're indistinguishable from human teammates at the protocol level — addressable, mentionable, DM-able, channel-joinable, threadable — and distinguishable only at the *render* level (an agent badge, a tool-call card).

## 8.2 — How agents best function with humans and other agents

Now flip the camera. What does an agent need from the platform?

- **A persistent identity.** A handle other participants address it by. A profile, an avatar, a presence.
- **A canonical inbox.** Mentions, DMs, threads it's watching, triggers, scheduled work — one queue.
- **A canonical outbox.** One place to send messages — DM a human, post in a channel, reply in a thread, mention another agent.
- **Channels.** Not "tool whitelists." Real spaces it's a member of, scoped to what it can see.
- **Threading.** Coordination across multiple steps without losing context.
- **Mentioning peers.** Agent A → Agent B is the same primitive as Human A → Agent B.
- **Memory of what was just said.** Conversation history, not function-call logs.

When you list these out, the realization is unavoidable: **agents need exactly the same primitives humans need**. Identity, inbox, outbox, channels, threads, mentions, DMs, history. Different *runtime* — same *protocol*.

If that's true, then maintaining two parallel sets of these primitives — `messages`/`agent_messages`, `spaces`/`agent_conversations`, `space_members`/`agent_employees-as-implicit-membership` — is doing the platform real damage. We're paying for two implementations of the same thing.

## 8.3 — The thesis

> **Chat is not where agents are exposed. Chat IS the agent platform.**
>
> Every participant — human or agent — is a `user`. Every conversation — human-to-human, human-to-agent, agent-to-agent, multi-party — is a `space`. Every message is a `messages` row. The runtime that authors a message is irrelevant to the protocol.

Slack tried to be this and half-succeeded because their bots were second-class — different APIs, different rendering, different limits. We can do this cleanly because Deft was multi-tenant + agent-aware from day one and Phase 9 already collapsed agent runtimes to a single shape (BYOA over MCP).

## 8.4 — Schema collapse this enables

Drop the parallel surfaces. Promote agents to first-class users.

| Today | Tomorrow |
|---|---|
| `agent_conversations` table | dropped → `spaces` (DM type, agent as member) |
| `agent_messages` table | dropped → `messages` with `metadata.agent_blocks` (tool calls, citations, model, tokens) |
| `agent_employees.user_id` shadow user | promoted to first-class — agents are `users` with `is_agent=true` (or `kind='agent'`) |
| `agent_employees` table | renamed `agents`, becomes a config sidecar pointing at `users.id` (system prompt, trust level, MCP token, heartbeat config, etc.) |
| `/agent` route | gone. Agents appear in chat sidebar. |
| `/settings/agent` (approval inbox) | merged into a global `/inbox` (or kept as `/approvals`) — one queue across mentions, assignments, agent actions |
| `agent_actions` | **kept**. This is the approvals/audit ledger, not chat. A pending action *links* to a `messages` row but isn't itself a message. Inline approval cards in chat render from `agent_actions` joined on `messages.metadata.pending_action_id`. |
| `poll_pending_work` MCP tool | becomes `fetch_unread` — returns unread `messages` (mentions, DMs, threads watched) + pending `agent_actions` against this agent. Same primitive humans use. |
| `post_message` / `post_thread_reply` / proposed `start_dm_with_user` | one tool: `send_message(target, content)` where `target` is `{space_id}` or `{user_id}` (DM, lazy-creates space) or `{thread_id}` |
| `agent-reply` worker (Defty's @-mention handler) | becomes a generic message handler — when a `messages` row mentions a participant whose `is_agent=true`, that agent's runtime is invoked (in-process for Defty, queue-for-pickup for BYOA) |
| Defty as `deft-agent@system.local` | Defty as a regular `users` row with `is_agent=true`, auto-DM'd with each user lazily on first interaction (or pre-created on org bootstrap) |
| Sidebar Agent badge | unread count from agent DMs (more legible — points at the actual conversation) |
| `/agent/conversations` page | gone — that's the chat sidebar's DM list filtered to `is_agent=true` |
| `AgentChat` component | merged into `SpaceChat` — message renderer learns to draw tool-call cards inline for messages where `metadata.agent_blocks` exists |

The CLAUDE.md line "*Don't store agent conversations in the same messages table — separate agent_conversations table*" is **superseded** by this design. The original concern (mixed schemas, bloat from tool blocks, search ergonomics) is small and tractable in modern Postgres + a JSONB column. The cost of two parallel stores is large and growing. Reverse the prior decision; update CLAUDE.md to reflect the new model.

## 8.5 — How the new world feels

### For the human

- Open Deft. Sidebar has spaces and DMs. Some DMs have a small AI badge (Defty pinned at top, Alex PM, Ops Bot, whoever you've talked to).
- DM Defty: "Pull up the deploy status." Defty's reply renders in the same thread; tool calls collapse into a card you can expand.
- @-mention `@alex-pm` in #engineering: Alex PM polls, sees the mention, replies in-thread. You see the reply in chat — same as if a human teammate replied.
- Alex PM's heartbeat fires at 9am: it has something to share with you, so it DMs you. Your sidebar shows an unread on the Alex DM. You read it, optionally reply, optionally approve a proposed action inline.
- A pending approval lands inline in the conversation as a card with Approve/Reject. No mode switch. The global `/inbox` (or `/approvals`) is still there for bulk review.
- `/agent` is gone. There's no page to "go to the agent" — the agent is *here*.

### For the agent

- Agent is a `user` with an identity, an avatar, a presence, a list of spaces it's in.
- Inbox = unread `messages` + pending `agent_actions` against it. One MCP call: `fetch_unread`.
- Outbox = `send_message`. Same call whether the target is a human DM, a channel, a thread, or another agent's DM.
- Agent A wants Agent B to do something: `send_message({user_id: B}, "Hey B, can you handle this?")`. B's MCP client polls, sees the mention, decides whether to act. Pure protocol — no special agent-to-agent infrastructure.
- Triggers (cron, webhook, member.joined) become messages from a `system` user *to* the agent. Same inbox.
- Memory of context = chat history. The same SELECT humans use.

### For the platform

- One messages table. One spaces table. One members table. One inbox. One outbox.
- Approval ledger (`agent_actions`) stays as a structurally separate thing because it *is* structurally different — it's a queue of proposed-but-not-yet-executed side effects, not a record of communication.
- Trust tiers, daily caps, circuit breakers, loop detection — all unchanged. They live on the `agents` config sidecar.
- New code is mostly subtractive: deleting `/agent` routes, merging `AgentChat` into `SpaceChat`, dropping two tables.

## 8.6 — Multi-agent semantics (the new question this opens)

When the platform is symmetric, this becomes possible: *multiple agents in a single space coordinating.* That deserves its own invariants:

- **Agents reply only when explicitly addressed.** @-mention, DM, or thread they own/started/are-assigned-to. Otherwise they stay silent. (Same rule humans follow — ambient presence, not constant chiming.)
- **No reply-storms.** When Agent A mentions Agent B, B can mention C, etc. Loop detector: if N consecutive messages in a thread are all agent-authored with no human turn, throttle and require human re-engagement. Existing per-agent loop detector adapts; thread-level detector is new.
- **Mentions cross runtimes.** `@alex-pm` (BYOA, queued) and `@defty` (in-process, immediate) work the same way from the user's POV. Latency varies.
- **Authority and trust are per-agent, not per-thread.** If Agent A is `autonomous` and Agent B is `conservative`, B's actions in the shared thread still go through B's approval matrix.
- **Spaces have an explicit member list.** An agent is in a space if and only if it's a `space_members` row. No implicit-everywhere agents. Solves the discovery problem cleanly.

This is genuinely new product capability — orgs can compose multi-agent workflows by adding agents to channels, the same way they invite humans. No DAG configuration, no orchestration layer. Just chat.

## 8.7 — Migration shape

This is bigger than Option B. It's not Option C either — Option C deleted `agent_messages` without rethinking the surface; this rethinks the surface and the schema falls out of it.

### Phase 1 — Promote agents to first-class users (foundational, ~2 days)
- `users.is_agent` boolean (or `kind` enum if we want plumbers/system/ai distinctions). Migration 0061.
- Backfill: every `agent_employees.user_id` flips `is_agent=true`. The `deft-agent@system.local` user flips `is_agent=true` per org.
- `/api/members` endpoint learns to return agent users (already returns them since they're `users` rows; just confirm filtering).
- @-autocomplete renders agents with a small badge, ranks them after humans by default.
- Add Member modal exposes agents.
- DM picker exposes agents.
- *No surfaces removed yet.* Both `/agent` and chat work in parallel.

### Phase 2 — Mirror, then dual-write, then collapse (data, ~3 days)
- New write path: every `agent_messages` insert *also* writes to `messages` with `metadata.agent_blocks`. Old reads still hit `agent_messages` (no change).
- Confidence period: ~1 week of running mirrored. Reconciliation cron checks parity.
- Flip reads to `messages.metadata.agent_blocks`. Drop the mirror; new agent turns write only to `messages`.
- Backfill historical `agent_messages` → `messages`. One-time script.
- Drop `agent_messages` and `agent_conversations` tables. (Or keep as audit-only for one quarter, then drop.)

### Phase 3 — Tool collapse (BYOA-facing, ~1 day)
- New unified MCP tool: `send_message({target, content})`. Old `post_message` / `post_thread_reply` / new `open_dm` aliases for one release, then deprecated.
- New unified MCP tool: `fetch_unread()`. Old `poll_pending_work` aliased then deprecated.
- Update `deft-mcp-client` bundled skill prompts.

### Phase 4 — UI collapse (frontend, ~2–3 days)
- `SpaceChat` learns to render `metadata.agent_blocks` (tool-call cards, citations, model footer). Reuse pieces from `AgentChat`.
- Inline approval cards render from `agent_actions` linked via `messages.metadata.pending_action_id`.
- Sidebar "Agents" subsection (or interleaved DMs, design call). Defty pinned.
- `/agent` route deleted. Top-nav "Agent" entry removed (or repointed to `/inbox`).
- `/settings/agent` becomes `/settings/agents` (employee management). Approval inbox migrates to `/inbox` (or stays at `/approvals`).
- `AgentChat` component deleted (merged into `SpaceChat`).

### Phase 5 — Multi-agent affordances (~2 days)
- Add Member modal can add agents to public/private spaces.
- Per-space agent budget caps (optional — prevents one expensive agent from racking up cost in a noisy channel).
- Thread-level reply-storm detector.
- Documentation: "How to compose multi-agent workflows in Deft."

**Total: ~10–12 engineer-days of focused work, with clean phase boundaries that ship independently.** Each phase is a real product improvement on its own — even Phase 1 alone (agents in autocomplete + DM picker) makes the platform feel meaningfully more unified.

## 8.8 — What this costs

Honest accounting:

- **CLAUDE.md prohibition reversed.** Conscious, documented, with a paragraph explaining why the original concern is no longer load-bearing.
- **`messages` rows for agents carry tool blocks** in `metadata.agent_blocks`. Postgres handles this fine; some agent turns will be 50–100KB. Indices on `(space_id, created_at)` unaffected; if we need agent-specific search later, GIN on `metadata->'agent_blocks'`.
- **One-time backfill** of historical `agent_messages` rows. A few hundred lines of script, plus a verification pass.
- **`SpaceChat` complexity grows** — it has to render two message shapes (human, agent-with-blocks). Net code is still less than `SpaceChat + AgentChat`, but the merged component is bigger than today's `SpaceChat` alone.
- **Cost-cap surface area widens.** Agents talking in shared spaces means every channel becomes a potential cost vector. The existing per-agent daily cap handles the worst case; per-space caps are a nice-to-have not a must.
- **Multi-agent loops are a new failure mode.** Mitigated by mention-only-replies + thread-level loop detector + existing per-agent circuit breaker.

None of these are deal-breakers. All are smaller than the cost of carrying two surfaces forever.

## 8.9 — Recommendation (revised)

**Do this. Option D — Unified Participant Model.**

Phase 1 alone is a clean win and doesn't commit us to the rest. If the team validates that agents-in-autocomplete + agents-in-DMs + agents-in-spaces feels right, Phase 2–5 follow naturally. If it doesn't, Phase 1 still delivers most of the initiation-gap fix and we can stop there with the surfaces still parallel — no wasted work.

The earlier "Hybrid Fold" recommendation was the right answer to the wrong question. The right question is: *what would chat have to be to be the universal coordination protocol for everyone — humans and agents — in this workspace?* The answer is, mostly, "what it already is, with agents promoted to first-class participants."

## 8.10 — Decision checkpoint (revised)

Before Phase 1 lands:

- [ ] Confirm: reverse the CLAUDE.md prohibition. Update CLAUDE.md to document the new model.
- [ ] Confirm: agents are `users` with `is_agent=true` (vs. `kind` enum vs. separate type discriminator). Default proposal: boolean flag, simplest.
- [ ] Confirm: Defty becomes a regular agent user per-org, lazy-DM'd with each human on first interaction. (No automatic universal-DM-to-everyone.)
- [ ] Confirm: agent message rendering — small "AI" badge on every agent turn, tool-call cards collapsible inline.
- [ ] Confirm: approval inbox moves to `/inbox` (unified) or stays at `/approvals` (just rebranded).

If green, Phase 1 ships behind a feature flag (`UNIFIED_PARTICIPANTS_ENABLED`) so we can roll forward and back per-org during validation.


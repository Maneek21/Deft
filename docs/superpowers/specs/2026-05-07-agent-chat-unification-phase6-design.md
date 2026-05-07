# Agent ↔ Chat Unification — Phase 6: Multi-Agent Affordances

**Date:** 2026-05-07
**Phase:** 6 of the agent-chat unification series. Builds on Phases 1–5.

## Goal

Make multi-agent participation in chat surfaces safe and legible:

1. **Agents in `SpaceMembersPanel`.** When a user opens "Add members" from a channel or group DM, agents appear as a separate, badged section in the picker — same UX pattern as the Phase 4 `CreateDmModal`.
2. **Reply-storm detector.** When an agent posts ≥5 replies in the same thread within a rolling 10-minute window, subsequent `post_thread_reply` calls from that agent (in that thread) return a `STORM_DETECTED` error from the tool executor. The agent can choose to back off, post in another surface, or DM the user. No chat-side artifacts.
3. **Agent participant indicator.** Each agent row in `SpaceMembersPanel` carries a small AI badge so humans see at a glance which participants are agents.

## Non-goals

- No channel-header redesign. The current header (space name, topic) stays as-is.
- No semantic-similarity detection. Storm signal is a simple per-thread, per-agent count over a rolling window. Heartbeat's `prompt_sha` idempotency stays where it is — those are different problems.
- No DM-only restriction on agents. Agents can be added to public, private, dm, and group_dm spaces alike (Phase 1 made them first-class users; the backend already accepts any user_id).
- No new admin notification when storms trip. The error in the tool result is enough signal for the agent's runtime to log; admins can grep server logs if they need to investigate.

## Architecture

```
chat surfaces                    storm detector
─────────────                    ──────────────
SpaceMembersPanel ──┐
  ├─ humans         │  POST /api/spaces/:id/members ──┐
  └─ agents (NEW)   │                                 │
                    │                                 ▼
                    └─ /api/members (returns kind) ─► spaceMembers row inserted
                                                      (no behavior change)

agent posts          MCP send_message / post_thread_reply
─────────────                  │
                               ▼
                    apps/api/src/lib/storm-detector.ts
                       countAgentRepliesInThread(agent_user_id, thread_id, 10min)
                               │
                          ≥5 replies in window? ─► throw STORM_DETECTED
                          else: proceed
```

Three changes, each in its own file with one clear responsibility:

- **`apps/api/src/lib/storm-detector.ts`** (new) — pure read-side helper. One exported function: `checkReplyStorm(agentUserId, threadId, now)` returns `{ tripped: boolean, count: number, windowMs: number }`. Reads from `messages` table; no writes, no side effects.
- **`apps/api/src/lib/mcp-tools/writes.ts`** (modify) — `sendMessage` (Phase 3) and `postThreadReply` (Block 2) check `checkReplyStorm` when caller's `user.kind === 'agent'` and `target.thread_id` (or implicit thread for `post_thread_reply`) is non-null. On trip, throw an error matching the existing tool-executor error contract: `{ code: 'STORM_DETECTED', message: 'reply rate limit exceeded for this thread' }`.
- **`apps/web/src/components/space-members-panel.tsx`** (modify) — extend `Member` type with `kind`, partition `nonMembers` into `humans` + `agents` arrays, render two labelled sections in the add-member picker. Each agent row gets a small AI badge (same `<AIBadge/>` pattern used in `CreateDmModal` from Phase 4 — extract into `apps/web/src/components/ai-badge.tsx` if it isn't already a standalone component).

## Components and data flow

### Component 1: storm detector

**Interface:**

```typescript
// apps/api/src/lib/storm-detector.ts
export const STORM_THRESHOLD = 5;
export const STORM_WINDOW_MS = 10 * 60 * 1000;

export type StormCheck = { tripped: boolean; count: number; windowMs: number };

export async function checkReplyStorm(
  agentUserId: string,
  threadParentId: string,
  now?: Date,
): Promise<StormCheck>;
```

**Logic:** Count rows in `messages` where `user_id = agentUserId AND parent_id = threadParentId AND created_at > now - 10min AND is_deleted = false`. If `count >= 5`, tripped. The `now` parameter exists for tests; production callers omit it.

**Why parent_id, not space_id:** the storm is about a single thread spinning. Different threads in the same space are unrelated. `messages.parent_id` is the thread root; replies hang off it. The thread root's own message has `parent_id = null`, so it is never counted as a reply by this query.

**No DB schema change.** All reads from existing columns + one composite index on `(user_id, parent_id, created_at)` if performance matters. Phase 6 ships without the index — `messages.parent_id` already has its own index, and a per-thread per-agent count over 10 minutes is bounded.

### Component 2: tool-side enforcement

**Two callsites, same guard:**

1. **`postThreadReply`** (Block 2). Always operates on a thread (the `parent_message_id` parameter resolves to a parent message; the new message's `parent_id` is set to that). Before the insert: if caller is an agent, run `checkReplyStorm`. On trip, throw.

2. **`sendMessage`** (Phase 3). Has a discriminated `target`:
   - `{ space_id }` — top-level post to a space, NOT a thread reply. No storm check.
   - `{ thread_id }` — explicit thread reply. Run storm check.
   - `{ user_id }` — DM. No storm check (DMs are 1:1, storms there are between humans and agents and the human can mute or close the DM).

**Error shape:** the executor wraps tool errors into the `agent_actions.error` column and the tool-result block returned to the agent. The error is `{ code: 'STORM_DETECTED', message: '<agentName> exceeded ${STORM_THRESHOLD} replies in this thread within ${windowMin} minutes; backing off' }`. Existing error wrapping handles propagation; no new error path.

**Why throw vs. silently insert with a flag:** the agent needs to know it failed so it can adapt. An MCP tool that silently no-ops would teach the agent to retry harder.

### Component 3: members panel UI

**Current state (`space-members-panel.tsx`):**

- Loads `members` (this space) and `allMembers` (whole org) on mount.
- `nonMembers` = `allMembers - members`. Filters by search string.
- Renders `nonMembers` as a flat list with avatar + name + "Add" button.
- `Member` type lacks `kind`.

**Phase 6 changes:**

```typescript
type Member = {
  id: string;
  name: string;
  email: string;
  avatar_url: string | null;
  kind?: 'human' | 'agent' | 'system'; // NEW
  status_emoji?: string | null;
  status_text?: string | null;
};

// In render:
const humanCandidates = filtered.filter(m => m.kind !== 'agent' && m.kind !== 'system');
const agentCandidates = filtered.filter(m => m.kind === 'agent' || m.kind === 'system');

// Two sections:
// "People" (humans) — existing styling
// "Agents" — same row layout + small AI badge after the name
```

The current members list (top of the panel) also gets a small AI badge after each agent's name. The remove button (`UserMinus`) is unchanged — humans can remove agents the same way they remove humans.

**`<AIBadge/>` reuse:** Phase 4's `CreateDmModal` introduced an "AI" badge for agents in the DM picker. If that's an inline JSX snippet, extract it into `apps/web/src/components/ai-badge.tsx` so both surfaces use the same component. If it's already a standalone component, just import it.

## Error handling

- **Storm tripped:** thrown error becomes a tool-result error block visible to the agent's runtime. Existing tool-error pipe handles persistence to `agent_actions.error`.
- **Member already in space:** existing 409 CONFLICT response; no change.
- **Adding a deleted/inactive agent:** existing add-member route doesn't validate user kind — agents can be added the same way humans are. If the agent is deactivated (`agent_employees.is_active = false`) we still allow adding it (the admin may want to reactivate later); the row just won't trigger any agent dispatch until reactivated.
- **Cross-org agent:** the existing `/api/members` route is org-scoped. Agents from another org never appear in the picker. No new check needed.

## Testing

Three new test files, all using `node:test` + `node:assert/strict`:

1. **`apps/api/test/storm-detector.test.ts`** — unit-tests `checkReplyStorm`:
   - 0 replies in window → not tripped, count=0
   - 4 replies in window → not tripped, count=4
   - 5 replies in window → tripped, count=5
   - 5 replies but oldest is >10min ago → tripped, count=5 of which only 4 in window → not tripped (count=4)
   - 5 replies in DIFFERENT thread → not tripped (different parent_id)
   - Mixed agents in same thread, only 4 from target agent → not tripped (per-agent scoping)

2. **`apps/api/test/mcp-storm-enforcement.test.ts`** — integration test on `sendMessage` and `postThreadReply` MCP tools:
   - `sendMessage` with `target: { thread_id }` and 5 prior agent replies → throws `STORM_DETECTED`
   - `sendMessage` with `target: { space_id }` and 5 prior top-level posts → succeeds (no thread, no check)
   - `sendMessage` with `target: { user_id }` (DM) and 5 prior DM messages → succeeds
   - `postThreadReply` with 5 prior agent replies → throws
   - Non-agent caller (kind=human) hitting same threshold → succeeds (storm check is agent-only)

3. **`apps/api/test/members-kind-in-list.test.ts`** — verifies `/api/members` returns `kind` for both human and agent rows. (May already exist from Phase 1; this test re-asserts the contract.)

For the UI partition: extend the existing file-structure regression test (`inbox-redirect.test.ts` pattern) with two assertions — `space-members-panel.tsx` source contains the literal strings `'People'` and `'Agents'` and references `kind === 'agent'`. Cheap regression-catcher.

## Files

**New (3):**
- `apps/api/src/lib/storm-detector.ts`
- `apps/api/test/storm-detector.test.ts`
- `apps/api/test/mcp-storm-enforcement.test.ts`

**Modified (3):**
- `apps/api/src/lib/mcp-tools/writes.ts` — `sendMessage` adds storm check on `target.thread_id` branch
- `apps/api/src/lib/mcp-tools/messages.ts` (or wherever `postThreadReply` lives — check current path) — adds storm check before insert
- `apps/web/src/components/space-members-panel.tsx` — `Member.kind` field, partitioned picker, AI badge per agent row

**Possibly extracted (1):**
- `apps/web/src/components/ai-badge.tsx` — only if Phase 4's `CreateDmModal` has the badge as inline JSX rather than as a reusable component already

**Possibly modified (1):**
- `apps/web/src/components/create-dm-modal.tsx` — if we extract `<AIBadge/>`, replace the inline badge here too

## Backwards compatibility

- No DB migration. `users.kind` already exists; `messages.parent_id` already exists; both are pre-Phase-6.
- Existing humans in spaces are unaffected. Existing agents already in spaces (Phase 1 made Defty a member of every org) get a visual badge but their participation is unchanged.
- Existing agents that DON'T thread-spam see no change. Only thread-spamming agents hit the new error.
- The threshold (`STORM_THRESHOLD = 5`) and window (`STORM_WINDOW_MS = 10 * 60 * 1000`) are exported constants. Tests can override them; future tuning is one-file.

## CLAUDE.md update

After implementation:

```markdown
**Phase 6 (2026-05-07).** Multi-agent affordances. (1) Agents partitioned
in `SpaceMembersPanel` into a separate "Agents" section with an AI
badge per row, mirroring the Phase 4 CreateDmModal pattern; backend
member-add accepts any user kind unchanged. (2) Reply-storm detector
in `apps/api/src/lib/storm-detector.ts`: counts agent-authored thread
replies (per agent, per thread root) in a rolling 10-minute window;
on ≥5, `sendMessage`/`post_thread_reply` MCP tools throw
`STORM_DETECTED` so the agent's runtime can back off. Top-level
posts and DMs are not throttled. (3) AI badge inline in the members
panel — no channel-header redesign.
```

## Out of scope (Phase 7+)

- Per-thread or per-channel mute toggles for individual agents (manual override)
- Admin dashboard for storm-tripped events
- Cross-channel agent rate limits (today: per-thread only)
- A separate "agents" tab in the right panel of `space-chat.tsx` showing live presence

# Agent ↔ Chat Unification — Phase 4: UI Collapse

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make chat the only agent-conversation surface. Teach `SpaceChat` to render agent messages (tool-call cards, citations, model + token footer, inline approval cards) using `metadata.agent_blocks`. Delete the parallel `/agent` route, the `AgentChat` component, and the conversation-list sidebar. Move the approval inbox to a top-level `/approvals` page.

**Architecture:** Add one new component `<AgentMessageBlocks/>` that consumes `metadata.agent_blocks` + `metadata.citations` + `metadata.model`/`tokens_in`/`tokens_out` and renders the structured pieces inline. `SpaceChat` calls it conditionally for messages where `metadata.agent_blocks` exists. Inline approval cards (existing `<ActionCard/>`) get rendered when a message has any pending `agent_actions` keyed by `message_id`. Deletion of `/agent` is mechanical — Phase 2 already made the data layer unified, Phase 3 made the MCP tools unified, so the UI has no functional dependency left on the parallel route.

**Tech Stack:**
- Next.js 14 App Router (`apps/web/src/app/(app)/`)
- React 18 client components, Tailwind CSS
- SWR for client-side data
- `<ActionCard/>` lives in `apps/web/src/components/agent-chat.tsx` today — we extract it to its own file before deleting `agent-chat.tsx`

**Spec:** `docs/superpowers/specs/2026-05-07-agent-chat-unification.md` §8.5 (the new world feels like) + §8.7 step 4 (UI collapse).

**Builds on Phases 1, 2, 3** (all shipped). Phase 5 follows: universal `/inbox`. Phase 6: multi-agent affordances.

---

## Discovery findings (already done)

- Phase 2 made `/api/agent/conversations/:id/messages` return rows with `content_blocks`, `citations`, `tool_calls`, `model`, `tokens_in`, `tokens_out`, `pending_actions[]` — same shape AgentChat consumed historically.
- Phase 2 also made `messages.metadata.agent_blocks` carry the same Anthropic block structure for native chat messages — so `SpaceChat` reading from `/api/messages/:spaceId` gets the structured blocks via the existing API.
- `apps/web/src/components/agent-chat.tsx` (~1200 lines) houses the structured-rendering logic to port: `AgentThinking` (lines 19–51), `ActionCard` (lines 1037–1132), `PlanCard` (lines 1134–1200), citations renderer, follow-up suggestions, model+tokens footer.
- `apps/web/src/components/space-chat.tsx` (~2100 lines) is the chat renderer. Each message is rendered around line 1715–1835 (where `orgMembers` is passed for reaction-name lookup). Find the message-content render block and inject `<AgentMessageBlocks/>` there for agent-authored messages.
- The Agent nav entry is `apps/web/src/components/sidebar.tsx:81` — `{ name: 'Agent', href: '/agent', icon: Bot }`. The `usePendingApprovals` hook drives the red badge (`apps/web/src/hooks/use-pending-approvals.ts`).
- Phase 2 smoke screenshot confirmed the /agent page renders correctly today via the unified backend. Killing it is purely a UI deletion — no data migration, no backend cleanup.
- `/settings/agent` lives at `apps/web/src/app/(app)/settings/agent/page.tsx` and contains both the trust-level selector (per-org) AND the approval inbox. We split: trust selector stays at `/settings/agents` (renamed for clarity); approval inbox moves to `/approvals`.
- `agent_actions.message_id` (Phase 1+2 invariant) links pending actions to chat messages — the same UUID space as `messages.id`. Inline cards just look up `agent_actions WHERE message_id = ${msg.id} AND approval_status = 'pending'`.

---

## File Structure

**New components**
- Create: `apps/web/src/components/agent-message-blocks.tsx` — the structured-rendering for agent messages (text/tool_use/tool_result blocks, model+tokens footer, citations footnotes)
- Create: `apps/web/src/components/agent-action-card.tsx` — extracted `<ActionCard/>` from `agent-chat.tsx` (so it survives the agent-chat.tsx deletion)

**Modified components**
- Modify: `apps/web/src/components/space-chat.tsx` — render `<AgentMessageBlocks/>` for messages where `metadata.agent_blocks` exists; render `<AgentActionCard/>` inline for messages with pending actions
- Modify: `apps/web/src/components/sidebar.tsx` — remove Agent nav entry; add Approvals nav entry; pin Defty DM at top of DMs section

**Deletions**
- Delete: `apps/web/src/app/(app)/agent/` (the entire route directory)
- Delete: `apps/web/src/components/agent-chat.tsx` (after extracting `<ActionCard/>`)
- Delete: `apps/web/src/components/conversation-list.tsx`

**New routes**
- Create: `apps/web/src/app/(app)/approvals/page.tsx` — moved approval inbox

**Modified routes**
- Modify: `apps/web/src/app/(app)/settings/agent/page.tsx` — strip approval-inbox section, leave only trust-level + recent-actions read-only display
- Modify: `apps/web/src/app/(app)/agent/...` — replaced by a redirect (Next.js dynamic redirect or just delete)

**Hooks**
- Modify: `apps/web/src/hooks/use-pending-approvals.ts` — unchanged in shape (it polls /api/agent/actions/pending), just consumed by the new `/approvals` page

**Tests**
- Manual UI smoke is the primary check. Add one Playwright assertion that visiting `/agent` gives a 404 / redirect to `/chat`. Add one assertion that `/approvals` renders with the badge count.

---

## Task 1: Extract `<AgentActionCard/>` from `agent-chat.tsx`

Goal: lift `<ActionCard/>` (the per-action approve/reject card) into its own component file so it survives when `agent-chat.tsx` is deleted in Task 9.

**Files:**
- Create: `apps/web/src/components/agent-action-card.tsx`

- [ ] **Step 1: Read the existing ActionCard**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -nE "^function ActionCard|^export function ActionCard|interface.*ActionCardProps" apps/web/src/components/agent-chat.tsx | head
```

Read 100 lines around the `ActionCard` definition (likely lines 1037–1132). Note imports it relies on (icons, action shape).

- [ ] **Step 2: Copy `ActionCard` into `agent-action-card.tsx`**

Create the new file with the COPIED-OUT component, plus a re-export of any types it depends on. Style:

```typescript
'use client';

import { useState } from 'react';
import { CheckCircle2, XCircle, Loader2, AlertCircle, Undo2 } from 'lucide-react';
// any other imports it needs — copy from agent-chat.tsx

// Copy the type definition for AgentAction from agent-chat.tsx
export type AgentAction = {
  id: string;
  action: string;
  params: Record<string, unknown>;
  approval_status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
  approval_tier?: 'auto' | 'quick' | 'full';
  result?: unknown;
  error?: string | null;
  executed_at?: string | null;
  // Add other fields the existing component reads
};

export type AgentActionCardProps = {
  action: AgentAction;
  onApprove?: (id: string) => Promise<void>;
  onReject?: (id: string) => Promise<void>;
  // Match the existing prop shape — copy from ActionCard's signature
};

export function AgentActionCard(props: AgentActionCardProps) {
  // Paste the body of ActionCard here. Rename internal references if needed.
  // Copy any helper functions that are local to ActionCard (like formatActionLabel,
  // paramSummary, etc.) into this file too.
}
```

The renaming from `ActionCard` to `AgentActionCard` makes the component name reflect what it does. Update internal references accordingly.

If `ActionCard` references helpers from `agent-chat.tsx` (e.g., `formatToolLabel`), copy those helpers into `agent-action-card.tsx` too. Keep the file self-contained.

- [ ] **Step 3: Update `agent-chat.tsx` to use the extracted component**

Replace the inline `ActionCard` definition in `agent-chat.tsx` with:

```typescript
import { AgentActionCard, type AgentAction } from './agent-action-card';
```

And replace JSX usages of `<ActionCard ... />` with `<AgentActionCard ... />`. The existing `agent-chat.tsx` keeps working — this is a refactor, not a behavior change.

- [ ] **Step 4: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/web exec tsc --noEmit 2>&1 | grep -E "agent-action-card|agent-chat" | head
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/web/src/components/agent-action-card.tsx apps/web/src/components/agent-chat.tsx && git commit -m "refactor(web): extract AgentActionCard from agent-chat.tsx

Phase 4 prep — pull the per-action approve/reject card into its own
file so it survives when agent-chat.tsx is deleted later in Phase 4.
No behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Build `<AgentMessageBlocks/>` component

Goal: a new component that renders the structured pieces of an agent message — text + tool-use chips + citations footer + model/tokens footer.

**Files:**
- Create: `apps/web/src/components/agent-message-blocks.tsx`

- [ ] **Step 1: Read AgentChat's rendering for reference**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -nE "AgentThinking|content_blocks|citations\.map|tokens_in" apps/web/src/components/agent-chat.tsx | head -20
```

Note how AgentChat renders:
- The collapsed tool-use chip (probably AgentThinking when in-flight, then a small "✓ tool_name" chip when complete)
- Citations as numbered/bullet list at end of message
- "model_name · 832 tokens" footer

- [ ] **Step 2: Create the component**

Create `apps/web/src/components/agent-message-blocks.tsx`:

```typescript
'use client';

import { useState } from 'react';
import { Wrench, ChevronRight, ChevronDown } from 'lucide-react';

export type AgentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type AgentCitation = {
  type: 'task' | 'message' | 'wiki' | 'event';
  id: string;
  title: string;
  url?: string;
};

export type AgentMessageBlocksProps = {
  blocks?: AgentBlock[];
  citations?: AgentCitation[] | null;
  model?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  /** When true, the assistant text is also passed via children — rely on that and skip text blocks */
  textRenderedSeparately?: boolean;
};

function formatToolLabel(name: string): string {
  // search_tasks → "Search Tasks", create_task → "Create Task"
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function ToolUseChip({ block }: { block: Extract<AgentBlock, { type: 'tool_use' }> }) {
  const [open, setOpen] = useState(false);
  const label = formatToolLabel(block.name);
  return (
    <button
      onClick={() => setOpen((o) => !o)}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium mr-1 mb-1"
      style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)' }}
    >
      {open ? <ChevronDown size={11} strokeWidth={1.5} /> : <ChevronRight size={11} strokeWidth={1.5} />}
      <Wrench size={11} strokeWidth={1.5} />
      <span>{label}</span>
      {open && block.input && (
        <pre
          className="mt-1 ml-2 text-[10px] font-mono whitespace-pre-wrap"
          style={{ color: 'var(--foreground)' }}
        >
          {JSON.stringify(block.input, null, 2)}
        </pre>
      )}
    </button>
  );
}

export function AgentMessageBlocks({
  blocks,
  citations,
  model,
  tokens_in,
  tokens_out,
  textRenderedSeparately,
}: AgentMessageBlocksProps) {
  const toolUses = (blocks ?? []).filter((b): b is Extract<AgentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
  const showTokensFooter = !!model || !!tokens_in || !!tokens_out;
  const hasCitations = !!citations && citations.length > 0;

  return (
    <div className="agent-message-blocks">
      {toolUses.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1 mb-1">
          {toolUses.map((b) => (
            <ToolUseChip key={b.id} block={b} />
          ))}
        </div>
      )}

      {hasCitations && (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--muted)' }}>
          <span className="uppercase tracking-wide opacity-70 mr-2">Sources</span>
          {citations!.map((c, i) => (
            <a
              key={c.id}
              href={c.url ?? '#'}
              className="underline-offset-2 mr-2 hover:underline"
              style={{ color: 'var(--accent)' }}
            >
              [{i + 1}] {c.title}
            </a>
          ))}
        </div>
      )}

      {showTokensFooter && (
        <details className="mt-1.5 text-[10px]" style={{ color: 'var(--muted)' }}>
          <summary className="cursor-pointer">details</summary>
          <div className="mt-0.5 font-mono">
            {model && <span>{model}</span>}
            {model && (tokens_in || tokens_out) && <span> · </span>}
            {(tokens_in != null || tokens_out != null) && (
              <span>
                {tokens_in ?? 0}/{tokens_out ?? 0} tokens
              </span>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
```

If the existing AgentChat renders citations as numbered footnotes inline within the assistant text (`[1]`, `[2]` markers), match that pattern instead — read AgentChat's citation render block for the canonical style.

- [ ] **Step 3: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/web exec tsc --noEmit 2>&1 | grep -E "agent-message-blocks" | head
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/web/src/components/agent-message-blocks.tsx && git commit -m "feat(web): AgentMessageBlocks component for inline structured rendering

Phase 4 of agent-chat unification. Renders tool-use chips (collapsible),
citations as a 'Sources' footer, and an expandable model+tokens detail.
Used by SpaceChat for messages with metadata.agent_blocks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: SpaceChat renders `<AgentMessageBlocks/>` for agent messages

Goal: when SpaceChat renders a message whose author is an agent (or whose `metadata.agent_blocks` is present), inject the structured rendering after the message text.

**Files:**
- Modify: `apps/web/src/components/space-chat.tsx`

- [ ] **Step 1: Find the message render block**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -nE "metadata|content_blocks|agent_blocks|message_renderer|render-message" apps/web/src/components/space-chat.tsx | head -20
```

The message rendering happens in a `messages.map((message, idx) => ...)` block. Find where the message body (the text bubble) is rendered.

- [ ] **Step 2: Import the new component + agent detection helper**

At the top of `space-chat.tsx`:

```typescript
import { AgentMessageBlocks, type AgentBlock, type AgentCitation } from './agent-message-blocks';
```

- [ ] **Step 3: Add the conditional render**

Inside the message map, after the existing message-body render, add:

```typescript
{(() => {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  const blocks = meta.agent_blocks as AgentBlock[] | undefined;
  const citations = meta.citations as AgentCitation[] | null | undefined;
  if (!blocks && !citations && !meta.model) return null;
  return (
    <AgentMessageBlocks
      blocks={blocks}
      citations={citations ?? null}
      model={(meta.model as string) ?? null}
      tokens_in={(meta.tokens_in as number) ?? null}
      tokens_out={(meta.tokens_out as number) ?? null}
    />
  );
})()}
```

Place it right after the text-bubble render so the chips appear underneath the message text.

- [ ] **Step 4: Filter tool_result rows from rendering**

Earlier in the same `messages.map`, add a guard that hides tool_result messages from the chat stream:

```typescript
{messages
  .filter((m) => {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    return meta.kind !== 'tool_result' && meta.hidden !== true;
  })
  .map((message, idx) => (
    // ... existing render
  ))}
```

The Phase 2 backend writes tool_result rows to messages with `metadata.kind = 'tool_result'`. Without this filter, they'd render as empty bubbles in chat. The /agent route already filters them server-side, but native chat renders directly.

- [ ] **Step 5: Smoke test**

Open a chat (e.g., `/chat?space=<general>`) in the browser and send `@deft what is 2+2?`. Defty replies should now render:
- Standard message bubble with the assistant text
- Inline tool-use chip (if Defty called any tools)
- Optional model+tokens detail expandable below

Take a screenshot.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/web/src/components/space-chat.tsx && git commit -m "feat(web): SpaceChat renders AgentMessageBlocks for agent messages

Phase 4 of agent-chat unification. Agent messages with
metadata.agent_blocks now render with tool-use chips, citations
footer, and model+tokens detail inline. Tool-result rows are
filtered out (their content has no value to humans rendering).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Inline approval cards in SpaceChat

Goal: when a message has any pending `agent_actions` keyed by `message_id`, render the `<AgentActionCard/>` inline below the message.

**Files:**
- Modify: `apps/web/src/components/space-chat.tsx`

- [ ] **Step 1: Add an SWR hook for pending actions per space**

The simplest approach: have SpaceChat fetch pending actions for messages currently visible and key by `message_id`. Add a fetcher near the top of the component:

```typescript
import useSWR from 'swr';
import { AgentActionCard, type AgentAction } from './agent-action-card';

// Inside the SpaceChat component:
const { data: pendingByMessageId } = useSWR(
  spaceId ? `/api/agent-actions/pending-by-message?space_id=${spaceId}` : null,
  async (url: string) => {
    const res = await api.get(url);
    if (!res.ok) return {};
    const list: Array<AgentAction & { message_id: string }> = await res.json();
    const map: Record<string, AgentAction[]> = {};
    for (const a of list) {
      if (!a.message_id) continue;
      (map[a.message_id] ??= []).push(a);
    }
    return map;
  },
  { refreshInterval: 5000 },
);
```

This requires a NEW API endpoint that returns pending actions for messages in a given space.

- [ ] **Step 2: Add the API endpoint**

Modify: `apps/api/src/routes/agent.ts` (or wherever the `/api/agent/actions` routes live — verify with grep).

Add a new GET handler:

```typescript
agentRoutes.get('/actions/pending-by-space', async (c) => {
  const user = c.get('user');
  const spaceId = c.req.query('space_id');
  if (!spaceId) {
    return c.json({ error: 'space_id required', code: 'VALIDATION_ERROR' }, 400);
  }
  // Membership check
  const [m] = await db.select({ id: spaceMembers.id })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.space_id, spaceId), eq(spaceMembers.user_id, user.id)))
    .limit(1);
  if (!m) {
    return c.json([], 200);
  }
  // Fetch pending actions whose message_id is in this space
  const rows = await db.execute(sql`
    SELECT a.*
    FROM agent_actions a
    JOIN messages m ON m.id = a.message_id
    WHERE m.space_id = ${spaceId}
      AND m.org_id = ${user.org_id}
      AND a.approval_status = 'pending'
    ORDER BY a.created_at DESC
    LIMIT 100
  `);
  return c.json(rows.rows);
});
```

Adjust the import (`spaceMembers`, `agent_actions`, `messages`, `sql`) and the route mount path. Match the existing pattern on the file.

- [ ] **Step 3: Render `<AgentActionCard/>` inline**

In SpaceChat's message map, after the `<AgentMessageBlocks/>` render from Task 3, add:

```typescript
{pendingByMessageId?.[message.id]?.map((action) => (
  <AgentActionCard
    key={action.id}
    action={action}
    onApprove={async (id) => {
      await api.post(`/api/agent-actions/${id}/approve`, {});
      // Trigger SWR revalidation
      mutate(`/api/agent-actions/pending-by-message?space_id=${spaceId}`);
    }}
    onReject={async (id) => {
      await api.post(`/api/agent-actions/${id}/reject`, {});
      mutate(`/api/agent-actions/pending-by-message?space_id=${spaceId}`);
    }}
  />
))}
```

If `mutate` isn't already imported, add `import { mutate } from 'swr';` at the top.

- [ ] **Step 4: Smoke test**

Open a chat where Defty has been invoked with a quick-tier action (e.g., `@deft create a task called "phase 4 smoke test"`). The reply should include an inline approval card with Approve / Reject buttons.

Click Approve and verify (a) the card disappears, (b) a new task appears in the tasks list.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/web/src/components/space-chat.tsx apps/api/src/routes/agent.ts && git commit -m "feat: inline approval cards in chat

Phase 4 of agent-chat unification. SpaceChat fetches pending
agent_actions per space and renders AgentActionCard inline below
messages with pending approvals. Approving/rejecting from chat
hits the existing /api/agent-actions/:id/{approve,reject} endpoints
and revalidates the SWR cache.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Pin Defty DM at top of sidebar DMs section

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx`

- [ ] **Step 1: Find the DMs section + member sort**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -nE "Direct Messages|orgMembers\\.filter\\(\\(m\\)|agentEmployees\\.some" apps/web/src/components/sidebar.tsx | head -10
```

Read the DMs section (around lines 197–300).

- [ ] **Step 2: Sort agents (with Defty pinned) before humans**

The current sort excludes `agent_employees` shadow users entirely (line 209). Update to include them, then sort: Defty first, other agents next, humans last. Identify Defty by `member.email === 'deft-agent@system.local'` (the canonical email per Phase 1).

Replace the existing filter chain:

```typescript
{orgMembers
  .filter((m) => m.id !== user?.id)
  .filter((m) => !agentEmployees.some((e) => e.user_id === m.id))
  .map((member) => { /* ... */ })
}
```

With:

```typescript
{orgMembers
  .filter((m) => m.id !== user?.id)
  .sort((a, b) => {
    // Defty pinned at top
    if (a.email === 'deft-agent@system.local') return -1;
    if (b.email === 'deft-agent@system.local') return 1;
    // Then other agents
    const aAgent = a.kind === 'agent';
    const bAgent = b.kind === 'agent';
    if (aAgent && !bAgent) return -1;
    if (!aAgent && bAgent) return 1;
    // Then alphabetical
    return a.name.localeCompare(b.name);
  })
  .map((member) => { /* ... */ })
}
```

The `kind` field comes from `/api/members` (Phase 1 added it). Make sure the `Member` type defined in this file (or imported) includes `kind?: string` and `email?: string | null`.

- [ ] **Step 3: Render an "AI" badge on agent rows in the sidebar**

Inside the row render, add a small badge for `member.kind === 'agent'`:

```typescript
{member.kind === 'agent' && (
  <span
    className="text-[9px] px-1 py-0 rounded-full ml-auto"
    style={{ background: 'var(--surface)', color: 'var(--muted)' }}
  >
    AI
  </span>
)}
```

- [ ] **Step 4: Smoke**

Refresh the browser. The DMs section should show Defty pinned at the top, followed by any BYOA agents, followed by humans alphabetically.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/web/src/components/sidebar.tsx && git commit -m "feat(web): pin Defty + group agents at top of sidebar DMs

Phase 4 of agent-chat unification. Defty's DM is pinned at the top of
the Direct Messages section, then other BYOA agents (kind='agent')
sorted alphabetically, then humans. Agent rows show a small AI badge.
The previous filter that excluded agents from the DMs list is removed
since chat is now the agent surface.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Move approval inbox to `/approvals` top-level route

**Files:**
- Create: `apps/web/src/app/(app)/approvals/page.tsx`
- Modify: `apps/web/src/app/(app)/settings/agent/page.tsx` (strip approval section, leave trust-level + recent-actions read-only)

- [ ] **Step 1: Read the existing settings/agent page**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && wc -l apps/web/src/app/\(app\)/settings/agent/page.tsx && grep -nE "Approval|trust|pending" apps/web/src/app/\(app\)/settings/agent/page.tsx | head -15
```

Identify the approval-inbox JSX block (rows of pending agent_actions with approve/reject buttons).

- [ ] **Step 2: Copy the approval-inbox section into a new page**

Create `apps/web/src/app/(app)/approvals/page.tsx`. Copy the approval-inbox section from `settings/agent/page.tsx`. Wrap it in the standard page layout (header, scrolling container).

```typescript
'use client';

import { usePendingApprovals } from '@/hooks/use-pending-approvals';
import { AgentActionCard } from '@/components/agent-action-card';
import { api } from '@/lib/api';

export default function ApprovalsPage() {
  const { actions, refetch } = usePendingApprovals();

  const handleApprove = async (id: string) => {
    await api.post(`/api/agent-actions/${id}/approve`, {});
    refetch();
  };
  const handleReject = async (id: string) => {
    await api.post(`/api/agent-actions/${id}/reject`, {});
    refetch();
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold" style={{ color: 'var(--foreground)' }}>
          Approvals
        </h1>
        <p className="text-[13px] mt-1" style={{ color: 'var(--muted)' }}>
          Pending agent actions awaiting your review.
        </p>
      </header>

      {!actions || actions.length === 0 ? (
        <div className="text-[13px] py-12 text-center" style={{ color: 'var(--muted)' }}>
          No pending approvals.
        </div>
      ) : (
        <div className="flex flex-col gap-3 max-w-[640px]">
          {actions.map((action) => (
            <AgentActionCard
              key={action.id}
              action={action}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

(Adapt to whatever `usePendingApprovals` returns — the hook lives at `apps/web/src/hooks/use-pending-approvals.ts`. If its return shape differs, match.)

- [ ] **Step 3: Strip the approval section from `/settings/agent`**

Open `apps/web/src/app/(app)/settings/agent/page.tsx` and DELETE the approval-inbox JSX block (the table of pending agent_actions). Leave:
- Trust-level selector
- Recent-actions read-only display (executed/approved/rejected — non-actionable)

Add at the top of the page a small banner pointing users to the new location:

```typescript
<div
  className="mb-4 px-4 py-3 rounded-lg text-[13px]"
  style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
>
  Pending approvals moved to <a href="/approvals" className="underline">/approvals</a>.
</div>
```

- [ ] **Step 4: Add Approvals to sidebar nav**

In `apps/web/src/components/sidebar.tsx`, replace the Agent nav entry:

```typescript
{ name: 'Agent', href: '/agent', icon: Bot },
```

With:

```typescript
{ name: 'Approvals', href: '/approvals', icon: ShieldCheck },
```

(`ShieldCheck` from `lucide-react` — already imported probably; verify and add if not.)

The badge logic (`usePendingApprovals` count next to "Agent" in the existing sidebar) carries over to "Approvals" — point it at the same nav entry.

- [ ] **Step 5: Smoke**

Visit `/approvals` — see pending approvals (or empty state).
Visit `/settings/agent` — see trust + recent actions, no longer the approval inbox.
Sidebar shows "Approvals" entry with the red badge if there are pending approvals.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add apps/web/src/app/\(app\)/approvals/page.tsx apps/web/src/app/\(app\)/settings/agent/page.tsx apps/web/src/components/sidebar.tsx && git commit -m "feat(web): move approval inbox to /approvals top-level route

Phase 4 of agent-chat unification. Pending approvals get a
dedicated top-level surface; settings/agent becomes a thin trust +
read-only-recent view with a banner pointing to /approvals. Sidebar
nav swaps the 'Agent' entry for 'Approvals' — same red badge.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Delete the `/agent` route

**Files:**
- Delete: entire `apps/web/src/app/(app)/agent/` directory

- [ ] **Step 1: Inventory what's in the route**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && find "apps/web/src/app/(app)/agent" -type f
```

Note all files (page.tsx, any subfolders, etc.).

- [ ] **Step 2: Find every place that links to /agent**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -rnE "href.*=.*[\"'/]agent[\"']|router\.push.*[\"'/]agent[\"']|/agent/conversations" apps/web/src 2>&1 | grep -v "node_modules\|/agent-employees" | head -20
```

(Excluding `/agent-employees` which is a different settings page.)

- [ ] **Step 3: Update internal links**

For each `href="/agent"` or `router.push('/agent')`, decide:
- If the link goes to the conversation list → redirect to `/chat` (the user can reach their Defty DM there)
- If the link goes to a specific conversation → redirect to `/chat?space=<id>` (since Phase 2 made conversation-id == space-id)

For the `usePendingApprovals` hook badge — already remapped in Task 6.

- [ ] **Step 4: Delete the route directory**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git rm -rf "apps/web/src/app/(app)/agent" 2>&1 | head -10
```

- [ ] **Step 5: Verify no build errors**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/web exec tsc --noEmit 2>&1 | tail -20
```

Pre-existing errors are fine. New errors caused by the deletion (e.g., dangling imports of components that lived under /agent) need to be fixed.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add -A && git commit -m "feat(web): delete /agent route — chat is the agent surface

Phase 4 of agent-chat unification. The /agent route is gone;
all agent conversations now live in chat (Defty DM, BYOA agent
DMs, agent participation in spaces). Internal links updated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Delete `AgentChat` and `conversation-list` components

**Files:**
- Delete: `apps/web/src/components/agent-chat.tsx`
- Delete: `apps/web/src/components/conversation-list.tsx`

- [ ] **Step 1: Confirm no remaining imports**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && grep -rnE "agent-chat|conversation-list|<AgentChat|<ConversationList" apps/web/src 2>&1 | grep -v "node_modules\|agent-action-card\|agent-message-blocks" | head
```

If matches remain (other than the soon-to-be-deleted files themselves), update those imports to remove the dependency. The /agent route deletion in Task 7 should have removed the only callers.

- [ ] **Step 2: Delete**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git rm apps/web/src/components/agent-chat.tsx apps/web/src/components/conversation-list.tsx
```

- [ ] **Step 3: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/web exec tsc --noEmit 2>&1 | tail -10
```

Should be clean (or only show pre-existing errors).

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git commit -m "feat(web): delete AgentChat + ConversationList components

Phase 4 of agent-chat unification. Their content was extracted
to AgentMessageBlocks + AgentActionCard, or absorbed by SpaceChat
+ the new /approvals page.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Self-review + smoke + CLAUDE.md

- [ ] **Step 1: Run all Phase 1 + 2 + 3 backend tests**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification/apps/api" && pnpm exec tsx --test test/user-kind-migration.test.ts test/members-kind-field.test.ts test/ensure-defty-membership.test.ts test/agent-mention-detection.test.ts test/ensure-agent-conversation-space.test.ts test/mcp-send-message.test.ts test/mcp-fetch-unread.test.ts 2>&1 | tail -10
```

Expected: 31 pass.

- [ ] **Step 2: Web typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && pnpm --filter @deft/web exec tsc --noEmit 2>&1 | tail -10
```

Phase 4 didn't introduce new errors. Pre-existing errors in dashboard-grid.tsx / clip-recorder.tsx remain out of scope.

- [ ] **Step 3: UI smoke**

Open the browser:
- Sidebar: "Approvals" entry replaces "Agent". Defty pinned at top of DMs section. Other BYOA agents next, with AI badges.
- Click Defty's DM. Send `what are my open tasks?`. Reply renders with tool-use chip + model footer below.
- If reply triggers a quick-approve action, an inline approval card appears.
- Visit `/agent` — should 404 or redirect to /chat.
- Visit `/approvals` — see pending actions (or empty state).

Take 2–3 screenshots of the new chat-as-agent-surface.

- [ ] **Step 4: Update CLAUDE.md**

Append a Phase 4 paragraph in the Agent Architecture section, after the Phase 3 paragraph:

```markdown


**Phase 4 (2026-05-07).** UI collapse: the dedicated `/agent` route
and `AgentChat` / `ConversationList` components are deleted. Chat is
now the only agent-conversation surface — `SpaceChat` renders agent
messages with inline tool-use chips, citations footer, and model+tokens
detail via the new `<AgentMessageBlocks/>` component. Inline approval
cards (`<AgentActionCard/>`, extracted from the deleted AgentChat)
render on chat messages with pending `agent_actions`. The approval
inbox moved from `/settings/agent` to a top-level `/approvals` page;
the sidebar nav entry swapped "Agent" for "Approvals" with the same
red-badge count. Defty DM is pinned at the top of the Direct Messages
section, followed by other BYOA agents.
```

- [ ] **Step 5: Commit CLAUDE.md**

```bash
cd "C:/Users/Osheen Pradhan/cairn/.claude/worktrees/phase1-agent-chat-unification" && git add CLAUDE.md && git commit -m "docs(claude): note Phase 4 UI collapse

Phase 4 has shipped: /agent route deleted, AgentChat absorbed
into SpaceChat, /approvals top-level route added.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review checklist

**Spec coverage** — every line from §8.7 step 4:
- [x] SpaceChat learns to render metadata.agent_blocks → Tasks 2 + 3
- [x] Inline approval cards → Tasks 1 + 4
- [x] Sidebar Defty pinned → Task 5
- [x] /agent route deleted → Task 7
- [x] /settings/agent slimmed → Task 6
- [x] Approval inbox moves to /approvals → Task 6
- [x] AgentChat deleted → Task 8

**Type consistency:**
- `AgentBlock`, `AgentCitation`, `AgentMessageBlocksProps` consistent across the new component file and its callers
- `AgentAction` type re-exported from `agent-action-card.tsx` so SpaceChat + ApprovalsPage import from the same place

**Risks:**
- The approval cards in chat could be noisy if a single agent turn produces many actions. Mitigated by the pending-approval filter (only show non-resolved). Multi-action plans render the existing PlanCard if AgentChat had one — Phase 4's minimum doesn't port PlanCard explicitly. If needed, port `<PlanCard/>` similarly to ActionCard in a follow-up.

---

## Phase 5 hand-off

Phase 5 (next) builds the universal `/inbox` page that unifies mentions, DMs, watcher notifications, task assignments, and pending approvals into one queue. Phase 4 ships the inline-in-chat approval surface; Phase 5 ships the bulk-review surface.

# Agent Conversation Bug Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 9 bugs found during Playwright testing of agent conversations, sidebar filtering, hidden messages, and action persistence.

**Architecture:** Three categories of fixes: (1) data backfill migrations for legacy rows missing new columns, (2) desktop sidebar integration with tab state, (3) UX polish for scroll and refresh behavior.

**Tech Stack:** PostgreSQL, Next.js 14, React, TypeScript

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `migration-agent-backfill.sql` | Create | Backfill legacy data — hide synthesis messages, link orphan actions |
| `apps/web/src/components/sidebar.tsx` | Modify | Wire `AgentSidebarContent` to active tab, refresh on tab change and new conversations |
| `apps/web/src/app/(app)/agent/page.tsx` | Modify | Expose active tab to sidebar via URL, listen for conversation-created events |
| `apps/web/src/components/agent-chat.tsx` | Modify | Scroll to top (not bottom) when loading an existing conversation; emit conversation-created event |

---

### Task 1: Backfill Migration — Legacy Data Cleanup

**Files:**
- Create: `migration-agent-backfill.sql`

Fixes BUG-1 (old conversations missing `agent_employee_id` leave all past chats under Defty), BUG-2 (legacy `[System:` synthesis messages still render as user messages), BUG-3 (old `agent_actions` rows have no `message_id` so plans don't render on reload).

- [ ] **Step 1: Create the migration SQL file**

Create `migration-agent-backfill.sql` in the project root:

```sql
-- Backfill for legacy agent conversation data
-- 1. Hide legacy synthesis messages so they don't render as user input
UPDATE agent_messages
SET hidden = true
WHERE role = 'user'
  AND content LIKE '[System:%'
  AND hidden = false;

-- 2. Link orphan agent_actions to the most recent assistant message in their conversation
-- For each action with NULL message_id, set it to the latest assistant message
-- created at or before the action's created_at in the same conversation
UPDATE agent_actions AS a
SET message_id = (
  SELECT m.id
  FROM agent_messages m
  WHERE m.conversation_id = a.conversation_id
    AND m.role = 'assistant'
    AND m.created_at <= a.created_at
  ORDER BY m.created_at DESC
  LIMIT 1
)
WHERE a.message_id IS NULL
  AND a.conversation_id IS NOT NULL;
```

- [ ] **Step 2: Run the migration against the database**

Run: `"/c/Program Files/PostgreSQL/16/bin/psql.exe" --dbname="postgres://postgres:postgres@localhost:5432/cairn" --file="migration-agent-backfill.sql"`
Expected: `UPDATE N` for each statement, no errors.

- [ ] **Step 3: Verify with API**

Fetch a conversation known to have legacy synthesis messages and confirm `hidden: true` is set, and that actions come through in `pending_actions`:

```bash
TOKEN=$(curl -s http://localhost:3001/api/auth/login -H 'Content-Type: application/json' -d '{"email":"maneek@test.com","password":"test1234"}' | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).accessToken)}catch{console.log('')}})")

curl -s "http://localhost:3001/api/agent/conversations/41a50067-fda3-4893-a5dd-922996f54110/messages" -H "Authorization: Bearer $TOKEN" | node -e "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const m=JSON.parse(d);console.log('Count:',m.length);m.forEach((x,i)=>console.log(i+1,x.role,'| hidden:',x.hidden,'| actions:',(x.pending_actions||[]).length))})"
```

Expected: The `[System: ...]` user message should no longer appear (hidden now). Pending actions should be > 0 on assistant messages with plans.

- [ ] **Step 4: Commit**

```bash
git add migration-agent-backfill.sql
git commit -m "fix(data): backfill legacy synthesis messages and orphan actions"
```

---

### Task 2: Desktop Sidebar — Filter by Active Agent

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx`

Fixes BUG-5 (desktop sidebar shows all conversations regardless of active tab) and BUG-6 (sidebar doesn't refresh when tab changes).

- [ ] **Step 1: Read the agent sidebar section of sidebar.tsx**

Find `AgentSidebarContent` in `apps/web/src/components/sidebar.tsx`. It currently fetches `/api/agent/conversations` unfiltered.

- [ ] **Step 2: Read active tab from URL**

At the top of `AgentSidebarContent`, read `useSearchParams`:

```typescript
import { useSearchParams } from 'next/navigation';

function AgentSidebarContent({ onNav }: { onNav?: () => void }) {
  const searchParams = useSearchParams();
  const activeTab = searchParams.get('employee') || 'defty';
  // ... rest of component
}
```

- [ ] **Step 3: Filter conversation fetch by active tab**

Find the existing conversations fetch (likely `api.get('/api/agent/conversations')` inside a `useEffect`). Change to include the employee filter when on an employee tab, and re-run when `activeTab` changes:

```typescript
useEffect(() => {
  const url = activeTab === 'defty'
    ? '/api/agent/conversations'
    : `/api/agent/conversations?employee=${activeTab}`;
  api.get(url).then(async (res) => {
    if (res.ok) {
      const data = await res.json();
      setConversations(data);
    }
  });
}, [activeTab]);
```

- [ ] **Step 4: Ensure "New conversation" link preserves the active tab**

If there's a "New conversation" link in the sidebar, update its href so clicking it on an employee tab stays on that employee's context:

```typescript
<Link href={activeTab === 'defty' ? '/agent' : `/agent?employee=${activeTab}`}>
  New conversation
</Link>
```

- [ ] **Step 5: Ensure conversation links include the employee param**

Find the conversation link rendering in `AgentSidebarContent`. Update the href to include `&employee=<id>` when the conversation has an `agent_employee_id`:

```typescript
<Link
  href={conv.agent_employee_id
    ? `/agent?id=${conv.id}&employee=${conv.agent_employee_id}`
    : `/agent?id=${conv.id}`}
  ...
>
```

This should already be in place from the previous sidebar badge fix — verify it.

- [ ] **Step 6: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/sidebar.tsx
git commit -m "fix(sidebar): filter agent conversations by active tab"
```

---

### Task 3: Sidebar Refresh on New Conversation

**Files:**
- Modify: `apps/web/src/components/sidebar.tsx`
- Modify: `apps/web/src/components/agent-chat.tsx`

Fixes BUG-9 (newly created conversations don't appear in the sidebar until full page refresh).

- [ ] **Step 1: Emit a conversation-created custom event from AgentChat**

In `apps/web/src/components/agent-chat.tsx`, find the lazy conversation creation block (the `api.post('/api/agent/conversations', ...)` call inside `sendMessage`). After `onConversationCreated` fires, also dispatch a browser custom event so the sidebar can listen:

```typescript
if (onConversationCreated) onConversationCreated(convId!);
// Notify sidebar to refresh its conversation list
window.dispatchEvent(new CustomEvent('agent-conversation-created'));
```

- [ ] **Step 2: Listen for the event in the sidebar**

In `AgentSidebarContent`, extract the fetch into a reusable function and call it both on mount and on the custom event:

```typescript
const fetchConversations = useCallback(async () => {
  const url = activeTab === 'defty'
    ? '/api/agent/conversations'
    : `/api/agent/conversations?employee=${activeTab}`;
  const res = await api.get(url);
  if (res.ok) {
    const data = await res.json();
    setConversations(data);
  }
}, [activeTab]);

useEffect(() => {
  fetchConversations();
}, [fetchConversations]);

useEffect(() => {
  const handler = () => fetchConversations();
  window.addEventListener('agent-conversation-created', handler);
  return () => window.removeEventListener('agent-conversation-created', handler);
}, [fetchConversations]);
```

Import `useCallback` from `react` if not already imported.

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/sidebar.tsx apps/web/src/components/agent-chat.tsx
git commit -m "fix(sidebar): auto-refresh conversation list on new conversation"
```

---

### Task 4: Scroll Behavior on Conversation Load

**Files:**
- Modify: `apps/web/src/components/agent-chat.tsx`

Fixes BUG-4 (loading an existing conversation auto-scrolls to bottom, hiding the user's original question).

- [ ] **Step 1: Find the message load effect**

In `apps/web/src/components/agent-chat.tsx`, find the `useEffect` that fetches messages when `conversationId` changes. It currently calls `setTimeout(scrollToBottom, 100)` after loading.

- [ ] **Step 2: Scroll to top instead of bottom when loading a conversation**

Replace the scroll-to-bottom call with scroll-to-top for loaded conversations (not live streams):

```typescript
api.get(`/api/agent/conversations/${conversationId}/messages`).then(async (res) => {
  if (res.ok) {
    const data = await res.json();
    setMessages(data.map((m: any) => ({
      id: m.id, role: m.role, content: m.content,
      citations: m.citations || [],
      pending_actions: (m.pending_actions || []).map((a: any) => ({
        id: a.id, action: a.action, params: a.params,
        approval_tier: a.approval_tier, status: a.status,
        result: a.result, executed_at: a.executed_at, error: a.error,
      })),
      auto_executed: [],
      model: m.model, tokens_in: m.tokens_in, tokens_out: m.tokens_out,
    })));
  }
  setLoading(false);
  // Scroll to the top so the user sees their original question first
  setTimeout(() => {
    const container = scrollRef.current;
    if (container) container.scrollTop = 0;
  }, 100);
});
```

Note: `scrollToBottom` should still fire during live streaming when new messages arrive — don't change that behavior, only the initial-load scroll.

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && pnpm typecheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/agent-chat.tsx
git commit -m "fix(agent-chat): scroll to top when loading existing conversation"
```

---

## Verification

After all tasks:

1. `cd apps/web && pnpm typecheck` — must pass
2. Manual verification:

**BUG-1, BUG-2, BUG-3 (backfill):**
- Navigate to an old conversation that had a plan (e.g., `41a50067-fda3-4893-a5dd-922996f54110`)
- Verify the user's question appears at the top
- Verify NO `[System: The approved actions...]` message shows
- Verify the Plan card with green checkmarks renders

**BUG-5, BUG-6 (sidebar filtering):**
- On the Defty tab, the desktop sidebar shows only Defty-tagged conversations
- Click the Alex PM tab — sidebar re-fetches and shows only Alex PM conversations
- Legacy conversations with `agent_employee_id = NULL` appear under Defty (which is correct default behavior)

**BUG-9 (sidebar refresh):**
- Start a new conversation on Defty — the new conversation appears at the top of the sidebar immediately (no refresh needed)
- Same on Alex PM tab

**BUG-4 (scroll):**
- Open an existing conversation with multiple messages — the user's first question is visible at the top
- Scroll to bottom manually — the latest assistant response is still reachable
- Send a new message in the same conversation — live streaming scrolls to bottom as expected

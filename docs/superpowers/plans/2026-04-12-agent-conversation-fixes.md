# Agent Conversation UI & Storage Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 10 issues with agent conversation UI, storage, and UX. Make conversations properly scoped to their agent, hide synthesis messages, restore approval UI on reload, and clean up the sidebar experience.

**Architecture:** Add `agent_employee_id` to `agent_conversations`, filter conversations by active tab, persist approved action results in message metadata, and add a `hidden` flag on messages to exclude synthesis prompts from display.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL, Hono, Next.js 14, React

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/db/src/schema.ts` | Modify | Add `agent_employee_id` to agent_conversations; add `hidden` to agent_messages |
| `apps/api/src/routes/agent.ts` | Modify | Filter conversations by employee, accept employee on create, skip hidden messages, persist synthesis results |
| `apps/api/src/lib/agent-actions.ts` | Modify | Update message metadata when action completes |
| `apps/web/src/app/(app)/agent/page.tsx` | Modify | Route sidebar clicks to correct tab, pass conversationId to employee AgentChat |
| `apps/web/src/components/agent-chat.tsx` | Modify | Send hidden flag, skip hidden messages on load, restore approval UI from metadata, per-agent placeholder |

---

### Task 1: Schema — agent_employee_id on conversations + hidden on messages

**Files:**
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Add `agent_employee_id` to agentConversations**

Find the `agentConversations` table definition (around line 338-344). Add after `user_id`:

```typescript
agent_employee_id: text('agent_employee_id'),
```

Leave it nullable — NULL means a Defty conversation.

- [ ] **Step 2: Add `hidden` column to agentMessages**

Find the `agentMessages` table (around line 347-355). Add after `tool_calls`:

```typescript
hidden: boolean('hidden').default(false).notNull(),
```

Hidden messages are stored (for conversation history/audit) but never rendered in the UI. Used for synthesis prompts.

- [ ] **Step 3: Run migration SQL**

Create `migration-agent-conv-fixes.sql`:

```sql
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS agent_employee_id text;
ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
```

Run: `"/c/Program Files/PostgreSQL/16/bin/psql.exe" --dbname="postgres://postgres:postgres@localhost:5432/deft" --file="migration-agent-conv-fixes.sql"`

- [ ] **Step 4: Typecheck**

Run: `cd packages/db && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat(schema): add agent_employee_id to conversations, hidden to messages"
```

---

### Task 2: Backend — Conversation filtering + create with employee

**Files:**
- Modify: `apps/api/src/routes/agent.ts`

- [ ] **Step 1: Read the GET /conversations handler**

Find `agentRoutes.get('/conversations'` in the agent.ts routes file. It currently returns all conversations for the user.

- [ ] **Step 2: Filter conversations by employee query param**

Change the handler to accept an optional `?employee=<id>` query param. When present, filter by `agent_employee_id = employee`. When omitted, filter by `agent_employee_id IS NULL` (Defty only).

```typescript
agentRoutes.get('/conversations', async (c) => {
  const user = c.get('user');
  const employeeFilter = c.req.query('employee');
  
  const baseWhere = [eq(agentConversations.user_id, user.id), eq(agentConversations.org_id, user.org_id)];
  if (employeeFilter) {
    baseWhere.push(eq(agentConversations.agent_employee_id, employeeFilter));
  } else {
    baseWhere.push(isNull(agentConversations.agent_employee_id));
  }
  
  const convos = await db
    .select()
    .from(agentConversations)
    .where(and(...baseWhere))
    .orderBy(desc(agentConversations.updated_at))
    .limit(50);
  return c.json(convos);
});
```

Add `isNull` to the drizzle imports at the top of the file.

- [ ] **Step 3: Accept agent_employee_id when creating a conversation**

Find `agentRoutes.post('/conversations'`. Accept optional `agent_employee_id` in the request body. Store it on the record.

```typescript
agentRoutes.post('/conversations', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const [created] = await db
    .insert(agentConversations)
    .values({
      org_id: user.org_id,
      user_id: user.id,
      agent_employee_id: body.agent_employee_id || null,
    })
    .returning();
  return c.json(created);
});
```

- [ ] **Step 4: Message loading skips hidden messages**

Find `agentRoutes.get('/conversations/:id/messages'`. Add a filter to exclude hidden messages:

```typescript
.where(and(
  eq(agentMessages.conversation_id, conversationId),
  eq(agentMessages.hidden, false),
))
```

- [ ] **Step 5: Accept hidden flag when saving messages**

Find where the streaming endpoint saves the user message to `agentMessages`. The request body should accept an optional `hidden` field:

```typescript
const { content, agent_employee_id, hidden } = await c.req.json();
// ...
await db.insert(agentMessages).values({
  conversation_id: conversationId,
  role: 'user',
  content,
  hidden: hidden || false,
});
```

- [ ] **Step 6: Link new conversations to employee if employee_id in body**

If a message is being streamed and the conversation has no `agent_employee_id`, but the body includes one, update the conversation:

```typescript
if (agent_employee_id && !existingConversation.agent_employee_id) {
  await db.update(agentConversations)
    .set({ agent_employee_id })
    .where(eq(agentConversations.id, conversationId));
}
```

Place this near where the conversation is loaded in the streaming handler.

- [ ] **Step 7: Typecheck and commit**

Run: `cd apps/api && pnpm typecheck`

```bash
git add apps/api/src/routes/agent.ts
git commit -m "feat(agent): filter conversations by employee, support hidden messages"
```

---

### Task 3: Backend — Persist approved action results in message metadata

**Files:**
- Modify: `apps/api/src/lib/agent-actions.ts`

When an action is approved and executed, the message that originally contained the pending_action needs its metadata updated with the execution result. This way, on reload the Plan card can render with the completed state.

- [ ] **Step 1: Read executeAction to find where results are persisted**

Find the MCP tool execution branch we added earlier. After storing the result on `agentActions`, also update the parent `agentMessages` row's `tool_calls` metadata.

- [ ] **Step 2: Update agentMessages.tool_calls on action completion**

In the native action switch AND the MCP branch, after a successful execution, find the message that the action belongs to (via `conversation_id` and matching `agentActions.id` in the tool_calls array), and update its `tool_calls` field to mark that action as completed.

Add a helper function:

```typescript
async function updateMessageActionStatus(
  conversationId: string | null,
  actionId: string,
  status: 'approved' | 'failed',
  result: any,
  error?: string,
) {
  if (!conversationId) return;
  
  // Find the most recent assistant message in this conversation with this action in tool_calls
  const [msg] = await db
    .select()
    .from(agentMessages)
    .where(and(
      eq(agentMessages.conversation_id, conversationId),
      eq(agentMessages.role, 'assistant'),
    ))
    .orderBy(desc(agentMessages.created_at))
    .limit(10);
  // ... iterate to find matching action_id in tool_calls array, update it
}
```

Actually, simpler: query agentActions to get conversation_id, then look up messages by that conversation, then update the right one. Or even simpler: just add the result directly to the action record and have the frontend reconstruct state from `agentActions.status` + `agentActions.result` on load.

**Simpler approach: skip message metadata mutation, just include action state in the message load.**

In the GET `/conversations/:id/messages` endpoint, after fetching messages, for each message look up the corresponding `agentActions` rows (by conversation_id and created_at) and attach them:

```typescript
const messageList = await db.select()...;
const actionsList = await db.select().from(agentActions)
  .where(eq(agentActions.conversation_id, conversationId));

// Attach pending_actions to messages based on conversation
// (since actions don't have message_id, assign all to the last assistant message)
```

This is fragile — actions aren't directly linked to messages. Let me use a different approach.

- [ ] **Step 3: Add message_id column to agentActions**

This is the cleanest fix. Add `message_id` to `agentActions`:

```sql
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS message_id text;
```

Update schema.ts:

```typescript
message_id: text('message_id'),
```

- [ ] **Step 4: Set message_id when creating pending actions**

In `apps/api/src/routes/agent.ts`, where pending actions are created (inside the streaming loop), set `message_id` to the assistant message being generated. You need to create the assistant message row first, then use its ID on the action inserts.

Currently the flow is: stream response → on 'done', insert assistant message. Change to: start assistant message with empty content, insert it, use its ID for any pending actions created during tool_use blocks, finalize content on 'done'.

Specifically, find the `Create pending action` block and pass the assistant message ID:

```typescript
// At the start of the streaming loop, create the assistant message row:
const assistantMsgId = createId();
await db.insert(agentMessages).values({
  id: assistantMsgId,
  conversation_id: conversationId,
  role: 'assistant',
  content: '',
});

// Later, when creating pending actions:
await db.insert(agentActions).values({
  // ... existing fields
  message_id: assistantMsgId,
});

// At end of stream, update the message with full content:
await db.update(agentMessages).set({ content: finalText }).where(eq(agentMessages.id, assistantMsgId));
```

- [ ] **Step 5: Return actions joined with messages in GET /messages**

In the messages load endpoint, fetch actions for each message:

```typescript
const messageList = await db.select().from(agentMessages)
  .where(and(
    eq(agentMessages.conversation_id, conversationId),
    eq(agentMessages.hidden, false),
  ));

const actionList = await db.select().from(agentActions)
  .where(eq(agentActions.conversation_id, conversationId));

const messagesWithActions = messageList.map(m => ({
  ...m,
  pending_actions: actionList.filter(a => a.message_id === m.id).map(a => ({
    id: a.id,
    action: a.action,
    params: a.params,
    approval_tier: a.approval_tier,
    status: a.approval_status,  // 'pending' | 'approved' | 'rejected'
    result: a.result,
    executed_at: a.executed_at,
  })),
}));

return c.json(messagesWithActions);
```

- [ ] **Step 6: Typecheck and commit**

Run: `cd apps/api && pnpm typecheck`

```bash
git add packages/db/src/schema.ts apps/api/src/routes/agent.ts apps/api/src/lib/agent-actions.ts
git commit -m "feat(agent): link actions to messages for reload persistence"
```

Also run the migration:

```sql
ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS message_id text;
```

---

### Task 4: Frontend — Sidebar filtering + clicking preserves agent

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`

- [ ] **Step 1: Fetch conversations filtered by active tab**

Find where conversations are fetched in the agent page. Add the employee query param based on `activeTab`:

```typescript
const url = activeTab === 'defty' 
  ? '/api/agent/conversations'
  : `/api/agent/conversations?employee=${activeTab}`;
const res = await api.get(url);
```

Re-fetch when `activeTab` changes.

- [ ] **Step 2: Store conversation's agent_employee_id when navigating**

When user clicks a conversation from the sidebar, load that conversation's `agent_employee_id` from the API response and set `activeTab` accordingly:

```typescript
// In the conversation click handler, or when loading a conversation:
const conv = conversations.find(c => c.id === activeId);
if (conv) {
  setActiveTab(conv.agent_employee_id || 'defty');
  // Update URL to match
  if (conv.agent_employee_id) {
    router.replace(`/agent?id=${activeId}&employee=${conv.agent_employee_id}`);
  }
}
```

- [ ] **Step 3: Pass conversationId to employee AgentChat when present**

Fix the employee branch of the render:

```typescript
if (activeTab !== 'defty' && activeEmployee) {
  return (
    <div className="flex flex-col h-full">
      {tabBar}
      {/* Employee header */}
      <div>...</div>
      <div className="flex-1 overflow-hidden">
        <AgentChat
          key={activeEmployee.id}
          conversationId={activeId || undefined}
          agentEmployeeId={activeEmployee.id}
        />
      </div>
    </div>
  );
}
```

Don't include `activeId` in the `key` — we want the component to re-fetch messages via the `conversationId` effect instead of remounting.

- [ ] **Step 4: Typecheck and commit**

Run: `cd apps/web && pnpm typecheck`

```bash
git add apps/web/src/app/\(app\)/agent/page.tsx
git commit -m "feat(agent-ui): filter sidebar by agent, preserve tab on conversation click"
```

---

### Task 5: Frontend — Send hidden synthesis messages, load with persisted actions

**Files:**
- Modify: `apps/web/src/components/agent-chat.tsx`

- [ ] **Step 1: Pass `hidden` flag in fetch body**

Find the `sendMessage` fetch call (around line 247-254). Include `hidden` in the body:

```typescript
body: JSON.stringify({
  content,
  ...(agentEmployeeId ? { agent_employee_id: agentEmployeeId } : {}),
  ...(hidden ? { hidden: true } : {}),
}),
```

- [ ] **Step 2: Pass agent_employee_id when creating new conversations**

In the lazy conversation creation block:

```typescript
const res = await api.post('/api/agent/conversations', {
  agent_employee_id: agentEmployeeId || undefined,
});
```

- [ ] **Step 3: Handle persisted pending_actions on load**

Find the load-messages effect (around line 147). Map the server response to include action state:

```typescript
setMessages(data.map((m: any) => ({
  id: m.id,
  role: m.role,
  content: m.content,
  citations: m.citations || [],
  pending_actions: m.pending_actions || [],  // now comes from server
  auto_executed: [],
  model: m.model,
  tokens_in: m.tokens_in,
  tokens_out: m.tokens_out,
})));
```

The `pending_actions` now arrive with their `status` field set from the DB (`pending`, `approved`, `rejected`), so the existing ActionCard/PlanCard will render them in the right state.

- [ ] **Step 4: Per-agent placeholder text**

In the render, change the textarea placeholder to reflect the active agent:

```typescript
placeholder={agentEmployeeId ? `Ask ${/* agent name */} anything...` : 'Ask Defty anything...'}
```

You'll need to pass the agent name as a prop or fetch it. Easiest: add `agentName?: string` to the AgentChat props and pass it from the parent.

In `agent/page.tsx`, pass:

```typescript
<AgentChat
  key={activeEmployee.id}
  conversationId={activeId || undefined}
  agentEmployeeId={activeEmployee.id}
  agentName={activeEmployee.name}
/>
```

- [ ] **Step 5: Typecheck and commit**

Run: `cd apps/web && pnpm typecheck`

```bash
git add apps/web/src/components/agent-chat.tsx
git commit -m "feat(agent-chat): hidden messages, persisted actions, per-agent placeholder"
```

---

### Task 6: UI Polish — Sidebar badge + employee indicator

**Files:**
- Modify: `apps/web/src/app/(app)/agent/page.tsx`

- [ ] **Step 1: Add employee avatar/badge to conversation sidebar items**

For each conversation in the sidebar, show a small employee avatar if `agent_employee_id` is set, or a Defty icon if not:

```typescript
{conversations.map(conv => {
  const employee = agentEmployees.find(e => e.id === conv.agent_employee_id);
  return (
    <Link href={`/agent?id=${conv.id}${employee ? `&employee=${employee.id}` : ''}`} ...>
      {employee ? (
        <div style={{ width: 14, height: 14, borderRadius: '50%', background: 'var(--primary-container)', ... }}>
          {employee.name[0]}
        </div>
      ) : (
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>◇</span>
      )}
      <span>{conv.title}</span>
      <span>{timeAgo}</span>
    </Link>
  );
})}
```

Currently the sidebar is filtered by tab, but showing an indicator makes it clear at a glance even when filtering is off.

- [ ] **Step 2: Include employee in sidebar link URL**

Ensure every conversation link preserves `&employee=X` when the conversation belongs to an employee, so clicking it routes correctly.

- [ ] **Step 3: Typecheck and commit**

Run: `cd apps/web && pnpm typecheck`

```bash
git add apps/web/src/app/\(app\)/agent/page.tsx
git commit -m "feat(agent-ui): sidebar conversation badges per agent"
```

---

## Verification

After all tasks:

1. `cd packages/db && npx tsc --noEmit` — must pass
2. `cd apps/api && pnpm typecheck` — must pass
3. `cd apps/web && pnpm typecheck` — must pass

Manual verification:

- **Conversation filtering:** On Defty tab, only Defty conversations show in the sidebar. On Alex PM tab, only Alex PM conversations show.
- **Tab persistence:** Clicking a conversation in the sidebar switches to the correct tab (Defty or employee) based on the conversation's `agent_employee_id`.
- **Employee conversation reload:** Navigate away, come back — conversation history loads in the employee tab, not empty state.
- **Approval state persists:** Approve a plan, reload — the Plan card still shows green checkmarks. The synthesis response is still visible.
- **Hidden synthesis messages:** On reload, you don't see `[System: The approved actions...]` as a user message.
- **Per-agent placeholder:** Alex PM tab shows "Ask Alex PM anything..." in the input.
- **Sidebar badges:** Each conversation shows an avatar or icon indicating which agent it's with.

## Notes on Deferred Items

- **Moving employee conversations to `spaces` + `messages`** (the spec's original vision): Deferred. This is a bigger refactor that changes the fundamental data model. Current implementation uses `agent_conversations` + `agent_messages` for all agents, which works for now. Revisit when chat integration becomes a priority.
- **Conversation search/filter:** Use existing browser search (Ctrl+F) for now. Dedicated search UI can come later.

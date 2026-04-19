# Phase 1: Agent Foundation — Trust Levels, Approval Routing & Background Execution

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agent "come alive" by enforcing trust levels so actions auto-execute when permitted, fixing broken action approval for `add_knowledge`/`wiki_write`, adding background execution mode to `agent-runner.ts`, and surfacing agent activity on the dashboard.

**Architecture:** Extract approval routing into `agent-approval.ts`, fix the `executeAction()` switch to handle all ACTION_TOOLS, wire trust levels into both the streaming chat loop (`agent.ts`) and the background runner (`agent-runner.ts`), and add a dashboard widget showing recent agent actions.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL, Next.js 14, React, Tailwind CSS

---

## Critical Issues Found During Plan Review

1. **`agent-runner.ts` blocks ALL write actions** (line 184-197) — returns `skipped_in_chat_mention` for every action tool. Background workers that call `runAgentQuery()` can never auto-execute actions. This blocks the entire "agent comes alive" vision.

2. **`executeAction()` missing cases** — `add_knowledge` and `wiki_write` are in `ACTION_TOOLS` but not handled in the `executeAction()` switch in `agent-actions.ts`. When a user approves these actions in the chat UI, execution silently fails with "Unknown action." Existing bug.

3. **System user inconsistency** — `standup-generate.ts` uses `user_id: 'system'` (a raw string, not a real user). `agent-reply.ts` has `ensureAgentUser()` creating a proper user with `deft-agent@system.local`. Background actions need a real user ID for audit trails and the `agentActions` table.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `apps/api/src/lib/agent-approval.ts` | Create | Trust level + approval tier routing logic |
| `apps/api/src/lib/agent-actions.ts` | Modify | Add `executeActionDirect()`, add `add_knowledge`/`wiki_write` cases, add `ensureAgentUser()` |
| `apps/api/src/lib/agent-tools.ts` | Unchanged | ACTION_TOOLS already correct, no changes needed |
| `apps/api/src/routes/agent.ts` | Modify | Use `shouldAutoExecute()` in the tool loop |
| `apps/api/src/lib/agent-runner.ts` | Modify | Add background execution mode with trust level support |
| `apps/api/src/routes/dashboard.ts` | Modify | Add agent activity endpoint |
| `apps/web/src/app/(app)/dashboard/page.tsx` | Modify | Add Agent Activity feed widget |
| `apps/web/src/components/agent-chat.tsx` | Modify | Handle `action_auto_executed` SSE events |

---

### Task 1: Create Agent Approval Logic

**Files:**
- Create: `apps/api/src/lib/agent-approval.ts`

This task creates the core routing function that decides whether an agent action should auto-execute or require user approval.

- [ ] **Step 1: Create `agent-approval.ts`**

```typescript
// apps/api/src/lib/agent-approval.ts

/**
 * Trust level + approval tier routing for agent actions.
 *
 * Trust levels (set per org in Settings > Agent):
 *   conservative — every write action requires explicit user approval
 *   standard     — 'auto' tier actions execute immediately, 'quick'/'full' need approval
 *   autonomous   — 'auto' and 'quick' execute immediately, only 'full' needs approval
 *
 * Approval tiers (assigned per action tool):
 *   auto  — low-risk internal state changes (status update, assignment)
 *   quick — moderate-risk entity creation (create task, add knowledge, wiki write)
 *   full  — high-risk external/visible actions (post message, calendar event, github issue)
 */

export type TrustLevel = 'conservative' | 'standard' | 'autonomous';
export type ApprovalTier = 'auto' | 'quick' | 'full';

/** Default approval tier for each action tool */
export const TOOL_APPROVAL_TIERS: Record<string, ApprovalTier> = {
  update_task_status: 'auto',
  assign_task: 'auto',
  create_task: 'quick',
  add_knowledge: 'quick',
  wiki_write: 'quick',
  post_message: 'full',
  create_calendar_event: 'full',
  create_github_issue: 'full',
};

/** Returns true if the action should be auto-executed (no user approval needed). */
export function shouldAutoExecute(
  action: string,
  trustLevel: TrustLevel,
): boolean {
  if (trustLevel === 'conservative') return false;

  const tier = TOOL_APPROVAL_TIERS[action] || 'full';

  if (trustLevel === 'standard') return tier === 'auto';
  if (trustLevel === 'autonomous') return tier === 'auto' || tier === 'quick';

  return false;
}

/** Returns the approval tier for an action tool. */
export function getApprovalTier(action: string): ApprovalTier {
  return TOOL_APPROVAL_TIERS[action] || 'full';
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd /c/Users/Osheen\ Pradhan/cairn/apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/agent-approval.ts
git commit -m "feat(agent): add trust level and approval tier routing logic"
```

---

### Task 2: Fix Action Execution — Add Missing Cases + `executeActionDirect()`

**Files:**
- Modify: `apps/api/src/lib/agent-actions.ts`

Three things to do: (a) add `add_knowledge` and `wiki_write` to the `executeAction` switch so approving them actually works, (b) add `executeActionDirect()` for auto-executed actions, (c) move `ensureAgentUser()` here so it's reusable by background workers.

- [ ] **Step 1: Read the full `agent-actions.ts` and `agent-context.ts` cases for add_knowledge and wiki_write**

Read: `apps/api/src/lib/agent-actions.ts` (full file — already read above)
Read: `apps/api/src/lib/agent-context.ts` lines 1200-1227 (add_knowledge case)
Read: `apps/api/src/lib/agent-context.ts` lines 1654-1740 (wiki_write case)

These show the current write implementations in the tool handler. We need equivalent logic in `executeAction()`.

- [ ] **Step 2: Add imports needed for the new cases**

At the top of `apps/api/src/lib/agent-actions.ts`, find the import from `@deft/db/schema` (line 2-11):

```typescript
import {
  tasks,
  projects,
  messages,
  spaces,
  agentActions,
  taskActivity,
  users,
  orgMembers,
} from '@deft/db/schema';
```

Replace with:

```typescript
import {
  tasks,
  projects,
  messages,
  spaces,
  agentActions,
  taskActivity,
  users,
  orgMembers,
  spaceKnowledge,
  wikiPages,
  wikiLinks,
  wikiOpsLog,
} from '@deft/db/schema';
```

- [ ] **Step 3: Add `ensureAgentUser()` function**

Add before the `resolveUser` function (before line 16):

```typescript
/** Well-known agent user email */
const AGENT_EMAIL = 'deft-agent@system.local';

/**
 * Ensure an agent system user exists for background actions.
 * Returns the agent user's ID.
 */
export async function ensureAgentUser(): Promise<string> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, AGENT_EMAIL))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(users)
    .values({ email: AGENT_EMAIL, name: 'Deft', email_verified: true })
    .returning();
  return created!.id;
}
```

- [ ] **Step 4: Add `add_knowledge` case to `executeAction` switch**

Add before the `default:` case in the switch statement (before line 399):

```typescript
      case 'add_knowledge': {
        const [space] = await db
          .select()
          .from(spaces)
          .where(and(eq(spaces.org_id, orgId), ilike(spaces.name, `%${params.space_name}%`)))
          .limit(1);
        if (!space) return { success: false, result: null, error: `Space "${params.space_name}" not found` };

        const [entry] = await db
          .insert(spaceKnowledge)
          .values({
            org_id: orgId,
            space_id: space.id,
            type: params.type,
            title: params.title,
            content: params.content || null,
            metadata: params.metadata || null,
            created_by: userId,
          })
          .returning();

        await db
          .update(agentActions)
          .set({
            result: { knowledge_id: entry!.id, title: params.title, space: space.name },
            before_state: null,
            after_state: { id: entry!.id, type: params.type, title: params.title, space_id: space.id },
            executed_at: new Date(),
          })
          .where(eq(agentActions.id, actionId));

        await logAuditEvent({
          orgId,
          actorType: 'agent',
          actorId: userId,
          action: 'add_knowledge',
          entityType: 'knowledge',
          entityId: entry!.id,
          beforeState: null,
          afterState: { type: params.type, title: params.title, space: space.name },
          metadata: { action_id: actionId },
        });

        return { success: true, result: { knowledge_id: entry!.id, title: params.title, space: space.name } };
      }
```

- [ ] **Step 5: Add `wiki_write` case to `executeAction` switch**

Add after the `add_knowledge` case:

```typescript
      case 'wiki_write': {
        const { slug: existingSlug, title, content, type: pageType, summary, related_slugs } = params;

        if (existingSlug) {
          // Update existing page
          const [existing] = await db
            .select()
            .from(wikiPages)
            .where(and(eq(wikiPages.org_id, orgId), eq(wikiPages.slug, existingSlug), eq(wikiPages.is_deleted, false)))
            .limit(1);
          if (!existing) return { success: false, result: null, error: `Wiki page "${existingSlug}" not found` };

          const updates: Record<string, any> = {};
          if (title) updates.title = title;
          if (summary) updates.summary = summary;
          if (pageType) updates.type = pageType;
          if (content && content !== existing.content) {
            updates.content = content;
            updates.previous_content = existing.content;
            updates.version = existing.version + 1;
          }

          if (Object.keys(updates).length > 0) {
            await db.update(wikiPages).set(updates).where(eq(wikiPages.id, existing.id));
          }

          if (related_slugs && related_slugs.length > 0) {
            await db.delete(wikiLinks).where(eq(wikiLinks.source_page_id, existing.id));
            const targets = await db
              .select({ id: wikiPages.id })
              .from(wikiPages)
              .where(and(eq(wikiPages.org_id, orgId), sql`${wikiPages.slug} = ANY(${related_slugs})`));
            for (const t of targets) {
              if (t.id !== existing.id) {
                await db.insert(wikiLinks).values({ org_id: orgId, source_page_id: existing.id, target_page_id: t.id }).onConflictDoNothing();
              }
            }
          }

          await db.insert(wikiOpsLog).values({
            org_id: orgId,
            operation: 'update',
            page_id: existing.id,
            details: { updated_fields: Object.keys(updates), by_agent: true },
            performed_by: userId,
          });

          await db
            .update(agentActions)
            .set({
              result: { slug: existingSlug, action: 'updated' },
              before_state: { content: existing.content, version: existing.version },
              after_state: { content: content || existing.content, version: (existing.version || 0) + 1 },
              executed_at: new Date(),
            })
            .where(eq(agentActions.id, actionId));

          await logAuditEvent({
            orgId,
            actorType: 'agent',
            actorId: userId,
            action: 'wiki_write',
            entityType: 'wiki_page',
            entityId: existing.id,
            beforeState: { content: existing.content },
            afterState: { content: content || existing.content },
            metadata: { action_id: actionId, slug: existingSlug },
          });

          return { success: true, result: { slug: existingSlug, action: 'updated' } };
        } else {
          // Create new page
          if (!title || !content || !pageType) {
            return { success: false, result: null, error: 'title, content, and type are required for new wiki pages' };
          }

          const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

          const [page] = await db
            .insert(wikiPages)
            .values({
              org_id: orgId,
              scope: 'org',
              type: pageType,
              title,
              slug,
              summary: summary || null,
              content,
              confidence: 0.7,
              version: 1,
            })
            .returning();

          await db.insert(wikiOpsLog).values({
            org_id: orgId,
            operation: 'create',
            page_id: page!.id,
            details: { type: pageType, by_agent: true },
            performed_by: userId,
          });

          await db
            .update(agentActions)
            .set({
              result: { slug, page_id: page!.id, action: 'created' },
              before_state: null,
              after_state: { id: page!.id, title, slug, type: pageType },
              executed_at: new Date(),
            })
            .where(eq(agentActions.id, actionId));

          await logAuditEvent({
            orgId,
            actorType: 'agent',
            actorId: userId,
            action: 'wiki_write',
            entityType: 'wiki_page',
            entityId: page!.id,
            beforeState: null,
            afterState: { title, slug, type: pageType },
            metadata: { action_id: actionId },
          });

          return { success: true, result: { slug, page_id: page!.id, action: 'created' } };
        }
      }
```

- [ ] **Step 6: Add `executeActionDirect()` function**

Add after the `executeAction` function (after the closing brace):

```typescript
/**
 * Create an action record and execute it immediately (for auto-approved actions).
 * Unlike executeAction(), this creates the agentActions row as already approved.
 */
export async function executeActionDirect(
  action: string,
  params: Record<string, any>,
  orgId: string,
  userId: string,
  conversationId: string | null,
  approvalTier: 'auto' | 'quick' | 'full',
): Promise<{ actionId: string; success: boolean; result: any; error?: string }> {
  const [actionRecord] = await db
    .insert(agentActions)
    .values({
      org_id: orgId,
      user_id: userId,
      conversation_id: conversationId,
      action,
      params,
      approval_tier: approvalTier,
      approval_status: 'approved',
      approved_at: new Date(),
    })
    .returning();

  const result = await executeAction(actionRecord!.id, action, params, orgId, userId);

  return { actionId: actionRecord!.id, ...result };
}
```

- [ ] **Step 7: Run typecheck**

Run: `cd /c/Users/Osheen\ Pradhan/cairn/apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/agent-actions.ts
git commit -m "fix(agent): add missing add_knowledge/wiki_write action handlers

Previously, approving these actions in the chat UI silently failed because
executeAction() didn't have cases for them. Also adds executeActionDirect()
for auto-executed actions and ensureAgentUser() for background jobs."
```

---

### Task 3: Wire Trust Level Enforcement Into Streaming Chat Loop

**Files:**
- Modify: `apps/api/src/routes/agent.ts` (lines 19-21 for imports, line 170 area for trust level, lines 324-358 for action handling)

- [ ] **Step 1: Add imports**

Find these lines (18-21):
```typescript
import { AGENT_TOOLS, ACTION_TOOLS, CALENDAR_TOOLS, GITHUB_TOOLS, CALENDAR_ACTION_TOOLS, GITHUB_ACTION_TOOLS, MANAGER_TOOLS } from '../lib/agent-tools.js';
import { executeToolCall } from '../lib/agent-context.js';
import { executeAction } from '../lib/agent-actions.js';
import { logAuditEvent } from '../lib/audit.js';
```

Replace with:
```typescript
import { AGENT_TOOLS, ACTION_TOOLS, CALENDAR_TOOLS, GITHUB_TOOLS, CALENDAR_ACTION_TOOLS, GITHUB_ACTION_TOOLS, MANAGER_TOOLS } from '../lib/agent-tools.js';
import { executeToolCall } from '../lib/agent-context.js';
import { executeAction, executeActionDirect } from '../lib/agent-actions.js';
import { logAuditEvent } from '../lib/audit.js';
import { shouldAutoExecute, getApprovalTier, type TrustLevel } from '../lib/agent-approval.js';
```

- [ ] **Step 2: Extract trust level from org query**

After the org query (line 169), add:
```typescript
  const trustLevel = (org?.trust_level || 'conservative') as TrustLevel;
```

- [ ] **Step 3: Replace the action handling block in the tool loop**

Find this block (approximately lines 324-358, the `if (isAction) {` branch):

```typescript
          if (isAction) {
            // Write actions require approval — store and notify client
            const [actionRecord] = await db
              .insert(agentActions)
              .values({
                org_id: user.org_id,
                user_id: user.id,
                conversation_id: convoId,
                action: tool.name,
                params: tool.input as any,
                approval_tier: 'quick',
                approval_status: 'pending',
              })
              .returning();

            pendingActions.push({
              id: actionRecord!.id,
              action: tool.name,
              params: tool.input,
            });
            await write({
              type: 'pending_action',
              id: actionRecord!.id,
              action: tool.name,
              params: tool.input,
            });

            toolResults.push({
              type: 'tool_result' as const,
              tool_use_id: tool.id,
              content: JSON.stringify({
                status: 'pending_approval',
                action_id: actionRecord!.id,
              }),
            });
```

Replace with:

```typescript
          if (isAction) {
            const approvalTier = getApprovalTier(tool.name);

            if (shouldAutoExecute(tool.name, trustLevel)) {
              // Trust level permits auto-execution
              await write({ type: 'tool_start', tool: tool.name });
              const { actionId, success, result, error } = await executeActionDirect(
                tool.name,
                tool.input as Record<string, any>,
                user.org_id,
                user.id,
                convoId,
                approvalTier,
              );

              await write({
                type: 'action_auto_executed',
                id: actionId,
                action: tool.name,
                params: tool.input,
                success,
                result,
                error,
              });

              toolResults.push({
                type: 'tool_result' as const,
                tool_use_id: tool.id,
                content: JSON.stringify(
                  success
                    ? { status: 'auto_executed', ...result }
                    : { status: 'auto_execute_failed', error },
                ),
              });
            } else {
              // Needs user approval
              const [actionRecord] = await db
                .insert(agentActions)
                .values({
                  org_id: user.org_id,
                  user_id: user.id,
                  conversation_id: convoId,
                  action: tool.name,
                  params: tool.input as any,
                  approval_tier: approvalTier,
                  approval_status: 'pending',
                })
                .returning();

              pendingActions.push({
                id: actionRecord!.id,
                action: tool.name,
                params: tool.input,
              });
              await write({
                type: 'pending_action',
                id: actionRecord!.id,
                action: tool.name,
                params: tool.input,
              });

              toolResults.push({
                type: 'tool_result' as const,
                tool_use_id: tool.id,
                content: JSON.stringify({
                  status: 'pending_approval',
                  action_id: actionRecord!.id,
                }),
              });
            }
```

- [ ] **Step 4: Run typecheck**

Run: `cd /c/Users/Osheen\ Pradhan/cairn/apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agent.ts
git commit -m "feat(agent): enforce trust level in streaming chat loop

Actions auto-execute when trust level permits (standard: auto-tier,
autonomous: auto+quick tier), otherwise require user approval."
```

---

### Task 4: Add Background Execution Mode to Agent Runner

**Files:**
- Modify: `apps/api/src/lib/agent-runner.ts`

This is the critical foundation piece. Currently `agent-runner.ts` blocks ALL write actions with `skipped_in_chat_mention`. We add a `mode` parameter so background workers can auto-execute actions.

- [ ] **Step 1: Read the full `agent-runner.ts`**

Already read above. Key section: lines 180-213, the action handling block.

- [ ] **Step 2: Add imports and update the function signature**

Find the imports (lines 1-11):

```typescript
// Reusable agent reasoning engine — used by @agent mentions in chat and other background jobs.
// Does NOT stream; returns the final response synchronously.

import Anthropic from '@anthropic-ai/sdk';
import { getModelConfig } from './llm.js';
import { db } from './db.js';
import { connectedAccounts, wikiPages } from '@deft/db/schema';
import { eq, and, desc, or, ilike, sql } from 'drizzle-orm';
import { env } from './env.js';
import { AGENT_TOOLS, ACTION_TOOLS, CALENDAR_TOOLS, GITHUB_TOOLS, CALENDAR_ACTION_TOOLS, GITHUB_ACTION_TOOLS } from './agent-tools.js';
import { executeToolCall } from './agent-context.js';
```

Replace with:

```typescript
// Reusable agent reasoning engine — used by @agent mentions in chat and other background jobs.
// Supports two modes:
//   'chat_mention' (default): write actions are skipped (safety for @mentions)
//   'background': write actions auto-execute based on org trust level

import Anthropic from '@anthropic-ai/sdk';
import { getModelConfig } from './llm.js';
import { db } from './db.js';
import { connectedAccounts, wikiPages, orgs } from '@deft/db/schema';
import { eq, and, desc, or, ilike, sql } from 'drizzle-orm';
import { env } from './env.js';
import { AGENT_TOOLS, ACTION_TOOLS, CALENDAR_TOOLS, GITHUB_TOOLS, CALENDAR_ACTION_TOOLS, GITHUB_ACTION_TOOLS } from './agent-tools.js';
import { executeToolCall } from './agent-context.js';
import { executeActionDirect } from './agent-actions.js';
import { shouldAutoExecute, getApprovalTier, type TrustLevel } from './agent-approval.js';
```

- [ ] **Step 3: Update function signature to accept mode and optional trust level**

Find the function signature and params type (lines 39-48):

```typescript
export async function runAgentQuery(params: {
  content: string;
  orgId: string;
  userId: string;
  orgName: string;
  conversationHistory?: ConversationMessage[];
}): Promise<{
  text: string;
  citations: any[];
  pendingActions: any[];
}> {
```

Replace with:

```typescript
export async function runAgentQuery(params: {
  content: string;
  orgId: string;
  userId: string;
  orgName: string;
  conversationHistory?: ConversationMessage[];
  /** 'chat_mention' (default): write actions skipped. 'background': write actions auto-execute per trust level. */
  mode?: 'chat_mention' | 'background';
  /** Override system prompt (for agent employees in future). */
  systemPromptOverride?: string;
}): Promise<{
  text: string;
  citations: any[];
  pendingActions: any[];
  executedActions: any[];
}> {
```

- [ ] **Step 4: Add trust level loading and mode handling**

After the destructuring of params (line 54), add mode handling:

```typescript
  const { content, orgId, userId, orgName, conversationHistory, mode = 'chat_mention', systemPromptOverride } = params;
```

After the connection info section (around line 87), add trust level loading for background mode:

```typescript
  let trustLevel: TrustLevel = 'conservative';
  if (mode === 'background') {
    const [org] = await db
      .select({ trust_level: orgs.trust_level })
      .from(orgs)
      .where(eq(orgs.id, orgId))
      .limit(1);
    trustLevel = (org?.trust_level || 'conservative') as TrustLevel;
  }
```

If `systemPromptOverride` is provided, use it instead:
```typescript
  if (systemPromptOverride) {
    systemPrompt = systemPromptOverride
      .replace('{{DATE}}', new Date().toISOString().split('T')[0]!)
      .replace('{{ORG}}', orgName || 'Unknown') + connectionInfo;
  }
```

- [ ] **Step 5: Replace the action handling block in the tool loop**

Find the action handling block (lines 182-197):

```typescript
      if (isAction) {
        // Write actions: skip in chat mention context, tell the agent it needs approval
        pendingActions.push({
          action: tool.name,
          params: tool.input,
        });
        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: tool.id,
          content: JSON.stringify({
            status: 'skipped_in_chat_mention',
            message: 'Write actions are not auto-executed from chat mentions. Suggest the user use the Agent panel for this action.',
          }),
        });
```

Replace with:

```typescript
      if (isAction) {
        if (mode === 'background' && shouldAutoExecute(tool.name, trustLevel)) {
          // Background mode: auto-execute if trust level permits
          const approvalTier = getApprovalTier(tool.name);
          const { actionId, success, result, error } = await executeActionDirect(
            tool.name,
            tool.input as Record<string, any>,
            orgId,
            userId,
            null, // no conversation_id for background actions
            approvalTier,
          );
          executedActions.push({ actionId, action: tool.name, params: tool.input, success, result, error });
          toolResults.push({
            type: 'tool_result' as const,
            tool_use_id: tool.id,
            content: JSON.stringify(
              success
                ? { status: 'auto_executed', ...result }
                : { status: 'auto_execute_failed', error },
            ),
          });
        } else {
          // Chat mention mode or trust level requires approval: skip write actions
          pendingActions.push({
            action: tool.name,
            params: tool.input,
          });
          toolResults.push({
            type: 'tool_result' as const,
            tool_use_id: tool.id,
            content: JSON.stringify({
              status: 'skipped',
              message: mode === 'background'
                ? 'Action requires approval. Trust level does not permit auto-execution.'
                : 'Write actions are not auto-executed from chat mentions. Suggest the user use the Agent panel for this action.',
            }),
          });
        }
```

- [ ] **Step 6: Add `executedActions` state and update return**

Near the top of the function where `allCitations` and `pendingActions` are initialized, add:

```typescript
  let executedActions: any[] = [];
```

And update the return statement (line 228-231):

```typescript
  return {
    text: responseText,
    citations: allCitations,
    pendingActions,
    executedActions,
  };
```

- [ ] **Step 7: Run typecheck**

Run: `cd /c/Users/Osheen\ Pradhan/cairn/apps/api && pnpm typecheck`
Expected: No errors. If there are errors, they will likely be in files that call `runAgentQuery()` and don't expect `executedActions` in the return — fix by adding `executedActions` handling in `agent-reply.ts`.

- [ ] **Step 8: Fix callers if needed**

If typecheck fails because `agent-reply.ts` (line 121) destructures the result without `executedActions`, update it:

Find (agent-reply.ts line 121-127):
```typescript
    const result = await runAgentQuery({
      content: promptContent,
      orgId,
      userId,
      orgName,
      conversationHistory: conversationHistory.length > 0 ? conversationHistory : undefined,
    });
```

No change needed here — `result.executedActions` just won't be used. But check if the line `if (!result.text)` still compiles. If the return type is now different, TypeScript should be fine since we're accessing the same `text` property.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/lib/agent-runner.ts
git commit -m "feat(agent): add background execution mode to agent runner

runAgentQuery() now accepts mode: 'background' which auto-executes
write actions based on org trust level. Chat mentions (default) still
skip writes for safety. Foundation for background automation and
agent employees."
```

---

### Task 5: Add Agent Activity Feed to Dashboard API

**Files:**
- Modify: `apps/api/src/routes/dashboard.ts`

- [ ] **Step 1: Read the dashboard route to understand structure and imports**

Read: `apps/api/src/routes/dashboard.ts`

- [ ] **Step 2: Add agent activity endpoint**

Add `agentActions` to the schema import and `inArray` to the drizzle-orm import if not already present.

Add a new GET endpoint:

```typescript
dashboardRoutes.get('/agent-activity', async (c) => {
  const user = c.get('user');

  const recentActions = await db
    .select({
      id: agentActions.id,
      action: agentActions.action,
      params: agentActions.params,
      result: agentActions.result,
      approval_status: agentActions.approval_status,
      approval_tier: agentActions.approval_tier,
      executed_at: agentActions.executed_at,
      created_at: agentActions.created_at,
      error: agentActions.error,
    })
    .from(agentActions)
    .where(
      and(
        eq(agentActions.org_id, user.org_id),
        inArray(agentActions.approval_status, ['approved', 'pending']),
      ),
    )
    .orderBy(desc(agentActions.created_at))
    .limit(20);

  return c.json(recentActions);
});
```

- [ ] **Step 3: Run typecheck**

Run: `cd /c/Users/Osheen\ Pradhan/cairn/apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard.ts
git commit -m "feat(dashboard): add agent activity feed endpoint"
```

---

### Task 6: Add Agent Activity Widget to Dashboard UI

**Files:**
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx`

- [ ] **Step 1: Read the dashboard page to understand BentoCard pattern and data fetching**

Read: `apps/web/src/app/(app)/dashboard/page.tsx`

Understand: BentoCard component, how fetches are done (likely in a `useEffect` with `fetch()`), how state is managed.

- [ ] **Step 2: Add type, state, and fetch for agent activity**

Add type near existing types:
```typescript
type AgentActivity = {
  id: string;
  action: string;
  params: any;
  result: any;
  approval_status: string;
  approval_tier: string;
  executed_at: string | null;
  created_at: string;
  error: string | null;
};
```

Add state in the Dashboard component:
```typescript
const [agentActivity, setAgentActivity] = useState<AgentActivity[]>([]);
```

Add fetch in the data-loading useEffect (alongside existing fetches):
```typescript
fetch('/api/dashboard/agent-activity', { headers })
  .then(r => r.ok ? r.json() : [])
  .then(setAgentActivity)
  .catch(() => {});
```

- [ ] **Step 3: Add `formatAgentAction` helper and the BentoCard**

Add helper function (inside or before the Dashboard component):
```typescript
function formatAgentAction(a: AgentActivity): string {
  const p = a.params as Record<string, any>;
  switch (a.action) {
    case 'create_task':
      return `Created task "${p.title}" in ${p.project_name}`;
    case 'update_task_status':
      return `Moved ${p.task_identifier} to ${(p.new_status || '').replace(/_/g, ' ')}`;
    case 'assign_task':
      return `Assigned ${p.task_identifier} to ${p.assignee_name}`;
    case 'post_message':
      return `Posted in #${p.space_name}`;
    case 'add_knowledge':
      return `Added ${p.type}: "${p.title}"`;
    case 'wiki_write':
      return `Updated wiki: ${p.title || p.slug}`;
    case 'create_calendar_event':
      return `Created event: ${p.title}`;
    default:
      return a.action.replace(/_/g, ' ');
  }
}
```

Add the BentoCard in the dashboard grid layout. Place it after the Activity log card or wherever makes sense visually:

```tsx
<BentoCard title="Agent Activity" className="col-span-1">
  {agentActivity.length === 0 ? (
    <p className="text-[12px]" style={{ color: 'var(--muted)' }}>
      No recent agent activity
    </p>
  ) : (
    <div className="space-y-2">
      {agentActivity.slice(0, 8).map((a) => (
        <div key={a.id} className="flex items-start gap-2 text-[12px]">
          <div
            className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
            style={{
              background: a.approval_status === 'approved'
                ? a.error ? '#EF4444' : '#22C55E'
                : '#EAB308',
            }}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate" style={{ color: 'var(--foreground)' }}>
              {formatAgentAction(a)}
            </p>
            <p style={{ color: 'var(--muted)', fontSize: '10px' }}>
              {a.approval_status === 'pending' ? 'Awaiting approval' : ''}
              {a.executed_at
                ? new Date(a.executed_at).toLocaleString('en', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })
                : new Date(a.created_at).toLocaleString('en', {
                    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
            </p>
          </div>
        </div>
      ))}
    </div>
  )}
</BentoCard>
```

- [ ] **Step 4: Run typecheck and build**

Run: `cd /c/Users/Osheen\ Pradhan/cairn/apps/web && pnpm typecheck`
Run: `cd /c/Users/Osheen\ Pradhan/cairn && pnpm --filter @deft/web build`
Expected: Both pass

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(app\)/dashboard/page.tsx
git commit -m "feat(dashboard): add agent activity feed widget

Shows recent agent actions with status indicators (green=executed,
yellow=pending, red=error) and human-readable action descriptions."
```

---

### Task 7: Handle Auto-Executed Actions in Agent Chat UI

**Files:**
- Modify: `apps/web/src/components/agent-chat.tsx`

The chat UI currently only handles `pending_action` SSE events. After Task 3, the backend also sends `action_auto_executed` events. The UI needs to render these as completed action cards.

- [ ] **Step 1: Read the agent chat component**

Read: `apps/web/src/components/agent-chat.tsx`

Find: how SSE `data.type` events are processed (likely a switch or if-else chain), how pending action cards are rendered.

- [ ] **Step 2: Add state for auto-executed actions**

Find where `pendingActions` state is declared. Add nearby:

```typescript
const [autoExecutedActions, setAutoExecutedActions] = useState<Array<{
  id: string;
  action: string;
  params: any;
  success: boolean;
  result: any;
  error: string | null;
}>>([]);
```

Find where state is reset when a new message is sent (likely where `setPendingActions([])` is called). Add:
```typescript
setAutoExecutedActions([]);
```

- [ ] **Step 3: Handle the `action_auto_executed` SSE event**

Find the SSE event handler (the switch/if-else on `data.type`). Add a new case:

```typescript
} else if (data.type === 'action_auto_executed') {
  setAutoExecutedActions(prev => [...prev, {
    id: data.id,
    action: data.action,
    params: data.params,
    success: data.success,
    result: data.result,
    error: data.error,
  }]);
}
```

- [ ] **Step 4: Render auto-executed action cards**

Find where pending action cards are rendered (look for `pendingActions.map`). After that section, add:

```tsx
{autoExecutedActions.map((a) => (
  <div
    key={a.id}
    className="flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] my-1"
    style={{
      background: a.success ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
      border: `1px solid ${a.success ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
    }}
  >
    <span style={{ color: a.success ? '#22C55E' : '#EF4444' }}>
      {a.success ? '\u2713' : '\u2717'}
    </span>
    <span style={{ color: 'var(--foreground)' }}>
      {a.action.replace(/_/g, ' ')}
      {a.success && a.result?.identifier ? `: ${a.result.identifier}` : ''}
      {a.error ? `: ${a.error}` : ''}
    </span>
    <span
      className="ml-auto text-[10px] px-1.5 py-0.5 rounded"
      style={{ background: 'var(--surface-container)', color: 'var(--muted)' }}
    >
      auto
    </span>
  </div>
))}
```

- [ ] **Step 5: Run typecheck and build**

Run: `cd /c/Users/Osheen\ Pradhan/cairn/apps/web && pnpm typecheck`
Run: `cd /c/Users/Osheen\ Pradhan/cairn && pnpm --filter @deft/web build`
Expected: Both pass

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/agent-chat.tsx
git commit -m "feat(agent-chat): render auto-executed actions in chat UI

Shows green completed cards with 'auto' badge for actions that
auto-executed based on trust level. Red cards for failures."
```

---

## Verification

After all tasks:

1. `cd apps/api && pnpm typecheck` — must pass
2. `cd apps/web && pnpm typecheck` — must pass
3. `pnpm --filter @deft/web build` — must succeed
4. Manual verification:
   - **Conservative (default):** All actions show approve/reject buttons
   - **Standard:** `update_task_status` and `assign_task` auto-execute (green "auto" card). `create_task`, `add_knowledge` show approve/reject. `post_message` shows approve/reject.
   - **Autonomous:** Only `post_message`, `create_calendar_event`, `create_github_issue` need approval. Everything else auto-executes.
   - **Dashboard:** Agent Activity widget shows all recent actions with correct status colors
   - **Knowledge approval:** Approving `add_knowledge` or `wiki_write` in chat now actually works (was previously broken)

## What This Enables for Future Phases

- **Phase 2 (MCP):** MCP tool actions will use the same `TOOL_APPROVAL_TIERS` map and `shouldAutoExecute()` logic. Just add new tool names to the map.
- **Phase 3 (Agent Employees):** Agent employees call `runAgentQuery({ mode: 'background', systemPromptOverride })` with their own system prompt. Trust level comes from the agent employee record (override `trustLevel` param, to be added later).
- **Phase 4 (Plans):** Plan step execution calls `executeActionDirect()` for each step.
- **Background triggers:** Any cron worker can now call `runAgentQuery({ mode: 'background' })` and the agent can actually DO things, not just read.

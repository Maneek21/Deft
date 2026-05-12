# Wiki Brain + Heartbeat + Self-Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent employees smarter (wiki brain write-back + employee-scoped knowledge), proactive (heartbeat system), and more reliable (self-verification after every response).

**Architecture:** Three features building on existing infrastructure. Wiki brain adds one column to `wikiPages` and modifies agent system prompts + worker post-response logic. Heartbeat adds four columns to `agent_employees`, one new cron worker, and a wizard step. Self-verification adds one Haiku call after every `runAgentQuery` response.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, PostgreSQL, Next.js 14, Anthropic API (Haiku for verification)

**Spec:** `docs/AGENT-VISION.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `packages/db/src/schema.ts` | Modify | Add `agent_employee_id` to wikiPages, heartbeat columns to agentEmployees |
| `apps/api/src/lib/agent-runner.ts` | Modify | Self-verification step, increased iteration limit for background, wiki write-back prompt injection |
| `apps/api/src/workers/handlers/agent-employee-message.ts` | Modify | Wiki write-back after response |
| `apps/api/src/workers/handlers/agent-employee-task.ts` | Modify | Wiki write-back after response |
| `apps/api/src/workers/handlers/agent-employee-heartbeat.ts` | Create | Heartbeat cron worker |
| `apps/api/src/workers/index.ts` | Modify | Register heartbeat worker |
| `apps/api/src/routes/agent-employees.ts` | Modify | Accept heartbeat fields in create/update |
| `apps/api/src/lib/agent-context.ts` | Modify | Filter wiki_search by employee's space access |
| `apps/api/src/routes/agent.ts` | Modify | Employee-scoped wiki context injection |
| `apps/web/src/app/(app)/settings/agent-employees/create/page.tsx` | Modify | Add heartbeat config step to wizard |
| `apps/web/src/app/(app)/settings/agent-employees/page.tsx` | Modify | Show heartbeat status in employee list |

---

### Task 1: Schema — Wiki Page Employee Tagging + Heartbeat Columns

**Files:**
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Add `agent_employee_id` to wikiPages table**

In the `wikiPages` table definition (line 1032-1052), add after the `user_id` column (line 1037):

```typescript
agent_employee_id: text('agent_employee_id'),
```

This tags wiki pages to specific agent employees. NULL = org-wide page (no employee association).

- [ ] **Step 2: Add heartbeat columns to agentEmployees table**

In the `agentEmployees` table definition (line 1143-1170), add after `daily_action_reset_at` (line 1161):

```typescript
heartbeat_enabled: boolean('heartbeat_enabled').default(false).notNull(),
heartbeat_interval_min: integer('heartbeat_interval_min').default(30).notNull(),
heartbeat_config: jsonb('heartbeat_config'),  // plain-English checklist of proactive tasks
last_heartbeat_at: timestamp('last_heartbeat_at'),
```

- [ ] **Step 3: Run migration SQL**

Create and run migration:

```sql
ALTER TABLE wiki_pages ADD COLUMN IF NOT EXISTS agent_employee_id text;
ALTER TABLE agent_employees ADD COLUMN IF NOT EXISTS heartbeat_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE agent_employees ADD COLUMN IF NOT EXISTS heartbeat_interval_min integer NOT NULL DEFAULT 30;
ALTER TABLE agent_employees ADD COLUMN IF NOT EXISTS heartbeat_config jsonb;
ALTER TABLE agent_employees ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamp;
```

Run via psql: `"/c/Program Files/PostgreSQL/16/bin/psql.exe" --dbname="postgres://postgres:postgres@localhost:5432/deft" --file="migration-file.sql"`

- [ ] **Step 4: Typecheck**

Run: `cd packages/db && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat(schema): add wiki employee tagging and heartbeat columns"
```

---

### Task 2: Wiki Brain — Employee-Scoped Context Injection

**Files:**
- Modify: `apps/api/src/lib/agent-runner.ts`
- Modify: `apps/api/src/routes/agent.ts`

The current wiki auto-context injection (agent-runner.ts lines 128-159) loads top 3 pages by FTS match. Modify it to prioritize the employee's own tagged pages.

- [ ] **Step 1: Modify wiki context query in agent-runner.ts**

Find the wiki auto-load section (lines 128-159). Replace the single query with a two-tier approach:

```typescript
// Wiki auto-context injection — employee-scoped
let wikiContext = '';
const searchQuery = content.replace(/[^a-zA-Z0-9\s]/g, '').trim();
if (searchQuery.length > 2) {
  try {
    let employeePages: any[] = [];
    let orgPages: any[] = [];

    // Tier 1: Employee's own tagged pages (if employee)
    if (params.agentEmployeeId) {
      employeePages = await db
        .select({
          title: wikiPages.title,
          summary: wikiPages.summary,
          type: wikiPages.type,
          confidence: wikiPages.confidence,
          slug: wikiPages.slug,
        })
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.org_id, orgId),
            eq(wikiPages.is_deleted, false),
            eq(wikiPages.agent_employee_id, params.agentEmployeeId),
            sql`search_vector @@ plainto_tsquery('english', ${searchQuery})`,
          ),
        )
        .orderBy(sql`ts_rank(search_vector, plainto_tsquery('english', ${searchQuery})) * ${wikiPages.confidence} DESC`)
        .limit(2);
    }

    // Tier 2: Org-wide pages (no employee tag)
    const orgLimit = params.agentEmployeeId ? 3 : 3;
    orgPages = await db
      .select({
        title: wikiPages.title,
        summary: wikiPages.summary,
        type: wikiPages.type,
        confidence: wikiPages.confidence,
        slug: wikiPages.slug,
      })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.org_id, orgId),
          eq(wikiPages.is_deleted, false),
          sql`${wikiPages.agent_employee_id} IS NULL`,
          sql`search_vector @@ plainto_tsquery('english', ${searchQuery})`,
        ),
      )
      .orderBy(sql`ts_rank(search_vector, plainto_tsquery('english', ${searchQuery})) * ${wikiPages.confidence} DESC`)
      .limit(orgLimit);

    const allPages = [...employeePages, ...orgPages];
    if (allPages.length > 0) {
      wikiContext = '\n\nRelevant knowledge from the team wiki:\n' +
        allPages.map(p => `- **${p.title}** (${p.type}, confidence: ${p.confidence}): ${p.summary || 'No summary'}`).join('\n') +
        '\n\nUse wiki_search and wiki_read tools for more details.';
    }
  } catch (err) {
    console.warn('[agent-runner] Wiki auto-load failed:', err);
  }
}
```

- [ ] **Step 2: Apply same pattern in agent.ts**

Find the wiki auto-context injection in `apps/api/src/routes/agent.ts` (similar section to agent-runner). Apply the same two-tier pattern, using the `agentEmployeeId` variable that already exists from Fix 1.

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/agent-runner.ts apps/api/src/routes/agent.ts
git commit -m "feat(wiki): employee-scoped wiki context injection

Tier 1: Employee's own tagged pages (up to 2, highest priority)
Tier 2: Org-wide pages with no employee tag (up to 3)
Both tiers ranked by FTS relevance * confidence score."
```

---

### Task 3: Wiki Brain — Write-Back After Task Completion

**Files:**
- Modify: `apps/api/src/workers/handlers/agent-employee-message.ts`
- Modify: `apps/api/src/workers/handlers/agent-employee-task.ts`
- Modify: `apps/api/src/lib/agent-runner.ts`

After an agent employee completes work, it should write key findings back to the wiki. This is done by injecting a write-back instruction into the system prompt and adding a post-response wiki persistence step.

- [ ] **Step 1: Add wiki write-back instruction to system prompt in agent-employee-message.ts**

Find where the `systemPrompt` is constructed (the augmented prompt with identity/context). Add to the communication guidelines section:

```typescript
## Knowledge Management
- After completing analysis or answering questions, consider: did you learn anything new that should be saved?
- Use wiki_write to create or update wiki pages with key findings, decisions, or new facts.
- Tag your pages by including your name in the context so they're attributed to you.
- Create 'preference' type pages when you learn user preferences (e.g., preferred report format).
- Create 'fact' type pages for data points you discover (e.g., current sprint velocity).
- Update existing pages rather than creating duplicates — use wiki_search first to check.
```

- [ ] **Step 2: Same instruction in agent-employee-task.ts**

Add the same `## Knowledge Management` section to the task handler's system prompt.

- [ ] **Step 3: Add durable notes step in agent-runner.ts**

After the agent loop completes and before returning, add a step that persists key context to agentMemory (for employees only). Find the return statement (around line 301-306) and add before it:

```typescript
// Durable notes — persist key findings before context is lost (employees only)
if (params.agentEmployeeId && responseText && responseText.length > 100) {
  try {
    const noteKey = `findings:${new Date().toISOString().slice(0, 10)}`;
    const noteValue = responseText.slice(0, 500); // truncated summary
    await db
      .insert(agentMemory)
      .values({
        id: createId(),
        org_id: orgId,
        user_id: userId,
        scope: 'user',
        key: noteKey,
        value: noteValue,
      })
      .onConflictDoUpdate({
        target: [agentMemory.user_id, agentMemory.conversation_id, agentMemory.key],
        set: { value: noteValue },
      });
  } catch (err) {
    console.warn('[agent-runner] Durable notes failed:', err);
  }
}
```

- [ ] **Step 4: Increase iteration limit for background mode**

In agent-runner.ts, find the iteration limit (line 194: `while (iterations < 8)`). Change to:

```typescript
const maxIterations = params.mode === 'background' ? 25 : 8;
while (iterations < maxIterations) {
```

This gives background tasks (employee work, heartbeats) more reasoning depth.

- [ ] **Step 5: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/agent-runner.ts apps/api/src/workers/handlers/agent-employee-message.ts apps/api/src/workers/handlers/agent-employee-task.ts
git commit -m "feat(wiki): agent write-back + durable notes + increased iterations

Agents instructed to write findings to wiki after completing work.
Durable notes persist key findings to agentMemory before context lost.
Background mode iteration limit increased from 8 to 25."
```

---

### Task 4: Self-Verification — Critic Step

**Files:**
- Modify: `apps/api/src/lib/agent-runner.ts`

Add a verification call using Haiku after the agent produces its final response.

- [ ] **Step 1: Add verification function**

Add this function above `runAgentQuery` in agent-runner.ts:

```typescript
async function verifyResponse(
  originalQuery: string,
  response: string,
  citations: any[],
  orgName: string,
): Promise<string> {
  try {
    const anthropic = getAnthropicClient();
    const verification = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: `You are a quality reviewer for an AI workspace assistant at ${orgName}. Review the response and check for issues.`,
      messages: [{
        role: 'user',
        content: `Original question: "${originalQuery}"

Response to review:
${response}

Citations provided: ${citations.length > 0 ? citations.map(c => c.title || c.id).join(', ') : 'none'}

Check:
1. Does the response answer the actual question asked?
2. Are there claims that seem fabricated or unsupported by the citations?
3. Is anything important missing that should have been addressed?
4. Are task/message identifiers (like DEFT-42) plausible given the citations?

If the response is good, reply with exactly: VERIFIED
If there are issues, provide a brief corrected version that fixes only the problems (keep the same style and length).`,
      }],
    });

    const verificationText = (verification.content[0] as any).text?.trim() || 'VERIFIED';
    if (verificationText === 'VERIFIED') {
      return response;
    }
    // Return the corrected version
    return verificationText;
  } catch (err) {
    console.warn('[agent-runner] Verification failed, using original response:', err);
    return response; // fail open — use original if verification errors
  }
}
```

- [ ] **Step 2: Wire verification into runAgentQuery**

Find where the final response text is assembled (around line 299: `const responseText = finalText || intermediateText;`). After that line, add:

```typescript
// Self-verification — critic step (background mode only, skip for chat mentions to keep fast)
let verifiedText = responseText;
if (params.mode === 'background' && responseText && responseText.length > 50) {
  verifiedText = await verifyResponse(content, responseText, allCitations, orgName);
}
```

Then use `verifiedText` instead of `responseText` in the return statement:

```typescript
return {
  text: verifiedText,
  citations: allCitations,
  pendingActions,
  executedActions,
};
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/agent-runner.ts
git commit -m "feat(agent): add self-verification critic step using Haiku

After generating a response, Haiku reviews for accuracy, completeness,
and citation validity. Only runs in background mode (employee tasks,
heartbeats, mentions). Fails open — uses original if verification errors."
```

---

### Task 5: Heartbeat Worker

**Files:**
- Create: `apps/api/src/workers/handlers/agent-employee-heartbeat.ts`
- Modify: `apps/api/src/workers/index.ts`

- [ ] **Step 1: Create the heartbeat worker**

```typescript
import { eq, and, lt, sql } from 'drizzle-orm';
import { db } from '@deft/db';
import { agentEmployees, orgs } from '@deft/db/schema';
import { runAgentQuery } from '../../lib/agent-runner.js';

export async function handleAgentEmployeeHeartbeat() {
  // Find all employees with heartbeat enabled and due for a check
  const now = new Date();

  const dueEmployees = await db
    .select()
    .from(agentEmployees)
    .where(
      and(
        eq(agentEmployees.is_active, true),
        eq(agentEmployees.heartbeat_enabled, true),
        sql`(${agentEmployees.last_heartbeat_at} IS NULL OR ${agentEmployees.last_heartbeat_at} + (${agentEmployees.heartbeat_interval_min} || ' minutes')::interval < NOW())`,
      ),
    );

  for (const employee of dueEmployees) {
    // Check daily action budget
    if (employee.daily_action_count >= employee.max_daily_actions) {
      continue; // Skip — budget exhausted
    }

    // Load org name
    const org = await db.select().from(orgs).where(eq(orgs.id, employee.org_id)).limit(1);
    const orgName = org[0]?.name || 'Unknown';

    // Build heartbeat prompt
    const heartbeatConfig = employee.heartbeat_config as string || 'Check if anything needs attention in your domain.';
    const heartbeatPrompt = `HEARTBEAT CHECK — You are waking up for a scheduled check.

## Your Heartbeat Checklist:
${heartbeatConfig}

## Instructions:
1. Go through each item in your checklist
2. Use your tools to check the current state
3. If something needs attention: take action (post in channels, create tasks, DM people)
4. If nothing needs attention: respond with exactly HEARTBEAT_OK

Be concise. Only act on things that genuinely need attention right now. Don't post noise.`;

    const augmentedPrompt = `${employee.system_prompt}

## Your Identity
You are ${employee.name}, a ${employee.role.replace(/_/g, ' ')} at ${orgName}.
${employee.expertise_description ? `Your expertise: ${employee.expertise_description}` : ''}

## Knowledge Management
- After finding important information, update relevant wiki pages.
- Create 'fact' type pages for new data points you discover.`;

    try {
      const result = await runAgentQuery({
        content: heartbeatPrompt,
        orgId: employee.org_id,
        userId: employee.user_id,
        orgName,
        mode: 'background',
        systemPromptOverride: augmentedPrompt,
        trustLevelOverride: employee.trust_level,
        agentEmployeeId: employee.id,
      });

      // Update last heartbeat timestamp
      await db.update(agentEmployees).set({
        last_heartbeat_at: now,
      }).where(eq(agentEmployees.id, employee.id));

      // If HEARTBEAT_OK, nothing more to do — minimal token cost achieved
      if (result.text?.trim() === 'HEARTBEAT_OK') {
        return;
      }

      // Otherwise the agent already took actions via tools during runAgentQuery
      // Log the heartbeat result for observability
      console.log(`[heartbeat] ${employee.name}: ${result.text?.slice(0, 100)}`);

    } catch (err) {
      console.error(`[heartbeat] Error for ${employee.name}:`, err);
      // Update timestamp anyway to prevent retry storm
      await db.update(agentEmployees).set({
        last_heartbeat_at: now,
      }).where(eq(agentEmployees.id, employee.id));
    }
  }
}
```

- [ ] **Step 2: Register heartbeat in workers/index.ts**

In the `getScheduledJobHandler` switch, add:

```typescript
case 'agent-heartbeat': {
  const mod = await import('./handlers/agent-employee-heartbeat.js');
  return mod.handleAgentEmployeeHeartbeat;
}
```

In CRON_DELAYS, add:

```typescript
'agent-heartbeat': 60 * 1000,  // Check every 60 seconds which employees are due
```

In CRON_KEYS, add:

```typescript
'agent-heartbeat': 'agent-heartbeat',
```

Note: The heartbeat worker runs every 60 seconds but each employee's actual interval is configurable (default 30 min). The worker checks which employees are due on each run.

- [ ] **Step 3: Typecheck**

Run: `cd apps/api && pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/workers/handlers/agent-employee-heartbeat.ts apps/api/src/workers/index.ts
git commit -m "feat(heartbeat): add proactive agent employee heartbeat worker

Cron checks every 60s which employees have heartbeat due.
Per-employee interval (default 30 min). Reads heartbeat_config
checklist, runs agent-runner in background mode. HEARTBEAT_OK
suppressed for minimal token cost. Respects daily action budget."
```

---

### Task 6: Heartbeat — API + Wizard Integration

**Files:**
- Modify: `apps/api/src/routes/agent-employees.ts`
- Modify: `apps/web/src/app/(app)/settings/agent-employees/create/page.tsx`
- Modify: `apps/web/src/app/(app)/settings/agent-employees/page.tsx`

- [ ] **Step 1: Accept heartbeat fields in create/update endpoints**

In `apps/api/src/routes/agent-employees.ts`, find the create schema (around line 102-117). Add:

```typescript
heartbeat_enabled: z.boolean().default(false),
heartbeat_interval_min: z.number().int().min(5).max(1440).default(30),
heartbeat_config: z.string().optional(),
```

In the insert statement (around line 187-209), add:

```typescript
heartbeat_enabled: data.heartbeat_enabled,
heartbeat_interval_min: data.heartbeat_interval_min,
heartbeat_config: data.heartbeat_config || null,
```

In the PUT /:id update handler, add the same fields to the allowed update set.

- [ ] **Step 2: Add heartbeat defaults to role templates**

Find the `ROLE_TEMPLATES` object in agent-employees.ts. Add heartbeat_config to each:

```typescript
project_manager: {
  // ... existing fields
  heartbeat_config: `### Every 30 minutes:
- Check for tasks overdue by more than 24 hours. If found, post a summary in the task's project channel.
- Check for tasks with status 'in_progress' that haven't been updated in 48+ hours. DM the assignee asking for a status update.

### Every morning (if first heartbeat of the day):
- Generate a brief standup summary from yesterday's task activity and post in #general.`,
},
engineering_lead: {
  // ... existing fields
  heartbeat_config: `### Every hour:
- Check for open PRs with no review activity in 24+ hours. Post a reminder in #engineering.
- Check for tasks blocked by code review. DM the reviewer.

### Every morning:
- Summarize merged PRs from yesterday and post in #engineering.`,
},
executive_assistant: {
  // ... existing fields
  heartbeat_config: `### Every 30 minutes:
- Check calendar for meetings in the next 30 minutes. If found, generate a prep brief and DM the attendee.
- Check for calendar conflicts in today's schedule. If found, alert the affected person.`,
},
```

- [ ] **Step 3: Add heartbeat step to wizard UI**

In `apps/web/src/app/(app)/settings/agent-employees/create/page.tsx`, expand from 3 steps to 4. Add Step 4 (Heartbeat) after Step 3 (Tools & Trust):

Add state:

```typescript
const [heartbeatEnabled, setHeartbeatEnabled] = useState(false);
const [heartbeatInterval, setHeartbeatInterval] = useState(30);
const [heartbeatConfig, setHeartbeatConfig] = useState('');
```

When role template is selected (Step 1), also pre-fill heartbeat:

```typescript
if (template?.heartbeat_config) {
  setHeartbeatConfig(template.heartbeat_config);
  setHeartbeatEnabled(true);
}
```

Step 4 UI:

```typescript
{step === 4 && (
  <div style={{ /* card style matching other steps */ }}>
    <h3>Heartbeat</h3>
    <p style={{ color: 'var(--muted)', fontSize: '12px', marginBottom: '16px' }}>
      Configure proactive monitoring. The agent will wake up at the specified interval
      and check its task list. If nothing needs attention, it stays silent.
    </p>
    
    <label>
      <input type="checkbox" checked={heartbeatEnabled}
        onChange={e => setHeartbeatEnabled(e.target.checked)} />
      Enable heartbeat monitoring
    </label>
    
    {heartbeatEnabled && (
      <>
        <div>
          <label>Check every (minutes)</label>
          <input type="number" value={heartbeatInterval} min={5} max={1440}
            onChange={e => setHeartbeatInterval(parseInt(e.target.value) || 30)} />
        </div>
        
        <div>
          <label>Heartbeat Checklist</label>
          <textarea value={heartbeatConfig}
            onChange={e => setHeartbeatConfig(e.target.value)}
            placeholder="### Every 30 minutes:\n- Check for overdue tasks..."
            rows={10} />
          <p style={{ color: 'var(--muted)', fontSize: '11px' }}>
            Write in plain English. Use ### headings for different intervals.
          </p>
        </div>
      </>
    )}
  </div>
)}
```

Update the total steps count from 3 to 4. Update the step indicator. The "Create" button appears on step 4 instead of step 3.

Include heartbeat fields in the submit payload:

```typescript
heartbeat_enabled: heartbeatEnabled,
heartbeat_interval_min: heartbeatInterval,
heartbeat_config: heartbeatConfig || undefined,
```

- [ ] **Step 4: Show heartbeat status in employee list**

In `apps/web/src/app/(app)/settings/agent-employees/page.tsx`, add a heartbeat indicator next to each employee. After the "Active" status, show:

```typescript
{employee.heartbeat_enabled && (
  <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
    ♥ {employee.heartbeat_interval_min}m
  </span>
)}
```

- [ ] **Step 5: Typecheck and build**

Run: `cd apps/api && pnpm typecheck`
Run: `cd apps/web && pnpm typecheck`
Expected: Both pass

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agent-employees.ts apps/web/src/app/\(app\)/settings/agent-employees/create/page.tsx apps/web/src/app/\(app\)/settings/agent-employees/page.tsx
git commit -m "feat(heartbeat): API fields, wizard step, role template defaults

Accept heartbeat_enabled, heartbeat_interval_min, heartbeat_config
in create/update endpoints. Pre-fill from role templates.
Wizard expanded to 4 steps with heartbeat configuration.
Employee list shows heartbeat indicator."
```

---

## Verification

After all tasks:

1. `cd packages/db && npx tsc --noEmit` — must pass
2. `cd apps/api && pnpm typecheck` — must pass
3. `cd apps/web && pnpm typecheck` — must pass

Manual verification:

- **Wiki brain:** Create an agent employee, ask it a question that requires research. Check that the agent's response references wiki pages. Check that after the response, relevant wiki pages were updated or created. Check that on the next question, the employee's tagged pages load in context.

- **Heartbeat:** Create an agent employee with heartbeat enabled (30 min interval). Wait or manually trigger the heartbeat worker. Check that the agent either takes action (posts in channel, creates task) or logs HEARTBEAT_OK. Check that `last_heartbeat_at` is updated. Check that daily action count is respected.

- **Self-verification:** Send an agent employee a complex question in background mode. Check the logs for the verification call. Compare response quality with and without verification (disable by setting `mode !== 'background'` temporarily).

- **Iteration limit:** Assign a complex task to an agent employee. Verify it can reason for up to 25 iterations (check tool_calls count in response metadata).

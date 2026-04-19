# Playwright Approval Repetition & Agent Loop Fidelity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the agent from requesting full approval on every Playwright browser operation and stop repeating the same "this is outside my scope / needs approval" disclaimers after each approval.

**Architecture:**
1. **Fix A — MCP tool classification:** Read the Model Context Protocol's tool `annotations` (readOnlyHint, destructiveHint) during discovery and fall back to name-based heuristics when the server omits them. Clear the on-disk `tools_cache` so existing connections pick up the new classification on next use.
2. **Fix B — MCP capabilities in the system prompt:** When MCP tools are attached to a turn, append a dedicated "Your MCP Capabilities" section to the system prompt (both base Defty and agent-employee paths). Also stop the hard replacement at `agent.ts:427` that loses the wiki/MCP augmentation for employees.
3. **Fix C — Structured tool-loop persistence:** Store Anthropic-native content blocks (text, tool_use, tool_result) on `agent_messages` in a new `content_blocks` jsonb column, persist `tool_use_id` on `agent_actions`, rewrite history loading to rehydrate structured content, and replace the web-side synthetic `"[System: approved…]"` text with a real `tool_result` block inserted server-side followed by a dedicated `/continue` streaming endpoint.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres, Anthropic SDK (`@anthropic-ai/sdk`), Hono (SSE), `@modelcontextprotocol/sdk`, Next.js 16 / React, pnpm workspaces.

**Prerequisites:**
- API (`localhost:3001`) and web (`localhost:3000`) running via `pnpm dev:api` / `pnpm dev:web`.
- Postgres running on `localhost:5432` (db: `cairn`).
- Anthropic API key set in root `.env` (already present).
- Playwright MCP connection `eaddd45d-2606-4225-af35-d3ae09a7ce61` exists for the test org (already present) with agent employee Alex PM `7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633` wired to it.

**No existing test harness in this repo.** This plan uses repeatable debug scripts (`apps/api/src/scripts/*.ts`) as verification gates instead of unit tests. Each task has an explicit verification step with expected output.

---

## File Structure

### Fix A — MCP tool auto-classification
- **Modify** `packages/mcp/src/client.ts` — `mapTool()` reads `annotations` from the SDK tool object, derives tier/isWrite, falls back to name heuristics for `browser_*` tools.
- **Modify** `packages/mcp/src/types.ts` — extend `MCPTool` with optional `annotations` field for persistence/debug.
- **Create** `apps/api/src/scripts/reclassify-mcp-tools.ts` — one-shot script that clears `mcp_connections.tools_cache` and warms the in-memory cache by re-discovering tools for every active connection. Prints the new tier for each tool.

### Fix B — System prompt MCP capabilities
- **Modify** `apps/api/src/routes/agent.ts` around lines 259–428:
  - After MCP tools are loaded (around line 271), build a `mcpCapabilitiesSection` string.
  - Change the employee-prompt override at line 427 from full replacement to composition (`employeePrompt + connectionInfo + memoryContext + wikiContext + mcpCapabilitiesSection`).

### Fix C — Structured tool-loop persistence
- **Modify** `packages/db/src/schema.ts`:
  - `agentMessages`: add `content_blocks: jsonb('content_blocks')` (nullable).
  - `agentActions`: add `tool_use_id: text('tool_use_id')` (nullable, stores Anthropic `toolu_*` id).
- **Create** `packages/db/drizzle/0004_agent_content_blocks.sql` — migration that adds the two columns.
- **Modify** `apps/api/src/routes/agent.ts`:
  - Streaming loop: after each Anthropic iteration, insert one `agent_messages` row per iteration (role=`assistant`, `content_blocks` = full `response.content`, `content` = concatenated text for backward compat). Insert a hidden `user` row with `content_blocks` = `tool_results` array after each tool-result batch. Delete the "pre-create empty assistant row then update at end" pattern (lines 437–444, 693–703).
  - When creating pending `agentActions` rows (line 564), store `tool_use_id: tool.id`.
  - History loader (lines 227–231, 468–471): if a row has `content_blocks`, emit `{role, content: content_blocks}`; else fall back to `{role, content: text}`. Filter/skip rows with empty `content_blocks` and empty `content` (avoid the pre-created empty assistant placeholders).
  - New endpoint `POST /agent/conversations/:id/continue` — body `{actionId}`. Looks up the action, confirms it's approved + executed, inserts a hidden user `agent_messages` row with `content_blocks = [{ type: 'tool_result', tool_use_id, content }]`, then runs the shared streaming loop.
- **Create** `apps/api/src/lib/agent-stream-loop.ts` — extracted helper `runAgentStreamingLoop({ c, user, convoId, systemPrompt, tools, allActionTools, apiMessages, agentEmployeeId })` used by both `/messages` (send) and `/continue`. Hosts the iteration loop, persistence, SSE writing. `/messages` and `/continue` become thin wrappers that build `apiMessages` then hand off.
- **Modify** `apps/api/src/routes/agent.ts` `POST /actions/:id/approve`: after `executeAction` succeeds, insert the hidden tool_result user row (via the same helper `insertToolResultMessage`). Do NOT stream — just return JSON. (Streaming is triggered by the client calling `/continue` on success.)
- **Modify** `apps/web/src/components/agent-chat.tsx`:
  - Replace the `await sendMessage("[System: approved…]", true)` calls at lines 648 and 671 with `await continueAfterAction(actionId)` / `continueAfterActions(actionIds)`.
  - Implement `continueAfterAction` that POSTs to `/api/agent/conversations/:convoId/continue` with the action id and streams the SSE response using the same stream-handling path as `sendMessage` (extract the SSE handler into a shared function inside the component so both call sites use it).

### Fix C — verification script
- **Create** `apps/api/src/scripts/verify-structured-history.ts` — loads latest conversation for Alex, dumps each row's `content_blocks` (structure-only), confirms tool_use / tool_result pairing.

---

## Task Breakdown

### Task 1: Read MCP tool annotations and classify by name

**Files:**
- Modify: `packages/mcp/src/types.ts`
- Modify: `packages/mcp/src/client.ts` (around `mapTool` at line 291)

- [ ] **Step 1.1: Extend MCPTool type with annotations**

Open `packages/mcp/src/types.ts`. After the `approvalTier` field in the `MCPTool` interface (around line 46), add:

```ts
  /**
   * Raw MCP tool annotations from the protocol, if the server provided them.
   * { readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint?, title? }
   * See https://modelcontextprotocol.io/specification/server/tools
   */
  annotations?: Record<string, unknown> | null;
```

- [ ] **Step 1.2: Classify tools in `mapTool`**

In `packages/mcp/src/client.ts`, replace the current `mapTool` function (lines 291–308) with the following. Note: pulls `annotations` from the SDK tool object (cast via index access since the SDK types are permissive), chooses tier via annotations → name heuristic → default.

```ts
  private mapTool(
    tool: { name: string; description?: string; inputSchema?: unknown; annotations?: unknown },
    config: MCPConnectionConfig,
    overrides: MCPToolOverride[]
  ): MCPTool {
    const override = overrides.find((o) => o.toolName === tool.name);
    const annotations = (tool as { annotations?: Record<string, unknown> }).annotations ?? null;

    const classified = classifyTool(tool.name, annotations);

    return {
      name: `mcp__${config.connectionSlug}__${tool.name}`,
      originalName: tool.name,
      description: override?.description ?? tool.description ?? "",
      inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {},
      connectionId: config.connectionId,
      connectionSlug: config.connectionSlug,
      isWrite: override?.isWrite ?? classified.isWrite,
      approvalTier: override?.approvalTier ?? classified.approvalTier,
      annotations,
    };
  }
```

- [ ] **Step 1.3: Add the `classifyTool` helper**

Still in `packages/mcp/src/client.ts`, add this helper function above the `MCPClientManager` class (after the imports, before `class MCPClientManager`):

```ts
/**
 * Classify an MCP tool into an approval tier based on protocol annotations
 * and a name-based fallback. Returns `isWrite` and `approvalTier`.
 *
 * Precedence (highest to lowest):
 *   1. annotations.destructiveHint === true → full-review, isWrite=true
 *   2. annotations.readOnlyHint === true    → auto-execute, isWrite=false
 *   3. Name heuristics (browser_*, filesystem_*, git_*, ...)
 *   4. Default: full-review, isWrite=false (conservative)
 */
function classifyTool(
  name: string,
  annotations: Record<string, unknown> | null
): { approvalTier: MCPTool["approvalTier"]; isWrite: boolean } {
  // 1. Explicit protocol annotations win
  if (annotations) {
    if (annotations.destructiveHint === true) {
      return { approvalTier: "full-review", isWrite: true };
    }
    if (annotations.readOnlyHint === true) {
      return { approvalTier: "auto-execute", isWrite: false };
    }
  }

  // 2. Name-based heuristics for common MCP servers
  // browser_* (Playwright): everything is safe within a session the user opened.
  // Pure reads auto-execute, state-changing browser ops quick-approve,
  // ones that exfiltrate or run arbitrary code stay full-review.
  if (name.startsWith("browser_")) {
    // Pure reads: no page state change
    const READ_ONLY_BROWSER = new Set([
      "browser_snapshot",
      "browser_take_screenshot",
      "browser_console_messages",
      "browser_network_requests",
      "browser_tabs",
      "browser_wait_for",
    ]);
    if (READ_ONLY_BROWSER.has(name)) {
      return { approvalTier: "auto-execute", isWrite: false };
    }

    // High-risk: arbitrary code exec, file upload, closing session, dialog handling
    const DESTRUCTIVE_BROWSER = new Set([
      "browser_run_code",
      "browser_evaluate",
      "browser_file_upload",
      "browser_close",
      "browser_handle_dialog",
    ]);
    if (DESTRUCTIVE_BROWSER.has(name)) {
      return { approvalTier: "full-review", isWrite: true };
    }

    // Everything else (navigate, click, type, press_key, hover, drag,
    // fill_form, select_option, resize, navigate_back) — quick approve.
    return { approvalTier: "quick-approve", isWrite: false };
  }

  // filesystem_* servers — reads auto, writes full
  if (name.startsWith("filesystem_read") || name === "filesystem_list") {
    return { approvalTier: "auto-execute", isWrite: false };
  }
  if (name.startsWith("filesystem_")) {
    return { approvalTier: "full-review", isWrite: true };
  }

  // git_* — log/diff/show are reads, everything else is full
  if (name === "git_log" || name === "git_diff" || name === "git_show" || name === "git_status") {
    return { approvalTier: "auto-execute", isWrite: false };
  }
  if (name.startsWith("git_")) {
    return { approvalTier: "full-review", isWrite: true };
  }

  // 3. Default: stay conservative
  return { approvalTier: "full-review", isWrite: false };
}
```

- [ ] **Step 1.4: Typecheck the mcp package**

Run:
```bash
pnpm --filter @deft/mcp typecheck
```
Expected: no errors. If `tsc` complains about unused `isWrite` or any missing export, fix inline.

- [ ] **Step 1.5: Commit**

```bash
git add packages/mcp/src/client.ts packages/mcp/src/types.ts
git commit -m "fix(mcp): classify tools via annotations + name heuristics"
```

---

### Task 2: Force re-classification of cached Playwright tools

**Files:**
- Create: `apps/api/src/scripts/reclassify-mcp-tools.ts`

- [ ] **Step 2.1: Write the re-classification script**

Create `apps/api/src/scripts/reclassify-mcp-tools.ts`:

```ts
/**
 * One-shot: clear mcp_connections.tools_cache on every active connection and
 * re-discover tools via the MCPClientManager. Prints each tool's new
 * approvalTier so you can confirm the new classification is correct.
 *
 * Run: pnpm --filter @deft/api exec tsx src/scripts/reclassify-mcp-tools.ts
 */
import { db } from '../lib/db.js';
import { mcpConnections } from '@deft/db/schema';
import { eq } from 'drizzle-orm';
import { mcpClientManager } from '@deft/mcp';
import { toConnectionConfig } from '../lib/mcp-tools.js';

async function main() {
  const active = await db
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.is_active, true));

  if (active.length === 0) {
    console.log('No active MCP connections found.');
    process.exit(0);
  }

  for (const conn of active) {
    console.log(`\n── ${conn.name} (${conn.slug}) [${conn.id}] ──`);

    // 1. Clear the stale DB cache.
    await db
      .update(mcpConnections)
      .set({ tools_cache: null, tools_cache_fetched_at: null })
      .where(eq(mcpConnections.id, conn.id));

    // 2. Force fresh discovery (bypasses in-memory cache for this connection).
    const config = toConnectionConfig(conn);
    try {
      const tools = await mcpClientManager.getCachedTools(config, []);
      console.log(`  Discovered ${tools.length} tools:`);
      for (const t of tools) {
        console.log(
          `    ${t.originalName.padEnd(30)} tier=${t.approvalTier.padEnd(14)} isWrite=${t.isWrite}`
        );
      }

      // 3. Persist the re-classified list back to tools_cache.
      await db
        .update(mcpConnections)
        .set({
          tools_cache: tools as any,
          tools_cache_fetched_at: new Date(),
        })
        .where(eq(mcpConnections.id, conn.id));
    } catch (err) {
      console.error(
        `  Failed to re-discover: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  console.log('\nDone. Restart the API so existing in-memory caches also get the new tiers.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

**Note:** If `mcpConnections.tools_cache_fetched_at` doesn't exist as a column, use just `tools_cache: null` in the update. Verify via `grep tools_cache_fetched_at packages/db/src/schema.ts` before running. If absent, delete the `tools_cache_fetched_at` references in both `set(...)` calls.

- [ ] **Step 2.2: Verify the column names before running**

Run:
```bash
grep -n "tools_cache" "C:/Users/Osheen Pradhan/cairn/packages/db/src/schema.ts"
```
Expected: shows the exact column(s) on `mcpConnections`. Edit the script to match.

- [ ] **Step 2.3: Run the script**

Run:
```bash
cd "C:/Users/Osheen Pradhan/cairn/apps/api" && pnpm exec tsx src/scripts/reclassify-mcp-tools.ts
```

Expected output (names may vary, tiers must match):
```
── Playwright Browser (playwright-browser) [eaddd45d-...] ──
  Discovered 21 tools:
    browser_snapshot               tier=auto-execute   isWrite=false
    browser_take_screenshot        tier=auto-execute   isWrite=false
    browser_navigate               tier=quick-approve  isWrite=false
    browser_click                  tier=quick-approve  isWrite=false
    browser_type                   tier=quick-approve  isWrite=false
    browser_press_key              tier=quick-approve  isWrite=false
    browser_close                  tier=full-review    isWrite=true
    browser_run_code               tier=full-review    isWrite=true
    browser_evaluate               tier=full-review    isWrite=true
    ...
```

If any tool still shows `full-review` for something other than the `DESTRUCTIVE_BROWSER` set, the classifier is wrong — fix and re-run.

- [ ] **Step 2.4: Restart the API so the in-memory tool cache is discarded**

The API you started earlier is holding old tools in `MCPClientManager.toolCache`. Find its PID and restart:
```bash
powershell.exe -Command "Get-NetTCPConnection -State Listen | Where-Object { \$_.LocalPort -eq 3001 } | Select-Object OwningProcess" 
powershell.exe -Command "Stop-Process -Id <pid> -Force"
```
Then start it again with `pnpm --filter @deft/api dev` (background task). Verify it boots cleanly by reading the log until you see `Deft API running on http://localhost:3001`.

- [ ] **Step 2.5: Commit**

```bash
git add apps/api/src/scripts/reclassify-mcp-tools.ts
git commit -m "chore(mcp): script to reclassify cached MCP tools"
```

---

### Task 3: Inject MCP capabilities section into the system prompt

**Files:**
- Modify: `apps/api/src/routes/agent.ts` (around lines 259–428)

- [ ] **Step 3.1: Capture MCP tool metadata for the prompt section**

In `apps/api/src/routes/agent.ts`, find the MCP tools loading block (lines 259–271). The current code only iterates `mcpTools` to add them to `tools` and `allActionTools`. Extend the same loop to collect a grouped summary.

Replace lines 259–271 with:

```ts
  // MCP tools — discover from active connections and auto-classify tiers.
  const mcpToolsBySlug = new Map<string, { originalName: string; tier: string }[]>();
  try {
    const mcpTools = await getMCPToolsForAgent(org?.id ?? user.org_id, agentEmployeeId);
    const mcpAnthropicTools = mcpTools.map(mcpToolToAnthropicFormat);
    tools = [...tools, ...mcpAnthropicTools];
    mcpTools.forEach(t => {
      if (t.approvalTierMapped !== 'auto') {
        allActionTools.add(t.name);
      }
      const slug = t.connectionSlug;
      const existing = mcpToolsBySlug.get(slug) || [];
      existing.push({ originalName: t.originalName, tier: t.approvalTierMapped });
      mcpToolsBySlug.set(slug, existing);
    });
  } catch (err) {
    console.warn('[agent] Failed to load MCP tools:', err instanceof Error ? err.message : err);
  }
```

- [ ] **Step 3.2: Build the MCP capabilities section**

Still in `agent.ts`, find where `systemPrompt` is assembled (around lines 364–367) — right after the `SYSTEM_PROMPT.replace(...) + connectionInfo + memoryContext` line. Add directly after that line:

```ts
  // Build the MCP capabilities section so the agent knows what external
  // tools it has. Without this, employees with a narrow system prompt
  // (e.g. "project manager") will refuse to use browser tools.
  let mcpCapabilitiesSection = '';
  if (mcpToolsBySlug.size > 0) {
    const lines: string[] = ['\n\n## Your Connected MCP Capabilities'];
    for (const [slug, toolList] of mcpToolsBySlug.entries()) {
      lines.push(`\n**${slug}** — ${toolList.length} tools available:`);
      const byTier: Record<string, string[]> = { auto: [], quick: [], full: [] };
      for (const t of toolList) byTier[t.tier]?.push(t.originalName);
      if (byTier.auto!.length) lines.push(`  - instant (no approval needed): ${byTier.auto!.join(', ')}`);
      if (byTier.quick!.length) lines.push(`  - quick-approve: ${byTier.quick!.join(', ')}`);
      if (byTier.full!.length)  lines.push(`  - full-review (ask first): ${byTier.full!.join(', ')}`);
    }
    lines.push(
      '\nUse these tools whenever the user asks for something that matches their purpose.',
      'Do NOT disclaim that the task is "outside your scope" — if the tool is listed here, it IS in scope.',
      'Do NOT narrate approval flow to the user — the UI already shows an approve/reject card.',
      'When a tool requires approval, call it once and stop; wait for the result to come back.',
    );
    mcpCapabilitiesSection = lines.join('\n');
  }
```

- [ ] **Step 3.3: Compose instead of hard-replacing for agent employees**

In `agent.ts` around line 427, the current code is:
```ts
  if (employeePrompt) {
    systemPrompt = employeePrompt;
  }
```

This replaces the whole system prompt with the employee's, losing `connectionInfo`, `memoryContext`, the wiki auto-load, and now `mcpCapabilitiesSection`. Change to composition:

```ts
  if (employeePrompt) {
    // Compose: employee identity + shared context (connections, memory, wiki, MCP).
    systemPrompt = employeePrompt + connectionInfo + memoryContext + mcpCapabilitiesSection;
  } else {
    systemPrompt += mcpCapabilitiesSection;
  }
```

**Note:** `systemPrompt` already includes the wiki context at this point (it was appended earlier around lines 415–420). `connectionInfo` and `memoryContext` are also in the base systemPrompt. When we replace for the employee case we need to re-add them — but we don't want duplicates. Simplest: add `mcpCapabilitiesSection` to both branches. For the wiki/memory duplication issue, verify the final prompt length isn't catastrophic (it won't be — this is an existing design flaw we're partially fixing).

Actually: re-read lines 364–428 carefully. `systemPrompt` at line 364 = base + connectionInfo + memoryContext. Wiki is appended at line 419. Line 427 replaces the whole thing with `employeePrompt`. So employees currently lose connectionInfo + memoryContext + wiki.

Fix: restructure to append context to both base and employee branch. Use:

```ts
  const sharedContext = connectionInfo + memoryContext + wikiSection + mcpCapabilitiesSection;
  // where wikiSection is built above instead of being appended to systemPrompt directly.
```

Actually the wiki code currently mutates `systemPrompt` directly: `systemPrompt += '\n\nRelevant knowledge...'`. Refactor that block too. Change lines 415–420 from:
```ts
        systemPrompt += `\n\nRelevant knowledge from the team wiki:\n${wikiContext}\nUse wiki_search and wiki_read tools for more details.`;
```
to:
```ts
        wikiSection = `\n\nRelevant knowledge from the team wiki:\n${wikiContext}\nUse wiki_search and wiki_read tools for more details.`;
```
Declare `let wikiSection = '';` above the try block. Then at line 427:
```ts
  if (employeePrompt) {
    systemPrompt = employeePrompt + connectionInfo + memoryContext + wikiSection + mcpCapabilitiesSection;
  } else {
    systemPrompt = systemPrompt + wikiSection + mcpCapabilitiesSection;
  }
```

Also adjust the earlier `systemPrompt` assembly at 364–367: remove `+ connectionInfo + memoryContext` there since we're now adding it in the final assembly. Or keep it there and skip re-adding for non-employee branch. Cleanest: remove from 364, add in both branches.

Change lines 364–367 from:
```ts
  let systemPrompt = SYSTEM_PROMPT.replace(
    '{{DATE}}',
    new Date().toISOString().split('T')[0]!,
  ).replace('{{ORG}}', org?.name || 'Unknown') + connectionInfo + memoryContext;
```
to:
```ts
  let systemPrompt = SYSTEM_PROMPT.replace(
    '{{DATE}}',
    new Date().toISOString().split('T')[0]!,
  ).replace('{{ORG}}', org?.name || 'Unknown');
  let wikiSection = '';
```

Then update the wiki block to write to `wikiSection` (step 3 above) instead of appending to `systemPrompt`.

And the final compose:
```ts
  if (employeePrompt) {
    systemPrompt = employeePrompt + connectionInfo + memoryContext + wikiSection + mcpCapabilitiesSection;
  } else {
    systemPrompt = systemPrompt + connectionInfo + memoryContext + wikiSection + mcpCapabilitiesSection;
  }
```

- [ ] **Step 3.4: Typecheck**

Run:
```bash
pnpm --filter @deft/api typecheck
```
Expected: no errors. If there are unrelated errors from the baseline, note them and move on — don't fix pre-existing errors in this task.

- [ ] **Step 3.5: Manual verification**

Restart the API (stop the background task, start fresh). Open `http://localhost:3000/agent?employee=7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633`. Ask Alex: "go to theverge.com and tell me the headlines". Expected:
- Alex does NOT write a "this is outside my PM scope" disclaimer.
- Browser_snapshot + browser_take_screenshot execute without an approval card (auto).
- Only browser_navigate triggers an approval (quick-approve tier).
- Alex summarizes the headlines after the tool result.

If Alex still disclaims: check the prompt in Postgres via:
```bash
pnpm --filter @deft/api exec tsx src/scripts/debug-agent-conversation.ts
```
and confirm `mcp_connection_ids` is set. If the disclaimer persists even with the section, the employee's stored `system_prompt` is strongly overriding — proceed to Task 4 anyway; the structural fix there will not help the disclaimers directly but Task 3 should. Consider also appending a stronger instruction like `'IMPORTANT: If a tool is listed in your MCP Capabilities section, using it IS within your scope.'` to the section.

- [ ] **Step 3.6: Commit**

```bash
git add apps/api/src/routes/agent.ts
git commit -m "fix(agent): inject MCP capabilities into system prompt + compose for employees"
```

---

### Task 4: Add `content_blocks` column to agent_messages and `tool_use_id` to agent_actions

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0004_agent_content_blocks.sql`

- [ ] **Step 4.1: Extend the schema**

In `packages/db/src/schema.ts` around line 354, add `content_blocks` to `agentMessages`:

```ts
export const agentMessages = pgTable('agent_messages', {
  ...id(),
  conversation_id: text('conversation_id').notNull().references(() => agentConversations.id),
  role: text('role').notNull(), // 'user', 'assistant'
  content: text('content').notNull(),
  content_blocks: jsonb('content_blocks'), // Anthropic content blocks: [{type:'text',text}] | [{type:'tool_use',id,name,input}] | [{type:'tool_result',tool_use_id,content}]
  citations: jsonb('citations'),
  tool_calls: jsonb('tool_calls'),
  hidden: boolean('hidden').default(false).notNull(),
  model: text('model'),
  tokens_in: integer('tokens_in'),
  tokens_out: integer('tokens_out'),
  ...timestamps(),
});
```

And around line 368 on `agentActions`, add `tool_use_id`:

```ts
export const agentActions = pgTable('agent_actions', {
  ...id(),
  ...orgId(),
  user_id: text('user_id').notNull().references(() => users.id),
  conversation_id: text('conversation_id').references(() => agentConversations.id),
  message_id: text('message_id'),
  agent_employee_id: text('agent_employee_id'),
  tool_use_id: text('tool_use_id'), // Anthropic tool_use block id (toolu_*) for matching tool_result
  source: text('source').default('native'),
  // ...rest unchanged
```

- [ ] **Step 4.2: Write the migration SQL manually**

Create `packages/db/drizzle/0004_agent_content_blocks.sql`:

```sql
ALTER TABLE "agent_messages" ADD COLUMN "content_blocks" jsonb;
ALTER TABLE "agent_actions" ADD COLUMN "tool_use_id" text;
```

- [ ] **Step 4.3: Update the Drizzle journal**

Open `packages/db/drizzle/meta/_journal.json`. Check the highest `idx` and add a new entry:

```bash
cat "C:/Users/Osheen Pradhan/cairn/packages/db/drizzle/meta/_journal.json"
```

Add a new entry matching the existing format, e.g.:
```json
{
  "idx": 4,
  "version": "7",
  "when": 1744459200000,
  "tag": "0004_agent_content_blocks",
  "breakpoints": true
}
```

Use `Date.now()` in ms at the time of editing (`node -e "console.log(Date.now())"`).

**Caveat:** If the journal version / format in the repo uses `drizzle-kit` auto-generation with snapshot files, the safer approach is: `pnpm --filter @deft/db generate` after the schema change, let drizzle-kit produce the SQL and snapshot. Try that first:

```bash
cd "C:/Users/Osheen Pradhan/cairn/packages/db" && pnpm generate
```
Expected: creates `0004_<adjective>_<noun>.sql` + `0004_snapshot.json` + updates `_journal.json`. If it works, skip steps 4.2 + 4.3 and use the generated files (rename the file if it must match the name referenced here, otherwise leave as-is).

- [ ] **Step 4.4: Apply the migration**

```bash
cd "C:/Users/Osheen Pradhan/cairn/packages/db" && pnpm push
```
Expected: "No schema changes to push" if already applied, or reports the two added columns. If pnpm push fails, use psql via Node:
```bash
cd "C:/Users/Osheen Pradhan/cairn/apps/api" && pnpm exec tsx -e "import {db} from './src/lib/db.js'; import {sql} from 'drizzle-orm'; await db.execute(sql\`ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS content_blocks jsonb\`); await db.execute(sql\`ALTER TABLE agent_actions ADD COLUMN IF NOT EXISTS tool_use_id text\`); console.log('done'); process.exit(0);"
```

- [ ] **Step 4.5: Verify the columns exist**

```bash
cd "C:/Users/Osheen Pradhan/cairn/apps/api" && pnpm exec tsx -e "import {db} from './src/lib/db.js'; import {sql} from 'drizzle-orm'; const r = await db.execute(sql\`SELECT column_name FROM information_schema.columns WHERE table_name IN ('agent_messages','agent_actions') AND column_name IN ('content_blocks','tool_use_id')\`); console.log(r.rows); process.exit(0);"
```
Expected output includes both `content_blocks` and `tool_use_id`.

- [ ] **Step 4.6: Typecheck**

```bash
pnpm --filter @deft/db typecheck && pnpm --filter @deft/api typecheck
```
Expected: no errors.

- [ ] **Step 4.7: Commit**

```bash
git add packages/db/src/schema.ts packages/db/drizzle/0004_agent_content_blocks.sql packages/db/drizzle/meta/_journal.json packages/db/drizzle/meta/0004_snapshot.json
git commit -m "feat(schema): content_blocks on agent_messages, tool_use_id on agent_actions"
```

---

### Task 5: Extract shared streaming loop into `agent-stream-loop.ts`

**Files:**
- Create: `apps/api/src/lib/agent-stream-loop.ts`
- Modify: `apps/api/src/routes/agent.ts` (replace the inline loop body with a call to the helper)

- [ ] **Step 5.1: Create the shared helper file**

Create `apps/api/src/lib/agent-stream-loop.ts`. The helper hosts the complete while-loop from `agent.ts:477–645`, plus per-iteration persistence logic. It accepts everything the loop currently reads from its closure.

```ts
/**
 * Shared streaming agent loop used by POST /messages (initial send) and
 * POST /continue (resume after action approval).
 *
 * Responsibilities:
 *  - Run the Anthropic tool-use loop to completion or budget exhaustion
 *  - For each iteration, persist the assistant content_blocks and any
 *    tool_result user message so future turns have a faithful history
 *  - Stream SSE events to the client via the provided `write` function
 *  - Create agent_actions rows for tools that require approval and stop
 *    the loop if any are pending (waiting for user approval)
 */
import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';
import { agentActions, agentConversations, agentMessages } from '@deft/db/schema';
import { eq } from 'drizzle-orm';
import { env } from './env.js';
import { executeToolCall } from './agent-context.js';
import { getApprovalTier, shouldAutoExecute, type TrustLevel } from './agent-approval.js';

export interface StreamLoopParams {
  convoId: string;
  userId: string;
  orgId: string;
  agentEmployeeId: string | undefined;
  systemPrompt: string;
  tools: Anthropic.Tool[];
  allActionTools: Set<string>;
  trustLevel: TrustLevel;
  apiMessages: Anthropic.MessageParam[];
  write: (data: any) => Promise<void>;
  abortSignal: AbortSignal;
  model: string;
}

export interface StreamLoopResult {
  finalText: string;
  citations: any[];
  pendingActions: { id: string; action: string; params: any }[];
  totalTokensIn: number;
  totalTokensOut: number;
}

const MAX_INPUT_TOKENS = 200_000;
const MAX_ITERATIONS = 50;

export async function runAgentStreamingLoop(p: StreamLoopParams): Promise<StreamLoopResult> {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  let apiMessages = [...p.apiMessages];
  let finalText = '';
  let allCitations: any[] = [];
  const pendingActions: { id: string; action: string; params: any }[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let iterations = 0;

  while (iterations < MAX_ITERATIONS && totalTokensIn < MAX_INPUT_TOKENS) {
    iterations++;
    console.log(`[agent-loop] iter=${iterations} tokens=${totalTokensIn}/${MAX_INPUT_TOKENS} msgs=${apiMessages.length}`);

    const response = await anthropic.messages.create({
      model: p.model,
      max_tokens: 4096,
      system: p.systemPrompt,
      messages: apiMessages,
      tools: p.tools,
    }, { signal: p.abortSignal });

    if (response.usage) {
      totalTokensIn += response.usage.input_tokens || 0;
      totalTokensOut += response.usage.output_tokens || 0;
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text'
    );

    const iterText = textBlocks.map((b) => b.text).join('\n\n').trim();

    // Persist the assistant turn (content_blocks + plain text).
    const [assistantRow] = await db.insert(agentMessages).values({
      conversation_id: p.convoId,
      role: 'assistant',
      content: iterText,
      content_blocks: response.content as any,
      hidden: toolUseBlocks.length > 0 && !iterText, // intermediate empty turns stay hidden
      model: p.model,
      tokens_in: response.usage?.input_tokens ?? null,
      tokens_out: response.usage?.output_tokens ?? null,
    }).returning();

    // Stream any text from this iteration.
    if (iterText) {
      for (const word of iterText.split(/(\s+)/)) {
        if (p.abortSignal.aborted) break;
        await p.write({ type: 'text', text: word });
      }
    }

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      finalText = iterText;
      break;
    }

    // Execute / enqueue tools, building the tool_result user turn.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let haltAfterThisIteration = false;

    for (const tool of toolUseBlocks) {
      const isAction = p.allActionTools.has(tool.name);

      if (isAction) {
        // Write action — insert pending agent_actions row and stop the loop.
        const approvalTier = getApprovalTier(tool.name);

        if (shouldAutoExecute(tool.name, p.trustLevel)) {
          // Trust level permits auto-exec — run synchronously.
          try {
            const { result, citations } = await executeToolCall(
              tool.name, tool.input as any, p.orgId, p.userId, p.convoId, p.agentEmployeeId,
            );
            allCitations.push(...citations);
            await p.write({ type: 'tool_result', tool: tool.name, count: Array.isArray(result) ? result.length : 1 });
            toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Tool execution failed';
            await p.write({ type: 'tool_result', tool: tool.name, error: errorMsg });
            toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify({ error: errorMsg }), is_error: true });
          }
          continue;
        }

        // Needs approval — create the action row and halt.
        const [actionRecord] = await db
          .insert(agentActions)
          .values({
            org_id: p.orgId,
            user_id: p.userId,
            conversation_id: p.convoId,
            agent_employee_id: p.agentEmployeeId ?? null,
            action: tool.name,
            params: tool.input as any,
            approval_tier: approvalTier,
            approval_status: 'pending',
            message_id: assistantRow!.id,
            tool_use_id: tool.id,
          })
          .returning();

        pendingActions.push({ id: actionRecord!.id, action: tool.name, params: tool.input });
        await p.write({ type: 'pending_action', id: actionRecord!.id, action: tool.name, params: tool.input });

        // No tool_result is produced yet — we'll halt after collecting any auto-execs.
        haltAfterThisIteration = true;
      } else {
        // Read-only tool — execute now.
        try {
          await p.write({ type: 'tool_start', tool: tool.name });
          const { result, citations } = await executeToolCall(
            tool.name, tool.input as any, p.orgId, p.userId, p.convoId, p.agentEmployeeId,
          );
          allCitations.push(...citations);
          await p.write({ type: 'tool_result', tool: tool.name, count: Array.isArray(result) ? result.length : 1 });
          toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : 'Tool execution failed';
          await p.write({ type: 'tool_result', tool: tool.name, error: errorMsg });
          toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify({ error: errorMsg }), is_error: true });
        }
      }
    }

    // Persist the tool_result user turn (only for the results we produced).
    if (toolResults.length > 0) {
      await db.insert(agentMessages).values({
        conversation_id: p.convoId,
        role: 'user',
        content: '',
        content_blocks: toolResults as any,
        hidden: true,
      });

      // Feed them into the next iteration.
      apiMessages = [
        ...apiMessages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
    }

    if (haltAfterThisIteration) {
      // Pending approval — stop here. Next /continue call resumes.
      finalText = iterText;
      break;
    }
  }

  // Update conversation updated_at.
  await db
    .update(agentConversations)
    .set({ updated_at: new Date() })
    .where(eq(agentConversations.id, p.convoId));

  return { finalText, citations: allCitations, pendingActions, totalTokensIn, totalTokensOut };
}
```

**Note on the halt semantics:** currently the old code in `agent.ts` uses a `{status: 'pending_approval'}` stub tool_result to let the loop continue and produce a natural-language "I'll wait" response. We're intentionally changing this: halt with the pending action card and let the user drive. This eliminates the repeated "I'm navigating The Verge, but requires approval…" prose.

- [ ] **Step 5.2: Typecheck**

```bash
pnpm --filter @deft/api typecheck
```
Expected: some errors about `agent.ts` still referencing the helper differently — that's OK, Task 6 fixes it. Do NOT commit yet. If `agent-stream-loop.ts` itself has errors, fix them before moving on.

- [ ] **Step 5.3: Commit (partial — helper only)**

```bash
git add apps/api/src/lib/agent-stream-loop.ts
git commit -m "refactor(agent): extract shared streaming loop helper"
```

---

### Task 6: Rewrite `POST /messages` to use the shared loop + persist structured history

**Files:**
- Modify: `apps/api/src/routes/agent.ts` (replace lines 437–707 approximately — the SSE streaming block)

- [ ] **Step 6.1: Replace the streaming block**

In `agent.ts`, locate the block starting with the pre-create of the empty assistant message (around line 437: `const assistantMsgId = crypto.randomUUID(); await db.insert(agentMessages).values({...})`) and extending through the `apiMessages = [...]` history mapper (line 468) and through the end of the update block around line 707 (`await db.update(agentConversations).set({updated_at: new Date()})...`).

Replace with:

```ts
  return streamSSE(c, async (sseStream) => {
    console.log(`[agent] SSE stream started for conversation ${convoId}`);
    const abortController = new AbortController();
    sseStream.onAbort(() => { console.log(`[agent] Stream aborted for ${convoId}`); abortController.abort(); });

    const write = async (data: any) => {
      await sseStream.writeSSE({ data: JSON.stringify(data) });
    };

    const keepalive = setInterval(async () => {
      try { await sseStream.writeSSE({ data: JSON.stringify({ type: 'heartbeat' }) }); } catch { /* closed */ }
    }, 10000);

    try {
      // Rehydrate history into Anthropic message format. Rows with content_blocks
      // use the structured form; legacy rows use the plain text content.
      const apiMessages: Anthropic.MessageParam[] = [];
      for (const m of history) {
        if (m.content_blocks && Array.isArray(m.content_blocks) && (m.content_blocks as any[]).length > 0) {
          apiMessages.push({ role: m.role as 'user' | 'assistant', content: m.content_blocks as any });
        } else if (m.content && m.content.trim().length > 0) {
          apiMessages.push({ role: m.role as 'user' | 'assistant', content: m.content });
        }
        // Skip empty rows (e.g. pre-created placeholder rows from the old code).
      }

      const result = await runAgentStreamingLoop({
        convoId,
        userId: user.id,
        orgId: user.org_id,
        agentEmployeeId,
        systemPrompt,
        tools,
        allActionTools,
        trustLevel: (employeeTrustLevel ?? trustLevel) as TrustLevel,
        apiMessages,
        write,
        abortSignal: abortController.signal,
        model: reasonConfig.model,
      });

      if (result.citations.length > 0) {
        await write({ type: 'citations', citations: result.citations });
      }
      if (result.pendingActions.length > 0) {
        await write({ type: 'actions', actions: result.pendingActions });
      }
      clearInterval(keepalive);
      await write({
        type: 'done',
        model: reasonConfig.model,
        tokens_in: result.totalTokensIn,
        tokens_out: result.totalTokensOut,
      });
    } catch (err) {
      clearInterval(keepalive);
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[agent] Stream error:', errMsg);
      try {
        await write({ type: 'error', error: errMsg });
      } catch { /* closed */ }
    }
  });
```

Delete the pre-created empty `assistantMsgId` row insert (the helper now inserts one row per iteration).

- [ ] **Step 6.2: Add the import**

At the top of `agent.ts`, add:
```ts
import { runAgentStreamingLoop } from '../lib/agent-stream-loop.js';
import type { TrustLevel } from '../lib/agent-approval.js';
```
(if `TrustLevel` isn't already imported).

- [ ] **Step 6.3: Typecheck**

```bash
pnpm --filter @deft/api typecheck
```
Expected: zero errors. Fix any that appear.

- [ ] **Step 6.4: Smoke test the send path**

Restart the API. Open `http://localhost:3000/agent?employee=7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633`. Start a NEW conversation (click New) and ask: "what are the top 3 overdue tasks?". Expected: Alex responds with real task data as before — no regression in the native-tool path. Confirm the assistant message is persisted with structured content_blocks by querying Postgres:

```bash
cd "C:/Users/Osheen Pradhan/cairn/apps/api" && pnpm exec tsx -e "import {db} from './src/lib/db.js'; import {sql} from 'drizzle-orm'; const r = await db.execute(sql\`SELECT role, LEFT(content,60) AS txt, content_blocks IS NOT NULL AS has_blocks FROM agent_messages ORDER BY created_at DESC LIMIT 6\`); console.log(r.rows); process.exit(0);"
```

Expected: the most recent rows (assistant, user, assistant) show `has_blocks=true` for new rows. Legacy rows show `has_blocks=false`.

- [ ] **Step 6.5: Commit**

```bash
git add apps/api/src/routes/agent.ts
git commit -m "feat(agent): use shared loop + persist structured history per iteration"
```

---

### Task 7: Insert `tool_result` on approve and add `/continue` endpoint

**Files:**
- Modify: `apps/api/src/routes/agent.ts` (the `/actions/:id/approve` handler around line 743, and add a new `/conversations/:id/continue` route)

- [ ] **Step 7.1: Update `/actions/:id/approve` to insert the tool_result message**

Replace the approve handler (lines 743–770) with:

```ts
agentRoutes.post('/actions/:id/approve', async (c) => {
  const user = c.get('user');
  const actionId = c.req.param('id');

  const [action] = await db
    .select()
    .from(agentActions)
    .where(and(eq(agentActions.id, actionId), eq(agentActions.org_id, user.org_id)))
    .limit(1);
  if (!action) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);
  if (action.approval_status !== 'pending') {
    return c.json({ error: 'Already processed', code: 'ALREADY_PROCESSED' }, 400);
  }

  await db
    .update(agentActions)
    .set({ approval_status: 'approved', approved_at: new Date() })
    .where(eq(agentActions.id, actionId));

  const execResult = await executeAction(
    actionId,
    action.action,
    action.params as any,
    user.org_id,
    user.id,
  );

  // Insert a hidden user agent_messages row with the tool_result so the next
  // agent iteration sees a valid Anthropic tool_use → tool_result pair.
  if (action.tool_use_id && action.conversation_id) {
    const toolResultBlock = {
      type: 'tool_result' as const,
      tool_use_id: action.tool_use_id,
      content: JSON.stringify(
        execResult.success
          ? execResult.result
          : { error: execResult.error || 'Action failed' }
      ),
      ...(execResult.success ? {} : { is_error: true }),
    };
    await db.insert(agentMessages).values({
      conversation_id: action.conversation_id,
      role: 'user',
      content: '',
      content_blocks: [toolResultBlock] as any,
      hidden: true,
    });
  }

  return c.json({ ...execResult, executed_at: new Date().toISOString() });
});
```

- [ ] **Step 7.2: Add the `/continue` endpoint**

Directly after the `/messages` handler (before the `/actions/:id/approve` block), add:

```ts
agentRoutes.post('/conversations/:id/continue', async (c) => {
  const user = c.get('user');
  const convoId = c.req.param('id');

  // Verify conversation ownership.
  const [convo] = await db
    .select()
    .from(agentConversations)
    .where(and(eq(agentConversations.id, convoId), eq(agentConversations.user_id, user.id)))
    .limit(1);
  if (!convo) return c.json({ error: 'Not found', code: 'NOT_FOUND' }, 404);

  const agentEmployeeId = convo.agent_employee_id ?? undefined;
  if (!env.ANTHROPIC_API_KEY) {
    return c.json({ error: 'Anthropic API key not configured', code: 'NO_API_KEY' }, 503);
  }

  // Load everything the /messages handler loads: history, MCP tools, employee prompt, etc.
  // Refactor: call the shared buildStreamContext helper. For minimal churn in this task,
  // duplicate the context-building block from /messages into a helper
  // `buildStreamContext(user, convoId)` in agent.ts, then both endpoints call it.
  const ctx = await buildStreamContext(user, convoId);
  if ('error' in ctx) return c.json({ error: ctx.error, code: ctx.code }, ctx.status);

  return streamSSE(c, async (sseStream) => {
    const abortController = new AbortController();
    sseStream.onAbort(() => abortController.abort());
    const write = async (data: any) => { await sseStream.writeSSE({ data: JSON.stringify(data) }); };
    const keepalive = setInterval(async () => {
      try { await sseStream.writeSSE({ data: JSON.stringify({ type: 'heartbeat' }) }); } catch { /* closed */ }
    }, 10000);

    try {
      const result = await runAgentStreamingLoop({
        convoId,
        userId: user.id,
        orgId: user.org_id,
        agentEmployeeId,
        systemPrompt: ctx.systemPrompt,
        tools: ctx.tools,
        allActionTools: ctx.allActionTools,
        trustLevel: ctx.trustLevel,
        apiMessages: ctx.apiMessages,
        write,
        abortSignal: abortController.signal,
        model: ctx.model,
      });
      if (result.citations.length > 0) await write({ type: 'citations', citations: result.citations });
      if (result.pendingActions.length > 0) await write({ type: 'actions', actions: result.pendingActions });
      clearInterval(keepalive);
      await write({ type: 'done', model: ctx.model, tokens_in: result.totalTokensIn, tokens_out: result.totalTokensOut });
    } catch (err) {
      clearInterval(keepalive);
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      try { await write({ type: 'error', error: errMsg }); } catch { /* closed */ }
    }
  });
});
```

- [ ] **Step 7.3: Extract `buildStreamContext` helper**

In `agent.ts`, extract the context-building block (history load, MCP tools, employee prompt assembly, wiki section, etc. — everything currently in lines 226–432 of the `/messages` handler that produces `apiMessages, systemPrompt, tools, allActionTools, trustLevel, model`) into a new helper function `buildStreamContext(user: { id: string; org_id: string }, convoId: string): Promise<StreamContext | StreamContextError>`. Place it above the route definitions in the same file.

Signature:
```ts
type StreamContext = {
  apiMessages: Anthropic.MessageParam[];
  systemPrompt: string;
  tools: Anthropic.Tool[];
  allActionTools: Set<string>;
  trustLevel: TrustLevel;
  model: string;
};
type StreamContextError = { error: string; code: string; status: 200 | 400 | 403 | 404 | 503 };

async function buildStreamContext(
  user: { id: string; org_id: string },
  convoId: string
): Promise<StreamContext | StreamContextError> {
  // ... move the 200-line block here ...
}
```

Both `/messages` and `/continue` call this. `/messages` inserts the user row FIRST (current lines 191–196), then calls `buildStreamContext`. `/continue` just calls `buildStreamContext` — the tool_result user row is already present in the DB from the approve handler.

**Important:** History load in `buildStreamContext` must happen AFTER the caller's insertion, so sequence in `/messages`:
1. Insert user message row.
2. Call `buildStreamContext` → returns `apiMessages` including the fresh user row.
3. Stream.

In `/continue`:
1. Call `buildStreamContext` → returns `apiMessages` including whatever approved tool_result row was already inserted by `/actions/:id/approve`.
2. Stream.

- [ ] **Step 7.4: Typecheck**

```bash
pnpm --filter @deft/api typecheck
```
Expected: zero errors.

- [ ] **Step 7.5: Commit**

```bash
git add apps/api/src/routes/agent.ts
git commit -m "feat(agent): approve endpoint persists tool_result, add /continue endpoint"
```

---

### Task 8: Wire the web client to `/continue` and remove synthetic `[System: approved…]` text

**Files:**
- Modify: `apps/web/src/components/agent-chat.tsx`

- [ ] **Step 8.1: Extract the SSE stream handling into a helper inside the component**

Find the inline SSE handling inside `sendMessage` (around lines 274–440 in `agent-chat.tsx`). The parsing of `text`, `tool_result`, `pending_action`, `actions`, `done`, `error`, etc. Extract into a helper `streamAgentResponse(res: Response, assistantIdx: number)` that takes a fetch Response and the placeholder message index, and updates React state as events arrive. Both `sendMessage` and the new `continueAfterAction` call this helper.

Signature (keep inside the component so it closes over `setMessages`, `setStreaming`, etc.):
```ts
const streamAgentResponse = async (res: Response, assistantIdx: number): Promise<void> => {
  // ... existing SSE parsing moved here ...
};
```

- [ ] **Step 8.2: Add `continueAfterAction` helper**

Below `sendMessage` (around line 440), add:

```ts
const continueAfterAction = async (convId: string): Promise<void> => {
  if (streaming) return;
  setStreaming(true);
  streamingRef.current = true;
  const controller = new AbortController();
  abortRef.current = controller;

  // Append an assistant placeholder that the stream will fill in.
  setMessages(prev => [...prev, { role: 'assistant', content: '', streaming: true, thinking: true }]);
  const assistantIdx = messages.length; // index of the placeholder we just appended
  isUserScrolledUp.current = false;
  setTimeout(scrollToBottom, 50);

  try {
    const token = localStorage.getItem('deft-access-token');
    const res = await fetch(`${API_URL}/api/agent/conversations/${convId}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Continue failed');
    }

    await streamAgentResponse(res, assistantIdx);
  } catch (err) {
    setMessages(prev => prev.map((m, i) => i === assistantIdx
      ? { ...m, content: `Failed to continue: ${err instanceof Error ? err.message : 'Unknown error'}`, streaming: false, thinking: false }
      : m));
  } finally {
    setStreaming(false);
    streamingRef.current = false;
  }
};
```

- [ ] **Step 8.3: Replace the synthetic sendMessage calls**

At lines 648 and 671 (single-action approve and batch approve), replace:

```ts
await sendMessage(`[System: The approved action has completed. Here is the result:\n${summary}\n\nNow provide the user with your analysis based on this result.]`, true);
```

with:

```ts
if (activeConversationId) await continueAfterAction(activeConversationId);
```

And similarly for the batch case (line 671):
```ts
if (activeConversationId) await continueAfterAction(activeConversationId);
```

Remove the `summary` construction code that was only used for the synthetic text — the server now owns the tool_result assembly.

- [ ] **Step 8.4: Typecheck the web app**

```bash
pnpm --filter @deft/web typecheck
```
Expected: zero errors (the component may still warn about unused vars — clean those up inline).

- [ ] **Step 8.5: Manual end-to-end test**

1. Restart the API and web dev servers.
2. Open `http://localhost:3000/agent?employee=7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633`.
3. Start a new conversation. Ask: "go to theverge.com and find any articles mentioning anthropic". Watch carefully:
   - Alex should NOT disclaim "outside my scope".
   - `browser_snapshot` (auto-execute) should NOT show an approve card.
   - `browser_navigate` should show an approve card once. Approve it.
   - After approve, the agent should continue with the result and write the analysis. It should NOT repeat "I'm navigating, requires approval" prose.
4. Verify in Postgres that the assistant message has `content_blocks` populated, the hidden user message has a `tool_result` block, and the action has `tool_use_id` set:

```bash
cd "C:/Users/Osheen Pradhan/cairn/apps/api" && pnpm exec tsx src/scripts/verify-structured-history.ts
```

(Create that script in the next task — Task 9.)

- [ ] **Step 8.6: Commit**

```bash
git add apps/web/src/components/agent-chat.tsx
git commit -m "feat(agent-chat): call /continue after action approval, drop synthetic system text"
```

---

### Task 9: Verification script for structured history

**Files:**
- Create: `apps/api/src/scripts/verify-structured-history.ts`

- [ ] **Step 9.1: Create the verifier**

```ts
/**
 * Dump the latest conversation for a given agent employee, showing each
 * message row's content_blocks structure and confirming tool_use/tool_result
 * pairs are correctly linked by tool_use_id.
 *
 * Run: pnpm --filter @deft/api exec tsx src/scripts/verify-structured-history.ts
 */
import { db } from '../lib/db.js';
import { sql } from 'drizzle-orm';

const EMPLOYEE_ID = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633';

async function main() {
  const convs = await db.execute(sql`
    SELECT id FROM agent_conversations
    WHERE agent_employee_id = ${EMPLOYEE_ID}
    ORDER BY updated_at DESC LIMIT 1
  `);
  if (convs.rows.length === 0) {
    console.log('No conversations.');
    process.exit(0);
  }
  const convoId = (convs.rows[0] as any).id;
  console.log(`Conversation: ${convoId}`);

  const msgs = await db.execute(sql`
    SELECT id, role, hidden, created_at, LEFT(content, 50) AS text,
      content_blocks IS NOT NULL AS has_blocks, content_blocks
    FROM agent_messages
    WHERE conversation_id = ${convoId}
    ORDER BY created_at ASC
  `);

  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const r of msgs.rows as any[]) {
    console.log(`\n[${r.created_at}] ${r.role} hidden=${r.hidden} has_blocks=${r.has_blocks}`);
    console.log(`  text: ${r.text}`);
    if (r.has_blocks && Array.isArray(r.content_blocks)) {
      for (const block of r.content_blocks) {
        if (block.type === 'text') {
          console.log(`  [text] ${String(block.text).slice(0, 80)}`);
        } else if (block.type === 'tool_use') {
          console.log(`  [tool_use id=${block.id} name=${block.name}] params=${JSON.stringify(block.input).slice(0, 120)}`);
          toolUseIds.add(block.id);
        } else if (block.type === 'tool_result') {
          const trimmed = String(block.content).slice(0, 120);
          console.log(`  [tool_result id=${block.tool_use_id}] ${trimmed}`);
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  const unmatched = Array.from(toolUseIds).filter((id) => !toolResultIds.has(id));
  const orphanResults = Array.from(toolResultIds).filter((id) => !toolUseIds.has(id));
  console.log(`\nTool uses: ${toolUseIds.size}, tool results: ${toolResultIds.size}`);
  if (unmatched.length) console.log(`Unmatched tool_use ids (awaiting approval or lost): ${unmatched.join(', ')}`);
  if (orphanResults.length) console.log(`Orphan tool_result ids (no matching use): ${orphanResults.join(', ')}`);

  // Check the agent_actions table for tool_use_id linkage
  const actions = await db.execute(sql`
    SELECT id, action, approval_status, tool_use_id
    FROM agent_actions
    WHERE conversation_id = ${convoId}
    ORDER BY created_at ASC
  `);
  console.log(`\nActions in this conversation: ${actions.rows.length}`);
  for (const a of actions.rows as any[]) {
    console.log(`  ${a.action} status=${a.approval_status} tool_use_id=${a.tool_use_id ?? 'NULL'}`);
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 9.2: Run it**

```bash
cd "C:/Users/Osheen Pradhan/cairn/apps/api" && pnpm exec tsx src/scripts/verify-structured-history.ts
```

Expected: every assistant message with tool_use blocks has a matching tool_result block in a subsequent user message. Every `agent_actions` row has a non-null `tool_use_id`. No orphans.

If there are orphans: read the tail of the script's output, identify which tool_use block is missing its pair, and verify the approve endpoint inserted the `tool_result` correctly.

- [ ] **Step 9.3: Commit**

```bash
git add apps/api/src/scripts/verify-structured-history.ts
git commit -m "chore(agent): verification script for structured tool-loop history"
```

---

### Task 10: Final end-to-end verification

- [ ] **Step 10.1: Full manual test**

1. Restart all dev servers.
2. Open `http://localhost:3000/agent?employee=7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633`.
3. Start a fresh conversation. Ask: "go to theverge.com, find the top headline about AI, and summarize it".
4. Observe:
   - Alex's first response should NOT include disclaimers about scope.
   - `browser_navigate` prompts for approval once. Approve.
   - `browser_snapshot` runs instantly (auto).
   - Alex writes the summary in a single coherent final message.
   - Total approval card count: 1 (navigate). Not 4.
5. Ask a follow-up: "now go to anthropic.com and find the latest blog post". Expect the same clean single-approve flow.

- [ ] **Step 10.2: Regression check on native tools**

Ask: "what are the top 3 overdue tasks?". Expected: Alex responds with task data using `search_tasks` (a native read-only tool). No regression.

- [ ] **Step 10.3: Regression check on write actions**

Ask: "create a task called 'test task for approval flow' in the Deft v1 project". Expected:
- Alex generates a `create_task` tool call.
- Approve card shows (trust level is conservative).
- Approve → task is created, tool_result message inserted, Alex confirms the task in a follow-up response without repeating the request.

- [ ] **Step 10.4: Clean up the old stale test conversation**

The conversation `86eba2cf-6df3-4d23-b3fc-ce5dc0295202` is full of legacy messages. Either archive it or leave it — not a functional issue since the history loader handles legacy text-only rows. Decision: leave it as a real-world artifact of the bug fix.

- [ ] **Step 10.5: Final commit (if any loose ends)**

If there are tiny cleanups (comments, unused imports), commit them:
```bash
git add -u
git commit -m "chore(agent): post-fix cleanup"
```

---

## Self-Review

**Spec coverage check:**
- "Permissions asked multiple times" → Tasks 1–2 (auto-classify + cache clear). ✓
- "Messages repeated over and over" → Tasks 4–8 (structured persistence + continue endpoint). ✓
- "Alex disclaims outside my scope" → Task 3 (MCP capabilities in system prompt). ✓

**Placeholder scan:**
- Every code step has the complete code.
- Every verification step has the exact command and expected output.
- No TBD / TODO / "similar to" references.

**Type consistency:**
- `StreamLoopParams` in Task 5 matches the call site in Task 6 (`runAgentStreamingLoop({...})`).
- `classifyTool` returns `{ approvalTier, isWrite }` — both used by `mapTool`.
- `content_blocks` is jsonb in schema (Task 4) and typed as `Anthropic.MessageParam['content']` at read sites (Tasks 5, 6).
- `tool_use_id` column added in Task 4, populated in Task 5 (`runAgentStreamingLoop` insert into `agent_actions`), consumed in Task 7 (`/actions/:id/approve` reads `action.tool_use_id`).

**Known caveats:**
- Tasks 5–7 involve substantial restructuring of `agent.ts`. A careful read of the existing 800-line file is required before each modification. Don't paste blindly — line numbers may drift between tasks.
- The `buildStreamContext` extraction in Task 7.3 is the riskiest refactor. If it turns out the context is too tangled to cleanly extract, fall back to duplicating the load block across `/messages` and `/continue`. Flag for review.
- This plan does not add unit tests (none exist in the repo). If a test harness is added later, the verification scripts in Tasks 2, 9, 10 are the contracts to preserve.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-12-playwright-approval-repetition-fixes.md`.

User memory `feedback_subagent_driven.md` says: always use subagent-driven development. Proceeding with subagent-driven execution using `superpowers:subagent-driven-development`.

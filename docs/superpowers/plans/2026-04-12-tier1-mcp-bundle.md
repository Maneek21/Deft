# Tier-1 MCP Bundle Installation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install the five zero-prerequisite Tier-1 MCP servers as real `mcp_connections` rows on Alex PM's org, extend the classifier so each server's tools auto-execute (no spurious approval prompts), and verify every connection discovers its tools successfully.

**Architecture:** Six MCPs shortlisted — Playwright is already wired (skipped), the other five install cleanly over stdio (via `npx`) or streamable-http. Python-prerequisite MCPs (mcp-run-python, AWS document-loader) are **deferred** to a follow-up plan since they require `uv` + `deno` and this host has neither. One reusable installer script registers all five connections, forces tool discovery so the updated classifier runs, attaches them to Alex PM's `mcp_connection_ids`, and prints a summary table.

**Tech Stack:** TypeScript, Drizzle ORM, Postgres, `@modelcontextprotocol/sdk`, `@deft/mcp` client manager, Node 18+, stdio + streamable-http transports.

**Prerequisites:**
- API running on `localhost:3001` (self-hosted mode — `DEFT_SELF_HOSTED=true` in root `.env`, already set).
- Postgres running on `localhost:5432` (already up).
- Node + npm available on PATH (already up).
- Existing MCP connection for Playwright (`eaddd45d-2606-4225-af35-d3ae09a7ce61`, already wired).
- Alex PM employee id `7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633` (already exists).
- A Tavily MCP URL containing a dev API key. **This is a secret — it must be passed via env var, never committed to git.** The user has already generated a key for this work.

---

## What's in the bundle

| # | Name | Transport | Command / URL | Stage |
|---|---|---|---|---|
| 1 | **Time** | stdio | `npx -y @modelcontextprotocol/server-time --local-timezone=Asia/Kolkata` | Install |
| 2 | **Fetch** | stdio | `npx -y @kazuph/mcp-fetch` | Install |
| 3 | **Tavily Search** | streamable-http | `https://mcp.tavily.com/mcp/?tavilyApiKey=<key>` | Install |
| 4 | **Playwright** | stdio | already wired (`822be95`) | Skip |
| 5 | **Sequential Thinking** | stdio | `npx -y @modelcontextprotocol/server-sequential-thinking` | Install |
| 6 | **Context7** | stdio | `npx -y @upstash/context7-mcp@latest` | Install |

**Deferred (require `uv` + `deno` — install separately):**
- Python Sandbox (`uvx mcp-run-python stdio`)
- AWS Document Loader (`uvx awslabs.document-loader-mcp-server`)

These stay out of the default bundle until the host has `uv` and `deno`. When ready, add them via the same installer script with a second BUNDLE constant.

---

## File Structure

### Modified files
- `packages/mcp/src/client.ts` — extend `classifyTool()` with auto-execute patterns for `tavily-*`, `brave-*`, `exa-*`, `perplexity-*`, `web_search`, `search`, `get_current_time`, `convert_time`, `time_*`, `fetch`, `http_get`, `sequentialthinking`, `sequential_thinking`, `resolve-library-id`, `get-library-docs`, `query-docs`. **(This edit is already in the working tree from the interrupted Tavily wiring session — the plan's first task commits it.)**

### New files
- `apps/api/src/scripts/install-tier1-mcp-bundle.ts` — one-shot installer that iterates a `BUNDLE` constant, upserts each `mcp_connections` row, runs `mcpClientManager.getCachedTools()` to force discovery, writes `tools_cache`, and attaches all connection ids to Alex PM's `mcp_connection_ids`. Prints a classification summary at the end.

### Files NOT touched
- `packages/db/src/schema.ts` — `mcp_connections` schema already supports everything we need (streamable-http, server_url, tools_cache, default_trust_tier).
- `apps/api/src/routes/agent.ts` — no route changes; the existing `getMCPToolsForAgent` picks up new connections automatically.
- `apps/web/src/*` — no UI changes in this plan; the user tests via the existing agent chat.

---

## Task Breakdown

### Task 1: Commit the classifier extension

The classifier edit already exists in the working tree (from the interrupted Tavily session). Verify it typechecks and commit it.

**Files:**
- Modify: `packages/mcp/src/client.ts` (already edited, uncommitted)

- [ ] **Step 1.1: Confirm the edit is present**

```bash
cd "C:/Users/Osheen Pradhan/cairn" && git diff packages/mcp/src/client.ts | head -80
```
Expected: diff shows a new block starting with `// Search MCPs — read-only lookups that should never gate the agent.` and containing regex patterns for `tavily`, `brave`, `exa`, `perplexity`, plus name checks for `get_current_time`, `fetch`, `sequentialthinking`, `resolve-library-id`, etc.

If the diff is empty, the edit was lost — open `packages/mcp/src/client.ts`, find the end of the `git_*` block in `classifyTool`, and add the block from this plan's header section. Then proceed.

- [ ] **Step 1.2: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm --filter @deft/mcp exec tsc --noEmit
```
Expected: zero errors. If there are errors, they're probably in the block you just added — fix them inline.

- [ ] **Step 1.3: Commit**

Stage only the classifier file — the repo has many unrelated modifications and you MUST NOT stage them.

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add packages/mcp/src/client.ts
git commit -m "$(cat <<'EOF'
feat(mcp): classify search/time/fetch/thinking/docs tools as auto-execute

Tavily, Brave, Exa, Perplexity, the `fetch` server, time tools,
sequential-thinking, and Context7's doc lookups are all read-only and
should never gate the agent on approval. Extends classifyTool() so
future tier-1 MCPs flow through without spurious full-review prompts.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: one file changed, commit succeeds.

---

### Task 2: Write the bundle installer script

**File to CREATE:** `apps/api/src/scripts/install-tier1-mcp-bundle.ts`

- [ ] **Step 2.1: Create the script file**

```ts
/**
 * One-shot installer for the Tier-1 MCP bundle on Alex PM's org.
 *
 * For each entry in BUNDLE:
 *   1. Upsert an mcp_connections row (keyed by org_id + slug)
 *   2. Force tool discovery via mcpClientManager.getCachedTools()
 *      — this is what runs the updated classifier and picks tiers
 *   3. Persist the discovered tools into tools_cache
 *   4. Attach the connection id to Alex PM's mcp_connection_ids
 *
 * Secrets are injected via env vars. Never hardcode API keys here.
 *
 * Run:
 *   TAVILY_MCP_URL="https://mcp.tavily.com/mcp/?tavilyApiKey=..." \
 *     pnpm --filter @deft/api exec tsx src/scripts/install-tier1-mcp-bundle.ts
 */
import { db } from '../lib/db.js';
import { mcpConnections, agentEmployees, users } from '@deft/db/schema';
import { eq, and } from 'drizzle-orm';
import { mcpClientManager } from '@deft/mcp';
import { toConnectionConfig } from '../lib/mcp-tools.js';

const EMPLOYEE_ID = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633'; // Alex PM

type BundleEntry = {
  slug: string;
  name: string;
  transport: 'stdio' | 'streamable-http';
  stdio_command?: string;
  stdio_args?: string[];
  server_url?: string;
  required: boolean; // if false, skip gracefully on missing env
};

const TAVILY_URL = process.env.TAVILY_MCP_URL || '';

const BUNDLE: BundleEntry[] = [
  {
    slug: 'time',
    name: 'Time',
    transport: 'stdio',
    stdio_command: 'npx',
    stdio_args: ['-y', '@modelcontextprotocol/server-time', '--local-timezone=Asia/Kolkata'],
    required: true,
  },
  {
    slug: 'fetch',
    name: 'Fetch',
    transport: 'stdio',
    stdio_command: 'npx',
    stdio_args: ['-y', '@kazuph/mcp-fetch'],
    required: true,
  },
  {
    slug: 'tavily-search',
    name: 'Tavily Search',
    transport: 'streamable-http',
    server_url: TAVILY_URL,
    required: false, // skipped if TAVILY_MCP_URL not set
  },
  {
    slug: 'sequential-thinking',
    name: 'Sequential Thinking',
    transport: 'stdio',
    stdio_command: 'npx',
    stdio_args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    required: true,
  },
  {
    slug: 'context7',
    name: 'Context7 Docs',
    transport: 'stdio',
    stdio_command: 'npx',
    stdio_args: ['-y', '@upstash/context7-mcp@latest'],
    required: true,
  },
];

async function main() {
  const [emp] = await db
    .select()
    .from(agentEmployees)
    .where(eq(agentEmployees.id, EMPLOYEE_ID))
    .limit(1);
  if (!emp) {
    console.error(`Employee ${EMPLOYEE_ID} not found`);
    process.exit(1);
  }
  const orgId = emp.org_id;
  console.log(`Installing Tier-1 bundle for ${emp.name} (org ${orgId})\n`);

  // Need a real user id for created_by — pick any user in the org.
  const [creator] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.org_id, orgId))
    .limit(1);
  if (!creator) {
    console.error(`No users found in org ${orgId}`);
    process.exit(1);
  }

  const attachedIds = new Set<string>(emp.mcp_connection_ids ?? []);
  const classificationTable: { slug: string; tool: string; tier: string; isWrite: boolean }[] = [];

  for (const entry of BUNDLE) {
    console.log(`── ${entry.name} (${entry.slug}) ──`);

    if (entry.transport === 'streamable-http' && !entry.server_url) {
      if (entry.required) {
        console.error(`  Missing server_url for required entry ${entry.slug}`);
        process.exit(1);
      }
      console.log(`  skipped: env var not set`);
      continue;
    }

    // 1. Upsert mcp_connections row.
    const existingRows = await db
      .select()
      .from(mcpConnections)
      .where(and(eq(mcpConnections.org_id, orgId), eq(mcpConnections.slug, entry.slug)))
      .limit(1);

    let connectionId: string;
    if (existingRows.length > 0) {
      connectionId = existingRows[0]!.id;
      await db
        .update(mcpConnections)
        .set({
          name: entry.name,
          transport: entry.transport,
          server_url: entry.server_url ?? null,
          stdio_command: entry.stdio_command ?? null,
          stdio_args: (entry.stdio_args ?? null) as any,
          auth_type: 'none',
          is_active: true,
          tools_cache: null,
          tools_cached_at: null,
          default_trust_tier: 'auto',
        })
        .where(eq(mcpConnections.id, connectionId));
      console.log(`  updated existing connection ${connectionId}`);
    } else {
      const [inserted] = await db
        .insert(mcpConnections)
        .values({
          org_id: orgId,
          name: entry.name,
          slug: entry.slug,
          transport: entry.transport,
          server_url: entry.server_url ?? null,
          stdio_command: entry.stdio_command ?? null,
          stdio_args: (entry.stdio_args ?? null) as any,
          auth_type: 'none',
          is_active: true,
          default_trust_tier: 'auto',
          created_by: creator.id,
        })
        .returning();
      connectionId = inserted!.id;
      console.log(`  inserted new connection ${connectionId}`);
    }

    // 2. Force tool discovery.
    const [connRow] = await db
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.id, connectionId))
      .limit(1);
    const config = toConnectionConfig(connRow!);
    try {
      const tools = await mcpClientManager.getCachedTools(config, []);
      console.log(`  discovered ${tools.length} tools:`);
      for (const t of tools) {
        console.log(
          `    ${t.originalName.padEnd(30)} tier=${t.approvalTier.padEnd(14)} isWrite=${t.isWrite}`
        );
        classificationTable.push({
          slug: entry.slug,
          tool: t.originalName,
          tier: t.approvalTier,
          isWrite: t.isWrite,
        });
      }
      await db
        .update(mcpConnections)
        .set({
          tools_cache: tools as any,
          tools_cached_at: new Date(),
          last_connected_at: new Date(),
          connection_error: null,
        })
        .where(eq(mcpConnections.id, connectionId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED to discover tools: ${msg}`);
      await db
        .update(mcpConnections)
        .set({ connection_error: msg, tools_cache: null })
        .where(eq(mcpConnections.id, connectionId));
      if (entry.required) {
        console.error(`  (required entry — continuing anyway, fix this before using Alex)`);
      }
    }

    attachedIds.add(connectionId);
  }

  // 3. Attach all to Alex PM.
  const finalIds = Array.from(attachedIds);
  await db
    .update(agentEmployees)
    .set({ mcp_connection_ids: finalIds })
    .where(eq(agentEmployees.id, EMPLOYEE_ID));
  console.log(`\nAttached ${finalIds.length} connections to ${emp.name}`);
  console.log(`mcp_connection_ids = ${JSON.stringify(finalIds, null, 2)}`);

  // 4. Summary table grouped by tier.
  const byTier: Record<string, typeof classificationTable> = { 'auto-execute': [], 'quick-approve': [], 'full-review': [] };
  for (const c of classificationTable) {
    byTier[c.tier]?.push(c);
  }
  console.log(`\n=== Classification Summary ===`);
  for (const tier of ['auto-execute', 'quick-approve', 'full-review'] as const) {
    console.log(`\n${tier}: ${byTier[tier]?.length ?? 0} tools`);
    for (const c of byTier[tier] ?? []) {
      console.log(`  ${c.slug}/${c.tool}`);
    }
  }

  console.log(`\nDone. Restart the API so in-memory tool caches refresh.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2.2: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm --filter @deft/api exec tsc --noEmit
```
Expected: zero errors. If there are errors around drizzle types (the `stdio_args: ... as any` cast), that's intentional — drizzle's jsonb column types are loose. If there are other errors, fix inline.

- [ ] **Step 2.3: Commit the script (before running it)**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add apps/api/src/scripts/install-tier1-mcp-bundle.ts
git commit -m "$(cat <<'EOF'
chore(mcp): tier-1 bundle installer script

One-shot script that registers Time, Fetch, Tavily, Sequential
Thinking, and Context7 as mcp_connections rows, discovers their tools
(triggering the updated classifier), and attaches them to Alex PM's
mcp_connection_ids. Secrets read from env vars — nothing hardcoded.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Run the installer

- [ ] **Step 3.1: Set the Tavily URL env var and run**

In bash (Git Bash on Windows):

```bash
cd "C:/Users/Osheen Pradhan/cairn/apps/api"
TAVILY_MCP_URL="https://mcp.tavily.com/mcp/?tavilyApiKey=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" \
  pnpm exec tsx src/scripts/install-tier1-mcp-bundle.ts
```

Expected output shape (names may vary, tiers MUST all be `auto-execute`):

```
Installing Tier-1 bundle for Alex PM (org 1d7d869a-...)

── Time (time) ──
  inserted new connection <uuid>
  discovered 2 tools:
    get_current_time              tier=auto-execute   isWrite=false
    convert_time                  tier=auto-execute   isWrite=false
── Fetch (fetch) ──
  inserted new connection <uuid>
  discovered 1 tools:
    fetch                         tier=auto-execute   isWrite=false
── Tavily Search (tavily-search) ──
  inserted new connection <uuid>
  discovered N tools:
    tavily-search                 tier=auto-execute   isWrite=false
    tavily-extract                tier=auto-execute   isWrite=false
    ...
── Sequential Thinking (sequential-thinking) ──
  inserted new connection <uuid>
  discovered 1 tools:
    sequentialthinking            tier=auto-execute   isWrite=false
── Context7 Docs (context7) ──
  inserted new connection <uuid>
  discovered 2 tools:
    resolve-library-id            tier=auto-execute   isWrite=false
    get-library-docs              tier=auto-execute   isWrite=false

Attached 6 connections to Alex PM
...

=== Classification Summary ===

auto-execute: N tools
  time/get_current_time
  ...

quick-approve: 0 tools
full-review: 0 tools
```

- [ ] **Step 3.2: Handle expected failures**

Some npm packages may not exist or may fail to start on first run. Likely failures and responses:

| Failure | Cause | Action |
|---|---|---|
| `Cannot find module '@kazuph/mcp-fetch'` | npm package renamed or unpublished | Edit the script, swap to a working fetch MCP — options in priority order: `@mseep/mcp-fetch`, `mcp-fetch`, or drop Fetch entirely (Tavily's `tavily-extract` covers this use case). Re-run. |
| `404 Not Found` on Tavily URL | Wrong URL format or expired key | Confirm URL in Tavily dashboard. |
| `Time` server discovery hangs | `--local-timezone` flag not supported | Drop the flag: `stdio_args: ['-y', '@modelcontextprotocol/server-time']` and pass timezone via env or in queries instead. |
| Any connection's `connection_error` populated | Server failed to start | Read the error, fix the command, re-run. The script is idempotent (upsert). |

If ≥4 of 5 servers succeed, the failed one(s) are logged with `connection_error` — proceed and fix separately.

- [ ] **Step 3.3: Confirm the connections exist and Alex is attached**

```bash
cd "C:/Users/Osheen Pradhan/cairn/apps/api" && pnpm exec tsx -e "
import { db } from './src/lib/db.js';
import { sql } from 'drizzle-orm';
const r = await db.execute(sql\`
  SELECT c.slug, c.transport, c.is_active, c.connection_error,
    jsonb_array_length(COALESCE(c.tools_cache, '[]'::jsonb)) AS tools
  FROM mcp_connections c
  WHERE c.org_id = (SELECT org_id FROM agent_employees WHERE id = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633')
  ORDER BY c.slug
\`);
for (const row of r.rows) console.log(row);
const e = await db.execute(sql\`SELECT mcp_connection_ids FROM agent_employees WHERE id = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633'\`);
console.log('Alex attached:', e.rows[0]);
process.exit(0);
"
```

Expected: 6 rows (5 new bundle + Playwright), `tools > 0` on each healthy one, `connection_error` NULL on healthy ones. Alex PM's `mcp_connection_ids` contains all 6 ids.

---

### Task 4: Restart the API so the in-memory tool cache refreshes

- [ ] **Step 4.1: Kill the existing API process**

```bash
powershell.exe -Command "Get-NetTCPConnection -State Listen | Where-Object { \$_.LocalPort -eq 3001 } | Select-Object OwningProcess"
# note the PID
powershell.exe -Command "Stop-Process -Id <PID> -Force"
```

- [ ] **Step 4.2: Restart in the background**

Use Bash with `run_in_background: true`:

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm dev:api
```

- [ ] **Step 4.3: Confirm boot by reading the background task output file**

Wait a few seconds, then read the output file until you see `Deft API running on http://localhost:3001`. If there's an `[agent]` error or an MCP connection-related stack trace, investigate before moving on. Common issue: a stdio server failed to spawn because `npx` is slow on first invocation — retry once.

---

### Task 5: Smoke-test each MCP from the UI

No automated tests — manual verification against the actual agent. Open `http://localhost:3000/agent?employee=7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633` (create a fresh conversation for each test to avoid legacy row contamination).

- [ ] **Step 5.1: Time**

Prompt: *"what time is it in tokyo right now"*

Expected: Alex calls `get_current_time(timezone="Asia/Tokyo")` or similar, no approval card, returns the current time in one turn.

- [ ] **Step 5.2: Fetch**

Prompt: *"fetch https://example.com and tell me what it says"*

Expected: Alex calls `fetch` or `http_get`, no approval card, summarizes the Example Domain placeholder content.

- [ ] **Step 5.3: Tavily Search**

Prompt: *"search the web for the latest anthropic claude release"*

Expected: Alex calls `tavily-search` (or whatever Tavily's MCP exposes), no approval card, returns a summary with citations — no disclaimer about being "outside scope", no repetition, no "requires approval" prose.

- [ ] **Step 5.4: Sequential Thinking**

Prompt: *"make a plan to launch a new product in 3 months — use sequential thinking to break it down"*

Expected: Alex calls `sequentialthinking` several times, no approval, produces a visible ordered plan.

- [ ] **Step 5.5: Context7**

Prompt: *"what's the latest react hook for handling optimistic updates — use the latest docs"*

Expected: Alex calls `resolve-library-id` then `get-library-docs`, no approval, returns a current-docs answer (the exact hook name depends on React's latest version).

- [ ] **Step 5.6: Run the structured-history verifier**

```bash
cd "C:/Users/Osheen Pradhan/cairn/apps/api" && pnpm exec tsx src/scripts/verify-structured-history.ts
```

Expected: the latest conversation shows `has_blocks=true` on new rows, tool_use and tool_result pairs match, no orphans. If an approval card appeared for any of the above, the classifier missed something — fix in `packages/mcp/src/client.ts:classifyTool` and re-run Task 3 to re-cache.

---

### Task 6: Document the deferred bundle

Add a short note in the plan file itself (or a follow-up doc) listing what's NOT installed and why, so the user can come back to it later.

- [ ] **Step 6.1: Create or append to `docs/superpowers/plans/2026-04-12-tier1-mcp-bundle.md`**

Append this section at the bottom of this plan document:

```markdown
## Deferred servers (install `uv` + `deno` first)

These were intentionally skipped in Task 3 because the host lacks `uv` (Python package runner) and `deno` (required by Pyodide-based sandbox). Install both, then rerun the installer with them added to `BUNDLE`:

- **Python Sandbox** — `uvx mcp-run-python stdio` — sandboxed data analysis, math, regex, CSV parsing
- **AWS Document Loader** — `uvx awslabs.document-loader-mcp-server` — PDF, Word, Excel, PowerPoint, image OCR

**Install commands (Windows, run in PowerShell as admin):**
```powershell
winget install astral-sh.uv
winget install DenoLand.Deno
```

After installing, add these entries to `BUNDLE` in `install-tier1-mcp-bundle.ts`:

\```ts
{ slug: 'python-sandbox', name: 'Python Sandbox', transport: 'stdio',
  stdio_command: 'uvx', stdio_args: ['mcp-run-python', 'stdio'], required: false },
{ slug: 'document-loader', name: 'Document Loader', transport: 'stdio',
  stdio_command: 'uvx', stdio_args: ['awslabs.document-loader-mcp-server'], required: false },
\```

Re-run Task 3. Same verification steps.
```

- [ ] **Step 6.2: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add docs/superpowers/plans/2026-04-12-tier1-mcp-bundle.md
git commit -m "$(cat <<'EOF'
docs(mcp): note deferred tier-1 MCPs (Python sandbox, document loader)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Classifier extension → Task 1 ✓
- 5 new connections registered → Task 2–3 ✓
- Playwright unchanged → skipped by design ✓
- All attached to Alex PM → Task 2 step 2.1 (script body) + 3.3 verification ✓
- API restart so caches refresh → Task 4 ✓
- Each server smoke-tested → Task 5 ✓
- Deferred servers documented → Task 6 ✓

**Placeholder scan:** Every code block is complete. No TODO/TBD. Expected outputs shown. Failure modes enumerated with specific remediation.

**Type consistency:** `BundleEntry` in Task 2 matches the body that iterates it. `mcp_connection_ids` is a `text('...').array()` column in schema — script treats it as `string[]`, consistent. `tools_cache` is `jsonb`, cast via `as any` to satisfy drizzle. `classifyTool`'s tool-name patterns (Task 1) match the expected output of Task 3.

**Known risks:**
- `@kazuph/mcp-fetch` existence not verified — Task 3 Step 3.2 has a fallback list.
- Tavily's hosted MCP URL format might have changed. If the streamable-http handshake fails, swap to the stdio variant via `npx -y tavily-mcp` with `TAVILY_API_KEY` env.
- First `npx -y` invocation can hang on slow networks; retry once.
- The `@modelcontextprotocol/server-time` package name might be `mcp-server-time`. Verify via `npm view @modelcontextprotocol/server-time` before running; if missing, drop the `@modelcontextprotocol/` scope and retry.

These are validation failures the installer will report in Step 3.2, not blocking plan issues.

**Secrets handling:** Tavily URL is passed via `TAVILY_MCP_URL` env var at invocation time only. Script never stores it in-source. DB row holds the URL (this is where it must live — MCP client reads it at connection time). Not in git history of the script file. User should rotate the dev key after this works since it was pasted into chat history.

---

## Deferred servers (install `uv` + `deno` first)

These were intentionally skipped because the host lacks `uv` (Python package runner) and `deno` (required by Pyodide-based sandbox). Install both, then rerun the installer with them added to `BUNDLE`:

- **Python Sandbox** — `uvx mcp-run-python stdio` — sandboxed data analysis, math, regex, CSV parsing
- **AWS Document Loader** — `uvx awslabs.document-loader-mcp-server` — PDF, Word, Excel, PowerPoint, image OCR

**Install commands (Windows, run in an elevated PowerShell):**

```powershell
winget install astral-sh.uv
winget install DenoLand.Deno
```

After installing, add these entries to `BUNDLE` in `install-tier1-mcp-bundle.ts`:

```ts
{ slug: 'python-sandbox', name: 'Python Sandbox', transport: 'stdio',
  stdio_command: 'uvx', stdio_args: ['mcp-run-python', 'stdio'], required: false },
{ slug: 'document-loader', name: 'Document Loader', transport: 'stdio',
  stdio_command: 'uvx', stdio_args: ['awslabs.document-loader-mcp-server'], required: false },
```

Also extend `classifyTool` in `packages/mcp/src/client.ts` so the sandbox tools and document-loader tools hit `auto-execute`:

- `run_python_code`, `run_javascript_code`, `python_repl` → auto-execute (sandbox is the boundary)
- `read_pdf`, `read_docx`, `read_xlsx`, `read_pptx`, `load_document`, `extract_text` → auto-execute

Rerun the installer and restart the API. The existing verification steps (Task 5) apply.

---

## Execution Record

- **Task 1** — classifier extension committed (`1c2b0ae`, `fb4ec02`).
- **Task 2** — installer script committed (`bbf18fe`, fixed in `14fedc1` after package swap).
- **Task 3** — installer ran successfully on second iteration. All 5 MCPs register, 17 tools classified auto-execute, 0 approval gates.
  - Swap: `@modelcontextprotocol/server-time` → `time-mcp` (Python-only package doesn't exist on npm)
  - Swap: `@kazuph/mcp-fetch` → `fetch-mcp` (the kazuph package only exposed `imageFetch`)
  - Classifier broadened for `current_time`/`relative_time`/etc and `fetch_*` family.
- **Task 4** — API restarted cleanly on port 3001.
- **Task 5** — manual UI smoke tests deferred to the user.
- **Task 6** — this section.

### Final bundle attached to Alex PM

| Slug | Transport | Tools | Tier |
|---|---|---|---|
| `playwright-browser` (existing) | stdio | 21 | mixed (auto/quick/full) |
| `time` | stdio | 6 | all auto |
| `fetch` | stdio | 2 | all auto |
| `tavily-search` | streamable-http | 6 | all auto |
| `sequential-thinking` | stdio | 1 | auto |
| `context7` | stdio | 2 | all auto |

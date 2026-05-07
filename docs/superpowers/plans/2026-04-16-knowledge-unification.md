# Knowledge Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify the fragmented memory/knowledge/wiki/decisions/notes surface into a coherent retrieval + observation spine, fix the stubs and orphaned workers that are silently breaking semantic search, and give observational features (burnout, people graph) access to the knowledge layer they currently ignore.

**Architecture:** Consolidate five overlapping knowledge tables (wikiPages, agentMemory, spaceKnowledge, decisions, notes) around `wikiPages` as the primary store with pgvector embeddings populated on ingest. Introduce a single `retrieveContext()` gateway that replaces the five separate per-surface queries the agent currently makes. Feed knowledge signals (authorship, citations, stalled commitments) into burnout and people graph. Merge the in-chat knowledge panel's 4-type entity model into wiki's 7-type model with a promote path.

**Tech Stack:** PostgreSQL + pgvector, Drizzle ORM, Hono API, BullMQ workers, Anthropic Claude (Sonnet + Haiku), OpenAI `text-embedding-3-small` (1536 dims) for embeddings, Next.js 14 web.

**Scope boundaries:** This plan is limited to the knowledge/memory spine + observational enrichment. **Out of scope** (tracked elsewhere in `docs/superpowers/plans/2026-04-15-deployment-readiness-todo.md`):
- Manager dashboard as a dedicated page (Roadmap Phase 2.1 — ~5–7 days)
- People directory as a dedicated page (Roadmap Phase 2.2 — ~5–7 days)
- Privacy/Terms pages, rate limiting, security headers, email verification gate
- packages/ai/ architectural cleanup (deprecate-or-populate decision belongs in a separate refactor)

**Assumptions:**
- `OPENAI_API_KEY` will be added to `.env` and Railway env vars before Phase 0. If unavailable, fall back to Voyage AI (`voyage-3`, 1024 dims); migration note in Task 0.1 covers the dimension swap.
- pgvector is installed in prod Neon (confirmed per `deployment-readiness-todo.md §D'6`). Local Windows Postgres has BYTEA fallback; plan assumes we proceed with prod-first embeddings.
- The `feat/phase2-4-mcp-agents-plans` branch is the working base. All work lands as bite-sized commits on a new branch `feat/knowledge-unification`.

---

## Surface summary (context for implementers)

Five knowledge tables, three observational services, one chat knowledge panel, five agent retrieval sites — all fragmented:

| Surface | Schema | Written by | Read by | Embedded? | UI |
|---|---|---|---|---|---|
| **wikiPages** | embedding(1536) + confidence + citations | `memory-extract.ts`, `migrate-to-wiki.ts`, MCP `memory_write` | agent FTS only, `wiki_read`, wiki-lint | ❌ column exists, 0% populated | `/knowledge` + graph |
| **agentMemory** | k-v scoped (user/conv/org) | `memory-extract.ts:420-438` (legacy compat dual-write), API upsert | `agent.ts:203-230`, `oneone-prep.ts:195-205` (commitments) | ❌ | none |
| **spaceKnowledge** | legacy, soft-deleted | nothing (deprecated) | `routes/knowledge.ts` maps to wiki types | ❌ | `/knowledge` legacy aggregator |
| **decisions** | message-tied, is_reversed | `memory-extract.ts:445-460` (legacy compat), `routes/decisions.ts` PATCH | `agent-context.ts:845,871` | ❌ | **zero UI** |
| **notes** | user-only (no org_id) | `routes/daily-notes.ts` | `/notes` only | ❌ | `/notes` user-scoped |
| **burnout-detect** | signals in burnoutAlerts | `burnout-detector.ts` reads messages/peoplePatterns only | N/A | N/A | notifications only |
| **people-graph** | peopleInteractions/Expertise/Patterns/Relationships | `people-graph.ts` reads messages/tasks only | manager-pulse, oneone-prep | N/A | `/dashboard` role-gated card |
| **in-chat knowledge panel** | 4 types (decision/resource/action_item/note) via `/api/spaces/:id/knowledge` | `knowledge-panel.tsx` | chat sidebar only | ❌ | `space-chat.tsx:1072-1079, 1923` |

**Dead/orphaned:**
- `embed-content.ts` (7-line TODO stub; nothing enqueues it)
- `wiki-lint` (cron registered in `workers/index.ts:14` but missing from `lib/job-scheduler.ts` bootstrap; never fires)
- `create_plan` tool (listed in `AGENT_TOOLS` but no case in `executeToolCall` → "Unknown tool" error)
- `packages/ai/src/index.ts` (2-line stub, zero imports)

---

## Phase 0: Critical spine fixes

Purpose: Bring orphaned/stub workers to life and fix the bugs preventing the current architecture from working at all. Nothing in later phases works without this.

### Task 0.1: Implement `embed-content` worker with OpenAI provider

**Files:**
- Modify: `apps/api/src/workers/handlers/embed-content.ts` (currently 7-line TODO stub at lines 1-7)
- Modify: `apps/api/package.json` (add `openai` dep)
- Create: `apps/api/test/embed-content.test.ts`
- Reference: `apps/api/src/scripts/backfill-wiki-embeddings.ts:30-76` (existing OpenAI call pattern to mirror)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/embed-content.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleEmbedContent } from '../src/workers/handlers/embed-content.js';
import { db } from '@deft/db/client';
import { wikiPages } from '@deft/db/schema';
import { eq } from 'drizzle-orm';

describe('embed-content handler', () => {
  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-mock');
  });

  it('writes a 1536-dim embedding to the target wiki page', async () => {
    const [page] = await db.insert(wikiPages).values({
      org_id: 'test-org',
      slug: 'test-embed-page',
      title: 'Test page',
      content: 'We decided to use Stripe for billing.',
      summary: 'Billing decision.',
      type: 'decision',
      scope: 'org',
      confidence: 0.9,
    }).returning();

    await handleEmbedContent({
      id: 'job-1',
      data: { source_type: 'wiki_page', source_id: page.id },
    });

    const [updated] = await db.select().from(wikiPages).where(eq(wikiPages.id, page.id));
    expect(updated.embedding).toBeDefined();
    expect(Array.isArray(updated.embedding)).toBe(true);
    expect(updated.embedding).toHaveLength(1536);
  });

  it('returns early without error when OPENAI_API_KEY is unset', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    await expect(
      handleEmbedContent({ id: 'job-2', data: { source_type: 'wiki_page', source_id: 'missing' } }),
    ).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Verify the test fails**

Run: `pnpm --filter @deft/api test embed-content`
Expected: FAIL — `handleEmbedContent` is a stub that does nothing; the embedding column stays NULL.

- [ ] **Step 3: Implement the handler**

Replace the contents of `apps/api/src/workers/handlers/embed-content.ts`:

```typescript
// Handler: embed-content — generates vector embeddings for wiki pages via OpenAI.
import type { JobData } from '../types.js';
import { db } from '@deft/db/client';
import { wikiPages } from '@deft/db/schema';
import { eq } from 'drizzle-orm';

type EmbedJobPayload = {
  source_type: 'wiki_page';
  source_id: string;
};

const OPENAI_EMBED_URL = 'https://api.openai.com/v1/embeddings';
const MODEL = 'text-embedding-3-small';
const DIMS = 1536;

export async function handleEmbedContent(job: JobData): Promise<void> {
  const { source_type, source_id } = job.data as EmbedJobPayload;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.log(`[embed-content] OPENAI_API_KEY not set; skipping job ${job.id}`);
    return;
  }

  if (source_type !== 'wiki_page') {
    console.warn(`[embed-content] unknown source_type ${source_type}; skipping job ${job.id}`);
    return;
  }

  const [page] = await db
    .select({ id: wikiPages.id, title: wikiPages.title, summary: wikiPages.summary, content: wikiPages.content })
    .from(wikiPages)
    .where(eq(wikiPages.id, source_id))
    .limit(1);

  if (!page) {
    console.warn(`[embed-content] wiki page ${source_id} not found; job ${job.id}`);
    return;
  }

  // Compose the input: title + summary + content (truncated to 8k tokens ~ 32k chars).
  const input = [page.title, page.summary ?? '', page.content ?? ''].join('\n\n').slice(0, 32000);

  const response = await fetch(OPENAI_EMBED_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: MODEL, input, dimensions: DIMS }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`[embed-content] OpenAI ${response.status}: ${text}`);
  }

  const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
  const embedding = json.data[0]?.embedding;
  if (!embedding || embedding.length !== DIMS) {
    throw new Error(`[embed-content] malformed embedding response; length=${embedding?.length}`);
  }

  await db.update(wikiPages).set({ embedding }).where(eq(wikiPages.id, source_id));
  console.log(`[embed-content] wrote ${DIMS}-dim embedding for wiki page ${source_id}`);
}
```

- [ ] **Step 4: Re-run the test; it should pass**

Run: `pnpm --filter @deft/api test embed-content`
Expected: both tests pass. (Mock the fetch call in the first test — use `vi.stubGlobal('fetch', ...)`.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workers/handlers/embed-content.ts apps/api/test/embed-content.test.ts apps/api/package.json
git commit -m "feat(embed): implement embed-content worker with openai provider"
```

---

### Task 0.2: Wire `embed-content` into the ingest path from `memory-extract`

**Files:**
- Modify: `apps/api/src/workers/handlers/memory-extract.ts` (currently writes wiki pages without enqueuing embeddings — see lines 195-246 for CREATE path, 145-192 for UPDATE path)
- Modify: `apps/api/test/memory-extract.test.ts` (or create if absent)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/memory-extract.test.ts
it('enqueues an embed-content job after creating a wiki page', async () => {
  const enqueueSpy = vi.spyOn(queues, 'enqueueAgentJob');
  await handleMemoryExtract({
    id: 'extract-1',
    data: {
      org_id: 'test-org',
      message_id: 'msg-1',
      facts: ['We decided to use Stripe for billing.'],
      decision: null,
    },
  });
  expect(enqueueSpy).toHaveBeenCalledWith(
    'embed-content',
    expect.objectContaining({ source_type: 'wiki_page' }),
  );
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @deft/api test memory-extract`
Expected: FAIL — no embed-content enqueue exists yet.

- [ ] **Step 3: Add the enqueue call**

In `apps/api/src/workers/handlers/memory-extract.ts`, after each successful wiki page create or update (the CREATE path around line 246 and the UPDATE path around line 192), add:

```typescript
// Enqueue embedding generation (fire-and-forget; non-critical)
try {
  await enqueueAgentJob('embed-content', {
    source_type: 'wiki_page',
    source_id: pageId, // the id of the just-created/updated wiki page
  });
} catch (err) {
  console.warn(`[memory-extract] failed to enqueue embed-content for ${pageId}`, err);
}
```

Add the import at the top:
```typescript
import { enqueueAgentJob } from '../../lib/queues.js';
```

- [ ] **Step 4: Re-run the test; it should pass**

Run: `pnpm --filter @deft/api test memory-extract`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workers/handlers/memory-extract.ts apps/api/test/memory-extract.test.ts
git commit -m "feat(memory-extract): enqueue embed-content on wiki create/update"
```

---

### Task 0.3: Backfill existing wiki embeddings

**Files:**
- Modify: `apps/api/src/scripts/backfill-wiki-embeddings.ts` (script already exists; runs standalone — wire it to skip pages that already have embeddings so it's idempotent, and add a `--dry-run` flag)

- [ ] **Step 1: Add `--dry-run` flag parsing**

At the top of the main function, parse `process.argv` for `--dry-run`. If set, log what would be updated but don't mutate.

- [ ] **Step 2: Add `WHERE embedding IS NULL` guard**

Confirm the query at `backfill-wiki-embeddings.ts:106-110` already has `WHERE embedding IS NULL`. If yes, no change needed. If no, add it.

- [ ] **Step 3: Run the backfill against dev database (dry run first)**

```bash
pnpm --filter @deft/api exec tsx src/scripts/backfill-wiki-embeddings.ts --dry-run
```
Expected output: count of NULL-embedding pages (per org).

- [ ] **Step 4: Run for real on dev**

```bash
pnpm --filter @deft/api exec tsx src/scripts/backfill-wiki-embeddings.ts
```
Verify via psql: `SELECT count(*) FROM wiki_pages WHERE embedding IS NOT NULL;` — should equal total non-deleted wiki pages.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/scripts/backfill-wiki-embeddings.ts
git commit -m "chore(embed): add dry-run flag to backfill script"
```

---

### Task 0.4: Bootstrap the `wiki-lint` cron

**Files:**
- Modify: `apps/api/src/lib/job-scheduler.ts` (missing the wiki-lint bootstrap — currently only schedules standup, nudge, people-graph, manager-pulse, burnout-detect, gateway-ping)
- Reference: `apps/api/src/workers/index.ts:14,134-136` (wiki-lint registration exists but is never initialized)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/job-scheduler.test.ts
it('registers wiki-lint as a scheduled cron job', async () => {
  const scheduledJobs = await initScheduler();
  expect(scheduledJobs).toContain('wiki-lint');
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @deft/api test job-scheduler`
Expected: FAIL — no such cron exists yet.

- [ ] **Step 3: Add the bootstrap**

In `apps/api/src/lib/job-scheduler.ts`, add a line alongside the other cron registrations (after the `burnout-detect` line, ~line 11):

```typescript
await ensureCronJob('wiki-lint', 24 * 60 * 60 * 1000, 'cron:wiki-lint');
```

- [ ] **Step 4: Re-run test**

Expected: PASS.

- [ ] **Step 5: Verify in workers log**

Restart dev: `pnpm dev:api`. Look for log line `[scheduler] cron:wiki-lint registered`. Wiki-lint will now fire nightly.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/job-scheduler.ts apps/api/test/job-scheduler.test.ts
git commit -m "fix(scheduler): bootstrap wiki-lint cron (was registered but never fired)"
```

---

### Task 0.5: Implement the `create_plan` tool handler

**Files:**
- Modify: `apps/api/src/lib/agent-context.ts` (the `executeToolCall` switch statement around lines 41-1949 — add a case for `create_plan`)
- Reference: `apps/api/src/routes/agent-plans.ts:62-98` (existing REST create-plan handler — extract its logic into a shared function)
- Modify: `apps/api/src/lib/agent-tools.ts:293-330` (tool declaration — confirm schema matches)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/agent-context-create-plan.test.ts
it('create_plan tool call persists a plan row and returns the plan id', async () => {
  const result = await executeToolCall({
    name: 'create_plan',
    input: {
      title: 'Test plan',
      steps: [
        { id: 'step-1', description: 'Do thing', tool: 'search_messages', params: { query: 'foo' } },
      ],
    },
  }, { userId: 'test-user', orgId: 'test-org', conversationId: 'conv-1' });
  expect(result).toMatchObject({ plan_id: expect.any(String), status: 'draft' });
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @deft/api test agent-context-create-plan`
Expected: FAIL — `executeToolCall` returns "Unknown tool: create_plan" error.

- [ ] **Step 3: Extract `createPlanRow` helper**

In `apps/api/src/lib/agent-plans.ts`, extract the plan-creation logic from the REST route into an exported function:

```typescript
export async function createPlanRow(params: {
  org_id: string;
  user_id: string;
  conversation_id?: string;
  agent_employee_id?: string;
  title: string;
  description?: string;
  steps: PlanStep[];
}): Promise<{ plan_id: string; status: 'draft' }> {
  const [row] = await db.insert(agentPlans).values({
    org_id: params.org_id,
    user_id: params.user_id,
    conversation_id: params.conversation_id,
    agent_employee_id: params.agent_employee_id,
    title: params.title,
    description: params.description ?? '',
    steps: params.steps,
    status: 'draft',
    current_step: 0,
    context: {},
  }).returning({ id: agentPlans.id });
  return { plan_id: row.id, status: 'draft' };
}
```

Update `routes/agent-plans.ts:62-98` to call `createPlanRow`.

- [ ] **Step 4: Wire the case into `executeToolCall`**

In `apps/api/src/lib/agent-context.ts`, add a case to the switch statement:

```typescript
case 'create_plan': {
  const { title, description, steps } = input as { title: string; description?: string; steps: PlanStep[] };
  return await createPlanRow({
    org_id: ctx.orgId,
    user_id: ctx.userId,
    conversation_id: ctx.conversationId,
    agent_employee_id: ctx.agentEmployeeId,
    title,
    description,
    steps,
  });
}
```

- [ ] **Step 5: Re-run test**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/agent-context.ts apps/api/src/lib/agent-plans.ts apps/api/src/routes/agent-plans.ts apps/api/test/agent-context-create-plan.test.ts
git commit -m "fix(agent): implement create_plan tool handler (was registered but unroutable)"
```

---

## Phase 1: Unified `retrieveContext` gateway

Purpose: Replace the five separate per-surface queries the agent currently makes with a single semantic-first gateway that ranks wiki + memory + notes + decisions together.

### Task 1.1: Write the `retrieveContext` signature + baseline FTS test

**Files:**
- Create: `apps/api/src/lib/retrieve-context.ts`
- Create: `apps/api/test/retrieve-context.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/retrieve-context.test.ts
import { describe, it, expect } from 'vitest';
import { retrieveContext } from '../src/lib/retrieve-context.js';

describe('retrieveContext', () => {
  it('returns ranked results across wiki + memory + notes + decisions', async () => {
    const results = await retrieveContext({
      query: 'billing decision',
      org_id: 'test-org',
      user_id: 'test-user',
      types: ['wiki', 'memory', 'notes', 'decisions'],
      limit: 10,
    });
    expect(Array.isArray(results)).toBe(true);
    expect(results.every(r => 'source_type' in r && 'score' in r && 'title' in r)).toBe(true);
  });

  it('respects type filter (wiki only)', async () => {
    const results = await retrieveContext({
      query: 'anything',
      org_id: 'test-org',
      user_id: 'test-user',
      types: ['wiki'],
      limit: 5,
    });
    expect(results.every(r => r.source_type === 'wiki_page')).toBe(true);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `pnpm --filter @deft/api test retrieve-context`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create the FTS-only baseline**

```typescript
// apps/api/src/lib/retrieve-context.ts
import { db } from '@deft/db/client';
import { wikiPages, agentMemory, notes, decisions } from '@deft/db/schema';
import { and, eq, or, sql } from 'drizzle-orm';

export type ContextSource = 'wiki_page' | 'agent_memory' | 'note' | 'decision';

export interface ContextResult {
  source_type: ContextSource;
  source_id: string;
  title: string;
  content: string;
  score: number;
  scope?: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface RetrieveContextParams {
  query: string;
  org_id: string;
  user_id?: string;
  conversation_id?: string;
  agent_employee_id?: string;
  types?: Array<'wiki' | 'memory' | 'notes' | 'decisions'>;
  limit?: number;
}

export async function retrieveContext(params: RetrieveContextParams): Promise<ContextResult[]> {
  const { query, org_id, user_id, types = ['wiki', 'memory', 'notes', 'decisions'], limit = 10 } = params;
  const cleanQuery = query.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  if (cleanQuery.length < 2) return [];

  const results: ContextResult[] = [];

  if (types.includes('wiki')) {
    const wikiRows = await db
      .select({
        id: wikiPages.id,
        title: wikiPages.title,
        content: wikiPages.content,
        summary: wikiPages.summary,
        scope: wikiPages.scope,
        confidence: wikiPages.confidence,
        score: sql<number>`ts_rank(search_vector, plainto_tsquery('english', ${cleanQuery})) * ${wikiPages.confidence}`,
      })
      .from(wikiPages)
      .where(
        and(
          eq(wikiPages.org_id, org_id),
          eq(wikiPages.is_deleted, false),
          sql`search_vector @@ plainto_tsquery('english', ${cleanQuery})`,
        ),
      )
      .orderBy(sql`score DESC`)
      .limit(limit);

    for (const r of wikiRows) {
      results.push({
        source_type: 'wiki_page',
        source_id: r.id,
        title: r.title,
        content: r.summary ?? r.content.slice(0, 500),
        score: Number(r.score),
        scope: r.scope,
        confidence: r.confidence,
      });
    }
  }

  // Similar blocks for memory, notes, decisions (omitted for brevity but follow the same pattern;
  // write actual implementations, not placeholders).

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
```

Write the full implementation for all four source types — do not leave them as comments. Each branch should query its table, normalize scores to 0-1, and push into results.

- [ ] **Step 4: Re-run tests**

Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/retrieve-context.ts apps/api/test/retrieve-context.test.ts
git commit -m "feat(retrieve): add retrieveContext gateway with FTS across wiki/memory/notes/decisions"
```

---

### Task 1.2: Add hybrid FTS + vector ranking to `retrieveContext`

**Files:**
- Modify: `apps/api/src/lib/retrieve-context.ts`
- Modify: `apps/api/test/retrieve-context.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('uses vector similarity when embeddings are available', async () => {
  // Seed a wiki page with an embedding manually
  await db.update(wikiPages).set({ embedding: [...Array(1536).keys()].map(() => 0.1) })
    .where(eq(wikiPages.slug, 'test-seeded'));
  const results = await retrieveContext({
    query: 'something totally unrelated',
    org_id: 'test-org',
    types: ['wiki'],
    hybrid: true,
  });
  // The seeded page should still appear in top results due to vector proximity
  expect(results.some(r => r.source_id === 'test-seeded')).toBe(true);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @deft/api test retrieve-context`
Expected: FAIL.

- [ ] **Step 3: Extract a helper `generateQueryEmbedding`**

```typescript
async function generateQueryEmbedding(query: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: query, dimensions: 1536 }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return json.data[0]?.embedding ?? null;
}
```

- [ ] **Step 4: Wire hybrid ranking into the wiki branch**

```typescript
const queryEmbedding = params.hybrid !== false ? await generateQueryEmbedding(cleanQuery) : null;

const ftsRankSql = sql<number>`ts_rank(search_vector, plainto_tsquery('english', ${cleanQuery}))`;
const vectorRankSql = queryEmbedding
  ? sql<number>`1 - (embedding <=> ${sql.raw(`'[${queryEmbedding.join(',')}]'::vector`)})`
  : sql<number>`0`;

const hybridScoreSql = queryEmbedding
  ? sql<number>`(0.4 * ${ftsRankSql} + 0.6 * ${vectorRankSql}) * ${wikiPages.confidence}`
  : sql<number>`${ftsRankSql} * ${wikiPages.confidence}`;

// use hybridScoreSql in the select + orderBy
```

For pages without embeddings, the vector term is 0 and the FTS term dominates — graceful degradation.

- [ ] **Step 5: Re-run test**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/retrieve-context.ts apps/api/test/retrieve-context.test.ts
git commit -m "feat(retrieve): add hybrid fts+vector ranking with graceful degradation"
```

---

### Task 1.3: Replace `agent.ts` wiki retrieval with `retrieveContext`

**Files:**
- Modify: `apps/api/src/routes/agent.ts:238-296` (the current wiki auto-load block — 3 separate queries for employee, org, memory)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/test/agent-context-retrieval.test.ts
it('agent buildStreamContext uses retrieveContext gateway', async () => {
  const spy = vi.spyOn(retrieveContextModule, 'retrieveContext');
  await buildStreamContext({ /* mocked user, convo, etc. */ });
  expect(spy).toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify failure**

Run: expected FAIL.

- [ ] **Step 3: Replace the block**

Delete `agent.ts:238-296` (three separate queries) and replace with a single call:

```typescript
import { retrieveContext } from '../lib/retrieve-context.js';

// ... inside buildStreamContext, where wiki loading was:
const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
const rawQuery = lastUserMsg?.content ?? '';
if (rawQuery.length > 2) {
  const contextResults = await retrieveContext({
    query: rawQuery,
    org_id: user.org_id,
    user_id: user.id,
    conversation_id: convoId,
    agent_employee_id: agentEmployeeId,
    types: ['wiki', 'memory'],
    limit: 5,
  });
  // Append to system prompt in the same format the previous block used
  wikiContext = contextResults.map(r => `[${r.source_type}] ${r.title}\n${r.content}`).join('\n\n');
}
```

Note: `agentMemory` reads at lines 203-230 remain for now (they're scope-filtered KV pairs, not semantic search). They will be retired in Task 2.1.

- [ ] **Step 4: Re-run test; verify no regressions in existing agent tests**

Run: `pnpm --filter @deft/api test agent`
Expected: existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agent.ts apps/api/test/agent-context-retrieval.test.ts
git commit -m "refactor(agent): use retrieveContext gateway for wiki auto-load"
```

---

### Task 1.4: Replace MCP `memory_recall` with `retrieveContext`

**Files:**
- Modify: `apps/api/src/lib/mcp-tools/memory.ts:41-99`

- [ ] **Step 1: Write the failing test**

```typescript
// test/mcp-memory-recall.test.ts
it('memory_recall delegates to retrieveContext', async () => {
  const spy = vi.spyOn(retrieveContextModule, 'retrieveContext');
  await handleMemoryRecall({ query: 'foo', scope: 'all' }, { orgId: 'test', employeeId: 'emp-1' });
  expect(spy).toHaveBeenCalledWith(expect.objectContaining({ types: expect.arrayContaining(['wiki']) }));
});
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Rewrite `memory_recall` to delegate**

Replace the handler body with a call to `retrieveContext`. Translate the `scope` param ('own' | 'org' | 'all') into appropriate filtering of the results based on `agent_employee_id`.

- [ ] **Step 4: Re-run test**

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(mcp): memory_recall delegates to retrieveContext gateway"
```

---

### Task 1.5: Replace `platform_context` wiki retrieval with `retrieveContext`

**Files:**
- Modify: `apps/api/src/lib/mcp-tools/context.ts:192-210`

- [ ] **Step 1: Test, implement, verify** (same pattern as 1.3/1.4)

Replace the FTS-only wiki snippet retrieval with a `retrieveContext` call. Preserve the 60s LRU cache at `context.ts` — wrap the gateway call, not replace the cache.

- [ ] **Step 2: Commit**

```bash
git commit -m "refactor(mcp): platform_context delegates to retrieveContext gateway"
```

---

## Phase 2: Schema consolidation — retire legacy dual-writes

Purpose: memory-extract is currently writing to three tables on every fact extraction (wiki + agentMemory + decisions) per the "COMPAT: remove after wiki migration complete" comment at `memory-extract.ts:420`. Finish the migration.

### Task 2.1: Migrate `oneone-prep.ts` commitments read from `agentMemory` to `wikiPages`

**Files:**
- Modify: `apps/api/src/services/oneone-prep.ts:195-205`

- [ ] **Step 1: Write the failing test**

```typescript
it('oneone-prep reads commitments from wikiPages with type=preference and commitment tag', async () => {
  // seed a wiki page of type='preference' with tag 'commitment'
  const prep = await generateOneOnePrep({ managerId: 'mgr', reportId: 'rep-1' });
  expect(prep.commitments).toContainEqual(expect.objectContaining({ text: expect.stringContaining('commitment') }));
});
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Rewrite the commitment query**

Replace lines 195-205 (the agentMemory LIKE '%commitment%' query) with:

```typescript
const commitmentRows = await db
  .select({ id: wikiPages.id, title: wikiPages.title, content: wikiPages.content, created_at: wikiPages.created_at })
  .from(wikiPages)
  .where(
    and(
      eq(wikiPages.org_id, user.org_id),
      eq(wikiPages.is_deleted, false),
      sql`${wikiPages.tags} @> ARRAY['commitment']::text[]`,
      sql`${wikiPages.referenced_user_ids} @> ARRAY[${reportId}]::text[]`,
    ),
  )
  .orderBy(desc(wikiPages.created_at))
  .limit(10);
```

Note: This assumes `wikiPages.tags` and `wikiPages.referenced_user_ids` columns exist. If they don't, Task 2.2 adds them.

- [ ] **Step 4: Add the schema columns if missing**

Check `packages/db/src/schema.ts:1048-1070`. If `tags` and `referenced_user_ids` arrays don't exist on wikiPages, add them:

```typescript
tags: text('tags').array().default(sql`ARRAY[]::text[]`),
referenced_user_ids: text('referenced_user_ids').array().default(sql`ARRAY[]::text[]`),
```

Generate a migration: `pnpm --filter @deft/db drizzle-kit generate`.

- [ ] **Step 5: Update `memory-extract.ts` to populate tags + referenced_user_ids**

When extracting commitments, attach `tags: ['commitment']` and populate `referenced_user_ids` with the speaker + any mentioned users.

- [ ] **Step 6: Re-run test**

- [ ] **Step 7: Commit**

```bash
git commit -m "refactor(oneone-prep): read commitments from wikiPages instead of agentMemory"
```

---

### Task 2.2: Kill the `agentMemory` dual-write in `memory-extract.ts`

**Files:**
- Modify: `apps/api/src/workers/handlers/memory-extract.ts:420-438`

- [ ] **Step 1: Write the failing test**

```typescript
it('memory-extract no longer writes to agentMemory', async () => {
  await handleMemoryExtract({ id: 'ex-1', data: { /* fact extract payload */ } });
  const rows = await db.select().from(agentMemory).where(eq(agentMemory.org_id, 'test-org'));
  expect(rows).toHaveLength(0);
});
```

- [ ] **Step 2: Verify failure**

Expected: FAIL (current code writes a row).

- [ ] **Step 3: Delete lines 420-438**

Remove the entire "COMPAT: Also write to legacy agentMemory" block. Keep only the wiki write path.

- [ ] **Step 4: Verify the test passes AND no downstream consumer breaks**

Grep for any remaining `.from(agentMemory)` reads. Must verify each one is either:
1. Retired (Task 2.1 covers oneone-prep)
2. Still reading scope='conversation' rows (ephemeral in-conversation state — KEEP this path for now; it's not the fact-extraction path)

The only writers of `scope='conversation'` rows are the native `remember` tool calls from the agent itself, which are a legitimate short-term KV store. Those stay.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(memory-extract): stop dual-writing to agentMemory (wiki migration complete)"
```

---

### Task 2.3: Kill the `decisions` dual-write in `memory-extract.ts`

**Files:**
- Modify: `apps/api/src/workers/handlers/memory-extract.ts:445-460`
- Modify: `apps/api/src/lib/agent-context.ts:845,871` (currently reads decisions table — migrate to reading wiki pages of type='decision')

- [ ] **Step 1: Write the failing test**

```typescript
it('memory-extract no longer writes to decisions table', async () => {
  await handleMemoryExtract({ id: 'd-1', data: { decision: 'We will use Stripe.' } });
  const rows = await db.select().from(decisions).where(eq(decisions.org_id, 'test-org'));
  expect(rows).toHaveLength(0);
});
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Delete lines 445-460 from memory-extract.ts**

- [ ] **Step 4: Update `agent-context.ts:845,871`**

Replace the `decisions` table reads with wiki pages of type='decision':

```typescript
const decisionsList = await db
  .select()
  .from(wikiPages)
  .where(
    and(
      eq(wikiPages.org_id, orgId),
      eq(wikiPages.type, 'decision'),
      eq(wikiPages.is_deleted, false),
    ),
  )
  .orderBy(desc(wikiPages.created_at))
  .limit(20);
```

- [ ] **Step 5: Update `routes/decisions.ts` (GET/PATCH)**

Re-point the existing endpoints at wikiPages so external API contract is preserved (clients hit `/api/decisions` and get wiki-backed data). The PATCH endpoint's `is_reversed` should now update `wikiPages.confidence` (0.2 for reversed, 0.9 for active) and add a tag `reversed`.

```typescript
// routes/decisions.ts PATCH handler
await db.update(wikiPages)
  .set({
    confidence: body.is_reversed ? 0.2 : 0.9,
    tags: sql`array_append(${wikiPages.tags}, 'reversed')`,
  })
  .where(and(eq(wikiPages.id, id), eq(wikiPages.type, 'decision')));
```

- [ ] **Step 6: Re-run tests**

- [ ] **Step 7: Commit**

```bash
git commit -m "refactor(decisions): migrate to wikiPages type=decision; update is_reversed→confidence"
```

---

### Task 2.4: Deprecate legacy tables (mark as DEPRECATED, plan drop)

**Files:**
- Modify: `packages/db/src/schema.ts` (agentMemory, decisions, spaceKnowledge)

- [ ] **Step 1: Add `/** @deprecated */` JSDoc to the three table definitions**

Do NOT drop the tables yet — they may hold historical data still referenced by reports or migrations. Mark them deprecated with a JSDoc comment pointing to the migration plan.

```typescript
/**
 * @deprecated Use wikiPages instead. Retired 2026-04-16 in feat/knowledge-unification.
 * Writes stopped in Task 2.2 (agentMemory except conversation-scope), Task 2.3 (decisions).
 * Safe to drop after 30 days (2026-05-16) if no consumers remain.
 * The spaceKnowledge table stopped receiving writes before this plan.
 */
export const agentMemory = pgTable(/* ... */);
```

- [ ] **Step 2: Add a cron job `deprecation-warning` that logs row counts**

Create `apps/api/src/workers/handlers/deprecation-warning.ts`:

```typescript
export async function handleDeprecationWarning(): Promise<void> {
  const [am] = await db.select({ count: sql<number>`count(*)::int` }).from(agentMemory)
    .where(or(eq(agentMemory.scope, 'user'), eq(agentMemory.scope, 'org')));
  const [dec] = await db.select({ count: sql<number>`count(*)::int` }).from(decisions);
  const [sk] = await db.select({ count: sql<number>`count(*)::int` }).from(spaceKnowledge)
    .where(eq(spaceKnowledge.is_deleted, false));
  console.warn(`[deprecation] legacy tables: agentMemory(user+org)=${am.count}, decisions=${dec.count}, spaceKnowledge=${sk.count}`);
  if (am.count + dec.count + sk.count === 0) {
    console.warn('[deprecation] all legacy tables empty — safe to drop');
  }
}
```

Register it in `workers/index.ts` and bootstrap in `job-scheduler.ts` with a 24h cron.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore(schema): deprecate agentMemory/decisions/spaceKnowledge; add warning cron"
```

---

## Phase 3: In-chat knowledge panel unification

Purpose: The in-chat knowledge panel currently has 4 types (decision/resource/action_item/note) backed by `/api/spaces/:id/knowledge` which routes via `routes/knowledge.ts`. The wiki has 7 types. Create a unified contract: the panel becomes a space-scoped filter view over wikiPages, with a promote/demote flow.

### Task 3.1: Migrate the knowledge panel to read from `wikiPages`

**Files:**
- Modify: `apps/web/src/components/knowledge-panel.tsx`
- Modify: `apps/api/src/routes/knowledge.ts` (currently has legacy type-mapping at lines 10-56 — replace with a direct wikiPages query filtered by space)

- [ ] **Step 1: Rewrite the API endpoint**

In `routes/knowledge.ts`, the handler for `GET /api/spaces/:spaceId/knowledge` should query:

```typescript
const pages = await db
  .select()
  .from(wikiPages)
  .where(
    and(
      eq(wikiPages.org_id, user.org_id),
      eq(wikiPages.scope, 'space'),
      eq(wikiPages.space_id, spaceId),
      eq(wikiPages.is_deleted, false),
      type ? eq(wikiPages.type, type) : sql`true`,
    ),
  )
  .orderBy(desc(wikiPages.updated_at));
```

If `wikiPages.space_id` column doesn't exist (check schema), add it as a nullable FK. Migration: `pnpm --filter @deft/db drizzle-kit generate`.

- [ ] **Step 2: Rewrite `POST /api/spaces/:spaceId/knowledge`**

Instead of writing to `spaceKnowledge`, insert into `wikiPages` with `scope: 'space'`, `space_id: spaceId`, and map the panel's 4-type input to wiki types (decision→decision, resource→resource, action_item→procedure, note→fact). Enqueue `embed-content` job for each new page.

- [ ] **Step 3: Update `knowledge-panel.tsx` UI**

The component already renders fine against a wikiPages shape since both have `title`, `content`, `type` — just rename any fields it expected from the legacy response (`source_message_id` → `citations[0].source_id` if citations are used).

Add a "Types" selector that exposes all 7 wiki types, not 4.

- [ ] **Step 4: Write a Playwright test in `docs/superpowers/audits/gap-fixes.audit.ts`**

```typescript
await page.goto('http://localhost:3000/chat');
await page.click('button[aria-label="Knowledge"]');
await page.click('button:has-text("Add")');
await page.selectOption('select[name="type"]', 'concept');
await page.fill('input[name="title"]', 'Test unified concept');
await page.fill('textarea[name="content"]', 'A concept created from chat panel.');
await page.click('button:has-text("Save")');
// Navigate to /knowledge and verify the concept appears under Concepts filter
await page.goto('http://localhost:3000/knowledge');
await page.click('button:has-text("Concept")');
await expect(page.locator('text=Test unified concept')).toBeVisible();
```

- [ ] **Step 5: Run audit, expected to pass**

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(knowledge): unify in-chat panel with wiki (space-scoped wikiPages)"
```

---

### Task 3.2: Add a "View in Wiki" universal link for panel entries

**Files:**
- Modify: `apps/web/src/components/knowledge-panel.tsx:362-366`

- [ ] **Step 1: Remove the slug check**

Since every entry is now a wikiPage, every entry has a slug. The current conditional `entry.slug ? showLink : null` becomes unconditional.

```typescript
<a href={`/knowledge/${entry.slug}`} className="...">View in Wiki →</a>
```

- [ ] **Step 2: Commit**

```bash
git commit -m "fix(knowledge-panel): always show View in Wiki link (all entries are now wikiPages)"
```

---

### Task 3.3: Give decisions a dedicated list view

**Files:**
- Modify: `apps/web/src/app/(app)/knowledge/page.tsx` — add a prominent "Decisions" tab/filter with custom display (is_reversed badge, confidence score, originating message citation)

- [ ] **Step 1: Add a Decisions tab to the knowledge page**

The page already has type filters (`/knowledge/page.tsx:394`). Promote the "decision" filter into a prominent tab with:
- A "Reversed" badge when `confidence < 0.5` or `tags.includes('reversed')`
- A timeline view showing decision creation date + cited message
- A "Reverse decision" action button that calls `PATCH /api/decisions/:id` with `is_reversed: true`

- [ ] **Step 2: Add the decisions route deep-link**

`/knowledge?type=decision` should pre-filter to decisions.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(knowledge): add prominent decisions view with reverse action"
```

---

## Phase 4: Observational enrichment — burnout + people graph read knowledge signals

Purpose: Burnout detector and people graph currently ignore the knowledge layer entirely. Feed authorship, citations, stalled decisions, and commitment backlog into their signals.

### Task 4.1: Burnout detector reads wiki authorship overload signal

**Files:**
- Modify: `apps/api/src/services/burnout-detector.ts` (add a 6th signal alongside working-hours/sentiment/withdrawal/response-time/overwork)
- Modify: `apps/api/test/burnout-detector.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('flags wiki authorship overload as a burnout signal', async () => {
  // seed: user authored 15 wiki pages in 7 days (baseline is 3)
  const result = await detectBurnout({ userId: 'user-1', orgId: 'test-org' });
  expect(result.signals).toContainEqual(expect.objectContaining({ name: 'authorship_overload', detected: true }));
});
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement the signal**

Add a function `detectAuthorshipOverload(userId, orgId)` that:
1. Counts wiki pages where `created_by=userId` in the last 14 days
2. Computes a 30-day baseline of weekly authorship
3. Returns `detected: true` if recent 2-week count > 3× baseline

Add to the signals array with weight 0.15, then renormalize weights (working-hours 0.15 + sentiment 0.2 + withdrawal 0.1 + response-time 0.15 + overwork 0.25 + authorship 0.15 = 1.0).

- [ ] **Step 4: Re-run test**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(burnout): add wiki authorship overload as burnout signal"
```

---

### Task 4.2: Burnout detector reads stalled commitment signal

**Files:**
- Modify: `apps/api/src/services/burnout-detector.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it('flags stalled commitments as a burnout signal', async () => {
  // seed: user has 5 wiki pages tagged 'commitment' mentioning them, all >30 days old
  const result = await detectBurnout({ userId: 'user-1', orgId: 'test-org' });
  expect(result.signals).toContainEqual(expect.objectContaining({ name: 'stalled_commitments', detected: true }));
});
```

- [ ] **Step 2-5: Implement, verify, commit** using the same pattern

```typescript
const stalledCommitments = await db
  .select({ count: sql<number>`count(*)::int` })
  .from(wikiPages)
  .where(
    and(
      eq(wikiPages.org_id, orgId),
      sql`${wikiPages.tags} @> ARRAY['commitment']::text[]`,
      sql`${wikiPages.referenced_user_ids} @> ARRAY[${userId}]::text[]`,
      sql`${wikiPages.updated_at} < NOW() - INTERVAL '30 days'`,
    ),
  );
```

Threshold: `stalledCommitments.count >= 5` → `detected: true`.

```bash
git commit -m "feat(burnout): add stalled commitments signal"
```

---

### Task 4.3: People graph: wiki authorship → expertise signal

**Files:**
- Modify: `apps/api/src/services/people-graph.ts:215-413` (the expertise extraction section)

- [ ] **Step 1: Write the failing test**

```typescript
it('people-graph counts wiki authorship toward expertise scoring', async () => {
  // seed: user authored 10 wiki pages tagged 'typescript'
  await runFullPeopleGraph({ orgId: 'test-org' });
  const [expertise] = await db.select().from(peopleExpertise)
    .where(and(eq(peopleExpertise.user_id, 'user-1'), eq(peopleExpertise.topic, 'typescript')));
  expect(expertise.expertise_score).toBeGreaterThan(10); // wiki pages weighted at 5 each
});
```

- [ ] **Step 2: Implement**

Add a new source of topic signal: wiki pages authored by the user. Each page contributes `+5` to the expertise score for each of its tags (or for topics extracted from `page.tags` field).

```typescript
// Inside extractExpertise loop, after message/task topic extraction:
const authoredPages = await db
  .select({ tags: wikiPages.tags, confidence: wikiPages.confidence })
  .from(wikiPages)
  .where(
    and(
      eq(wikiPages.org_id, orgId),
      eq(wikiPages.created_by, userId),
      eq(wikiPages.is_deleted, false),
      sql`${wikiPages.created_at} > NOW() - INTERVAL '24 hours'`,
    ),
  );
for (const page of authoredPages) {
  for (const tag of page.tags ?? []) {
    topicScores[tag] = (topicScores[tag] ?? 0) + 5 * page.confidence;
  }
}
```

- [ ] **Step 3-5: Test, verify, commit**

```bash
git commit -m "feat(people-graph): count wiki authorship toward expertise scoring"
```

---

### Task 4.4: People graph: wiki citations → peopleRelationships edges

**Files:**
- Modify: `apps/api/src/services/people-graph.ts:798-923` (detectRelationships block)

- [ ] **Step 1: Write the failing test**

```typescript
it('creates peopleRelationships edge when user A cites user B wiki pages', async () => {
  // seed: user-A creates a wiki page citing a wiki page authored by user-B
  await runFullPeopleGraph({ orgId: 'test-org' });
  const [rel] = await db.select().from(peopleRelationships)
    .where(and(eq(peopleRelationships.user_a, 'user-A'), eq(peopleRelationships.user_b, 'user-B')));
  expect(rel.relationship_type).toBe('knowledge_dependency');
});
```

- [ ] **Step 2: Add `'knowledge_dependency'` to the relationship_type enum**

In `packages/db/src/schema.ts`, extend the relationship_type enum. Generate migration.

- [ ] **Step 3: Implement**

```typescript
// Inside detectRelationships:
const citationPairs = await db.execute(sql`
  SELECT citing.created_by AS user_a, cited.created_by AS user_b, COUNT(*)::int AS strength
  FROM wiki_citations wc
  JOIN wiki_pages citing ON citing.id = wc.source_page_id
  JOIN wiki_pages cited ON cited.id = wc.target_page_id
  WHERE citing.org_id = ${orgId}
    AND citing.created_by != cited.created_by
  GROUP BY citing.created_by, cited.created_by
  HAVING COUNT(*) >= 2
`);
for (const { user_a, user_b, strength } of citationPairs) {
  await db.insert(peopleRelationships).values({
    org_id: orgId,
    user_a, user_b,
    relationship_type: 'knowledge_dependency',
    strength: Math.min(1, strength / 10),
  }).onConflictDoUpdate({ target: [peopleRelationships.user_a, peopleRelationships.user_b, peopleRelationships.relationship_type], set: { strength: sql`EXCLUDED.strength` } });
}
```

- [ ] **Step 4-5: Test, verify, commit**

```bash
git commit -m "feat(people-graph): derive knowledge_dependency edges from wikiCitations"
```

---

### Task 4.5: Implement the three missing relationship types

**Files:**
- Modify: `apps/api/src/services/people-graph.ts`

Schema declares `tension`, `delegation_chain`, `cross_team_bridge` relationship types but people-graph only implements `close_collaborator` and `mentor_mentee`.

- [ ] **Step 1: Write failing tests for all three types** (one `it` block each)

- [ ] **Step 2: Implement `tension`**

Signal: two users where (a) they frequently co-participate in threads but (b) sentiment delta between their messages exceeds 0.4 (one is positive, the other is negative). Use the sentiment analysis from burnout-detector's LLM path.

- [ ] **Step 3: Implement `delegation_chain`**

Signal: user A frequently assigns tasks to user B (≥5 in 14 days) with no reverse assignments. Query `tasks.assigned_by + assigned_to`.

- [ ] **Step 4: Implement `cross_team_bridge`**

Signal: user is a member of ≥3 distinct spaces AND is cited in each space's knowledge. Query `space_members` × `peopleExpertise`.

- [ ] **Step 5: Run tests and commit**

```bash
git commit -m "feat(people-graph): implement tension/delegation_chain/cross_team_bridge detection"
```

---

## Phase 5: Notes org visibility + command palette + hygiene

### Task 5.1: Add optional `org_id` to `notes` for org-wide visibility

**Files:**
- Modify: `packages/db/src/schema.ts:904-922`
- Migration: generate a new one

- [ ] **Step 1: Add the column**

```typescript
export const notes = pgTable('notes', {
  // existing columns...
  visibility: text('visibility').notNull().default('private'), // 'private' | 'org' | 'space'
  visibility_space_id: text('visibility_space_id'),
});
```

Note: keep `user_id` — notes remain owned by a user. The new `visibility` column opts in to broader visibility.

- [ ] **Step 2: Generate migration**

```bash
pnpm --filter @deft/db drizzle-kit generate
```

- [ ] **Step 3: Update `routes/daily-notes.ts` list handler**

The GET list now returns notes where:
```
user_id = current_user OR visibility = 'org' AND org_id = current_user.org_id
```

- [ ] **Step 4: Add the visibility selector to the notes UI**

In `apps/web/src/app/(app)/notes/page.tsx`, add a dropdown: Private / Org / Space. Default: Private.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(notes): add optional org visibility for notes"
```

---

### Task 5.2: Wire notes into `retrieveContext` (already exposed in Phase 1)

**Files:**
- Modify: `apps/api/src/lib/retrieve-context.ts` (the `notes` branch)

- [ ] **Step 1: Filter by visibility**

In the `notes` branch of `retrieveContext`, add:
```typescript
.where(
  and(
    eq(notes.org_id, params.org_id),
    eq(notes.is_deleted, false),
    or(
      eq(notes.user_id, params.user_id!),
      eq(notes.visibility, 'org'),
    ),
  ),
)
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(retrieve): respect note visibility in retrieveContext"
```

---

### Task 5.3: Add wiki/notes/decisions to the command palette

**Files:**
- Modify: `apps/web/src/components/command-palette.tsx`
- Modify: `apps/api/src/routes/search.ts` (check if it already exposes wiki/notes/decisions)

- [ ] **Step 1: Extend the search API**

`routes/search.ts` currently returns spaces/tasks/people/messages/tags. Add wiki (from wikiPages), notes (respecting visibility), and decisions (wiki pages of type='decision') as additional result groups.

The cleanest implementation: internally call `retrieveContext({ types: ['wiki', 'notes', 'decisions'], ... })` and merge with the existing spaces/tasks/people results.

- [ ] **Step 2: Extend the command palette renderer**

Add three new result group sections: "Knowledge", "Notes", "Decisions". Each row should deep-link:
- Knowledge → `/knowledge/:slug`
- Notes → `/notes?id=:id`
- Decisions → `/knowledge?type=decision#:slug`

- [ ] **Step 3: Add a Playwright test**

```typescript
await page.keyboard.press('Control+K');
await page.fill('input[type="search"]', 'billing');
await expect(page.locator('text=Knowledge').first()).toBeVisible();
await expect(page.locator('[data-group="wiki"]')).toContainText(/decision|concept/i);
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(command-palette): index wiki, notes, and decisions in global search"
```

---

### Task 5.4: Fix `FEATURES.md` doc drift

**Files:**
- Modify: `FEATURES.md`

- [ ] **Step 1: Correct the standup cadence**

Find the line claiming standup is "hourly" (per audit, around the §1 background workers table). Change to "daily at 9am local time per org."

- [ ] **Step 2: Correct the semantic search claim**

Find the line in §3 claiming semantic search works. Replace with: "Semantic search via pgvector + text-embedding-3-small (implemented 2026-04-16; requires `OPENAI_API_KEY`)."

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: fix standup cadence + semantic search accuracy in FEATURES.md"
```

---

### Task 5.5: Delete the `standup-check.ts` stub

**Files:**
- Delete: `apps/api/src/workers/handlers/standup-check.ts` (if it exists and is a stub, per the doc-vs-reality audit)
- Modify: `apps/api/src/workers/index.ts` (remove dispatcher entry)

- [ ] **Step 1: Verify stub status**

Read the file. If it's a TODO stub (as reported) and `standup-generate.ts` is the actual implementation doing the real work, delete the stub.

- [ ] **Step 2: Delete file + dispatcher case**

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: delete standup-check stub (real work is in standup-generate)"
```

---

### Task 5.6: Persist classifier output to `message_classifications`

**Files:**
- Modify: `packages/db/src/schema.ts` (add new table)
- Modify: `apps/api/src/routes/messages.ts:543-589` (persist before enqueuing)

- [ ] **Step 1: Add the schema**

```typescript
export const messageClassifications = pgTable('message_classifications', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  org_id: text('org_id').notNull(),
  message_id: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  intent: text('intent').notNull(),
  confidence: real('confidence').notNull(),
  agent_mention: boolean('agent_mention').notNull().default(false),
  blocked: boolean('blocked').notNull().default(false),
  task_references: text('task_references').array(),
  entities: jsonb('entities'),
  memorable_facts: text('memorable_facts').array(),
  decision: text('decision'),
  created_at: timestamp('created_at').notNull().defaultNow(),
}, (t) => ({
  orgMsgIdx: index('mc_org_msg_idx').on(t.org_id, t.message_id),
}));
```

- [ ] **Step 2: Generate migration**

```bash
pnpm --filter @deft/db drizzle-kit generate
```

- [ ] **Step 3: Insert the row after classification**

In the classify fire-and-forget block (`messages.ts:543-589`), after `classifyMessage` returns, insert a row into `messageClassifications` before the `task-extract`/`memory-extract` enqueues.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(classifier): persist classification output to message_classifications"
```

---

### Task 5.7: Delete `packages/ai` stub

**Files:**
- Delete: `packages/ai/` (entire directory if confirmed as 2-line stub with zero imports)
- Modify: `pnpm-workspace.yaml` (remove package entry)
- Modify: `CLAUDE.md` (remove the `packages/ai` reference from the architecture diagram)

- [ ] **Step 1: Verify zero imports**

Run: `grep -rn "@deft/ai" .`
Expected output: zero matches.

- [ ] **Step 2: Delete directory + update CLAUDE.md**

Replace the CLAUDE.md architecture block's `packages/ai/` line with a note: "Agent engine implementation lives in `apps/api/src/lib/` (agent-context, agent-plans, agent-tools, classifier, agent-stream-loop). packages/ai was deprecated in Task 5.7."

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: delete unused packages/ai stub; update CLAUDE.md"
```

---

## Self-review

**Spec coverage check:**
- ✅ embed-content stub → Task 0.1
- ✅ wiki-lint cron bootstrap → Task 0.4
- ✅ create_plan tool handler → Task 0.5
- ✅ Unified retrieveContext gateway → Tasks 1.1-1.5
- ✅ Hybrid FTS + vector ranking → Task 1.2
- ✅ agentMemory dual-write → Task 2.2
- ✅ decisions dual-write → Task 2.3
- ✅ oneone-prep migration → Task 2.1
- ✅ is_reversed → confidence sync → Task 2.3 Step 5
- ✅ Legacy table deprecation → Task 2.4
- ✅ In-chat panel unification → Tasks 3.1-3.2
- ✅ Decisions UI → Task 3.3
- ✅ Burnout authorship signal → Task 4.1
- ✅ Burnout stalled commitment signal → Task 4.2
- ✅ People graph wiki authorship → Task 4.3
- ✅ People graph citations → Task 4.4
- ✅ tension/delegation_chain/cross_team_bridge → Task 4.5
- ✅ notes.org visibility → Task 5.1
- ✅ retrieveContext notes branch → Task 5.2
- ✅ Command palette knowledge search → Task 5.3
- ✅ Doc drift → Task 5.4
- ✅ standup-check stub → Task 5.5
- ✅ Classifier persistence → Task 5.6
- ✅ packages/ai stub → Task 5.7

**Out-of-scope confirmations** (intentionally NOT in this plan):
- Manager dashboard page, people directory page → Roadmap Phase 2
- Privacy/Terms, rate limiting, security headers → M2 readiness TODO
- Voyage fallback provider → deferred; OpenAI is sufficient for trusted tester cohort
- cross-references worker extension to wiki↔wiki → not critical, defer

**Type consistency:**
- `ContextResult.source_type` values: `'wiki_page' | 'agent_memory' | 'note' | 'decision'` — consistent across Task 1.1, 1.3, 1.4, 1.5
- `RetrieveContextParams.types` values: `'wiki' | 'memory' | 'notes' | 'decisions'` — consistent throughout
- `relationship_type` enum: extended with `'knowledge_dependency'` in Task 4.4, implementations for `'tension' | 'delegation_chain' | 'cross_team_bridge'` in Task 4.5
- `wikiPages.tags` + `wikiPages.referenced_user_ids` columns added in Task 2.1 — used by Tasks 4.1, 4.2, 4.3, 4.4, 5.2

**Known risk: `wikiPages.space_id` column**
Task 3.1 assumes this column exists. If it doesn't, Task 3.1 Step 1 adds it — but this should be flagged to the implementer up front. Check `packages/db/src/schema.ts:1048-1070` first; if absent, add it in a preliminary step before Phase 3.

**Known risk: OpenAI budget**
`text-embedding-3-small` is $0.02 per 1M tokens. Assuming 10k wiki pages × 1k tokens each = 10M tokens = $0.20 for backfill. Monthly ingest rate at 200 pages/day ≈ $0.12/month. Negligible but worth noting in Task 0.3.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-16-knowledge-unification.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Fresh implementer subagent per task + two-stage review (spec + code quality). Fast iteration, no context switch.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for your review.

**Recommended order:**
- **Phase 0 is urgent and isolated** — ship it standalone (5 tasks, ~1 day of focused work). It fixes 3 real bugs and unblocks everything downstream. Can be a single PR.
- **Phase 1 follows immediately** — 5 tasks, unlocks the retrieval spine.
- **Phase 2 is a cleanup phase** — can run in parallel with UI work in Phase 3 if two people/sessions are available. Retires legacy tables.
- **Phase 3, 4, 5** build sequentially on 1 and 2.

**Before starting:**
1. Confirm `OPENAI_API_KEY` is available in `.env` and Railway env vars (required by Task 0.1, 1.2)
2. Verify `wikiPages.space_id` column state (Task 3.1 risk)
3. Run the current audit `docs/superpowers/audits/gap-fixes.audit.ts` to confirm baseline green before touching anything

Which approach?

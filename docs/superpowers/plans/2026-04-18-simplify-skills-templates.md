# Simplify skills + templates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the overloaded `skills` primitive into agent-only capability bundles; make templates a first-class standalone catalog; strip per-project customization so every project uses fixed Engineering defaults; simplify the project-create modal to 1 step and the agent-create wizard from 5 to 3 steps.

**Architecture:** Additive-then-destructive migration. Phase 1 adds the new `task_templates` table and hardcoded defaults alongside the existing `project_skills` / `skills.project_config` machinery. Phase 2 flips all consumers to the new sources. Phase 3 ships the UI simplifications. Phase 4 drops the old tables/columns/types. Phase 5 verifies end-to-end.

**Tech Stack:** TypeScript strict mode, Drizzle ORM, PostgreSQL with raw SQL migrations in `packages/db/drizzle/`, Hono API routes, Next.js 14 App Router, Node 18+ test runner (`tsx --test`), Playwright for UI verification.

**Source spec:** `docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md`

---

## Pre-flight

### Task 0: Verify starting state

**Files:**
- Read: `packages/db/src/schema.ts`
- Read: `apps/api/src/lib/project-resolved-config.ts`
- Read: `apps/api/src/lib/bundled-skills.ts`
- Read: `apps/api/src/routes/task-templates.ts`
- Read: `apps/web/src/components/create-project-modal.tsx`

- [ ] **Step 1: Run the test suite to establish a green baseline**

Run: `pnpm --filter @deft/api test`
Expected: all existing tests pass. If anything is already red, fix or skip that test before touching anything else. Do not start implementation on top of red tests.

- [ ] **Step 2: Check dev DB is reachable**

Run: `pnpm --filter @deft/db studio &`
Expected: opens studio on localhost. Connect, confirm `skills`, `project_skills`, `agent_employee_skills`, `tasks` tables exist. Kill studio.

- [ ] **Step 3: Record current migration number**

Run: `ls packages/db/drizzle/ | grep -E '^[0-9]{4}_' | sort | tail -5`
Expected: `0044_agent_heartbeat_turns.sql` is the latest. All new migrations in this plan start at `0045`.

---

## Phase 1 — Additive foundation

No existing code changes. The new `task_templates` table + bundled templates + hardcoded engineering constants live alongside the old system.

### Task 1: Add `task_templates` table and Drizzle schema entry

**Files:**
- Create: `packages/db/drizzle/0045_task_templates_table.sql`
- Modify: `packages/db/src/schema.ts` (add declaration near `skills`)

- [ ] **Step 1: Write the migration SQL**

Create `packages/db/drizzle/0045_task_templates_table.sql`:

```sql
-- Task templates — first-class catalog, not nested in skills.
-- source='bundled' rows have org_id IS NULL (cross-tenant).
-- source='org' rows have a real org_id.
-- 'marketplace' is reserved; no code path uses it yet.

CREATE TABLE IF NOT EXISTS task_templates (
  id              text PRIMARY KEY,
  org_id          text,
  name            text NOT NULL,
  description     text,
  icon            text,
  slug            text NOT NULL,
  source          text NOT NULL CHECK (source IN ('bundled', 'marketplace', 'org')),
  version         text NOT NULL DEFAULT '1.0.0',
  tasks           jsonb NOT NULL,
  created_by      text REFERENCES users(id),
  is_deleted      boolean NOT NULL DEFAULT false,
  usage_count     integer NOT NULL DEFAULT 0,
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);

-- Same partial-unique-index trick the skills table uses so bundled rows
-- (org_id NULL) collide correctly on re-seed.
CREATE UNIQUE INDEX IF NOT EXISTS task_templates_source_org_slug_idx
  ON task_templates (source, COALESCE(org_id, ''), slug)
  WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS task_templates_org_idx ON task_templates (org_id);
CREATE INDEX IF NOT EXISTS task_templates_source_idx ON task_templates (source);
```

- [ ] **Step 2: Add the Drizzle schema declaration**

In `packages/db/src/schema.ts`, immediately after the `skills` table block (near line 521), add:

```typescript
// ═══ TASK TEMPLATES ═══
// First-class catalog. Not nested in skills. Bundled rows live cross-tenant
// (org_id NULL); org rows have a real org_id. Instantiated into a project
// via POST /api/projects/:id/apply-template.
export const taskTemplates = pgTable('task_templates', {
  ...id(),
  org_id: text('org_id'),
  name: text('name').notNull(),
  description: text('description'),
  icon: text('icon'),
  slug: text('slug').notNull(),
  source: text('source').$type<'bundled' | 'marketplace' | 'org'>().default('org').notNull(),
  version: text('version').default('1.0.0').notNull(),
  tasks: jsonb('tasks').notNull(),
  created_by: text('created_by').references(() => users.id),
  is_deleted: boolean('is_deleted').default(false).notNull(),
  usage_count: integer('usage_count').default(0).notNull(),
  ...timestamps(),
}, (t) => [
  uniqueIndex('task_templates_source_org_slug_idx').on(t.source, t.org_id, t.slug),
  index('task_templates_org_idx').on(t.org_id),
  index('task_templates_source_idx').on(t.source),
]);
```

- [ ] **Step 3: Apply the migration locally**

Run: `psql $DATABASE_URL -f packages/db/drizzle/0045_task_templates_table.sql`
Expected: `CREATE TABLE`, `CREATE UNIQUE INDEX`, `CREATE INDEX` x2, no errors.

- [ ] **Step 4: Verify the table exists**

Run: `psql $DATABASE_URL -c "\d task_templates"`
Expected: table listing with 12 columns, 3 indexes.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @deft/db typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/drizzle/0045_task_templates_table.sql packages/db/src/schema.ts
git commit -m "feat(db): add task_templates table as first-class catalog"
```

---

### Task 2: Ship bundled templates + seeder

**Files:**
- Create: `apps/api/src/lib/bundled-templates.ts`
- Create: `apps/api/src/scripts/seed-bundled-templates.ts`
- Test: `apps/api/test/bundled-templates-seed.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/bundled-templates-seed.test.ts`:

```typescript
/**
 * Structure test — the bundled-templates array has exactly the templates
 * the spec calls for, each with a non-empty tasks array.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_TEMPLATES } from '../src/lib/bundled-templates.js';

test('BUNDLED_TEMPLATES ships launch-campaign and re-engage-sequence', () => {
  const slugs = BUNDLED_TEMPLATES.map((t) => t.slug).sort();
  assert.deepEqual(slugs, ['launch-campaign', 're-engage-sequence']);
});

test('every bundled template has a non-empty tasks array', () => {
  for (const tpl of BUNDLED_TEMPLATES) {
    assert.ok(Array.isArray(tpl.tasks), `${tpl.slug} tasks must be array`);
    assert.ok(tpl.tasks.length > 0, `${tpl.slug} tasks must be non-empty`);
    for (const t of tpl.tasks) {
      assert.ok(typeof t.title === 'string' && t.title.length > 0, `${tpl.slug}: task title required`);
    }
  }
});

test('launch-campaign has exactly 7 tasks', () => {
  const tpl = BUNDLED_TEMPLATES.find((t) => t.slug === 'launch-campaign');
  assert.ok(tpl);
  assert.equal(tpl.tasks.length, 7);
});

test('re-engage-sequence has exactly 14 tasks', () => {
  const tpl = BUNDLED_TEMPLATES.find((t) => t.slug === 're-engage-sequence');
  assert.ok(tpl);
  assert.equal(tpl.tasks.length, 14);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @deft/api exec tsx --test test/bundled-templates-seed.test.ts`
Expected: FAIL — "Cannot find module '../src/lib/bundled-templates.js'".

- [ ] **Step 3: Write `bundled-templates.ts`**

Create `apps/api/src/lib/bundled-templates.ts`:

```typescript
/**
 * First-class bundled task templates. Replaces the nested `task_templates`
 * jsonb that previously lived inside `skills.project_config`.
 *
 * Re-extracted from the former Marketing Campaign and Sales Pipeline
 * bundled skills so day-one users still get the same starting bundles
 * they had before the simplification.
 */

export type TemplateTask = {
  title: string;
  status?: string;        // defaults to 'todo' at apply time
  priority?: string;      // defaults to 'p2' at apply time
  due_offset_days?: number;
  description?: string;
  labels?: string[];
};

export type BundledTemplate = {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  version: string;
  tasks: TemplateTask[];
};

const DEFAULT_VERSION = '1.0.0';

const launchCampaign: BundledTemplate = {
  id: 'template_bundled_launch-campaign',
  slug: 'launch-campaign',
  name: 'Launch Campaign',
  description:
    '7-task marketing launch bundle: brief, assets, announcement copy, social teasers, day-of blast, follow-up, retro.',
  icon: null,
  version: DEFAULT_VERSION,
  tasks: [
    { title: 'Draft launch brief', due_offset_days: 0 },
    { title: 'Design launch assets', due_offset_days: 3 },
    { title: 'Write announcement copy', due_offset_days: 4 },
    { title: 'Schedule social teasers', due_offset_days: 5 },
    { title: 'Publish launch announcement', due_offset_days: 7 },
    { title: 'Send follow-up newsletter', due_offset_days: 9 },
    { title: 'Launch retrospective', due_offset_days: 14 },
  ],
};

const reEngageSequence: BundledTemplate = {
  id: 'template_bundled_re-engage-sequence',
  slug: 're-engage-sequence',
  name: 'Re-engage Sequence',
  description:
    '14-day cadence for warming up cold deals: outreach touches, personalized follow-ups, hand-off checkpoints.',
  icon: null,
  version: DEFAULT_VERSION,
  tasks: [
    { title: 'Research account history', due_offset_days: 0 },
    { title: 'Send initial re-engage email', due_offset_days: 1 },
    { title: 'LinkedIn touch', due_offset_days: 2 },
    { title: 'Follow-up email with value offer', due_offset_days: 4 },
    { title: 'Phone call attempt', due_offset_days: 5 },
    { title: 'Share relevant case study', due_offset_days: 6 },
    { title: 'Loop in champion / exec sponsor', due_offset_days: 7 },
    { title: 'Second phone attempt', due_offset_days: 9 },
    { title: 'Personalized video message', due_offset_days: 10 },
    { title: 'Final email — breakup note', due_offset_days: 12 },
    { title: 'Log disposition + notes', due_offset_days: 13 },
    { title: 'Hand off to AE or archive', due_offset_days: 14 },
    { title: 'Schedule 30-day re-touch', due_offset_days: 14 },
    { title: 'Write retro / what worked', due_offset_days: 14 },
  ],
};

export const BUNDLED_TEMPLATES: BundledTemplate[] = [launchCampaign, reEngageSequence];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @deft/api exec tsx --test test/bundled-templates-seed.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Write the seeder script**

Create `apps/api/src/scripts/seed-bundled-templates.ts`:

```typescript
/**
 * Idempotent seeder for bundled task templates. Re-run on deploy; upserts
 * by (source, COALESCE(org_id,''), slug).
 *
 *   pnpm tsx apps/api/src/scripts/seed-bundled-templates.ts
 */
import { fileURLToPath } from 'node:url';
import { db } from '../lib/db.js';
import { sql } from 'drizzle-orm';
import { BUNDLED_TEMPLATES } from '../lib/bundled-templates.js';

export async function seedBundledTemplates(
  opts: { silent?: boolean } = {},
): Promise<number> {
  const log = (msg: string) => {
    if (!opts.silent) console.log(msg);
  };
  log(`[seed-bundled-templates] Upserting ${BUNDLED_TEMPLATES.length} bundled templates`);

  for (const tpl of BUNDLED_TEMPLATES) {
    await db.execute(sql`
      INSERT INTO task_templates (
        id, org_id, source, slug, name, description, icon, version, tasks, is_deleted, usage_count
      ) VALUES (
        ${tpl.id},
        NULL,
        'bundled',
        ${tpl.slug},
        ${tpl.name},
        ${tpl.description},
        ${tpl.icon},
        ${tpl.version},
        ${JSON.stringify(tpl.tasks)}::jsonb,
        false,
        0
      )
      ON CONFLICT (source, (COALESCE(org_id,'')), slug) WHERE is_deleted = false
      DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        icon = EXCLUDED.icon,
        version = EXCLUDED.version,
        tasks = EXCLUDED.tasks,
        updated_at = now()
    `);
  }
  log(`[seed-bundled-templates] Done`);
  return BUNDLED_TEMPLATES.length;
}

const isMain = (() => {
  try { return fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();
if (isMain) {
  seedBundledTemplates().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 6: Run the seeder against dev DB**

Run: `pnpm tsx apps/api/src/scripts/seed-bundled-templates.ts`
Expected: `Upserting 2 bundled templates` then `Done`. No errors.

- [ ] **Step 7: Verify rows inserted**

Run: `psql $DATABASE_URL -c "SELECT slug, jsonb_array_length(tasks) AS task_count FROM task_templates WHERE source='bundled';"`
Expected: `launch-campaign | 7`, `re-engage-sequence | 14`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/bundled-templates.ts apps/api/src/scripts/seed-bundled-templates.ts apps/api/test/bundled-templates-seed.test.ts
git commit -m "feat(templates): ship launch-campaign + re-engage-sequence bundled templates"
```

---

### Task 3: Add list/get endpoints for task templates

**Files:**
- Modify: `apps/api/src/routes/task-templates.ts` (prepend GET routes)
- Test: `apps/api/test/task-templates-list.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/task-templates-list.test.ts`:

```typescript
/**
 * Shape test for the new list/get endpoints. Exercises route wiring
 * without hitting an actual DB — the route handlers are mocked against
 * a Hono app built in-process.
 *
 * Uses the existing test harness pattern: seed test org via seed-test-org.ts,
 * issue an authenticated request, assert the JSON shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/index.js';

// Helper assumes the dev seed ran — maneek@test.com / test1234.
async function authHeaders(): Promise<Record<string, string>> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
    headers: { 'content-type': 'application/json' },
  });
  const body = (await res.json()) as { accessToken: string };
  return { authorization: `Bearer ${body.accessToken}` };
}

test('GET /api/task-templates returns bundled + org templates', async () => {
  const headers = await authHeaders();
  const res = await app.request('/api/task-templates', { headers });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { templates: Array<{ slug: string; source: string }> };
  assert.ok(Array.isArray(body.templates));
  const slugs = body.templates.map((t) => t.slug).sort();
  assert.ok(slugs.includes('launch-campaign'));
  assert.ok(slugs.includes('re-engage-sequence'));
});

test('GET /api/task-templates/:id returns one template', async () => {
  const headers = await authHeaders();
  const listRes = await app.request('/api/task-templates', { headers });
  const { templates } = (await listRes.json()) as { templates: Array<{ id: string; slug: string }> };
  const launch = templates.find((t) => t.slug === 'launch-campaign');
  assert.ok(launch, 'launch-campaign should exist');

  const getRes = await app.request(`/api/task-templates/${launch.id}`, { headers });
  assert.equal(getRes.status, 200);
  const body = (await getRes.json()) as { template: { slug: string; tasks: unknown[] } };
  assert.equal(body.template.slug, 'launch-campaign');
  assert.equal(body.template.tasks.length, 7);
});

test('GET /api/task-templates/:id with unknown id returns 404', async () => {
  const headers = await authHeaders();
  const res = await app.request('/api/task-templates/template_does_not_exist', { headers });
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @deft/api exec tsx --test test/task-templates-list.test.ts`
Expected: FAIL — routes don't exist yet (404 on every request, or status mismatch).

- [ ] **Step 3: Add the GET routes**

In `apps/api/src/routes/task-templates.ts`, add these two handlers BEFORE the existing `POST /:id/apply-template` handler:

```typescript
import { or, isNull } from 'drizzle-orm';
import { taskTemplates } from '@deft/db/schema';

// GET /api/task-templates — list bundled + org templates for this tenant.
taskTemplateRoutes.get('/', async (c) => {
  try {
    const user = c.get('user') as { id: string; org_id: string };
    const rows = await db
      .select()
      .from(taskTemplates)
      .where(
        and(
          eq(taskTemplates.is_deleted, false),
          or(
            isNull(taskTemplates.org_id),                  // bundled + marketplace
            eq(taskTemplates.org_id, user.org_id),         // this tenant's custom
          ),
        ),
      );
    return c.json({ templates: rows });
  } catch (err) {
    console.error('Failed to list task templates:', err);
    return c.json({ error: 'Failed to list templates', code: 'INTERNAL_ERROR' }, 500);
  }
});

// GET /api/task-templates/:id — fetch one, with org-scoping.
taskTemplateRoutes.get('/:id', async (c) => {
  try {
    const user = c.get('user') as { id: string; org_id: string };
    const id = c.req.param('id');
    const [row] = await db
      .select()
      .from(taskTemplates)
      .where(
        and(
          eq(taskTemplates.id, id),
          eq(taskTemplates.is_deleted, false),
          or(
            isNull(taskTemplates.org_id),
            eq(taskTemplates.org_id, user.org_id),
          ),
        ),
      )
      .limit(1);
    if (!row) {
      return c.json({ error: 'Template not found', code: 'NOT_FOUND' }, 404);
    }
    return c.json({ template: row });
  } catch (err) {
    console.error('Failed to get task template:', err);
    return c.json({ error: 'Failed to get template', code: 'INTERNAL_ERROR' }, 500);
  }
});
```

- [ ] **Step 4: Confirm router is mounted under `/api/task-templates`**

Run: `grep -n "task-templates\|taskTemplateRoutes" apps/api/src/index.ts`
Expected: an existing mount. If the current mount is under `/api/projects` (because the route file originally only held the apply-template POST), add a second mount: `app.route('/api/task-templates', taskTemplateRoutes)`. Both routes can share the same Hono instance because paths don't collide.

If the existing mount conflicts (e.g. GET `/` on projects prefix would shadow project list), create a dedicated sub-router:

```typescript
// In task-templates.ts — export two routers
export const taskTemplateRoutes = new Hono();         // for /api/task-templates
export const projectTemplateRoutes = new Hono();      // for /api/projects/:id/apply-template
// and move the POST /:id/apply-template onto projectTemplateRoutes.
```

Then mount accordingly in `index.ts`. Decide based on what the current `grep` shows.

- [ ] **Step 5: Run the tests to verify pass**

Run: `pnpm --filter @deft/api exec tsx --test test/task-templates-list.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/task-templates.ts apps/api/src/index.ts apps/api/test/task-templates-list.test.ts
git commit -m "feat(api): add GET /api/task-templates list + detail endpoints"
```

---

### Task 4: Export hardcoded engineering defaults

**Files:**
- Modify: `apps/api/src/lib/task-status-machine.ts`
- Test: `apps/api/test/engineering-defaults.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/engineering-defaults.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENGINEERING_STATUSES,
  ENGINEERING_TRANSITIONS,
  ENGINEERING_PRIORITY_VOCAB,
  ENGINEERING_DEFAULTS,
  isValidTransition,
} from '../src/lib/task-status-machine.js';

test('ENGINEERING_STATUSES has the 6 expected ids in order', () => {
  const ids = ENGINEERING_STATUSES.map((s) => s.id);
  assert.deepEqual(ids, ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled']);
});

test('ENGINEERING_PRIORITY_VOCAB is p0..p3 numbered', () => {
  assert.equal(ENGINEERING_PRIORITY_VOCAB.kind, 'numbered');
  assert.deepEqual(ENGINEERING_PRIORITY_VOCAB.labels, ['p0', 'p1', 'p2', 'p3']);
});

test('isValidTransition still accepts legal engineering transitions', () => {
  assert.equal(isValidTransition('backlog', 'todo', ENGINEERING_DEFAULTS), true);
  assert.equal(isValidTransition('todo', 'in_progress', ENGINEERING_DEFAULTS), true);
  assert.equal(isValidTransition('in_progress', 'done', ENGINEERING_DEFAULTS), true);
  assert.equal(isValidTransition('done', 'backlog', ENGINEERING_DEFAULTS), true);
});

test('isValidTransition rejects illegal transitions', () => {
  // done -> todo isn't in the allowed list
  assert.equal(isValidTransition('done', 'todo', ENGINEERING_DEFAULTS), false);
  // backlog -> in_review skips stages
  assert.equal(isValidTransition('backlog', 'in_review', ENGINEERING_DEFAULTS), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @deft/api exec tsx --test test/engineering-defaults.test.ts`
Expected: FAIL — constants don't export yet.

- [ ] **Step 3: Extend `task-status-machine.ts`**

Replace the entire file at `apps/api/src/lib/task-status-machine.ts` with:

```typescript
/**
 * Canonical status vocabulary, transition graph, and priority vocabulary
 * for every project. Previously driven by skills.project_config via
 * project-resolved-config.ts; now hardcoded after the Phase-4-reversal
 * simplification (see docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md).
 *
 * If per-project customization is ever re-introduced, these constants are
 * the thing that becomes configurable.
 */
export type StatusId = string;

export type ProjectResolvedConfig = {
  statuses: { id: StatusId; label: string; color: string; order: number }[];
  allowed_transitions: Record<StatusId, StatusId[]> | null;
};

export const ENGINEERING_STATUSES: ProjectResolvedConfig['statuses'] = [
  { id: 'backlog', label: 'Backlog', color: '#6b7280', order: 0 },
  { id: 'todo', label: 'To Do', color: '#3b82f6', order: 1 },
  { id: 'in_progress', label: 'In Progress', color: '#f59e0b', order: 2 },
  { id: 'in_review', label: 'In Review', color: '#8b5cf6', order: 3 },
  { id: 'done', label: 'Done', color: '#10b981', order: 4 },
  { id: 'cancelled', label: 'Cancelled', color: '#ef4444', order: 5 },
];

export const ENGINEERING_TRANSITIONS: Record<StatusId, StatusId[]> = {
  backlog: ['todo', 'in_progress', 'cancelled'],
  todo: ['in_progress', 'backlog', 'cancelled'],
  in_progress: ['in_review', 'done', 'backlog', 'cancelled'],
  in_review: ['in_progress', 'done', 'cancelled'],
  done: ['in_progress', 'backlog'],
  cancelled: ['backlog'],
};

export const ENGINEERING_PRIORITY_VOCAB = {
  kind: 'numbered' as const,
  labels: ['p0', 'p1', 'p2', 'p3'],
};

export const ENGINEERING_DEFAULTS: ProjectResolvedConfig = {
  statuses: ENGINEERING_STATUSES,
  allowed_transitions: ENGINEERING_TRANSITIONS,
};

export function isValidTransition(
  from: StatusId,
  to: StatusId,
  projectResolvedConfig: ProjectResolvedConfig,
): boolean {
  const statusIds = new Set(projectResolvedConfig.statuses.map((s) => s.id));
  if (!statusIds.has(to)) return false;
  if (from === to) return true;
  if (projectResolvedConfig.allowed_transitions) {
    const allowed = projectResolvedConfig.allowed_transitions[from];
    if (!allowed) return false;
    return allowed.includes(to);
  }
  return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @deft/api exec tsx --test test/engineering-defaults.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/task-status-machine.ts apps/api/test/engineering-defaults.test.ts
git commit -m "feat(status): hardcode engineering defaults + transitions as exported constants"
```

---

## Phase 2 — Flip consumers to the new sources

Old `project_skills` / `skills.project_config` still exist but nothing reads from them after this phase.

### Task 5: Collapse `getProjectResolvedConfig` to return hardcoded defaults

**Files:**
- Modify: `apps/api/src/lib/project-resolved-config.ts`
- Test: `apps/api/test/project-resolved-config-hardcoded.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/project-resolved-config-hardcoded.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProjectResolvedConfig } from '../src/lib/project-resolved-config.js';
import { ENGINEERING_STATUSES, ENGINEERING_TRANSITIONS } from '../src/lib/task-status-machine.js';

test('getProjectResolvedConfig returns engineering defaults regardless of project id', async () => {
  const resolved = await getProjectResolvedConfig('any-project-id-even-nonexistent');
  assert.deepEqual(resolved.statuses, ENGINEERING_STATUSES);
  assert.deepEqual(resolved.allowed_transitions, ENGINEERING_TRANSITIONS);
  assert.equal(resolved.default_view, 'board');
  assert.deepEqual(resolved.custom_fields, []);
  assert.deepEqual(resolved.task_templates, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @deft/api exec tsx --test test/project-resolved-config-hardcoded.test.ts`
Expected: FAIL (current implementation reads project_skills from DB — even if it returns engineering, the test may pass accidentally; force a real check by using a fake project_id that has no attached skills and confirming we get the hardcoded defaults).

- [ ] **Step 3: Replace the whole file**

Overwrite `apps/api/src/lib/project-resolved-config.ts` with:

```typescript
/**
 * Collapsed resolver — always returns engineering defaults.
 *
 * Previously read `project_skills` and merged `skills.project_config`
 * jsonb. That machinery retired in the Phase-4-reversal simplification;
 * per-project customization is a non-goal. See
 * docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md.
 *
 * Kept as a function (not a constant) so existing async callers don't
 * need signature changes. Invalidate / cache helpers are no-ops retained
 * for API compatibility.
 */
import {
  ENGINEERING_STATUSES,
  ENGINEERING_TRANSITIONS,
  ENGINEERING_PRIORITY_VOCAB,
  type ProjectResolvedConfig as BaseProjectResolvedConfig,
} from './task-status-machine.js';

export type ProjectResolvedConfig = BaseProjectResolvedConfig & {
  priority_vocab: typeof ENGINEERING_PRIORITY_VOCAB;
  default_view: 'board' | 'list' | 'calendar' | 'pipeline' | 'timeline';
  hide_prefix_ids: boolean;
  custom_fields: never[];
  task_templates: never[];
};

const RESOLVED: ProjectResolvedConfig = {
  statuses: ENGINEERING_STATUSES,
  allowed_transitions: ENGINEERING_TRANSITIONS,
  priority_vocab: ENGINEERING_PRIORITY_VOCAB,
  default_view: 'board',
  hide_prefix_ids: false,
  custom_fields: [],
  task_templates: [],
};

export async function getProjectResolvedConfig(
  _projectId: string,
): Promise<ProjectResolvedConfig> {
  return RESOLVED;
}

export function invalidateProjectResolvedConfig(_projectId: string): void {
  // No-op. Kept for call-site compatibility.
}

export function _clearProjectResolvedConfigCache(): void {
  // No-op. Kept for call-site compatibility.
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @deft/api exec tsx --test test/project-resolved-config-hardcoded.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck the API**

Run: `pnpm --filter @deft/api typecheck`
Expected: PASS. If any caller used the removed `SkillProjectConfig` types, fix by importing from the new file or replacing with the concrete narrowed types.

- [ ] **Step 6: Run the full API test suite**

Run: `pnpm --filter @deft/api test`
Expected: PASS. Any test that was asserting merged-from-skills behavior may now fail — those tests described the old behavior and should be deleted or rewritten to reflect the hardcoded semantics.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/project-resolved-config.ts apps/api/test/project-resolved-config-hardcoded.test.ts
git commit -m "refactor(resolver): collapse project-resolved-config to hardcoded engineering defaults"
```

---

### Task 6: Rewrite `apply-template` endpoint to read from `task_templates`

**Files:**
- Modify: `apps/api/src/routes/task-templates.ts` (the POST handler)
- Test: `apps/api/test/apply-template-from-table.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/apply-template-from-table.test.ts`:

```typescript
/**
 * Integration test — POST /api/projects/:id/apply-template reads the template
 * from the task_templates table (not from skill config), creates the tasks,
 * and returns the created task list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/index.js';

async function authHeaders() {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'maneek@test.com', password: 'test1234' }),
    headers: { 'content-type': 'application/json' },
  });
  const body = (await res.json()) as { accessToken: string };
  return {
    authorization: `Bearer ${body.accessToken}`,
    'content-type': 'application/json',
  };
}

test('POST /api/projects/:id/apply-template instantiates launch-campaign tasks', async () => {
  const headers = await authHeaders();

  // Create a throwaway project.
  const createRes = await app.request('/api/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'test-apply-template',
      prefix: 'TAT',
    }),
  });
  assert.equal(createRes.status, 201);
  const { project } = (await createRes.json()) as { project: { id: string } };

  // Apply the launch-campaign bundled template.
  const applyRes = await app.request(`/api/projects/${project.id}/apply-template`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ template_id: 'template_bundled_launch-campaign' }),
  });
  assert.equal(applyRes.status, 201);
  const body = (await applyRes.json()) as { count: number; tasks: Array<{ title: string }> };
  assert.equal(body.count, 7);
  assert.ok(body.tasks.some((t) => t.title === 'Draft launch brief'));
});

test('POST /api/projects/:id/apply-template with missing template returns 404', async () => {
  const headers = await authHeaders();
  const createRes = await app.request('/api/projects', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'test-apply-template-2', prefix: 'TAT2' }),
  });
  const { project } = (await createRes.json()) as { project: { id: string } };

  const res = await app.request(`/api/projects/${project.id}/apply-template`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ template_id: 'template_does_not_exist' }),
  });
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @deft/api exec tsx --test test/apply-template-from-table.test.ts`
Expected: FAIL — current endpoint reads from skill config, returns 404 because no skill attaches the bundled template id.

- [ ] **Step 3: Rewrite the POST handler**

In `apps/api/src/routes/task-templates.ts`, replace the existing POST `/:id/apply-template` handler body. Replace the template-resolution block (the `getProjectResolvedConfig` + `find(t => t.id === parsed.data.template_id)` lines) with a direct table query, and swap `t.due_date` for `t.due_offset_days`:

```typescript
// POST /api/projects/:id/apply-template
taskTemplateRoutes.post('/:id/apply-template', async (c) => {
  try {
    const user = c.get('user') as { id: string; org_id: string };
    const projectId = c.req.param('id');
    const body = await c.req.json().catch(() => null);
    const parsed = applyTemplateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid input', code: 'VALIDATION_ERROR' }, 400);
    }

    // Verify org ownership of the project.
    const [project] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.org_id, user.org_id)))
      .limit(1);
    if (!project) {
      return c.json({ error: 'Project not found', code: 'NOT_FOUND' }, 404);
    }

    // Fetch the template from the task_templates table, org-scoped
    // (bundled rows have org_id NULL; tenant rows match user.org_id).
    const [template] = await db
      .select()
      .from(taskTemplates)
      .where(
        and(
          eq(taskTemplates.id, parsed.data.template_id),
          eq(taskTemplates.is_deleted, false),
          or(
            isNull(taskTemplates.org_id),
            eq(taskTemplates.org_id, user.org_id),
          ),
        ),
      )
      .limit(1);
    if (!template) {
      return c.json({ error: 'Template not found', code: 'NOT_FOUND' }, 404);
    }
    const tasksPayload = template.tasks as Array<{
      title: string;
      status?: string;
      priority?: string;
      due_offset_days?: number;
      description?: string;
      labels?: string[];
    }>;
    if (!Array.isArray(tasksPayload) || tasksPayload.length === 0) {
      return c.json({ error: 'Template has no tasks', code: 'VALIDATION_ERROR' }, 400);
    }

    const applyDate = new Date();
    const createdTasks = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(projects)
        .set({
          task_counter: (project.task_counter as number) + tasksPayload.length,
        })
        .where(eq(projects.id, projectId))
        .returning({ task_counter: projects.task_counter });

      const finalCounter = updated!.task_counter as number;
      const firstNumber = finalCounter - tasksPayload.length + 1;

      const rowsToInsert = tasksPayload.map((t, idx) => {
        let dueDate: Date | undefined = undefined;
        if (typeof t.due_offset_days === 'number') {
          const d = new Date(applyDate);
          d.setDate(d.getDate() + t.due_offset_days);
          dueDate = d;
        }
        return {
          org_id: user.org_id,
          project_id: projectId,
          number: firstNumber + idx,
          title: t.title,
          description: t.description,
          status: (t.status || 'backlog') as any,
          priority: (t.priority || 'p2') as any,
          created_by: user.id,
          due_date: dueDate,
          sort_order: (idx + 1) * 1000,
        };
      });

      const inserted = await tx.insert(tasks).values(rowsToInsert).returning();

      if (inserted.length > 0) {
        await tx.insert(taskActivity).values(
          inserted.map((row) => ({
            org_id: user.org_id,
            task_id: row.id,
            user_id: user.id,
            action: 'created',
            field: 'template',
            old_value: null,
            new_value: template.id,
          })),
        );
      }

      // Bump usage_count on the template row.
      await tx
        .update(taskTemplates)
        .set({ usage_count: (template.usage_count as number) + 1 })
        .where(eq(taskTemplates.id, template.id));

      return inserted;
    });

    const io = getIO();
    if (io) {
      for (const task of createdTasks) {
        io.to(`org:${user.org_id}`).emit('task:created', {
          ...task,
          project_prefix: project.prefix,
          project_name: project.name,
        });
      }
    }

    return c.json(
      {
        template_id: template.id,
        count: createdTasks.length,
        tasks: createdTasks.map((t) => ({
          id: t.id,
          number: t.number,
          title: t.title,
          status: t.status,
          due_date: t.due_date,
        })),
      },
      201,
    );
  } catch (err) {
    console.error('Failed to apply template:', err);
    return c.json({ error: 'Failed to apply template', code: 'INTERNAL_ERROR' }, 500);
  }
});
```

Remove the top-of-file imports of `getProjectResolvedConfig`. Add (if not already present from Task 3): `import { taskTemplates } from '@deft/db/schema';` and `import { or, isNull } from 'drizzle-orm';`.

- [ ] **Step 4: Remove the now-unused `resolveTemplateDueDate`**

Delete the `resolveTemplateDueDate` export from `task-templates.ts`. Update `apply-template-dueDate.test.ts` to either delete it entirely OR rewrite it to cover the new inline due-offset-days logic as a unit test. Simplest: delete `apps/api/test/apply-template-dueDate.test.ts` since `due_offset_days` is a plain number (no parsing edge cases).

Run: `rm apps/api/test/apply-template-dueDate.test.ts`

- [ ] **Step 5: Run the new test to verify it passes**

Run: `pnpm --filter @deft/api exec tsx --test test/apply-template-from-table.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 6: Run the full API test suite**

Run: `pnpm --filter @deft/api test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/task-templates.ts apps/api/test/apply-template-from-table.test.ts apps/api/test/apply-template-dueDate.test.ts
git commit -m "refactor(templates): apply-template reads from task_templates table, uses due_offset_days"
```

---

### Task 7: Move PHASE3_TASK_TOOLS onto the Deft Workspace bundled skill

**Files:**
- Modify: `apps/api/src/lib/bundled-skills.ts`

- [ ] **Step 1: Inspect current Deft Workspace definition**

Run: `grep -n -A 6 "slug: 'deft-workspace'" apps/api/src/lib/bundled-skills.ts`
Expected: shows an `agent_config: { capability_packs: [...] }` or `agent_config: {}` block. Capture the current shape so you can extend without overwriting.

- [ ] **Step 2: Add PHASE3_TASK_TOOLS to Deft Workspace**

Edit `apps/api/src/lib/bundled-skills.ts`. Find the `deftWorkspace` (or capability-pack-derived) skill entry for slug `'deft-workspace'`. Merge `tools: PHASE3_TASK_TOOLS` into its `agent_config`:

```typescript
// Before (example):
const capabilityPackSkills: BundledSkill[] = getAvailableCapabilityPacks().map((pack) => ({
  id: `skill_bundled_${pack.slug}`,
  slug: pack.slug,
  name: pack.display_name,
  description: pack.description,
  icon: null,
  version: DEFAULT_VERSION,
  agent_config: { capability_packs: [pack.slug] },
  project_config: {},
}));

// After — inject PHASE3_TASK_TOOLS into the deft-workspace entry:
const capabilityPackSkills: BundledSkill[] = getAvailableCapabilityPacks().map((pack) => {
  const baseAgentConfig: BundledSkill['agent_config'] = {
    capability_packs: [pack.slug],
  };
  if (pack.slug === 'deft-workspace') {
    baseAgentConfig.tools = PHASE3_TASK_TOOLS;
  }
  return {
    id: `skill_bundled_${pack.slug}`,
    slug: pack.slug,
    name: pack.display_name,
    description: pack.description,
    icon: null,
    version: DEFAULT_VERSION,
    agent_config: baseAgentConfig,
    project_config: {},
  };
});
```

Do NOT remove the Engineering bundled skill yet — Task 16 handles that after we know consumers are flipped.

- [ ] **Step 3: Re-run the bundled-skills seeder**

Run: `pnpm tsx apps/api/src/scripts/seed-bundled-skills.ts`
Expected: `Upserting 9 bundled skills ... Done`. No errors.

- [ ] **Step 4: Verify Deft Workspace now has 9 tools**

Run: `psql $DATABASE_URL -c "SELECT slug, jsonb_array_length((agent_config->'tools')::jsonb) AS tool_count FROM skills WHERE slug='deft-workspace';"`
Expected: `deft-workspace | 9`.

- [ ] **Step 5: Run bundled-skills-seed.test.ts**

Run: `pnpm --filter @deft/api exec tsx --test test/bundled-skills-seed.test.ts`
Expected: PASS. If a shape assertion on Deft Workspace breaks, adjust the assertion to the new shape (tools array of 9 entries).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/bundled-skills.ts
git commit -m "feat(skills): move PHASE3_TASK_TOOLS onto deft-workspace bundled skill"
```

---

## Phase 3 — UI collapse

### Task 8: Collapse project create modal to a single step

**Files:**
- Modify: `apps/web/src/components/create-project-modal.tsx`

- [ ] **Step 1: Back up the current file for reference**

Run: `cp apps/web/src/components/create-project-modal.tsx /tmp/create-project-modal.before.tsx`

- [ ] **Step 2: Audit what Step 2 did**

Run: `grep -n "Step 2\|skill\|attach\|skills" apps/web/src/components/create-project-modal.tsx`
Expected: identifies the skill picker component, the `attachedSkills` state, the attach/detach callbacks, the `POST /api/projects/:id/skills` calls.

Record every state variable, handler, and child component that exists only for the skill step. They all get deleted.

- [ ] **Step 3: Delete step-2 state and UI**

Remove from the component:
- Any `useState` for `attachedSkills`, `availableSkills`, `step` (if only two steps existed).
- The entire JSX block wrapped by the "Step 2 of 2" or "Which skills apply?" header.
- Any `useEffect` that fetches `/api/skills` or builds the attach list.
- The "Continue" button; replace with a single "Create project" submit button wired to a single-step form.
- The `handleAttach`, `handleDetach`, `handleReorder` callbacks.

Keep: Name, Prefix, Description, Color state + submit → `POST /api/projects`. The submit handler should no longer make any follow-up `POST /api/projects/:id/skills` call — remove that too.

- [ ] **Step 4: Refocus the project on create**

After successful `POST /api/projects`, the response returns `{ project: { id, ... } }`. On success:

```typescript
// After the fetch resolves:
const { project } = await res.json();
onClose();
router.push(`/tasks?project=${project.id}`);
// AND invalidate any project-list caches the sidebar uses. Grep the repo
// for existing useSWR or react-query keys mentioning 'projects' and call
// mutate() / queryClient.invalidateQueries() accordingly. This fixes
// friction #14 (new project missing from picker).
```

- [ ] **Step 5: Verify typecheck**

Run: `pnpm --filter @deft/web typecheck`
Expected: PASS. Fix any stale references (e.g. the old `Step` enum, the removed components).

- [ ] **Step 6: Manual UI verification**

Start both servers if not already running:

```bash
pnpm dev:api &
pnpm dev:web &
```

Open `http://localhost:3000/tasks`, log in as `maneek@test.com` / `test1234`, click the "+" next to PROJECTS in the sidebar. Expected:
- Modal titled "Create a project" with no "Step 1 of 2" indicator.
- Fields: Name, Prefix, Description, Color. Nothing else.
- Submit → project is created AND the board immediately reflects the new project (top picker + sidebar).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/create-project-modal.tsx
git commit -m "feat(web): single-step project create modal — drop skill picker"
```

---

### Task 9: Filter agent wizard skill list to non-empty `agent_config`

**Files:**
- Modify: the agent wizard step-3 component under `apps/web/src/app/(app)/settings/agent-employees/create/`

- [ ] **Step 1: Locate the skill list fetcher**

Run: `grep -rln "available.*skill\|list.*skill\|/api/skills" apps/web/src/app/\(app\)/settings/agent-employees/`
Expected: one or two files — typically a `step-skills.tsx` or an inline component in `page.tsx` / `client.tsx`.

- [ ] **Step 2: Add the filter**

After the skill list is fetched (e.g. `const { data: skills } = useSWR('/api/skills')`), filter:

```typescript
const installableSkills = (skills ?? []).filter((s) => {
  const cfg = (s.agent_config ?? {}) as {
    tools?: unknown[];
    capability_packs?: unknown[];
    triggers?: unknown[];
    system_prompt_addition?: string;
    heartbeat_checklist?: unknown[];
  };
  return (
    (cfg.tools?.length ?? 0) > 0 ||
    (cfg.capability_packs?.length ?? 0) > 0 ||
    (cfg.triggers?.length ?? 0) > 0 ||
    (cfg.system_prompt_addition?.length ?? 0) > 0 ||
    (cfg.heartbeat_checklist?.length ?? 0) > 0
  );
});
```

Use `installableSkills` wherever the raw `skills` was being rendered.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @deft/web typecheck`
Expected: PASS.

- [ ] **Step 4: Manual UI verification**

Log in, go to Settings → Agent Employees → Create Agent → advance to Step 3. Expected: Marketing Campaign and Sales Pipeline cards no longer appear (they will disappear entirely after Task 16; today they still exist but have empty `agent_config` so the filter excludes them).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(app\)/settings/agent-employees/
git commit -m "fix(agent-wizard): filter skill list to entries with non-empty agent_config"
```

---

### Task 10: Collapse agent wizard from 5 steps to 3

**Files:**
- Modify: files under `apps/web/src/app/(app)/settings/agent-employees/create/`

- [ ] **Step 1: Map the current step files**

Run: `ls apps/web/src/app/\(app\)/settings/agent-employees/create/`
Expected: a `page.tsx` plus component files (likely `step-identity.tsx`, `step-instructions.tsx`, `step-skills.tsx`, `step-tools-trust.tsx`, `step-heartbeat.tsx`, or an inline state machine in `page.tsx`).

- [ ] **Step 2: Merge old step 2 + old step 4 into a single "Behavior" step**

Create `step-behavior.tsx` (or merge inline if steps are inline) that contains:
- System Prompt textarea
- Expertise description input
- Trust Level radio group (Conservative / Standard / Autonomous)
- Max Daily Actions number input

Delete the separate `step-instructions.tsx` and `step-tools-trust.tsx` files (if they exist) once the merge is complete.

- [ ] **Step 3: Delete the Heartbeat step**

Remove `step-heartbeat.tsx` (if it exists). In the wizard router, drop the case for step 5 and set `TOTAL_STEPS = 3`.

Any `enable_heartbeat` default used during `POST /api/agent-employees` must stay as `false` (or be omitted — API default should already be false). Search the create request payload for this field; if it's being set from the old step-5 checkbox, remove the field from the payload.

- [ ] **Step 4: Update the progress indicator**

Wherever "Step N of 5" is rendered, change 5 → 3. Update the progress dots / progress bar element count.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @deft/web typecheck`
Expected: PASS.

- [ ] **Step 6: Manual UI verification**

Log in, navigate to Create Agent. Expected: 3-step wizard with steps Identity / Behavior / Skills. Step 4 and 5 screens gone. Progress indicator says "Step N of 3".

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/app/\(app\)/settings/agent-employees/
git commit -m "feat(agent-wizard): collapse 5 steps to 3 (Identity, Behavior, Skills)"
```

---

### Task 11: BYOA pre-flight on agent wizard step 1

**Files:**
- Modify: agent wizard step 1 component
- Modify (maybe): `apps/api/src/routes/agent-employees.ts` or wherever the "self-hosted mode" flag lives

- [ ] **Step 1: Locate the BYOA check**

Run: `grep -rln "self.hosted\|BYOA\|Bring Your Own" apps/api/src apps/web/src`
Expected: the backend condition that returned `"Self-hosted mode requires BYOA"` on Create.

- [ ] **Step 2: Expose the check as a GET endpoint**

Add (or reuse) a `GET /api/agent-employees/provider-readiness` endpoint that returns `{ ready: boolean, reason?: string }`. If a suitable endpoint already exists, use it. Otherwise add minimal:

```typescript
// In agent-employees.ts
routes.get('/provider-readiness', async (c) => {
  const user = c.get('user') as { id: string; org_id: string };
  // Reuse whatever logic currently runs on POST before returning the BYOA error.
  const ready = await isOrgProviderReady(user.org_id);
  if (ready) return c.json({ ready: true });
  return c.json({
    ready: false,
    reason: 'Self-hosted mode requires a BYOA provider. Configure one in Settings → Integrations.',
  });
});
```

(Extract the existing BYOA branch into `isOrgProviderReady` if needed.)

- [ ] **Step 3: Call the endpoint on wizard mount**

In the step-1 component:

```typescript
const { data: readiness } = useSWR<{ ready: boolean; reason?: string }>(
  '/api/agent-employees/provider-readiness',
);

if (readiness && !readiness.ready) {
  return (
    <div className="rounded-md border border-destructive bg-destructive/10 p-4">
      <p className="text-sm font-medium">Can't create agents yet</p>
      <p className="text-sm text-muted-foreground">{readiness.reason}</p>
      <Link href="/settings/integrations" className="text-sm underline">
        Open integrations settings
      </Link>
    </div>
  );
}
```

Keep the form disabled until `readiness.ready === true`. Remove the post-Create BYOA error surfacing (the red banner on step 5) — the API will still return the error as a defense in depth, but the UI should never let you reach that point.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @deft/web typecheck && pnpm --filter @deft/api typecheck`
Expected: PASS.

- [ ] **Step 5: Manual UI verification**

With no BYOA provider configured: open Create Agent → step 1 shows the blocked state with a link. With a provider configured: normal wizard.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/agent-employees.ts apps/web/src/app/\(app\)/settings/agent-employees/
git commit -m "fix(agent-wizard): BYOA provider check moves to step 1 pre-flight, not post-Create error"
```

---

### Task 12: Add "+ from template" picker to task quick-create

**Files:**
- Modify: `apps/web/src/components/task-quick-create.tsx` (or wherever the New Task entry lives)
- Create: `apps/web/src/components/template-picker-modal.tsx`

- [ ] **Step 1: Build the picker modal**

Create `apps/web/src/components/template-picker-modal.tsx`:

```tsx
'use client';

import { useState } from 'react';
import useSWR from 'swr';

type Template = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tasks: Array<{ title: string; due_offset_days?: number }>;
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function TemplatePickerModal({
  projectId,
  onClose,
  onApplied,
}: {
  projectId: string;
  onClose: () => void;
  onApplied: (count: number) => void;
}) {
  const { data } = useSWR<{ templates: Template[] }>('/api/task-templates', fetcher);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const selected = data?.templates.find((t) => t.id === selectedId) ?? null;

  async function apply() {
    if (!selectedId) return;
    setApplying(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/apply-template`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template_id: selectedId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed');
      const body = (await res.json()) as { count: number };
      onApplied(body.count);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-2xl rounded-lg bg-background p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Apply a template</h2>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2 max-h-[50vh] overflow-y-auto">
            {(data?.templates ?? []).map((tpl) => (
              <button
                key={tpl.id}
                className={`w-full rounded-md border p-3 text-left ${
                  selectedId === tpl.id ? 'border-primary bg-primary/5' : ''
                }`}
                onClick={() => setSelectedId(tpl.id)}
              >
                <div className="font-medium">{tpl.name}</div>
                <div className="text-xs text-muted-foreground">
                  {tpl.tasks.length} tasks
                </div>
              </button>
            ))}
          </div>
          <div className="rounded-md border p-3 max-h-[50vh] overflow-y-auto">
            {selected ? (
              <>
                <div className="mb-2 text-sm text-muted-foreground">{selected.description}</div>
                <ol className="space-y-1 text-sm">
                  {selected.tasks.map((t, i) => (
                    <li key={i}>
                      <span className="font-medium">{i + 1}.</span> {t.title}
                      {typeof t.due_offset_days === 'number' ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                          (+{t.due_offset_days}d)
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Select a template to preview.</p>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border px-3 py-1.5 text-sm">Cancel</button>
          <button
            onClick={apply}
            disabled={!selectedId || applying}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            {applying ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the entry point in task quick-create**

In `apps/web/src/components/task-quick-create.tsx` (or the New Task bar), add next to the "Create task" button:

```tsx
<button
  onClick={() => setTemplatePickerOpen(true)}
  className="text-xs underline"
>
  + from template
</button>

{templatePickerOpen && currentProjectId && (
  <TemplatePickerModal
    projectId={currentProjectId}
    onClose={() => setTemplatePickerOpen(false)}
    onApplied={(count) => {
      setTemplatePickerOpen(false);
      toast(`Applied template — ${count} tasks created`);
    }}
  />
)}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @deft/web typecheck`
Expected: PASS.

- [ ] **Step 4: Manual UI verification**

Open the Content Calendar project (or create a fresh one). Click "+ from template", pick Launch Campaign, click Apply. Expected: 7 new tasks appear on the board within a second (WebSocket push).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/template-picker-modal.tsx apps/web/src/components/task-quick-create.tsx
git commit -m "feat(tasks): add + from template picker modal to task quick-create"
```

---

### Task 13: Create `/library` page with Skills + Templates tabs

**Files:**
- Create: `apps/web/src/app/(app)/library/page.tsx`
- Modify: sidebar nav component

- [ ] **Step 1: Build the page shell**

Create `apps/web/src/app/(app)/library/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import useSWR from 'swr';

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type Skill = { id: string; name: string; slug: string; source: string; description: string | null };
type Template = {
  id: string;
  name: string;
  slug: string;
  source: string;
  description: string | null;
  tasks: unknown[];
};

export default function LibraryPage() {
  const [tab, setTab] = useState<'skills' | 'templates'>('skills');
  const { data: skillsData } = useSWR<{ skills: Skill[] }>('/api/skills', fetcher);
  const { data: templatesData } = useSWR<{ templates: Template[] }>('/api/task-templates', fetcher);

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Library</h1>
      <div className="mb-6 border-b">
        <button
          onClick={() => setTab('skills')}
          className={`px-4 py-2 text-sm ${tab === 'skills' ? 'border-b-2 border-primary font-medium' : ''}`}
        >
          Skills
        </button>
        <button
          onClick={() => setTab('templates')}
          className={`px-4 py-2 text-sm ${tab === 'templates' ? 'border-b-2 border-primary font-medium' : ''}`}
        >
          Templates
        </button>
      </div>

      {tab === 'skills' && (
        <div className="space-y-3">
          {(skillsData?.skills ?? []).map((s) => (
            <div key={s.id} className="rounded-md border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{s.name}</div>
                  <div className="text-xs text-muted-foreground uppercase">{s.source}</div>
                </div>
              </div>
              {s.description ? (
                <p className="mt-2 text-sm text-muted-foreground">{s.description}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {tab === 'templates' && (
        <div className="space-y-3">
          {(templatesData?.templates ?? []).map((t) => (
            <div key={t.id} className="rounded-md border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{t.name}</div>
                  <div className="text-xs text-muted-foreground uppercase">{t.source}</div>
                </div>
                <span className="text-xs text-muted-foreground">{(t.tasks ?? []).length} tasks</span>
              </div>
              {t.description ? (
                <p className="mt-2 text-sm text-muted-foreground">{t.description}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

This is the minimal catalog browser. Install-to-agent and apply-to-project flows can be wired up later; the browsable surface is the immediate need.

- [ ] **Step 2: Add the sidebar nav entry**

Find the main sidebar component (search `grep -rln "Dashboard.*Notes.*Calendar" apps/web/src/components`). Add an entry for Library between "Agent" and "Settings" with an appropriate icon (e.g. BookOpen from lucide).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @deft/web typecheck`
Expected: PASS.

- [ ] **Step 4: Manual UI verification**

Log in. Sidebar shows "Library" between Agent and Settings. Click → page opens with Skills tab active, 9 bundled skills listed. Switch to Templates → 2 bundled templates listed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/\(app\)/library apps/web/src/components
git commit -m "feat(web): /library catalog with Skills + Templates tabs"
```

---

## Phase 4 — Cleanup

### Task 14: Migration — drop project_skills, drop project_config, delete bundled rows

**Files:**
- Create: `packages/db/drizzle/0046_drop_project_skills.sql`
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Pre-flight audit — who has project-only bundled skills attached?**

Run:

```bash
psql $DATABASE_URL -c "
SELECT aes.agent_employee_id, s.slug
FROM agent_employee_skills aes
JOIN skills s ON s.id = aes.skill_id
WHERE s.source = 'bundled' AND s.slug IN ('engineering','marketing-campaign','sales-pipeline');
"
```

Record the output. If non-empty, the migration must strip those junction rows first (or the FK constraint `ON DELETE RESTRICT` will block the skill DELETE).

- [ ] **Step 2: Write the migration**

Create `packages/db/drizzle/0046_drop_project_skills.sql`:

```sql
-- Phase-4 reversal — remove project-level customization surface.
-- See docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md.

BEGIN;

-- 1. Strip agent_employee_skills rows that point at the three project-only
--    bundled skills. Required because the FK is ON DELETE RESTRICT.
DELETE FROM agent_employee_skills
WHERE skill_id IN (
  SELECT id FROM skills
  WHERE source = 'bundled' AND slug IN ('engineering','marketing-campaign','sales-pipeline')
);

-- 2. Drop the project_skills junction table entirely (multi-skill-per-project,
--    attachment ordering, first-attached-wins resolution — all retired).
DROP TABLE IF EXISTS project_skills;

-- 3. Drop the project_config jsonb column from skills. Everything it expressed
--    (statuses, priority vocab, default view, custom fields, task templates,
--    allowed transitions) is either hardcoded to engineering defaults or moved
--    to the first-class task_templates table.
ALTER TABLE skills DROP COLUMN IF EXISTS project_config;

-- 4. Delete the three bundled skill rows that existed only to carry
--    project_config. Their tools (Engineering's PHASE3_TASK_TOOLS) have
--    already been folded into the deft-workspace bundled skill.
DELETE FROM skills
WHERE source = 'bundled'
  AND slug IN ('engineering','marketing-campaign','sales-pipeline');

COMMIT;
```

- [ ] **Step 3: Remove the Drizzle schema declarations for project_skills and skills.project_config**

In `packages/db/src/schema.ts`:
- Delete the `projectSkills` table declaration (around line 1414).
- Remove the `project_config: jsonb('project_config').default({}).notNull(),` line from the `skills` table definition.

- [ ] **Step 4: Apply the migration**

Run: `psql $DATABASE_URL -f packages/db/drizzle/0046_drop_project_skills.sql`
Expected: BEGIN, DELETE (N), DROP TABLE, ALTER TABLE, DELETE (3), COMMIT. No errors.

- [ ] **Step 5: Verify schema state**

Run:

```bash
psql $DATABASE_URL -c "\d project_skills" 2>&1 | grep -i "does not exist"
psql $DATABASE_URL -c "\d skills" | grep project_config || echo "project_config column GONE"
psql $DATABASE_URL -c "SELECT slug FROM skills WHERE source='bundled' ORDER BY slug;"
```

Expected:
- `project_skills` does not exist
- `project_config column GONE`
- 6 bundled slugs (deft-workspace, github, google-calendar, shell-exec, tavily-search, web-browsing) — no engineering / marketing-campaign / sales-pipeline.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @deft/db typecheck && pnpm --filter @deft/api typecheck && pnpm --filter @deft/web typecheck`
Expected: PASS — IF there are broken references to `projectSkills` or `skills.project_config`, they appear here. Fix each by deleting the reference (the next tasks handle the libs; this step flushes any stragglers).

- [ ] **Step 7: Run full API test suite**

Run: `pnpm --filter @deft/api test`
Expected: PASS. Any test referencing `project_config` as a column or `project_skills` as a table should already have been deleted in Phase 2 — if not, delete now.

- [ ] **Step 8: Commit**

```bash
git add packages/db/drizzle/0046_drop_project_skills.sql packages/db/src/schema.ts
git commit -m "chore(db): drop project_skills table, skills.project_config column, and 3 project-only bundled skills"
```

---

### Task 15: Delete SkillProjectConfig and SkillProjectStatus types

**Files:**
- Modify: `apps/api/src/lib/skill-config.ts`

- [ ] **Step 1: Find remaining importers**

Run: `grep -rn "SkillProjectConfig\|SkillProjectStatus" apps/api/src apps/web/src packages`
Expected: after Task 5 rewrote project-resolved-config.ts, the only remaining importer should be skill-config.ts itself (the definition site). If other files still import: they need deletion or rewrite.

- [ ] **Step 2: Delete the exports**

Edit `apps/api/src/lib/skill-config.ts`. Delete `SkillProjectStatus` type and `SkillProjectConfig` type. Keep `SkillAgentConfig`. Final file shape:

```typescript
/**
 * Unified skill primitive typings — agent-only after the
 * Phase-4-reversal simplification (see the design spec).
 *
 * The per-project fork (SkillProjectConfig) retired along with the
 * project_skills junction and skills.project_config column. A skill is
 * now strictly a bundle of agent capabilities.
 */

export type SkillAgentConfig = {
  tools?: string[];
  capability_packs?: string[];
  triggers?: string[];
  system_prompt_addition?: string;
  trust_level_override?: 'conservative' | 'standard' | 'autonomous' | null;
  model_recommendation?: string;
  heartbeat_checklist?: string[];
  param_schema?: Record<string, unknown>;
};
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @deft/api typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/skill-config.ts
git commit -m "refactor(skills): drop SkillProjectConfig and SkillProjectStatus — agent-only now"
```

---

### Task 16: Remove 3 project-only bundled skill definitions + update seeder

**Files:**
- Modify: `apps/api/src/lib/bundled-skills.ts`
- Modify: `apps/api/src/scripts/seed-bundled-skills.ts`

- [ ] **Step 1: Delete the project-workflow skill definitions**

In `apps/api/src/lib/bundled-skills.ts`:
- Delete the `engineeringSkill`, `marketingCampaignSkill`, `salesPipelineSkill` declarations.
- Remove them from the exported `BUNDLED_SKILLS` array.
- Delete `PHASE3_TASK_TOOLS` (it now lives only where it's used — inside `capabilityPackSkills` per Task 7).
- Delete the `project_config` field from the `BundledSkill` type and from every entry in `capabilityPackSkills`.

Final shape after edits:

```typescript
export type BundledSkill = {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string | null;
  version: string;
  agent_config: SkillAgentConfig;
  // project_config removed.
};

const PHASE3_TASK_TOOLS = [/* ... moved here since only capabilityPackSkills uses it */];

const capabilityPackSkills: BundledSkill[] = getAvailableCapabilityPacks().map((pack) => {
  const baseAgentConfig: SkillAgentConfig = { capability_packs: [pack.slug] };
  if (pack.slug === 'deft-workspace') {
    baseAgentConfig.tools = PHASE3_TASK_TOOLS;
  }
  return {
    id: `skill_bundled_${pack.slug}`,
    slug: pack.slug,
    name: pack.display_name,
    description: pack.description,
    icon: null,
    version: DEFAULT_VERSION,
    agent_config: baseAgentConfig,
  };
});

export const BUNDLED_SKILLS: BundledSkill[] = [...capabilityPackSkills];
```

- [ ] **Step 2: Update the seeder SQL to drop project_config column reference**

In `apps/api/src/scripts/seed-bundled-skills.ts`, remove the `project_config` column from the INSERT and the `${JSON.stringify(skill.project_config)}::jsonb` from VALUES. The updated INSERT:

```typescript
await db.execute(sql`
  INSERT INTO skills (
    id, org_id, source, slug, name, description, icon, version,
    agent_config, is_deleted, usage_count
  ) VALUES (
    ${skill.id},
    NULL,
    'bundled',
    ${skill.slug},
    ${skill.name},
    ${skill.description},
    ${skill.icon},
    ${skill.version},
    ${JSON.stringify(skill.agent_config)}::jsonb,
    false,
    0
  )
  ON CONFLICT (source, (COALESCE(org_id,'')), slug) WHERE is_deleted = false
  DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    version = EXCLUDED.version,
    agent_config = EXCLUDED.agent_config,
    updated_at = now()
`);
```

- [ ] **Step 3: Re-run seeder**

Run: `pnpm tsx apps/api/src/scripts/seed-bundled-skills.ts`
Expected: `Upserting 6 bundled skills ... Done`. (Was 9 before; after the 3 deletions + seeder update, it's 6.)

- [ ] **Step 4: Run bundled-skills-seed test**

Run: `pnpm --filter @deft/api exec tsx --test test/bundled-skills-seed.test.ts`
Expected: PASS. If the test asserted 9 skills, update the assertion to 6.

- [ ] **Step 5: Typecheck + full test suite**

Run: `pnpm --filter @deft/api typecheck && pnpm --filter @deft/api test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/lib/bundled-skills.ts apps/api/src/scripts/seed-bundled-skills.ts apps/api/test/bundled-skills-seed.test.ts
git commit -m "chore(skills): drop 3 project-only bundled skill defs; seeder writes agent_config only"
```

---

### Task 17: Delete the web `use-project-resolved-config` hook or collapse it

**Files:**
- Modify: `apps/web/src/hooks/use-project-resolved-config.ts`
- Modify: every component that imports it (task-board, task-card, task-detail, task-filters, task-list, task-pipeline-view, task-quick-create, tasks/page.tsx)

- [ ] **Step 1: Decide — delete or collapse?**

Delete is cleanest, but changes many call sites. Collapse — have the hook synchronously return the hardcoded constants — preserves call sites and is a 20-line change.

**Choose collapse.** Rewrite the hook to return a constant object, sync, no fetch:

```typescript
// apps/web/src/hooks/use-project-resolved-config.ts
import type { ProjectResolvedConfig } from '@/types/project-resolved-config';

const ENGINEERING_STATUSES = [
  { id: 'backlog', label: 'Backlog', color: '#6b7280', order: 0 },
  { id: 'todo', label: 'To Do', color: '#3b82f6', order: 1 },
  { id: 'in_progress', label: 'In Progress', color: '#f59e0b', order: 2 },
  { id: 'in_review', label: 'In Review', color: '#8b5cf6', order: 3 },
  { id: 'done', label: 'Done', color: '#10b981', order: 4 },
  { id: 'cancelled', label: 'Cancelled', color: '#ef4444', order: 5 },
];

const HARDCODED: ProjectResolvedConfig = {
  statuses: ENGINEERING_STATUSES,
  allowed_transitions: {
    backlog: ['todo', 'in_progress', 'cancelled'],
    todo: ['in_progress', 'backlog', 'cancelled'],
    in_progress: ['in_review', 'done', 'backlog', 'cancelled'],
    in_review: ['in_progress', 'done', 'cancelled'],
    done: ['in_progress', 'backlog'],
    cancelled: ['backlog'],
  },
  priority_vocab: { kind: 'numbered', labels: ['p0', 'p1', 'p2', 'p3'] },
  default_view: 'board',
  hide_prefix_ids: false,
  custom_fields: [],
  task_templates: [],
};

export function useProjectResolvedConfig(_projectId: string | null) {
  return { data: HARDCODED, isLoading: false, error: null };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @deft/web typecheck`
Expected: PASS.

- [ ] **Step 3: Manual UI verification**

Open every project in the sidebar. Expected: Marketing project no longer crashes — it renders identical columns to all other projects (Backlog / To Do / In Progress / In Review / Done + collapsed Cancelled). Test sidebar project count updates when creating a task.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/hooks/use-project-resolved-config.ts
git commit -m "refactor(web): collapse useProjectResolvedConfig to hardcoded engineering defaults"
```

---

### Task 18: Update CLAUDE.md — reflect new architecture

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Skills primitive paragraph**

Find the "Skills primitive (unified agent + project capabilities)" block in CLAUDE.md. Replace with:

```markdown
**Skills primitive (agent-only).** A single `skills` table with three source tiers — `bundled` (shipped with Deft, `org_id IS NULL`), `marketplace` (installable catalog), `org` (tenant-authored). Carries an `agent_config` JSONB (tools, capability packs, triggers, prompt additions). Agents install skills via the `agent_employee_skills` junction. Six day-one bundled skills ship: one per capability pack. Task templates are a separate first-class primitive (`task_templates` table) — instantiated into any project via `POST /api/projects/:id/apply-template`. Project-level customization (per-skill statuses, priority vocab, custom fields) was retired 2026-04-18 in favor of fixed engineering defaults.
```

- [ ] **Step 2: Remove the Known Limitations "Postgres status enum" entry**

Delete the bullet `**Postgres status enum constraint.**` from the Known Limitations section. Every project now uses the 6-value enum; no customization can violate it.

- [ ] **Step 3: Update the Task Architecture section**

Find and remove references to `project_skills`, first-attached-wins resolution, and per-skill `project_config`. Add a one-line note:

```markdown
- **Fixed project defaults.** All projects use the 6-status engineering vocabulary (Backlog / To Do / In Progress / In Review / Done / Cancelled), p0–p3 priority, Kanban default. Per-project customization was retired 2026-04-18. See `docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): reflect skills simplification — agent-only skills + first-class templates"
```

---

## Phase 5 — Verification

### Task 19: End-to-end Playwright walkthrough

**Files:**
- None (manual run; optionally codify as a new audit under `docs/superpowers/audits/` if desired).

- [ ] **Step 1: Restart both servers**

```bash
# Kill any existing dev servers first.
pkill -f "next dev" ; pkill -f "tsx watch" ; true
pnpm dev > /tmp/deft-dev.log 2>&1 &
sleep 20
tail -n 20 /tmp/deft-dev.log
curl -s -o /dev/null -w "web:%{http_code} api:%{http_code}\n" http://localhost:3000 http://localhost:3001/health
```

Expected: `web:307 api:200`.

- [ ] **Step 2: Playwright walkthrough — project creation**

- Open `http://localhost:3000/login`. Log in as `maneek@test.com` / `test1234`.
- Click + next to PROJECTS in sidebar.
- Expected: single-step modal with Name / Prefix / Description / Color. No step 2. No skill picker.
- Create "Walkthrough A". Expected: sidebar updates immediately, top picker updates immediately, URL reflects new project id, empty board renders.

- [ ] **Step 3: Playwright walkthrough — task creation + template**

- Click "New task", enter "First task", submit.
- Expected: task appears in Backlog.
- Click "+ from template" in the task-create area.
- Pick "Launch Campaign". Preview shows 7 tasks. Apply.
- Expected: 7 tasks appear on the board, spread across appropriate columns (or all Backlog by default).

- [ ] **Step 4: Playwright walkthrough — Marketing project no longer crashes**

- Click existing "Marketing" project in sidebar.
- Expected: board renders without the `Cannot read properties of undefined (reading 'length')` crash. Columns = the 6 engineering statuses.

- [ ] **Step 5: Playwright walkthrough — agent wizard 3-step**

- Settings → Agent Employees → Create Agent.
- Expected: "Step 1 of 3" progress indicator.
- Step 1: Identity (Name, Role, Avatar). Fill "QA Assistant" / QA Engineer / any avatar. Next.
- Step 2: Behavior — single screen with System Prompt, Expertise, Trust Level, Max Daily Actions. Fill. Next.
- Step 3: Skills — list excludes Marketing Campaign and Sales Pipeline (they no longer exist). Pick one or leave default. Create.
- Expected: success (or the BYOA blocker surfaces on step 1 instead of after Create).

- [ ] **Step 6: Library catalog**

- Open `/library`. Expected: Skills tab shows 6 bundled skills. Templates tab shows 2 bundled templates.

- [ ] **Step 7: Screenshot the key flows**

Save screenshots to `docs/superpowers/audits/simplify-skills-templates-post-migration/`:
- `project-create-single-step.png`
- `template-picker.png`
- `marketing-board-renders.png`
- `agent-wizard-3-step.png`
- `library-catalog.png`

- [ ] **Step 8: Final commit**

```bash
git add docs/superpowers/audits/simplify-skills-templates-post-migration
git commit -m "docs(audit): post-migration screenshots — simplification verification"
```

---

## Self-review checklist

- [x] **Spec coverage** — every `## Data model`, `## UI changes`, `## Migration`, `## Code changes` item in the spec maps to a task: task_templates table (T1), bundled templates (T2), hardcoded defaults (T4), resolver collapse (T5), apply-template rewrite (T6), PHASE3_TASK_TOOLS preservation (T7), project create modal (T8), agent wizard collapse (T10), BYOA pre-flight (T11), template picker (T12), Library page (T13), destructive migration (T14), type deletions (T15), bundled-skills cleanup (T16), web hook collapse (T17), CLAUDE.md update (T18), e2e verification (T19).
- [x] **Placeholder scan** — no TBDs, no "add appropriate error handling," every test step includes concrete assertions, every SQL block is executable as-is.
- [x] **Type consistency** — `ProjectResolvedConfig` uses the shape defined in Task 4's `task-status-machine.ts`; the web hook (T17) mirrors it. `BundledSkill` drops `project_config` in T16 — matches the type deletion in T15.
- [x] **Ordering** — additive phase (1) precedes flip phase (2) precedes UI (3) precedes destructive cleanup (4). Seeder update in T16 happens AFTER the `project_config` column is dropped in T14 — safe because T16 removes the reference to it from the INSERT.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-18-simplify-skills-templates.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

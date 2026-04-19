# Simplify skills + templates — design

Status: approved 2026-04-18
Author: maneek
Scope: task management, agent creation, skills/templates primitives

## Motivation

A UX walk-through of agent creation, project creation, and task creation in the test org surfaced concentrated friction in three places:

1. **Project creation forces a skill decision** the user doesn't want or understand. Step 2 of 2 demands a "Which skills apply?" pick, defaults "Content Calendar" to the Engineering skill with a "DRIVES UI" tag, and teaches the user about first-attached-wins ordering before they've made a project.
2. **`skills` is two primitives in one entity.** Pure project-workflow skills (Marketing Campaign, Sales Pipeline) appear in the agent-install wizard where they do nothing (0 tools, 0 triggers). The same Engineering skill means one thing on an agent and a different thing on a project.
3. **Non-Engineering project skills are broken in production.** The Marketing project crashes the task board with `Cannot read properties of undefined (reading 'length')` because the `tasks.status` Postgres enum only accepts the 6 Engineering values. CLAUDE.md flags this as a known deployment blocker.

Secondary friction (captured separately):
- Agent creation is a 5-step wizard where step 4 ("Tools & Trust") has no tool config and step 5 ("Heartbeat") is a single checkbox for an unshipped Phase 8 feature.
- Agent wizard ends with a `Self-hosted mode requires BYOA` error on Create — no pre-flight validation in earlier steps.
- Project picker stale state (newly-created project missing from top dropdown; sidebar task count stuck at 0 after task creation).

The common thread: the skills primitive was overloaded, and templates were buried inside that primitive. Stripping project-level customization out of skills unblocks the rest.

## Decision

Ship option (a) from the brainstorm: **projects use fixed defaults forever. Skills become agent-only. Templates become their own first-class catalog.** No per-project status/priority/view overrides. No "Which skill applies to this project?" step. Per-project customization can come back later (option c from the brainstorm) if real demand shows up.

## Data model

### Drop

- `project_skills` table entirely. Multi-skill-per-project, attachment ordering, first-attached-wins resolution all go.
- `skills.project_config` jsonb column. The `SkillProjectConfig` TypeScript type and every consumer.
- The three project-workflow bundled skills:
  - `skill_bundled_marketing-campaign` (empty `agent_config`, project-only)
  - `skill_bundled_sales-pipeline` (empty `agent_config`, project-only)
  - `skill_bundled_engineering` (has `agent_config.tools = PHASE3_TASK_TOOLS`, so its deletion has an extra step — see below)

  The other six bundled skills (Deft Workspace, GitHub, Google Calendar, Shell Exec, Tavily Search, Web Browsing) stay — they carry agent-only `agent_config` and don't touch project shape.

### Preserve Engineering's 9 task tools

Deleting the Engineering bundled skill would also delete `PHASE3_TASK_TOOLS` (`comment_on_task`, `set_priority`, `set_due_date`, `add_label`, `close_task`, `reopen_task`, `add_dependency`, `remove_dependency`, `list_my_tasks`) from agents currently relying on it. Move those tools onto the **Deft Workspace** bundled skill's `agent_config.tools` — Deft Workspace is already "Required for every deployment" per its own description, so every agent picks up the task tools automatically. Verify no agent in the dev org currently installs Engineering *without* Deft Workspace; if any do, the audit should re-install Deft Workspace on them during the migration.

### Keep

- `skills` table. Agent-only primitive from now on. Columns unchanged except `project_config` drops.
- `agent_employee_skills` junction. Unchanged.
- Every `SkillAgentConfig` field (`tools`, `capability_packs`, `triggers`, `system_prompt_addition`, `trust_level_override`, `model_recommendation`, `heartbeat_checklist`).

### Add

New first-class table:

```
task_templates
  id text primary key,
  org_id text,                      -- nullable for bundled/marketplace templates
  name text not null,
  description text,
  icon text,
  slug text not null,
  source text not null,             -- 'bundled' | 'marketplace' | 'org'
  version text not null default '1.0.0',
  tasks jsonb not null,             -- [{ title, status?, priority?, due_offset_days?, description?, labels? }]
  created_by text references users.id,
  is_deleted boolean default false not null,
  usage_count integer default 0 not null,
  created_at, updated_at

  unique (source, org_id, slug) where is_deleted = false
  index (org_id)
  index (source)
```

No foreign key to `skills`. No `project_id` — templates are project-agnostic; the user instantiates them into whichever project is open.

The `tasks` jsonb shape:

```ts
type TemplateTask = {
  title: string;
  status?: TaskStatus;        // defaults to 'todo' if omitted
  priority?: TaskPriority;    // defaults to 'p2'
  due_offset_days?: number;   // days from instantiation date
  description?: string;
  labels?: string[];
};
```

### Task status enum

Stays as the existing 6-value enum: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `cancelled`. No migration. The CLAUDE.md "Known Limitations" entry about the enum constraint is resolved — not by migrating, but by removing the features that collided with it.

### Allowed status transitions

Currently lived in `SkillProjectConfig.allowed_transitions` for the Engineering skill. Hardcode the Engineering adjacency graph in a new constant `ENGINEERING_STATUS_TRANSITIONS` in `apps/api/src/lib/task-status.ts`. Single source of truth, no JSON config, no per-project override. If/when per-project customization returns, this constant is the thing that becomes configurable.

## UI changes

### Project creation

Single step. Name, Prefix, Description (optional), Color. Save → new project, user lands on its board.

Remove:
- Step 2 "Which skills apply to this project?"
- Skills attach/detach UI
- "DRIVES UI" badge, "ATTACHED (DRAG-FREE REORDER)" label
- First-attached-wins resolver in the client

### Task board

Every project renders identically:
- 5-column Kanban (Backlog / Todo / In Progress / In Review / Done) plus a Cancelled column that's collapsed by default (current behavior).
- p0–p3 priority vocabulary.
- View switcher (Board / List / Timeline / Calendar / Pipeline) stays as per-user view selection, same as today.

Add: **"+ from template"** action in the task-creation area. Opens a template picker (reads from `task_templates`), shows preview of tasks that will be created, user confirms → bulk-create tasks into the current project. Due offsets resolve against the instantiation date.

### Library section

New top-level route `/library` (add to sidebar nav between Agent and Settings). Two tabs:

- **Skills** — browse bundled + org skills. Install onto an agent via a picker. This is the browse surface; the actual install still happens from the agent wizard or agent detail page.
- **Templates** — browse bundled + org templates. Click a template → "Use in project" opens a project picker → instantiates tasks.

Org users can create custom skills and templates here.

### Agent wizard

Collapse 5 → 3 steps:

**Step 1: Identity**
- Name
- Role (dropdown)
- Avatar

**Step 2: Behavior**
- System prompt
- Expertise description
- Trust level (Conservative / Standard / Autonomous)
- Max daily actions

Merges the old step 2 (Instructions) and step 4 (Tools & Trust minus the empty tool picker).

**Step 3: Skills**
- Installable skill list. Filtered to skills with non-empty `agent_config` (so project-only skills never show up here — they don't exist after this change, but the filter guards against future drift).
- Role selection still pre-checks a recommended set. Surfacing this effect stays in step 3's blurb ("Your role selection pre-selected the recommended set").

**Delete:**
- Old step 4's empty "Tool and MCP configuration can be done after creation" placeholder.
- Old step 5 "Heartbeat" entirely. Heartbeat toggle moves to the agent detail/settings page when Phase 8 is ready.

### Concurrent fixes (in scope)

- **BYOA pre-flight.** Detect self-hosted mode on Step 1 load. If self-hosted + no BYOA provider configured, disable the wizard with a clear "Configure a deployment provider first" state and a link to settings. Eliminates the completed-then-rejected failure mode.
- **Project picker stale cache.** Invalidate the top project-picker query on project create; refetch sidebar task counts after task create/delete.

Out of scope (tracked separately):
- Picker dropdown overlay trapping clicks / Escape not dismissing.

## Migration

Single migration file. Order matters:

1. `CREATE TABLE task_templates (...)` with the schema above.
2. Seed bundled templates by extracting `skills.project_config.task_templates` from the three project-workflow bundled skill rows. Produces roughly:
   - `launch-campaign` (7 tasks, from Marketing Campaign)
   - `re-engage-sequence` (14 tasks, from Sales Pipeline)
   - Engineering had no task templates in its config, so nothing extracted from there.
3. `DROP TABLE project_skills;`
4. `ALTER TABLE skills DROP COLUMN project_config;`
5. `DELETE FROM skills WHERE source = 'bundled' AND slug IN ('engineering', 'marketing-campaign', 'sales-pipeline');`
6. Keep `agent_employee_skills` untouched.

### Data impact on existing rows

- Projects: lose any `project_skills` attachments. Tasks keep their existing status (already constrained to the 6 enum values). No task data lost.
- Agents: `agent_employee_skills` rows referencing the three deleted bundled skills get cascade-deleted via the existing `ON DELETE CASCADE`... except the existing junction is `ON DELETE RESTRICT`. Audit first: if any agents have the three project-only bundled skills installed, strip those junction rows in step 5.5 before the skill DELETE, or upgrade the constraint to CASCADE for this migration only.
- Org-created custom skills: `skills.project_config` column drop preserves the row. If an org had custom project-workflow skills with empty `agent_config`, they become orphan rows — flag in migration output but leave. Follow-up cleanup can prune them after users have a chance to re-file.

### Migration safety

- Run inside a transaction.
- Dry-run query before the DELETE to report how many rows would be affected per tenant.
- Journal entry in Drizzle `_journal.json` (or raw SQL via `drizzle-kit push`, per CLAUDE.md's stale-journal note — confirm which path this repo uses before writing the migration).

## Code changes

File-by-file:

**`packages/db/src/schema.ts`**
- Remove `projectSkills` table declaration.
- Remove `project_config` column from `skills`.
- Add `taskTemplates` table declaration.

**`apps/api/src/lib/skill-config.ts`**
- Delete `SkillProjectConfig`, `SkillProjectStatus` types.
- Keep `SkillAgentConfig`.

**`apps/api/src/lib/bundled-skills.ts`**
- Delete `engineeringSkill`, `marketingCampaignSkill`, `salesPipelineSkill` definitions.
- Remove their exports from the bundle array.
- Move `PHASE3_TASK_TOOLS` onto the Deft Workspace bundled skill's `agent_config.tools`. Deft Workspace currently has `tools: []`; it becomes `tools: PHASE3_TASK_TOOLS`.

**New: `apps/api/src/lib/bundled-templates.ts`**
- `launchCampaignTemplate`, `reEngageSequenceTemplate` definitions.
- Export array for seeder.

**New: `apps/api/src/lib/task-status.ts`**
- Export `ENGINEERING_STATUSES` array, `ENGINEERING_STATUS_TRANSITIONS` adjacency map, `ENGINEERING_PRIORITY_VOCAB`.
- Callers: task board view, task form, any code that read these from `project_config`.

**API routes**
- `apps/api/src/routes/projects/*`: remove skill attachment from project create/update endpoints.
- Delete `apps/api/src/routes/projects/[id]/skills.ts` (if it exists — verify).
- New: `apps/api/src/routes/task-templates.ts` with list / get / instantiate endpoints.
  - `POST /api/task-templates/:id/instantiate` body: `{ project_id }` → creates tasks, returns `{ created_task_ids }`.

**Web**
- `apps/web/src/app/(app)/tasks/...project-create-modal.tsx` (or wherever it lives): strip step 2, drop the wizard altogether, collapse to single-form modal.
- `apps/web/src/app/(app)/settings/agent-employees/create/...`: collapse 5-step wizard to 3 steps. Merge old step 2 + 4. Delete old step 5.
- `apps/web/src/app/(app)/tasks/...task-create-form.tsx`: add "+ from template" button + picker modal.
- New route: `apps/web/src/app/(app)/library/page.tsx` with Skills and Templates tabs. Existing `/skills` route can redirect to `/library?tab=skills`.
- Sidebar nav entry: "Library" between "Agent" and "Settings".

**Seeders**
- Update bundled-skills seeder to skip the three deleted rows.
- New bundled-templates seeder.

### Estimated diff size

- Schema: ~25 lines removed, ~20 added.
- `skill-config.ts`: ~45 lines removed.
- `bundled-skills.ts`: ~110 lines removed.
- New bundled-templates + task-status + task-templates route: ~200 lines added.
- UI wizard collapse: ~150 lines removed (step components), ~50 added (merged step).
- Project-create modal: ~100 lines removed.
- Library page: ~200 lines added.

Net: roughly flat, possibly negative.

## Tradeoffs

**Lost:**
- Hot/Warm/Cold priority (Sales Pipeline). Collapses to p0–p3 everywhere.
- Calendar-view-default (Marketing). The view is still available via the switcher — one click.
- Per-project custom fields. Schema had a hook, no UI ever shipped, no data in the wild.
- Per-project allowed-transition graph override. Engineering's graph becomes the canonical one.

**Gained:**
- Project creation: 2 steps → 1 step.
- Agent wizard: 5 steps → 3 steps.
- `tasks.status` enum limitation resolved without migration.
- Skills becomes one primitive, one meaning, one surface.
- Templates become discoverable (catalog) instead of buried (nested jsonb).
- ~110 lines of `bundled-skills.ts` gone, ~45 lines of types gone.

## Open questions for implementation

- **Route naming.** `/library` vs. keep `/skills` and add `/templates` sibling vs. `/marketplace`. Leaning `/library` because it's a shorter word for a catalog and doesn't commit to marketplace semantics.
- **Existing skills-page.** `apps/web/src/app/(app)/skills/` already exists. Audit what it currently shows — if it's an install wizard, fold its content into `/library?tab=skills`. If it's something else, handle separately.
- **BYOA detection logic.** Where does "self-hosted mode" flag live? Env var? Org setting? Needs a grep before the wizard pre-flight gets wired.
- **Migration path: Drizzle journal vs. raw SQL.** CLAUDE.md notes the journal has been stale since 0017. Confirm the production apply path (journaled vs. `drizzle-kit push`) before writing the migration file.

These don't block the spec. They become tasks in the implementation plan.

## Non-goals

- Per-project custom statuses/priorities (option c from the brainstorm). Not building it, not painting into a corner either — if demand surfaces, add a `project_config` jsonb later with a clean purpose.
- Marketplace monetization / third-party skill/template distribution. `source: 'marketplace'` stays in the enum for future use; no code paths wire it up.
- Workflow executor expansion to skill-defined triggers (Phase 8).
- OpenClaw heartbeat autonomy (Phase 8).

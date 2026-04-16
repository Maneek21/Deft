# Task Management Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Deft's task management from "works-for-engineers-with-known-bugs" to production-deployable for the trusted-tester launch, with first-class support for non-technical workflows (marketing, sales). Zero deferrals — every audit-surfaced bug is fixed, every CLAUDE.md promise is either kept or removed from the docs, and the product stops feeling like a JIRA clone for dev teams only.

**Architecture:**
- **Fix first, build second.** Phases 0-2 close security/correctness gaps before we touch new features. Phase 3 closes the agent integration gaps surfaced in the deep audit. Phase 4 introduces Skills — the unified capability primitive that covers both agent-side (tools, prompts, triggers) and project-side (statuses, vocabulary, templates, custom fields). This is the non-technical-workflow story AND the openclaw skill-ecosystem integration point. Phase 5 wires cross-surface integrations. Phase 6 handles UX polish. Phase 7 is QA + deploy. Phase 8 activates OpenClaw's intended 24/7 autonomous lifecycle — extending the heartbeat pattern to deployed OpenClaw agents so they proactively check and act on their own cadence instead of only responding when Deft pings.
- **Schema-additive, not rewriting.** `tasks` table stays as-is; new capabilities land via new columns (`projects` gets no `skill_id` — we use a junction `project_skills` instead for multi-skill-per-project support) + extending the existing `skills` table (currently skeletal at `packages/db/src/schema.ts:405-418`) rather than creating a new one.
- **Unify existing primitives into Skills rather than invent new ones.** The audit found we already have 60% of the skill primitive shipped under different names: `agentEmployees.capability_packs[]`, `agentEmployees.trigger_subscriptions[]`, `agentEmployeeTemplates.source` (first-party|community|user). Phase 4 unifies these under the existing `skills` table + new junctions (`agent_employee_skills`, `project_skills`).
- **Multica-inspired patterns adopted:** agents-as-first-class-assignees on the board, proactive agent comments on blockers, live agent progress streaming on task detail, shareable skills primitive. NOT adopted: CLI runtime management, local daemons, multi-CLI agent registry — Deft stays Anthropic + MCP + OpenClaw.
- **OpenClaw stays strictly agent-runtime, not a skill marketplace.** Bundled + marketplace + org-authored skills live in Deft's own registry. OpenClaw skill markdown files can be imported into Deft's marketplace tier via an adapter.

**Tech Stack:** TypeScript strict, Drizzle ORM, Postgres + pgvector, Hono API, Next.js 14, TipTap, Socket.io, `node:test` harness, Playwright audits under `docs/superpowers/audits/`.

**Scope boundaries:**
- **In scope:** All task-management bugs from the shallow + deep audits (~40 items), agent-task integration gaps, non-technical workflow UX (Skills, vocab/view overrides), cross-surface consistency, doc/reality drift fixes, OpenClaw autonomous-agent heartbeat lifecycle (Phase 8), Playwright audit suite for the new surface.
- **Out of scope:** Full CRM (contacts + accounts as first-class entities beyond minimal attachment), Zapier-level workflow builder, Airtable-level custom-field UI, full calendar scheduling engine (we display due dates; users manage them in the task detail), migrating the `/calendar` page into `/tasks?view=calendar` (they stay distinct — `/calendar` is the human-user personal calendar with future Google/Outlook/Apple sync).
- **Not doing:** Cutting `tasks.assignee_id` in favor of only `taskAssignees` (keeping singular as "primary assignee" + junction for "also assigned to" multi-assignees). Rewriting the `tasks.ts` route as microservices. Replacing `PREFIX-N` IDs with UUIDs in the UI (hiding them for non-eng projects is sufficient). Rewriting the OpenClaw integration from scratch — we extend the existing dispatch + heartbeat pattern, we don't replace it.

**Assumptions:**
- Current branch is `feat/phase2-4-mcp-agents-plans`. All work lands there, deploys to both api + web Railway services (the gap we hit in the knowledge-hub hotfix).
- Prod Neon has pgvector + all current migrations applied (0020-0024).
- `OPENAI_API_KEY` on Railway, `ANTHROPIC_API_KEY` on Railway. No new API keys needed.
- Trusted-tester cohort is ~5 people. We're not solving for 1000-user-org scale — we're solving for "usable and correct for 5-50 active users."
- The working tree has uncommitted April 14 wip on `task-board.tsx`, `task-card.tsx`, `task-filters.tsx`, `task-list.tsx`, `task-quick-create.tsx`. **Phase 0 prerequisite: reconcile this wip** (commit as a "wip carry-forward" OR stash cleanly) before any Phase 0 subagent runs, to avoid the bundling problem we hit with `memory-extract.ts` earlier.

---

## Design decisions baked in

These are the calls we've already made. Any task in this plan that would touch these must respect them — if a new constraint emerges during implementation that would force a different choice, escalate before deviating.

1. **Skills (vocabulary).** We use "Skills" — the term is already in the schema, aligns with the AI-landscape and openclaw ecosystem. No rename to "Playbooks" or similar.
2. **Unified skill concept.** A skill bundles *both* agent-side capability (tools, prompts, triggers, capability packs) and project-side config (statuses, vocabulary, custom fields, templates). Either side can be empty — an agent-only skill is fine, a project-only skill is fine.
3. **Three source tiers.** `bundled` (shipped by Deft), `marketplace` (community + openclaw-imported), `org` (authored internally). Stored in a unified `skills` table with a `source` field. Global table + fork-on-customize semantics with update-notification model: when we ship a new bundled/marketplace version, installed copies show "update available" rather than auto-propagating.
4. **Extend the existing `skills` table** (schema.ts:405-418), don't create a new one. Old columns (`system_prompt`, `param_schema`) fold into `agent_config` JSONB.
5. **Multiple skills per agent AND multiple skills per project.** Flat arrays (`agent_employee_skills` junction, `project_skills` junction). For UI-exclusive project config (statuses, priority vocab, default view, hide_prefix_ids), first-attached-wins — no primary flag. For additive config (custom fields, task templates, allowed_transitions, agent tools, trigger subscriptions), union.
6. **Optional `allowed_transitions` per skill.** Engineering skill ships strict transitions; Marketing/Sales ship no transition rules (any-status-to-any-status within the skill's status set). Validator: `isValidTransition(from, to, projectResolvedConfig)` — must exist in status set + must be allowed if rules present.
7. **Hybrid install model.** Runtime-installable config (prompts, project workflow, trust overrides, native Deft tools) applies instantly. Deploy-time-pinned config (capability_packs = MCP servers + openclaw plugins) triggers a re-provision job for openclaw-hosted agents; for native agents they're runtime-installable too. UI prompts user honestly when redeploy is required.
8. **JIT install.** When an agent is invoked for a task in a project that requires skill X, if the agent lacks X, auto-install for `bundled` + `org` skills, prompt for `marketplace` skills. Import of an openclaw skill also goes through the marketplace security prompt on first install.
9. **Verb-first agent tool naming.** `list_my_tasks` (not `my_tasks`), `set_priority` (not `change_priority`), `comment_on_task`, `set_due_date`, `add_label`, `close_task`, `reopen_task`, `add_dependency`.
10. **Calendar stays distinct.** `/calendar` is the human-user personal calendar (Google/Outlook/Apple sync on the roadmap; renders tasks + notes with dates). `/tasks?view=calendar` is a new, project-scoped timeline component. Separate implementations, no shared component.
11. **OpenClaw usage.** OpenClaw is an autonomous agent runtime, not just an LLM endpoint. Phase 8 activates the heartbeat-driven proactive behavior the OpenClaw framework was built around. Current "request/response only" treatment is a known bug — we're fixing it.
12. **Trigger subscription conflicts.** Multiple skills on the same agent declaring the same trigger → dedupe (no duplicate firing). Multiple agents in org claiming the same trigger → first-installed-wins (current behavior in `agent-deploy.ts:166-189`, preserved). Installing a skill that would create a trigger conflict → prompt to reassign rather than silently block.
13. **Dead primitives to remove as part of this plan.** `agentEmployees.native_tools[]` (unused per audit). `TEMPLATE_DEFAULT_PACKS` hashmap in `capability-packs.ts:220-229` (deprecated in the legacy agent-employees phase-9 cleanup comment on that same branch; that legacy numbering is unrelated to this plan's Phase 8).

---

## Surface map (current state)

| Surface | Audit status | Critical issues |
|---|---|---|
| `/tasks` UI | Engineering-coded; dead UI; no status filter; board hides Cancelled; label mismatch | Phase 1 |
| `tasks.ts` routes | 2 endpoints missing auth; DELETE too permissive; N+1 on detail; project_id mutable w/o renumber | Phase 0, 2 |
| Schema | Dual assignee source; no status transitions; enums missing; PK missing; FKs missing | Phase 0, 2 |
| Agent tools | Only 3 write tools; fuzzy resolution; agents unassignable; no source_message_id; no comment; no progress | Phase 3 |
| Cross-ref worker | Silent failures; no atomic insert; no inline chat card | Phase 2, 3 |
| Dashboard widgets | "My Work" mislabeled (no assignee filter); merged overdue/today visuals | Phase 0 |
| Notifications | Icon map missing `agent_suggestion`; no grouping on bulk | Phase 0, 5 |
| Calendar | No live update on `task:updated`; stale due dates | Phase 5 |
| GitHub integration | PR→Done promised in CLAUDE.md, not implemented | Phase 5 |
| Recurrence | Spawner live, no UI, no label cloning | Phase 4 |
| Templates | API live, zero UI | Phase 4 |
| Workflows | CRUD only, no executor | Phase 5 |
| Skills primitive | Skeletal `skills` table exists (schema.ts:405-418) but disconnected; capability_packs + trigger_subscriptions + template.source overlap | Phase 4 (unify + extend) |
| OpenClaw runtime | Container runs 24/7 but treated as stateless chat-completions API; heartbeat disabled for openclaw agents | Phase 8 (activate autonomy) |
| Project archive/delete | DB supports, no UI | Phase 5 |

---

## Phase 0: Security + data-integrity hotfixes

Must ship before any other work. These are multi-tenant-leak or silent-wrong-data bugs.

### Task 0.1: Auth + org scoping on `watchers` + `assignees` GET endpoints

**Files:**
- Modify: `apps/api/src/routes/tasks.ts` (GET `/api/tasks/:id/watchers` at ~L467, GET `/api/tasks/:id/assignees` at ~L550)
- Create: `apps/api/test/tasks-watchers-assignees-auth.test.ts`

- [ ] Write failing test: call both endpoints with no auth → expect 401; call as user from another org → expect 404; call as legit user → expect 200 with data
- [ ] Run test, confirm failures
- [ ] Add `const user = c.get('user'); if (!user) return c.json({error:'Unauthorized',code:'UNAUTHORIZED'},401);` to both handlers
- [ ] Add `await getTaskForOrg(taskId, user.org_id)` check before any data return; if null → 404
- [ ] Re-run tests, confirm pass
- [ ] Commit: `fix(tasks): add auth + org check to watchers/assignees GET endpoints`

### Task 0.2: Permission guard on DELETE + define status transitions

**Files:**
- Modify: `apps/api/src/routes/tasks.ts` (DELETE `/api/tasks/:id` ~L1499; PATCH status section ~L1221)
- Create: `apps/api/src/lib/task-permissions.ts`
- Create: `apps/api/src/lib/task-status-machine.ts`
- Create: `apps/api/test/task-permissions.test.ts`

- [ ] Write `apps/api/src/lib/task-permissions.ts` with `canDeleteTask(user, task, orgRole)` — rule: creator OR assignee_id OR org role='owner'|'admin' → true, else false
- [ ] Write `apps/api/src/lib/task-status-machine.ts` with `isValidTransition(from, to, projectResolvedConfig): boolean`. Rules:
  - If `to` is not in the project's resolved skill config status set → invalid (unknown status)
  - If `projectResolvedConfig.allowed_transitions` is present → `to` must be in `allowed_transitions[from]` (or `from == to` no-op)
  - If `allowed_transitions` absent → any-to-any within the skill's status set is allowed
  - The Engineering bundled skill (Phase 4.1) ships with strict rules: backlog→todo/in_progress/cancelled, todo→in_progress/backlog/cancelled, in_progress→in_review/done/backlog/cancelled, in_review→in_progress/done/cancelled, done→in_progress/backlog, cancelled→backlog
  - Marketing + Sales skills ship without allowed_transitions (fluid any-to-any)
- [ ] Write tests for both helpers — cover: strict-Engineering allowed + disallowed + unknown status + fluid-Marketing any-to-any
- [ ] Wire `canDeleteTask` into DELETE handler; 403 on failure with `{error, code: 'FORBIDDEN'}`
- [ ] Wire `isValidTransition` into PATCH handler; load project's resolved config (skills' union of statuses + first-attached transitions) via `getProjectResolvedConfig(project_id)` helper (shipped in Task 4.5); 400 on invalid with `{error, code: 'INVALID_TRANSITION'}`
- [ ] Note: project resolved config helper doesn't exist until Task 4.5 ships. For Phase 0.2, implement an interim `getProjectResolvedConfig` that falls back to the Engineering-skill statuses when no skill attached. Task 4.5 replaces the interim with the real resolver.
- [ ] Run tests, confirm pass
- [ ] Commit: `fix(tasks): delete permission guard + skill-aware status transition validator`

### Task 0.3: Resolve assignee dual source of truth

**Design decision:** Keep `tasks.assignee_id` as **primary assignee** (singular — used by board columns, dashboard "My Tasks", nudge targeting). Keep `taskAssignees` table for **additional assignees** (shown as extra avatars on the card). Every task has exactly one primary assignee (or null); zero or more additional assignees.

**Files:**
- Modify: `packages/db/src/schema.ts` (docs on both fields)
- Modify: `apps/api/src/routes/tasks.ts` (POST/PATCH multi-assignee endpoints at ~L500-566)
- Modify: `apps/web/src/components/task-card.tsx`, `apps/web/src/components/task-detail.tsx` — render primary + additional
- Create: `apps/api/test/task-assignee-model.test.ts`

- [ ] Add JSDoc to `tasks.assignee_id` schema field: `@see Phase 0.3 plan — primary assignee; use taskAssignees for additional`
- [ ] Add JSDoc to `taskAssignees` table: `@see Phase 0.3 — additional (non-primary) assignees; do not duplicate tasks.assignee_id here`
- [ ] In POST `/api/tasks/:id/assignees`: validate that the user_id being added ≠ current `tasks.assignee_id`; if it IS the primary, return 409 `{error, code: 'ALREADY_PRIMARY_ASSIGNEE'}`
- [ ] In DELETE `/api/tasks/:id/assignees/:userId`: succeed only if the user is in `taskAssignees` (not if they're the primary)
- [ ] Add a new PATCH `/api/tasks/:id` flow: if request body contains `assignee_id`, also remove that user from `taskAssignees` if present (prevents duplication when promoting to primary)
- [ ] Update `task-card.tsx` to render primary avatar prominently + up to 2 secondary avatars with `+N` overflow
- [ ] Update `task-detail.tsx` assignee section: "Primary: X • Additional: Y, Z"
- [ ] Write test covering primary/additional rules
- [ ] Commit: `refactor(tasks): define primary vs additional assignees; enforce no duplication`

### Task 0.4: Dashboard "My Work" assignee filter

**Files:**
- Modify: `apps/api/src/routes/dashboard.ts` — find the `allWork` aggregation (should be around the dashboard summary response)
- Modify: `apps/web/src/app/(app)/dashboard/page.tsx` (L456 where `allWork` is built)
- Create: `apps/api/test/dashboard-my-work.test.ts`

- [ ] Write test: seed user A with 3 in_progress tasks assignee_id=A, seed user B with 5 tasks assignee_id=B in same org; call GET /api/dashboard as A; assert `my_work.length === 3` and all have assignee_id=A
- [ ] Run test, confirm failure
- [ ] In dashboard API: change the "my_work" query to filter `WHERE assignee_id = :currentUserId OR id IN (SELECT task_id FROM task_assignees WHERE user_id = :currentUserId)` (include additional assignees per Phase 0.3)
- [ ] Update frontend to read `my_work` key and drop the `allWork` merging
- [ ] Test passes
- [ ] Commit: `fix(dashboard): "My Work" kanban actually filters by assignee`

### Task 0.5: Notification icon map includes `agent_suggestion`

**Files:**
- Modify: `apps/web/src/components/notification-panel.tsx` (icon map ~L20-30)

- [ ] Add `agent_suggestion` → `Sparkles` (or similar "AI" icon from lucide-react) to the type → icon map
- [ ] Add click handler: agent_suggestion notifications navigate to `/chat?messageId=<m>` (the source message), not `/tasks`
- [ ] No test (trivial render); manual verification sufficient
- [ ] Commit: `fix(notifications): icon + click handler for agent_suggestion`

### Task 0.6: PATCH `/api/tasks/:id` project_id — reject, don't silently break cross-refs

**Decision:** Cross-references store PREFIX-N; changing project_id breaks them. Simpler to reject the change and require delete+recreate, OR accept it and renumber. **We'll reject** — it's the safer default and avoids breaking every chat message that references the task.

**Files:**
- Modify: `apps/api/src/routes/tasks.ts` (PATCH handler ~L1191-1493)
- Modify: `apps/api/test/tasks-patch.test.ts` (or create)

- [ ] In the PATCH handler, if body contains `project_id` AND `project_id !== existing.project_id`, return 400 `{error: 'Project change is not supported — delete and recreate the task in the target project', code: 'PROJECT_CHANGE_UNSUPPORTED'}`
- [ ] Remove `project_id` from the Zod schema accepted-fields list
- [ ] Write a test that asserts the 400
- [ ] Commit: `fix(tasks): reject project_id change in PATCH to preserve cross-refs`

---

## Phase 1: Visible-bug triage (ships alongside Phase 0)

### Task 1.1: Standardize status labels to "To Do"

**Decision:** We pick `"To Do"` (with space) as canonical — more readable, widely used in PM tools. Store as `todo` in DB (unchanged), render as `To Do` everywhere.

**Files:**
- Modify: `apps/web/src/components/task-board.tsx:77` (change `'Todo'` → `'To Do'`)
- Modify: `apps/web/src/components/task-list.tsx:52` (same)
- Modify: `apps/web/src/components/task-detail.tsx:166` (already `'To Do'` — verify)
- Modify: any other file with hardcoded `'Todo'` string — grep first
- Create: `apps/web/src/lib/task-status-labels.ts` — single source of truth

- [ ] `grep -rn "'Todo'" apps/web/src/` — collect all hits
- [ ] Create `apps/web/src/lib/task-status-labels.ts`:
  ```ts
  export const STATUS_LABELS = {
    backlog: 'Backlog',
    todo: 'To Do',
    in_progress: 'In Progress',
    in_review: 'In Review',
    done: 'Done',
    cancelled: 'Cancelled',
  } as const;
  export type TaskStatus = keyof typeof STATUS_LABELS;
  export function statusLabel(s: string): string { return STATUS_LABELS[s as TaskStatus] ?? s; }
  ```
- [ ] Replace every hardcoded status-label map across components with `statusLabel(entry.status)`
- [ ] Commit: `fix(tasks): standardize status labels to "To Do" via single source`

### Task 1.2: Include Cancelled in board view

**Files:**
- Modify: `apps/web/src/components/task-board.tsx:67-73`

- [ ] Extend the column array from 5 to 6 (append Cancelled column after Done)
- [ ] Cancelled column gets the same visual treatment as others but collapsed by default (use details/summary OR a collapse button)
- [ ] Collapsed state persists in localStorage key `tasks:cancelled-collapsed`
- [ ] Commit: `feat(tasks): include Cancelled column in board, collapsed by default`

### Task 1.3: Add status filter to `TaskFilters`

**Files:**
- Modify: `apps/web/src/components/task-filters.tsx`
- Modify: `apps/web/src/app/(app)/tasks/page.tsx` (filter state)

- [ ] Add `status: string[]` to the `Filters` type; empty array = show all
- [ ] Render a multi-select control in the filter bar, using the 6 statuses from `STATUS_LABELS`
- [ ] In page.tsx, apply the filter: `if (filters.status.length > 0 && !filters.status.includes(task.status)) return false;`
- [ ] Commit: `feat(tasks): add status filter to TaskFilters`

### Task 1.4: Wire Socket.io listeners for `task:created` / `task:updated`

**Files:**
- Modify: `apps/web/src/app/(app)/tasks/page.tsx`
- Modify: `apps/web/src/components/task-detail.tsx`
- Modify: `apps/web/src/app/(app)/calendar/page.tsx` (from deep-audit I4 — same fix)

- [ ] In `/tasks` page, add a `useEffect` that subscribes to `task:created`, `task:updated`, `task:deleted` on the socket. Action: refetch the task list OR merge the payload into local state if it's in-scope for the active project filter.
- [ ] In `task-detail.tsx`, subscribe for the currently-open task_id. On `task:updated` matching the ID, reload the detail fetch (or merge fields from payload).
- [ ] Same for `/calendar` — subscribe to `task:updated`, refetch the current date-range query on relevant events.
- [ ] All unsubscribes in cleanup.
- [ ] Commit: `feat(tasks): live socket updates for list, detail, calendar`

### Task 1.5: Dead UI — decision point

**Three dead UI items:** label filter, date-range picker, saved views. Decision: **build all three** — they're all wired in state, the surgery to expose them is small, and trusted testers will use them.

**Files:**
- Modify: `apps/web/src/components/task-filters.tsx`

- [ ] Add the label multi-select control (reuse the label picker pattern from task-detail)
- [ ] Add date-range picker (use browser native `<input type="date">` for from/to)
- [ ] Add the Saved-Views button that opens a dropdown of `handleLoadView` results + a "Save current filter set as…" option calling `handleSaveView`
- [ ] Commit: `feat(tasks): complete filter UI (labels, date range, saved views)`

### Task 1.6: Timezone-aware "due today" everywhere

**Files:**
- Modify: `apps/api/src/lib/task-dates.ts` (new) — helper for "is this date within :tz day X relative to :now"
- Modify: `apps/api/src/routes/tasks.ts` — any `due_date < NOW()` / `<= NOW()` queries
- Modify: `apps/api/src/services/manager-pulse.ts` overdue count
- Modify: `apps/api/src/services/oneone-prep.ts` overdue filter
- Modify: `apps/api/src/routes/calendar.ts`
- Modify: `apps/api/src/workers/handlers/nudge-check.ts`

- [ ] Create `task-dates.ts` with `isDueToday(due_date, orgTz)`, `isOverdue(due_date, orgTz)`, `isDueWithinDays(due_date, orgTz, n)`. Use `Intl.DateTimeFormat(orgTz)` to bucket by calendar day.
- [ ] Replace raw `<` / `BETWEEN` comparisons on `due_date` with calls to these helpers in the listed files
- [ ] `orgs.timezone` already exists at `schema.ts:49` (`text('timezone').default('UTC').notNull()`) — no migration needed; just consume it via `getOrgTimezone(orgId)` helper
- [ ] Write a test asserting a task due at 23:00 UTC is "due today" for a user in `America/Los_Angeles` (which would be 16:00 local)
- [ ] Commit: `fix(tasks): org-timezone-aware due-date comparisons`

### Task 1.7: Unified `<TaskCard>` component

**Files:**
- Create: `apps/web/src/components/task-card-unified.tsx` — accepts a `task` and `variant: 'board' | 'list' | 'chat' | 'calendar' | 'dashboard' | 'notification'`
- Modify: callers to use the new component (or a thin wrapper)

- [ ] Extract the rendering logic from the current `task-card.tsx` board variant as the default
- [ ] Add variant-specific overrides (e.g. `variant='chat'` renders a pill with title + status chip; `variant='notification'` renders title + due date + a View button)
- [ ] Migrate `task-card.tsx` to be a thin wrapper that passes `variant='board'`
- [ ] Migrate `task-list.tsx` row renderer to use `variant='list'`
- [ ] Migrate chat cross-reference renderer in `space-chat.tsx` to use `variant='chat'`
- [ ] Migrate dashboard widgets (Today, My Work, Overdue) to use `variant='dashboard'`
- [ ] Migrate notification-panel to use `variant='notification'` for task-typed notifications
- [ ] Commit: `refactor(tasks): unify TaskCard across board/list/chat/calendar/dashboard/notification`

---

## Phase 2: Schema correctness + worker hardening

### Task 2.1: Status transition state machine (already in 0.2)

Covered in Task 0.2. Skip this task; keep number for reference.

### Task 2.2: `taskRelationships.type` pgEnum

**Files:**
- Modify: `packages/db/src/schema.ts` (taskRelationships definition)
- Create: `packages/db/drizzle/0025_task_relationship_type_enum.sql`

- [ ] Add pgEnum `task_relationship_type = 'blocks' | 'blocked_by' | 'relates_to' | 'duplicates'`
- [ ] Migration: `DO $$ BEGIN CREATE TYPE task_relationship_type AS ENUM (...); EXCEPTION WHEN duplicate_object THEN null; END $$;` then `ALTER TABLE task_relationships ALTER COLUMN type TYPE task_relationship_type USING type::task_relationship_type;`
- [ ] Handle existing bad values (run `UPDATE task_relationships SET type='relates_to' WHERE type NOT IN ('blocks','blocked_by','relates_to','duplicates');` first)
- [ ] Apply to local dev DB
- [ ] Commit

### Task 2.3: `notifications.type` pgEnum

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0026_notification_type_enum.sql`

- [ ] Grep codebase for all `notifications.type` write values to build the enum set: `task | task_assigned | task_updated | agent_suggestion | mention | message | reminder | huddle_started | system | blocked | cross_reference` (add any I missed)
- [ ] Same migration pattern as 2.2
- [ ] Commit

### Task 2.4: `taskLabels` primary key

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0027_task_labels_pk.sql`

- [ ] Add `id text primary key default ...createId()` OR promote the existing unique index `(task_id, label_id)` to primary key
- [ ] Prefer the composite PK since there's no need for a synthetic id: `ALTER TABLE task_labels ADD PRIMARY KEY (task_id, label_id);`
- [ ] Drop the redundant unique index after
- [ ] Commit

### Task 2.5: `org_id` on `taskComments` + `taskActivity`

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0028_task_child_tables_org_id.sql`
- Modify: `apps/api/src/routes/tasks.ts` routes that insert into these tables

- [ ] Add `org_id text not null` column (initially nullable for backfill)
- [ ] Backfill: `UPDATE task_comments SET org_id = (SELECT org_id FROM tasks WHERE tasks.id = task_comments.task_id);` same for task_activity
- [ ] After backfill, `ALTER COLUMN org_id SET NOT NULL`
- [ ] Add index `(org_id, task_id)` for efficient org-scoped scans
- [ ] Update every INSERT in tasks.ts to pass `org_id: user.org_id`
- [ ] Commit

### Task 2.6: `parent_task_id` FK to self

**Files:**
- Modify: `packages/db/src/schema.ts` (tasks.parent_task_id)
- Create: `packages/db/drizzle/0029_tasks_parent_fk.sql`

- [ ] Add `REFERENCES tasks(id) ON DELETE SET NULL` to parent_task_id
- [ ] Migration: clean orphans first (`UPDATE tasks SET parent_task_id = null WHERE parent_task_id IS NOT NULL AND parent_task_id NOT IN (SELECT id FROM tasks);`), then `ALTER TABLE tasks ADD CONSTRAINT fk_tasks_parent FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL;`
- [ ] Commit

### Task 2.7: Circular dependency check on POST dependencies

**Files:**
- Modify: `apps/api/src/routes/tasks.ts` (POST `/api/tasks/:id/dependencies` ~L1650+)
- Create: `apps/api/test/task-dependency-cycles.test.ts`

- [ ] Write `detectCycle(fromId, toId, type, orgId)`: BFS from `toId` through `task_relationships` of type `blocks`/`blocked_by`; if we reach `fromId`, cycle detected
- [ ] Invoke before insert; if cycle → 400 `{error, code: 'DEPENDENCY_CYCLE'}`
- [ ] Write test seeding A→B, B→C, then attempting C→A; expect 400
- [ ] Commit

### Task 2.8: `duplicate-detect` atomic insert + dedup table

**Files:**
- Modify: `apps/api/src/workers/handlers/duplicate-detect.ts`
- Create: `packages/db/drizzle/0030_duplicate_flags.sql`
- Modify: `packages/db/src/schema.ts`

- [ ] Add `duplicate_flags` table: `(id, org_id, task_a_id, task_b_id, similarity, created_at, unique(task_a_id, task_b_id))` — unique constraint covers both orders via a CHECK `task_a_id < task_b_id` (lexicographic sort before insert)
- [ ] In worker: before creating a notification, INSERT into duplicate_flags with ON CONFLICT DO NOTHING; if insert-count was 0, skip the notification (already flagged)
- [ ] Commit

### Task 2.9: Workload dedup keyed by admin role

**Files:**
- Modify: `apps/api/src/workers/handlers/nudge-check.ts` (workload imbalance section ~L444-450)

- [ ] Change dedup key from `user_id = overloaded.assignee_id` to `nudge_type = 'workload_imbalance'` + `metadata.overloaded_user_id = <user>` + `metadata.admin_user_id = <admin>`
- [ ] For each overloaded user, for each admin in org: check if a workload_imbalance nudge was sent to this admin about this user in the last 7 days; skip if yes
- [ ] Write test covering 2 admins scenario
- [ ] Commit

### Task 2.10: `cross-reference` atomic insert + unresolved-ref telemetry

**Files:**
- Modify: `apps/api/src/workers/handlers/cross-reference.ts`

- [ ] Replace check-then-insert with `INSERT ... ON CONFLICT (source_type, source_id, target_type, target_id) DO NOTHING`
- [ ] Add unique constraint via migration `0031_cross_references_unique.sql` — `CREATE UNIQUE INDEX IF NOT EXISTS cross_references_quad_idx ON cross_references(source_type, source_id, target_type, target_id);` (idempotent; constraint is required for ON CONFLICT to work, so this migration is NOT conditional)
- [ ] When a matched PREFIX-N doesn't resolve to a real task, log a `[cross-reference] unresolved-ref messageId=X prefix=Y number=Z` warning (structured for future observability hook)
- [ ] Commit

---

## Phase 3: Agent task integration (deep-audit gaps + multica patterns)

### Task 3.1: Agent employees are assignable

**Files:**
- Modify: `apps/api/src/lib/agent-actions.ts:322` (resolveUser)
- Modify: `apps/api/src/lib/agent-context.ts:178` (same helper in different file — consolidate)
- Create: `apps/api/src/lib/resolve-assignee.ts` — single canonical implementation

- [ ] Create `resolveAssignee(nameOrId, orgId): { id, name, is_agent, kind: 'user'|'agent' } | null`
- [ ] First check exact match on users.name WHERE is_agent=true OR org_members.user_id=user.id (both paths)
- [ ] If no exact match, fall back to `ilike '%name%'` BUT enforce: if multiple rows match, return null + log warning + let the agent tool return `{ error: 'Ambiguous name', matches: [...] }` to the LLM
- [ ] If the resolved user is `is_agent=true` but not in org_members, accept it IF they're tied to this org via `agent_employees.org_id`
- [ ] Replace both call sites
- [ ] Write tests: single exact, multiple partial, agent-employee-only, not found
- [ ] Commit

### Task 3.2: `source_message_id` threaded through agent-created tasks

**Files:**
- Modify: `apps/api/src/lib/agent-actions.ts` (create_task path)
- Modify: `apps/api/src/lib/agent-plans.ts` (plan step invoking create_task)
- Modify: `apps/api/src/workers/handlers/agent-reply.ts` (passes message context)

- [ ] `create_task` accepts new optional field `source_message_id`; if present, writes to `tasks.source_message_id`
- [ ] In `agent-reply` → `runAgentQuery`, thread the triggering `messageId` into the tool-call context so `create_task` can pick it up automatically
- [ ] In `agent-plans.ts` plan-execution path, thread the plan's originating `conversation_id` + if conversation is tied to a message, pass `source_message_id`
- [ ] Commit

### Task 3.3: `taskActivity` agent attribution via `agentActions` link

**Files:**
- Modify: `packages/db/src/schema.ts` (taskActivity)
- Create: `packages/db/drizzle/0032_task_activity_agent_ref.sql`
- Modify: `apps/api/src/lib/agent-actions.ts` (where taskActivity rows are inserted)

- [ ] Add `agent_action_id text references agent_actions(id)` nullable column on `task_activity`
- [ ] Add `acting_agent_employee_id text references agent_employees(id)` nullable column
- [ ] When an agent invokes `executeActionDirect` and it writes a taskActivity row, set both fields
- [ ] Update `/api/tasks/:id/activity` to return these fields
- [ ] In `task-detail.tsx` activity tab, render agent-authored entries as "Alex (AI) changed status to In Progress" with a subtle AI badge
- [ ] Commit

### Task 3.4: New agent tools — comment_on_task, set_due_date, set_priority, add_label

**Files:**
- Modify: `apps/api/src/lib/agent-tools.ts` (tool declarations)
- Modify: `apps/api/src/lib/agent-actions.ts` (implementations)
- Modify: `apps/api/src/lib/agent-approval.ts` (tier assignments)
- Create: `apps/api/test/agent-tools-task-mutations.test.ts`

**Approval tiers (per agent-approval.ts pattern):**
- `comment_on_task` → `quick` (public visibility; user may want a preview)
- `set_due_date` → `auto` (low risk)
- `set_priority` → `auto`
- `add_label` → `auto`

- [ ] Add 4 new tool definitions in `AGENT_TOOLS` with Anthropic Tool shape
- [ ] Add 4 new cases in `ACTION_TOOLS` set
- [ ] Add 4 new tier entries in `TOOL_APPROVAL_TIERS`
- [ ] Implement each in `agent-actions.ts` — use the resolveAssignee helper (Task 3.1) for `assignee_name` when relevant
- [ ] Each writes `taskActivity` with proper agent attribution (Task 3.3)
- [ ] Each broadcasts `task:updated` socket event
- [ ] Write 4+ tests
- [ ] Commit

### Task 3.5: `close_task` + `reopen_task`

**Files:**
- Same as 3.4

- [ ] Thin wrappers around `update_task_status`: `close_task` = set status=done; `reopen_task` = set status=todo
- [ ] Tier `auto` for both
- [ ] Commit

### Task 3.6: `add_dependency` + `remove_dependency` with cycle guard

**Files:**
- Same pattern

- [ ] Tool inputs: `source_task_identifier`, `target_task_identifier`, `type: 'blocks'|'blocked_by'|'relates_to'|'duplicates'`
- [ ] Use `detectCycle` from Task 2.7; on cycle, return error to LLM
- [ ] Tier `quick`
- [ ] Commit

### Task 3.7: `list_my_tasks` tool (default caller scope)

**Files:**
- Same pattern

- [ ] Name: `list_my_tasks` (verb-first per design decision #9)
- [ ] Accepts optional `status` filter; defaults to `status != 'done' AND status != 'cancelled'`
- [ ] Resolves caller via ctx.userId; no `assignee_name` param required
- [ ] Returns the same shape as `search_tasks` — plus any additional-assignee matches
- [ ] Tier: n/a (read)
- [ ] Commit

### Task 3.8: Semantic task search via retrieveContext

**Files:**
- Modify: `apps/api/src/lib/retrieve-context.ts` (add `'tasks'` to type union + new `fetchTasks` branch)
- Modify: `apps/api/src/lib/agent-context.ts` `search_tasks` case — consult retrieveContext for fuzzy/semantic before falling back to SQL
- Modify: `apps/api/src/workers/handlers/embed-content.ts` — handle `source_type: 'task'`

- [ ] Add `task` to ContextSource type; add embedding column to `tasks` table + migration 0033 (`embedding vector(1536)`)
- [ ] Add a GIN search_vector column (or computed column) to tasks for FTS on title + description; or reuse the search_vector pattern from wiki_pages
- [ ] Extend embed-content worker to embed task title+description when `source_type='task'`
- [ ] In retrieveContext, fetchTasks branch: hybrid FTS + vector on tasks, filter by org_id + is_deleted
- [ ] Update `search_tasks` tool: first call retrieveContext({types:['tasks']}), then merge with SQL-filtered results (status/priority/assignee)
- [ ] Backfill existing tasks with embeddings via `backfill-task-embeddings.ts` script
- [ ] Commit

### Task 3.9: Plan fail-fast mode + orphan cleanup

**Files:**
- Modify: `apps/api/src/lib/agent-plans.ts` (~L284-289 failure handling)

- [ ] Add `fail_fast: boolean` field to `agent_plans` schema (default false for back-compat)
- [ ] When `fail_fast=true`: on step failure, mark all later steps as 'skipped_due_to_failure' and stop execution
- [ ] Add `rollback_on_fail: boolean` (default false) — when true AND fail_fast: for each successful write action, attempt to reverse it (e.g., a created task gets soft-deleted)
- [ ] Plan create UI (or LLM prompt) exposes these options
- [ ] Commit

### Task 3.10: Live agent progress streaming on task detail

**Files:**
- Modify: `apps/api/src/lib/agent-plans.ts` — emit progress events per step
- Modify: `apps/api/src/lib/agent-runner.ts` — emit for agent-employee-task flows
- Modify: `apps/web/src/components/task-detail.tsx` — subscribe + render progress strip
- Modify: `apps/api/src/lib/socket.ts` (server) — define event

- [ ] Server: on each plan step start + complete + fail, `io.to(\`org:${orgId}\`).emit('task:agent_progress', {task_id, agent_employee_id, step_index, step_description, status, total_steps})`
- [ ] Client: task-detail subscribes on mount; shows a compact strip above Description when progress is active: "Alex (AI) is on step 3 of 6: Drafting the first section"
- [ ] Strip auto-dismisses 5s after 'complete' or 'fail' (fail state shows the error for 30s)
- [ ] Commit

### Task 3.11: Proactive agent comments from nudge-check + task-extract

**Files:**
- Modify: `apps/api/src/workers/handlers/nudge-check.ts`
- Modify: `apps/api/src/workers/handlers/task-extract.ts`

- [ ] Nudge-check: for each stalled/overdue task, if org has an agent employee subscribed to the relevant trigger, post a comment on the task AS that agent (via the new `comment_on_task` tool's internal implementation) with a brief structured note: "Noticed this has been in In Progress for 48h without updates — is there a blocker?"
- [ ] Task-extract: if the suggestion is auto-accepted (future: autonomous trust), the created task gets an agent comment explaining which message it came from
- [ ] Commit

### Task 3.12: Inline chat suggestion card

**Files:**
- Modify: `apps/web/src/components/space-chat.tsx` (consume the `agent:task_suggestion` event listener at L776)
- Create: `apps/web/src/components/task-suggestion-card.tsx`

- [ ] When a task_suggestion arrives for a visible message, render a compact card below the message: "Alex suggests: Create task 'X' — [Create] [Edit] [Dismiss]"
- [ ] Create button → POST /api/projects/:projectId/tasks; Edit → opens task-quick-create pre-filled; Dismiss → PATCH the notification to mark dismissed
- [ ] Card disappears on any of the three actions
- [ ] Persist dismissed state so re-renders don't re-show
- [ ] Commit

---

## Phase 4: Skills — unified capability primitive + non-technical workflows

**Key architectural context (from the agent-employees audit):** the existing `skills` table at `packages/db/src/schema.ts:405-418` is skeletal (only `name/slug/system_prompt/param_schema/usage_count`) and unused by any route/worker today. **We extend this existing table rather than create a new one.** 60% of the skill primitive already exists under different names (`agentEmployees.capability_packs[]`, `agentEmployees.trigger_subscriptions[]`, `agentEmployeeTemplates.source`). Phase 4 unifies them.

### Task 4.1: Extend `skills` table + define the unified shape

**Files:**
- Modify: `packages/db/src/schema.ts` (existing `skills` table starting at line 405)
- Create: `packages/db/drizzle/0035_skills_extend.sql`
- Create: `apps/api/src/lib/skill-config.ts` — TypeScript types for `agent_config` + `project_config`

**Schema changes — ALTER the existing table, don't recreate:**
```sql
-- 0035_skills_extend.sql
ALTER TABLE skills ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'org'
  CHECK (source IN ('bundled','marketplace','org'));
ALTER TABLE skills ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT '1.0.0';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS agent_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS project_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS is_deleted boolean NOT NULL DEFAULT false;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS default_agent_employee_id text REFERENCES agent_employees(id) ON DELETE SET NULL;

-- Existing columns system_prompt + param_schema are folded INTO agent_config via one-time migration:
UPDATE skills
  SET agent_config = jsonb_build_object(
    'system_prompt_addition', system_prompt,
    'param_schema', param_schema
  )
  WHERE agent_config = '{}'::jsonb AND (system_prompt IS NOT NULL OR param_schema IS NOT NULL);

-- org_id becomes nullable (bundled/marketplace skills have no org):
ALTER TABLE skills ALTER COLUMN org_id DROP NOT NULL;

-- Uniqueness: (source, org_id, slug) must be unique
ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_org_slug_unique;
CREATE UNIQUE INDEX IF NOT EXISTS skills_source_org_slug_idx ON skills (source, COALESCE(org_id,''), slug) WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS skills_source_idx ON skills(source) WHERE is_deleted = false;
CREATE INDEX IF NOT EXISTS skills_org_idx ON skills(org_id) WHERE is_deleted = false AND source = 'org';
```

**`agent_config` JSONB shape:**
```jsonc
{
  "tools": ["search_tasks","create_task","post_message"],      // native Deft tool names
  "capability_packs": ["deft-workspace","web-browsing"],       // CAPABILITY_PACKS slugs
  "triggers": ["cron:standup","webhook:pr-merged"],            // trigger kinds
  "system_prompt_addition": "You are a marketing operations expert...",
  "trust_level_override": null | "conservative" | "standard" | "autonomous",
  "model_recommendation": "claude-sonnet-4-6",
  "heartbeat_checklist": [                                      // Phase 8 uses this
    "Review any campaigns approaching publish date",
    "Flag any brief waiting for review >24h"
  ],
  "param_schema": {}                                            // legacy, preserved for back-compat
}
```

**`project_config` JSONB shape:**
```jsonc
{
  "statuses": [
    {"id":"ideas","label":"Ideas","color":"#64748B","order":0},
    {"id":"drafting","label":"Drafting","color":"#F59E0B","order":1}
    // ... ordered list
  ],
  "priority_vocab": {"kind":"named","labels":["High","Medium","Low"]},
  "default_view": "calendar",
  "hide_prefix_ids": true,
  "custom_fields": [
    {"id":"content_type","label":"Content Type","type":"select","options":["blog","email","social"]}
  ],
  "task_templates": [
    {"id":"launch-kit","name":"New launch campaign","tasks":[...]}
  ],
  "allowed_transitions": null | {"backlog":["todo","cancelled"], "todo":[...], ...}
}
```

- [ ] Write the migration (idempotent; applies to prod Neon)
- [ ] Update Drizzle schema to match
- [ ] Create `skill-config.ts` with exported TypeScript types for both JSONB shapes
- [ ] Commit: `feat(skills): extend existing skills table with source/agent_config/project_config`

### Task 4.2: Skill junctions — `agent_employee_skills` + `project_skills`

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0036_skill_junctions.sql`

```sql
CREATE TABLE IF NOT EXISTS agent_employee_skills (
  agent_employee_id text NOT NULL REFERENCES agent_employees(id) ON DELETE CASCADE,
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  installed_at timestamp NOT NULL DEFAULT NOW(),
  installed_version text NOT NULL,
  PRIMARY KEY (agent_employee_id, skill_id)
);
CREATE INDEX IF NOT EXISTS aes_skill_idx ON agent_employee_skills(skill_id);

CREATE TABLE IF NOT EXISTS project_skills (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  attachment_order int NOT NULL DEFAULT 0,
  attached_at timestamp NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, skill_id)
);
CREATE INDEX IF NOT EXISTS ps_skill_idx ON project_skills(skill_id);
CREATE INDEX IF NOT EXISTS ps_project_order_idx ON project_skills(project_id, attachment_order);
```

- [ ] Migration + Drizzle schema
- [ ] Commit: `feat(skills): junction tables for agent installs + project attachments`

### Task 4.3: Seed 11 bundled skills from existing CAPABILITY_PACKS + 3 project skills

**Files:**
- Create: `apps/api/src/lib/bundled-skills.ts` — definitions
- Create: `apps/api/src/scripts/seed-bundled-skills.ts` — runs once at migration time + on-demand for new orgs
- Modify: `apps/api/src/scripts/seed-templates.ts` — also seed bundled skills during template seeding

**6 agent-only bundled skills seeded on day one** (one per available CAPABILITY_PACKS entry at `apps/api/src/lib/capability-packs.ts:44-203`). Each becomes a row with `source='bundled'`, `org_id=null`, `agent_config.capability_packs=[<slug>]`, no `project_config`. Slugs seeded now: `deft-workspace`, `web-browsing`, `tavily`, `github`, `google-calendar`, `shell-exec`. The 5 coming-soon packs (gmail, slack, linear, notion, playwright-mcp) are **skipped at seed time** — they get seeded later when their pack flips from `coming_soon=true` to active. (Rationale: seeding a disabled skill pollutes the /skills library with non-installable entries.) Total seeded project-workflow skills: 3 (below), so day-one bundled-skill count = **9**, not 14. Update the seed count verification (Task 7.3) accordingly.

**3 project-focused bundled skills** (the main non-technical-workflow value):

1. **engineering** (preserves current behavior, zero regression):
   - `project_config.statuses`: backlog/todo/in_progress/in_review/done/cancelled
   - `project_config.priority_vocab`: `{kind:'numbered',labels:['p0','p1','p2','p3']}`
   - `project_config.default_view`: `'board'`
   - `project_config.hide_prefix_ids`: `false`
   - `project_config.allowed_transitions`: strict rules from Phase 0.2
   - `agent_config.tools`: the 9 new task tools from Phase 3 (comment_on_task, set_priority, set_due_date, add_label, close_task, reopen_task, add_dependency, remove_dependency, list_my_tasks) — this is how they ship; orgs can uninstall this skill to opt out
   - `default_agent_employee_id`: null (existing agents install based on their capability_packs)

2. **marketing-campaign**:
   - statuses: ideas/drafting/in_review/approved/scheduled/live/archived
   - priority: `{kind:'named',labels:['High','Medium','Low']}`
   - default_view: `'calendar'`
   - hide_prefix_ids: `true`
   - no `allowed_transitions` (fluid)
   - custom_fields: content_type, channel, asset_url, publish_url, approver
   - task_templates: "New launch campaign" (7 tasks)
   - `agent_config.heartbeat_checklist`: `["Review campaigns near publish date","Flag briefs waiting >24h in review"]`
   - Ships with a reference to the `alex-pm` bundled template as `default_agent_employee_id` when installed

3. **sales-pipeline**:
   - statuses: new/qualified/demo/proposal/won/lost/snoozed
   - priority: `{kind:'temperature',labels:['Hot','Warm','Cold']}`
   - default_view: `'pipeline'`
   - hide_prefix_ids: `true`
   - custom_fields: contact_name, company, deal_value, last_contact_at, next_step
   - task_templates: "14-day re-engage sequence" (5 sequenced follow-ups)
   - `agent_config.heartbeat_checklist`: `["Flag deals with no contact in 7+ days","Surface hot deals awaiting response"]`

- [ ] Write `bundled-skills.ts` with all 9 day-one definitions (6 agent + 3 project); include the 5 coming-soon definitions behind a `seed_when_active: true` flag so the next release can flip them on without a schema change
- [ ] Seed script: idempotent insert via `ON CONFLICT DO UPDATE` by `(source, slug)` — run at migration time
- [ ] Write tests: every day-one bundled skill exists post-seed; engineering skill's statuses match current hardcoded set; coming-soon slugs do NOT appear
- [ ] Commit: `feat(skills): seed 9 bundled skills (6 capability-pack + 3 project-workflow)`

### Task 4.4: Migrate `capability_packs[]` + `trigger_subscriptions[]` → junction rows

**Files:**
- Create: `packages/db/drizzle/0037_migrate_caps_to_skills.sql`
- Modify: `apps/api/src/lib/capability-packs.ts` — mark `TEMPLATE_DEFAULT_PACKS` hashmap as deprecated with JSDoc pointing to skills

```sql
-- 0037_migrate_caps_to_skills.sql
-- For every agent_employee, turn each pack slug into an agent_employee_skills row.
-- Bundled skills for packs must exist first (Task 4.3 seeded them with slug = pack slug).
INSERT INTO agent_employee_skills (agent_employee_id, skill_id, installed_at, installed_version)
SELECT ae.id, s.id, COALESCE(ae.created_at, NOW()), s.version
FROM agent_employees ae
CROSS JOIN LATERAL unnest(ae.capability_packs) AS pack_slug
JOIN skills s ON s.source = 'bundled' AND s.slug = pack_slug
ON CONFLICT (agent_employee_id, skill_id) DO NOTHING;

-- trigger_subscriptions[] stays as-is on agent_employees for backward compat; we read it at dispatch time.
-- Resolved at runtime as: union(employee.trigger_subscriptions, skills.agent_config.triggers for all installed skills)
```

- [ ] Migration + applied to local + tested on fresh seed
- [ ] Dual-read shim in `agent-deploy.ts:105` and `deploy-provision.ts:127`: when loading an employee's capability packs, return `union(capability_packs[], installed_skills.agent_config.capability_packs)` — this lets us migrate incrementally without breaking the provisioning flow
- [ ] Commit: `feat(skills): migrate existing capability_packs to agent_employee_skills junction`

### Task 4.5: Project skill attachment routes + resolver

**Files:**
- Modify: `apps/api/src/routes/projects.ts` — new endpoints
- Create: `apps/api/src/lib/project-resolver.ts` — `getProjectResolvedConfig(project_id)` returning merged config
- Modify: `apps/api/src/routes/tasks.ts` — use resolver wherever status validation occurs

- [ ] New endpoints:
  - `GET /api/projects/:id/skills` — list attached skills in `attachment_order` with resolved config
  - `POST /api/projects/:id/skills` — attach skill (body: `skill_id`); appends to end of `attachment_order`
  - `DELETE /api/projects/:id/skills/:skill_id` — detach (renumber order after)
  - `PATCH /api/projects/:id/skills/reorder` — update `attachment_order[]` of all skills at once
- [ ] `getProjectResolvedConfig(project_id)` implementation:
  - Fetches all `project_skills` ordered by `attachment_order`
  - Merges `project_config` from each: first-attached-wins for UI-exclusive fields (statuses, priority_vocab, default_view, hide_prefix_ids); union for additive (custom_fields, task_templates, allowed_transitions)
  - Returns the merged config
  - 60s per-project LRU cache; invalidated on skill attach/detach/reorder
- [ ] Replace Phase 0.2's interim resolver with this real one
- [ ] Test: attach marketing + engineering; resolved config has marketing statuses (first-attached), union of custom_fields
- [ ] Commit: `feat(skills): project skill attach/detach + resolved config helper`

### Task 4.6: JIT install on agent dispatch

**Files:**
- Modify: `apps/api/src/workers/handlers/agent-employee-task.ts` — before dispatch, check+install required skills
- Modify: `apps/api/src/workers/handlers/agent-employee-message.ts` — same
- Create: `apps/api/src/lib/skill-install.ts` — `ensureSkillInstalled(employee, skill, mode)`

- [ ] `ensureSkillInstalled(employee_id, skill_id)`:
  - If already in `agent_employee_skills`, no-op
  - Load skill; check source:
    - `bundled` + `org` → auto-install (insert junction row); if skill has `capability_packs`, add them to employee's `capability_packs[]` (and trigger re-provision if employee.kind='openclaw' and is already connected)
    - `marketplace` → NOT auto-install; return `{requires_approval: true, skill}`. Caller decides whether to surface a prompt or skip.
  - Return install result: `{installed: boolean, requires_reprovision: boolean}`
- [ ] In `agent-employee-task.ts`: after loading task + project, compute `required_skills = project_resolved_config.skills`; for each, call `ensureSkillInstalled` with `agent_id=employee.id`; if any returns `requires_approval`, queue the task to the employee's owner with a prompt
- [ ] In `agent-employee-message.ts`: same pattern — but use the space's linked project if any
- [ ] Re-provision path: if `requires_reprovision` true AND kind='openclaw', enqueue a `deploy-provision` job with mode='update'; mark the employee's `connection_status='pending'`. The agent is temporarily unavailable; Deft notifies the owner with "Installing GitHub skill on Alex PM. ~2 min."
- [ ] Commit: `feat(skills): JIT install on agent invocation; runtime for native, re-provision for openclaw`

### Task 4.7: Unified agent-employee creation wizard

**Context:** Today there are two creation paths:
1. Legacy native creation (`apps/web/src/app/(app)/settings/agent-employees/create/page.tsx`) — no packs/triggers/skills UI
2. Legacy openclaw deploy wizard (via `apps/api/src/routes/agent-deploy.ts` — built during the `phase2-4-mcp-agents-plans` phase-8 work, unrelated to this plan's Phase 8) — full packs + triggers UI

They diverge in UX and both need updating. Unify around skills.

**Files:**
- Modify: `apps/web/src/app/(app)/settings/agent-employees/create/page.tsx` — add skill picker step
- Modify: any UI file wired to the legacy deploy wizard (search for callers of `/api/agent-deploy/start`) — same skill picker
- Modify: `apps/api/src/routes/agent-deploy.ts:/start` — accept `skill_ids[]` instead of `capability_packs[]` (keep pack support for backward compat)

- [ ] Wizard Step: "Which skills does this employee start with?"
  - Shows all `bundled` + `org` skills, grouped by source
  - Multi-select with checkboxes
  - Each card shows: icon, name, description, "Includes: [tool names]" + "Triggers: [trigger kinds]"
  - Templates preselect their recommended skills (from the template's `default_capability_packs` → resolved to skill ids)
- [ ] On submit: `skill_ids[]` becomes the initial `agent_employee_skills` entries
- [ ] Legacy `capability_packs[]` field on agentEmployees gets populated by a trigger/after-insert hook from the junction (or dropped in Task 4.12 below — decide then)
- [ ] Commit: `feat(skills): unified agent-creation wizard with skill picker (native + openclaw paths)`

### Task 4.8: Create-project wizard with skill attachment

**Files:**
- Modify: `apps/web/src/components/create-project-modal.tsx`

- [ ] Step 1: Name + prefix + color + description (as today)
- [ ] Step 2: "Which skills apply to this project?" — multi-select with "first attached drives the UI" helper text
  - Card per bundled + org skill that has a `project_config` (engineering / marketing-campaign / sales-pipeline + any org skills with project_config)
  - Default: Engineering pre-selected
  - Order matters — drag to reorder; the first one's statuses/view/vocab drive the board
- [ ] Submit → POST /api/projects, then for each selected skill in order: POST /api/projects/:id/skills
- [ ] After creation, if any skill has `task_templates`, offer "Apply a starter template?" — one click creates tasks
- [ ] Commit: `feat(projects): create wizard with skill attachment + ordering`

### Task 4.9: Status columns + vocab + PREFIX-N + view mode driven by resolved config

**Files:**
- Modify: `apps/web/src/components/task-board.tsx` — read columns from resolved config
- Modify: `apps/web/src/components/task-list.tsx` — same
- Modify: `apps/web/src/components/task-card.tsx` priority badge
- Modify: `apps/web/src/components/task-filters.tsx` priority filter
- Modify: `apps/web/src/components/task-detail.tsx` priority dropdown + PREFIX-N visibility
- Modify: `apps/web/src/components/space-chat.tsx` cross-reference pills — check hide_prefix_ids
- Modify: `apps/web/src/app/(app)/tasks/page.tsx` — view toggle defaults to resolved config's default_view
- Create: `apps/web/src/hooks/use-project-resolved-config.ts` — client-side fetch + cache

- [ ] Hook fetches `/api/projects/:id/resolved-config`, caches for session, invalidates on skill attach/detach socket events
- [ ] Board columns are driven by `resolved_config.statuses[]`, rendered in `order` field
- [ ] Priority badges + filter + dropdown use `resolved_config.priority_vocab`
- [ ] DB still stores the 4 canonical values `p0/p1/p2/p3`; UI maps to skill labels at render time (numbered=identity, named=High/Medium/Low, temperature=Hot/Warm/Cold)
- [ ] `hide_prefix_ids` hides `PREFIX-N` header on cards, detail; chat pills show title only
- [ ] Default view comes from resolved_config
- [ ] Commit: `feat(tasks): render config (statuses/vocab/view/prefix) from project resolved skill config`

### Task 4.10: Calendar + Pipeline views

**Files:**
- Create: `apps/web/src/components/task-calendar-view.tsx`
- Create: `apps/web/src/components/task-pipeline-view.tsx`
- Modify: `apps/web/src/app/(app)/tasks/page.tsx` (view toggle)

- [ ] Calendar view: month grid; tasks render by `due_date`; drag to reschedule (PATCH due_date); "Add task on date" button per cell; uses the unified `<TaskCard variant='calendar'>`
- [ ] Pipeline view: horizontal stages (one per config status); wider cards with contact_name + deal_value inline for Sales skill; drag between stages; column footer shows sum of deal_value + count
- [ ] Both views only render when project's resolved `default_view` matches, OR user manually selects
- [ ] Commit: `feat(tasks): calendar + pipeline view modes driven by skill config`

### Task 4.11: Custom fields + task templates

**Files:**
- Modify: `apps/web/src/components/task-detail.tsx` — render custom fields from resolved config
- Modify: `apps/web/src/components/task-quick-create.tsx` — include custom fields for the project's first skill
- Modify: `apps/api/src/routes/tasks.ts` — accept `metadata` JSONB on POST/PATCH
- Create: `apps/api/src/routes/task-templates.ts` — POST `/api/projects/:id/apply-template` for bulk create

- [ ] Custom field types: text, textarea, url, select (with options), date, user (picker), number
- [ ] On save, write to `tasks.metadata` JSONB keyed by field id
- [ ] Task templates: resolve the union of all skills' task_templates; show a "Templates" dropdown at project level; applying creates tasks via bulk endpoint in a transaction
- [ ] Each template task's `due_date` can be `+Nd` relative to application date (parse on apply)
- [ ] Search endpoints include metadata values in FTS (lightly — just the searchable-string fields)
- [ ] Commit: `feat(tasks): custom fields + task templates from resolved skill config`

### Task 4.12: Recurrence UI + clone gaps + dead-primitive cleanup

**Files:**
- Modify: `apps/web/src/components/task-detail.tsx` — add Recurrence section
- Modify: `apps/api/src/routes/tasks.ts` recurrence spawner (~L1325-1365)
- Modify: `packages/db/src/schema.ts` — drop `agent_employees.native_tools[]` column
- Modify: `apps/api/src/lib/capability-packs.ts:220-229` — delete `TEMPLATE_DEFAULT_PACKS` hashmap
- Create: `packages/db/drizzle/0038_drop_native_tools.sql`

- [ ] Recurrence UI: dropdown (none/daily/weekly/biweekly/monthly) in task-detail; saves `tasks.recurrence` via PATCH
- [ ] Recurring-task chip on card
- [ ] Update spawner: also clone `taskLabels`, `metadata` custom fields, `parent_task_id`; set `recurrence_source_id` to original id (on first generation point to self)
- [ ] Drop `native_tools` column — audit confirmed unused
- [ ] Delete `TEMPLATE_DEFAULT_PACKS` hashmap (legacy phase-9 deprecation marker — see design decision #13); callers already route through the DB templates
- [ ] Commit: `feat(tasks): recurrence UI + clone-gap fix + remove dead native_tools + TEMPLATE_DEFAULT_PACKS`

### Task 4.13: `/skills` library page + marketplace browser + openclaw import

**Files:**
- Create: `apps/web/src/app/(app)/skills/page.tsx`
- Create: `apps/web/src/app/(app)/skills/[slug]/page.tsx`
- Create: `apps/api/src/lib/openclaw-skill-import.ts` — markdown parser
- Modify: `apps/api/src/routes/skills.ts` — list/get/create/edit/delete + import

- [ ] `/skills` page: three tabs — "Bundled" / "Marketplace" / "Your org". Grid of cards per skill showing icon, name, description, source badge, "Installed on N agents" + "Attached to M projects" counts
- [ ] Actions per card: View (→ detail page), Install (→ prompts which agent), Attach (→ prompts which project), Fork (→ copy into Your org tier)
- [ ] Detail page: editable config (statuses/vocab/custom_fields/templates) for org skills; read-only for bundled/marketplace; version history for bundled; "Update available" banner when installed version lags
- [ ] Marketplace import button: paste OpenClaw skill URL (e.g. `https://clawhub.ai/skills/content-creator`) → fetches markdown → `openclaw-skill-import.ts` parses → creates skill row with `source='marketplace'`, `source_url=<url>`
- [ ] Security prompt on marketplace install: "This skill can: [read files, call web APIs, post messages]. Install?"
- [ ] Context-bloat indicator: if an agent has >5 skills installed, show "~N tokens on each invocation. Consider uninstalling unused." Threshold of 5 is a v1 heuristic — adjust based on trusted-tester feedback.
- [ ] Retry-provisioning button on the skill-install dialog: when a JIT install (Task 4.6) leaves the employee in `connection_status='pending'` because re-provision failed, the detail page exposes a "Retry install" action that re-enqueues the `deploy-provision` job. Endpoint: `POST /api/agent-employees/:id/retry-provision` (add to `agent-employees.ts`).
- [ ] Commit: `feat(skills): /skills library + marketplace browser + openclaw markdown import + retry-provision`

### Task 4.14: Version update notification model

**Files:**
- Create: `apps/api/src/workers/handlers/skill-update-check.ts`
- Modify: `apps/api/src/lib/job-scheduler.ts` — register as a daily cron
- Modify: `apps/web/src/components/notification-panel.tsx` — render `skill_update_available` notification type

- [ ] Daily cron: for each installed skill where `installed_version < current_version`, create a `skill_update_available` notification with link to `/skills/:slug?agent=X`
- [ ] Notification action: "Update" (re-installs at current version; re-runs provisioning for openclaw-hosted agents if capability_packs differ) / "Ignore" (marks the notification dismissed; re-surfaces next minor version)
- [ ] Commit: `feat(skills): version update notifications with opt-in adoption`

### Task 4.15: Trigger conflict UX on skill install

**Files:**
- Modify: `apps/api/src/lib/skill-install.ts`
- Modify: `apps/api/src/routes/agent-employees.ts` — new endpoint `POST /api/agent-employees/:id/reassign-trigger`

- [ ] Before installing a skill, check its `agent_config.triggers` for any kind already claimed by a different employee in the same org
- [ ] On conflict: return `{requires_user_decision: true, conflicting_trigger, current_owner_id, current_owner_name}` to the frontend
- [ ] Frontend prompts: "Alex PM currently owns `cron:standup`. Reassign to Riya?"
- [ ] On confirm, reassign endpoint removes trigger from old employee + installs skill on new
- [ ] Multiple skills on same agent declaring same trigger kind → dedupe at read time (no duplicate firing)
- [ ] Test: two-agent conflict scenario
- [ ] Commit: `feat(skills): trigger conflict prompt + reassignment UX`

---

## Phase 5: Cross-surface integrations + deferred promises

### Task 5.1: Notes ↔ tasks cross-referencing

**Files:**
- Modify: `apps/api/src/workers/handlers/cross-reference.ts` — also scan note content
- Modify: `apps/api/src/routes/daily-notes.ts` POST/PATCH — enqueue cross-reference job after save
- Modify: `apps/api/src/routes/tasks.ts` GET /:id/references — include note references
- Modify: `apps/web/src/app/(app)/notes/page.tsx` — render PREFIX-N as link pill

- [ ] Cross-reference worker: `source_type: 'note'` gets same regex match pattern
- [ ] Bidirectional: task detail shows "Referenced in notes" if any, note detail shows "References tasks" sidebar
- [ ] Commit

### Task 5.2: Task completion feeds `peopleExpertise`

**Files:**
- Modify: `apps/api/src/services/people-graph.ts` (`extractExpertise` function)

- [ ] After the wiki authorship signal, add a task-completion signal: count `tasks.assignee_id = user_id AND status = 'done' AND completed_at > NOW()-INTERVAL '24h'` grouped by label
- [ ] Each completed task with a label adds `+3 × label_weight` to that topic's score (labels like 'marketing', 'research' become topics)
- [ ] Write test covering a seeded completion
- [ ] Commit

### Task 5.3: Task overload signal in burnout-detector

**Files:**
- Modify: `apps/api/src/services/burnout-detector.ts`

- [ ] Add `detectTaskOverload(userId, orgId)` signal: count tasks assigned to user with status in (todo, in_progress, in_review) AND due_date < NOW()+14d — if count > 15, `detected: true`
- [ ] Add to the composite score with weight 0.10 (renormalize other weights — this is the 8th signal)
- [ ] Test + commit

### Task 5.4: Manager pulse excludes backlog from active-task count

**Files:**
- Modify: `apps/api/src/services/manager-pulse.ts:76-87`

- [ ] Change filter from `NOT IN ('done', 'cancelled')` to `IN ('todo', 'in_progress', 'in_review')`
- [ ] Test + commit

### Task 5.5: Bulk ops — batched socket + grouped notifications

**Files:**
- Modify: `apps/api/src/routes/tasks.ts` (PATCH /bulk, POST /bulk-delete)
- Modify: `apps/web/src/app/(app)/tasks/page.tsx` socket listener for `task:bulk_updated`

- [ ] Server: instead of emitting N `task:updated` events, emit 1 `task:bulk_updated` with `{task_ids: [...], changes: {...}}`
- [ ] Server: instead of N notifications, if ≥3 tasks assigned to same user in one bulk, create 1 notification `"You were assigned N tasks"` with `metadata.task_ids`
- [ ] Client: new handler refetches the list / detail as needed
- [ ] Commit

### Task 5.6: GitHub PR merged → task status update (CLAUDE.md promise)

**Files:**
- Modify: `apps/api/src/workers/handlers/github-sync.ts` (or wherever PR webhook is processed)
- Modify: `CLAUDE.md` — update text to reflect actual behavior post-implementation

- [ ] When syncing a `pr_merged` event, parse the PR title + body for `PREFIX-N` matches
- [ ] For each matched task in the same org: if current status is in (todo, in_progress, in_review), move to `done`
- [ ] Write a comment on the task: `"Closed by merging PR #<n>: <title>"` with PR URL
- [ ] Don't touch tasks already `done` or `cancelled`
- [ ] Write test covering the flow
- [ ] Commit

### Task 5.7: Workflows executor (basic trigger → action)

**Decision:** Build a thin executor that handles "when status changes to X, do Y." Enough to make workflows feel real without turning into Zapier.

**Files:**
- Create: `apps/api/src/workers/handlers/workflow-execute.ts`
- Modify: `apps/api/src/workers/index.ts` register handler
- Modify: `apps/api/src/routes/tasks.ts` PATCH status — enqueue workflow-execute if org has matching workflows
- Create: `apps/web/src/app/(app)/settings/workflows/page.tsx` — list + create UI
- Modify: `apps/api/src/routes/workflows.ts` — ensure CRUD is solid

**Supported triggers (v1):**
- `task.status_changed` with filter `to_status`

**Supported actions (v1):**
- `add_comment` with template
- `assign_to` (user id or role)
- `add_label` (label id)
- `notify` (user id)

- [ ] Handler: receives `{workflow_id, task_id}`, loads workflow, executes each action sequentially
- [ ] UI: simple form — pick trigger (only status_changed for v1) + pick target status + pick actions (checkboxes)
- [ ] Write test: create workflow "when status → done, add label 'shipped'"; PATCH task to done; assert label present
- [ ] Commit

### Task 5.8: Project archive + delete UI

**Files:**
- Modify: `apps/api/src/routes/projects.ts` — PATCH `/api/projects/:id` accepts `is_archived`; DELETE is soft-delete
- Create: `apps/web/src/components/project-settings-modal.tsx`

- [ ] Modal with fields: name, prefix (read-only), color, description, lead_id + Archive/Delete buttons at bottom
- [ ] Archive: PATCH is_archived=true; shown in separate "Archived" section in sidebar (hidden by default)
- [ ] Delete: soft-delete via is_deleted; tasks remain in DB for audit but no longer appear; 7-day recovery window (surface in settings as "Recently deleted")
- [ ] Commit

---

## Phase 6: Detail modal + UX polish

### Task 6.1: Task detail tabs (not flat sections)

**Files:**
- Modify: `apps/web/src/components/task-detail.tsx`

- [ ] Replace the flat-stacked layout with tabs: Description | Subtasks | Dependencies | Comments | Activity | Attachments | References
- [ ] Top of modal stays: title + assignee + status + priority + due date (always visible)
- [ ] Tabs use URL hash (`#comments`) for deep-link
- [ ] Commit

### Task 6.2: Activity log diff view

**Files:**
- Modify: `apps/web/src/components/task-detail.tsx` (activity tab)

- [ ] For `field_changed` / `status_changed` rows, render old → new inline with subtle strikethrough on old
- [ ] For long description changes, render a collapsible diff with +/- markers (use a small diff lib or simple line-by-line compare)
- [ ] Commit

### Task 6.3: Task reactions

**Files:**
- Create: `packages/db/drizzle/0042_task_reactions.sql`
- Modify: `packages/db/src/schema.ts`
- Modify: `apps/api/src/routes/tasks.ts`
- Modify: `apps/web/src/components/task-card.tsx` + `task-detail.tsx`

- [ ] New table `task_reactions`: `(id, task_id, user_id, emoji, created_at, unique(task_id, user_id, emoji))`
- [ ] POST/DELETE `/api/tasks/:id/reactions`
- [ ] UI: small reaction bar at bottom of card — predefined: 👍 👀 🎉 🔥 + "+ reaction" picker
- [ ] Commit

### Task 6.4: @mentions in description + comments

**Files:**
- Modify: `apps/web/src/components/task-detail.tsx` — TipTap with Mention extension
- Modify: `apps/api/src/routes/tasks.ts` — on comment/description save, parse mentions + create notifications

- [ ] Install/wire TipTap's Mention extension if not already
- [ ] Mention data source: org members + agent employees
- [ ] On save, extract `@user_id` mentions; for each, create a `notifications.type = 'mention'` row with link to task
- [ ] Commit

### Task 6.5: Attachment upload progress + error states

**Files:**
- Modify: `apps/web/src/components/task-detail.tsx` attachment section

- [ ] Show progress bar while uploading (XHR with progress event)
- [ ] On failure, inline error + retry button
- [ ] On large files >10MB, confirmation prompt before upload
- [ ] Commit

### Task 6.6: Cross-page task card consistency audit

- [ ] Manually sweep: chat link, calendar event, notification row, dashboard widget, board card, list row — all should use the unified TaskCard from Task 1.7
- [ ] Any leftover bespoke rendering → migrate
- [ ] Commit

---

## Phase 7: QA, tests, deploy

### Task 7.1: Playwright audit suite for `/tasks` end-to-end

**Files:**
- Create: `docs/superpowers/audits/tasks-overhaul.audit.ts`

Tests (each is a sentinel-enclosed block):
1. Login + navigate to /tasks
2. Create a project with Engineering skill; verify Backlog/Todo/In Progress/In Review/Done/Cancelled columns
3. Create a task via quick-create; verify it appears in Todo column
4. Drag a card from Todo to Done; verify socket fires + DB updates
5. Create a project with Marketing skill; verify Ideas/Drafting/Review/Approved/Scheduled/Live columns + calendar default view
6. Create a project with Sales skill; verify pipeline view + Hot/Warm/Cold priority
7. Apply a task template; verify N tasks created
8. Assign a task to Alex PM (agent employee); verify card shows agent avatar with AI badge
9. @mention a user in a comment; verify notification created
10. React to a task with 👍; verify reaction appears
11. Filter by status=done; verify only done tasks show
12. Open a task detail; click each tab; verify content renders
13. Reverse a decision from the knowledge page (regression check)

- [ ] Each test enclosed in `// GAP CHECK: <name>` sentinels
- [ ] Run locally; all pass
- [ ] Commit

### Task 7.2: OpenClaw heartbeat + skill lifecycle regression tests

**Files:**
- Create: `apps/api/test/openclaw-heartbeat.test.ts`
- Create: `apps/api/test/skill-install.test.ts`

- [ ] Openclaw heartbeat tests: native agents heartbeat at 5min cadence, openclaw agents at 30min (or override); heartbeat dispatcher routes to correct transport (native runAgentQuery vs openclawDispatch); heartbeat is skipped when `unhealthy=true` or `daily_action_count >= daily_action_cap`
- [ ] Skill install tests: JIT install auto-installs bundled+org skills; marketplace requires approval path; openclaw re-provision triggers when pack changes; trigger conflict returns `requires_user_decision`; reassignment endpoint moves trigger between employees
- [ ] Commit: `test(agents): openclaw heartbeat + skill lifecycle regression suite`

### Task 7.3: Full workspace verification + 3-service deploy

- [ ] `pnpm -r typecheck` — clean on apps/api + apps/web
- [ ] `cd apps/api && pnpm test` — 300+ tests passing, 0 fail, 1 pre-existing pgvector skip
- [ ] Apply all new migrations (0025-0040) to prod Neon in order
- [ ] Seed bundled skills into trusted-tester org (one-time script invocation); verify via `SELECT count(*) FROM skills WHERE source='bundled'` returns **9** (6 capability-pack + 3 project-workflow; coming-soon packs are excluded per Task 4.3)
- [ ] Data migration verification: `SELECT count(*) FROM agent_employee_skills` ≥ sum of `array_length(capability_packs, 1)` across all agent_employees (prove the backfill landed)
- [ ] `railway up --service $RAILWAY_SERVICE_ID` (api)
- [ ] `railway up --service $RAILWAY_WEB_SERVICE_ID` (web)
- [ ] `railway up --service $RAILWAY_OPENCLAW_SERVICE_ID` (openclaw gateway; confirm container still 24/7 and heartbeat endpoint responds)
- [ ] Verify all three deploys reach SUCCESS
- [ ] Run Task 7.1 audit against prod + smoke-test one heartbeat firing (force cron via admin endpoint)
- [ ] Commit deploy artifacts (nothing if none)

### Task 7.4: Update docs to match reality

**Files:**
- `CLAUDE.md` — if PR→Done is now implemented (Task 5.6), keep the line; if not, remove it. Update Task architecture summary to mention the Skills primitive (unified agent+project capabilities) and Phase 8 openclaw autonomy model.
- `FEATURES.md` — add the Skills primitive (with 3 source tiers), Marketing/Sales presets, multi-skill-per-project (first-attached-wins), OpenClaw autonomous agents (heartbeat-driven), recurrence UI, workflow executor (basic), live agent progress, proactive agent comments, inline suggestion cards, task reactions, @mentions, diff view in activity log. Remove/update any out-of-date claims.
- `HUMAN-TEST-GUIDE.md` — add task-specific test flows for Marketing and Sales personas; add "24/7 agent employee" persona flow (deploy Alex PM openclaw → observe heartbeat turn after 30min → see proactive task nudge in space).
- `AGENT-TEST-GUIDE.md` — document heartbeat checklist, skill install prompts, trigger conflict resolution, context-bloat warning.
- `README.md` if it mentions task-management claims.

- [ ] Sweep each file; correct or flag as follow-up
- [ ] Commit: `docs: update CLAUDE/FEATURES/test-guides for skills primitive + openclaw autonomy`

---

## Phase 8: OpenClaw autonomous agent lifecycle

**Problem (from the openclaw audit):** we deploy openclaw agents into long-running containers but then treat them as push-only request/response endpoints. Autonomy primitives exist half-wired:
- `agent-employee-heartbeat.ts:6,43-54,63-72` explicitly excludes openclaw agents from heartbeat ticks
- `gateway-ping.ts:1-18` only pings the openclaw API for liveness — no reasoning, no tool use
- `trigger_subscriptions[]` is stored on the employee but no subscription dispatcher fires for openclaw agents
- `daily_action_count` + `daily_action_cap` columns exist but no enforcement path

A trusted tester paying for "Alex PM, your 24/7 agent employee" today gets a dormant container that only wakes up when pinged. This phase wires the heartbeat loop, autonomous reasoning cycles, trigger dispatch, and cost guardrails so the container actually earns its keep.

**Scope guard:** this phase is about making the existing openclaw container behave autonomously. It does NOT introduce a new runtime, switch providers, or rearchitect the gateway. All work is inside `apps/api/src/workers/handlers/` and `apps/api/src/lib/openclaw-*.ts`.

### Task 8.1: Extend heartbeat dispatcher to openclaw agents

**Files:**
- Modify: `apps/api/src/workers/handlers/agent-employee-heartbeat.ts`
- Modify: `apps/api/src/lib/job-scheduler.ts` — register two cron kinds: `heartbeat-native` (existing, 5min) and `heartbeat-openclaw` (new, 30min)
- Modify: `apps/api/src/lib/openclaw-dispatch.ts` — add `dispatchHeartbeat(employee, checklistPrompt)` entry point

- [ ] Remove the `kind='openclaw'` exclusion at heartbeat.ts:6,43-54,63-72 — the handler should now dispatch based on kind
- [ ] Handler logic:
  - For `kind='native'`: existing `runAgentQuery` path (unchanged cadence)
  - For `kind='openclaw'`: call new `openclawDispatch.dispatchHeartbeat(employee, prompt)` which reuses the SSE stream transport at `openclaw-client.ts:30-53` but with a different message role/type (`heartbeat` vs `user`)
- [ ] Two cron kinds, different cadences, same worker handler dispatches based on employee.kind
- [ ] Skip dispatch if employee `connection_status != 'connected'` OR `unhealthy=true` OR `daily_action_count >= daily_action_cap`
- [ ] Test: queue a heartbeat job for an openclaw employee; assert dispatchHeartbeat called, runAgentQuery not
- [ ] Commit: `feat(agents): heartbeat dispatches to openclaw agents via SSE with separate cadence`

### Task 8.2: Heartbeat prompt builder from installed skills + employee overrides

**Files:**
- Create: `apps/api/src/lib/heartbeat-prompt.ts`
- Modify: `packages/db/src/schema.ts` — add `agent_employees.heartbeat_overrides jsonb` (optional, `{checklist: string[], cadence_minutes: number}`)
- Create: `packages/db/drizzle/0040_agent_heartbeat_overrides.sql`

- [ ] `buildHeartbeatPrompt(employee_id)`:
  1. Load employee + all installed skills via `agent_employee_skills` junction
  2. Union `agent_config.heartbeat_checklist[]` across skills (Engineering skill contributes nothing; Marketing contributes 2 items, Sales contributes 2, etc)
  3. Merge with `employee.heartbeat_overrides.checklist` (appended, deduped by exact string)
  4. Load the employee's recent context: last 3 space messages in any space they're assigned to, any open tasks assigned to them, any tasks they created in last 24h
  5. Compose the final prompt:
     ```
     You are {employee_name}. It has been {interval_minutes} minutes since your last check-in.

     Recent context:
     - Tasks assigned to you: [...]
     - Recent messages in your spaces: [...]

     Review the following checklist and take action on any items that apply. If no action is needed, reply with "nothing to do" and skip. Do NOT invent work.

     Checklist:
     - {item 1}
     - {item 2}
     ...

     You have {remaining_budget} actions remaining today. Be judicious.
     ```
- [ ] Migration + schema update for `heartbeat_overrides`
- [ ] Tests: prompt for an Alex PM with marketing+engineering skills lists both sets of checklist items; override merges correctly
- [ ] Commit: `feat(agents): compose heartbeat prompt from installed skills + employee overrides`

### Task 8.3: Per-agent cadence config

**Files:**
- Modify: `apps/api/src/lib/job-scheduler.ts`
- Modify: `apps/api/src/routes/agent-employees.ts` — accept `heartbeat_cadence_minutes` on PATCH

- [ ] Default cadence: 30min for openclaw, 5min for native (unchanged)
- [ ] Override via `agent_employees.heartbeat_overrides.cadence_minutes` (min 5min, max 6h); guard with admin-only permission
- [ ] Scheduler uses per-employee cadence when registering repeatable jobs; on cadence change, cancel+re-register the repeatable BullMQ job
- [ ] UI surface: in agent-employee detail page (settings tab), show cadence with edit-in-place
- [ ] Tests: change cadence → next fire uses new interval
- [ ] Commit: `feat(agents): per-agent heartbeat cadence with override`

### Task 8.4: Heartbeat turn logging + UI surfacing

**Files:**
- Modify: `packages/db/src/schema.ts` — new `agent_heartbeat_turns` table
- Create: `packages/db/drizzle/0041_agent_heartbeat_turns.sql`
- Modify: `apps/api/src/workers/handlers/agent-employee-heartbeat.ts` — log turn
- Create: `apps/web/src/app/(app)/settings/agent-employees/[id]/heartbeats/page.tsx`

```sql
CREATE TABLE agent_heartbeat_turns (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES orgs(id),
  agent_employee_id text NOT NULL REFERENCES agent_employees(id) ON DELETE CASCADE,
  fired_at timestamp NOT NULL DEFAULT NOW(),
  cadence_minutes int NOT NULL,
  prompt_sha text NOT NULL,            -- dedupe identical back-to-back prompts (see 8.6)
  action_count int NOT NULL DEFAULT 0, -- tools/messages/tasks created this turn
  tokens_in int,
  tokens_out int,
  cost_cents int,
  outcome text NOT NULL,               -- 'no_op' | 'acted' | 'error' | 'skipped_budget'
  outcome_reason text,
  summary text,                        -- one-line summary of what the agent did
  raw_response jsonb
);
CREATE INDEX aht_employee_fired_idx ON agent_heartbeat_turns(agent_employee_id, fired_at DESC);
CREATE INDEX aht_org_fired_idx ON agent_heartbeat_turns(org_id, fired_at DESC);
```

- [ ] Log a row per heartbeat tick with outcome + summary + cost
- [ ] UI page: timeline of heartbeat turns with filter by outcome, cost summary per day, expand to see prompt/response
- [ ] Socket event `agent:heartbeat:turn` so the page updates live when a turn completes
- [ ] Link from agent-employee detail page "Heartbeats" tab
- [ ] Tests: a fired heartbeat produces one row with outcome matching the action count
- [ ] Commit: `feat(agents): persist + surface heartbeat turns with cost/outcome`

### Task 8.5: Cost guardrails — daily action cap + budget cap + unhealthy flag

**Files:**
- Modify: `apps/api/src/workers/handlers/agent-employee-heartbeat.ts` — enforce budget
- Modify: `apps/api/src/lib/openclaw-dispatch.ts` — increment counters per action
- Modify: `packages/db/src/schema.ts` — add `daily_budget_cents`, `daily_cost_cents`, `unhealthy_reason`
- Modify: `apps/api/src/lib/job-scheduler.ts` — add midnight UTC cron to reset `daily_action_count` and `daily_cost_cents`

- [ ] Pre-flight in heartbeat handler:
  - If `daily_action_count >= daily_action_cap`, log a `skipped_budget` turn and return
  - If `daily_cost_cents >= daily_budget_cents`, log a `skipped_budget` turn and return
  - If `unhealthy=true`, log `skipped_budget` + reason and return
- [ ] Post-flight:
  - Increment `daily_action_count` by the number of tool calls / messages / tasks created in the turn
  - Increment `daily_cost_cents` by the turn's cost
  - If a single turn errors 3 times in a row (check last 3 `agent_heartbeat_turns` rows), set `unhealthy=true` with `unhealthy_reason='3 consecutive errors'` and notify the owner
- [ ] Midnight UTC cron resets daily counters (per-org aware if multi-tenant timezone is a concern; v1 uses UTC for simplicity)
- [ ] UI: agent-employee detail page shows "Today: {X}/{cap} actions, ${cost}/${budget}" + "Mark healthy" button if unhealthy
- [ ] Tests: budget enforcement blocks dispatch; unhealthy flag blocks dispatch; manual reset restores
- [ ] Commit: `feat(agents): daily action + budget caps with unhealthy circuit breaker`

### Task 8.6: Idempotency + loop prevention

**Files:**
- Modify: `apps/api/src/workers/handlers/agent-employee-heartbeat.ts`
- Modify: `apps/api/src/lib/heartbeat-prompt.ts`

- [ ] Compute `prompt_sha` from the normalized heartbeat prompt (exclude timestamp, include checklist + context digest)
- [ ] Before dispatch, check last turn's `prompt_sha`; if identical AND last turn was `no_op`, skip dispatch and log `skipped_idempotent` — avoids the agent being asked the same question with no new context
- [ ] Separately: loop detection — if 5 consecutive turns all created the same task title OR posted the same message text, mark unhealthy (`unhealthy_reason='loop detected'`)
- [ ] Tests: idempotent skip fires when nothing changes; loop detector triggers on the 5th identical action
- [ ] Commit: `feat(agents): idempotency skip + loop detector for heartbeat autonomy`

### Task 8.7: Trigger dispatcher for openclaw agents

**Context:** `trigger_subscriptions[]` is on the employee table but nothing dispatches on trigger fire. Phase 4.15 handled skill-level conflicts. This wires execution.

**Files:**
- Create: `apps/api/src/workers/handlers/trigger-dispatch.ts`
- Modify: `apps/api/src/lib/job-scheduler.ts` — register cron/webhook/event listeners for each active trigger kind
- Modify: `apps/api/src/routes/webhooks/` (extend existing — or create `apps/api/src/routes/webhooks/github.ts` if absent)

- [ ] Supported trigger kinds in v1 (matches what Phase 4 bundled skills declare):
  - `cron:standup` (9am org tz)
  - `cron:nightly-review`
  - `webhook:github-pr-merged` (when PR merges, notify Alex PM)
  - `event:task-extracted` (when classifier extracts a task from chat)
  - `event:task-overdue`
  - `event:task-stalled-48h`
- [ ] On trigger fire, `trigger-dispatch.ts` looks up which employee owns that trigger kind (union of `trigger_subscriptions[]` + installed skills' `agent_config.triggers`); dispatches to agent employee (heartbeat-style, but with trigger-specific prompt)
- [ ] Trigger firings also count against the daily action budget (from 8.5)
- [ ] Tests: PR-merged webhook routes to the Alex PM agent that has `webhook:github-pr-merged`; standup cron fires at 9am
- [ ] Commit: `feat(agents): trigger dispatcher binds skill triggers to openclaw autonomous execution`

**Spec coverage check — every item from the audits:**

Phase 0:
- ✅ #1 Watchers/assignees auth (0.1)
- ✅ #2 DELETE permission (0.2)
- ✅ #3 dual assignee (0.3)
- ✅ #A1 Dashboard My Work filter (0.4)
- ✅ #A3 notification icon (0.5)
- ✅ PATCH project_id (0.6)
- ✅ status transitions (0.2)

Phase 1:
- ✅ #4 status label (1.1)
- ✅ #5 Cancelled column (1.2)
- ✅ #6 status filter (1.3)
- ✅ #7 Socket.io listeners (1.4)
- ✅ #10 dead UI (1.5) — all three built
- ✅ #I10 timezone (1.6)
- ✅ #A11 + polish: unified card (1.7)

Phase 2:
- ✅ #8 status transition (absorbed in 0.2)
- ✅ #17 taskRelationships enum (2.2)
- ✅ notifications enum (2.3)
- ✅ taskLabels PK (2.4)
- ✅ #19 taskComments/Activity org_id (2.5)
- ✅ parent_task_id FK (2.6)
- ✅ #15 circular deps (2.7)
- ✅ #12 duplicate-detect race (2.8)
- ✅ #11 workload dedup (2.9)
- ✅ #21 cross-ref atomicity (2.10)

Phase 3:
- ✅ #A2 agent assignable (3.1)
- ✅ #A3 (extended) source_message_id (3.2)
- ✅ #A5 agent attribution (3.3)
- ✅ Missing tools — comment, due_date, priority, label (3.4)
- ✅ close/reopen (3.5)
- ✅ dependencies (3.6)
- ✅ list_my_tasks (3.7)
- ✅ semantic task search (3.8)
- ✅ #A4 plan fail-fast (3.9)
- ✅ live progress (3.10) — multica pattern adopted
- ✅ proactive agent comments (3.11) — multica pattern adopted
- ✅ inline chat card (3.12) — multica pattern adopted

Phase 4 (skills — unified capability primitive + non-technical workflows):
- ✅ extend existing skills table + unified agent_config/project_config (4.1)
- ✅ agent_employee_skills + project_skills junctions (4.2)
- ✅ seed 9 day-one bundled skills (6 capability-pack + 3 project-workflow; 5 coming-soon packs reserved) (4.3)
- ✅ migrate capability_packs[] → junction (4.4)
- ✅ project skill attach/detach routes + resolver (4.5)
- ✅ JIT install on agent dispatch (4.6)
- ✅ unified agent creation wizard (4.7)
- ✅ create-project wizard with skill attachment (4.8)
- ✅ resolved-config-driven render (statuses/vocab/view/prefix) (4.9)
- ✅ calendar + pipeline views (4.10)
- ✅ custom fields + task templates (4.11)
- ✅ recurrence UI + dead-primitive cleanup (4.12)
- ✅ /skills library + marketplace browser + openclaw import (4.13)
- ✅ version update notifications (4.14)
- ✅ trigger conflict prompt + reassignment (4.15)

Phase 5:
- ✅ notes ↔ tasks (5.1)
- ✅ tasks → expertise (5.2)
- ✅ task → burnout (5.3)
- ✅ manager pulse active count (5.4)
- ✅ bulk batching (5.5)
- ✅ GitHub PR → Done (5.6) — CLAUDE.md promise delivered
- ✅ workflows executor (5.7)
- ✅ project delete/archive (5.8)

Phase 6:
- ✅ detail tabs (6.1)
- ✅ activity diff (6.2)
- ✅ reactions (6.3)
- ✅ @mentions (6.4)
- ✅ attachment progress (6.5)
- ✅ card consistency (6.6)

Phase 7 (QA + deploy):
- ✅ playwright audit for /tasks (7.1)
- ✅ openclaw heartbeat + skill lifecycle regression tests (7.2)
- ✅ full workspace verify + 3-service deploy (7.3)
- ✅ docs update — CLAUDE/FEATURES/HUMAN-TEST/AGENT-TEST (7.4)

Phase 8 (OpenClaw autonomy — earning the "24/7 agent employee" promise):
- ✅ extend heartbeat dispatcher to openclaw (8.1)
- ✅ heartbeat prompt builder from installed skills + overrides (8.2)
- ✅ per-agent cadence config (8.3)
- ✅ heartbeat turn logging + UI (8.4)
- ✅ cost guardrails — daily action + budget caps + unhealthy breaker (8.5)
- ✅ idempotency + loop prevention (8.6)
- ✅ trigger dispatcher binding skill triggers → openclaw execution (8.7)

**Placeholder scan:** no "TBD", "later", or "if time allows" in any task. Every task has Files, Steps, a commit line.

**Type consistency:**
- `STATUS_LABELS` type used consistently across Tasks 1.1 / 4.9
- `skills.agent_config` + `skills.project_config` JSONB shapes documented once in 4.1 (replacing the old single `config` field), consumed in 4.3-4.15 + 8.2
- `Context Source` / `retrieveContext` types extended in 3.8 and match the pattern from the knowledge-unification plan
- `TaskCard variant` type in 1.7 used in Phase 6
- `agent_employee_skills` junction defined once in 4.2, consumed in 4.4/4.6/4.7/4.13/8.2
- Phase 0.2's interim state-machine resolver explicitly replaced by real one in 4.5 (documented as prerequisite-swap, not parallel code paths)

**Migration numbering:** 0025 → 0042 (17 new migrations — one more than originally scheduled because Task 3.9 needed a schema column add). All numbered sequentially, none conflict with existing 0020-0024. Order:
- 0025: task_relationship_type enum (2.2)
- 0026: notification_type enum (2.3)
- 0027: task_labels PK (2.4)
- 0028: task_child_tables org_id (2.5)
- 0029: tasks_parent_fk (2.6)
- 0030: duplicate_flags (2.8)
- 0031: cross_references unique index (2.10)
- 0032: task_activity agent_action_id + acting_agent_employee_id (3.3)
- 0033: tasks embedding + FTS (3.8)
- 0034: agent_plans fail_fast + rollback_on_fail (3.9) — added mid-execution
- 0035: skills table extension (4.1)
- 0036: skill junctions (4.2)
- 0037: migrate capability_packs → junction (4.4)
- 0038: drop native_tools (4.12)
- 0039: notification_type skill_update_available (4.14)
- 0040: agent_heartbeat_overrides (8.2)
- 0041: agent_heartbeat_turns (8.4)
- 0042: task_reactions (6.3)

Note: `orgs.timezone` column already exists (`schema.ts:49`) — Task 1.6 needs no migration.

**Risks:**
- **Phase 4 + 8 together are ~55% of the total scope** — skills as unified primitive + openclaw autonomy is the strategic bet. If trusted-tester feedback kills the multi-skill UX, the engineering-skill-only path still preserves current behavior exactly (zero regression). If openclaw heartbeat proves too chatty/expensive, 8.5's cost guardrails mean we can dial cadence to 2h or disable autonomously without rollback.
- **Data migration risk (4.4)** — migrating `capability_packs[]` into junction rows is destructive-adjacent. Dual-read shim lets us ship incrementally; migration itself is a backfill, not a drop. Keep `capability_packs[]` column around for one full release cycle after cutover as an insurance policy.
- **OpenClaw re-provisioning (4.6)** during JIT install — if a provisioning round-trip fails mid-install, the employee's `connection_status='pending'` but skill is attached to the project. Recovery: Task 4.13 adds a "Retry install" button + `POST /api/agent-employees/:id/retry-provision` endpoint that re-enqueues `deploy-provision`. Task 8.1's pre-flight check already refuses to dispatch heartbeats while `connection_status != 'connected'`.
- **Pipeline view (4.10)** is new component work. If time-pressed, ship Calendar view first and make Sales-skill projects default to List view; Pipeline becomes a fast-follow.
- **Workflows executor (5.7)** is scoped down to one trigger + four actions. Tempting to expand. DON'T. Trusted-tester feedback will tell us if users want more triggers before we build them.
- **GitHub PR → Done (5.6)** depends on webhook delivery. If the webhook infra is stubbed or incomplete, this task becomes a bigger project. Verify by grepping for webhook signature validation in routes/webhooks/ before starting.
- **Recurrence clone gaps (4.12)** — ensure label/metadata cloning doesn't duplicate taskLabels rows. Use the new PK (Task 2.4) to get proper insert-or-ignore semantics.
- **Heartbeat storm (8.1 + 8.7)** — if many orgs deploy at once, 30min * (org_count * agent_count) heartbeats can spike at the top of the hour. Mitigation: register repeatable jobs with `jitter` offset per employee id hash so they spread across the window.
- **Budget enforcement race (8.5)** — action-count increment is not in the same transaction as dispatch. Worst case a few actions over the cap. Acceptable for v1; solve with pessimistic lock only if we see cost overruns in practice.

**Known-ambiguous decisions baked in (can revisit):**
- Reject project_id change (0.6) rather than renumber. Renumber is possible but adds complexity; can upgrade later.
- Primary-vs-additional assignee model (0.3) rather than flattening to one. If trusted testers never use additional-assignees, we can remove the junction table.
- Only `status_changed` trigger in workflows (5.7). Extending later is easier than ripping out.
- Skills have three source tiers (bundled/marketplace/org) from v1 — marketplace browser ships day-one but can be hidden behind a feature flag if moderation takes longer than expected.
- OpenClaw heartbeat defaults to 30min (native 5min). Cadence is per-agent overridable so trusted testers can tune. No global rate limit in v1 — we rely on per-agent action cap + budget cap to bound cost.
- Heartbeat turns log raw response — privacy-sensitive content may land in `agent_heartbeat_turns.raw_response`. Retention policy: 30 days, then null out raw_response but keep aggregates. Document in privacy notes before GA.

---

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-16-task-management-overhaul.md`.** Two execution options:

**1. Subagent-Driven (recommended)** — Fresh implementer subagent per task, two-stage review after each. Phases 0-2 must be sequential (security + schema first). Phase 3 has parallelizable sub-tasks (3.4/3.5/3.6/3.7 touch one file but batch cleanly). Phase 4 requires 4.1/4.2/4.3/4.4 in strict order (schema → junction → seed → migrate); 4.5-4.15 are highly parallelizable after that. Phase 8 runs in parallel with Phase 5/6 — its only dependency is Phase 4's junction tables + skill seeds. Phase 7 is the final QA+deploy gate.

**2. Inline Execution** — Sequential using `superpowers:executing-plans`.

**Recommended order + parallelism:**

- **Week 1 Day 1-2:** Phase 0 (6 tasks — serial; security first). Deploy after.
- **Week 1 Day 3-4:** Phase 1 (7 tasks — mostly parallel). Deploy after.
- **Week 1 Day 5:** Phase 2 (10 tasks — migrations serialized, code changes parallel).
- **Week 2 Day 1-2:** Phase 3 (12 tasks — 3.1-3.3 serial; 3.4-3.7 one batch; 3.8-3.12 another).
- **Week 2 Day 3 — Week 3 Day 1:** Phase 4 (15 tasks — 4.1→4.2→4.3→4.4 strict serial foundation; 4.5-4.15 parallel after).
- **Week 3 Day 2-4 (in parallel):**
  - **Track A:** Phase 5 (8 tasks — heavily parallelizable)
  - **Track B:** Phase 6 (6 tasks — heavily parallelizable)
  - **Track C:** Phase 8 (7 tasks — 8.1→8.2→8.3 serial; 8.4/8.5/8.6/8.7 parallel after)
- **Week 4 Day 1-2:** Phase 7 — audit suite, openclaw regression tests, 3-service deploy, docs.

Total: ~3.5-4 working weeks if single dev, ~2 weeks with aggressive subagent parallelism + clean reviews (Track A/B/C can overlap if reviewer bandwidth allows).

**Deploy cadence:** Every phase gets its own deploy. The earlier phases are stable wins — don't let a failing Phase 5 task block Phase 0-3 shipping. Phase 8 deploys alongside Phase 4 (they share the openclaw runtime surface) so partial Phase 4 landing without Phase 8 heartbeat would leave "24/7 agent" claim unfulfilled.

**Before starting (prerequisites — these are BLOCKERS, resolve first):**
1. **Reconcile wip working-tree changes.** 12 `task-*` files + several route files are modified on this branch but uncommitted. Decide: commit them now as baseline, or stash and reapply after Phase 0.1 lands. Plan assumes they are committed/stashed before Phase 0 starts.
2. **Seed migration dry-run.** Apply migrations 0025-0039 against a local DB from a fresh clone; confirm no ordering issues and seed-bundled-skills produces 14 rows.
3. **Verify openclaw gateway deploy lane.** Confirm `RAILWAY_OPENCLAW_SERVICE_ID` is set and the gateway currently responds to `/health`. Phase 8 assumes the container is already 24/7.
4. **Confirm with product:** non-technical tester lined up for trusted cohort? If yes, Phases 4 + 8 are critical-path. If no, ship Phases 0-3 + 5-6 first, park 4 + 8 until onboarding.
5. **Verify GitHub webhook infra** (grep `apps/api/src/routes/webhooks/`) — if empty, Phase 5.6 AND Phase 8.7 `webhook:github-pr-merged` both become bigger projects.
6. **Run the baseline:** `pnpm test` + `pnpm -r typecheck` + one full Playwright audit pass. Record baseline numbers — every phase must verify zero regression.

Which approach?

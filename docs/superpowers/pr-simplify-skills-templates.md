# PR: Simplify skills + templates

**Branch:** `worktree-simplify-skills-templates`
**Base:** `main`
**Generated:** 2026-04-19

---

## Summary

Collapses the overloaded `skills` primitive to agent-only, moves templates to a first-class `task_templates` catalog, strips per-project customization in favor of fixed engineering defaults, and collapses the agent-create wizard from 5 steps to 3.

End result of the UX audit this started from: the Marketing project crash is fixed, project creation is 1 step (was 2), agent creation is 3 steps (was 5), Library page at `/library` lets users browse bundled skills and templates.

---

## What changed

### Data model
- New `task_templates` table — first-class catalog (not nested in skills). Two bundled templates seeded: Launch Campaign (7 tasks), Re-engage Sequence (14 tasks).
- Dropped `project_skills` junction table.
- Dropped `skills.project_config` jsonb column.
- Dropped 3 project-only bundled skill rows (engineering, marketing-campaign, sales-pipeline) — their dev-time tools moved onto the Deft Workspace bundled skill.
- Migrations: `0045_task_templates_table.sql`, `0046_drop_project_skills.sql`.

### API
- New `GET /api/task-templates` + `GET /api/task-templates/:id` endpoints.
- `POST /api/projects/:id/apply-template` rewritten to read from the new table (was reading from merged skill config).
- `project-resolved-config.ts` collapsed to return hardcoded engineering defaults (no more DB reads, no more skill-config merge).

### Web
- Project create modal: 2 steps → 1 step. No more skill picker.
- Agent create wizard: 5 steps → 3 (Identity, Behavior, Skills). BYOA pre-flight moved from post-submit error to step-1 block.
- New `/library` page with Skills + Templates tabs + sidebar nav entry.
- New "+ from template" picker in task quick-create.
- `useProjectResolvedConfig` hook collapsed to hardcoded defaults (fixes the Marketing project crash).
- Agent wizard skill list filters to non-empty `agent_config` (hides project-only skills).

### Build-required files
Committed 6 files that existed only as untracked in the main workspace but are imported by committed code:
- `apps/api/src/workers/handlers/wiki-lint.ts`
- `apps/web/src/app/(app)/knowledge/graph.tsx`
- `apps/web/src/app/(app)/tasks/timeline.tsx`
- `apps/web/src/components/confirm-dialog.tsx`
- `apps/web/src/app/forgot-password/page.tsx`
- `apps/web/src/app/reset-password/page.tsx`

Without these, API typecheck failed and web pages crashed at build time. Ship together so the branch builds in isolation.

### Docs
- `CLAUDE.md` updated — reflects agent-only skills, first-class templates, fixed engineering defaults, and removal of the "Postgres status enum constraint" known limitation (no longer applicable).

---

## Verification

- `pnpm --filter @deft/api typecheck` — clean.
- `pnpm --filter @deft/web typecheck` — clean.
- `pnpm --filter @deft/api test` — all pass except `phase8-heartbeat-prompt.test.ts` (pre-existing red — schema drift on `skills.author_user_id`; not introduced by this PR).
- Two audit scripts committed under `docs/superpowers/audits/`:
  - `simplify-skills-templates.audit.ts` — 17/17 green end-to-end smoke.
  - `simplify-extensive.audit.ts` — 21/21 green including full agent creation flow, template apply, Marketing project no-crash, task assignment to agent, status transitions.

---

## Test plan (reviewer)

- [ ] Clone PR branch, run `pnpm install && pnpm --filter @deft/api typecheck` — expect clean.
- [ ] `pnpm --filter @deft/web typecheck` — expect clean (unrelated `graph.tsx`/`timeline.tsx`/`confirm-dialog.tsx` errors should be absent now).
- [ ] Start dev servers (`pnpm dev`), navigate `/library` — Skills + Templates tabs render with bundled content.
- [ ] Create a new project — verify single-step modal, no skill picker.
- [ ] Open Marketing project (or any other existing project) — verify no "Cannot read properties of undefined (reading 'length')" crash.
- [ ] Settings → Agent Employees → Create Agent — verify "Step 1 of 3" progress indicator, BYOA pre-flight on step 1.

---

## Migration notes for deploy

- Migrations 0045 + 0046 must run in order. 0046 drops `project_skills` table + `skills.project_config` column + deletes 3 bundled skill rows in one transaction.
- `pnpm tsx apps/api/src/scripts/seed-bundled-templates.ts` must run after 0045 to seed the 2 bundled templates.
- `pnpm tsx apps/api/src/scripts/seed-bundled-skills.ts` must run after 0046 to re-seed the 6 remaining bundled skills (with the Phase-3 task tools now on Deft Workspace).

---

## References

- Design spec: `docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-18-simplify-skills-templates.md`
- UX audit screenshots: `docs/superpowers/audits/screenshots/simplify-*/`

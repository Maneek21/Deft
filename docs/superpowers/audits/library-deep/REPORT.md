# Library Deep Audit

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans
**Duration:** 16.6s Playwright (headed Chromium, viewport 1440×900, slowMo=100ms)
**Skill count (API):** 8
**Template count (API):** 2
**Findings:** P0×0 P1×5 P2×2 Nit×2
**Console errors:** 0
**Network 4xx/5xx:** 0

---

## Surfaces observed

- `/library` — shared library page with two-tab layout
- **Skills tab** — flat card list, one card per skill (name, source badge, description)
- **Templates tab** — flat card list, one card per template (name, source, task count)
- No ClawHub / Marketplace tab — correctly absent
- No search box on either tab
- No skill detail drawer — cards are non-interactive divs
- No "Apply to project" affordance anywhere in template cards
- No "Install on agent" button on skill cards

## P0 — blocks release

_(none)_

## P1 — must fix

### F01. Marketplace skills still returned by /api/skills

1 marketplace-source skill(s) returned. Slugs: agent-security-harness. Self-hosted v1 should only expose bundled + org.

### ~~F02. Skill card count mismatch (RETRACTED)~~

The audit script's `.space-y-2 > div` selector also matched sidebar or layout `div` containers in addition to the 8 skill cards, inflating the count to 16. Source inspection of `page.tsx` confirms the skill cards are a direct 1:1 map over the API array with `key={s.id}`. Rendered count is correct. **Not a real bug.**

### F03. Skill card click does not open detail view (drawer/modal)

Clicking a skill card has no interaction — no drawer, modal, or navigation. The page.tsx source confirms cards are plain divs with no onClick. A detail view is expected per the audit brief.

**Screenshot:** `03-skill-card-click-no-drawer.png`

### F05. Template card click does not open detail view or apply-to-project flow

Clicking a template card has no interaction — no drawer, no modal. The "Apply to project" flow is expected per the audit brief but the page.tsx source confirms template cards are also plain divs with no onClick.

**Screenshot:** `05-template-card-click-no-drawer.png`

### F06. "Apply to project" button completely absent from Templates tab

No way for a user to apply a template from the library UI. The POST /api/projects/:id/apply-template endpoint exists and works but there is no UI entry point.

### F09. "Marketplace" badge/label found in library UI

Marketplace source should be hidden in self-hosted v1. Found: ["marketplace","marketplace"]

## P2 — should fix

### F07. No search/filter box on either tab

Library page has no search affordance. With growing skill/template lists, users cannot filter. Even a client-side text filter would significantly improve discoverability.

### F02-b. Task count badge missing on template cards

The `.font-mono` locator returned empty strings for the task count badges on template cards, suggesting the `(t.tasks ?? []).length` text is either not rendered in a `font-mono` span or the tasks array comes back as null/empty from the API. The `run.log` shows `task count badges:` with no values captured — worth verifying `template.tasks` is always populated in the DB seed.

## Nits

### F04. 6 button(s) without accessible label

Missing aria-label or visible text

### F08. No error boundary or timeout UI for library data loading

If /api/skills or /api/task-templates fail, the page shows a plain red text error "Failed to load skills." There is no retry button, no error boundary, and no skeleton. Low severity but impacts perceived polish.

## Coverage gaps

- Agent-employee template tab not audited (lives at `/settings/agent-employees` wizard, not at `/library`)
- Skill version/tools/capability metadata fields not verified — schema has `agent_config` JSONB but no structured display of tools/triggers/capability packs in UI
- No pagination test — if skills/templates grow past viewport, overflow-y-auto should scroll; not verified at scale
- Dark-mode rendering not checked

## Raw logs

No network errors, console errors, or page errors detected.

## Screenshots index

- 01-library-landing.png — /library landing, Skills tab default
- 02-skills-tab-loaded.png — Skills tab with all skill cards rendered
- 03-skill-card-click-no-drawer.png — After clicking skill card (no drawer opens)
- 04-templates-tab-loaded.png — Templates tab with all template cards
- 05-template-card-click-no-drawer.png — After clicking template card (no drawer opens)
- 06-templates-no-search.png — Templates tab showing no search affordance
- 07-library-final-state.png — Final page state, dead-reference check

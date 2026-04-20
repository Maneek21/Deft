# Settings Deep Audit

**Date:** 2026-04-20
**Branch:** feat/phase2-4-mcp-agents-plans
**Duration:** 32s (well within 8-min budget)
**Tests:** 9 passed, 0 failed
**Console errors:** 0
**HTTP 4xx/5xx:** 0
**Screenshots:** 18

---

## Subtabs observed

All 8 expected subtabs confirmed in sidebar nav:

| # | Label | URL | Status |
|---|-------|-----|--------|
| 1 | General | /settings | OK |
| 2 | Members | /settings/members | OK |
| 3 | Groups | /settings/groups | OK |
| 4 | Tags | /settings/tags | OK |
| 5 | Integrations | /settings/integrations | OK |
| 6 | Agent | /settings/agent | OK |
| 7 | Agent Employees | /settings/agent-employees | OK |
| 8 | API Access | /settings/api-access | OK |

No "Deploy" tab present. No "Workflows" tab linked (route exists but not in nav).

---

## P0 - blocks release

None found.

---

## P1 - must fix

### P1-1: McpConnectionForm modal Cancel button blocked by overlay

**Location:** /settings/integrations - "Add MCP Server"

When the MCP connection modal opens, the full-screen backdrop overlay (`div.fixed.inset-0.z-50`) intercepts all pointer events, making the Cancel button inside the modal unclickable. Playwright click times out after 30s because the overlay sits on top.

**User impact:** Users clicking Cancel get no response. Escape key works as a workaround, but is undiscoverable.

**Fix:** Add `onClick={e => e.stopPropagation()}` on the inner modal card. Ensure Cancel button has higher z-index than the backdrop, or restructure the modal so backdrop and content are siblings (not parent/child).

### P1-2: "Regenerate token" button present, permanently disabled, with internal-jargon tooltip

**Location:** /settings/agent - employee drawer - Connection section (BYOA/Custom MCP employees)

Button renders with `disabled` and `title="Coming in Phase 8"`. "Phase 8" is internal sprint nomenclature -- users see a permanently greyed button with an inscrutable tooltip.

**Fix:** Remove button until shipped, or change tooltip to "Coming soon" with a brief description of the feature.

---

## P2 - should fix

### P2-1: API Access -- permissions hardcoded to `mcp:full`, no scope selector

The Create API Key form has no permission scope picker. Every key is created with `['mcp:full']` hardcoded. Users who need read-only or scoped keys have no recourse from the UI.

### P2-2: General page has no workspace name / timezone / branding fields

/settings (General) only shows Profile (name + email read-only) and Appearance (theme toggle). No workspace renaming, logo, or timezone. First-time admins expect "General" to control workspace identity. Consider renaming to "Profile & Theme" or adding workspace fields.

### P2-3: Dual employee-list surfaces may confuse users

Both /settings/agent and /settings/agent-employees list employees. /settings/agent is the operational dashboard (trust level, pending approvals, action log). /settings/agent-employees is a directory view + onboarding entry point. The distinction is not communicated on either page.

### P2-4: Member remove button invisible by default (accessibility concern)

The Trash2 remove button on member rows has `opacity-0` with JS onMouseEnter/onMouseLeave handlers rather than Tailwind group-hover. Keyboard-only users cannot discover or tab to the control.

---

## Nits

1. Invite form dismissed via Invite button toggle rather than a Cancel button -- non-standard UX but functional.
2. API Access page has no copy pointing to `/api/mcp/v1` -- first-time MCP integrators won't know the endpoint.
3. Groups page has no empty-state message when no groups exist ("No groups yet" style copy missing).
4. Tags page tag pill elements use `rounded-full` rather than semantic class names -- minor.
5. "Coming soon" on Slack and Gmail renders correctly.

---

## Dead deleted-feature references

| Feature | Status |
|---------|--------|
| "Deploy" tab in sidebar | NOT PRESENT - correctly removed |
| "Railway" / "deployment provider" copy | NOT PRESENT - correctly removed |
| "ClawHub" reference | NOT PRESENT - correctly removed |
| "Personality" in kebab menu | NOT PRESENT - correctly removed |

Kebab menu items verified: Developer, Webhooks, Clone agent, Save as template.
Developer link correctly navigates to /settings/agent-employees/<id>/developer.

---

## Coverage gaps

- Invite submit end-to-end (not submitted to avoid real data mutation)
- Role change API round-trip (dropdown opened, options verified, PATCH not fired)
- Connect Wizard full tab flow (separate audit)
- Agent employee Developer and Webhooks pages (links verified, pages not loaded)
- MCP connection expand + tool override toggles
- Dark mode across all subtabs
- OAuth connect redirect (requires real credentials)

---

## Raw logs

See run.log in this directory.

---

## Screenshots index

| File | Content |
|------|---------|
| 01-settings-landing.png | /settings General with Profile + Appearance |
| 02-members-list.png | Members -- rows + Invite button |
| 02-members-invite-form.png | Invite form open -- email + role selector |
| 03-integrations.png | 4 OAuth providers + MCP Connections section |
| 03-integrations-mcp-form.png | McpConnectionForm modal open |
| 04-agent-dashboard.png | Agent Settings -- Trust Level + 5 employee rows |
| 04-agent-kebab-open.png | Kebab menu: Developer, Webhooks, Clone agent, Save as template |
| 04-agent-drawer-open.png | Employee drawer -- trust upgrade + delete + recent turns |
| 05-agent-employees.png | /settings/agent-employees list |
| 05-agent-employees-list.png | Same -- Create Agent button |
| 05-agent-employees-create-wizard.png | Connect Agent wizard -- 3 tabs |
| 06-api-access.png | API Access empty state |
| 06-api-access-create-form.png | Create API Key form |
| 07a-general.png | General -- Profile + theme picker |
| 07b-groups.png | User Groups |
| 07c-tags.png | Tags |

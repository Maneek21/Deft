# Settings review passes — 2026-09-09

Scope: visual and interaction review of the current Settings implementation on
`codex/settings-visual-polish`, using the localhost:3025 app and synthetic,
read-only API fixture. This is not a production integration certification.

## Pass 1: route inventory and desktop layout

Visited all 18 top-level Settings routes at 1440 CSS px. Pages loaded without a
rendered application crash or page-level horizontal overflow. Profile's initial
automated heading observation matched an Overview card during navigation;
the saved Profile screenshot and subsequent direct inspection verified the page.

| Route | Desktop | Mobile initial layout (390 CSS px) |
| --- | --- | --- |
| `/settings` | Reviewed | Reviewed |
| `/settings/profile` | Reviewed | Reviewed |
| `/settings/mcp-access` | Reviewed | Reviewed |
| `/settings/calendar` | Reviewed | Reviewed |
| `/settings/members` | Reviewed | Reviewed |
| `/settings/teams` | Reviewed | Reviewed |
| `/settings/apps` | Reviewed | Reviewed |
| `/settings/modules` | Reviewed | Reviewed |
| `/settings/groups` | Reviewed | Reviewed |
| `/settings/agent-employees` | Reviewed | Reviewed |
| `/settings/ai` | Reviewed | Reviewed |
| `/settings/integrations` | Reviewed | Reviewed |
| `/settings/agent` | Reviewed | Reviewed |
| `/settings/library` | Reviewed | Missing title fixed |
| `/settings/workflows` | Reviewed | Narrow action fixed |
| `/settings/tags` | Reviewed | Initial layout fits; form overflow fixed |
| `/settings/projects` | Reviewed | Reviewed |
| `/settings/api-access` | Reviewed | Narrow action fixed |

## Pass 2: mobile screenshots

Saved and inspected initial screenshots for all 18 routes. Page-level width alone
was insufficient: a nested horizontal scrolling container hid overflowing tag-form
controls. The follow-up check measured individual visible control bounds too.

Evidence: `tmp/preview-evidence/audit-mobile-0.png` through `audit-mobile-17.png`,
three `audit-sheet-*.png` contact sheets, and `settings-audit.json`. These ignored
local artifacts use sample data; they are not checked into the repository.

## Pass 3: forms, secondary routes, and fixes

Opened service-key, task-rule, tag, group, team and invitation forms at phone width.
Inspected agent creation and the staged Contacts App detail route. No invitations,
credentials, App activation, trust changes or external writes were performed.

Reproduced and fixed:

1. Task templates used a compact PageHeader without an alternative mobile title.
   Removed compact mode; the title is now visibly rendered at 390px.
2. Task-rule creation action was squeezed into a tall, narrow label by the heading
   row. Stack the header on narrow screens and keep the action from shrinking.
3. Service API creation action had the same problem. Applied the same bounded fix.
4. Tag creation's Create and Cancel controls extended to approximately 397px and
   441px on a 390px viewport. Use a two-row mobile grid and a shrinkable input.
   Give the input, cancel control and colour buttons accessible names and expose
   the selected colour with aria-pressed.

Fresh recheck: zero offscreen tag controls at 390px and 320px; colour selection
updates aria-pressed; cancel closes the form. Inspected corrected screenshots for
all four pages: `audit-fixed-{tags,templates,rules,service}-mobile.png`.

Web typecheck, focused ESLint for the four changed pages, three Settings navigation
tests, and git diff whitespace checks passed. No backend contracts changed.

## Remaining evidence gaps

- The four employee record routes (detail, developer, heartbeats, webhooks) need
  populated employee records; this fixture has none. Their healthy rendered states
  were not certified in this pass.
- Empty lists do not prove populated tables, long records, pagination or every
  dialog state. The staged App detail is one sample, not lifecycle certification.
- Save persistence, real OAuth/MCP connections, role-based runtime authorization,
  screen-reader use, browser zoom and exhaustive light-theme states remain outside
  this pass. Previous light-theme inspection was representative, not exhaustive.
- Some existing forms still use placeholder-only labels and small controls. The
  fixes above are specific findings, not a claim of complete accessibility.

PR #325 remains stacked on #324 and unmerged for user review.

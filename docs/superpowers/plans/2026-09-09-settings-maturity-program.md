# Settings maturity program

Status: active. User authorized iterative implementation and PR creation; never
merge or enable auto-merge before user review. This is a delivery checkpoint, not
a claim that Settings is complete. Resume from the first unfinished milestone.

## Workspace and existing evidence

Work in `C:/tmp/deft-settings-structure`; current implementation branch is
`codex/settings-connection-flow`, based on `codex/settings-structure` at 5f6f0d86.
PR #323 contains the first structural pass and connection overflow repair.
Preserve the original worktree and unrelated changes. Keep milestones separately
reviewable; use explicitly based follow-up branches/PRs for subsequent features,
and record their base and dependency rather than silently merging the first PR.

Local renderer: http://localhost:3025. API fixture: localhost:4191.
The fixture does not persist changes or issue credentials. It cannot establish
database-backed or external integration acceptance. Existing UI evidence and
foundation boundaries are in `2026-09-09-settings-implementation-loops.md`.

## Definition of the outcome

Users can locate a setting, understand who and what it affects, perform the task,
and verify its outcome. Main surfaces prioritize the next useful action. Existing
authorization, API payloads and lifecycle operations remain intact unless a
separately reviewed contract change is required. No fabricated connection health,
success, role access or release certification.

## Route inventory confirmed from source

| Destination | Existing route | Intended pattern |
| --- | --- | --- |
| Overview | /settings | Role-filtered searchable directory |
| Profile | /settings/profile | Identity/preferences form and separate security actions |
| Personal AI connections | /settings/mcp-access | Managed list, guided setup, connection management |
| Calendar connections | /settings/calendar | Connection list and feed-sharing configuration |
| People | /settings/members | Member/invitation list and role management |
| Teams | /settings/teams | Managed membership list/detail |
| Apps | /settings/apps, /settings/apps/[id] | Installed list, detail, governed setup |
| Modules | /settings/modules | Owned/standalone list, collection policy configuration |
| Mention groups | /settings/groups | Reusable mention lists; distinct from access membership |
| Agent employees | /settings/agent-employees | Canonical roster and employee detail |
| Employee setup | /settings/agent-employees/create | Guided setup |
| Employee operations | /settings/agent-employees/[id], /webhooks, /heartbeats, /developer beneath that detail | Contextual operational detail |
| AI configuration | /settings/ai | Provider readiness, model routing, search, voice |
| Tool connections | /settings/integrations | Shared MCP-server management |
| Policies and audit | /settings/agent | Separate policy configuration and evidence inspection |
| Task templates | /settings/library | Reusable template list/detail |
| Task rules | /settings/workflows | Rule list/editor |
| Tags | /settings/tags | Compact labels list with usage |
| Project recovery | /settings/projects | Deleted-resource list and restore action |
| Service API access | /settings/api-access | Credential lifecycle management |

This inventory establishes destinations, not a completed control audit. Before
rewriting each page, enumerate its handlers, API calls, role conditions and
secondary actions. Record their replacement locations. Inspect server contracts
for consequences and authorization; frontend labels alone are insufficient.

## Shared interaction contract

- One page title and concise purpose; avoid decorative category badges and
  repeated explanations. Use the existing theme tokens and typography.
- Forms use readable constrained widths; managed lists may use wider layouts.
  Setting rows contain label, explanation, current value/control and local feedback.
- Cards denote independent resources or distinct tasks, not every nested paragraph.
- Explicit Save for related form fields. Preserve drafts while changing sections.
  Show unsaved changes and intercept discard where necessary. Do not mix implicit
  autosave with explicit saves without an obvious distinction.
- Action feedback appears adjacent to the originating control and is announced
  accessibly. Pending requests prevent duplicates; failures retain input and offer
  recovery. Never announce success before confirmation.
- States: loading, empty, ready, partial configuration, unavailable, denied, saving,
  saved and failed. Resource health requires actual backend evidence.
- Keyboard focus stays visible and follows meaningful setup transitions. Steps
  have labels and current-step semantics; inputs have persistent accessible labels.
- At 390px and narrower, secondary content follows the main task. Test 200% zoom,
  long names, long commands and large lists. Internal code scrolling must not
  expand parent cards. Use bounded columns with zero minimum widths.
- Keep all role/feature-filtered destinations aligned between navigation, overview
  and search. Do not expose hidden admin metadata through search results.

## Milestones and completion evidence

### 1. Reference connection experience — next implementation

Inventory is the initial state. Setup has four explicit stages: client, access,
connect, verify. OAuth clients review access on the actual authorization screen;
do not imply local presets govern an external grant. Shared employees lead to the
employee setup destination. Token clients retain the existing scope contracts.

Use a compact client picker. Access presents a recommended set and expandable
individual controls. Connect shows one client's instructions and local copy/error
feedback. Verification distinguishes instructions from observed activity. Preserve
drafts on Back/Next and setup close; client changes must not silently leave a token
with misleading instructions or lose an unacknowledged one-time credential.

Extract reusable step/section/feedback patterns only when this reference uses
them. Do not create an unused component library. Include future list/detail
management without deleting revocation, grants or history.

Acceptance: all client branches; all permission presets; empty scopes; back/next;
draft retention; clipboard failure; request failure/retry; token once-only display;
actual verification state; keyboard and mobile. Add regression coverage against
observable behavior, and update production smoke to follow the new flow.

### 2. Apps, Modules and employee ownership

Expose organization-scoped module ownership in the read contract before routing
management to its owner. Preserve standalone actions and collection access policy.
Audit Governance-only employee actions (clone, template, trust and receipts) before
consolidation. Apply architecture-gate for contract/trust changes. Separate schema
or API work from presentation when it improves review and rollback.

### 3. Shared patterns across remaining pages

Apply the validated reference patterns to Profile, Calendar and AI, then People,
Teams, groups, tool connections, policy/audit, templates, rules, tags, recovery and
service access. Track each page's control inventory and verification rather than
claiming a blanket pass from page-load screenshots.

### 4. Integrated acceptance and polish

Use a disposable database-backed workspace, representative roles and realistic
records. Verify persistence, denied actions, recoverable failures, browser history,
deep links, refresh, keyboard, zoom and responsive layouts. Test live connector
flows only within user-authorized scope. Require independent user task validation
before calling usability proven. Resolve relevant CI/security blockers separately.

## Loop protocol

Each loop: read this checkpoint and git status; inspect relevant code; implement a
bounded coherent change; reproduce/verify behavior; inspect final diff; commit and
open/update a PR only with fresh evidence. Update this document with completed
work, evidence, exact next action and blockers. Never treat elapsed time or silence
as approval. Continue independent work when external review is pending. No merge,
production deployment, real credential grants or external messages are implied.

## Current checkpoint

- Completed: existing route inventory and shared interaction specification above.
- Existing repair: PR #323, commit 6e0ec97b, 54 rendered connection states verified;
  web lint/typecheck/navigation tests passed. Updated production smoke pending.
- Implemented: guided connection setup on `codex/settings-connection-flow`:
  compact client selection; access review; client-specific connection instructions;
  explicit verification. Shared employee setup exits to its existing destination.
  Added reusable SettingsSteps progress with current-step semantics and step focus.
  Existing token scope payloads and OAuth permissions are unchanged. New tokens
  lock the client, name and scopes, prevent duplicate generation, and require an
  explicit saved-token acknowledgement before advancing. Back/Next retains drafts
  and the one-time token. Clipboard failures produce local feedback.
- Verification uses the issued token_id against the existing inventory response;
  it does not infer connection success from completing instructions or another
  token's activity. Contextual memory guidance is expandable.
- Fresh evidence: all seven client branches traversed at 390 and 1440 CSS px,
  without visible section overflow; name and custom permissions retained across
  steps; rejected issuance kept the Connect step; inert synthetic issuance tested
  acknowledgement gating, duplicate prevention, locked client/access controls and
  pending verification despite another fixture token having recent use. The fixture
  was returned to read-only mode afterward. Typecheck, full web lint, navigation
  tests and smoke-script syntax passed. Production smoke now traverses the steps,
  checks command containment and name retention; CI execution remains pending.
- Screenshots: `tmp/preview-evidence/guided-access-desktop.png` and
  `guided-connect-mobile.png`. These are fixture-based visual evidence only.
- Whole-page follow-through (PR #324, stacked on #323): replaced the management
  dashboard with a searchable unified token/authorization list, expandable access
  and activity, inline revoke confirmation, and restrained history/developer
  disclosures. Setup is a separate view with compact client rows, a plain-language
  access selector, focused credential instructions and connection-specific checks.
  Cancelling preserves drafts; finishing clears the acknowledged credential.
  Partial request failures retain the last inventory with an explicit warning;
  history and metadata failures have distinct retry states. Verification prompts
  follow the selected connection's actual permissions. Copy feedback is local.
- Fresh whole-page evidence: seven client paths at 390 and 1440 CSS px without
  section overflow; management and expanded revoke confirmation also checked at
  320 px. Inspected dark desktop/mobile and light desktop/reflow layouts. Tested
  search/clear, empty state, partial load failures/recovery, token and grant revoke,
  failed revoke/retry, custom-scope validation, draft retention, inert issuance,
  acknowledgement/duplicate guards, pending and fixture-observed activity,
  grant-specific prompt permissions, and focus on steps/confirm/cancel/finish.
  Web typecheck, full web lint, three navigation tests, smoke syntax and diff check
  passed. Production smoke now includes issuance/acknowledgement/revoke against
  its disposable seeded backend; that updated smoke has not been run locally.
- Current screenshots: `tmp/preview-evidence/connections-whole-desktop.png`,
  `connections-whole-mobile.png`, `connections-whole-light.png`, and
  `connections-access-desktop.png` / `connections-access-mobile.png`.
  All are synthetic fixture evidence, not proof of OAuth or persistence. Browser
  zoom and screen-reader acceptance remain unverified; narrow reflow is not a zoom
  test. The preview fixture returns to read-only mode after the interaction pass.
- Next: obtain database-backed integration and independent usability evidence for
  this page, strengthen zoom/screen-reader acceptance, then apply the patterns to
  Profile/Calendar/AI. Module ownership and canonical employee work require their
  explicit contract/control audits before implementation.
- Open: dependency audit, real integration evidence, independent usability review.
- Visual polish follow-up: page-local CSS strengthens field/row boundaries and
  surface contrast, aligns setup with the page heading, tightens section spacing,
  distinguishes heading levels, deepens primary button colour, and adds consistent
  hover/focus treatment with reduced-motion support. No API or permission changes.
  Inspected desktop dark/light, mobile permissions/connect/expanded details, and
  keyboard focus; custom permissions had no section overflow at 390 CSS px.
  Fresh web typecheck, focused page lint and diff checks passed. Evidence lives in
  `tmp/preview-evidence/polish-*.png`. This is fixture-based visual verification.
- The Settings implementation schedule was deleted at the user's request. Continue
  only on direct user instruction; do not recreate it from this checkpoint.

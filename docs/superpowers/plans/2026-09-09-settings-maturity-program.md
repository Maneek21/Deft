# Settings maturity program

Status: active. User authorized iterative implementation and PR creation; never
merge or enable auto-merge before user review. This is a delivery checkpoint, not
a claim that Settings is complete. Resume from the first unfinished milestone.

## Workspace and existing evidence

Work in `C:/tmp/deft-settings-structure`, branch `codex/settings-structure`.
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
- Next: inspect full connection-page handlers and extract a client/access/connect/
  verify state model, then implement the reference flow on a follow-up branch.
- Open: dependency audit, real integration evidence, independent usability review.

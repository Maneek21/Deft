# Settings structural review

Exploratory review, 2026-09-09. Builds on the Apps/Modules exploration. No settings, credentials, grants or product source were changed.

Evidence: navigation map and targeted page-source review at `46da535e`, plus read-only live inspection of Settings overview, Personal AI connections, Agent employees, Governance, Tool servers and AI providers at demo.deft.ing. Live deployment revision was not independently identified. Profile, Calendar, task settings and People/Teams observations below are source-based. No mobile, role matrix, mutation or accessibility certification was performed in this pass.

## Finding

Several pages need the same structural treatment as Apps, but the work should be scoped by responsibility rather than applying a uniform visual reskin. The recurring problems are setup forms before inventory, overlapping management surfaces, inconsistent names, operational views buried in Settings and mixed personal/workspace/operator ownership.

## Priority and treatment

| Priority | Surface | Evidence / problem | Recommended treatment |
|---|---|---|---|
| High | Personal AI connections, Tool servers, API access | Sidebar says Connections, page heading says AI App Connections, browser title says MCP Access. Personal inbound clients, outbound tools and service credentials require users to understand three similar integration concepts. | Put personal clients under Your account → AI connections; workspace tool servers under Agents & AI → Tool connections; service keys under Developer access. Keep the principals and credentials distinct. |
| High | Personal AI connections page | Client selection, permission presets, token/config setup, test prompts and context-packet explanations appear above Manage active connections. | Existing users land on connection inventory with name, access, last activity and revoke/manage actions. Add connection opens the existing useful client-first guided flow. First-use can still open onboarding. Keep exact scope review and one-time secret handling. |
| High | Agent employees + Governance | Employees already has search, status filters, detail routes and setup detection. Governance separately lists/manages the same employees with drawers and action controls, alongside policy and logs. Approvals link to Inbox. | One employee inventory and one detail destination. Governance owns workspace policy/defaults and audit navigation, not a second roster. Pending approvals stay in Inbox; employee pages can deep-link with context. |
| High | AI providers | Provider credentials, classify/summarize/reason/extract routing, embeddings and transcription form one long configuration page. Header promises workspace scope; transcription explains environment-level keys and operator defaults. | Inventory/overview first, then Providers, Models, Search and Voice sections. Clearly distinguish saved workspace override, effective configuration and operator-managed prerequisite. Advanced routing remains available without dominating initial setup. |
| Medium | Profile | Identity/avatar/title, presence/status, DND, notification controls, read receipts, preview and password change occupy one page. | Split Your account into Profile, Notifications, and Security, with Appearance alongside them. Status can stay near profile/presence. Retain the useful profile preview only with identity editing. Preserve independent save boundaries and unsaved-change behavior. |
| Medium | Task templates, Automations, Tags, Project recovery | Related task administration is scattered in Advanced. Sidebar Automations opens a page titled Workflows; this page only implements deterministic task status rules. | Group under Work management: Templates, Task rules, Tags and Project recovery. Use Task rules consistently. App schedules remain owned by their Apps; a future cross-type overview may link to owners without merging execution models. |
| Medium | Calendar | Sidebar Calendar opens Calendar sync; source implements two directional ICS flows: publish Deft's personal feed, subscribe to external feeds. | Call it Calendar connections or Calendar feeds. Separate Connected calendars from Share Deft calendar. Lead with subscription health/last sync and use Add calendar for setup. Show that feeds are read-only in their respective direction; avoid implying bidirectional provider sync. Preserve private feed URL controls. |
| Medium, later | Teams | Team details include workload, needs-attention, roster, knowledge context and linked resources inside Settings. | Keep membership/configuration in Settings. Consider a workspace Team page for everyday team work later, reusing the same detail model. Do not add another competing management surface. |
| Low | Settings overview | General is an overview plus appearance control. Overview cards duplicate navigation definitions and labels: People & teams links only to People; Apps/Modules are repeated; Open task settings links to Templates. | Name it Overview, preserve search, and generate labels/destinations from a shared navigation registry where appropriate. Links should name their actual destination. Move appearance to the personal group. |
| Low | People, Mention groups, Tags, Recovery | These have comparatively narrow jobs. | Improve naming, empty states, consistent actions and placement. No evidence in this pass justifies a large rewrite. Mention groups and Teams must stay semantically distinct: notification lists are not membership/access boundaries. |

## Suggested navigation model

This is a grouping proposal, not a requirement to create all new routes immediately. Groups can be collapsed and role-filtered; splitting responsibilities should not produce a longer undifferentiated sidebar.

| Group | Destinations |
|---|---|
| Your account | Profile; Notifications; Appearance; Security; Personal AI connections |
| Workspace | People; Teams; Apps; Calendar connections; Mention groups |
| Work management | Task templates; Task rules; Tags; Project recovery |
| Agents & AI | Agent employees; AI configuration; Tool connections; Policies & audit |
| Developer & operator | API/service access; relevant diagnostics; License & source |

Calendar placement needs one explicit ownership decision during implementation: personal feeds should be presented as personal; workspace-shared subscriptions should be labeled with their actual owner. Do not move a page into a workspace group and imply it grants shared authority.

Apps remains the owner for its collection lifecycle, bindings and schedules. Personal AI connections act as the current person; agent employees are shared identities; tool connections supply external capabilities; model providers supply inference; service keys authenticate automation clients. Similar visual components are appropriate, but these are not interchangeable authorization models.

## Shared interaction pattern

1. Inventory or effective status first for repeat visits.
2. One obvious add/setup action; onboarding in a focused flow.
3. A dedicated detail view for access, configuration and activity.
4. Plain-language blocker with a next action; do not merely disable a button.
5. Technical configuration and audit identifiers available on demand.
6. Owner/scope visible before a sensitive change; preserve current server enforcement and review semantics.
7. Show success only after confirmed save; failed requests retain the last confirmed effective state and present recovery.

Do not mechanically move every form to a drawer. Complex credential setup, access review and employee configuration benefit from stable detail routes and enough space. Small editing tasks can remain inline.

## Implementation order

1. Finish the Apps/Modules ownership design already explored.
2. Reconcile navigation names and personal versus workspace ownership; keep old URLs working.
3. Rework Personal AI connections and remove the duplicate Governance employee roster. These offer the strongest next structural improvement.
4. Reorganize AI configuration around effective status and prerequisite ownership.
5. Split Profile responsibilities and regroup task/calendar settings.
6. Reassess moving daily team/agent operations outside Settings after the administrative flows are clear.

Avoid making a whole-Settings rewrite a prerequisite for B/C. The first two follow-ups can be focused slices that reuse existing services and forms. Any change to credentials, trust or approval meaning requires separate boundary review; this proposal changes presentation and navigation, not authority.

## Acceptance for a redesign

- A person can distinguish “connect my Codex,” “connect a shared agent,” “add external tools,” and “configure Deft's model” without knowing MCP terminology.
- A returning user can inspect/revoke a connection without scrolling through creation instructions.
- An employee has one canonical settings/detail destination; policy changes and pending approvals have clear separate owners.
- UI states distinguish saved credentials, tested reachability, active runtime contact and actual readiness; none is inferred from another.
- Workspace and operator prerequisites are visible before users encounter an unusable control.
- Existing URLs, feature-flag fallbacks, role restrictions, one-time secrets and exact access reviews continue working.
- Representative empty, configured, blocked, error and non-admin states are checked at desktop/mobile sizes and with keyboard navigation.

## Source pointers

All refer to the inspected current snapshot under `tmp/app-audit-2026-09-09/current`:

- `apps/web/src/lib/settings-navigation.ts`: canonical current sidebar groups and names.
- `apps/web/src/app/(app)/settings/page.tsx:24`: separately authored overview cards.
- `apps/web/src/app/(app)/settings/mcp-access/page.tsx:625`: onboarding before active-connection management at line 974.
- `apps/web/src/app/(app)/settings/agent/page.tsx:299`: policy, duplicate Employees section and action log.
- `apps/web/src/app/(app)/settings/agent-employees/page.tsx:196`: existing inventory and status filters.
- `apps/web/src/app/(app)/settings/integrations/page.tsx:178`: tool inventory preceded by cross-routing cards and a repeated Calendar recommendation.
- `apps/web/src/app/(app)/settings/ai/page.tsx:115`: providers, routing, embeddings and transcription.
- `apps/web/src/app/(app)/settings/profile/page.tsx:255`: mixed profile/preferences/security layout.
- `apps/web/src/app/(app)/settings/workflows/page.tsx:145`: Workflows title and task-rule scope.
- `apps/web/src/app/(app)/settings/calendar/page.tsx:85`: outbound and inbound ICS sections.
- `apps/web/src/app/(app)/settings/teams/page.tsx:869`: operational workload/context sections within Settings.

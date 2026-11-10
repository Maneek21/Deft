# Apps and Modules: product maturity plan

Date: 2026-09-09. Status: proposed execution sequence; analysis only.

Current direction: the [flagship Contacts CRM plan](2026-09-09-flagship-contacts-crm.md) supersedes the lineup and delivery sequence below, including the subsequent three-App proposal. Focus on one productive CRM with selected Campaigns features. This document remains the source inventory and detailed polish backlog.

## Recommendation

Make the bundled Contacts module the first flagship, working through Contacts and Companies, Deals, then Activities and follow-up tasks. Use that work to improve the shared Module experience. Then finish independent Resource Contacts and Resource Campaigns as a coherent composition example, followed by connected actions and scheduled actions. Finish with a small, exceptionally clear Hello Workspace author tutorial and a reproducible reference bundle.

The target is a complete, useful journey in each example: enter real information, understand it, take the next action, see the result, and recover when something fails. Adding more fields or styling existing tables alone will not accomplish that.

## Scope and evidence

- Root checkout: `2d478aee`. Current remote `master`, fetched and inspected for this review: `7c2e409470a0cc98acb21fdf703361f73053865f`. The checkout was not switched and pre-existing changes were preserved.
- Inventory comes from `git ls-tree` at that current revision. Relevant Module manifests, example packages, shared renderers, action UI, and services were inspected in the existing `tmp/app-audit-2026-09-09/current` source snapshot at `46da535e1c7b85e2f2301faf780237c5241a254b`. A revision comparison confirms those files are unchanged in current master. Changed Apps settings code was read directly from current master.
- This covers all repository-defined extension Apps and Modules, their shared UI, authoring templates, and proof provider. It does not establish which packages are installed in a running deployment or inventory private sideloaded packages.
- Native Chat, Tasks, Notes, Knowledge, Calendar, Inbox, and people/team management are supporting workspace surfaces, not separate extension packages in this inventory. Their integration requirements are identified below; a full redesign of each native product is outside this plan.
- Findings are source-backed observations and product judgments. No fresh browser walkthrough, database integration run, performance measurement, or usability study was performed. Proposed acceptance tests are future work, not passing evidence.
- No implementation, migration, deployment, or package publication is included in this change. The deliverable is this ordered plan with explicit exit criteria.

The earlier [implementation audit](../audits/2026-09-09-apps-modules-implementation-audit.md) covers platform readiness and future execution tracks. This plan complements it by concentrating on the examples people actually use. Historical test results in that audit are not fresh results from this review.

## What exists

| Item | Current contents | Purpose and maturity | Treatment |
|---|---|---|---|
| Bundled **Contacts**, `com.deft.contacts`, Module 1.1.0 | Contacts, Companies, Deals, Activities; table, board, timeline, form and detail declarations | Broadest domain example; meaningful schema, generic interaction | First flagship. Finish all four collections as one relationship workflow. |
| **Hello Workspace**, App 1.0.0, Protocol v0 | Greetings: required message, optional occasion, one table | Deliberately minimal install/lifecycle example | Keep small; improve teaching, setup and first success. |
| **Resource Contacts**, App 1.0.0, Protocol v0 | Name, email, company text, lead/active/inactive status; table/form/detail | Independently owned resource provider | Polish for reuse by another App, without duplicating the full bundled CRM. |
| **Resource Campaigns**, App 2.0.0, Protocol v0 | Name, subject, status, multiple live contact references, planned datetime, audience notes; table/board/form/detail | Cross-App composition proof | Finish planning and audience selection before external effects. |
| **Connected Resource Campaigns**, App 3.0.0, Protocol v1 | Same lineage, Module 3.0.0 adds plain-text body; dependency/binding/grant review; one send action | Governed external-action proof | Add a clear single-recipient review/result/recovery journey. |
| **Scheduled Connected Resource Campaigns**, App 4.0.0, Protocol v2 | Same Campaigns Module 3.0.0 and action, plus a requested daily schedule | Bounded unattended-action proof | Add understandable schedule ownership, validity, state and recovery. |
| Sandbox email provider | Independent stdio MCP tool, deterministic idempotency, optional durable test outbox | Conformance support; **sends no email** | Make sandbox outcomes visible and setup reproducible. Keep production delivery a separate capability project. |
| App Kit templates | `declarative`, `connected`, `connected-automation` | Starter versions of these patterns | Update examples and templates together so new authors inherit improvements. |

There are **five example App directories but three distinct App IDs**: Hello Workspace, Resource Contacts, and Resource Campaigns. Campaigns v2/v3/v4 are upgrades of one App, not three independently installable products. There is one bundled Module, four distinct Module IDs across the inventory, and seven logical collection definitions when counting the bundled four plus Greetings, independent Contacts, and Campaigns. Repeated Campaign manifests are version fixtures.

Email Lite and Booking are future platform proof proposals, not implemented App packages in current master. Do not include them in a claim that existing examples have been polished.

## Why the current experience feels skeletal

| Source observation | Consequence | Required direction |
|---|---|---|
| `module-record-form.tsx` explicitly removes `relation` and `resource_ref` fields from create/edit forms. | Creating a deal or campaign is separated from choosing its company/contact/audience. | Support relationship selection in the primary journey, with explicit partial-failure behavior where writes are separate. |
| `module-record-explorer.tsx` limits tables to the first seven configured fields and renders non-title values as text. | A manifest cannot reliably determine what people see; rich types have little visual distinction. | Respect declared columns, add intentional overflow/column choices, and improve typed values. |
| Module board cards are record links, with no stage-move interaction in the renderer. | A Deals pipeline is a picture of stages rather than a fast working surface. | Add keyboard/touch-accessible stage changes; drag-and-drop is an enhancement to the same operation. |
| Timeline range and board counts are calculated from loaded records. | Loading another page can change the apparent picture; counts are not whole-collection totals. | Label partial data honestly; use bounded server queries/aggregates before claiming complete summaries. |
| `ModuleRecordRelations` renders outgoing declared relation fields and returns nothing when there are none. Companies declares none. | A company page does not naturally become a hub of its contacts, deals and activities through this component. | Add permission-aware reverse relationship sections with pagination. |
| Record detail is a field list plus separate task, relationship, App-action and change-history panels. | The substrate is visible, but the next useful action and business story are weak. | Establish a clear summary, primary actions and related-work hierarchy. |
| Contacts declares both legacy company text and a company relation; search/subtitle still use company text. | Linked and textual company information can diverge. | Decide canonical display/search behavior and provide a reviewed compatibility/backfill plan. |
| Activities are domain records, while record activity is audit history. | Logging a call and editing a field are different events, but the product must explain the distinction. | Provide a relationship activity feed while retaining a separate changes/receipts view. |
| Campaigns has `scheduled_for` and draft/ready/paused status; automation is a separate host-owned definition. | A planned date or a record marked paused can be mistaken for actual delivery scheduling/control. | Label planning metadata separately from effective schedule and delivery eligibility. |
| Connected actions already have safe previews, approval routing, run states and authorized results; result UI includes JSON. | Authority exists, but users must interpret technical output to know what happened. | Present authorized human-readable outcomes and actionable recovery without exposing sealed input. |
| Current Apps settings has search and an App detail route. | List/detail separation is already improved. | Build on it; do not repeat the completed settings restructuring. |

## Delivery order and boundaries

| Stage | Outcome | Relative scope | Depends on |
|---|---|---|---|
| 0 | Reproducible baseline and one reference story | Small | Current revision, disposable demo environment |
| 1 | Useful Contacts and Companies | Large | Stage 0; shared form/detail work delivered here |
| 2 | Working Deals pipeline | Medium–large | Stage 1 relationships and record interactions |
| 3 | Activities and accountable follow-up | Medium–large | Stages 1–2; native task links |
| 4 | Independent Contacts + Campaigns planning | Medium | Shared improvements from 1–3 |
| 5 | Understandable governed connected action | Medium–large | Stage 4; existing action/binding/grant services |
| 6 | Operable daily scheduled action | Medium–large | Stage 5; existing automation service |
| 7 | Excellent author examples and reference distribution | Small–medium | Earlier journeys stabilized; docs updated throughout |

Sizes express relative implementation breadth, not calendar commitments. Stage 0 browser findings and the relationship-write design determine estimates. Work sequentially by completed journey; do not open every collection for redesign simultaneously. Shared components improve as part of the first real consumer, not through a broad preliminary rewrite.

### Stage 0 — Establish the reference story

Use a fictional services team handling a new customer inquiry: create a company/contact, qualify a deal, record a conversation, assign follow-up, prepare a customer update, review a sandbox action, then schedule a bounded daily proof.

1. Create an explicit, non-destructive fixture loader for a disposable workspace. Target approximately 20 companies, 60 contacts, 15 deals spanning all stages, 40 activities, and a small independent Contacts/Campaigns dataset. Include missing values, long names, duplicate candidates, unassigned records and archived targets. These are proposed QA fixtures, not business metrics.
2. Walk every current collection, view, record page, install/review surface and action flow at desktop and mobile sizes. Capture friction and screenshots at the exact tested revision. Reproduce any suspected defect before fixing it.
3. Record baseline completion steps and failures for the journeys below. Separate defects from missing interactions and new capability requests.
4. Define package labels and documentation that distinguish bundled Contacts from independent Resource Contacts and explain Campaigns upgrades. Preserve IDs and historical package fixtures.
5. Select relevant current-candidate conformance tests; identify mandatory skipped tests before touching shared contracts. Reuse existing fixtures and scripts.

Exit: a runnable baseline, verified inventory, reproducible acceptance journeys, and a prioritized issue list tied to observed behavior. Do not reset an existing workspace to obtain demo data.

### Stage 1 — Contacts and Companies

**User journey:** Add a company and contact, assign an owner, attach the company during creation, find the contact again, and navigate the company's relationships without re-entering information.

Deliver:

- A concise contact summary: name, role, company, status, owner and working contact links; quieter empty optional fields. Company detail becomes an account overview with related contacts, deals, activities and work.
- Searchable relationship selection in create/edit. Contextual “add contact to this company” preselects the relationship. Offer related-record creation only after the basic selection path is reliable.
- Useful views such as All contacts, Leads, Unassigned, Active companies, Customers and Partners using supported filters. Personal “mine” and relative-date filters need contract verification; do not simulate them with static IDs/dates in a manifest.
- Remove silent column truncation, retain mobile cards, show useful status/member/date values, and make chosen view/filter context survive the return from detail. Verify existing navigation before changing it.
- A deliberate path for first data: manual entry first, then a reviewed CSV flow reusing existing import/bulk-create services. Add mapping, validation preview, duplicate candidate reporting, row-level outcomes and safe retry as separate work where the current contract lacks them. Do not imply an import wizard already exists.
- Resolve company text versus company relation. Preserve old values, show conflicts to users, and avoid matching companies by name alone. Search should reflect the canonical visible company under current permissions.

**Design boundary:** Start with host-rendered presentation over declarative records. Reverse relationship discovery, form relation writes and aggregate queries must be generic. Do not hardcode CRM IDs or field names into core services. A new optional presentation contract should be introduced only where existing metadata cannot express the required layout.

**Exit evidence:** A person completes the journey without an agent; relationships survive reload; company reverse lists page correctly; long/empty values work at 390px and 1440px; a concurrent edit produces a recoverable conflict; denied/archived targets disclose no unauthorized data. Import scope, if included, passes invalid-row and repeated-submit cases.

### Stage 2 — Deals

**User journey:** Create a deal for the existing company/contact, progress it through qualification and proposal, set its next work and close date, and mark it won or lost.

Deliver:

- Deal cards that prioritize company, value, owner, close date and next work instead of flattening fields into a subtitle. Define currency semantics before showing monetary symbols or totals: the current field is only a number.
- Stage changes from board and record detail, with an accessible menu and the same revision checks used by other writes. Preserve data and restore the prior display on failure.
- Useful saved views: open deals, unassigned deals and closed outcomes; add “closing soon” only through a supported dynamic-date query.
- Clear planned close dates, undated deals, and a readable mobile alternative to the wide timeline. Date zoom/navigation is optional after the basic close-planning journey works.
- Visible linked tasks for the next action. Use native tasks for assignee, due date and completion; avoid a competing follow-up task system in Module fields.
- Stage counts and pipeline values only when the backend can compute complete, authorized totals for the active query. Do not sum the loaded page and label it total pipeline.

Exit: deal stage/value/date changes persist across views and clients; failed moves recover; task links lead to real work; won/lost outcomes remain findable; numbers have explicit units and complete/partial scope. A large fixture must not show misleading counts.

### Stage 3 — Activities and follow-up

**User journey:** From a contact or deal, log a call, see it on the relevant relationship pages, assign follow-up to a person or agent, and see that work completed with its source context intact.

Deliver:

- A compact “Log activity” path with type, time, subject, notes and preselected relations. Date/time entry must make timezone behavior understandable.
- Chronological relationship activity sections on contact/company/deal pages, distinct from audit changes. The same linked activity appears consistently without duplicating its record.
- Create/link follow-up work using the existing task model, with return navigation to the source record. Confirm current APIs before promising one-click task creation.
- Decide whether “Last contacted” is manually maintained or derived. If derived, define qualifying activity kinds, linked entities, edits, archive behavior and timezone handling. The field's existence is not proof of automatic maintenance. Keep the rule in a governed domain capability or supported declarative mechanism.
- Suggested agent journeys: summarize a relationship with record citations; propose a follow-up task; draft an activity from supplied context. Include an ambiguous-contact case and require the normal governed write path.

Exit: an activity is discoverable from every explicitly linked entity; follow-up ownership/due date/completion are real; last-contacted behavior matches the chosen rule; agent output links to authorized source records; audit history still identifies actors and changes. An agent failure does not prevent manual work.

### Stage 4 — Independent Resource Contacts and Campaigns

**User journey:** Install the independent Contacts App, create contacts, install Campaigns, draft a campaign and select its audience from those existing live records.

Deliver:

- Keep Resource Contacts intentionally small. Improve empty states, email/status presentation, search and record navigation; explain that it supplies shared resources. Do not copy the bundled four-collection CRM into this package.
- Make the required contact source clear. Current references target the independent Module ID, so bundled Contacts is not an interchangeable dependency. A future common contact contract requires explicit design, compatibility and data migration work.
- A campaign detail organized around purpose, subject/content where available, audience and planning state. Support selecting related contacts in the main workflow rather than discovering a separate editor after saving.
- Audience choices show authorized names, company and email where permitted; allow removing a choice and navigating to the original. Explain unavailable resources without leaking their former contents.
- Distinguish planned date from execution: the v2 package does not send mail, and `scheduled_for` is not an installed schedule. Review whether the planning label should change while preserving the field key.
- Clarify missing-source/setup states. Campaigns v2 has a resource target but no explicit App dependency declaration; onboarding must not claim automatic dependency installation. Later connected versions do declare the dependency.
- Explain and exercise the v2 → v3 → v4 lineage with retained record IDs. Keep fixtures available as compatibility examples; present one Campaigns product in user documentation.

Exit: changing a source contact is reflected after authorized refresh without copied records; source disable/archive/revocation behaves safely; missing setup has a clear next step; upgrades retain campaigns and relations; the user can explain planning versus actual delivery.

### Stage 5 — Connected Campaigns

**User journey:** Open a campaign, choose one related contact, review the permitted action, approve if required, execute once, and understand the result.

Deliver:

- A readiness summary using authoritative host state: dependency available, connector selected, grants effective, required input usable, action eligible. Each blocker leads to a relevant repair surface for the user's role.
- Label the available action and result as sandbox behavior. A multi-contact audience still permits only **one selected recipient per action**; make this explicit before review.
- Present authorized review metadata in human language, preserving sealed provider input. If a fuller subject/body/recipient preview is needed, design a permission-aware projection; do not reveal execution payload merely to improve the UI.
- Keep record planning status distinct from actual action state. Show pending approval, running, sandbox accepted, failed, expired/cancelled and unknown outcome with appropriate next steps. Provider acceptance is not delivered mail.
- A human-readable receipt summary with actor, time, affected authorized resources and run link. Retained raw result JSON belongs in expandable technical detail.
- A deliberate recovery policy: do not offer blind retry for an unknown external outcome. Explain when the operator must reconcile or create a newly reviewed action.
- Operator setup documentation and a deterministic sandbox proof that can be reproduced outside the monorepo. Improve the existing binding/grant review, preserving requested versus effective authority.

Exit: a user understands one complete run without reading JSON; duplicate submission has one logical effect; revocation between review and execution prevents unauthorized work; stale input is handled under the current contract; denial and unknown outcome are accurately explained. Existing Web, Defty, MCP and API action paths retain common service enforcement.

### Stage 6 — Scheduled Campaigns

**User journey:** From a working connected action, approve one daily schedule, inspect what it will do and when, pause it, resume when eligible, and investigate a missed or failed run.

Deliver:

- Show campaign/contact labels through live authorization, timezone, next execution, approved validity dates, effective budgets, last outcome and a direct run/receipt link.
- Use a timezone selector and a next-occurrence preview based on the host's scheduling rules. Explicitly explain daily repetition, catch-up behavior and expiry. Do not let the campaign planned date imply a one-shot schedule.
- Use one clear execution status vocabulary: active, paused, expired, blocked or runner disabled. Current UI already includes eligibility, latest fire/run, dead letters, pagination and pause/resume; refine these rather than rebuilding them.
- Replace ambiguous operator copy such as “Kill switch off” with the actual effect, using verified server semantics. Present organization-wide budgets as organization-wide, not per-campaign allowances.
- Add clear links from the record to schedule management and back. Summarize stale pins, revoked grants, missing resources and expired approval in actionable terms without silently changing approved authority.
- Specify permanent definition revocation and renewal/replacement only through existing supported transitions or an explicit API design. Changing a resource selection, schedule or expiry must not mutate previously approved scope invisibly.
- Preserve the bounded daily model. Bulk sends, arbitrary cron, workflows and campaign fan-out are new product/kernel scope.

Exit: controlled-time daily and timezone/DST cases match displayed scheduling; pause/revocation/expiry prevent effects as intended; the runner-disabled state is clear; duplicate delivery remains idempotent; a killed/restarted worker and restore scenario produce explainable outcomes on the current candidate. In-process duplicate-handler coverage alone is insufficient for the restart claim.

### Stage 7 — Hello Workspace and the author reference bundle

**User journey:** An outside author obtains the kit, builds a tiny App in a clean directory, inspects and activates it, creates a greeting and finds it in Deft.

Deliver:

- Keep the two-field Greetings collection and minimal authority. Improve the first-record prompt, a few optional fictional sample values, the guide and screenshots. Do not turn it into another full product.
- Provide a short route through the examples: declarative records → independent resource reuse → one governed connected action → one bounded daily schedule.
- Reconcile stale phase language in briefs with actual package contents. Explain what the host supplies and what each manifest adds.
- Bring CLI templates, sample manifests, lockfiles/digests and expected screenshots into agreement. Build reference artifacts deterministically; retain immutable historical fixtures where tests depend on them.
- Provide a version-matched kit/reference artifact and checksum through an agreed public channel, with operator instructions. Package publication is a separate release action, not something performed by this planning task.
- Document example-data setup, lifecycle behavior, disabled-state recovery and compatibility. Do not imply that reactivation, downgrade or deletion are supported until exercised by the actual contract.

Exit: an author unfamiliar with the repository completes the documented path from a clean external directory; no core edits or workspace links are needed; the connected guide stops at the correct host review step; generated packages match their declared versions and digests.

## Shared work versus new platform scope

| Work | Where it belongs | Decision before implementation |
|---|---|---|
| Labels, fictional fixtures, view field selection, explanatory briefs | Example manifests, docs and tests | Preserve IDs; regenerate artifacts when manifests change. |
| Relation selection, typed cells, reverse lists, record hierarchy, stage interaction, mobile behavior | Generic host renderer plus existing record/relation APIs | Check contract support and concurrency; add only consumed optional metadata. |
| Relation-aware create, complete aggregates, dynamic saved queries, import/merge, archive restoration | Potential shared service/API work | Inspect existing behavior first; define authorization, atomicity, failure recovery and upgrade impact. |
| Domain-derived last contact, duplicate matching, currency rules | Declarative domain contract or governed capability | Explicit rules and migration design; no bespoke CRM branches in core. |
| More informative action previews and permanent automation revocation | Existing action/automation services with additive contracts if necessary | Treat data exposure and approval scope as trust boundaries. |
| Real email delivery, bulk audience execution, private mail, custom executable UI, sync and public Booking | Separate platform/product tracks | New capability contracts and operational evidence; not cosmetic polish. |

Prefer host-rendered improvements for existing packages. Do not make flagship Contacts wait for arbitrary executable App UI. If a desired interaction cannot be expressed safely by the current Module contract, compare the smallest generic extension against a specialized future App surface before implementation.

For relationship-aware creation, explicitly choose between a transactional service operation and a visible create-then-link sequence with repairable partial success. For company canonicalization, do not delete legacy text until backfill/conflicts and rollback are reviewed. For the two Contacts implementations, retain separate ownership/IDs until a deliberate compatibility or migration project exists. These decisions should pass the repository's architecture review method when their stages begin.

## Native workspace integration requirements

| Surface | Required contribution to the examples |
|---|---|
| Tasks | One source of truth for follow-up ownership, due dates and completion; bidirectional navigation to Module records. |
| Search and agent context | Authorized titles, useful subtitles and source links; test changed/deleted/denied references. Do not promise body search where the manifest excludes it. |
| Chat/Defty/MCP | Propose useful work from supplied context; clarify ambiguous identities; use shared governed mutations and receipts. |
| Inbox/approvals | Approval cards identify the intended action and offer a return to the originating record/run. |
| Calendar | Keep planning dates, native events and automation schedules distinct; validate timezone presentation. New native-event adapters are separate scope. |
| Notes/Knowledge | Useful links and cited context where current resource contracts permit them. Do not invent universal adapters as a polish shortcut. |
| People/teams/settings | Readable ownership, appropriate role-based controls and targeted setup/repair links. Preserve current settings improvements. |

## Completion standard for every stage

1. **Useful outcome:** the named journey succeeds with realistic data and has a clear next step. Critical manual operations do not depend on an AI provider.
2. **Visual behavior:** inspect 1440px desktop and 390px mobile, plus a narrow 320px stress case where relevant; light/dark themes, long text, empty/loading/error states, keyboard focus and touch targets. A successful build is not visual evidence.
3. **Data integrity:** concurrent edits, repeated submissions, relationship changes, archive/disable and denied access preserve appropriate state. Inspect final diffs and untracked files.
4. **Agent parity:** at least one supported read/proposal/write journey uses the shared services, respects approval policy and produces a traceable result. Test ambiguity and permission denial, not only a happy path.
5. **Scale honesty:** exercise multiple pages; no page-derived counts masquerade as totals. Set measured latency targets after baseline rather than inventing claims. Use a larger disposable fixture when validating aggregate/search work.
6. **Lifecycle:** affected existing records and package upgrades survive the change; schema changes include a reviewed migration/rollback note. Never claim downgrade compatibility from an upgrade test.
7. **Evidence:** focused checks during development, one consolidated relevant validation pass, current screenshots and a concise remaining-limitations record. Contract/security tests must actually execute; skipped mandatory cases are not passes.

Use existing package scripts and focused tests. Relevant starting points include Module contacts acceptance, relation/view upgrades, action/run authorization and terminalization, connected grants, automation lifecycle, App Kit protocol/CLI and external-package tests. Select the exact set for each change; do not claim the entire platform certified by one polished demo.

## First implementation batch

Start with Stage 0 and one bounded Stage 1 journey: **create a company → create and link a contact → open the company and see that contact → find both again**.

The first batch should establish relationship-aware creation, reverse relationship display, useful record hierarchy and representative desktop/mobile evidence. Defer import/merge, monetary aggregates, derived last-contact rules and sending until their stages. This makes the first result concrete while giving later examples reusable improvements.

## Source index

Paths below refer to the inspected revision, not the older root checkout. Use the pinned [source tree](https://github.com/Maneek21/Deft/tree/7c2e409470a0cc98acb21fdf703361f73053865f) to resolve them.

- Inventory and domain schemas: `modules/bundled/contacts/deft.module.json`; all five `examples/*-app/deft.app.json`, their Module manifests and `APP_BRIEF.md`; `apps/api/src/lib/bundled-modules.ts`.
- Shared navigation/views/forms: `apps/web/src/components/modules/module-workspace.tsx`, `module-record-explorer.tsx`, `module-record-form.tsx`, `module-saved-views.tsx`.
- Relations/detail: `apps/web/src/components/modules/module-record-relations.tsx`, `module-resource-relations.tsx`, `module-record-task-links.tsx`, `module-record-activity.tsx`; `apps/web/src/app/(app)/modules/[slug]/[collectionKey]/[recordId]/page.tsx`.
- Actions/schedules: `apps/web/src/components/modules/module-record-app-actions.tsx`; `apps/web/src/components/apps/app-automation-management.tsx`, `app-run-inspector.tsx`; current `apps/web/src/app/(app)/settings/apps/apps-client.tsx`.
- Existing reusable import mechanisms: `apps/api/src/lib/module-csv-import.ts`, `module-record-bulk-create.ts`. These are not evidence of a user-facing Module import wizard.
- Authoring and proof boundary: `packages/app-kit/README.md`, `packages/app-kit/src/cli.ts`, `examples/app-platform-connected-proof-bundle.json`, `examples/app-platform-sandbox-email-provider/README.md`.

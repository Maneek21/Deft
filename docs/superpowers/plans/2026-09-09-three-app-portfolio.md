# Three distinct showcase Apps

Date: 2026-09-09. Status: revised product plan; no implementation or data migration performed.

Superseded: the user narrowed the immediate scope to one flagship Contacts CRM with selected Campaigns features. Follow the [flagship CRM plan](2026-09-09-flagship-contacts-crm.md). Team Onboarding and a separate Campaigns product are deferred; this portfolio is retained as planning history.

The user requested three unique Apps after reviewing overlap in the existing examples. This plan supersedes the lineup and sequencing in the [product maturity analysis](2026-09-09-apps-modules-product-maturity.md). The choice of Team Onboarding as the third product is a proposed product direction, not an existing implemented App.

## Portfolio

| App | User's job | Owns | Demonstrates |
|---|---|---|---|
| **Contacts CRM** | Manage customer relationships and opportunities | Contacts, companies, deals, relationship activities | Rich declarative collections, relations, views, search and task links |
| **Campaigns** | Plan outreach and govern its execution | Campaign content, audience references and planning state | Cross-App resource reuse, reviewed actions, approvals, runs, receipts and bounded scheduling |
| **Team Onboarding** | Bring a new teammate from arrival to readiness | Onboarding cases and their context | Workspace member references, native task participation and human/agent collaboration |

Three top-level App entries, each with a distinct purpose. Collections remain inside their owning App. A customer contact belongs to CRM; an audience references it. A workspace teammate belongs to the native member system; an onboarding case references that member. Tasks, approvals, schedules and receipts remain owned by their existing host services.

## 1. Contacts CRM

Evolve the existing bundled Contacts module into the canonical relationship product. Retain its Contacts, Companies, Deals and Activities collections.

The first useful journey is: create a company, add and link a contact, create an opportunity, log a conversation and assign follow-up. A company page should show its relationships and open work. Deals should support meaningful stage changes. Contact creation and editing should include company selection.

Polish priorities:

1. Relationship-aware forms and reverse relationship lists.
2. Useful contact/company detail hierarchy, typed values and reliable search.
3. Interactive Deals pipeline, explicit value/currency semantics and complete-query totals where supported.
4. Quick activity logging and native follow-up tasks.
5. Reviewed import and duplicate handling after the manual workflow is solid.

CRM does not own campaigns, email execution, workspace identities or onboarding cases. Relationship activities record business interactions; native task completion remains authoritative for follow-up work.

App packaging is part of consolidation: the current bundle is a Module, not already this canonical App package. Inspect how App ownership can adopt or reference the installed bundle before selecting an App ID or installer behavior. Do not create a second populated copy of the Contacts module just to obtain an App entry.

Acceptance: one coherent relationship journey works on desktop/mobile; users find related records without duplicating data; task links retain context; edits and denied relationships behave safely.

## 2. Campaigns

Present the existing Campaigns lineage as one App. Planning, connected actions and schedules are capabilities within that product, with availability determined by host support and reviewed configuration.

The journey is: draft content, choose live contacts from CRM, review one recipient/action, execute through the governed path, inspect the outcome and optionally approve a bounded daily schedule.

Polish priorities:

1. Campaign detail organized around content, audience and readiness.
2. Audience selection from canonical CRM contacts with direct source navigation.
3. Clear separation of planned date/status from effective execution state and approved schedules.
4. Actionable setup blockers, authorized previews and human-readable receipts.
5. Schedule timezone, validity, pause/resume, expiry and recovery.

Campaigns has no editable copy of CRM contacts and no independent contact directory. Its audience is a set of references. Use host-owned action/run/schedule state rather than inventing competing delivery records.

Current limits remain explicit: one selected recipient per action; the bundled provider is a sandbox that sends no email; a daily automation is not bulk audience delivery. Production email, fan-out and campaign analytics require separate consumed contracts and evidence. Do not add decorative delivery/open-rate charts without real supporting data.

Acceptance: CRM edits resolve through authorized references; upgrading Campaigns retains records; review/revocation and duplicate-run handling remain correct; sandbox acceptance is never presented as delivered email.

## 3. Team Onboarding

Replace Hello Workspace's role in the showcase with a practical internal coordination App. Keep Hello Workspace available as a minimal author tutorial and test fixture.

The first version helps a team onboard an existing workspace member. It is an organization-visible coordination product; confidential HR records are outside this initial model.

Proposed collection: **Onboarding cases**, containing a title, member reference, coordinator, buddy, start date, target-ready date, status and welcome/context notes. Proposed states: Preparing, In progress, Blocked, Complete. Existing native tasks represent the actual work; do not introduce another checklist-item collection that duplicates task status, assignee and due date.

The journey is: open a case for an existing teammate, assign a coordinator and buddy, attach real setup tasks, share useful context, resolve blockers and explicitly mark the case complete after reviewing work.

Polish priorities:

1. A readable case overview showing who is joining, when, who is helping and what needs attention.
2. Start-date table/timeline and a status board using shared Module views.
3. Native task links with completion state and return navigation to the case. Begin with supported linking; add contextual task creation through existing task services where needed.
4. A guided example checklist that users turn into real tasks. Reusable automatic task generation requires explicit idempotency and template support; it is not assumed to exist.
5. Agent assistance that summarizes linked work or proposes next tasks under ordinary permissions and approvals.

References to welcome material can begin as explicit links/notes. Do not promise a universal knowledge adapter or automatic access provisioning. Creating an onboarding case does not invite a member, grant access, create accounts elsewhere or trigger unattended workflows.

Acceptance: a coordinator follows one case from setup to completion with real tasks; changing a task updates the authorized displayed state; a departed/inaccessible member has a recoverable state; an agent cannot mark incomplete work done merely by changing the case label. Case status is initially an explicit coordination decision, not an unsupported computed workflow.

## Consolidation map

| Existing artifact | Destination |
|---|---|
| Bundled Contacts module | Canonical data foundation for Contacts CRM; preserve existing records and Module identity. |
| Resource Contacts example | Legacy compatibility fixture; migrate any real installations through a reviewed mapping into CRM. Remove it from the primary showcase after supported migration. |
| Resource Campaigns v2 | Historical upgrade fixture for the single Campaigns App. |
| Connected Resource Campaigns v3 | Historical upgrade fixture; connected action remains a Campaigns capability. |
| Scheduled Campaigns v4 | Current lineage starting point for the unified Campaigns product. |
| Hello Workspace | Minimal developer tutorial/test fixture, outside the three-product showcase. |
| Sandbox provider | Supporting test/demo tool, not an App in the catalog. |
| Team Onboarding | New distinct App with its own identity; do not repurpose Hello's identity or greeting records. |

This is a product consolidation, not a safe find-and-replace rename. Current Campaigns dependencies and resource targets point to the independent Resource Contacts App/Module, not `com.deft.contacts`.

## Migration and authority decisions

Before implementation, inspect live installation ownership and compare adopting the existing bundled Module into a CRM App against another supported ownership arrangement. Choose the smallest option that preserves IDs, records, authorization and one visible product. This requires architecture review because it touches App/Module ownership and public references.

For existing Resource Contacts data, build an explicit old-to-new record mapping. Do not auto-merge by name or email alone. Define duplicate resolution and preserve provenance. A disposable demo may install cleanly, but that does not prove a supported production migration.

Campaign migration must update the package dependency, target Module contract and stored references through supported versioned mechanisms. Inventory pinned resource versions, grants, pending runs and approved schedules. Changed dependencies or resource pins require the proper renewed review; do not rewrite existing approvals to point to new contacts. Validate old → new mappings before cutover, stop new execution during the affected cutover if necessary, and document rollback limitations after new writes.

Historical manifests/digests remain immutable where conformance tests depend on them. New packages receive compatible versions and regenerated lockfiles/digests. Merely hiding Resource Contacts from navigation does not consolidate data ownership.

## Build order

1. **Consolidation design and baseline:** confirm installed data/ownership, choose CRM packaging and dependency migration, define fixture and upgrade tests. Use a disposable workspace for demonstrations.
2. **Contacts CRM:** finish Contacts/Companies first, then Deals, then Activities and follow-up. Extract shared form/view/relationship improvements as part of this work.
3. **Campaigns:** complete canonical CRM integration and migration, then planning, governed action and schedule usability within one App.
4. **Team Onboarding:** build the member/case/task journey using the now-polished shared renderer and task linking.
5. **Portfolio verification:** exactly three showcase entries on a fresh install; test supported upgrades, desktop/mobile journeys, roles, agent participation, package authoring and failure recovery.

Keep one product under active deep polish at a time. The deliverable for each is a complete manual journey plus an agent-assisted example, supported by current browser and focused integration evidence. Existing detailed renderer, security and lifecycle acceptance criteria remain in the original maturity analysis.

## First implementation outcome

One visible Contacts CRM App over one canonical relationship dataset, with the journey **company → linked contact → company overview → find again** working. Establish safe ownership and migration before collapsing the old Contacts packages. Finish that foundation before implementing Campaigns' new dependency or starting Onboarding.

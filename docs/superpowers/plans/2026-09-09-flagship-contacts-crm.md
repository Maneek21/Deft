# Contacts CRM: flagship product plan

Date: 2026-09-09. Status: active implementation program.

First batch implemented on `codex/crm-flagship-foundation` in `C:/tmp/deft-crm-flagship`: atomic relationship selection in create/edit forms, paginated incoming relationships, contextual creation from a company, compact populated details, and concurrent-edit protection. Fresh checks: 38 focused tests, web lint, web/API typecheck, production build, and desktop/mobile browser evidence. Full Docker/auth/socket validation remains unverified because the local engine could not start; browser checks used fixture identity with real Module routes and isolated PostgreSQL. See that checkout's `docs/superpowers/audits/2026-09-09-crm-foundation-verification.md`. Remaining stages below are not yet implemented.

The user narrowed the work to making Contacts CRM a flagship example and incorporating useful Campaigns features. This supersedes the [three-App portfolio](2026-09-09-three-app-portfolio.md). The [original analysis](2026-09-09-apps-modules-product-maturity.md) supplies the source-backed inventory and detailed shared UI findings. Team Onboarding and a standalone Campaigns product are deferred.

## Product outcome

A person should be able to run their relationship work here: know who a customer is, understand the opportunity, see the last interaction, decide what needs doing, prepare relevant outreach and follow through. An agent should help on the same records, with normal permissions, approvals and traceable results.

The flagship journey is:

**Add a company/contact → qualify a deal → log a conversation → assign follow-up → draft outreach → review a governed action → inspect its outcome → continue the relationship.**

Prioritize the useful manual workflow first. Agent assistance and connected actions should extend a working CRM. A user without an AI provider or mail connector can still manage relationships, opportunities, activities, tasks and outreach drafts.

## One product, coherent sections

| Section | Purpose | Data ownership |
|---|---|---|
| Overview | Show the next useful work: due follow-ups, deals needing attention and outreach awaiting review | Authorized queries over the actual records and native tasks; no parallel records |
| Contacts | People outside the workspace whom the team works with | Existing Contacts collection |
| Companies | Relationship hubs showing contacts, deals, activity and open work | Existing Companies collection |
| Deals | Opportunity stage, value, expected close and next action | Existing Deals collection |
| Activities | Calls, meetings, notes and explicitly recorded interactions | Existing Activities collection |
| Outreach | Prepare messages for selected contacts, review action readiness and inspect results | Campaign-derived planning records; references to canonical CRM contacts |

Task execution stays in native Tasks. Approvals, runs, receipts and approved schedules stay in existing host services. Their relevant state should be visible from CRM records. Outreach does not introduce a second contact directory or copy contact details into independently editable audience records.

“Overview” is a proposed product surface, not an existing manifest view type. Start with supported saved views and linked tasks; add a host-rendered summary surface only through the smallest reusable contract actually needed. Counts must cover the authorized query, not just the loaded page.

## Campaigns features to bring in

| Feature | Flagship treatment |
|---|---|
| Named campaign/outreach draft | Include: name, subject, plain-text body, planning state and audience notes. Present as Outreach within CRM. |
| Multiple live contact references | Include: select canonical CRM contacts, open their records and reflect authorized changes. |
| Planned date | Include as planning metadata, clearly distinct from an executable schedule. |
| Connected action and selected recipient | Include after the core workflow: one selected recipient per reviewed action using the common executor. |
| Approval, execution status and receipt | Include as the visible continuation of the outreach workflow. Use human-readable outcomes and source links. |
| Daily scheduled action | Later, optional demonstration after manual action usability and recovery pass. Keep explicit pins, expiry and budgets; do not make repeated daily contact the default sales workflow. |
| Bulk sends, drip sequences, delivery/open tracking | Defer. These require real capability and event contracts; the present examples do not implement them. |
| Sandbox email provider | Retain for deterministic demonstrations and testing. Label its acceptance as sandbox behavior; it sends no actual mail. |

Production email delivery is a separate explicit milestone if required for real outreach. Do not claim this reference App sends customer email until a supported provider contract, authorization and recovery path has been implemented and verified.

## Depth before breadth

### 1. A useful relationship workspace

Create contacts with company selection in the same journey. Show a compact summary of identity, owner, status, contact details and relationship context. Make company detail a hub with related contacts, deals, activities and tasks.

Add searchable relations and reverse lists through shared services. Preserve revision checks and make a create-then-link partial failure repairable if the current API cannot commit the operation atomically. Add contextual creation from a company or contact with preselected relationships.

Resolve the legacy company text versus company relation deliberately. Preserve old information and review conflicts before migration. Search and displayed company identity should agree.

Exit: create company → create linked contact → open the company and see the contact → find both again, without duplicate entry or an agent. Verify desktop/mobile, long/empty values, concurrent edits and denied targets.

### 2. Deals that drive action

Make the pipeline actionable with stage controls usable by keyboard and touch. Prioritize company, value, owner, close date and linked next work on each deal. Define currency/unit semantics before showing monetary totals.

Use real native tasks for follow-ups and show their status on the deal. Start with explicit views for open/unassigned/closed deals. Dynamic “closing soon” or “needs attention” views need supported query semantics and agreed rules.

Exit: create and progress a deal, assign follow-up, complete the task and see that completion in context. Failed moves recover. Large paginated fixtures do not produce misleading totals.

### 3. Activities and a coherent customer history

Log a call, meeting or note from the relevant record with relations already selected. Show domain interactions chronologically, separately from audit changes. Display linked outreach outcomes and follow-up work without inventing duplicate activity records or falsely treating a sandbox action as a real customer interaction.

Define manual versus derived last-contacted behavior. A derived rule needs explicit qualifying events and behavior for edits, archive and multiple linked entities. Internal edits, drafts and sandbox acceptance must not silently count as contacting a customer.

Exit: a teammate can reconstruct what happened and what happens next from the contact/company/deal. Activities appear under explicitly linked entities, task state is current and audit attribution remains intact.

### 4. Outreach embedded in relationship work

Start an outreach draft from a contact, company context or selected contacts. Reuse the Campaigns content and reference model but point at the canonical CRM dataset. Show the selected audience and allow navigation back to source records. Prefer plain-text editing and a clear draft/review progression before adding templates or rich formatting.

Show readiness and repair actions using host-authoritative state: usable input, eligible selected contact, dependency availability, effective grants and connector configuration. Keep planning state separate from run state. Multiple selected contacts are an audience for planning; the current action still chooses one recipient.

Exit: draft outreach in context, select a contact, review the authorized metadata and return to the original relationship record without losing work. Missing configuration has a clear next step; stale or inaccessible references do not leak data.

### 5. Governed execution and useful agent assistance

Use the existing AppAction/AppRun path for execution and approvals. Show pending approval, running, sandbox accepted, failed, cancelled/expired and unknown outcome distinctly. Put actor, time, authorized source resources and receipt/run navigation ahead of raw JSON. Do not reveal sealed provider inputs to improve the preview.

Agent examples should solve actual work:

- Summarize a company's relationships and open opportunities with source links.
- Identify follow-up work using supported, explicitly scoped queries.
- Draft outreach from supplied notes and authorized CRM context.
- Propose a next task after a recorded meeting.
- Prepare a governed outreach action for human review.

Do not auto-enrich contacts from the web, silently change deal stages or send messages on the user's behalf as implicit side effects of assistance. Agent mutations use the same validation, permissions and approval policy as existing tools.

Exit: an agent-assisted journey and its manual equivalent reach the same persisted record model; ambiguity triggers clarification; duplicate execution has one logical effect; revocation between review and execution is enforced; unknown outcome offers reconciliation rather than blind retry.

### 6. Daily usability and optional scheduling

Finish import mapping/validation and duplicate review using existing import services where possible, useful saved views, navigation continuity and clear archive/recovery behavior. Add the Overview only with supported complete-query data and a small reusable presentation design.

Scheduled outreach is optional and follows the proven manual action: show exactly what is approved, recipient, timezone, next occurrence, validity, budgets and pause/recovery controls. Existing planned dates do not create schedules. Daily recurrence is not a sales sequence engine.

Exit: a fictional team can run a full working session in the CRM without direct database editing. For scheduling, current-image restart/revocation/expiry evidence must supplement the ordinary in-process tests.

## Architecture and migration boundary

One coherent CRM experience does not require an immediate physical merge of every Module or a rewrite of the generic renderer. Compare these options before changing ownership or manifests:

| Option | Benefit | Cost/risk |
|---|---|---|
| One CRM App containing relationship and outreach Modules | Can preserve collection ownership boundaries and reuse the existing resource-reference/action pattern | Must verify bundled-Module adoption, multi-Module packaging and reference contracts; user navigation must remain coherent |
| One expanded Contacts Module including Outreach | A compact domain schema and local relation model | Existing action bindings consume the resource-reference proof; compatibility and migration may be more substantial |

Provisional preference: preserve existing data identities and reuse the action contracts, exposing one CRM product. The architecture decision is pending inspection of App ownership/adoption and caller contracts; neither option is claimed to work unchanged today.

Current Campaigns targets the independent Resource Contacts Module, not bundled Contacts. Inventory installed Apps/data, map old contact IDs to canonical records, handle duplicates explicitly and review grants/pins. Never silently retarget an approved run or schedule. Preserve historical package manifests/digests for conformance; new packages get versioned changes and supported upgrade evidence.

Do not automatically remove legacy installations. Define migration, cutover, authorization renewal, rollback and data preservation before consolidation. Keep domain rules in declarative modules or governed capabilities and shared primitives generic.

## Acceptance and delivery discipline

Deliver the numbered journeys in order, completing each before broadening scope. The first implementation batch remains the Contacts/Companies journey, with the CRM packaging decision resolved before installation ownership changes.

For each batch: reproduce suspected defects, use focused tests during implementation, run one consolidated relevant validation pass, inspect the final diff and verify rendered behavior at representative desktop/mobile sizes. Cover empty/loading/error/denied states and long values. Record the exact tested revision and any unverified requirements.

The final flagship demonstration must show one canonical contact reused across company context, a deal, an activity, native follow-up work and outreach. A human and an agent can participate on that same record; any connected effect has a visible governed outcome. No duplicate address books, invented execution statistics or hidden manual database steps are acceptable substitutes.

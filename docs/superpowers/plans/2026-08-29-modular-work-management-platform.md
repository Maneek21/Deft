# Modular Work Management Platform Plan

**Status:** Superseded as a standalone implementation plan on 2026-08-29

The full-surface App Platform plan now governs implementation. This document remains design input for the Resource Service, generic relations, declarative views, reference Modules, and solution composition. Where it conflicts on the installed product unit, lifecycle, grants, executable behavior, or phase order, `2026-08-29-full-surface-app-platform.md` wins.

**Goal:** Evolve Deft from an opinionated task manager with declarative record modules into a general work-management platform for marketing, sales, operations, HR, service, finance, events, and engineering without turning core Tasks into a universal domain-record table.

## Outcome

Deft should have three cooperating layers:

1. **Core work primitives** provide identity, permissions, chat, tasks, knowledge, calendar, files, approvals, receipts, search, agents, notifications, and automation execution.
2. **Domain modules** own canonical business records such as campaigns, accounts, opportunities, assets, candidates, vendors, and service cases.
3. **Solution packs** compose modules, task templates, views, dashboards, automations, approval policies, and agent skills into cohesive experiences such as Marketing Operations or Sales Operations.

Tasks remain the universal execution object. Domain records are not copied into Tasks and are not duplicated between modules. They link to Tasks and to other canonical records through permission-aware resource references.

## Product principles

- Keep Deft core generic. Domain-specific fields and behavior belong in modules or reusable capabilities.
- Prefer one canonical record with links and projections over bidirectional data copies.
- Preserve tenant isolation and revalidate access at both ends of every relationship.
- Keep modules declarative by default. Do not execute arbitrary code from uploaded manifests.
- Provide strong domain defaults while allowing safe customization.
- Agent writes cross the same validation, permission, approval, idempotency, audit, and receipt boundaries as human and API writes.
- Make module upgrades additive and reversible; never reinterpret stored values without an explicit migration.

## Current implementation assessment

### Capabilities already present

The current module platform is a credible foundation:

- Strict, versioned, digest-pinned module manifests with install and upgrade lifecycle.
- Up to eight collections per module and 64 fields per collection.
- Text, long text, email, URL, date, datetime, number, boolean, select, multi-select, member, tags, and relation fields.
- Relations between collections in the same module installation.
- Generic Table, Board, Timeline, Form, and Detail views.
- Personal saved Table, Board, and Timeline views.
- CRUD, bulk creation, CSV import, archive, validation, revision tracking, idempotency, audit, and mutation receipts.
- Universal search, context retrieval, Defty tools, employee-agent tools, and MCP access.
- Configurable agent access and approval-aware module mutations.
- Record activity and permission-aware links between module records and native Tasks.

### Blocking limitations

The current platform cannot yet deliver the target architecture:

- Relations are restricted to collections inside one module installation. Cross-module record edges are rejected by both the manifest contract and database constraints.
- Module-to-Task links exist, but there is no general typed resource-relation service for module-to-module or module-to-core relationships.
- There are no currency, percentage, duration, file, asset, location, formula, rollup, lookup, or computed fields.
- There are no Calendar, Gantt, Gallery, Chart, Funnel, Dashboard, Workload, Map, Pivot, or proofing views.
- Manifests cannot declare automations, scheduled triggers, webhooks, integrations, approval chains, custom commands, or agent workflows.
- Manifests cannot declare reusable dashboard metrics or analytical semantic definitions.
- There is no safe extension seam for specialized UI such as creative proofs, UTM reports, forecasts, or service-level timers.
- Saved views are personal in version one; team and solution-owned views are missing.
- Domain modules cannot declare dependencies on other modules or compatible capability versions.
- Fine-grained record and field access policies required for HR, finance, and customer data are not available as a module contract.

## Architecture decision

### Rejected: one universal business module

A single module containing campaigns, contacts, deals, assets, candidates, vendors, and cases would work around the current same-installation relation restriction. It would also create a tightly coupled schema, force customers to install unrelated domains, make upgrades risky, and concentrate permissions that should remain separable.

### Rejected: independent modules connected only through Tasks

This preserves installation independence, but a campaign still needs direct relationships to accounts, contacts, assets, budgets, events, and performance records. Tasks alone cannot represent that domain graph without duplicating data or abusing task metadata.

### Recommended: resource graph plus reusable capabilities

Extend the module platform with canonical, typed, permission-aware cross-resource relations. Each domain module owns its records; shared platform capabilities provide views, analytics, automations, files, approvals, and integrations. Solution packs compose those pieces into user-facing applications.

## Target resource model

Every linkable resource exposes a stable resource identifier and type. The relation service stores:

- organization
- source resource type and identifier
- relation key and optional inverse key
- target resource type and identifier
- owning module installation and manifest version where applicable
- ordering and optional typed metadata
- actor attribution, timestamps, archive state, and revision

The service must resolve each endpoint through its owning resource adapter and revalidate organization, visibility, installation state, and actor access on every read and mutation. It must not trust labels or cached denormalized titles for authorization.

Initial adapters should cover module records, Tasks, projects, messages, wiki pages, notes, calendar events, files, approvals, people, and teams.

## Module Platform version two

### Manifest additions

- `dependencies`: required or optional modules and compatible version ranges.
- `capabilities`: files, formulas, analytics, automations, approvals, integrations, and specialized trusted views.
- External relation fields with target resource types, allowed collections, cardinality, deletion behavior, and inverse labels.
- Module-owned shared views, dashboards, forms, task templates, and automation recipes.
- Collection-level access-policy declarations constrained to safe platform-provided predicates.
- Semantic field metadata such as currency code, percentage, duration unit, metric aggregation, privacy classification, and external identifier.

### New field types

- currency and percentage
- duration and time interval
- file and asset reference
- location and address
- formula and computed status
- lookup and rollup
- external identifier
- rich content reference
- approval state

Formula and rollup evaluation must use a bounded, deterministic expression language. No JavaScript or remote code is allowed in manifests.

### Shared views

Add platform-rendered Calendar, Gantt, Gallery, Chart, Funnel, Dashboard, Workload, Map, and Pivot views. Views consume manifest metadata and a common query/aggregation contract. Domain modules should not implement duplicate calendar or chart engines.

Specialized experiences such as asset proofing should be trusted bundled capabilities with narrow, versioned interfaces. Sideloaded manifests may request an installed capability but may not provide executable UI code.

## Automation and synchronization

Build a governed event and automation layer rather than ad hoc module-to-module copying.

### Event envelope

- organization and actor
- resource type and identifier
- event name and schema version
- changed field names, not unrestricted sensitive values
- causation, correlation, and idempotency identifiers
- timestamp and permission context reference

### Automation model

- triggers: record created or changed, status entered, relation added, date reached, schedule, form submitted, task completed, approval resolved, or external event received
- conditions: bounded comparisons over permitted fields, relationships, actor, dates, and aggregate values
- actions: create or update records, create or update Tasks, add relations, request approval, notify, schedule, invoke an agent, or call an explicitly configured integration

Automations must have action caps, loop detection, idempotency, retries, dead-letter visibility, audit history, and simulation before activation. Agent actions remain subject to trust and approval policy.

Derived projections and rollups may update asynchronously, but the UI must expose freshness and failure state. Source records remain authoritative.

## Domain module portfolio

### CRM

Owns accounts, contacts, leads, opportunities, activities, and pipeline stages. Links to Tasks, messages, calendar events, marketing campaigns, service cases, proposals, and approvals.

### Marketing

Owns campaigns, audiences, channels, briefs, content items, launches, UTM definitions, budgets, and performance snapshots. Reuses CRM relationships, Assets, Tasks, Calendar, approvals, and analytics.

### Assets and Creative Review

Owns assets, versions, proofs, annotations, usage rights, review rounds, and approval outcomes. Supplies reusable proofing and gallery capabilities to Marketing, Events, Knowledge, and client delivery.

### Service and Client Delivery

Owns cases, request types, severity, service-level policies, escalations, customer updates, and satisfaction outcomes. Links to CRM, Tasks, messages, knowledge, approvals, and incidents.

### Recruiting and People Operations

Owns requisitions, candidates, applications, interviews, offers, onboarding plans, training, and offboarding cases. Requires private collections, field-level restrictions, access auditing, and retention controls.

### Finance and Procurement

Owns purchase requests, vendors, quotes, budgets, renewals, payment milestones, and approval chains. Requires currency, formulas, documents, separation of duties, and immutable audit evidence.

### Events

Owns events, venues, speakers, sessions, suppliers, registrations, and run-of-show records. Reuses Marketing, CRM, Assets, Tasks, Calendar, and approvals.

### Operations

Owns requests, procedures, vendors, locations, equipment, incidents, recurring checks, and service schedules. Reuses forms, Tasks, workload, automations, knowledge, and calendar capabilities.

## Solution packs

A solution pack is a declarative composition, not another data store. It can require modules and capabilities, then install:

- default navigation
- module and task views
- dashboards and metrics
- forms and intake routes
- task and project templates
- automation recipes
- approval policies
- agent skills and guidance
- sample data when explicitly requested

Initial packs should be Marketing Operations, Sales Operations, Client Service, Recruiting, and General Operations. Each pack must remain useful without an AI provider configured.

## Delivery phases

### Phase 0: Contract and migration design

- [ ] Write the cross-resource relation contract and threat model.
- [ ] Define ownership, inverse relationships, visibility, deletion, archive, and retention semantics.
- [ ] Define module dependency resolution and upgrade compatibility.
- [ ] Specify migration and rollback for existing same-module relations and Task links.
- [ ] Establish performance budgets for relation traversal, aggregation, and search.
- [ ] Record the accepted architecture as a durable decision before schema implementation.

### Phase 1: Cross-resource graph

- [ ] Introduce typed cross-resource relations behind one service interface.
- [ ] Add adapters for module records and Tasks first.
- [ ] Preserve existing module relation and Task-link APIs through compatibility adapters.
- [ ] Add cross-module relation fields to the manifest schema.
- [ ] Add permission, tenant-isolation, archive, cycle, idempotency, and concurrency tests.
- [ ] Add relation browsing and editing to generic record detail.

### Phase 2: Rich fields and shared files

- [ ] Add currency, percentage, duration, location, external identifier, file, and asset-reference fields.
- [ ] Add deterministic formulas, lookups, and rollups with dependency-cycle detection.
- [ ] Define file ownership, scanning, versioning, visibility, and retention behavior.
- [ ] Add migration fixtures proving older manifests and records remain readable.

### Phase 3: Views, dashboards, and analytics

- [ ] Add Calendar, Gantt, Gallery, Chart, Funnel, Dashboard, Workload, Map, and Pivot renderers incrementally.
- [ ] Introduce a typed query and aggregation contract shared by views and agents.
- [ ] Add module-owned and team-shared saved views.
- [ ] Add freshness, partial-data, and permission-filtered-result indicators.
- [ ] Validate representative desktop and mobile layouts visually.

### Phase 4: Governed automations

- [ ] Add versioned events and transactional outbox delivery.
- [ ] Build trigger, condition, and action contracts with bounded execution.
- [ ] Add simulation, activation, pause, retry, dead-letter, and audit UI.
- [ ] Add schedule and external webhook triggers with secret isolation and signature validation.
- [ ] Add agent actions as governed steps with approvals, caps, and receipts.

### Phase 5: Capability extensions

- [ ] Define the safe capability interface for proofing, service-level timers, forecasting, and UTM analytics.
- [ ] Permit only trusted bundled or administratively installed capability implementations.
- [ ] Keep uploaded manifests declarative and unable to inject scripts, URLs, or prompts into trusted execution.
- [ ] Add capability compatibility and disable/restore tests.

### Phase 6: Reference modules

- [ ] Evolve Contacts into the CRM foundation without breaking existing resource identifiers.
- [ ] Build Marketing and Assets as the first cross-module proof.
- [ ] Demonstrate Campaign to Account, Contact, Asset, Task, Calendar, and Approval relationships.
- [ ] Add UTM definitions, performance imports, campaign calendar, asset versions, annotations, and review gates.
- [ ] Build Service as the second proof, exercising service levels and customer relationships.

### Phase 7: Solution packs and authoring

- [ ] Ship Marketing Operations and Sales Operations packs.
- [ ] Add a no-code module and solution-pack authoring surface constrained by the manifest contract.
- [ ] Add preview, validation, dependency review, permissions review, and rollback before publishing.
- [ ] Add import/export and version-control-friendly canonical manifests.

## Acceptance evidence

The platform is ready for domain expansion when all of the following are demonstrated:

- A campaign in Marketing links to an account and contacts in CRM, assets in Creative Review, native Tasks, calendar events, and approvals without duplicating those records.
- Removing a viewer's access to one endpoint immediately removes the relationship and rollup data they should no longer see.
- Cross-organization and unauthorized cross-installation relations fail at API and database boundaries.
- A module upgrade preserves identifiers and relations, and rollback restores the previous compatible reader.
- Completing an agent-created marketing task can advance a campaign through a governed automation with one approval and verifiable receipts.
- Marketing and Sales packs can coexist without duplicating contacts or accounts.
- A deployment without an AI provider can use every core module, view, form, approval, dashboard, and deterministic automation.
- Existing Contacts records, same-module relations, saved views, search results, Task links, MCP clients, and agent receipts remain compatible.
- Representative marketing, sales, operations, HR, and service workflows pass end-to-end tests and rendered desktop/mobile inspection.

## Principal risks

- Cross-resource traversal can become a new tenant-isolation boundary; centralize authorization and test denial paths first.
- Formulas and automations can create cycles or unbounded work; use deterministic limits, loop detection, and action caps.
- Cross-module dependencies can make upgrades brittle; require compatible version ranges and staged activation.
- Generic views can become slow over JSON records and relations; introduce indexed projections deliberately and measure before denormalizing.
- Sensitive domains need stronger privacy than current modules; do not ship HR or finance packs before record and field access policies exist.
- Specialized capabilities can become a code-injection surface; keep manifests declarative and capability implementations trusted and versioned.

## Explicit non-goals

- Replacing native Tasks with module records.
- Making every record behave like a task.
- Shipping an unrestricted scripting runtime in module manifests.
- Automatically copying records between modules.
- Building every Monday, Jira, Notion, or CRM feature before validating the shared primitives.
- Moving domain-specific forecasting, campaign, recruiting, or procurement logic into Deft core.

## Recommended first vertical slice

Build the smallest end-to-end proof around Marketing plus CRM plus Assets:

1. Add a permission-aware Campaign-to-Account cross-module relation.
2. Link Campaign to native Tasks and Calendar.
3. Link Campaign to versioned Assets with one approval gate.
4. Add one campaign calendar view and one deterministic budget rollup.
5. Add one governed automation that creates review Tasks when an Asset version is submitted.
6. Verify the entire chain through UI, REST, MCP, Defty, an employee agent, search, audit, approvals, and receipts.

This slice exercises the architectural seams without prematurely building the full solution catalog.

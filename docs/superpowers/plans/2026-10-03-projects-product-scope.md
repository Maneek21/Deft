# Deft Projects: product scope for mixed teams

October 3, 2026. Status: proposed scope, not an implementation authorization. This document follows the [eight-product research](../audits/2026-10-03-project-management-product-research.md) and source inspection through merged master `b567af6ff12e5e4c61dbc54eddde17a81b986a28`. The user has narrowed this assessment to Projects for mixed teams. Workflows is excluded. Calendar remains core, superseding the earlier extraction suggestion in the [general app platform plan](2026-10-02-general-app-platform-execution.md). Ponytail is off.

## Decision

Make Projects a first-class core surface over the existing native Project and Task records. Give each undertaking an understandable home: purpose, accountable lead, current assessment, next milestone, execution views and authorized references to its context.

Deft already has substantial task execution. Its gap is helping a mixed team understand what the work is for, how it is actually going and which decisions or dependencies need attention. A project home connects Chat, Tasks, Knowledge, Calendar and installed apps around that outcome. It should remain useful when an app is unavailable and when no agent is enabled.

This is a core coordination responsibility. Specialized Documents, CRM or Email apps can contribute resources and governed actions through the general platform without becoming project owners. Project APIs and references should be equally usable by the web interface, permitted agents and app integrations.

The working hypothesis is that this coherence will make Deft more useful than adding further task views or a configurable work hierarchy. It is a product judgment supported by the comparative research, not a measured adoption result.

## Who and what to serve first

The initial audience is an internal mixed team: project lead, contributors across functions and stakeholders who need a reliable account without reviewing every task. Human and agent contributions use the same project context and underlying permission boundaries.

| Journey | What the team needs | Completion evidence |
| --- | --- | --- |
| Cross-functional launch | Marketing, design, engineering and sales coordinate a brief, deliverables, approvals and launch date | Lead can show the accepted outcome, next milestone, risk and supporting work; contributors find their next task |
| Client onboarding | An internal coordinator connects setup work, kickoff meeting, account references and handover | Team completes onboarding and preserves a useful handover record; no external guest access is implied |
| Internal initiative | Operations, finance or people teams deliver a policy, process or migration | Team explains the intended change, tracks commitments and records whether the outcome was accepted |

Dates are optional. Ongoing workstreams can remain active; users should not have to invent a deadline or sprint. Product language should use project, task, milestone, owner and update. Epics, story points and cycles are not prerequisites.

## Product shape and navigation

Add a Projects destination in primary navigation. Its index answers which undertakings exist and which need attention. Preserve global Tasks and My Tasks for execution across projects. Dashboard remains the cross-workspace summary; Calendar remains the shared time surface.

Suggested routes are `/projects` and `/projects/:id`. The route syntax is a proposal; implementation should follow the app's existing conventions. Preserve existing project IDs, task IDs, prefixes and `/tasks?project=...` links. Recent/favorite projects can remain accessible from the sidebar without requiring every project to appear there.

Use four project tabs at most:

| Tab | Purpose | Initial content |
| --- | --- | --- |
| Overview | Understand the undertaking in under a minute | Outcome, lead, lifecycle, health with date, latest update, next milestone and key references |
| Tasks | Do and inspect the work | Existing Board, Table, Timeline and Calendar views, scoped to the project |
| Updates | Read and publish the maintained account | Dated author assessments, meaningful progress, risks, asks and source references |
| Resources | Find supporting context | Authorized links to Chat, Knowledge, meetings, files and app-owned resources |

Milestones start as an Overview section, not a fifth navigation system. Existing project-space links provide access to the relevant conversation. A project does not create a second chat or document store.

The Overview should prioritize the latest assessment and next meaningful event over a wall of charts. A short brief can appear beside compact project properties on desktop; on narrow screens, the outcome and latest assessment precede secondary metadata. Keep the selected project, filters and task when changing execution views. Opening a task should preserve project context.

The inspected Deft task panel puts many properties before description and context. Test a more compact primary-property area within this journey, but do not make a global task-detail redesign a dependency of Projects.

## First supported release

### 1. Project identity, purpose and lifecycle

Reuse native Project identity, name, lead, icon, color, prefix and description. Add an explicit intended outcome or acceptance statement, optional start/target dates and lifecycle. Reuse an existing appropriate editor for a bounded brief; link a full document when more depth is needed.

Recommended lifecycle values are Planned, Active, Paused, Completed and Cancelled. Existing projects start with an unset lifecycle until deliberately classified; being present or unarchived does not prove they are active. Archive remains a separate visibility/retention operation. Completion records the accepted outcome and a short closing assessment, with references when useful.

Task status remains separate. Retain the existing six-state task model. Do not introduce custom task statuses, fields or a generic process designer as a condition of creating a project.

### 2. Explicit health and freshness

Health is Not assessed, On track, At risk or Off track. Show who assessed it, when and their explanation. The lead or an explicitly authorized editor owns this assessment. An overdue update is marked stale; it does not silently change the assessment to red or green.

Task completion and overdue counts can inform judgment but must not generate an authoritative health state. A project can be Off track with 95% of tasks done because its remaining approval is critical. Equally, early exploratory work can be On track with few completed tasks.

The index should default to name, lead, lifecycle, health, target and last update, with simple filters and sorting. Display task counts only after visibility-safe aggregation is implemented. Label partial counts as work visible to the viewer; never imply they represent hidden tasks too.

### 3. Maintained project updates

Provide a short update composer with progress, risks/blockers and next steps/asks. All sections need not be filled every time. A published update has an author, timestamp, assessment and optional source references. Latest published update appears on Overview; history remains readable.

Updates need canonical persisted identity rather than being reconstructed from whichever chat message is newest. Publishing may link the update into the existing project conversation. Discussion should reuse the existing spaces/messages model and its authorization instead of introducing parallel comment storage. Absence of a linked conversation must not prevent publishing an update.

Use optimistic concurrency for mutable project information. Published updates preserve edit history or explicit replacement/supersession rather than silent overwrite. A repeated publish request must not create duplicate updates or duplicate chat projections. Failure to project into Chat should leave the saved update accessible with an honest retry state.

Manual authoring is required. An agent-assisted draft is optional after the evidence path is reliable: it may use only permitted source data, distinguish missing context and cite its sources. It cannot autonomously publish a status update or change project health under this scope.

### 4. Deliverable milestones

A milestone names a meaningful deliverable, with optional owner and target date, a bounded completion state and links to contributing tasks. It is distinct from a task checklist, an agent execution milestone and a recurring timebox.

Show upcoming or blocked deliverables on Overview. Reuse task identities and their authorization. Task completion can suggest readiness but does not automatically establish that a deliverable was accepted. Avoid automatic dependency rescheduling, critical-path calculations and a new Gantt engine in this release.

Milestones can follow the first internal pilot. They belong in the supported release because they provide an understandable middle level between the project outcome and its many tasks.

### 5. Connected resources

Support selected references to project conversations, Knowledge pages, calendar events, files, relevant tasks and installed-app resources. A reference has canonical owner identity; presentation is resolved through that owner's authorization-aware interface. Keep one primary project owner for each task. Referencing another project's task does not change that ownership or duplicate the task.

The current shared resource contract includes native and app-runtime references but lacks a Project reference. Add Projects through the existing versioned contract and owner adapter, including deep links and safe unavailable/denied behavior. Do not create a second resource registry. Reconcile the existing task reference version through the established adapter path instead of broadening this into a resource-system rewrite.

The native project pilot can use native references first. App cards are accepted provider by provider as the general platform matures. An unavailable or uninstalled app produces a safe unavailable state; it cannot break the project page. Do not rely on custom embedded app widgets or arbitrary provider writes for this release.

### 6. Useful starting points

Offer three lightweight starting structures: Launch, Client onboarding and Internal initiative. They supply brief prompts and a small editable task/milestone structure. Use the existing task-template capability after fixing its dormant entry point. Preview before applying and make retries safe.

Users must also be able to create a blank project quickly. Templates are optional starting content, not domain-specific records or a new framework. They should not create empty meetings, documents or external app records automatically.

## Visibility, authority and failure boundaries

Current projects are organization-visible while underlying tasks and other resources can have narrower visibility. The first release preserves this model and explicitly communicates workspace visibility. Private projects, external guests and client portals require a separate permission/migration design and are outside this estimate.

The relevant flow is: authenticated actor and organization -> project authorization -> owner-authorized source queries -> safe aggregation/reference resolution -> viewer-specific presentation. Creation or publication follows the same owner interfaces and records the actor. Neither a browser client nor an agent receives privileged access merely by supplying a project ID.

| Boundary | Required behavior |
| --- | --- |
| Cross-organization access | Every project, update, milestone and reference operation is scoped and checked server-side |
| Restricted or deleted source | No hidden title, description, count, cached snippet or resolved URL leaks through project summaries or search |
| Project lead change | Preserve and test current task visibility implications; do not treat reassignment as a cosmetic field edit |
| Resource linking | Linking never grants read or write access to the target |
| Publishing an update | The composer makes the destination audience clear; source visibility does not automatically authorize republishing its contents |
| Agent draft | Read actor-permitted context, show sources and incomplete evidence, require a deliberate publication step |
| Source unavailable | Keep the project usable with a safe state and actionable recovery where the viewer is authorized |
| Concurrent edits | Detect conflicting writes; avoid last-writer-wins loss of a brief or assessment |

Project editor policy needs one implementation decision record before schema work: map lead/admin and any delegated editor role to the existing organization permission model. Participants, mentions and linked resources must not implicitly grant edit rights. Do not add a participant table merely to make an avatar row look complete.

An organization-visible published update is its own audience-bearing content. It must not automatically embed excerpts from restricted sources. Initial assistance should restrict project-wide drafts to appropriately shareable evidence or require an explicit authorized publication decision with a visible audience; it cannot treat a lead's personal source access as permission to broadcast. Source references continue to enforce their own permissions.

The [concurrent core quality audit](../audits/2026-10-03-core-capability-quality.md) reports access/deletion and stale-content inconsistencies. This assessment did not rerun those tests. Correct the affected owner queries and shared paths used by Projects before enabling their aggregates. Do not copy older project detail/velocity queries that omit task visibility conditions.

## Architecture options

| Option | Effort and benefits | Cost and failure mode | Decision |
| --- | --- | --- | --- |
| Add a small overview panel inside Tasks | Smallest local change; reuses navigation and models; easily hidden | Useful prototype, but project discovery and stakeholder orientation remain subordinate to task execution | Use as a throwaway interaction prototype only if faster; insufficient final product surface |
| First-class Projects navigation over current native owners | Additive metadata and records; preserves execution and references; callers share a bounded API | Requires careful aggregation, update publication and lifecycle semantics | Recommended |
| Build Projects as a general configurable app/module first | Exercises the app platform and supports specialized variants | Defers the core coordination experience behind app lifecycle/embedding maturity and complicates canonical task/context ownership | Keep specialized project extensions in apps; do not make this the initial core implementation |

The recommended implementation should expose a small project service boundary for read, edit, publish assessment, milestone management and resource linking. Use existing package conventions, shared validation and structured errors. Add no separate workflow engine, generalized graph service or new infrastructure merely to support these operations. Route tests and other callers should use the same authorized interfaces.

## Phases and estimates

These are planning estimates, not deadlines or measured delivery velocities. They assume engineers familiar with this repository, existing task views reused, internal organization members only, additive schema changes and focused design support. Agent assistance is included as a productivity aid, not assumed to make integration or validation instantaneous.

| Phase | Deliverable and exit condition | Engineering effort |
| --- | --- | --- |
| A. Project home | Agree audience/editor/health contracts; prototype with realistic mixed-team data; ship index, overview, metadata and existing task navigation | 2-3 engineer-weeks |
| B. Maintained context | Updates with history, native resource links/project references, safe aggregation, recovery and a modest Dashboard entry; internal pilot | 3-5 engineer-weeks |
| C. Delivery structure | Milestones and three lightweight starting templates, incorporating pilot findings | 2-4 engineer-weeks |
| D. Release validation | Supported upgrade/rollback proof, access/concurrency regression coverage, desktop/mobile/keyboard journeys and product polish | 1-2 engineer-weeks |

Total: **8-14 engineer-weeks** for the bounded supported release. Phases A and B provide a narrower pilot in roughly **5-8 engineer-weeks**. With two experienced engineers and available design/QA support, allow approximately **6-9 elapsed weeks** for the supported release; with one engineer plus agents, approximately **10-16 elapsed weeks** is more credible. These calendar ranges include ordinary coordination and iteration, but not a major pre-existing security repair or platform rewrite. Confidence is moderate-to-low until Phase A resolves the editing/publication model and measures reuse in the current integration branch. Treat roughly 40-50% variation as plausible.

The first 3-5 working days are part of Phase A: validate a clickable journey, define its source/audience rules and turn this scope into implementation-sized tickets. Re-estimate afterward. A private-client portal, full multi-project task ownership or arbitrary app widgets would invalidate the current range.

The broader app-platform estimate is separate and overlaps this work at resource resolution and authorization. Do not add the two estimates mechanically. A native Projects pilot need not wait for every app-platform capability; installed-app participation must wait for the relevant provider contract to be accepted.

## Relationship to other ongoing work

There is no evidence that all other development must stop. Continue security/correctness work, native resource contracts and general app-platform work that preserve the agreed core boundary. They support this proposal. Avoid starting another independent project schema, permission scheme or navigation redesign in parallel.

Before implementation, nominate an owner for shared resource contracts and coordinate changes to project authorization, task visibility and app-resource resolution. Rebase against current merged master, then inspect the actual integration candidate; the dirty root checkout and evolving Email/platform worktree are not interchangeable with a release baseline.

Freeze only conflicting changes while their contracts are being decided. Workflows, portfolios and additional core surfaces are deferred product decisions. Existing Task Rules can continue to function; their expansion and agent orchestration redesign are not Projects deliverables.

## Migration and rollback

Use additive project columns and new organization-scoped update/milestone/link records only where existing owners cannot represent the relationship. Preserve current project/task identity and foreign keys. Do not copy tasks into new containers.

Backfill no invented health, lifecycle, dates or acceptance statement. Existing descriptions and leads stay intact; new assessments start Not assessed and lifecycle remains unset. Existing archived projects remain archived, not automatically Completed. Keep archive, deletion/recovery and lifecycle distinct in API validation and UI language.

Use the supported repository upgrade path with a reviewed migration. Verify both a fresh install and an upgrade with existing projects, restricted tasks and archived/deleted records. No raw important-data migration is authorized by this proposal.

Gate new navigation and writes during rollout. A UI rollback can restore existing Tasks entry points while retaining new project records. Establish a compatible previous release before claiming binary rollback: an additive schema alone does not prove old code safely handles new data. Prefer disabling new writes and rolling forward over destructive down-migration. Published update links need a safe read-only destination if the new navigation is disabled.

## Acceptance evidence

Before declaring the supported release complete, collect the following evidence:

1. Run the launch, onboarding and internal-initiative journeys using realistic sample data. A contributor finds their work, a lead publishes an assessment and a stakeholder finds the outcome, risk, next milestone and supporting context without navigating every task.
2. Validate with representatives of at least three roles across a mixed team. Proposed usability targets are at least 80% completing the orientation exercise within one minute and creating a useful blank project within five minutes without administrator help. These are pilot targets, not current measured results; record failures and revise the design.
3. Demonstrate that Off track can coexist with high task completion, unset lifecycle is honest, stale updates are visible and completion differs from archive.
4. Use two organizations and actors with different source permissions to test project reads, counts, links, updates, search and agent drafts. Include revoked membership, deleted/archived source records and lead changes. Ensure cached content cannot bypass current access rules.
5. Exercise concurrent project edits, repeated publication, failed Chat projection, unavailable apps and retry recovery. Confirm that updates remain attributable and published content is not silently lost.
6. Preserve old task/project URLs, task identity, comments, source links, views and cross-project My Tasks. Test the project service through the same contracts used by routes and agents.
7. Rehearse fresh install, supported upgrade and the declared rollback procedure with populated data. Inspect the resulting schema/data and application behavior.
8. Inspect rendered journeys at representative desktop and mobile widths, including keyboard navigation, focus return from task panels, empty/loading/error states and long project/resource names. A passing build is insufficient evidence.
9. Complete the main journeys with agents disabled. Validate optional drafts separately for source accuracy, incomplete context and deliberate publication.

Capture focused automated checks at authorization, aggregation, revision and idempotency boundaries; use visual and user evidence for usability. The research performed for this scope is not implementation test evidence.

## Explicit exclusions

The release does not include a Workflows designer, autonomous recurring status publication, a second agent runtime, portfolios/OKRs, resource-capacity planning, billing/time tracking, private projects or guest portals, task multi-homing, custom statuses/fields, new sprint models, dependency auto-rescheduling, a document editor suite, arbitrary embedded app widgets or new Calendar provider-write integrations.

The result should be one complete, understandable Projects experience for mixed teams. Expansion follows evidence from using that experience, with specialized behavior continuing through the general app platform.

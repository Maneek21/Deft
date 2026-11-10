# Project management product research for Deft

Research date: October 3, 2026. Purpose: understand what makes strong project-management products useful, compare those lessons with Deft, and inform a bounded Projects surface for mixed teams. The user subsequently narrowed delivery to Projects only; Workflows is background research and is excluded from the proposed delivery scope. Calendar remains core. Ponytail is off.

Recommendation: evolve Deft's existing Projects into a shared home for an undertaking, with purpose, accountable ownership, milestones, maintained status updates and authorized context. Preserve its existing task execution views. The opportunity is a more coherent working experience across Chat, Tasks, Calendar, Knowledge and installed apps. It is not another task engine or a union of competitors' features. The [companion scope](../plans/2026-10-03-projects-product-scope.md) defines the release boundaries.

## Research method and limits

The sample covers Linear, Asana, monday.com, ClickUp, Jira, Notion, Basecamp and Plane. These represent focused software delivery, cross-functional coordination, configurable operations, document-centered work, simple project rooms and a self-hostable challenger. They are a useful selection of prominent and emerging products, not a statistically established ranking of the hottest products. No comparative active-user, retention or growth dataset was available for this assessment.

Three GPT-6.1 Sol agents contributed competitor research and Deft source inspection. Evidence comes from current official documentation and public examples. Vendor illustrations for Linear, Asana, Basecamp, ClickUp, monday, Jira, Notion and Plane were visually inspected. Their examples establish layout and interaction patterns, not measured usability or hands-on product reliability. No competitor accounts were created and no authenticated competitor workflows were executed. Journeys below are reconstructed examples; audience fit, benefits and tradeoffs are analytical judgments.

Deft was inspected through merged master `b567af6ff12e5e4c61dbc54eddde17a81b986a28`, which includes native mentions. The root checkout remains older and dirty. The evolving Platform/Email candidate was treated separately. The live demo's Tasks, project navigation, task detail and Task Rules screens were also inspected without saving data. Its dataset identifies itself as synthetic; its deployment was not asserted to match the source SHA. No runtime test suite was run for this research.

## Comparative findings

| Product | Organizing idea | Strongest fit in this analysis | Useful lesson for Deft | Main cost of copying it wholesale |
| --- | --- | --- | --- | --- |
| Linear | Clearly defined issues, projects and initiatives | Product and engineering delivery | Purposeful defaults, maintained project updates, disciplined intake | Software terminology and planning methods become obligations for everyone |
| Asana | Shared work connected across departments and outcomes | Launches, marketing, operations and service delivery | One work record, explicit ownership, contextual project overview | Portfolio and configuration hierarchy can overwhelm smaller teams |
| monday.com | Typed rows in configurable operational boards | Business teams working from shared tables | Scan responsibility, status and dates without opening every record | Teams must invent and maintain consistent meanings for their boards |
| ClickUp | Hierarchical work locations with many views | Teams that need several execution perspectives | Preserve work identity while changing views | Container hierarchy and view hierarchy both need management |
| Jira | Typed work and controlled transitions | Teams with demanding process and administration needs | Distinguish state, transition and resulting action | Heavy configuration makes ordinary work expensive |
| Notion | Rich pages with relational structured data | Context-heavy planning and knowledge work | Put explanation next to execution | Users become designers and maintainers of their own work system |
| Basecamp | A project room containing communication and work | Agencies, small businesses and client delivery | An understandable home, asynchronous updates, human judgment | Multiple tools can still fragment one workstream |
| Plane | Projects, execution structure and knowledge in one workspace | Product teams valuing integrated and self-hostable tools | Project overview, progressive feature activation, explicit agent scope | Feature and hierarchy expansion can recreate incumbent complexity |

These comparisons describe product design, not rankings of reliability, speed or customer satisfaction.

## Linear

Linear gives projects their own overview with a short summary, detailed description, responsible lead, dates, resources and milestones. The same properties remain accessible from a project details panel while viewing its issues. This creates a useful distinction between understanding a project and executing its tasks, while keeping both reachable. [Project overview](https://linear.app/docs/project-overview)

A representative launch journey starts with a project brief and milestones, then breaks delivery into issues. During execution, the lead publishes a dated assessment of health and progress. The latest update appears on the overview; previous updates and property changes remain available in a chronological record. The design helps answer what changed and why, rather than making stakeholders infer status from a board. [Project updates](https://linear.app/docs/initiative-and-project-updates)

A second journey starts with an incoming customer problem. Triage separates arrival from acceptance: a responder can investigate, accept, decline, mark a duplicate or snooze. The inspected public Triage illustration places titles first, with source/requester context and identifiers in secondary positions. My interpretation is that this supports rapid review without demanding that every report become committed work. [Triage](https://linear.app/docs/triage)

For Deft, the most useful borrowing is the project brief, latest owner update and compact details access. Preserve those ideas while using mixed-team language. Engineering cycles and issue estimates should not become prerequisites for launching a campaign or onboarding a customer. A risk is mistaking an orderly hierarchy for truthful reporting: updates still need an accountable author and freshness.

## Asana

Asana offers several views of project work and a path from individual tasks to broader project and organizational reporting. For a cross-functional launch, one department may review a list of responsibilities while another uses a board. Their views should represent the same work. Asana also documents placing one task in multiple projects without duplicating its identity. [Project management](https://asana.com/features/project-management), [task multi-homing](https://help.asana.com/s/article/multi-home-tasks-to-avoid-information-silos?language=en_US)

Consider a campaign requiring legal approval. Marketing needs the approval visible in its launch plan; legal needs it in its review workload. Reusing one task prevents conflicting owners and completion states. A lead can then issue an update explaining which deliverables finished and which risks need attention. Asana's status-update product explicitly supports selecting meaningful project highlights. [Status updates](https://asana.com/features/project-management/status-updates)

A separate creative-intake journey turns a structured request into assigned work and a human review checkpoint. The public AI Studio illustration shows named steps, a review branch, separate Build and Activity views and an explicit Publish action. This is useful evidence of how authoring and execution can be distinguished, but building this workflow product is outside Deft's current Projects scope. [AI Studio](https://asana.com/product/ai/ai-studio)

My interpretation: Asana is a particularly relevant mixed-team comparator because it helps different roles coordinate around the same commitment. The cost is administrative vocabulary and inconsistent configuration between teams. Deft should adopt cross-context references and clear project updates immediately; full multi-project task ownership, portfolios, goals and capacity management need separate evidence. A reference to another project's task can provide useful visibility without changing its canonical owner or permissions.

## monday.com

monday separates organizational containers from the working board. Boards contain groups, items and typed columns; items can represent tasks, customers or projects. This is powerful for teams that think in operational tables, but it means the software does not impose one definition of a project. [Structural hierarchy](https://support.monday.com/hc/en-us/articles/7278527605906-Understanding-monday-com-s-structural-hierarchy)

The inspected sample board makes owner avatars, colored status cells, dates, timelines and files visible in rows. Search, person filter, general filters, sorting, hiding and grouping sit in the toolbar. A creative manager can scan a campaign's assets, see who owns review and open the specific item's discussion. A department lead can aggregate several boards in a dashboard, then drill into the project needing attention. [Board walkthrough](https://support.monday.com/hc/en-us/articles/115005317249-The-basics-of-a-board)

My interpretation: the strength is immediate operational readability. The weakness emerges as columns accumulate or teams model the same concept differently. Deft already has a task table; it should improve useful defaults and scanning before adding more views. A project index should expose owner, lifecycle, health, target and last update in a compact table. It should not require each team to assemble a project-management system from generic columns.

monday also distinguishes editing content from editing board structure. This is a useful design principle for Deft: participating in delivery and changing the project's configuration are different responsibilities. Borrow that distinction without copying an enterprise permission designer. [Board permissions](https://support.monday.com/hc/en-us/articles/115005315809-Board-permissions)

## ClickUp

ClickUp separates a hierarchy of work locations from views of those locations. Its documented structure includes Workspace, Space, optional Folder, List, Task and Subtask. A List is a container; List view is a presentation. [Hierarchy](https://clickup.com/hierarchy-guide)

An agency might organize a client in a Folder and a campaign in a List, then use tasks for deliverables. A manager reads owners and deadlines in List view; a producer uses Board; connected scheduling work can appear in Gantt. A second journey uses a location's views to inspect recurring operational work and switch between upcoming deadlines and execution state. Documented views can be organized, defaulted and protected. [Views](https://help.clickup.com/hc/en-us/articles/6329880717719-Intro-to-views)

My interpretation: changing perspective without copying work is the central benefit. The corresponding cost is maintaining both a location tree and its collection of views. Deft already has Board, Table, Timeline and Calendar; another large view catalog is not the missing capability. Preserve the current project, filters and selected task when switching views. Put secondary display controls behind progressive disclosure and supply useful defaults.

Cross-location permissions are an important caution. ClickUp documents interactions among item, location, individual and team permissions, including tasks present in multiple Lists. Deft should not infer that appearing in a project's resource list makes the underlying resource visible to everyone. [Permission model](https://help.clickup.com/hc/en-us/articles/6309221065495-Permissions-in-detail)

## Jira

Jira's work hierarchy distinguishes epics, standard work items and subtasks. Its workflow model separately defines statuses and allowed transitions. This supplies stronger process semantics than a free-form collection of status labels. [Work types](https://support.atlassian.com/jira-cloud-administration/docs/what-are-issue-types/), [workflows](https://support.atlassian.com/jira-cloud-administration/docs/work-with-issue-workflows)

A software team breaks a feature into work items and tracks their review and delivery. A mixed team could use controlled review states for an approval process. The lesson is to distinguish a deliverable's structure from how an item progresses. Deft should similarly distinguish project lifecycle from task status, health from completion ratio, and archiving from successful delivery.

The inspected navigation example separates personal navigation from tabs for the current working context. Current documentation uses spaces and work items, while some images retain older terminology. Personal sidebar customization and shared context configuration are separate concerns. [Navigation](https://support.atlassian.com/jira-software-cloud/docs/what-is-the-new-navigation-in-jira/)

My interpretation: Jira is useful when consistency and explicit process matter, but broad configuration can overwhelm routine collaboration. Deft should borrow predictable transitions and clear scope, while avoiding required epics, sprints, points or administrator-created schemes for ordinary mixed-team projects. AI-generated automation in Jira follows a preview, inspect and enable sequence; the same reviewable approach is relevant to future Deft assistance, without bringing workflow authoring into this release. [AI-assisted automation](https://support.atlassian.com/cloud-automation/docs/use-atlassian-intelligence-with-jira-automation/)

## Notion

Notion connects project and task databases with rich pages. Its templates provide different starting levels, from a to-do list to related Projects and Tasks and optional Sprints. A project can contain narrative context while linked task views support daily execution. [Projects and tasks guide](https://www.notion.com/help/guides/getting-started-with-projects-and-tasks)

In a launch journey, a lead writes the brief inside the project page and uses related tasks for deliverables. For client onboarding, a repeatable project structure keeps context, owners and tasks together. The value is that the explanation of work stays near the work itself. These are illustrative applications of its documented model, not tested templates.

The inspected layout-builder illustration separates the heading, property group and details panel. Current layout documentation also supports tabbed content and related database views. This demonstrates how a dense record can expose important fields while moving secondary ones away from the narrative. [Database layouts](https://www.notion.com/help/layouts)

My interpretation: flexibility is valuable, but it transfers product-design work to the team. Someone must decide what each database, relation, status and template means and keep that system coherent. Deft should provide an opinionated project overview with a short brief and linked Knowledge/Documents resources. It should not build another general document/database editor inside Projects.

Notion's database automation documentation also names limits, including restrictions on automation chaining. That is a useful reminder to distinguish linked information from a full process engine. Such automation is outside the current scope. [Database automations](https://www.notion.com/help/database-automations)

## Basecamp

Basecamp organizes collaboration around a project room containing selected tools for discussion, tasks, chat, scheduling and files. The inspected Basecamp 5 illustration uses a project/member header and a grid of tool previews that show actual content. This offers immediate orientation: users can see what is happening before opening a tool. [Features](https://basecamp.com/features), [Basecamp 5](https://basecamp.com/5)

For a website-delivery project, the team keeps a brief, assets, discussions and work lists together, then deliberately shares selected deliverables with a client. Current client documentation distinguishes private material and explicitly shared content, including inheritance. Deft should study this journey, but client guest access is not a free consequence of adding a Projects page and is excluded from the first scope. [Client visibility](https://5.basecamp-help.com/article/1082-what-clients-can-see-and-do)

A second journey involves uncertain work. A lead reviews which parts of a project are still being figured out and which are understood and progressing. Hill Charts explicitly represent that judgment rather than equating completed tasks with confidence. [Hill Charts](https://5.basecamp-help.com/article/1066-tracking-work-on-the-hill-chart)

My interpretation: Basecamp is the strongest counterweight to copying every configuration feature. Its project room is understandable to mixed teams. However, separate tools can still distribute the latest decision across a message, chat and task. Deft should borrow the orientation and owner judgment, while reusing its existing Chat and Knowledge rather than creating duplicate discussions and document stores. A new project overview must not turn into a miniature second application shell.

## Plane

Plane is a particularly relevant comparator because it publicly offers integrated project/knowledge work and self-hosted deployment. Its documented hierarchy separates workspace, teamspace, project and work item. This reinforces that Deft cannot claim uniqueness merely from combining tasks, knowledge and agents or offering self-hosting. [Product](https://plane.so/), [workspace model](https://docs.plane.so/workspaces/overview)

The public project-overview image inspected here places the brief and goals in a main column, project properties in a side panel, and task-state progress below. Project overview documentation includes resources, dates, lead and status updates. A lead can orient a team around an undertaking; a stakeholder can inspect its latest condition without opening every work item. [Project overview](https://docs.plane.so/core-concepts/projects/project-overview)

Plane distinguishes modules that group delivery scope from cycles that time-box execution. A migration might have several deliverable groups across successive cycles. That distinction is useful for analysis, but Deft does not need both new objects for its mixed-team first release. [Modules](https://docs.plane.so/core-concepts/modules), [cycles](https://docs.plane.so/core-concepts/cycles)

Project updates pair narrative with health. Agent documentation separately requires explicit project and connector scope. My interpretation: keeping project context and agent access understandable is increasingly a competitive expectation. Deft should make actor, permitted context and publication audience visible, and should avoid treating a project's collection of links as a blanket access grant. Plane's documentation labels features by edition; the research does not certify identical availability across every cloud/self-hosted plan. [Updates](https://docs.plane.so/communication-and-collaboration/project-updates), [agent access](https://docs.plane.so/ai/agents/agent-access)

## Findings across products

The most transferable pattern is a maintained project home with two complementary layers: an account of the outcome and current risks, and views of the work required to get there. Adding view types alone does not create that home.

Six design principles follow from the comparison:

1. Give objects stable meanings. A project, task, status update and document should not be interchangeable merely because a generic database can represent all four.
2. Preserve identity across perspectives. Linking work into a new context should not duplicate its owner, discussion or status.
3. Distinguish measured activity from judgment. Task completion is a useful measure; health and acceptance of an outcome require an explicit accountable assessment.
4. Put enough context beside the work. Reveal secondary metadata progressively, while keeping purpose, owner, next action and important references easy to reach.
5. Make the common path usable without configuration. Templates can accelerate a launch or onboarding without asking users to construct an operating model first.
6. Make generated assistance reviewable. Source links, actor identity, freshness and a clear publication step matter more than an additional AI button.

These are design hypotheses to validate with Deft users. Competitor documentation does not prove that a copied pattern will improve Deft's adoption or retention.

## What Deft already has

Current source supplies project identity, prefixes, lead and description, plus archive/delete/restore. Tasks have Board, Table, Timeline and Calendar views, saved filters, bulk operations, subtasks, dependencies, comments, references and agent participation. Existing project-space links and task source links provide useful integration points. [Project schema](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/packages/db/src/schema.ts#L403), [task surface](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/web/src/app/%28app%29/tasks/page.tsx)

What is missing is project-level purpose and communication as a product: no dedicated overview route, lifecycle/health model, target dates, maintained project updates or deliverable milestones were found. Task counts and completion velocity do not supply these. The Goals widget is empty scaffolding and unregistered; agent progress milestones are not project planning milestones. [Project API](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/projects.ts), [Goals stub](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/web/src/app/%28app%29/dashboard/widgets/goals.tsx)

Current task statuses are deliberately fixed; project-resolved configuration has no active custom status/field system. The existing task template catalog is useful, but the Tasks page's template entry is gated by configuration that currently returns an empty template list. Treat neither dormant UI nor old prose as a delivered capability. [Resolved configuration](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/lib/project-resolved-config.ts), [task template API](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/apps/api/src/routes/task-templates.ts)

Native references were extended in the mentions merge, but the inspected union does not yet include Projects. A first-class project reference and owner adapter must be added through that existing contract. App resource identity existing in the schema does not certify a complete installed-app participation experience. [Resource references](https://github.com/Maneek21/Deft/blob/b567af6ff12e5e4c61dbc54eddde17a81b986a28/packages/shared/src/resources-v2.ts)

## Deft interface observations

The live demo's task board has recognizable columns, inline creation, filters and a persistent project list. Selecting a project changes the task view; it does not open a project brief or current assessment. That supports execution well but makes the user reconstruct the undertaking from its individual tasks.

The inspected desktop task detail opens as a side panel and preserves board context. Its property block occupies much of the initial viewport, while description and references sit below a horizontally overflowing section strip. This is a concrete opportunity for progressive disclosure and better context placement, not evidence that all detail views are unusable. The prototype should test a shorter primary-property area and clearer access to description, source and next action.

The Task Rules screen is correctly labeled as small deterministic handoffs and was empty in the inspected demo. Opening its creation form exposed a status-change trigger and four action kinds; the form was cancelled without saving. It is not a general Workflows product and is outside this delivery scope.

The concurrent [core capability quality audit](2026-10-03-core-capability-quality.md) identifies access, deletion, history and recovery inconsistencies. This research did not rerun its probes. Its findings matter because a new project aggregate could repeat existing authorization mistakes. Project overview, counts, updates and agent context should use corrected owner authorization rather than copy older summary queries.

## Implication for the next release

Prioritize a mixed-team Projects experience inspired by Asana's coordination, Basecamp's understandable home, Linear's maintained updates and Notion's proximity of context to work. Keep Deft's existing task engine and visual identity. Use references to integrate Calendar, Knowledge, Chat and apps.

The first successful journey should be an internal mixed-team launch or client onboarding: establish the outcome, organize existing work, connect context, communicate progress and close with evidence. Do not require a new document suite, private client portal, workflow designer or portfolio hierarchy to complete that journey. The [Projects scope](../plans/2026-10-03-projects-product-scope.md) translates this recommendation into screens, data changes, phased effort and acceptance evidence.

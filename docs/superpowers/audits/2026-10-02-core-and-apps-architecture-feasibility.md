# Deft core and installed apps architecture feasibility

Subsequent direction: the user clarified that completing the general app platform is the primary goal. The [general platform execution plan](../plans/2026-10-02-general-app-platform-execution.md) supersedes this report's Documents-first sequencing and supplies a separate platform-beta estimate. This report remains the earlier evidence snapshot; native mentions has since opened PR 352.

Reviewed October 2, 2026. This is a feasibility assessment and proposed direction, not an accepted implementation decision. Three GPT-6.1 Sol agents independently examined core extraction, App Kit readiness, and GitHub delivery state; the lead reviewed relevant Codex chats, checked source evidence, and reconciled their findings. No application code, database, deployment, PR, or other chat was changed. This report is the only intended file addition.

The proposed product has four primary surfaces: Chat, Tasks, Knowledge, and Dashboard. Documents, Calendar, Email, CRM, and other specialized products become independently authored and installed apps. This is feasible and consistent with much of the existing App platform investment. It requires a retained workspace platform underneath those four surfaces. Removing identity, attention, files, agents, permissions, or governance along with specialized screens would undermine the intended integration.

Recommend an incremental transition to protocol-based installed apps. First stabilize and version the existing platform, prove a second substantial consumer with Documents, then extract Calendar and remaining specialized experiences. Reduce Notes' prominence separately if desired. A four-surface navigation change can take roughly one to two weeks; a genuine extraction program with collaborative Documents, Calendar ownership, migration, and release evidence is approximately four to seven months with two experienced engineers and supporting review. These are planning estimates with substantial uncertainty, not measured delivery commitments.

## Scope and meaning of external

Four different requirements must not be conflated:

| Requirement | Recommendation |
| --- | --- |
| Independently authored and versioned code | Required for specialized apps. They should have their own product ownership and release cadence. |
| Installation through a public App Kit artifact | Required. An outside author should build and install the app without patching Deft source. |
| Separate runtime process | Use where app execution, provider integration, or a specialized engine needs isolation. Not every declarative app needs a service. |
| Separate physical database | Optional. Logical ownership and enforced interfaces matter first; a database per app adds backup, availability and consistency costs. |

An external app can be first-party and self-hosted alongside Deft. External does not imply a third-party SaaS account or an unrelated website. The initial deployment should retain the supported one-workspace model rather than combine this program with multi-tenant hosting or distributed core services.

The target is four primary product destinations with platform administration and attention available in the shell. Settings, installation, member administration, approval review, and connection management remain necessary interfaces. Their existence does not make them independent productivity products.

## Verified source and delivery baseline

The root working directory is not the current product. Its application code is 205 commits behind the reviewed remote master and it contains unrelated changes. No pull, reset, cleanup, or overwrite was performed.

| Source | Reviewed identity | What it establishes |
| --- | --- | --- |
| Main local checkout | `2d478aee4bba23b34266e29247c1a0901f5b6d58` | Historical code and current local planning documents; not a suitable implementation baseline. |
| GitHub master | `94626051299decb231b48bead1144a716cd7873d` | Current merged source. Exact-head CI succeeds. Kit package is alpha.3. |
| Published preview.15 | `a1aeab4336d5f2005864ca852d17cf82b0eeb9f8`, September 8 | Published prerelease. Master contains 47 subsequent commits; merged CRM and October fixes must not be described as already in this artifact. |
| Platform PR 345 | `7fe25abe6a7b487fca2e67b45b8683315abec8e4` | Draft, 599 changed files. API and one CodeQL check fail; Build is skipped. Other checks include successful image/browser and upgrade runs. |
| Release PR 346 | `153614ee373a874bd88e9119c0ec028f03b69ef8` | Draft stacked on Platform, with no checks. Its alpha.6 title does not describe the newer local Kit. |
| Email PR 347 | `0c611bb4b1a000e8b4a066f71974137e5c0f31cd` | Draft stacked on release preparation, with no checks. Local work has advanced beyond this head. |
| Active Platform and Email checkout | `C:/tmp/deft-gate-g-integration-20260924`, preceding head plus dirty/untracked work | Runtime, Experience, private resource, state, file, connection and Email development. Package version alpha.9; substantial work is absent from remote PRs. |
| Native mentions checkout | `C:/Users/Osheen Pradhan/.codex/worktrees/native-mentions/Deft Main Repo`, based on reviewed master | Active local implementation; no open PR at review. Includes the additive resource contract and migration 61. |

Fresh GitHub inspection found exactly five open PRs: [345](https://github.com/Maneek21/Deft/pull/345), [346](https://github.com/Maneek21/Deft/pull/346), [347](https://github.com/Maneek21/Deft/pull/347), [348](https://github.com/Maneek21/Deft/pull/348), and [349](https://github.com/Maneek21/Deft/pull/349). JWT validation PR 348 has a failing image/browser gate. CodeQL action update PR 349 has green applicable checks. These are separate core maintenance tasks, not grounds to restart the App architecture.

The [current-master CI run](https://github.com/Maneek21/Deft/actions/runs/36968368026) succeeds at the exact reviewed SHA. The workflow takes roughly eleven minutes, which measures feedback latency, not engineering throughput. Stacked PR 346 and 347 do not receive the ordinary PR checks because the workflow targets master/main bases. Their empty check lists provide no release evidence.

Sources: [published prerelease](https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.15), [current self-host contract](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/docs/self-hosted-v1-contract.md), [release rules](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/RELEASING.md).

## Proposed ownership boundary

| Area | Product or platform ownership | Reason |
| --- | --- | --- |
| Chat | Core product | Shared conversations, spaces, threads and human/agent participation are the work record. |
| Tasks and projects | Core product | Work ownership, status, dependencies, comments, history and due dates remain native. Task calendar views do not require a Calendar app. |
| Knowledge | Core product | Curated wiki content, decisions, procedures, memory, citations and provenance remain durable team understanding. |
| Dashboard | Core product | Aggregates authorized work and attention. Apps contribute bounded summaries and links through a future supported contract. |
| Documents and Notes | Specialized app | Rich authoring, document organization, collaboration, versions and comments form a product with its own depth. |
| Calendar | Specialized app | Native appointments, feeds, calendar sharing, scheduling and provider synchronization move together. Generic time utilities and scheduled jobs remain platform services. |
| CRM and business workflows | Specialized apps | Contacts, companies, deals and activities already use declarative domain records. |
| Email | Specialized app | Mailbox identity, MIME, provider semantics, search and compose belong with Email. |
| People and teams | Split | User identity, membership, access groups, assignees and offboarding remain platform functions. Rich directories, manager analytics and HR workflows can be optional. |
| Files | Split | Attachment custody, scanning/derivatives, quotas and owner-derived access remain shared. A Drive-like browser or document-management product can be an app. |
| Inbox and notifications | Shared attention plus a shell experience | Personal clear/snooze state and approvals span every product. They are not the Email inbox. Dashboard or a persistent tray can provide access. |
| Agents and MCP | Shared governance and protocols | Identities, scopes, approvals, receipts, tool/resource access and shared chat stay integrated. Model/runtime execution can remain external. |
| Authentication, settings, installation and operations | Platform | Apps cannot each become a separate source of workspace identity, authority or recovery policy. |

Knowledge and Documents need a deliberate product distinction. A document is an authored artifact; Knowledge is curated workspace understanding. Keep current wiki editing while Documents is introduced. A document can be a cited source or can publish a selected conclusion into Knowledge. Copying private source text into a broadly visible knowledge entry must be an explicit authorized publication, not an automatic side effect of indexing.

## What the code requires beyond moving screens

Current source directly couples Notes and Calendar to shared behavior:

- [Search](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/routes/search.ts) queries native Notes alongside core records. Agent tools, human MCP, cross-references and task links also know their native types.
- [Calendar](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/routes/calendar.ts) combines events with tasks, Notes and reminders. Dashboard and meeting-preparation workers read Calendar state directly.
- [Team routes](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/routes/teams.ts) and team context enumerate native Notes, wiki and calendar-feed resources. People/member lifecycle also manages credentials, assignment and access relationships.
- [Dashboard widgets](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/web/src/app/%28app%29/dashboard/widgets/index.ts) are statically imported React components. The internal registry is not an App Kit install or security contract.
- [Notes routes](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/routes/daily-notes.ts) store HTML, history and sharing, and only permit the owner to edit. Their permissions differ from workspace-readable Module records.

Therefore, removing sidebar entries is a product presentation change. Moving code into a package that is still imported by the host build is an intermediate refactor. Neither proves independent installation or removal.

CRM is the easiest initial extraction. [PR 334](https://github.com/Maneek21/Deft/pull/334) is merged, and [Contacts already has an external source repository](https://github.com/Maneek21/deft-module-contacts/pull/1). Its business records and views are declarative. Preserve the existing installation and IDs; installing a second populated Contacts dataset would be a migration failure.

## App Kit readiness and required additions

The merged [Kit contract](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/packages/app-kit/README.md) supports declarative packaging, requested authority, grants and governed execution. Its [resource resolver](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/lib/resource-authorization.ts) has closed Module and Task adapter slots. An arbitrary resource name in a manifest does not create a provider.

The newer candidate adds substantial reusable machinery: isolated Worker experiences, host rendering, private resource synchronization, runtime claims, short-lived sessions, retained uncertain outcomes, encrypted state, file custody and connection setup. Those are important investments to retain. They are development capabilities requiring an exact accepted candidate and conformance evidence.

| Gap | Source evidence | Required direction |
| --- | --- | --- |
| Durable shared documents | [Private state](C:/tmp/deft-gate-g-integration-20260924/packages/app-kit/src/private-state.ts:5) permits bounded temporary owner state: 16 KiB per record, 32 records and up to 30-day retention. [Sync declarations](C:/tmp/deft-gate-g-integration-20260924/packages/app-kit/src/resource-sync.ts:62) use owner-private visibility. | A durable document owner service with document ACLs, revisions, attachments and lifecycle. Do not use email drafts or workspace-readable Module rows as a substitute. |
| Rich editor execution | [Experience bridge](C:/tmp/deft-gate-g-integration-20260924/apps/web/src/lib/app-experience-bridge.ts:41) validates a closed, bounded view grammar; a Worker cannot mount its own DOM editor. | Choose one supported trusted editor primitive or a separately isolated visible editor experience. Reuse Tiptap or another existing engine. |
| Generic content | [ExperienceResourceDocument](C:/tmp/deft-gate-g-integration-20260924/packages/app-kit/src/experience-sdk.ts:14) requires sender-account metadata and includes mail reply headers. | Separate generic content/read authorization from Email-owned metadata. Documents should not fabricate mail identities. |
| Workspace participation | Resource references exist, but no complete installed-app contract was found for Dashboard cards, arbitrary domain attention, mentions and shared editor participation. | Extend existing resource and authorization seams with consumed contributions. Avoid a separate registry or ACL model for every surface. |
| Everyday installation | [Connection registry](C:/tmp/deft-gate-g-integration-20260924/apps/api/src/lib/app-connection-registry.ts:15) loads operator-configured, hash-pinned trusted adapters. | Specify what an operator provisions and what installation supplies; keep arbitrary authored code out of the trusted server. |
| Export and removal | [App service](C:/tmp/deft-gate-g-integration-20260924/apps/api/src/lib/app-service.ts:662) refuses destructive uninstall pending export/retention behavior. | Define disable, retained data, export, re-enable, ownership transfer and eventual removal separately. |
| Version compatibility | Candidate package says alpha.9 while exported constant and documentation retain older versions. | Freeze one host, Kit, app and schema combination with explicit capability negotiation and packed-consumer checks. |

Documents is a valuable second consumer precisely because it exposes abstractions shaped too closely around Email. Fix those concrete seams; do not restart the whole platform or design a universal plugin system in advance.

Human document editing should use authorized resource mutation with revision/conflict semantics. Every keystroke must not become a governed external App Run. Agent changes, publication, sharing, export and destructive actions still require the applicable actor policy and audit behavior. Preserve the distinction between personal MCP acting as its user and employee/Defty policy.

## Ongoing Codex work and how it fits

The current thread catalog was inspected, and the seven relevant recent chats below were read. The catalog returns at most 50 recent non-pinned chats plus pinned chats; this is a review of visible ongoing/recent Deft work, not a claim to have enumerated every historical or archived chat. No follow-up instructions were sent to these chats.

| Chat title | Observed state | Implication for this change |
| --- | --- | --- |
| Universal Tagging | Active implementation of native mentions, not classification tags. Adds reference state, durable delivery, source ACLs, editor integration, human publication intent and passive agent attention. | Continue reusable identity/delivery work. Add a future app-owned source adapter rather than replacing its ledger. Notes-specific handling becomes a compatibility adapter. |
| Fast Inbox | Detailed plan and compatibility review; application implementation still pending in the inspected state. | Keep it as shared attention. Preserve pending approvals, personal triage semantics, native mention delivery and App Run receipts. It need not wait for full Email or Documents. |
| Email Stage 1 | Active real-provider testing and fixes; candidate contains additional reader/compose/triage work. Latest checkpoint still has unresolved release gates. | Continue bounded certification. Preserve runtime/custody/authorization work; extract mail semantics from generic contracts before more consumers depend on them. |
| Analyze Deft repository and GitHub | Completed audit and remediation plan; no fixes applied by that plan. | Treat task visibility, standup disclosure, JWT, bootstrap and stale-state work as prerequisites or parallel core repairs, not solved by moving products. |
| Review Hearthcore open PRs | Reports merged PRs 342, 343, 344 after dependency/security PR 350. GitHub independently confirms the relevant merges. | Preserve them. This is completed transcription, source-version and VAPID work, not another unmerged app. |
| Review sideloaded apps state | Long-running platform history; latest completed work populated and inspected the demo. | Reuse as historical context only. Seeded demo data and successful screens do not certify outside-author installation or provider reliability. |
| Map Deft feature opportunities | Product/dashboard recommendations, not an implementation branch. | Delivery pulse, grounded briefs and review navigation fit core. App-owned operational views need the missing contribution contract. |

The two active implementation branches already share identical additive `resources-v2.ts` content at the audit snapshot. That is an opportunity to land one compatible contract. They also overlap schema, migration manifests, shared exports, API registration, human MCP and attention code. Their shared contract ownership and merge order must be explicit.

The mentions implementation has a particularly important boundary: a row attributed to a human may have been written by an agent. Notification publication therefore requires authenticated human intent; raw persistence only reconciles references. Preserve this during extraction. An app must not infer authority to notify or start an agent from an author field.

The latest Email Stage 1 checkpoint says Stage 2 is paused; the separate Stage 2 plan says in progress and Stage 2 code exists. This is a status-ledger inconsistency, not evidence that the work is complete. The robust conclusion is that Stage 1 acceptance remains open and broader mail functionality has development artifacts. Recipient-body equality, accepted response-loss handling without resend, second-account isolation/revocation, complete conversation/deletion behavior and final device evidence remain in the checkpoint. Do not turn delivered mail into a full Gmail/Outlook replacement claim.

Related local plans: [native mentions](../plans/2026-10-02-universal-native-mentions.md), [Fast Inbox](../plans/2026-10-02-fast-inbox-triage.md), [open-work remediation](../plans/2026-10-02-open-work-remediation-plan.md), [Email execution](../plans/2026-09-30-email-launch-execution-plan.md).

## Options and recommended sequence

| Option | What it achieves | Decision |
| --- | --- | --- |
| Four primary destinations with optional native feature packages | Fast product simplification, preserves existing storage and callers. Still shares host release/build. | Useful first milestone; label it honestly. |
| Installed apps over a shared, versioned platform | Independent authoring and releases, shared authority/resources and coherent user experience. | Recommended target. Extend the current platform incrementally. |
| Immediate separate services and databases for all other features | Physical separation, but new identity, synchronization, backup and outage burdens before interfaces are mature. | Avoid as the default. Use an external engine where a concrete product needs it. |

Suggested delivery order:

1. **Agree the boundary and baseline.** Record four product surfaces plus retained platform services. Freeze exact candidate provenance, migration ownership and a compatibility matrix. Keep core hardening on current master independent of uncertified Email scope.
2. **Make the shell optional.** Add clear app discovery/navigation and absence states. De-emphasize Notes without deleting existing content or breaking links. Retain core attention and administration. This can ship before extraction is complete.
3. **Close the minimum platform contracts.** Reconcile versions and failing gates; reuse the resource v2 identity; settle authorized contribution, durable document ownership and editor interfaces. Certify outside-monorepo packaging and actual upgrade/restore behavior.
4. **Make CRM a clean independent installation.** Prove adoption of populated existing records. This is the least risky distribution and lifecycle rehearsal, not proof of a rich editor platform.
5. **Use Documents as the second substantial consumer.** First prove create, save/reopen, private and shared permissions, file access, task linkage, authorized search, agent access and revocation through public interfaces. Then complete collaboration and product depth against the same architecture.
6. **Extract Calendar after the shared seams hold.** Move event/ICS ownership, jobs and consumers while retaining task due-date functionality. Begin with existing supported native/ICS behavior; broad Google/Outlook bidirectional sync is additional product scope.
7. **Move optional analytics and clean up compatibility.** Rich people/team/manager experiences can follow. Remove native paths only after data, references and supported clients have migrated and release evidence is complete.

The core hardening lane, mentions and Inbox can progress alongside this sequence with agreed shared-file ownership. There should be one integrator for public contracts, authorization, schema and upgrade numbering. This report recommends coordination; it does not alter existing tasks or their authorization.

## Time and staffing estimate

These estimates are judgment from the inspected work, not a forecast derived from commit counts. One engineer-week is a focused week from an experienced engineer responsible for implementation, review and useful validation. Agent assistance is assumed, but three running agents are not three independent engineer-equivalents: contracts, schema changes, external credentials, browser checks and final integration serialize work.

| Outcome | Estimated elapsed time with two experienced engineers | What the estimate does and does not include |
| --- | --- | --- |
| Four core navigation surfaces | 1–2 weeks | Optional navigation and safe existing access. Backend products still exist. |
| First packaging milestone | 3–6 weeks | Shell plus CRM installation/adoption, using existing contracts. No deep Documents claim. |
| Useful Documents app pilot | 6–10 weeks, potentially 10–14 if platform repair expands | Minimum accepted platform seams, reused editor, durable single-writer documents, permissions, history, task/search/agent participation and a migration rehearsal. Not full coediting parity. |
| Four-surface core with deep Documents and Calendar extraction | 4–7 months | Shared platform closure, collaborative document product, existing Calendar/ICS ownership, optional specialized surfaces, migration and operational certification. No general marketplace or office-suite parity. |
| Same full program with one accountable engineer plus agents | Approximately 7–12 months | Roughly 25–45 engineering-weeks of scope plus sequential integration and operational constraints. Concurrent unrelated priorities extend elapsed time. |

The broader program estimate is consistent with approximately 25–45 engineering-weeks, including ordinary testing and integration. Do not add every row above: they are cumulative outcome scenarios. Do not add the following component estimates mechanically either; platform closure includes interfaces consumed by later work, and some migration/certification effort overlaps.

Component checks from the specialist audit: minimum platform closure 6–10 engineer-weeks; a Documents pilot 4–7 additional; a collaborative Documents product 10–16 additional total instead of the pilot-only scope; Calendar presentation extraction 2–4, or actual domain ownership and data migration 5–8. CRM adoption, shell work, optional analytics and whole-release migration tests account for additional breadth. The independent core audit found a similar 25–48 engineer-week range starting from merged master.

A faster outcome is plausible if the current Platform candidate passes its remaining gates largely intact and the initial Documents scope remains bounded. A slower outcome is plausible if rich app isolation must be redesigned, shared ACLs or concurrency need a different storage model, live provider evidence remains blocked, or “everything external” requires separate databases and deployments. Treat full-program uncertainty as roughly plus or minus 50 percent until the first outside-authored Documents workflow passes.

The existing Email launch is a parallel product commitment, not automatically completed by this program. Full Gmail/Outlook replacement, Office-compatible import/export, offline-first documents, public guest collaboration and a marketplace need separate estimates. If the same two engineers must also finish those, the calendar range increases.

Recommended first checkpoint: spend 5–10 working days with a platform owner and an app owner on a bounded spike and integration decision. Produce a frozen candidate matrix, one durable private document with save/reopen and revoked access, a tested editor-host choice, a migration fixture, and an updated estimate. This is not a commitment to solve the full platform in that interval. If the existing bridge cannot support the editor, the checkpoint should demonstrate that limit and select the smallest alternative before broad implementation.

## Migration and failure behavior

Keep the first transition additive. Existing Notes, folders, shares, revisions, attachments, tags, team links, mentions, task references and URLs need a durable mapping to their new owner. Preserve IDs where possible; otherwise use host-owned aliases that resolve through current authorization. An alias or cached label must never grant access.

Do not keep old and new stores writable independently. Choose a bounded cutover with a short write freeze, or a proven change-log/catch-up mechanism if uninterrupted writes are necessary. Compare content and attachment hashes, revision history, ACLs and references before switching routing. Unknown shares or unsupported content require an explicit retained/exportable state rather than silent loss.

Rollback before new app writes can often restore routing. After new writes, restoring the old image is insufficient unless the old schema and API can represent them. Plan a tested reverse-compatible export/replay or a forward repair. A backup restore sacrifices later work and must be presented honestly. Use supported `pnpm db:upgrade`; do not delete old tables in the first cutover.

Disabling an app should block new sessions, writes, sync and scheduled work, and revoke held sessions. Already dispatched external actions may be irreversible or uncertain; preserve their receipts and reconciliation state. Re-enabling should not duplicate events or silently renew prior expanded authority. Export and final removal are separate operations with retained-data policy.

Core must remain useful during an app outage. Dashboard cards and search results should degrade within bounded time; private labels and previews must not outlive authorization. Task and Knowledge links can show an unavailable source while preserving provenance. Core startup must not require a healthy optional app runtime. Restoring a self-hosted workspace must cover app-owned durable state or explicitly identify it as an external backup responsibility.

## Acceptance evidence before calling the shift complete

| Gate | Required observable evidence |
| --- | --- |
| Minimal core | Fresh install without Documents, Calendar, CRM or Email still supports Chat, Tasks, Knowledge, Dashboard, attention, administration and authorized agents/MCP. No AI key is required for ordinary work. |
| Independent authoring | A clean external directory builds and installs the exact supported app/Kit artifact without private host imports or rebuilding Deft. Updating a compatible app does not require a core source edit. |
| Shared participation | App resources link to tasks, appear in authorized search/context, support references and intended attention, and contribute permitted dashboard information through the same resource identity. |
| Security | Two organizations and relevant owner/member/guest/agent/MCP roles; denied reads, forged references, scope narrowing, offboarding, held-connection revocation and no stale private previews. |
| Documents | Reliable saves and recovery; sharing and edit roles; rich content/files; versions and restore; comments; simultaneous edits/reconnect if promised; basic import/export; real desktop/mobile behavior. |
| Calendar | Existing event and ICS behavior, timezone/DST, task due dates without Calendar, reminders/meeting context, retry-safe jobs, feed tokens and app disable. Additional provider breadth is separately certified. |
| Data migration | Record/history counts, content and blob integrity, preserved ACLs and references, interrupted restart, concurrent-write strategy, and recovery before and after new writes. |
| Lifecycle and operations | Install, upgrade, disable, re-enable, export and supported removal; compatible backup/restore; app outage isolation; exact host/Kit/app/schema evidence. |
| Release | Required checks execute on the integrated candidate with mandatory database cases enabled. Current-image browser, upgrade and restore evidence is distinct from old CI or seeded demos. |

No new benchmark supports a scale claim. Before committing to production limits, test a declared small-team fixture and a materially larger document/calendar corpus for save latency, authorized search, reference resolution, queue backlog and app outage behavior. The target sizes and acceptable response times belong in the spike's acceptance contract, not in retrospective marketing claims.

## Recommendation and limits of this review

Adopt the four-surface product boundary and the installed-app destination. Preserve the shared platform and current successful core work. Begin with a short boundary/contract spike and an optional shell milestone, then make Documents the second real consumer after Email-driven platform work. Use Calendar as the next ownership extraction rather than moving every surface simultaneously.

This assessment freshly inspected GitHub PR/release/check state, local source and worktree state, relevant plans, and seven Codex chat histories. The source probes from the other audit are attributed to that audit; this review did not independently rerun them. No full test suite, live provider operation, database migration, deployment, browser workflow, performance benchmark or recovery rehearsal was performed here. Existing tests and historical passes describe evidence to reuse or rerun; they do not certify the proposed architecture.

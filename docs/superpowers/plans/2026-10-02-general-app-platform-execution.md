# Deft general app platform feasibility and execution plan

Prepared October 2, 2026 for the proposed Deft architecture shift. Status: proposed execution plan; no implementation, migration, deployment, or instruction to another chat has been performed.

The objective is a general App Authoring Kit platform that lets independently built apps extend Deft. Chat, Tasks, Knowledge, and Dashboard remain the core product. Documents, Calendar, Email, CRM, and future specialist products use the platform. This clarifies the sequencing in the [earlier architecture audit](../audits/2026-10-02-core-and-apps-architecture-feasibility.md): platform completion comes first; a finished Documents product is a subsequent consumer.

The direction is feasible. Much of the package, permission, execution, runtime, and synchronization foundation already exists in development. The largest unresolved work is durable shared app resources, custom app interfaces, consistent participation in core surfaces, and certification of the integrated release. Ponytail's practical consequence is to reuse that foundation and prove a small set of general contracts with different consumers. It does not justify removing the explicitly requested generality.

## Completion criterion

An outside developer, using the released Kit and public documentation from a clean directory, can define a new resource type, implement a rich interface and governed actions, build an installable artifact, and connect it to Deft without editing or rebuilding Deft source. A workspace operator can install, authorize, update, disable, export, and remove that app through supported procedures.

Within its grants, the app can participate in authorized search and references, Chat and Tasks links, Knowledge citations, Dashboard summaries, attention, agents/MCP, and bounded scheduled or event-driven work. A compatible app upgrade must not require a host release.

Generality remains bounded by a versioned protocol. A new domain record or app action should need no host patch. A new category of host privilege, trusted native operation, or execution environment can require an explicit platform extension. An app cannot grant itself authority by inventing an action name or declaring a lower risk level.

Platform beta completion does not mean Documents, Calendar, and Email are complete products or that existing native data has been extracted. Those are later product and migration milestones.

## Evidence and feasibility

The assessment uses the preceding source and GitHub audit, three GPT-6.1 Sol investigations, seven relevant Codex chat histories, and additional targeted source reads. Current source overrides historical plans. The existing [full platform design](2026-08-29-full-surface-app-platform.md) and [delivery plan](2026-08-30-full-surface-app-platform-delivery-plan.md) already support independently authored apps and evidence-led generalization; retain their useful work rather than restart them.

GitHub master remains `94626051299decb231b48bead1144a716cd7873d`. The main local checkout is older and dirty. The newest app candidate is in `C:/tmp/deft-gate-g-integration-20260924`, based on Email PR 347 with substantial additional local work. It is not a reproducible released artifact. Its Kit package says alpha.9 while several constants and documents identify earlier versions.

| Capability | Inspected state | Platform work required |
| --- | --- | --- |
| Packaging, grants, governed runs and receipts | Present across merged code and the newer candidate | Consolidate and certify one compatible host/Kit/app/schema combination. |
| External execution | Candidate has scoped runtime sessions, leases, heartbeats, replay defenses and uncertain outcomes | Document and certify operator-provisioned runtimes; preserve host policy and revocation. |
| App resource identity | Candidate includes additive native and app-runtime references | Reuse one resolver with live owner authorization across all consumers. |
| Durable shared app data | Declarative Module records exist; private sync and temporary state are narrower | Add the missing shared resource and access contract; define authoritative owner, revisions, export and recovery. |
| Custom rich interface | Candidate uses an isolated hidden Worker that emits a closed host-rendered grammar | Add one supported isolated visible UI path capable of running an app-owned editor or canvas. |
| Generic content and actions | Some exported interfaces retain mail-specific requirements and conservative external-write policy | Separate generic envelopes from domain payloads; preserve host-controlled action classification. |
| Core participation | Native references and attention work are underway; dashboard components remain statically registered | Support bounded installed-app contributions over the shared resource identity. |
| Sync, automation and public ingress | Substantial bounded implementations and templates exist in the candidate | Prove composition, retries, revocation and limits across consumers; do not build a second engine. |
| App lifecycle | Destructive uninstall remains blocked pending retention/export behavior | Complete documented data ownership, export, upgrade, disable and removal behavior. |

Specific source constraints explain why packaging alone is insufficient:

- [Private state](C:/tmp/deft-gate-g-integration-20260924/packages/app-kit/src/private-state.ts:5) allows 16 KiB per record and at most 30 days of retention. It cannot serve as permanent collaborative document storage.
- [Resource synchronization](C:/tmp/deft-gate-g-integration-20260924/packages/app-kit/src/resource-sync.ts) currently declares owner-private visibility. Adding a shared resource type requires authorization semantics beyond a string in a manifest.
- [Experience content](C:/tmp/deft-gate-g-integration-20260924/packages/app-kit/src/experience-sdk.ts:14) requires account and sender metadata. A generic document should not invent an email identity.
- [The experience bridge](C:/tmp/deft-gate-g-integration-20260924/apps/web/src/lib/app-experience-bridge.ts) constrains messages and rendered nodes. A Worker cannot mount its own DOM editor.
- [Runtime authoring](C:/tmp/deft-gate-g-integration-20260924/packages/app-kit/src/runtime-authoring.ts) supports bounded scalar schemas and host-controlled conservative execution policy. Extend only the input/output shapes concrete consumers require; do not replace validated contracts with arbitrary JSON or app-asserted safety.
- [Native authoring](C:/tmp/deft-gate-g-integration-20260924/packages/app-kit/src/native-authoring.ts) currently exposes specific Calendar operations. A generic integration story must document which core actions are actually supported and route each through its existing owner service.
- [Connection adapters](C:/tmp/deft-gate-g-integration-20260924/apps/api/src/lib/app-connection-registry.ts) are operator-configured trusted code. An installable app artifact must not silently become trusted API code.

These are development findings, not demonstrated release failures. No new test run or production-scale benchmark was performed for this plan.

## Architecture decision

| Option | Cost and capability | Decision |
| --- | --- | --- |
| Expand declarative records and host-rendered forms only | Smallest incremental work; useful for CRM and workflow apps, but custom editors and canvases repeatedly need host changes | Keep as the easy authoring path; insufficient as the whole platform. |
| Declarative apps plus isolated custom UI and external runtimes | Reuses existing governance and operations while allowing genuinely different products; needs explicit resource and session boundaries | Recommended general platform. |
| Load arbitrary app packages into trusted Next.js or API processes | Appears flexible but couples dependency, code execution, security and host release lifecycle | Reject for installed apps. Operator-maintained trusted adapters remain an explicit separate mechanism. |

Keep one Deft platform implementation using the existing API, Postgres, workers, resource resolver and governance services. Resource, Experience, Runtime and App Run are logical contracts, not a requirement to create separate microservices. Declarative apps should work without a separate runtime. Apps needing provider access, custom computation or a specialized engine can use an operator-provisioned runtime.

The platform retains identity, organizations, membership, permissions, file custody, attention, approvals, receipts, agent/MCP access and installation management. These services support the four core destinations and optional apps. External does not require a separate database or a third-party SaaS subscription.

## Smallest sufficient platform contracts

| Contract | Required behavior | Reuse and limit |
| --- | --- | --- |
| Package and installation | Versioned manifest, bounded declarations, grants, compatibility checks, upgrade and disable | Extend the Kit and installer; no new marketplace or package manager. |
| Resource and access | Stable references, typed bounded content, revisions, files, read/edit authority, lifecycle and authorized discovery | Extend the existing resolver and resource owners; no competing reference registry or policy language. |
| Experience | Declarative views plus one isolated custom interface, scoped resource/action bridge and host-controlled navigation | Retain current simple UI path; add the missing isolation boundary once. |
| Capability and execution | Declared app verbs, validated inputs, actor-aware policy, approvals where required, durable outcomes and safe reconciliation | Retain App Runs and owner services. Human editing uses authorized revision-aware mutations. |
| Participation and lifecycle | Search/context projections, references, attention, summaries, bounded events/schedules, sync, ingress, export and recovery | Compose existing facilities; add only contributions consumed by the proof apps. |

For durable data, use existing Module storage where its semantics fit. For custom runtime-owned resources, define one registration and authorization contract with private, organization, and explicit member/group access as justified by the shared-app proof. Start with concrete read/edit permissions, not an arbitrary ACL scripting language. The owner remains authoritative; host projections carry only permitted searchable or displayable content and must not independently widen access.

Specialized persistence, rich document content, collaborative editing algorithms, spreadsheet calculation and media processing remain app responsibilities. Deft supplies scoped identity, authorization, resource links, lifecycle and integration. A collaborative engine can reuse an established library; building a general collaboration engine into Deft is not required to deliver the platform.

For custom UI, spike an opaque sandboxed frame and a separately hosted cookieless origin against the actual editor, static bundle delivery, CSP, browser restrictions and self-host configuration. Select the smallest option that passes isolation and usability evidence. Keep host cookies and provider credentials out of app code. The host validates every message and resource/action request; an iframe origin check alone is insufficient authorization. The decision must be demonstrated before promising arbitrary rich apps.

Allow bounded dashboard summaries and links first. An arbitrary dashboard widget SDK is unnecessary if summaries and opening the app cover the consumers. Similarly, expose concrete core capabilities through their existing services rather than creating a universal database access API.

## Trust and data flow

An installation declares requested access; an authorized workspace actor grants it. Opening an app issues a short-lived session tied to the actor, organization, installation, audience and allowed operations. The session may narrow existing access; it cannot manufacture membership or ownership.

A read resolves the stable resource reference and checks current owner authority. Search, Dashboard, agents and mentions use that same boundary. A cached projection or label cannot become an alternate authorization path. Revocation must cover open sessions, cached private previews, scheduled work and subscriptions.

A normal human save validates actor access, content shape and expected revision, then records the mutation through the owner. Governed agent actions and external effects use policy, approvals where applicable, durable run identity and receipts. Accepted-but-unknown external outcomes require reconciliation, never a blind resend. Public ingress has separately scoped claims and budgets; it does not inherit a logged-in user's authority.

Attention publication requires authenticated intent and recipient visibility. Reuse the native mentions publication model; a record attributed to a human is not proof that the human requested a notification or agent activation. Event consumers must tolerate duplicates and restarts, and recheck authorization before executing delayed actions.

## Proof apps and acceptance evidence

Use different consumers to expose real differences before freezing an abstraction. They are conformance exercises, not four simultaneous polished product launches.

| Consumer | Narrow proof | What it establishes |
| --- | --- | --- |
| Existing Contacts/CRM | Build, install, update and export existing declarative records and views from outside the host repo | Simple apps need no runtime or source changes. Preserve existing installation and resource identities. |
| Existing Email candidate | One certified private sync/read/action journey with attachments where supported, isolation, revocation and response-loss handling | External runtime, custody, private data and governed effects work without mail-only host contracts. Full mailbox product breadth is separate. |
| Thin document or canvas app | Independently packaged rich UI; durable private/shared resource; save/reopen, two actors, conflict/reconnect behavior, revoked access, task link and Dashboard summary | Custom interface and shared state work through public contracts. A full document suite is unnecessary for this proof. |
| Existing Shipping Label template | Exercise its public claim and runtime action; connect a bounded scheduled/event journey using supported contracts | Public ingress and background execution compose safely. Extend the existing fixture instead of creating another product. |

Run these through the published package surface from clean author directories, with no private host imports. Test the same API that authors call. Verify two organizations, owner/member/denied actor, human/agent policy, forged references, scope narrowing, duplicate delivery, offboarding, app outage and active-session revocation.

Before calling beta complete, demonstrate fresh installation and supported upgrade, application update without host rebuild, backup/restore including app-owned state, export/re-enable/removal, and the supported self-host deployment. Inspect representative desktop/mobile and keyboard behavior for both UI paths. Agree on explicit small-team and larger-corpus performance targets during the first checkpoint; no current evidence supports a scale claim.

## Execution sequence and effort

Estimates below are engineering effort for a general platform beta, including integration, review, documentation and conformance. They assume the existing candidate can be retained substantially and two experienced engineers have sustained availability with security and UI review support. They are judgment estimates, not measurements of agent throughput.

| Phase | Deliverable and exit evidence | Dependency | Engineer weeks |
| --- | --- | --- | --- |
| 0 Establish the candidate and resolve the two hardest choices | Curate a reproducible source snapshot; align versions; map remaining gates; demonstrate shared-resource and rich-UI feasibility; define supported app classes and limits | Start | 1–2 |
| 1 Stabilize the existing foundation | Host/Kit/schema matrix, required checks on the integrated candidate, packed outside-consumer install, runtime/revocation/uncertain-outcome regression evidence | Phase 0 | 3–5 |
| 2 Generalize resource ownership and participation | Remove required mail metadata; durable shared resource/ACL/revision path; authorized search/references/attention; bounded Dashboard and core action contributions | Phase 0 contract decision; integrate with Phase 1 | 4–6 |
| 3 Deliver isolated custom interfaces | Real app-owned editor/canvas through one supported UI path; scoped bridge, files, navigation and held-session revocation; self-host and device evidence | Phase 0 isolation choice; resource interfaces from Phase 2 | 3–5 |
| 4 Close background and public composition | Existing sync, schedule/event, ingress and runtime facilities operate together with bounded permissions, retry semantics and outage behavior | Stable resource/action contracts | 2–4 |
| 5 Certify the author and operator experience | All proof consumers work from clean directories against one candidate; lifecycle/export/restore; usable author/operator docs and honest support matrix | Phases 1–4 | 3–5 |
| Total | General platform beta, excluding finished specialist products and native extraction | Some work can overlap | 16–27 |

Allow approximately **10–18 elapsed weeks with two experienced engineers**, including integration and review slack. For **one engineer using agents**, plan roughly **4–7 months**. Agents can parallelize inspection, bounded implementation and checks; they do not remove integration ownership, provider evidence or security review. Re-estimate after Phase 0; uncertainty is roughly plus or minus 50 percent until those feasibility demonstrations and the candidate audit pass.

The earlier 25–45 engineer-week estimate covered a broader extraction program with deep Documents and Calendar work. This estimate has a different completion criterion. Do not present a platform beta as completion of that earlier program, or add the estimates mechanically because some work overlaps.

The critical path is reproducible candidate → resource/authority decisions → custom UI integration → outside-author and lifecycle proof. Resource work and UI implementation can overlap after their interface is agreed. Release preparation should run throughout; final certification is one consolidated candidate pass rather than repeated certification of changing branches.

The first checkpoint is **5–10 working days**. Deliver a pinned candidate, an outside-built thin app demonstrating the resource and UI boundary or a reproducible blocker, an agreed compatibility matrix and a revised estimate. This checkpoint is not a promise to finish both missing subsystems. If the current approach fails, record exactly which boundary needs redesign before expanding implementation.

## Coordination with ongoing work

Do not stop all other work. Assign one platform contract owner and one integration owner; one person may hold both roles at the start. Coordinate resource references, authorization, package exports, schema migrations, attention and public APIs before concurrent changes land. Avoid multiple chats inventing alternate versions of the same contract.

| Work | Recommended treatment |
| --- | --- |
| Platform PRs 345 and 346 and local candidate | Make these the primary foundation. Preserve local work, separate completed generic capabilities from product breadth, and obtain checks on the integrated candidate. Do not reset or merge the entire stack merely to simplify planning. |
| Email PR 347 | Continue the bounded platform proof and reliability gates. Defer additional mail product breadth if it draws the same engineers away from platform completion. |
| Universal Tagging | Continue and coordinate resource/attention interfaces. Native mentions now has draft [PR 352](https://github.com/Maneek21/Deft/pull/352), superseding the earlier audit's no-PR snapshot. Reuse its publication and identity work. |
| Fast Inbox | Continue shared attention and guarded triage work with compatible contracts. Pending approvals must retain their independent lifecycle. |
| Core security and reliability remediation | Continue. Moving products out does not repair existing authorization, JWT, startup or disclosure defects. |
| New native specialist features or a separate plugin architecture | Defer until the platform contracts settle. Build subsequent domain features as apps. |
| Existing merged Hearthcore work | Retain; no need to revisit completed work for this shift. |

GitHub was refreshed during this reassessment: open PRs are 345, 346, 347, 348, 349 and 352. The earlier audit records CI results for the then-current heads; this plan does not claim a new test pass. Stacked PRs 346 and 347 lack ordinary PR checks because their bases are outside the workflow's master/main filter. Fix the evidence gap for the integrated candidate before release.

These are proposed coordination rules. No other chat has been paused, redirected or messaged.

## Migration and reversibility

Start additively. Existing native Notes, Calendar, URLs and data remain readable and functional while the general platform is certified. Keep the existing reference versions and owner services compatible; use supported schema upgrade procedures. Agree migration numbering with native mentions rather than allowing parallel manifest collisions.

An app outage must not prevent core startup or ordinary Chat, Tasks, Knowledge and Dashboard use. Optional contributions should time out predictably. Retain provenance for unavailable app resources without exposing stale private labels. Disable blocks new sessions and work, revokes held authority, and preserves existing receipts, data and uncertain outcomes. Export and final deletion are separate lifecycle actions.

For runtime-owned data, the app must declare and demonstrate backup/export responsibilities. A Deft database backup alone cannot claim to restore an external app's store. Upgrade compatibility and restore must be verified together. Do not claim that rolling back an image reverses data migrations or external effects.

After platform beta, migrate specialist products one at a time. Notes-to-Documents needs preserved content, history, attachments, shares and URLs, with one writable owner at cutover. Reuse the existing editor and storage where appropriate through owner interfaces. Retain old data until the migration and recovery evidence is accepted; destructive deletion is not part of the first transition.

## Deliberate deferrals

Defer marketplace commerce and billing until actual distribution needs it. Defer managed app compute until operator-provisioned runtimes are an observed adoption barrier. Defer separate databases or microservices until scale, isolation or recovery requirements justify them. Defer a workflow designer, arbitrary dashboard code, arbitrary native database access and unlimited schema languages until concrete consumers show that the bounded contracts fail.

Full Documents collaboration, Office interoperability, complete Gmail/Outlook parity, Calendar migration, offline-first behavior and public guest document collaboration require separate product scopes. Preserve their future path through the general platform; do not quietly include their delivery in the beta estimate.

The next engineering action is Phase 0: consolidate the current candidate and prove independently authored shared data plus custom UI. Success gives Deft a credible path to a general platform. Failure identifies a specific redesign and changes the estimate before the team commits to migrating every product.

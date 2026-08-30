# Deft Full-Surface App Platform Plan

| Field | Value |
|---|---|
| **Status** | Phase 1 declarative alpha implemented; Phase 2 is next |
| **Date** | 2026-08-29 |
| **Baseline inspected** | `origin/master` at `e05471f1`, after native Hermes integration and cleanup |
| **North star** | A Deft user can ask Codex to build a useful application, install it into their Deft workspace, and have it participate natively in the human UI, search and knowledge, tasks and chat, Defty, employee agents, human MCP, automation, approvals, runs, receipts, and audit. |
| **First delivery principle** | Build one safe participation protocol in stages; do not turn `deft.module.json` into an arbitrary plugin runtime. |
| **Relationship to earlier work** | Supersedes the provisional App Protocol v2 implementation sequence while retaining its certified Module, Capability, App Run, and approval-boundary decisions as design input. Absorbs the useful resource-graph and solution-composition ideas from the modular work-management proposal. |

## Executive decision

Build a first-class **Deft App Platform** above the existing Module system.

- **Apps** are what users build and install.
- **Modules** remain the safest and easiest declarative resource provider.
- **Capabilities** are governed verbs.
- **Experiences** are either Deft-rendered declarations or isolated custom UI.
- **Runtimes** provide app-owned long-running or specialized computation outside Deft's trusted processes.
- **App Runs** are the execution envelope for App-defined capabilities, external-provider effects, and App work initiated through agents, MCP, automation, runtimes, sync, or public ingress. Existing native Deft/Module actions retain their current governed action/receipt path unless separately migrated. Ordinary human resource CRUD remains a directly authorized, audited Resource Service mutation.
- **Grants** determine what an installation may read, write, invoke, expose, or schedule.

Custom app code must never run inside the trusted Deft API or web process merely because a user installed an artifact. Full-surface apps participate through versioned, scoped protocols. This is less permissive than an in-process plugin system and substantially more capable than today's record-only Modules.

The plan is deliberately staged. The early phases produce valuable connected apps. The later phases add isolated custom experiences, external runtimes, synchronization, public surfaces, and specialized resources needed for full email, documents, spreadsheets, and other deep applications.

## User problem and desired outcome

Deft already supplies the common workspace substrate that most internal and vertical applications repeatedly rebuild:

- organization identity, membership, teams, and permissions;
- chat, tasks, knowledge, calendar, files, search, notifications, and realtime state;
- Defty, employee agents, and personal MCP clients;
- approvals, trust levels, audit, idempotency, and receipts;
- self-hosted installation, upgrades, and operator control.

Users should be able to build the missing domain application rather than adopt another disconnected SaaS product. A Codex-built app should reuse Deft's substrate and contribute only its domain resources, experience, actions, integrations, and workflows.

Authoring is not activation authority. Any user may author and validate a package, but the initial organization-scoped platform requires the existing authorized workspace role to stage, bind, grant, activate, upgrade, disable, or uninstall it. A future user-private installation mode may reuse the same grant algebra, but it must not be implied by the first org-scoped release.

Success is not an iframe in the sidebar that knows nothing about the workspace. Success means the installed app becomes a governed participant:

- its resources can be addressed, permission-checked, searched, linked, cited, and acted upon;
- its actions are available through the human UI, Defty, employee agents, and scoped MCP clients;
- its scheduled and event-triggered actions enter the same approval and App Run path;
- its UI inherits the Deft shell or uses a clearly isolated custom-experience boundary;
- its data and actions appear in knowledge, task, chat, activity, and receipt surfaces where authorized;
- disable, revocation, upgrade, and uninstall are predictable and recoverable.

## Current-state assessment

### Reusable foundations

The current repository already provides important parts of the substrate:

- strict, digest-pinned, declarative Module manifests and immutable versions;
- org-scoped Module installations, records, generic views, search projections, relations, saved views, audit, idempotency, receipts, and Task links;
- Module records in global search and permission-filtered agent context;
- eight frozen Module operations shared across Defty, employee MCP, and human MCP;
- outbound MCP connections with encryption, target validation, tool discovery, assignment controls, and approval-tier policy;
- agent identities, health, budgets, scopes, approvals, signed receipts, and persistent Hermes delivery state;
- a durable job queue, product-specific automation ledgers, notifications, WebSockets, files, and audit logging;
- forward-only, checksummed release upgrades through `pnpm db:upgrade`.

### Missing platform primitives

The current implementation does not yet provide:

- an actor-neutral Capability Service; outbound MCP still has two direct execution seams;
- actor-neutral Governed App Runs for capability and delegated execution sources;
- an App installation/package/grant model;
- a generic Resource Service for core, Module, and specialized providers;
- cross-provider resource relations and permission-aware search projections;
- isolated custom experiences or an app SDK;
- an app runtime protocol or scoped-credential lifecycle;
- a generic event/outbox/trigger/workflow contract;
- app synchronization cursors, conflict policy, or freshness state;
- governed public pages, forms, or webhook ingress;
- app authoring, local development, permission-diff, and conformance tooling.

### Important constraint from the self-hosted contract

Deft does not promise to provision or control every third-party runtime. The platform must support:

1. Deft-rendered declarative apps that need no separate runtime;
2. bundled, reviewed providers shipped with Deft;
3. operator-managed external runtimes registered and granted explicitly;
4. local development runtimes bound explicitly by a workspace owner.

Managed runtime hosting and a hosted marketplace remain later product choices, not prerequisites for the protocol.

## Feasibility verdict and product boundary

The current Module architecture alone does **not** fulfill the vision. It can already produce strong data-centric Tier 1 applications, but it lacks the identity, grants, execution, privacy, runtime, event, sync, public-ingress, and isolated-UI contracts required for independently authored full-surface Apps.

The proposed platform can fulfill the vision because it extends working Deft primitives rather than replacing them. It is a multi-release platform program, not a manifest revision or a single email-client project.

| User-built application | Feasible on the target architecture? | Required platform planes | Important boundary |
|---|---|---|---|
| Custom UI for an agent | Yes | App package, Resource Service, isolated Experience Host, native bindings | The frame receives no ambient Deft authority; it sees and invokes only what the current actor plus installation may access. |
| Booking and calendar invite App | Yes | Public Gateway, resources, calendar capability/connector, App Runs | Slot claims must be transactional; public callers never gain workspace access. |
| Marketing automation/newsletters | Yes | connected App grants, capabilities/connectors, events, schedules, App Runs | Deft governs work but does not become an SMTP deliverability vendor or silently assume legal/compliance obligations. |
| Full email client | Yes, as the Tier 3 proof | specialized Resource Provider, private ACLs, one-way remote sync, isolated UI, email capabilities, optional runtime | It needs an operator-selected provider/runtime; production-grade provider breadth, offline behavior, and deliverability remain substantial App work. |
| Broad future SaaS categories | Usually, when expressible as resources + experiences + capabilities + governed runtimes | whichever planes the App actually uses | GPU work, high-frequency collaboration, specialized storage, or provider-specific compute may remain external while still participating natively in Deft. |

“Native to Deft” therefore means shared identity, permissions, resources, knowledge/search, agents, MCP, approvals, runs, receipts, navigation, and lifecycle. It does not mean every App's code, data engine, network service, or regulated responsibility must run inside Deft core.

## Architecture options considered

### Option A: Expand Module manifests into a plugin system

Allow Modules to carry JavaScript, arbitrary UI, endpoints, secrets, workers, SQL, network destinations, triggers, and custom tools.

**Rejected.** This collapses data description, permission requests, executable code, and trusted policy into one unreviewable artifact. It makes every install a supply-chain and tenant-isolation event, couples upgrades to domain code, and makes safe self-hosting much harder.

### Option B: Load app packages directly into the Deft API and Next.js process

Provide maximum power through in-process server and UI plugins.

**Rejected for user-installed apps.** In-process code inherits Deft's database, environment, cookies, network, and process availability. A single app bug or malicious dependency could compromise the whole workspace. Trusted bundled features may still ship through the normal Deft repository and release process, but that is core development, not app installation.

### Option C: Participation protocol plus isolated experiences and runtimes

Keep the trusted Deft core small. Apps declare resources, grants, bindings, and compatibility. Declarative UI is rendered by Deft. Custom UI and specialized computation run outside the trusted process and use short-lived, scoped protocols.

**Recommended.** It has more initial platform work, but preserves reversibility, self-hostability, actor parity, and the possibility of independently authored full-surface apps.

## Product terminology

| Term | Meaning |
|---|---|
| **App** | The user-facing installed application. This is the product term. |
| **App package** | An immutable versioned `deft.app.json` artifact set staged for review and activation. |
| **App lineage** | The immutable upgrade-identity chain that may inherit one installation's grants; workspace-scoped for unsigned local Apps, portable only with verified provenance. |
| **Module** | A closed declarative provider for structured records and Deft-rendered views. |
| **Resource** | A stable, permission-checked noun that can be resolved, linked, searched, cited, and acted upon. |
| **Experience** | A human interface: either Deft-rendered declarative UI or isolated custom UI. |
| **Capability** | A typed verb such as `deft.email.send.v1` or an app-namespaced private action. |
| **Connector** | An org-owned credentialed connection to an external provider. |
| **Runtime** | An app-owned process for synchronization, specialized resources, or long-running computation. |
| **Binding** | A declarative placement of an action, command, trigger, or view against a resource context. |
| **App Run** | The durable governed execution envelope for an invocation. |
| **Grant** | The explicit effective rights approved for one app installation and version. |
| **Interface** | A versioned compatibility contract implemented or required by independently authored apps/providers. |

`Pack` may remain an internal term for an immutable resolved artifact set, but users install an **App** and review its requested permissions. The product must not make users reason about Modules, Skills, capability packs, and solution packs as competing installation units.

## Three app depths

### Tier 1: Declarative apps

Use Module resources, Deft-rendered experiences, native bindings, and optional deterministic workflows.

Examples: CRM, ATS, inventory, vendor management, leave management, content calendar, lightweight service desk.

These should be the fastest apps to create with Codex and should require no separate runtime.

### Tier 2: Connected apps

Add capabilities, connectors, sync, events, schedules, and explicit external-write grants.

Examples: marketing automation, social publishing, booking workflows, support operations, analytics imports, document signing.

### Tier 3: Full-surface apps

Add specialized resource providers, isolated custom experiences, and operator-managed runtimes.

Examples: full email client, spreadsheet, collaborative editor, Drive-like file manager, design tool, IDE-like application, specialized agent operations console.

All tiers use the same identity, resource, grant, capability, run, audit, and installation contracts. Higher tiers add privileged planes; they do not bypass the lower-level governance.

The tier is a documentation and template aid, not an author-selected trust label. Deft computes the installation's trust class from the planes and permissions actually present in the immutable package.

## Target architecture

```text
DEFT CORE
identity · orgs · ACLs · chat · tasks · knowledge · calendar · files
search · notifications · approvals · receipts · audit · jobs · realtime
agents · MCP · installation · upgrades

                         │
                         ▼

DEFT APP PARTICIPATION PROTOCOL

Resource Service     stable IDs · adapters · relations · search · citations
Experience Host      declarative views · isolated UI · host bridge · sessions
Capability Service   interfaces · providers · connector mapping · policy
App Run Service      approvals · attempts · idempotency · receipts · ancestry
Event Service        transactional outbox · subscriptions · trigger delivery
Automation Service   conditions · schedules · budgets · loops · dead letters
Runtime Service      registration · scoped claims · health · events · revocation
Sync Service         cursors · ownership · freshness · conflicts · tombstones
Public Gateway       public forms/pages · webhooks · abuse controls · consent
App Service          stage · grants · activate · upgrade · disable · uninstall

                         │
                         ▼

USER-BUILT APPS
declarative apps · connected apps · full-surface apps
```

These planes are logical deep modules and versioned contracts, not a mandate to create networked microservices. The initial implementation stays inside Deft's existing web, API, worker, database, MCP, and shared-contract packages. Add a new process boundary only for untrusted/operator-managed runtimes or when measured scale and failure isolation justify it; self-hosting must not acquire a fleet of mandatory services merely because the diagram names several responsibilities.

## Core invariants

1. Tenant and membership scope are resolved from authenticated context, never trusted from app input.
2. Installing an artifact grants nothing. Staging, review, connector/runtime binding, and activation are separate states.
3. Apps request rights; Deft and the workspace owner grant rights. Apps cannot lower approval floors or expand tokens.
4. Custom app code never receives Deft database access, environment secrets, session cookies, or unrestricted internal APIs.
5. Every App-defined capability, external-provider write, App automation/runtime/public action, and bounded sync checkpoint enters a Governed App Run. An agent or MCP client invoking an App binding uses that same Run. Existing native Deft/Module actions retain `agent_actions` and their current receipt path unless a separately certified migration is justified; ordinary human CRUD uses authorized, validated, idempotent Resource mutations.
6. Cached resource labels, search projections, provider schemas, app copy, sync data, and runtime messages are untrusted data and never authorization.
7. Authorization is rechecked at read and execution time, including after approval.
8. Existing tokens, installations, Module manifests, and actor behavior never gain new rights during an upgrade.
9. Non-idempotent unknown outcomes are never blindly retried.
10. Disabling an App immediately stops new Deft-mediated sessions, invocations, triggers, sync, and runtime claims without deleting canonical data.
11. Domain-specific logic remains in apps/providers. Deft core owns only reusable protocol and governance machinery.
12. Core workspace operation must remain useful without AI, external runtimes, or an app registry.
13. Revocation prevents future Deft-mediated access; it cannot erase data already delivered to an independently operated runtime. Installation review and operator documentation state that boundary explicitly.

Every request computes effective rights as an intersection, never as a union:

```text
current actor rights
∩ current App-installation grant
∩ caller/session/token scope
∩ resource security context
∩ employee policy, when applicable
∩ run-delegated rights, when applicable
∩ connector/capability policy floor
```

The App-installation term is mandatory for App-originated work. During a bounded migration, a closed `core` or `legacy_connector` execution origin substitutes the existing actor, assignment, token, connector, and approval policy; it never manufactures a broad pseudo-App grant or appears in the public App catalog.

An App never runs as the owner who installed it. Custom UI acts as the current human plus the App installation. Automation and external runtimes use distinct principals whose rights cannot exceed the installation grant.

## Plane 1: Resource Service

### Why it is required

Modules are currently special-cased into search, context retrieval, navigation, and Task links. Full-surface apps need the same participation without forcing email, documents, spreadsheets, and runtime objects into Module JSON.

### Resource contract

Introduce a transport-neutral `ResourceRef` and provider adapter contract. Existing IDs such as `module_record:<id>` remain valid compatibility identities.

Each Resource Provider declares versioned types and supports the applicable subset of:

- resolve one reference;
- return registered ownership/security-context facts and optionally deny an operation;
- get a minimal safe projection;
- query/search through bounded contracts;
- create, update, or archive host-certified pure canonical state through strict schemas, mutation authorization, idempotency, audit, and optimistic-concurrency preconditions;
- produce a permission-filtered context/citation projection;
- enumerate native actions and relations;
- report availability, revision, freshness, and tombstone state.

Use a small central resource registry/index for identity and routing, not a universal domain table. Domain values remain with their canonical provider. Deft stores only the metadata necessary to route, relate, search, audit, and expose freshness.

Direct Resource CRUD is allowed only for a host-certified pure canonical-state mutation with no network call or external side effect. An untrusted provider cannot self-classify an operation as pure. Sending, publishing, remote deletion/archive, or any mutation of independently operated state is a Capability and must use CapabilityService plus an App Run, even if the App presents it as “edit” or “archive.” Conformance includes a malicious-provider test that attempts to hide an external effect behind Resource `update`.

### Resource authorization and privacy

Introduce one `ResourceAuthorizationService` used by Resource APIs, relations, search, knowledge retrieval, Defty, employee MCP, human MCP, custom experiences, automation, and runtime delegation. It supports reusable security contexts rather than duplicating ad hoc ACL rows on every child object. Deft core makes the final allow decision; an external provider may contribute bounded facts or further deny access but can never widen the core result.

The initial visibility contract must include organization-visible, team-visible, user-private, explicit-share, and role-restricted resources. Field-level redaction may follow, but it is required before confidential HR or finance Apps are certified. Blobs and attachments inherit their parent resource security context and can never widen it.

Blob access is brokered: providers return opaque references, never storage credentials. Deft enforces declared and sniffed MIME, per-file/total limits, safe download disposition, CSP, and quarantine/scanning hooks where configured. Untrusted HTML, SVG, scripts, office macros, or media metadata never execute in the authenticated Deft shell merely because a Resource Provider supplied them.

This privacy plane is a prerequisite for Email Lite and other personal-data Apps. Current installation-level Module `agent_access` remains a compatibility policy, not the final App privacy model.

### Resource relations

Add typed, org-scoped relations between any registered resources. Both endpoints are resolved and authorized live. Initial adapters cover Module records and Tasks, then messages, wiki pages, notes, files, calendar events, people, teams, and specialized App resources.

Existing Module relations and Module-to-Task APIs remain through compatibility adapters. Do not migrate or reinterpret them until shadow-read/write evidence proves equivalence.

### Search and knowledge

Providers submit bounded search/context documents containing declared fields, security-context/freshness metadata, and no secrets. Search may use the projection to find candidates, but Deft must resolve the current context through `ResourceAuthorizationService`; a provider may then apply a stricter local denial before content is returned.

Agent context wraps App content as untrusted workspace data. Apps cannot inject system prompts or policy through resource descriptions.

## Plane 2: Experience Host

### Deft-rendered experience

Expand the declarative renderer incrementally with calendar, gallery, charts, dashboards, related resources, action bars, metrics, and workload views. Deft owns accessibility, theme, keyboard behavior, responsive layout, loading, errors, approvals, and notifications.

### Isolated custom experience

The first supported custom experience is an immutable, content-addressed static bundle. Deft never runs its build scripts or installs its dependencies. Before the custom-experience manifest block is frozen, the Phase 8 entry gate must choose between an opaque-origin iframe with no durable storage or a dedicated cookie-less origin isolated per installation/version with explicit quota and clearing semantics. A shared sandbox origin across Apps is forbidden. The decision must prove ordinary self-hosting, App-to-Deft and App-to-App isolation, CSP, module loading, accessibility, downloads, mobile behavior, and revocation. Declarative App v0 rejects custom-experience fields, so this spike does not block its package or lifecycle milestone.

Whichever transport wins must provide:

- immutable JS/CSS/assets pinned to the active App-version digest;
- a restrictive iframe sandbox, Permissions Policy, and per-route Content Security Policy rooted at `default-src 'none'`, with only digest-bound asset sources explicitly reopened;
- `connect-src 'none'`, `form-action 'none'`, `object-src 'none'`, `base-uri 'none'`, restrictive navigation/frame policy, and tests blocking image, CSS, font, media, form, ping, preload, and navigation exfiltration—not only `fetch`;
- no Deft cookies, reusable bearer token, database connection, server environment, shared storage authority, parent DOM access, or general proxy;
- no browser network egress by default; external effects use declared Capabilities/Connectors;
- no provider/resource-supplied active HTML in the bridge-capable document; use safe text/DOM rendering or a nested opaque sandbox with no host bridge for rich external content;
- a nonce-bound, versioned, closed, Zod-validated `MessageChannel` bridge tied to the exact frame and App installation/version;
- brokered host operations for authorized resource get/query, binding invocation, App Run status, navigation, theme, resource/file pickers, dialogs, and notifications;
- bounded messages, response schemas, cancellation, rate limits, and flood protection;
- immediate revocation on App disable, membership loss, grant change, version switch, or session expiry.

The browser SDK wraps the bridge; it does not hand the iframe a reusable workspace credential. Remote mutable experience URLs and unrestricted browser egress are deferred until immutable bundles have proven the isolation contract.

The App shell must visually retain Deft navigation, App identity, trust class, and a clear way to exit. The installed Next.js version requires CSP behavior to be verified against its local documentation. Dynamic per-App CSP must be limited to App host routes so the rest of Deft does not unnecessarily lose static optimization.

## Plane 3: Capability Service and App Runs

### Capability identity

Support two interface classes:

1. **Standard interfaces**, such as `deft.email.send.v1`, reviewed for interoperability and carrying a Deft-owned minimum approval floor.
2. **App-private interfaces**, namespaced to publisher + App + capability-contract version, such as `com.example.marketing.email_send.v1`, and available only to explicitly granted installations. The implementing App-version/provider snapshot is pinned separately so a routine App release does not churn capability identity or grants.

Verified publisher identity may provide the publisher namespace. Until signed provenance exists, the canonical private-interface identity uses a workspace-scoped immutable App lineage ID rather than trusting the package's claimed publisher string. The claimed name remains display metadata only.

An App may declare the schema and description of a private capability, but that declaration is untrusted and cannot set effective risk, data-egress class, approval floor/scope, retry or idempotency policy, automation eligibility, token scope, or grants. A new private external-effect capability defaults to `review_requirement: always`, `review_scope: per_invocation`, unsafe/unknown idempotency, no automatic retry, and forbidden automation. It remains disabled until an owner/admin binds a registered provider and explicitly accepts a Deft-owned classification with a meaningful bounded approval preview. Repeated compatible private interfaces may later be promoted into standard interfaces.

The current numeric approval tier is insufficient because Autonomous employees can execute ordinary full-tier actions. Add a Deft-owned orthogonal policy dimension such as `review_requirement: policy | always`, a risk class such as `internal_write`, `external_write`, `destructive`, or `privileged`, and a host-owned review scope: `per_invocation`, `immutable_batch`, `approved_automation_definition`, or `forbidden_in_automation`. An actor's trust may satisfy `policy`; it can never bypass `always`. A broader review scope satisfies `always` only through an explicit immutable approval that pins inputs/query version, connector/provider, limits, validity window, and current authorization-version vector.

This replaces the indefinitely closed interface union from the first App Protocol proof while preserving its safe bootstrap behavior.

### Provider model

Outbound MCP is the first provider adapter. Bundled providers and registered App runtimes may implement the same interfaces later. Provider discovery metadata never defines policy. Invocation rechecks the live connector/runtime, mapping, grant, actor, schema digest, and assignment.

`CapabilityService.invoke` becomes the sole production provider-call seam.

### App Run model

Every invocation creates or attaches to one actor-neutral App Run containing:

- a closed execution origin: App installation/version and binding identity, `core`, or `legacy_connector`;
- initiating actor and execution actor;
- resource context and effective grant/policy snapshot where applicable;
- capability/interface/provider snapshots;
- encrypted canonical input, domain-separated keyed fingerprint, and encryption/fingerprint-key versions;
- a domain-separated keyed caller-idempotency fingerprint;
- approval link, attempts, events, result summary, receipts, and ancestry;
- explicit `unknown_outcome` handling for non-idempotent external effects.

The snapshot is the minimum executable input, not an unrestricted copy of every source resource. Prefer pinned ResourceRefs, revisions, digests, and bounded argument fields; copy sensitive content only when the exact external effect cannot be reproduced safely from an immutable revision. Enforce per-interface and global size limits. Large payloads use an encrypted blob reference with the same org/security context and retention policy rather than an oversized database row.

Child Runs inherit ancestry, the remaining parent budgets, authorization versions, and a bounded maximum depth; they cannot reset limits or synchronously recurse through an ancestor binding/interface. Cycles fail before another provider call.

Artifact/content integrity continues to use ordinary SHA-256. Sensitive Run-input and caller-idempotency fingerprints use a dedicated versioned secret and domain separation so low-entropy values cannot be guessed from a leaked database. Fingerprint keys are distinct from encryption and receipt-signing keys, remain available for the supported replay/verification window, and are included in backup/restore. Replay lookup checks the current and retained fingerprint-key versions; idempotency-row expiry and old-key retirement are one coordinated policy.

`agent_actions` may remain the current approval-inbox adapter, but App Runs are the execution source of truth. State transitions and approval linkage must be transactional so the two ledgers cannot silently drift.

This source-of-truth rule applies to App/capability Runs. It does not declare every pre-existing native Deft action to be an App Run. The structural extraction first wraps the two outbound MCP provider seams; broader native-action convergence is optional later work with its own compatibility proof.

During migration, only the closed `core` and `legacy_connector` origins may omit an App installation/resource context. They persist `grant_source: legacy_connection_policy` plus the exact actor, assignment, token scope, connector, and approval-policy snapshot used by today's path. They are not discoverable or invokable through the App catalog. App installation, binding, resource context, and append-only grant snapshot become mandatory for App-originated calls in Phase 5, after which every remaining legacy origin must be enumerated before the compatibility path can be removed.

The current encryption helper needs a versioned Secret Service before durable App Run inputs are stored. Use authenticated encryption with a random nonce and AAD bound to org, record type, record ID, field, and key version. The encryption keyring supports one current write key plus previous decrypt-only keys during rotation. Ciphertext must be excluded from generic ORM selections, logs, traces, API responses, approval previews, events, and receipts.

Run input retention is explicit and reviewable. After the approved retention window, purge ciphertext/blobs through a one-way audited terminal transition while retaining only non-sensitive state, keyed fingerprints, key/version metadata, and sanitized receipts needed for audit. Immutability prevents replacing executable input before purge; purge may only clear it. Retention widening requires a permission diff and fresh approval; legal holds, if ever supported, are an operator policy rather than an App-controlled flag.

Receipt signing is a separate key lifecycle, never a reuse of the encryption key. Each receipt records signing algorithm and key version; old verify-only keys remain available for historical verification. Encryption and signing keyrings, versions, and restore procedure are part of the operator backup contract.

## Plane 4: Events and automation

Introduce a versioned App event envelope delivered through a transactional outbox:

- org, App installation/version, actor, resource reference, event name/version;
- changed field names or safe summaries, not unrestricted sensitive values;
- causation, correlation, ancestry, and idempotency identifiers;
- timestamp, sequence, and permission-context reference.

Apps may request subscriptions during staging. Activation must show each trigger and default it off unless the user explicitly enables it.

Automation runs as a distinct, non-admin principal; it never permanently inherits the creator's session or the installing owner's authority. Delivery of an event confers no read or action right by itself. Each trigger resolves the current installation grant, automation policy, resource security context, relevant authorization versions, and capability review floor before creating its App Run.

Unattended work is permitted only when the capability's host-owned classification allows `approved_automation_definition` and a human has approved an immutable bounded definition. For a campaign that approval pins the audience or query revision, content/template digest, connector/provider, schedule, volume/action/cost limits, validity window, and authorization-version vector. Each child send still receives its own idempotent App Run and receipt. Private external-effect capabilities remain `forbidden_in_automation` until explicitly classified; employee trust alone never authorizes unattended execution.

The deterministic automation engine supports bounded triggers, conditions, and actions. It includes:

- record and relation events;
- task, approval, message, file, calendar, and App Run events;
- schedules and signed webhook events;
- explicit schedule timezone, daylight-saving behavior, missed-run/catch-up policy, and unique fire claims;
- concurrency limits, rate/action/cost budgets, loop detection, retries, and dead letters;
- simulation against redacted/sample data before activation;
- pause, resume, inspection, and kill switches;
- immutable workflow definitions pinned to an App version, with durable step/wait state, bounded branching, cancellation, and per-step App Run ancestry;
- one App Run per externally meaningful action with complete ancestry.

Arbitrary compensation code is not promised initially; reversals are explicit reviewed capabilities. There must not be a separate less-governed cron or runtime action path.

## Plane 5: Connectors and synchronization

Connectors remain org-owned credential stores. Apps request connector kinds or standard interfaces and bind only an existing compatible connector selected during activation. Apps never receive raw credentials.

### Credential ownership modes

An external integration must use one declared mode:

1. **Deft-held connector:** Deft stores the provider credential and a bundled/MCP provider adapter executes the capability. The App/runtime receives only validated results.
2. **Connector-backed delegated capability:** a runtime with a live Run claim invokes a narrow declared capability; Deft executes it through CapabilityService as a child Run. This is not a generic credential or network proxy.
3. **Runtime-owned credential:** the operator configures the downstream credential outside Deft and binds an opaque runtime connection reference. Deft can revoke future claims and bindings, but cannot rotate, erase, or prevent independent use of a credential it never possessed. Install, health, backup, and disable UI must state that authority boundary.

A runtime connection reference is not presented as a Deft Connector and must not imply Deft credential custody. An App package cannot choose or populate a credential mode, carry a secret, or convert a Deft-held connector into runtime-owned authority. The owner/admin selects the mode and exact binding during activation. Each proof App declares which mode it uses and tests its corresponding revocation and recovery limit.

Sync contracts declare canonical ownership:

- **Deft-owned:** Deft resource is canonical and changes are pushed outward.
- **Remote-owned:** external resource is canonical and Deft exposes a permission-filtered projection.
- **Bidirectional:** allowed only with explicit field ownership and conflict rules.

The first shipped sync mode is provider-authoritative, one-way remote-owned projection. Deft-owned push and especially bidirectional sync remain behind separate flags until per-field ownership, echo suppression, conflict UX, deletion propagation, and rollback have independent proofs.

Each provider registration declares its canonical store, data ownership, export/resync/backup capability, consistency-checkpoint contract, and restore-health check. If Deft cannot back up or restore provider-owned canonical data, the install and operator UI say so plainly instead of implying Postgres/uploads backup is sufficient.

A sync execution is a bounded App Run per page/checkpoint attempt, not one Run per imported item or one unbounded mailbox backfill. It persists cursors, checkpoints, provider schema versions, freshness, failures, rate-limit state, tombstones, and last-known authorization. Per-resource mutations have transactional audit/subreceipts; each externally meaningful outbound effect gets its own App Run attempt. A stale index or cursor never authorizes a read. Deletion, retention, and replay semantics must be defined per provider before activation.

## Plane 6: Runtime Service

Some Apps need persistent or specialized computation. Define a narrow runtime protocol for:

- registration and version binding;
- health, compatibility, and capability discovery;
- short-lived scoped credential issuance and rotation;
- start/status/events/logs/cancel/terminate where applicable;
- action, concurrency, time, data, and cost budgets;
- callback signatures, sequence numbers, replay prevention, and revocation.

Supported initial runtime modes:

1. operator-managed remote HTTPS runtime;
2. operator-managed local/container runtime explicitly enabled for self-hosting;
3. reviewed bundled provider shipped through Deft's normal release process.

Runtime endpoints are configured by an owner/admin after target validation. App artifacts cannot silently register a URL, command, image, or network destination. Deft can limit what data and APIs a remote runtime receives, but it cannot guarantee what that independently operated runtime does after receiving authorized data. The grant screen must state this trust boundary plainly.

The first external Runtime Channel should be pull-based and reuse the proven shape, not the employee-specific tables, of Hermes delivery: short-lived session credentials, claim tokens, leases, run/attempt IDs, heartbeat, cancellation, reconciliation, and replay-safe sequence numbers. Queue payloads contain IDs only. Sensitive inputs are loaded only after a live grant check, and runtime output is untrusted, bounded, and schema-validated. A runtime never receives connector secrets or installing-user impersonation.

Managed provisioning, billing, and a hosted runtime marketplace are deferred.

## Plane 7: Public Gateway

Booking pages, intake forms, unsubscribe pages, and inbound webhooks cross an unauthenticated or externally authenticated boundary. They never consume an ordinary App experience or shell session. The preferred deployment uses an operator-configured public-surface URL with separate cookie scope and DNS/TLS; ordinary self-hosting may use same-origin public routes only when public-only middleware categorically ignores ambient session cookies and never resolves an authenticated workspace actor.

Provide two modes:

- Deft-rendered public forms/pages from strict declarative schemas;
- externally hosted public experiences that submit through a scoped public endpoint.

Every public endpoint has an opaque public identifier, explicit enabled state, narrow accepted schema, payload limit, rate limit, origin policy where applicable, retention rule, abuse controls, and revocation. Sensitive submissions are encrypted or immediately transformed into a permissioned resource; they never appear in logs or public error responses.

Webhooks require signature verification over the exact raw request bytes, timestamp/replay windows, event deduplication, and asynchronous processing. An untrusted App may select only strict Deft-supplied verification profiles; provider-specific executable verification requires a reviewed bundled adapter. Otherwise the operator routes the webhook to an independently operated registered runtime, which submits a separately authenticated scoped event to Deft. The Gateway returns a generic `202 Accepted` only after a deduplicated ingress record and outbox event commit durably; a failed commit receives a generic retryable error. Public submissions create governed work later and never call App code or mutate ordinary workspace resources inline.

Booking additionally requires transactional slot claims, timezone normalization, expiry, cancellation, and duplicate protection. An accepted newsletter unsubscribe transactionally commits an authoritative suppression ledger before returning success. Send dispatch and unsubscribe serialize on the recipient/suppression version: the send transaction checks suppression and durably claims dispatch before provider invocation. If unsubscribe commits first, no later send may claim; if dispatch commits first, that one attempt may already be in flight and is recorded honestly. Unsubscribe endpoints remain functional when the authoring App UI is disabled according to an explicit retention policy.

## Plane 8: App package, grants, and lifecycle

### Package shape

`deft.app.json` is strict, versioned, canonicalized, and digest-pinned. It may declare:

- App identity, display metadata, license, protocol compatibility, and provenance;
- included or required Modules and resource interfaces;
- declarative/custom Experience requirements;
- capability interfaces and connector requirements;
- native actions, commands, views, and trigger bindings;
- runtime and public-surface requirements;
- requested resource access, scopes, automation budgets, and retention classes;
- immutable artifact digests and dependency constraints.

It may not carry secrets, effective grants, approval overrides, trust changes, raw SQL, Deft process imports, arbitrary commands, or an automatically trusted runtime, sandbox origin, or public endpoint.

App-owned route, navigation, binding, command, resource-type, and private-interface machine keys use a strict ASCII-lowercase grammar and are canonicalized under the verified lineage/installation namespace. Display labels are untrusted metadata and may be localized. An artifact cannot shadow a reserved core route/tool/command or claim a standard interface by choosing a lookalike identifier.

The first installation creates or adopts an immutable App lineage and records its upgrade authority. An unsigned artifact from another lineage cannot replace that installation, claim its private-interface identity, or inherit its grants, connector mappings, data, or public endpoints. It stages as a distinct App unless an owner explicitly performs a reviewed fork/migration. Publisher signatures may establish portable upgrade lineage later; a claimed publisher name never does.

The manifest is additive by host capability: an App may use only blocks implemented by its declared compatible Deft protocol version. Future-plane fields are rejected, not ignored or persisted optimistically.

Dependency resolution is deterministic and bounded: exact resolved digests are locked, cycles and ambiguous providers are rejected, depth/count/artifact-size limits apply, and installing or upgrading one App never implicitly upgrades another active App. Shared dependencies are reference-counted by ownership rather than silently duplicated or cascade-deleted.

### Installation lifecycle

1. **Inspect:** parse and show trust class and provenance without writing active state.
2. **Stage:** resolve immutable artifacts and dependencies transactionally; grant nothing.
3. **Review:** show resources, actions, connectors, experience isolation, runtime/public endpoints, triggers, retention, and requested versus effective rights.
4. **Bind:** owner/admin selects existing connectors, operator-administered runtime/public endpoints, and storage/retention choices.
5. **Activate:** atomically install approved dependencies, write append-only grant snapshot, enable bindings, and switch the active version pointer.
6. **Operate:** surface health, freshness, App Runs, errors, budgets, and receipts.
7. **Upgrade:** stage the next version, compute artifact and permission diffs, and require fresh confirmation for widening.
8. **Disable:** revoke sessions/tokens/triggers/sync/invocations immediately while preserving data.
9. **Uninstall:** require dependency/reference review, export/retention choice, and explicit confirmation; never cascade silently.

Activation and version switching are pointer operations over immutable versions. Failed activation leaves the previous version active. Database upgrades remain forward-only and require the supported backup/restore rollback procedure.

Upgrades explicitly choose a drain or supersede policy for pending Runs, workflows, sync checkpoints, and public submissions. A pending Run remains pinned to its immutable App/interface/provider snapshots and is never rebound silently to the new version, but approval/execution still intersects the current active grant, mapping, authorization versions, and schema compatibility. Removed or narrowed behavior expires/cancels safely; externally accepted work that cannot be reconciled becomes `unknown_outcome`. Old artifacts remain retained while Runs, receipts, dependencies, or rollback policy reference them.

App-version activation is not authority to run author-supplied data migrations. Initial Module evolution uses the existing safe upgrade contract: revalidate every record, relation, saved view, and search projection against a strictly newer immutable manifest, then switch atomically only if all data remains compatible. Field rename/backfill/type transforms require an explicit export/import or a future reviewed declarative migration protocol with preview, idempotency, backup, and rollback evidence. Specialized providers own their internal migrations and must report compatibility/recovery health; Deft never executes their migration scripts in-process.

Rollback has three distinct meanings. A failed or unused staged activation can return to the old pointer. An App code/config version may roll back only when its resource/interface compatibility ranges still accept current data. A resource-schema downgrade after writes under the new schema is not assumed safe; it requires a proved reverse-compatible manifest, a pre-upgrade backup restore, or a forward corrective version. The UI and operator runbook must never label an unsafe schema downgrade as a simple App rollback.

Revocation uses an authorization-version vector, not one global counter. Each installation has an epoch for disable, grant, and security-sensitive version changes; each actor/membership has an authorization version for membership/role changes; each connector and runtime binding has its own epoch. Sessions, bridge messages, runtime claims, approvals, trigger deliveries, and execution attempts bind the relevant versions and still perform live checks. Removing one member therefore does not invalidate every user, while a stale claim for that member fails closed. Pending approvals are invalidated when any bound version changes; claimed work is cancelled where possible, and an external side effect that cannot be reconciled becomes `unknown_outcome` rather than silently succeeding. Required public compliance endpoints such as unsubscribe are retained only through an explicit, independently scoped policy.

### Trust classes shown during install

| Class | Contents | Default posture |
|---|---|---|
| Declarative | JSON schemas and Deft-rendered views only | Lowest execution risk; normal data grants still apply |
| Connected | Capabilities/connectors/sync/triggers | Explicit connector, action, retention, and schedule review |
| Full-surface | Isolated custom bundle and/or external runtime | Strong warning, exact bindings, no ambient browser authority, operator trust required |
| Bundled trusted | Code reviewed and shipped with Deft | Governed by Deft release, migration, and security gates rather than sideload trust |

## Plane 9: Agents, MCP, knowledge, and native equivalence

Apps do not mint arbitrary top-level MCP tool names. Deft exposes a small stable protocol catalog for:

- App discovery and schema;
- Resource list/get/query/search;
- relation list/add/remove;
- capability and binding list/invoke;
- App Run get/list/cancel where authorized.

App discovery, resource access, binding invocation, and Run inspection use new explicit scopes and token-policy mappings. Existing broad scopes such as legacy workspace-read access do not automatically include newly installed Apps or specialized resources. Old personal/OAuth tokens default to no App discovery or invocation until the owner/client explicitly reauthorizes the new scopes; compatibility mappings are exact and covered by denial tests.

The same ResourceRef, binding key, Capability Service, App Run, and receipt identity is used by the human UI, Defty, employee agents, human MCP, and automation.

Agent-visible App descriptions and data are quoted as untrusted material. App Skills may provide optional reasoning/playbooks later, but cannot grant tools, modify system policy, access secrets, or bypass a deterministic binding. Installing an App does not automatically add prompt material to every agent.

### Native-equivalence matrix

| Concern | Human UI | Defty | Employee | Human MCP | Automation |
|---|---|---|---|---|---|
| Discover active App | yes | yes | if granted | if scoped | if configured |
| Resolve/read resource | live ACL | live ACL | ACL + employee policy | ACL + token scope | run grant |
| Search/cite resource | yes | yes | yes | yes | service context |
| Invoke binding | UI action | stable tool | stable tool | protocol operation | declared binding |
| Approval | Deft UI | Deft policy | Deft policy | Deft policy | Deft policy |
| Run status | native UI | inspect/cite | inspect | inspect | persisted |
| Receipt/audit | native UI | inspect/cite | inspect | inspect | persisted |

An intentional asymmetry must be documented and tested. A one-off adapter for one App or actor surface is evidence that the protocol is incomplete.

## Authoring experience for Codex and developers

### Source project versus installed package

A source project may use ordinary TypeScript, React, Vite, tests, and Codex tooling. Deft installs only the deterministic output of `deft app build`; it never executes package scripts, runs `npm install`, or trusts an author's build environment.

```text
my-deft-app/
├── deft.app.json
├── APP_BRIEF.md
├── AGENTS.md
├── resources/
├── experience/src/
├── workflows/
├── tests/
├── fixtures/
└── deft.app.lock.json
```

The build initially emits a strict indexed JSON package envelope plus a lock containing every digest. The format enforces normalized relative paths, an allowlisted file/MIME set, no symlinks, file-count, per-file and total-size limits, immutable artifact digests, and no server-executable content. A multipart or deterministic archive format may follow only after adding traversal and compression-bomb defenses to the same baseline checks.

### CLI and SDK

Provide a versioned authoring kit:

```text
deft app init --template declarative|connected|experience
deft app dev
deft app check
deft app build
deft app test
deft app permissions diff
deft app install-local
deft app package
deft app doctor
```

Templates choose a starting shape only. `check`, the permission diff, and the installer compute the actual tier/trust class from immutable package contents; an author cannot select a lower trust label.

The kit includes:

- JSON Schemas and generated strict TypeScript types;
- manifest and permission validators;
- React/custom-experience SDK and host simulator;
- runtime SDK and signed callback helpers;
- fake connectors and deterministic App Run fixtures;
- accessibility, responsive-layout, CSP, origin, and bridge checks;
- native-equivalence conformance tests across human, Defty, employee, MCP, and automation surfaces;
- upgrade, disable, revocation, partial-failure, and unknown-outcome tests;
- templates and Codex instructions that prefer protocol primitives over domain code in Deft core.

Publish version-matched CLI, SDK, and test artifacts with each compatible Deft release so external App repositories can consume authoritative contracts without importing private monorepo packages. Developer Settings must show the exact compatible protocol/tooling version. A generated `APP_BRIEF.md` captures users, data classification, external systems, privacy, exclusions, and acceptance tests; generated `AGENTS.md` forbids direct Deft-core edits, secrets, undeclared egress, and self-granting policy.

A platform plane is not complete when only its internal host service exists. The same phase must publish its strict manifest blocks, schemas/types, permission-diff/install review, CLI/template or SDK support, local simulator/fakes, and external-repository conformance tests.

### Local development

`deft app dev` pairs with a development workspace through a browser-confirmed ephemeral developer installation. Pairing uses a distinct development principal and token audience—not MCP OAuth or an ordinary shell session token—after owner/admin confirmation and a one-time short-lived exchange. Credentials are stored outside the source project, are explicitly revocable, and the feature is disabled by default in production. The UI clearly marks development Apps. Manifest or permission changes stage a development upgrade and show a widening diff. Fixtures affect only that installation, and tests use a disposable workspace rather than real data. Production grants, connectors, or tokens are never copied automatically into local development.

`deft app install-local` shows the same permission review as a packaged install. Local source provenance is recorded honestly and cannot claim a signed publisher identity.

### Distribution

Start with local directories and immutable indexed JSON package artifacts. First install creates a workspace-scoped lineage and records the local upgrade authority; a different unsigned lineage is a different App and receives no inherited grants. Add signed Git/release artifacts and portable publisher lineage only after conformance is stable. Install-by-URL, a hosted registry, payments, reviews, automatic updates, and remote code fetching are later ecosystem work.

## Proof applications

### Proof A: Independent CRM and Marketing Apps

Two independently authored Apps interoperate without source knowledge:

- CRM provides contact-compatible resources.
- Marketing requires compatible contacts and `deft.email.send.v1`.
- Campaign references Contacts without copying them.
- Send is available through UI, Defty, employee, and human MCP.
- Approval, idempotency, App Run, sanitized send log, receipt, and failure recovery are identical across surfaces.

This proves the connected-app substrate.

### Proof B: Custom Agent Operations Console

A separately authored custom experience:

- appears inside the Deft shell;
- lists only employee agents the viewer may access;
- reads health and recent work through scoped Resource APIs;
- requests a governed action through a native binding;
- shows native approval and App Run status;
- has no Deft cookies, direct database access, or arbitrary parent bridge;
- loses access immediately when disabled or when the user loses membership.

This proves isolated custom UI without requiring a specialized data engine.

### Proof C: Booking App

- public booking page exposes bounded availability without workspace access;
- concurrent claims cannot double-book a slot;
- confirmed booking creates/updates a permissioned resource and invokes a calendar capability through an App Run;
- timezone, expiry, cancellation, idempotency, rate limiting, and public-data retention are tested;
- event appears in Deft calendar/context and is available to authorized agents/MCP clients.

This proves public ingress and workspace-native participation.

### Proof D: Scheduled Campaign and Newsletter App

**D1 — governed automation gate:**

- campaign, audience, content, schedule, and suppression resources are native;
- a human-approved immutable automation definition pins the audience/query revision, content digest, sandbox provider, schedule, validity window, and budgets;
- the schedule creates normal automation ancestry and a bounded batch of per-send App Runs/receipts against deterministic sandbox recipients;
- retries do not duplicate sends and pause/kill stops unsent work.

This proves unattended bounded automation, not yet an operational newsletter.

**D2 — public compliance and inbound gate:**

- unsubscribe and suppression remain authoritative through independently scoped public endpoints;
- accepted unsubscribe is durably present before success, and suppression versus send dispatch uses the documented serialized claim boundary;
- bounce/complaint events use a Deft-supplied or reviewed verification adapter, are deduplicated, and become visible resources/events;
- provider credentials never reach the App UI or an untrusted App artifact.

The Newsletter proof is complete only after D1 and D2 pass. Production deliverability, legal advice, and managed SMTP are not Deft core promises.

### Proof E: Email Lite full-surface App

- specialized email provider exposes mailbox, thread, message, label, and attachment resources;
- remote-owned sync has cursors, freshness, tombstones, and permission-filtered search/context;
- custom experience supports inbox, thread reading, compose, reply, archive, and search;
- hostile HTML/message/attachment fixtures cannot execute in the bridge-capable document or invoke a binding;
- authorized email can be cited or linked to Tasks/knowledge without silently copying private bodies;
- send/reply/archive use capabilities and App Runs;
- Defty, employee, and human MCP see the same resources/actions when granted;
- the App and runtime build from clean independent repositories using only published version-matched artifacts;
- the runtime runs as a separate process and is tested across restart, outage, lease expiry, disable, and recovery;
- the proof names its external credential ownership mode and demonstrates the matching rotation, revocation, backup, and operator-trust boundary;
- deterministic fake-provider conformance is followed by at least one standards-based or real-provider test adapter before the full feasibility claim;
- runtime compromise cannot gain new Deft-mediated access to other Apps or unrestricted workspace data.

This proves the architecture can host a real Tier 3 application. It is a protocol proof, not a commitment to ship a production Gmail replacement in the same milestone.

## Delivery phases

These are dependency and certification gates, not promises that each phase is one pull request, sprint, or release. Phase 3 deliberately spans compatibility releases; other phases may split structurally from behaviorally. Phases 0–5 establish the governed foundation, 6–7 deliver useful connected/automated Apps, 8–11 add privileged full-surface planes, 12 certifies the vision, and 13 is optional ecosystem work. Calendar estimates should be made only after Phase 0 freezes contracts and the first milestone is decomposed against the then-current code.

### Phase 0: Rebaseline and freeze the architecture

**Outcome:** one canonical App Platform contract aligned with post-Hermes `origin/master`.

- [x] Adopt **App** as the installed product unit and Module as a resource primitive.
- [x] Mark the earlier narrow implementation plan and modular work-management proposal as superseded where they conflict.
- [x] Preserve the certified security decisions that still apply.
- [x] Remove obsolete preview.3/branch chronology and record the actual implementation baseline immediately before work begins.
- [x] Freeze Module schema `1` against executable/self-granting fields with table-driven tests.
- [x] Define shared actor, ResourceRef, capability, grant, and error-shape terminology.
- [x] Freeze the effective-rights intersection and the distinct human, employee, automation, runtime, and public principals.
- [x] Resolve the current approval-tier contradiction with Deft-owned risk, egress, retry/idempotency, automation-eligibility, `review_requirement`, and `review_scope` contracts.
- [x] Publish an explicit SDK, template, and independently authored App licensing policy consistent with Deft's AGPL-3.0-only core before distributing authoring artifacts.
- [x] Reserve consistent disabled-by-default feature-gate names and semantics, but add each gate only with its first real route or behavior; the opening milestone adds only the Apps gate, and later planes remain absent rather than represented by unused flag code.
- [x] Record architecture and threat-model decisions before schema changes.

**Acceptance evidence:** docs agree; decision records close approval and declarative-authoring license questions; existing Module manifests/tools remain byte/behavior compatible; forbidden-key tests pass; no feature is enabled.

### Phase 1: Declarative App package and Authoring Kit alpha

**Outcome:** Codex can build, inspect, stage, activate, and disable a minimal Tier 1 App without editing Deft core.

- [x] Add the smallest strict `deft.app.json` v0: identity, compatibility, exact immutable included/App-owned Module artifacts, and declarative navigation only; do not freeze generalized resource rights before ResourceAuthorizationService exists.
- [x] Add immutable App versions/artifacts, installation states, content digests, exact Module dependency bindings, and transactional stage/activate/disable pointer operations.
- [x] Refactor Module lifecycle planning/apply internals to accept an existing database transaction so App and Module pointer changes commit once; do not compose nested independently committed lifecycle calls.
- [x] Mint a workspace-scoped immutable lineage and local upgrade authority on first install; reject cross-lineage unsigned replacement and grant inheritance.
- [x] Publish version-matched JSON Schemas, generated TypeScript types, and `deft app init`, `check`, `build`, `install-local`, and `doctor` commands outside private monorepo imports.
- [x] Produce deterministic bounded indexed JSON package output and a digest lock with path/MIME/file/total-size enforcement; never execute package scripts, dependency installation, or author-supplied server code.
- [x] Add owner/admin-confirmed ephemeral developer pairing with a distinct dev principal/audience, one-time exchange, credentials outside source, explicit revocation, and production-disabled default.
- [x] Ship a Hello Workspace reference App composed from existing Module resources and Deft-rendered views.
- [x] Reject manifest blocks for capabilities, custom experiences, runtimes, sync, automation, and public ingress until their host plane exists.

**Acceptance evidence:** a clean external project can be scaffolded, built twice to identical digests, inspected, staged with zero effective rights, activated locally, opened, and disabled; injected failure after Module preparation but before App-pointer swap commits neither change; a different unsigned lineage cannot replace it; dev credentials cannot authenticate as MCP/shell tokens; no generalized grant, new provider call, or executable-code path exists.

**Implementation evidence (2026-08-29):** the clean packed-kit authoring/install loop, API inspection, disposable-Postgres lifecycle and pairing tests, schema/upgrade parity tests, desktop/mobile UI inspection, lint, repository typecheck, and production build pass. A full fresh `db:push-full` bootstrap remains environment-gated on this Windows host because its PostgreSQL installation lacks the repository-required `vector` extension; the additive App migration and its transactional behavior were applied and tested directly on a disposable database.

### Phase 2: Capability Service extraction

**Outcome:** one deep internal provider seam exists with no visible behavior change.

- [ ] Add strict shared capability/provider/interface schemas.
- [ ] Add immutable provider discovery snapshots with tuple uniqueness and safe projections.
- [ ] Implement MCP as the first provider adapter.
- [ ] Route discovery and both direct outbound MCP execution paths through CapabilityService.
- [ ] Preserve names, payload bytes, errors, approval tiers, assignments, budgets, and connector behavior.
- [ ] Add a grep/architecture test proving only provider adapters call `mcpClientManager.executeTool`.

**Acceptance evidence:** current connector/trust tests plus new auto/reviewed parity tests pass; one provider call occurs per invocation; no UI, scope, token, receipt, or error-shape change.

### Phase 3: Governed App Runs and Secret Service

**Outcome:** every capability execution can use one actor-neutral, durable, approval-aware envelope.

- [ ] Add a versioned Secret Service with random nonces, AAD-bound ciphertext, current and decrypt-only keys, rotation, and explicit safe projections.
- [ ] Add minimum-input rules, strict Run payload/blob limits, retention classes, terminal-state purge, and sanitized audit residue; permission widening cannot silently extend retention.
- [ ] Stage encryption compatibility across releases: add legacy+v2 dual-read while retaining legacy writes, require the rollback-floor image to read v2 before enabling v2 writes, avoid in-place connector re-encryption during that window, then retire legacy only after tested backup/restore.
- [ ] Add separate versioned receipt-signing and input/idempotency-fingerprint keyrings; never reuse encryption, signing, and fingerprint keys across purposes.
- [ ] Add App Run, attempt, append-only event, App-native receipt, and attention schemas/tables/state machines.
- [ ] Add idempotency replay/conflict, locks, timeouts, cancellation, retry classification, and `unknown_outcome` semantics.
- [ ] Add bounded child-Run ancestry with inherited budgets/authorization and synchronous capability-cycle rejection.
- [ ] Integrate the existing approval inbox through one linked `app_run_invoke` action while making the App Run the execution source of truth.
- [ ] Add the closed `app | core | legacy_connector` execution-origin union; legacy origins persist `grant_source: legacy_connection_policy` and cannot appear in the App catalog.
- [ ] Enforce the actor/App-grant intersection for App origins and the exact current legacy policy for compatibility origins before approval and again immediately before execution.
- [ ] Recheck membership, employee health/budget, token scope, connector, schema digest, provider, assignment, grants/policy source, and bound authorization versions at execution.
- [ ] Add sanitized receipts, metrics, operator inspection, and migration adapters for existing action receipts.
- [ ] Wrap App Run invocation behind a disabled-by-default flag, certify it, and retain a bounded rollback path until parity is proven.

**Acceptance evidence:** auto and reviewed calls create one Run and at most one provider call; capability cycles stop before a second call and child Runs cannot reset budgets; no pseudo-App grant exists; legacy Runs are not App-discoverable; `always` review cannot be bypassed by an Autonomous employee; payload limits and terminal purge preserve only the declared sanitized residue; restart/replay, encryption/signer/fingerprint rotation, supported-image rollback, low-entropy guessing resistance, unknown-outcome, and ciphertext-leakage tests pass.

### Phase 4: Resource Service, privacy, and universal relations

**Outcome:** core, Module, and future specialized resources share one addressable contract with live, reusable privacy enforcement.

- [ ] Add ResourceRef/provider schemas, registry/routing metadata, and one `ResourceAuthorizationService` used by every caller surface.
- [ ] Implement Module record and Task adapters first.
- [ ] Add bounded create/update/archive contracts for host-certified pure canonical state with strict validation, mutation authorization, idempotency, audit, and optimistic-concurrency preconditions; route every remote/network effect through CapabilityService and an App Run.
- [ ] Add organization, team, user-private, explicit-share, and role-restricted security contexts; make blobs and attachments inherit the parent context.
- [ ] Add generic typed relations with tenant, endpoint authorization, visibility, archive, deletion, and idempotency tests.
- [ ] Adapt search, context, and citations through Resource Service without changing current authorized results.
- [ ] Add adapters for messages, wiki, notes, files, calendar, people, and teams incrementally.
- [ ] Accept bounded provider search documents with freshness metadata, but always resolve and reauthorize live before disclosure.
- [ ] Treat provider security facts as inputs or denials only; add tests where a malicious provider claims access or hides an external effect behind `update`, and core authorization/governance still denies it.
- [ ] Preserve existing Module relations and Task links through compatibility adapters and shadow comparisons.

**Acceptance evidence:** no cross-org or cross-security-context resolution; stale projections cannot authorize; private-resource snippets and blobs disappear immediately after revocation; Module/Task parity passes; Campaign can reference Contact without copying it.

### Phase 5: Connected App grants, lifecycle, and native bindings

**Outcome:** installed Apps can request connected behavior, receive exact grants, and expose one governed action equivalently across all interactive actor surfaces.

- [ ] Extend `deft.app.json` only with the now-supported resource requirements, capability interfaces, connector requirements, and closed action/command/view bindings.
- [ ] Add dependencies, ownership, append-only full grant snapshots, requested-versus-effective review, and exact connector/provider binding; migrate Phase 1's exact Module bindings through an explicit v0-to-v1 adapter.
- [ ] Add deterministic bounded dependency resolution, cycle/ambiguity rejection, exact lock digests, shared ownership accounting, and no implicit dependency auto-upgrades.
- [ ] Reuse the existing Module compatibility revalidation for App-owned Module upgrades; reject transform-requiring schema changes without changing the active App/Module pointers or existing data.
- [ ] Add widening upgrade diffs, atomic version switching, installation/actor/connector/runtime authorization versions, dependency-aware uninstall, and explicit export/retention choices.
- [ ] Add explicit drain/supersede behavior for pending Runs/workflows/sync/public ingress; never rebind old work silently to a new App/interface/provider version.
- [ ] Enforce upgrade authority and canonical lineage identity; a different unsigned lineage stages separately and cannot inherit grants, connectors, private-interface mappings, data ownership, or endpoints.
- [ ] Add Settings Apps management, grant, provenance, health, and Run surfaces.
- [ ] Add closed declarative action/command/view binding schemas.
- [ ] Namespace every App-owned route/command/binding/resource key by canonical lineage/installation identity and reject reserved-core or confusable collisions.
- [ ] Resolve binding inputs only from authorized fields, references, and explicit user input.
- [ ] Add generic action bars, command-palette entries, and approval/run status UI.
- [ ] Add small stable MCP/App operations rather than generated top-level tools.
- [ ] Add explicit App discovery/resource/invocation/Run scopes and exact legacy token mappings; broad old workspace scopes default to no access to newly installed Apps.
- [ ] Implement standard-interface mapping and strict minimum approval floors.
- [ ] Ensure App activation cannot create connectors, widen OAuth/MCP tokens, enable schedules, or choose a runtime implicitly.

**Acceptance evidence:** staging grants nothing; cycles, ambiguous providers, implicit dependency upgrades, incompatible Module data/schema changes, reserved-key shadowing, and Unicode/confusable identifier collisions fail before activation without modifying current data or pointers; a widening upgrade requires fresh confirmation; pending old-version work is drained or safely expired but never rebound; failed activation leaves the old version active; disable or grant change advances the installation epoch, one member's removal advances only that actor's authorization version, and stale sessions/claims/approvals/invocations fail closed; old OAuth/MCP tokens cannot discover or invoke Apps without explicit reauthorization.

### Phase 6: Connected Authoring Kit beta and proof

**Outcome:** Codex can build and validate an independently authored Tier 2 App whose resources and actions participate natively in Deft.

- [ ] Extend the CLI, schemas, types, templates, lock file, and host simulator for resources, capabilities, bindings, grants, and Runs.
- [ ] Add fake connectors and deterministic App Run, approval, idempotency, revocation, and unknown-outcome fixtures.
- [ ] Add Codex/AGENTS guidance for App creation and safe extension choices.
- [ ] Add permission diff, provenance, upgrade, disable, and native-equivalence conformance tests.
- [ ] Publish independent CRM and Marketing reference Apps with a sandbox email provider.
- [ ] Complete Proof A without a CRM, Marketing, or campaign branch in Deft core.

**Acceptance evidence:** a fresh Codex task can scaffold, validate, locally install, and exercise the connected proof using only published contracts and docs; UI, Defty, employee, and human MCP produce the same binding, App Run, approval floor, idempotency, receipt, and result identity.

### Phase 7: Event outbox and governed automation

**Outcome:** Apps can react and schedule bounded work through the same App Run path, without requiring an external runtime.

- [ ] Add transactional event outbox, versioned envelopes, subscriptions, cursors, replay, and ancestry.
- [ ] Add deterministic trigger/condition/action DSL plus immutable version-pinned workflows with durable step/wait state, bounded branching, cancellation, and per-step App Runs.
- [ ] Add schedule timezone/DST/misfire policy, unique fire claims, pause, resume, retry, dead-letter, budgets, loop detection, and kill switches; do not promise arbitrary compensation code.
- [ ] Add a distinct non-admin automation principal, run-scoped delegation, live resource/grant checks, and authorization-version binding.
- [ ] Enforce capability risk, retry/idempotency, `review_requirement`, and `review_scope` identically across scheduled, event-triggered, employee, MCP, and human calls.
- [ ] Implement explicit immutable automation-definition approval; pin query/content/provider/schedule/limit/validity inputs and create one idempotent child Run/receipt per external effect.
- [ ] Extend the manifest, permission review, CLI/templates, workflow simulator, fixtures, and external conformance runner in the same phase.
- [ ] Keep App Skills and arbitrary runtime code out of deterministic policy evaluation.
- [ ] Complete Proof D1: bounded Scheduled Campaign automation using deterministic sandbox recipients/provider.

**Acceptance evidence:** trigger replay is idempotent; unclassified private effects cannot run unattended; immutable-definition widening requires review; loops/caps stop runaway actions; pause prevents unsent work; every effect has App Run ancestry and receipt.

### Phase 8: Isolated custom Experience Host

**Outcome:** a user-built custom UI can feel native without entering Deft's trusted origin/process.

- [ ] Run the browser isolation spike and record whether opaque-origin/no-storage frames or per-installation/version cookie-less origins satisfy self-hosting, CSP, all egress primitives, App-to-App isolation, storage clearing, module loading, downloads, accessibility, mobile, and revocation requirements before freezing the custom-experience manifest block.
- [ ] Store and serve immutable content-addressed static bundles; do not run builds, install dependencies, or load mutable author-controlled URLs.
- [ ] Implement the selected opaque-origin/no-storage or per-installation/version cookie-less transport; never share one sandbox origin/storage namespace across Apps.
- [ ] Add a hardened iframe shell, restrictive sandbox/Permissions Policy, and per-route CSP that blocks every browser egress primitive by default, not only `fetch`.
- [ ] Add a nonce-bound, frame-bound, versioned `MessageChannel` handshake and closed bridge schemas without giving the frame a reusable bearer token.
- [ ] Add App SDK for resources, bindings, Runs, theme, navigation, pickers, and notifications.
- [ ] Broker every workspace operation through live Resource Service/App Run authorization and the bound authorization-version vector.
- [ ] Extend custom-experience manifest blocks, permission diff, CLI template/build checks, browser SDK, host simulator, and external conformance suite in the same phase.
- [ ] Add accessibility, responsive, focus, keyboard, theme, storage clearing, offline/error, App-to-App isolation, hostile-resource-content, stored-XSS, and revocation behavior/tests.
- [ ] Complete Proof B: custom Agent Operations Console.

**Acceptance evidence:** custom UI has no Deft cookies, bearer token, database/internal API, parent DOM, shared App storage, or undeclared network channel; hostile resource HTML cannot gain the frame's bridge authority; egress-primitive tests and live revocation pass; desktop/mobile rendered behavior is inspected; all actions remain governed.

### Phase 9: Runtime Service

**Outcome:** full-surface Apps can use operator-managed specialized computation safely on top of the proven Run/event substrate.

- [ ] Add operator-administered runtime registration, compatibility, health, App-version binding, data/recoverability declaration, and revocation contracts.
- [ ] Bind one explicit credential mode: Deft-held provider, connector-backed child capability, or operator-managed runtime credential with truthful independent-authority warnings.
- [ ] Add a pull-based claim/lease/heartbeat/cancel/reconcile channel with short-lived claim credentials and IDs-only queue payloads.
- [ ] Load sensitive input only after live actor/grant and authorization-version checks; never deliver connector credentials or installing-user impersonation.
- [ ] Add signed, sequenced callbacks and bounded, schema-validated logs/events/status/result interfaces.
- [ ] Enforce runtime/action/cost/time/data budgets and circuit breakers.
- [ ] Validate targets and prevent manifest-driven SSRF, arbitrary commands, or silent runtime creation.
- [ ] Extend runtime manifest blocks, permission review, CLI/template, runtime SDK, fake separate-process runtime, and external conformance tests in the same phase.
- [ ] Document Compose/local and remote operator deployment without promising managed hosting.

**Acceptance evidence:** a compromised/test runtime cannot cross org/App/grant boundaries or obtain new claims after disable; each credential mode proves its stated rotation/revocation limit; the UI states that already delivered data and runtime-owned credentials cannot be clawed back; callback replay, stale authorization versions, outage, lease expiry, and cancellation fail safely.

### Phase 10: Synchronization and specialized resources

**Outcome:** Apps can expose external or specialized data without copying it into generic Module records.

- [ ] Add specialized Resource Provider registration and runtime bridge.
- [ ] Require each provider to declare canonical store, ownership, export/resync/backup support, consistency checkpoints, and restore-health behavior.
- [ ] Require the provider's credential authority and rotation/revocation owner to be declared and shown during binding and health checks.
- [ ] Ship provider-authoritative one-way projection first, using one bounded App Run per page/checkpoint, transactional item subreceipts, cursors, freshness, tombstones, retention, and explicit resync.
- [ ] Add permission-aware search/context projection ingestion and reauthorization.
- [ ] Add brokered attachment/blob handoff with inherited ACLs, size/MIME/sniff checks, safe disposition, quarantine/scanning hooks, and no storage-credential or active-content exposure.
- [ ] Add schema drift, provider outage, resync, revocation, and deletion tests.
- [ ] Add Deft-owned push only after loop and partial-failure proof; add bidirectional mode only after field-ownership and conflict UX proof.
- [ ] Extend sync/provider manifest blocks, permission and recoverability review, CLI/templates, fake provider/runtime, fixtures, and external conformance tests in the same phase.

**Acceptance evidence:** remote-owned resources survive restart/resume; bounded backfills resume from committed checkpoints; stale data is labelled and cannot widen access; malicious/active attachments cannot execute in the shell or escape parent ACLs; sync failure does not corrupt canonical data; backup/restore UI truthfully distinguishes Deft-restorable, resyncable, and externally owned data and names who controls each external credential.

### Phase 11: Public Gateway

**Outcome:** Apps can expose safe public workflows such as booking and intake.

- [ ] Add declarative public pages/forms and scoped external submission API.
- [ ] Add opaque endpoints, enable/disable, schemas, payload limits, rate limits, retention, consent, and abuse controls.
- [ ] Support an operator-configured separate public-surface URL; where same-origin fallback is allowed, use public-only middleware that ignores ambient cookies and never resolves a shell actor.
- [ ] Add strict built-in raw-byte signature profiles and reviewed bundled webhook adapters; untrusted manifests cannot supply verification code.
- [ ] Route unsupported provider webhooks to an operator-managed runtime, which submits a separately authenticated scoped event.
- [ ] Return `202 Accepted` only after deduplicated ingress/outbox durability; return a generic retryable failure if the commit fails.
- [ ] Commit unsubscribe before success and serialize recipient suppression versions against durable send-dispatch claims; never imply an already in-flight provider call was retracted.
- [ ] Add transactional public-resource creation patterns.
- [ ] Extend public-surface manifest blocks, permission/retention review, CLI/templates, local public simulator, abuse/signature fixtures, and external conformance tests in the same phase.
- [ ] Complete Proof C: Booking App and Proof D2: authoritative unsubscribe plus deduplicated bounce/complaint ingestion.

**Acceptance evidence:** anonymous callers and ambient shell cookies cannot enumerate or inherit workspace state; double-book, raw-byte signature, crash-before/after-`202`, replay, rate/size, unsubscribe-versus-send race, and deletion-retention tests pass; public errors/logs leak no submission data; disable is immediate except explicitly retained compliance endpoints.

### Phase 12: Full-surface proof and platform hardening

**Outcome:** demonstrate that App Protocol fulfills the original full-surface vision.

- [ ] Complete Proof E: Email Lite using an operator-owned sandbox/test provider.
- [ ] Build the App and runtime from clean independent repositories using only published version-matched artifacts; run the provider as a separate process.
- [ ] After deterministic fake-provider conformance, certify at least one standards-based or real-provider test adapter.
- [ ] Complete ACL/parity certification for the core Resource adapters claimed by the north star: Modules, Tasks, messages/chat, wiki/notes, files/blobs, calendar, people, and teams.
- [ ] Run native-equivalence conformance across UI, Defty, employee, human MCP, and automation.
- [ ] Exercise backup, supported upgrade, disable, restore, compatible code/config rollback, rejected unsafe schema downgrade, provider outage/restart, lease expiry, runtime compromise, unknown outcomes, and externally owned-data recovery limits.
- [ ] Establish performance budgets for search, relation traversal, App Runs, event backlog, sync, iframe startup, and runtime callbacks.
- [ ] Complete focused independent security review of the new highest-risk boundaries.
- [ ] Update README, self-hosting, limitations, and roadmap claims only from certified evidence.

**Acceptance evidence:** an independently built full-surface App and separate runtime use only published contracts, add no domain code to Deft core, and participate natively across all claimed actor and core-resource surfaces under failure, restore, and revocation tests.

### Phase 13: Ecosystem and stable protocol, evidence permitting

- [ ] Publish compatibility and deprecation policy for App protocol versions.
- [ ] Add signed publisher/release provenance and optional registry metadata.
- [ ] Add canonical examples and community conformance CI.
- [ ] Consider install-by-URL, automatic updates, managed runtime providers, and marketplace UX only after local/signed artifacts are dependable.
- [ ] Promote repeated private interfaces into reviewed standard interfaces rather than designing a giant ontology upfront.

## First implementation milestone

The reviewable implementation sequence for this milestone is defined in `docs/superpowers/plans/2026-08-29-app-platform-first-loops.md`.

Do not begin with custom UI, runtime hosting, or Email Lite. The first shippable slice should prove that Deft has an App product unit, not merely more backend abstractions:

1. rebaseline the contract and threat model against the implementation commit used to start work;
2. settle the approval-floor contract and freeze Module/App v0 against executable, authority-bearing, and future-plane fields;
3. add the minimal declarative App/version/artifact/installation model behind flags;
4. publish the matching alpha schema, TypeScript types, and `init`, `check`, `build`, `install-local`, and `doctor` commands;
5. stage, review, activate, open, and disable a deterministic Hello Workspace App composed only from existing Module resources and Deft-rendered views;
6. certify digest reproducibility, zero-rights staging, failed-activation rollback, tenant isolation, and disable/revocation.

This milestone creates a narrow but real user loop while adding no executable App code, new connector authority, background execution, or custom network surface. It also prevents the protocol and tooling from drifting apart.

The next internal milestone extracts CapabilityService with behavior parity. App Runs and the Secret Service follow; Resource Service/privacy follows that. Only after those gates pass does the same package expand into connected grants and Proof A. Governed automation comes next, followed by custom experiences, runtimes, sync, and public ingress as separately revocable planes.

## Migration and rollback strategy

- Preserve Module manifest schema `1`, current Module IDs, Module records, saved views, task links, tools, and APIs.
- Add new tables and compatibility adapters; avoid destructive table reinterpretation.
- Make Module lifecycle operations transaction-composable before App activation orchestrates them; a failed cross-service activation must not leave a dependency active without the App pointer or vice versa.
- Keep Phase 1's exact Module dependency bindings distinct from generalized grants; migrate them through an explicit, tested v0-to-v1 adapter only after ResourceAuthorizationService exists.
- Preserve the current safe Module-upgrade rule: compatible schema revalidation only, with no App-authored migration execution. Incompatible changes leave active pointers and data untouched; any later declarative migration protocol requires its own architecture gate.
- Use `pnpm db:push-full` for fresh schemas and versioned `pnpm db:upgrade` scripts for release upgrades.
- Every release migration includes representative pre-upgrade fixtures and checksum registration.
- Feature flags default off until focused certification; structural CapabilityService extraction remains behavior-compatible and always on only after parity proof.
- Activation/version changes use immutable versions and pointer swaps.
- Treat pointer rollback and data-schema downgrade separately: only compatibility-proved code/config rollback is a pointer operation after new-version writes; otherwise restore backup or ship a forward corrective version.
- Runtime/experience/public endpoints can be globally disabled by operators.
- Roll out Secret Service changes across compatibility releases: legacy+v2 dual-read first, v2 writes only after the rollback-floor image supports them, no in-place re-encryption during that window, then tested retirement. Backups include encryption, receipt-signing, and fingerprint keyrings and versions.
- Successful database upgrades are forward-only. Operational rollback uses a pre-upgrade Postgres/uploads/keyring backup plus a compatible previous immutable image digest.
- Provider-owned canonical data follows its declared export/resync/backup and consistency-checkpoint contract. Deft rollback never claims to restore external data that the operator/provider did not back up.
- Before removing a compatibility path, run shadow comparisons and inspect mismatch telemetry with sensitive values excluded.

## Failure modes that must be designed, not patched later

- approval succeeds after App/grant/connector/runtime revocation;
- provider accepts an external effect and the local process crashes before recording success;
- an App Run copies oversized or long-lived sensitive resource content instead of a minimal retained executable snapshot;
- a specialized provider hides a network effect behind direct Resource `update` or `archive`;
- sync cursor advances without durable resource projection;
- custom UI bridge nonce, channel message, or `postMessage` is replayed by the wrong frame;
- App upgrade changes capability/resource schemas while Runs are pending;
- an operator rolls an App pointer back after new-schema writes that the old Module manifest cannot parse;
- public webhook is replayed or sends an oversized/poisoned payload;
- the Gateway returns `202` before durable ingress, or unsubscribe races a claimed send;
- automation recursively triggers itself or exceeds budget;
- runtime goes offline with leases or long-running work outstanding;
- App disable strands shared resources, public compliance endpoints, or dependencies;
- stale search projection reveals a label or snippet after permission loss;
- a provider-supplied attachment executes active content in the authenticated shell or bypasses its parent ACL;
- an App description, resource value, or Skill contains prompt injection;
- a self-hosted operator restores database and uploads to inconsistent points;
- a private capability is mistaken for a standardized interoperable interface;
- a private capability's author-supplied metadata is trusted as risk, retry, egress, or automation policy;
- a provider claims authorization that the core security context denies;
- a broad legacy OAuth/MCP scope accidentally discovers a new App;
- an unsigned sideload claims another App's namespace and inherits its grants or connector mappings;
- one member's removal globally revokes—or fails to revoke—the wrong installation sessions;
- a previous image cannot read newly written ciphertext or verify historical receipts;
- an unkeyed Run/input digest permits offline guessing of low-entropy personal data;
- browser egress escapes through images, CSS, forms, navigation, pings, or shared App storage despite `connect-src 'none'`;
- Deft reports a successful restore while externally canonical App data is missing or inconsistent;
- a remote runtime exfiltrates data it was legitimately granted;
- a runtime-owned external credential continues acting after Deft disables the App, contrary to what the UI promised.

Each phase must include denial, revocation, race, restart, idempotency, partial-failure, tenant-isolation, and leakage tests appropriate to its boundary.

## Explicit non-goals for the initial platform

- Running arbitrary user code inside the Deft API, worker, or web process
- Giving Apps direct Postgres, filesystem, environment, cookie, or connector-secret access
- Managed hosting or automatic provisioning of every App runtime
- A hosted multi-tenant Deft service
- A public marketplace, billing, payments, or one-click remote code installation
- A giant universal domain schema or ontology
- Automatically converting every MCP tool into a trusted standardized capability
- Arbitrary App-supplied schema/data migration code; initial Module evolution must pass existing compatibility revalidation
- Silent connector creation, token scope expansion, trigger activation, or background execution
- Claiming a production Gmail replacement, newsletter deliverability service, legal compliance, or general-purpose spreadsheet engine as part of the protocol milestone
- Requiring AI for core App operation

## Final north-star acceptance test

A user starts from an ordinary self-hosted Deft workspace and asks Codex to build a full-surface application from the published authoring kit.

Without editing Deft core, Codex can:

1. scaffold a versioned App package;
2. define declarative and/or specialized resources;
3. build a Deft-rendered or isolated custom experience;
4. declare private or standard capabilities without granting policy to itself;
5. connect an explicitly registered operator-owned runtime/provider;
6. validate permissions and native-equivalence conformance;
7. stage the App and show a truthful grant/experience-isolation/runtime/public-surface review;
8. activate it without restarting or rebuilding Deft;
9. make its authorized resources searchable, linkable, citable, and available to knowledge/tasks/chat;
10. expose the same actions through UI, Defty, employee agents, human MCP, and automation;
11. execute every App capability, external-provider write, and App-delegated effect through the applicable approval, App Run, idempotency, audit, and receipt contract while ordinary human resource CRUD and existing native Deft actions retain their explicitly governed paths;
12. disable, upgrade, restore Deft-owned state, reconcile provider-owned state through its declared recovery contract, and uninstall without silent privilege retention or unrelated data loss.

Until this test passes with a Tier 3 proof App under failure and revocation conditions, Deft may claim an extensible connected workspace, but not a complete full-surface App platform.

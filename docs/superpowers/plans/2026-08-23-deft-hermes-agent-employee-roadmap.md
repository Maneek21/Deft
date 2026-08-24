# Deft + Hermes Agent Employee Roadmap

**Date:** 2026-08-23
**Status:** Core integration merged in `v0.3.0-preview.7`; reliability follow-up
and ideal-employee certification remain
**Primary employee under test:** Rita
**Runtime:** Hermes Agent

## Implementation checkpoint — 2026-08-23

Implemented on `codex/app-protocol-v2`:

- durable Agent Channel single-flight claims, renewable leases, fencing tokens,
  stale-owner rejection, and truthful terminal outcomes;
- UI/REST/human-MCP wake parity for agent task assignments, task changes, and
  chat mentions, with private-space membership enforced at dispatch and worker
  boundaries;
- bearer-bound employee identity (delegated workers no longer select identity
  with `caller_employee_slug`);
- a Deft Hermes memory-provider artifact with automatic scoped recall,
  post-turn reporting, explicit/built-in memory mirroring, secret rejection,
  source provenance, deterministic wiki reconciliation, replay safety, and
  human-correction fencing;
- a thin `deft-employee` Hermes hook plugin for assignment/budget context,
  generic external-write/destructive-command policy, sanitized tool receipts,
  and child outcomes; and
- durable plus live task progress for queued, running, approval-pending,
  needs-human, blocked, completed, failed, and cancelled work.

Fresh-schema, migration, API/web type and lint, Agent Channel, MCP
privacy/write, bridge, Hermes loader, and both Hermes adapter unit suites are
green. This checkpoint is not a release claim: Rita still runs Hermes v0.16.0,
the exposed provider credential still requires human-owned rotation, the two
adapter directories are not yet installed in Rita's dedicated profile, live
failure/recovery certification has not run, and the implementation is not yet
reviewed, merged, or deployed.

That paragraph records the August 23 checkpoint. The implementation was
subsequently reviewed, merged, released, and deployed through
`v0.3.0-preview.7`. Fresh Rita and Asha pilots proved the supervised employee
loop, but also exposed the reliability and context defects captured in the
minimum-work section below. The current release therefore remains a supervised
pilot rather than an ideal-employee release.

## Reliability delivery checkpoint — 2026-08-24

The first five minimum-work packages are merged:

- PR #240 makes the triggering conversation the primary evidence envelope
  and scopes automatic Knowledge recall to the local assignment before broader
  workspace evidence; and
- PR #241 gives every Hermes delivery attempt a stable runtime request key,
  permits one same-key recovery on an ambiguous transport failure, correlates
  durable Deft effects to that exact attempt, and reconciles an uncertain final
  handoff without replaying completed work or reporting a false failure;
- PR #242 makes task transitions and generic module relation writes executable
  from returned schemas and certification rather than model guesswork;
- PR #243 publishes the release-pinned external-runtime bundle, readiness and
  diagnostics contract, selected-module preflight, deep certification, and
  bridge-restart proof without placing Hermes on the Deft VPS; and
- PR #244 completes governed employee-private memory writeback, promotion,
  correction/deletion fencing, secret and instruction rejection, and fresh
  session reuse certification; and
- PR #245 completes durable task milestones, quiet long-run heartbeats,
  artifact-oriented outcome cards, immutable employee attribution, and the
  matched Hermes progress/reporting contract.

The executable-contract package established this employee boundary:

- task query/detail and mutation results expose `allowed_next_statuses`, while
  invalid transition responses return the current, requested, and allowed
  statuses in a structured error;
- module create and update share `relations: { field_key: [record_ids] }`, with
  record fields and relation edges committed atomically and legacy empty-create
  idempotency identities preserved;
- `module_schema_get` returns the exact shared create/update JSON Schemas plus
  manifest-derived, parser-valid examples and relation cardinality for every
  collection; and
- employee certification probes task-transition discovery and generic module
  discovery without requiring Contacts—or any module—to be installed.

This still does not make the ideal-employee claim. The deterministic release
gate now rebuilds and seeds a disposable Deft database, exercises the complete
employee recovery/security matrix and matched Hermes bundle twice, and emits a
commit-bound certificate required by release publication. Two consecutive
matched live demo runs from newly onboarded external Hermes profiles remain in
the delivery order below.

## Executive summary

The goal is not to rebuild Hermes inside Deft.

Hermes already provides a rich execution runtime: web research, browser control,
terminal and file access, code execution, MCP discovery and invocation, skills,
memory, goals, delegation, multi-agent Kanban, cron, messaging, and profile
isolation. Those capabilities, their ecosystems, their credentials, and their
execution strategy remain owned by the local Hermes runtime.

Deft is the employee's workplace and organizational control plane. It owns the
employee identity, company context, conversations, assignments, shared
knowledge, permissions to Deft data, organizational approvals, durable work
state, evidence, and reporting.

The product we are building is therefore a small but reliable integration:

1. a reliable Deft Agent Channel;
2. one isolated Hermes profile per Deft employee;
3. a Deft memory-provider adapter for automatic two-way company memory;
4. a thin Hermes plugin that injects Deft context, applies Deft-specific policy,
   and reports activity and outcomes; and
5. an excellent task experience in which the employee accepts work, executes it
   with its native capabilities, asks for help when blocked, and reports back
   with evidence.

This reliability work must be completed, merged, and certified before Deft
makes the ideal-employee promise. App Protocol remains the governed execution
system for Deft-owned apps and connectors; it must not become a replacement for
Hermes's native MCP and skills ecosystem.

## Product endstate

A person assigns Rita an outcome in Deft. Rita automatically receives the
relevant company, team, people, project, conversation, task, and wiki context.
She uses any permitted capability available in her Hermes profile to complete
the work, including tools that Deft does not know how to implement itself. She
posts meaningful progress, requests precise assistance or approval when
necessary, survives restarts and duplicate delivery, and returns a structured
final report with sources, artifacts, external effects, and remaining risks.

Knowledge learned during the work is retained at the right level:

- short operational facts remain in Rita's local Hermes memory;
- user preferences remain in Rita's Hermes user profile;
- task/session observations remain in Deft employee memory and cooperative logs;
- verified reusable company knowledge, decisions, procedures, and resources are
  created or updated as Deft wiki pages with provenance; and
- future Rita sessions automatically retrieve relevant wiki context without
  depending on a person to mention the page explicitly.

## Architectural boundary

| Concern | Owner | Deft's integration responsibility |
| --- | --- | --- |
| Company work and task state | Deft | Assign, discuss, review, close, and retain the canonical record |
| Company wiki and shared knowledge | Deft | Enforce scope, provenance, search, corrections, and retention |
| Employee identity and membership | Deft | Authenticate the employee and bind every run and child to that identity |
| MCP servers and external tool discovery | Hermes | Record a high-level attestation; do not duplicate the catalog or schemas |
| Skills and procedural memory | Hermes | Optionally display installed skill names/digests; do not manage the ecosystem |
| Browser, terminal, files, code, vision | Hermes | Supply task boundaries and receive activity/evidence |
| Planning, goals, delegation, Kanban | Hermes | Correlate Hermes sessions/children with the originating Deft task |
| Local profile memory | Hermes | Synchronize selected company context through a memory-provider adapter |
| Deft-specific approval and policy | Deft | Use Hermes hooks to allow, block, or escalate consequential activity |
| Shared Deft-owned connectors | App Protocol | Execute through governed App Runs with idempotency and receipts |
| Runtime-native external connectors | Hermes | Apply generic run policy through hooks and report sanitized results to Deft |

### Deployment topology

Deft is installed on the organization's VPS and remains the lightweight
workplace and control plane. Hermes does **not** run on that VPS as part of the
Deft deployment: co-hosting arbitrary employee runtimes would make Deft's RAM
and process footprint unpredictable.

People and organizations install Hermes wherever they choose: a personal
computer, company workstation, dedicated worker, home lab, or separately
managed server. The Deft integration bridge runs beside that Hermes runtime and
connects outbound to Deft over the Agent Channel. Deft never needs an inbound
connection to the Hermes host.

- Every connected employee uses an isolated Hermes profile and an
  employee-scoped, revocable Deft credential.
- Several employees may run on one host or on different hosts; placement is an
  operator decision, not a Deft architecture decision.
- A disconnected runtime is a normal availability state. Deft retains queued
  work and reports the employee as unavailable without treating the Deft
  deployment as unhealthy.
- Deft publishes and certifies the release-pinned bridge, memory adapter, and
  policy hooks. Hermes continues to install, run, update, and supervise its own
  gateway, profiles, skills, MCPs, browser, and execution processes.
- The same protocol and certification suite applies across supported operating
  systems. Deft does not require or infer a particular runtime host topology.

Rejected alternatives are bundling Hermes into the Deft VPS deployment and
building a Deft-owned Hermes fleet manager. Both expand Deft's operational and
security surface, duplicate runtime ownership, and undermine self-hosting
predictability.

### What this boundary means

Deft will not create a capability interface for every Hermes tool. It will not
copy Hermes MCP credentials, install arbitrary MCP servers, or maintain another
skills marketplace. It will not recreate Hermes goals, delegation, Kanban,
cron, browser automation, or memory engine.

Deft will make those capabilities safer and more useful when they are used for
company work by supplying scoped context, an authenticated employee identity,
task-level boundaries, human escalation, durable reporting, and shared memory.

## Product decisions locked — 2026-08-24

1. **Distributed, operator-owned runtimes.** Hermes runs wherever the person or
   organization installs it and connects outbound to Deft. Deft does not host
   Hermes or decide employee placement.
2. **Tiered memory.** Transient working state remains in Hermes. Reusable
   learning may sync automatically into employee-private Deft Knowledge with
   provenance. Organization-wide promotion requires human approval unless an
   authorized human explicitly requested publication. Newer human corrections
   always override runtime memory.
3. **External-action policy.** Research and external reads may run within the
   assignment policy. Standard employees require approval before email,
   publishing, destructive changes, or other external writes. Autonomous
   employees may bypass per-action approval only for connector and action
   classes explicitly granted by the organization.
4. **Minimum multi-employee coordination.** Employees coordinate through normal
   Deft spaces, tasks, comments, Knowledge, and explicit handoffs. No new
   runtime-to-runtime orchestration is required for the first promise.
5. **Useful progress, not chat noise.** Milestones are durable task activity; a
   long silent step emits a heartbeat after roughly 60–90 seconds. Chat is used
   for meaningful results, blockers, approval or assistance requests, and
   explicitly requested updates.
6. **Release threshold.** A fresh Deft seed and fresh Hermes profiles must pass
   the complete gauntlet twice consecutively, without shell repair, before the
   ideal-employee label is used.

## Where we are now

### What works

The August 23 evaluation showed that Rita can:

- converse naturally in Deft spaces;
- distinguish people and conversation scopes;
- notice assigned tasks and start work;
- retrieve task, project, team, and wiki context through Deft MCP;
- use generic module tools, including Contacts;
- create durable Deft records;
- ask for missing information instead of inventing it;
- resume after a human replies; and
- report completed work back into tasks and chat.

The deeper scenario battery passed all seven functional scenarios. Rita is
usable today for supervised, bounded workflows.

The detailed Rita evaluation artifacts remain local and are intentionally kept
separate from this implementation changeset.

### What prevents unattended use

The same evaluation found integration failures that Hermes cannot repair by
itself:

1. Long work can cross the Agent Channel delivery lease and be delivered to a
   second run while the first is still active.
2. Delegated Hermes workers can lose Rita's authenticated Deft identity.
3. A child authorization failure can open a shared circuit breaker and impair
   the parent.
4. UI/REST writes and human MCP writes do not publish identical employee wake
   events.
5. The bridge can report healthy while Hermes cannot execute a model turn.
6. The bridge does not persist truthful terminal outcomes such as
   `needs_human`, `blocked`, or `failed`.
7. Idempotency does not yet cover the complete source-event-run-tool-write path.
8. Progress and assistance requests are behaviorally present but not represented
   as reliable run state.

### Runtime baseline issue

The connected runtime is Hermes v0.16.0 and is substantially behind the current
Hermes implementation. During inspection, its shareable status command exposed
a live provider credential instead of redacting it. The credential must be
rotated, Hermes upgraded, and status/redaction behavior recertified before the
runtime is treated as production-ready.

### Memory today

Deft already exposes useful primitives:

- `platform_context` for company, people, project, space, and relevant memory;
- `memory_recall` / `wiki_search` for scoped wiki retrieval;
- `memory_list` for enumeration;
- `memory_write` for durable wiki creation;
- `record_conversation_turn`, `record_decision`, and `record_outcome` for
  cooperative reporting; and
- scoped `agent_memory` for native conversation/user/org memory.

Hermes already supports built-in profile memory and external memory-provider
plugins that can prefetch context before a turn, sync turns after a response,
mirror memory writes, and expose provider-specific memory tools.

The missing work is not a new memory database. It is the adapter and policy that
connect these existing systems automatically and safely.

## What we are building now

## Workstream 0 — Secure and certify the runtime

### Deliverables

- Rotate the exposed model-provider credential.
- Upgrade Rita's Hermes runtime to the current approved stable version.
- Create or confirm a dedicated Rita Hermes profile; no other employee process
  may write to that profile.
- Confirm `gpt-5.6-sol` at medium reasoning after the upgrade.
- Reconfigure and verify Deft MCP, browser, terminal/file, web, code, memory,
  skills, delegation, cron, and required messaging capabilities.
- Verify status/log/error redaction with planted test secrets.
- Run a real authenticated inference and Deft MCP read/write probe.

### Exit gate

The runtime reports degraded when inference or Deft MCP is unavailable, no
shareable diagnostic leaks planted secrets, and the effective profile identity,
version, model, and high-level toolsets are visible to Deft.

## Workstream 1 — Reliable assignment and execution correlation

This is a bridge, not a second workflow engine.

### Deliverables

- Atomically claim each Agent Channel event.
- Add a renewable lease, lease expiry, and fencing token.
- Permit only one active Hermes execution for one event/attempt.
- Correlate the Deft task/event with Hermes profile, session, goal, and child
  session identifiers.
- Carry the authenticated employee identity into every child execution.
- Isolate circuit breakers by deployment, caller, and failure class.
- Publish identical wake events for equivalent UI, REST, human MCP, and employee
  MCP mutations through shared domain services.
- Add deep readiness: bridge connectivity, Hermes API, authenticated inference,
  and Deft MCP access.
- Carry one idempotency identity across event receipt, attempt, Hermes request,
  Deft writes, and retried external actions where supported.

### Minimal correlated run state

- source task/event;
- employee and Hermes profile;
- Hermes session/goal identifier;
- attempt number and fencing token;
- parent/child identifiers;
- `assigned`, `claimed`, `running`, `waiting_human`, `approval_pending`,
  `review`, `completed`, `failed`, and `cancelled` status;
- last meaningful progress timestamp and summary;
- current blocker or approval request;
- active task boundaries and budget; and
- final outcome and artifact references.

Deft does not store or recreate Hermes's internal plan. Hermes may use goals,
delegation, Kanban, or ordinary tool calls as it sees fit.

### Exit gate

A long-running assignment survives lease renewal, bridge restart, Hermes
restart, duplicate delivery, and one child failure without duplicate work or a
false completion state.

## Workstream 2 — Deft memory provider for Hermes

Memory synchronization is part of the first usable release.

### Component

Build a small Hermes memory-provider/plugin package named conceptually
`deft-memory`. It uses the authenticated Rita Deft MCP connection and Hermes's
existing memory-provider and hook contracts. Deft remains the source of truth
for shared company knowledge; Hermes remains the source of truth for Rita's
local operational memory.

### Deft to Hermes: automatic contextual recall

Before each employee turn:

1. Resolve the triggering Deft task, space, project, people, and thread.
2. Fetch `platform_context` using authenticated runtime identity rather than a
   caller-declared slug.
3. Retrieve a bounded set of relevant wiki pages through `memory_recall`.
4. Include titles, stable IDs, timestamps, scope, and citations.
5. Inject the context through Hermes's memory-provider or `pre_llm_call` hook.
6. Preserve Deft access control: private spaces and restricted pages are never
   retrieved merely because Rita knows their IDs.
7. Let Hermes perform deeper on-demand recall through the normal Deft MCP tools.

This makes relevant wiki context available even when the assignment does not
explicitly mention a wiki page.

### Hermes to Deft: automatic learning and reporting

During and after a turn or completed assignment:

1. Record a concise conversation/turn summary through
   `record_conversation_turn`.
2. Record consequential decisions through `record_decision`.
3. Record success, partial success, failure, and follow-up through
   `record_outcome`.
4. Extract candidate durable memories with type, confidence, sources, and task
   provenance.
5. Search for related wiki pages before writing.
6. Create or update the wiki through an idempotent extension of `memory_write`.
7. Store the resulting wiki page ID on the employee run and cite it in the final
   report.

### Knowledge promotion policy

| Learned information | Destination | Default policy |
| --- | --- | --- |
| Temporary step state or scratch fact | Hermes session/local operational memory | Automatic |
| Stable preference about how a person works | Hermes `USER.md` and scoped Deft employee memory | Automatic with provenance; correctable by that person |
| Task-specific observation | Deft employee/task memory or cooperative log | Automatic |
| Explicit “remember/save this” instruction | Deft wiki | Write immediately if authorized |
| Verified fact supported by tool results or sources | Deft wiki | Automatically create/update with citations and confidence |
| Decision made by an authorized person | Deft wiki decision | Automatically capture with actor and source conversation |
| Reusable procedure proven during work | Deft wiki procedure | Create/update at successful run completion |
| Unverified inference or speculation | Candidate memory only | Do not publish to the wiki without review |
| Secret, credential, private token, or sensitive raw payload | Nowhere in memory/wiki | Reject and redact |

### Required `memory_write` improvements

Extend rather than replace the existing tool:

- accept `idempotency_key`;
- accept source references such as task, message, session, URL, and artifact;
- support deterministic create-or-update behavior;
- include author employee and Hermes run provenance;
- preserve confidence and verification state;
- return the canonical wiki page ID and version;
- reject cross-scope and cross-org references;
- prevent secrets and unsafe raw tool output from being persisted; and
- emit a wake/change event so later Rita sessions see the new version.

### Loop and correction safety

- Every synced item carries a stable source ID and content digest.
- Context read from a wiki cannot be re-published as newly learned knowledge
  without a material change.
- Replayed hooks and retried sessions must update the same item rather than
  creating duplicates.
- Wiki edits, corrections, archive/delete actions, and access changes invalidate
  cached Hermes context.
- The next session must not continue using a deleted or newly inaccessible page.
- Agent-authored pages are labeled with employee, task/run, sources, confidence,
  and last verification time.

### Memory-sync exit gate

The following sequence must pass:

1. A person creates a wiki page containing a company rule.
2. Rita receives a related task without an explicit wiki mention.
3. The relevant page is automatically present in Rita's context and cited in
   her work.
4. Rita researches and verifies a new reusable fact.
5. The fact is created or merged into the correct wiki page with provenance.
6. A later fresh Hermes session recalls and uses that new knowledge.
7. Correcting the wiki changes the answer in the next session.
8. Replaying the original event creates no duplicate wiki page.
9. A restricted-space fact is not exposed outside its allowed context.
10. A planted prompt injection or credential in retrieved/tool content is not
    promoted into instructions or durable memory.

## Workstream 3 — Deft policy and reporting plugin

Build one thin Hermes plugin named conceptually `deft-employee`. It should use
Hermes's existing hooks instead of wrapping or reproducing runtime tools.

### `pre_llm_call`

- Inject current assignment and automatically retrieved memory.
- State the authenticated employee identity and current Deft participants.
- Supply task outcome, constraints, budget, and reporting expectations.

### `pre_tool_call`

- Receive the real underlying Hermes/MCP tool name and arguments.
- Allow ordinary research and permitted local work.
- Enforce task-specific destination, recipient, filesystem, and command limits.
- Block explicitly forbidden operations.
- Escalate external writes or high-risk actions to a Deft approval when required.
- Fail closed when policy cannot be checked.

This hook is generic. It does not require importing the tool's complete schema
into Deft or creating a new Deft capability interface.

### `post_tool_call`

- Report tool/server category, timestamps, success/failure, and sanitized result
  summary.
- Attach URLs, files, screenshots, hashes, and provider receipts when available.
- Never send credentials or unrestricted raw tool payloads to Deft.
- Preserve the event/run/tool-call identity for deduplication.

### Completion and delegation hooks

- Report child completion/failure to the parent correlated run.
- Persist `completed`, `needs_human`, `blocked`, `failed`, or `cancelled` instead
  of reducing all acknowledged work to completed.
- Include work performed, evidence, changes made, remaining risks, and next
  action in the final task report.

### Exit gate

Hermes can freely use an installed runtime-native MCP that Deft has never
implemented, while Deft still shows the task's meaningful progress, blocks a
forbidden external write, obtains approval for a permitted reviewed write, and
records a sanitized verified result.

## Workstream 4 — Agent employee experience

### Required behavior

For each assignment Rita:

1. acknowledges ownership;
2. states a concise plan and any assumptions;
3. begins work without requiring the requester to restate available context;
4. posts meaningful milestones rather than raw tool-call noise;
5. asks a specific person a specific question when blocked;
6. remains in `waiting_human` until the answer arrives;
7. resumes from the existing Hermes session or durable checkpoint;
8. requests approval before a consequential action when policy requires it;
9. puts finished work into the appropriate task, module, wiki, or artifact; and
10. posts a structured final report and moves the task to review.

### Minimal budgets

Deft supplies the assignment-level ceilings; Hermes performs execution within
them:

- wall-clock duration;
- LLM cost/token budget where available;
- maximum tool calls;
- maximum delegated children;
- maximum external sends or mutations; and
- deadline or stop condition.

Exhausting a budget moves the run to `needs_human`; it does not silently fail or
claim completion.

## Workstream 5 — End-to-end certification

### Scenario A — External research to company knowledge

Rita researches a current business question using native Hermes web/browser
tools, produces a cited report, saves verified reusable findings into the Deft
wiki, links the pages to the task, and uses them correctly in a fresh session.

### Scenario B — Lead research to Contacts

Rita reads the company's ICP from Deft Knowledge without an explicit page
mention, researches prospects using Hermes-native tools or MCPs, deduplicates
them, creates Contacts through generic module tools, and records sources and
qualification rationale.

### Scenario C — Approved outreach

Rita selects appropriate Contacts, drafts personalized outreach using company
context, requests approval, sends through a Hermes-configured email/MCP tool,
records activity only after a successful provider response, and reports failures
without false success.

### Failure and recovery matrix

Each scenario must also run with:

- duplicate event delivery;
- Agent Channel bridge restart;
- Hermes restart;
- expired or revoked connector credential;
- approval delay and rejection;
- one delegated child failure;
- human clarification;
- budget exhaustion;
- prompt injection in a retrieved webpage or wiki page; and
- replay after completion.

The invariants are no duplicate records, no duplicate external sends, no lost
work, no cross-employee identity, no unauthorized context, no secret persistence,
and no false completion.

## What remains App Protocol work

App Protocol v2 remains appropriate for Deft-owned application execution:

- native Defty and human-initiated external actions;
- organization-owned shared connectors;
- App Pack capability bindings;
- deterministic approval floors;
- encrypted executable input;
- exact idempotency and provider receipt handling; and
- automation ancestry and budgets.

The specification must clarify that `CapabilityService.invoke` is the sole
provider-call seam for **Deft-owned app execution**, not the sole provider-call
seam for an onboarded external runtime.

Hermes-native MCPs and skills remain outside the App Pack wire format. When
Hermes uses them for a Deft assignment, the Deft employee plugin supplies
context, policy escalation, and audit reporting through Hermes's hook system.

Reference: [App Protocol v2 specification](../specs/2026-08-22-app-protocol-v2.md)

## Explicitly not building

The following work is outside this plan because Hermes already owns it or
because it does not materially improve Hermes inside Deft:

- a Deft universal MCP catalog, marketplace, installer, or OAuth system for
  runtime-local MCPs;
- importing every Hermes MCP tool schema into the Deft capability registry;
- copying runtime-local MCP secrets into Deft;
- a second skills ecosystem, skill editor, or autonomous skill engine;
- a Deft browser, terminal, filesystem, code executor, research engine, or
  messaging gateway;
- a second planner, persistent-goal engine, delegation system, Kanban board, or
  cron runner;
- a second general-purpose memory engine;
- mirroring complete Hermes sessions into the company wiki;
- connector-specific Deft adapters for every service Hermes can reach;
- unrestricted chain-of-thought storage or display;
- broad cross-host multi-agent orchestration; and
- automatic trust, token, secret, network, or tool expansion from a skill.

## Work parked until after the certified employee loop

- Rich visualization of delegated Hermes run trees.
- Advanced cost allocation and forecasting dashboards.
- Universal proactive triggers beyond visible Deft assignments and a small set
  of explicit schedules.
- Cross-host Hermes coordination.
- Full workflow time travel and arbitrary historical replay.
- Organization-wide automatic knowledge extraction from all conversations.
- Skill discovery and inventory UX beyond a read-only runtime attestation.
- Detailed per-tool schema-aware policy for arbitrary runtime-native MCPs.
- Specialized CRM, campaign, recruiting, or support logic in Deft core.

## Further questions resolved

| Question from the live pilot | Resolution |
| --- | --- |
| Why did a `#general` reply import unrelated work? | The current event and memory-prefetch seams carry identifiers but do not establish the source thread as the primary evidence boundary. Fix prompt assembly and retrieval scoping together; do not treat this as a model-only problem. |
| How should an ambiguous long-run transport failure recover? | Send a stable Hermes `Idempotency-Key` derived from the Deft event and attempt, permit one bounded recovery request, and reconcile durable Deft writes and receipts before reporting failure. Never blindly replay a non-idempotent run. |
| Who schedules background skill and memory review? | Hermes. Deft employee profile guidance disables foreground-triggered review until Hermes can make it idle-only and preemptible. Deft does not build a second scheduler. |
| What relation shape should modules expose? | One generic shape for create and update: `relations: { field_key: [record_ids] }`. Mutations are atomic and module introspection returns manifest-derived valid examples. |
| Where should learned knowledge live? | Transient state stays in Hermes; reusable learning syncs to employee-private Deft Knowledge with provenance; organization-wide promotion follows the locked approval policy; human corrections fence stale runtime copies. |

## Minimum Deft work before the ideal-employee promise

### 1. Make the triggering conversation the primary evidence envelope

- Include the source space, thread, message, task, and relevant participants in
  a structured event context rather than relying on identifiers embedded in an
  undifferentiated prompt.
- Fetch the source thread before broad workspace search when answering a
  conversation event.
- Label every retrieved fact with its scope and source. Importing evidence from
  another space must be explicit and justified.
- Bound automatic context and wiki recall independently so an unrelated but
  semantically similar workspace item cannot displace the local conversation.

**Acceptance evidence:** an automated fixture containing plausible conflicting
facts in another space produces a locally grounded answer with no undisclosed
cross-space import.

### 2. Make long-run handoff and terminal outcomes truthful

- Send a stable idempotency key on the Hermes response request and reuse it for
  the same Deft delivery attempt.
- On an ambiguous response-body or connection failure, perform at most one safe
  recovery request and never start an uncorrelated second run.
- Reconcile task state, comments, module mutations, action receipts, and stored
  runtime correlation before terminalizing the event.
- Represent `work_completed_handoff_uncertain` separately from both success and
  failure when durable effects exist but the final human-facing response is
  unavailable.

**Acceptance evidence:** the BUY-10 failure shape cannot produce duplicate
writes or a false failure, including when the connection drops after the last
durable mutation.

### 3. Make Deft task and module contracts executable without guessing

- Return `allowed_next_statuses` with task reads and invalid-transition errors.
- Use the same generic relation patch on module record creation and update:
  `relations: { field_key: [record_ids] }`.
- Apply record fields and relations atomically.
- Return exact operation input schemas and at least one valid,
  manifest-derived example, including relation cardinality and value shape.
- Add these contract probes to employee certification so Contacts is not a
  special case.

**Acceptance evidence:** a fresh employee creates a linked Contacts activity
and advances a task to review without schema-error recovery.

### 4. Make distributed onboarding self-verifying

- Deft publishes a release-pinned integration bundle for installation beside
  any operator-owned Hermes runtime. The bundle contains only the bridge,
  memory adapter, policy hooks, manifest, and diagnostics.
- The bridge uses outbound HTTPS to Deft; no inbound runtime port or co-location
  with the Deft VPS is required.
- Onboarding preflights requested modules, missing installations, employee
  access, approval policy, model reachability, and high-level connector
  availability before showing Ready.
- Deep certification proves protocol compatibility, employee-bound identity,
  one event delivery, a real Hermes inference, a Deft MCP call, report-back,
  private memory recall/writeback, and selected-module read/write access.
- Certification includes bridge restart persistence. Hermes remains responsible
  for installing and supervising its gateway.
- Offline, incompatible, degraded, certifying, and ready are distinct visible
  states. An offline runtime leaves queued work intact.

**Acceptance evidence:** a clean Hermes install on an independently chosen host
can connect using only the pinned instructions, pass certification, restart,
and process the next event without shell repair.

### 5. Complete the governed memory loop

- Scope automatic recall to the triggering task, conversation, people, project,
  and authorized Knowledge before broad organization recall.
- Keep working state local to Hermes and sync reusable learning to
  employee-private Deft Knowledge with stable provenance and replay identity.
- Promote organization-wide knowledge only under the locked authorization and
  approval policy.
- Human edits, deletion, access changes, and newer versions invalidate stale
  cached runtime context.
- Reject credentials, untrusted instructions, restricted-space leakage, and
  unsupported claims at the memory boundary.

**Acceptance evidence:** an implicit-Knowledge task cites the right rule, a
verified new learning is reusable in a fresh session, a human correction changes
the next answer, and replay creates no duplicate page.

### 6. Show employee progress and business outcomes clearly

- Persist meaningful milestones in task activity and emit a heartbeat after
  roughly 60–90 seconds without a milestone.
- Use chat for results, blockers, approval or assistance requests, and requested
  updates rather than mirroring every tool call.
- Show durable business artifacts and receipts independently of runtime health
  or final-response transport.
- Preserve immutable employee attribution on generic module writes.
- Show a high-level runtime capability attestation so people know whether an
  external connector exists, what Deft policy permits, and what approval is
  still required.

**Acceptance evidence:** a five-minute research task never appears abandoned,
does not flood chat, and ends with a truthful artifact-oriented handoff even if
the runtime subsequently disconnects.

### 7. Certify the promise from clean state

Run the full gauntlet from a fresh Deft seed and fresh Hermes profiles. It must
include conversation locality, explicit and implicit Knowledge, generic module
writes, approved external outreach, destructive and identity boundaries,
approval delay and rejection, duplicate delivery, bridge and Hermes restart,
credential revocation, memory correction, action-budget exhaustion, delegated
partial failure, injection resistance, privacy, and secret redaction.

The complete gauntlet must pass twice consecutively with no manual database,
profile, service, or shell repair. Simple boundary responses should complete in
under 30 seconds, ordinary internal tasks in under two minutes, and longer work
must provide useful progress.

## Delivery order

1. **Context locality PR:** structured source evidence, scoped retrieval, and
   contamination fixtures.
2. **Runtime reconciliation PR:** Hermes idempotency header, bounded ambiguous
   recovery, durable-outcome reconciliation, and failure injection tests.
3. **Executable contracts PR:** allowed task transitions, atomic module
   relations on create/update, examples, and certification fixtures.
4. **Distributed onboarding PR:** capability/access preflight, release-pinned
   bundle flow, readiness states, restart proof, and diagnostics.
5. **Memory-policy PR:** scoped recall, employee-private writeback, promotion,
   correction fencing, and memory certification.
6. **Employee experience PR:** progress cadence, assistance/approval UX,
   outcome cards, attribution, and capability attestation.
7. **Release-gate PR:** automate the clean-state gauntlet and recovery/security
   matrix in release and self-host smoke gates.
8. Deploy the matched Deft release and integration bundle to demo, onboard fresh
   employees from independently hosted Hermes runtimes, pass the gauntlet twice,
   merge all required work, and only then use the ideal-employee promise.

## Definition of done

This plan is complete when Rita can be treated as an agent employee rather than
a supervised tool demo:

- she reliably receives and owns assigned work;
- relevant Deft wiki knowledge is automatically available to her;
- verified knowledge she creates is durably written back to the wiki with
  provenance and is usable in a later fresh session;
- she uses Hermes-native tools, MCPs, skills, delegation, and execution methods
  without Deft recreating them;
- she remains within authenticated Deft identity, context, and task boundaries;
- consequential activity is approved when required and reported afterward;
- she provides useful progress and asks the right person for help when blocked;
- she survives duplicate delivery and process restarts without duplicated work;
- she reports final results with evidence, artifacts, external effects, and
  remaining risks; and
- the integration passes the full scenario, recovery, privacy, injection, and
  secret-redaction certification suite.

At that point, Deft makes Hermes better at being a company employee while
preserving the full value of Hermes's open-source runtime and ecosystem.

## External references

- [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)
- [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
- [Hermes persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
- [Hermes memory providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers/)
- [Hermes profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles/)
- [Hermes event hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks/)
- [Hermes tool search](https://hermes-agent.nousresearch.com/docs/user-guide/features/tool-search)

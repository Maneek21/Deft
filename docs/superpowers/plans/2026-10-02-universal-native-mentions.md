# Universal native mentions

Build one `@` experience across Deft's native content so people and agents receive attention, and tasks and wiki pages become linked references with backlinks. Core owns identity, authorization, publication and delivery. App Kit can adopt these contracts after the native experience works.

Status: compatibility-reviewed implementation plan, October 2, 2026. Execution uses master 94626051299decb231b48bead1144a716cd7873d in an isolated worktree. The review identified and corrected shared-index ownership, plain-text comment serialization, agent channel invocation, native schema compatibility and autosave publication conflicts. Implementation is opt-in; the PR report records verified behavior and outstanding integration gates. The initial audience is small teams working with AI agents. Proposed behavior below is a product and architecture recommendation, with acceptance evidence defined for execution.

## Outcome and scope

Typing `@` opens one searchable picker with People, Agents, Tasks and Wikis. Selecting a result inserts a reference with a stable identity. A person or agent mention creates eligible attention when the content is published; a task or wiki reference creates a navigable link and a backlink to its source.

| Target | Result | Additional behavior |
| --- | --- | --- |
| Person | Profile reference and one mention notification for a newly published mention | Notification opens the exact message, comment or document field. Existing preferences and source access apply. |
| Agent | Agent profile reference and durable mention attention | Outside chat, attention is passive. Starting work requires an explicit request. Preserve chat's existing direct invocation behavior. |
| Task | Authorized task reference and a backlink | Referencing a task does not assign it, change its status, subscribe anyone or notify its owner. |
| Wiki page | Authorized wiki reference and a backlink | Referencing a wiki does not share it or notify its owner. |

V1 supports chat messages and thread replies, task descriptions and comments, wiki bodies, and notes including daily notes. The four target groups above are the initial targets. Calendar descriptions, files and message references, Email, external systems and App Kit content follow later. Titles, settings, code blocks and arbitrary text inputs are not V1 mention surfaces.

`#tags`, existing task labels and wiki tags remain a separate classification feature. This work does not unify their taxonomy, redesign the wiki editor, replace the workspace permission model or build an agent workflow engine.

Acceptance example:

> @Sam, please review @DEFT-42 using @Launch checklist.

After publication, Sam receives one eligible notification opening the source. The task and wiki each show an authorized backlink. Editing unrelated text produces no additional ping. Removing a typed reference removes its inline backlink. Renaming a target preserves the connection. Mentioning an agent in a document creates attention without starting an agent run.

## Source baseline and existing seams

The main checkout has older application code and existing user changes. Do not implement by pulling or resetting this checkout. At execution kickoff, refresh the baseline and use a suitable isolated worktree.

| Reviewed source | Evidence and implication |
| --- | --- |
| Local `origin/master` at `94626051299decb231b48bead1144a716cd7873d` | Reviewed merged source for this plan. This baseline was freshly fetched at execution kickoff. Resource v1 covers tasks and modules. `resources-v2.ts` is absent here. |
| Main checkout at `2d478aee4bba23b34266e29247c1a0901f5b6d58` | Contains nine pre-existing modified tracked files and substantial untracked work. Preserve them. The new plan document is the intended addition for this turn. |
| Platform and Email worktree at `C:/tmp/deft-gate-g-integration-20260924`, HEAD `0c611bb4b1a000e8b4a066f71974137e5c0f31cd` plus local changes | Contains additive native resource v2 contracts and newer implementation work. Read this as a candidate, not a merged or certified dependency. Do not edit, reset or copy its whole dirty tree. |

Relevant code inspected across merged source and the candidate:

| Seam | Paths | Work required |
| --- | --- | --- |
| Chat mention UI and serialization | `apps/web/src/components/rich-composer.tsx`, `mention-autocomplete.tsx` | Extract a reusable picker and reference node. Scope roster/search caches to the authenticated organization and session. |
| Shared editor configuration | `apps/web/src/lib/editor/shared-config.ts`, `task-detail.tsx`, notes page | Add mention support through existing extension hooks. Task comment serialization currently uses plain text; preserve target IDs through its full save and render path. |
| Wiki editing | `apps/web/src/app/(app)/knowledge/page.tsx` | Add a compatible Markdown picker/codec adapter to the current editor. |
| Parsers and message dispatch | `apps/api/src/lib/mentions.ts`, `agent-mention-normalization.ts`, `routes/messages.ts` | Preserve legacy chat readers and direct agent routing; make create/edit processing consistent. |
| Task mention dispatch | `apps/api/src/routes/tasks.ts` | Replace fuzzy human-name notification routing with validated identities on new writes; reconcile mentions on create and edit. |
| Notification and attention policy | `apps/api/src/lib/notification-policy.ts`, `attention.ts` | Pass a typed source and exact anchor. Extend source visibility checks for supported native sources; existing generic attention checks are insufficient for this new contract. |
| Persisted references | `packages/db/src/schema.ts`, `routes/cross-references.ts`, `workers/handlers/cross-reference.ts`, wiki routes | Add ownership for inline references, reconcile additions/removals and preserve existing manual links and wiki relations. |
| Durable jobs | `apps/api/src/lib/queues.ts` | Reuse `enqueue` with its transaction executor and tenant-aware dedupe. Its at-least-once delivery requires durable effect dedupe beyond queue retention. |
| Agent delivery | `lib/agent-channel.ts`, `routes/agent-channel.ts`, `lib/mcp-tools/messages.ts`, employee MCP registry, Hermes bridge | Existing channel events can start runtime work. Add passive attention to the existing identity-bound attention/MCP path rather than feeding passive mentions into that execution channel. |
| Writers outside HTTP routes | `lib/mcp-tools/human.ts`, `lib/mcp-tools/writes.ts`, `lib/agent-actions.ts`, wiki MCP writers | Inventory direct database writes and route supported content mutations through the same Core processing boundary. UI-only integration would leave inconsistent behavior. |

Independent unmerged remediation work covers task visibility, historical watcher access, wiki save identity and socket disclosure. Reuse the resulting fixes. Do not make mention insertion depend on unsafe watcher grants, stale editor state or organization-wide private-content broadcasts. Relevant regressions must pass on the integrated release candidate.

## Core architecture decision

Use a shared Core reference contract, publication service and small adapters for the existing native editors and writers.

| Option | Benefits | Cost and risks | Decision |
| --- | --- | --- | --- |
| Shared Core service with HTML/Markdown adapters | Preserves current editors and storage, supports all native writers, provides one authorization and delivery policy | Requires additive state, provenance and explicit save boundaries | Choose this. |
| Convert all native content to one document model and one new graph store | Gives one long-term serialization model | Broad content migration, editor replacement and rollback risk; delays the requested behavior | Reconsider only if native adapters prove inadequate. |

A picker added separately to each screen is insufficient: it cannot guarantee stable identities, writer parity, safe notifications or removal of backlinks.

### Identity and editor contracts

1. Keep task identity compatible with `TaskResourceRefV1`. Use the candidate's additive native resource vocabulary for people, wiki pages, notes and messages. Review and land the required native identity subset with its tests, or consume it if it has already merged. Core V1 must not require shipping the full Platform/Email stack.
2. Define the mention target as a validated native subset of the resource union. Tasks remain v1; native people/wiki refs use the additive contract. Do not accidentally restrict the union to v2 and exclude tasks, or create a second incompatible resource-addressing scheme.
3. People and agents both reference their stable `users.id`. Core resolves the current agent employee association and active status. Human/agent grouping is picker and policy metadata, with no parallel agent conversation store.
4. Define a source descriptor containing the owning resource, field, stable anchor and server revision. A task comment needs its comment ID plus owning task; a thread reply needs its message ID plus space/thread context. Plain document IDs are insufficient for exact navigation.
5. Provide one lossless logical reference codec with adapters for existing HTML and Markdown. Preserve existing `<@id|name>` chat markers and UUID mention spans. Legacy task identifiers remain readable. New notification routing uses canonical IDs, never a partial name match.
6. Persist identity and safe placeholders for new typed references. Resolve display labels, status and navigation through the current viewer's authorization. Avoid automatically copying a restricted target's title or preview into a broader source body, response, export or cache. Review legacy representations separately; this feature does not establish retroactive cleanup of old labels.
7. Bound search and resolution, validate with shared Zod contracts, and follow existing structured errors. Client-supplied labels, URLs, organization IDs or agent kinds do not confer authority.

### Publication and delivery

Reference reconciliation and mention notification are distinct operations. Every successful content mutation reconciles current typed references. A publication boundary determines which newly added people/agent mentions are eligible for attention.

| Surface | Publication boundary |
| --- | --- |
| Chat messages and thread replies | Successful Send; an explicit edit save can publish newly added mentions. |
| Task comments | Successful Post; any supported explicit edit save follows the same rule. |
| Wiki body | Explicit Notify mentions after Save succeeds. |
| Autosaved task descriptions and notes | Explicit Notify mentions flushes the latest save and publishes its captured hash. Autosave, blur and navigation do not notify. |
| Personal MCP writes | Successful authenticated write with an explicit validated publication intent. Existing supported chat sends retain their semantics. |
| Agent writes, imports and system maintenance | Reconcile references. Default to passive content with no automatic agent invocation; any human notification policy must be explicit in the authenticated writer contract. |

For autosaved surfaces, retain pending mention additions until a successful publication. Navigation and reopening do not infer publication intent. If saving fails, show the failure and retain pending state for retry. Restoration never sends a delayed ping merely because a draft was reopened.

Store the current reference set, the last published recipient set and monotonic revision per source field/anchor. Compare the final published set with the previous published set. Mentioning the same recipient twice in one publication produces one attention effect. Removing and re-adding a person within the same unfinished edit produces none if that person was already published. A removal followed by a later separate publication adding that person can notify again. Self-mentions create no notification.

Commit content and an identity-only reconciliation job together using a native-source database trigger. Core reconciliation locks and reads current source content, so all writers converge without changing every writer. Authenticated human Send/Post commits a hash-bound publication-intent job in the content transaction; persisted human author IDs cannot attest intent because governed agent writes may use them. Explicit publication verifies the saved content hash, then commits published recipient state, a durable delivery ledger and its delivery job together using the existing queue executor. A worker creates the eligible notification/attention idempotently, keyed by organization, publication, source and recipient. Effect dedupe must survive queue-row pruning. Retries, lost HTTP responses and repeated edit completion events cannot produce duplicate attention.

Workers reload current source state, recipient access and active membership. A stale job cannot recreate removed backlinks or deliver content from a deleted/revoked source. Notification clicks, attention reads and counts also apply live visibility. Delivery follows existing preferences and mute policy; a suppressed notification does not grant access or imply successful delivery.

### Persistence and backlinks

Compatibility review correction: preserve `crossReferences` and its uniqueness key. Existing conflict-target callers depend on that key. Store a bounded reference set per source in a dedicated Core state table; source kinds and IDs provide field/anchor ownership. Existing manual/module/wiki relationships remain untouched. See the [architecture decision](../../decisions/2026-10-02-native-mentions.md).

Add a narrow per-source publication state/ledger for current and published mention sets, revision and durable effect identity. Use the existing database job queue and attention records. No new broker or separate agent inbox is required. Freeze the exact columns, indexes and deletion behavior in step 1 after checking all current cross-reference writers.

Reconciliation replaces only the inline-origin set owned by that exact source field/anchor. Existing wiki related links, task-wiki citations, module relationships and manual edges keep their owning behavior. Backlink readers deduplicate displayed sources and require the viewer to see both target and source, including counts and snippets. New typed backlinks have removal guarantees; legacy related edges do not gain invented provenance during this rollout.

Source deletion removes its inline edges and invalidates pending attention. Target deletion or access revocation produces a neutral unavailable reference for unauthorized viewers, with no stale title, preview or navigation. Renaming resolves a new authorized label against the same identity. A recipient who cannot read the source is not notified; existing explicit sharing can be offered when supported, without automatic membership or ACL changes.

### Agent attention and explicit requests

Persist outside-chat agent mentions as attention owned by the agent's existing user identity. Add identity-bound employee MCP read/acknowledge adapters to the existing attention helpers and registry; neither accepts an arbitrary recipient ID. Include passive mention attention in `fetch_unread` as a separate response field, preserving its existing messages and pending actions.

An acknowledgement records receipt, not task assignment, execution or completion. Do not create a chat-dispatch job, pending executable action or runtime channel event merely because a document mentions an agent. Test the existing bridges as well as the server so passive attention cannot be misclassified as work. Agents that do not consume the supported attention interface cannot be shown as having received a mention; display pending/unacknowledged status honestly.

Provide an explicit Request action on an agent reference that opens the existing shared chat composer. The human writes and sends the request through current chat dispatch, trust checks, approvals and receipts. Source-context prefill is deferred; no private document body is copied into the conversation. Avoid a new document-specific agent runner or conversation table.

Agent-authored content cannot automatically wake another agent. Quoted or retrieved text and imports cannot become invocation authority. Keep `@here` and `@all` under existing chat-specific policy; they are not universal document broadcast targets.

## Delivery steps

### Step 0 — Establish the execution baseline

Refresh current master, inspect attached worktrees and preserve existing changes. Reuse a suitable clean worktree or create an isolated one from the current merged baseline. Follow `CONTRIBUTING.md` for the tracking issue before substantial implementation, and link this plan there. Inspect changes against the active Platform candidate before bringing over any native resource contracts.

Record the source SHA, relevant dependencies and the writer inventory for all V1 sources. Check the task visibility and wiki save fixes that affect this feature. Read `apps/web/AGENTS.md` and the installed Next.js guides before frontend implementation. This step is complete when the baseline, scope and dependency dispositions are recorded; it does not require completing unrelated Email work.

### Step 1 — Implement the Core contract and save service

Primary packages: `packages/shared`, `packages/db`, API libraries and workers.

- Add native target/source schemas, lossless codecs and source authorization adapters. Converge the resource contract with Platform's additive native identities.
- Add dedicated source reference/publication state and persistent effect dedupe; preserve existing relationship stores and their indexes. Generate the additive schema migration and supported release upgrade together.
- Implement a proposed `native-mentions` Core service for extracting, validating, reconciling and publishing mentions. New names are provisional; follow package-local conventions.
- Atomically enqueue attention delivery through the existing queue. Wire create/update/delete semantics and render-time resource resolution.
- Cover stale writes, transaction rollback, retries, active membership, recipient visibility and unauthorized backlink queries before adding UI callers.

Exit evidence: direct service tests prove stable refs, removal, isolation and one eligible attention effect for a repeated publication. Fresh schema and supported upgrade paths both pass in disposable databases. Nothing in the service assumes a particular editor or an agent runtime.

### Step 2 — Ship the first complete journey in chat

Primary paths: `rich-composer.tsx`, `mention-autocomplete.tsx`, chat/thread renderers, message routes and shared message writers.

- Extract one picker with the four target groups, bounded authorized search and organization/session-scoped caching. Handle keyboard, touch, composition input and stale requests.
- Add shared reference insertion/rendering and accessible authorized previews. Implement task/wiki backlink navigation to an exact message or reply.
- Integrate message create, explicit edit and delete with the Core service. Inventory human MCP chat writers and preserve current direct agent dispatch without duplicate notifications or runs.
- Keep legacy chat content readable. Avoid running the old regex worker and new typed service as competing owners of the same inline edge.

Exit evidence: the Sam/task/wiki example works end to end through chat and a thread reply, with exact notification navigation, visible backlinks and removal after editing. Existing `@agent` invocation still produces one normal dispatch. REST and supported personal MCP chat sends agree.

### Step 3 — Adopt task descriptions and comments

Primary paths: `task-detail.tsx`, task routes, personal/employee MCP task writers and agent comment actions.

- Reuse the picker/node instead of adding another mention implementation. Preserve canonical refs through comment serialization rather than flattening selected targets to names.
- Cover task creation, description edits, comment creation and every supported comment mutation. Use Notify mentions to publish autosaved descriptions after saving.
- Replace fuzzy routing for new typed mentions and feed exact task/comment anchors into notifications and backlinks.
- Integrate direct task writers with Core reconciliation and the declared publication policy. Keep assignment and existing assigned-agent comment events separate from mention effects; test their combined behavior to prevent duplicate work.

Exit evidence: a newly created task description can notify eligible people, unrelated edits do not re-ping them, comment refs survive reload, restricted tasks remain undiscoverable, and supported API/MCP/agent writers satisfy their declared behavior.

### Step 4 — Adopt wikis, notes and passive agent attention

Primary paths: knowledge and notes pages, note save coordinator, wiki/note routes and writers, attention helpers and employee MCP registry.

- Add the Markdown adapter to the wiki editor and the shared TipTap adapter to notes/daily notes. Preserve existing save coordination and prevent a response for one document from applying to another.
- Publish wiki and note mentions through Notify mentions only after the latest save succeeds. Show pending/failure states without claiming delivery.
- Add authorized task/wiki backlink displays for these sources, including exact document/field navigation and deletion cleanup.
- Expose passive agent attention with employee-bound read/acknowledge operations and the compatible `fetch_unread` addition. Add the explicit Request action through existing chat.

Exit evidence: all V1 sources support all four target groups. An offline agent's passive attention remains durable, its later acknowledgement is visible, and no runtime starts from document publication. A human's explicit chat request still invokes the existing governed path.

### Step 5 — Certify and enable the native rollout

Complete the acceptance matrix below on the integrated candidate. Record source SHA, final diff, test results, schema versions and rendered desktop/mobile evidence. Enable the feature for a small pilot workspace first using a host-controlled rollout gate, then widen after the full native journey passes.

App Kit integration is a follow-up: expose host-owned search, resolution, rendering and publication hooks for installed app resources/surfaces, using governed resource adapters. Extensions may supply records; Core continues to enforce tenant context, access, dedupe and agent invocation policy. Do not include Email/provider writes in native certification.

## Acceptance and validation

| Area | Required evidence |
| --- | --- |
| Native coverage | Each V1 source can select, save, reload and navigate people, agents, tasks and wiki refs. Comments and wiki Markdown preserve identity. |
| Notifications | Create/newly published mentions notify once; repeat saves, transport retries, worker retries, duplicate recipients and self-mentions do not add pings. Removal/re-add follows publication rules. |
| Autosave | Continuous typing causes no alerts. Notify mentions publishes the captured saved revision once. Picker selection, failed save, navigation during save and reopen behave predictably. |
| Tenant and access | Cross-org IDs, inactive members, restricted search, recipient access, revoked membership, deleted resources, backlink snippets/counts, API payloads and exports preserve visibility. No implicit share/watch grant. |
| Edit concurrency | Out-of-order saves and delayed jobs cannot resurrect removed refs or notify from obsolete content. Switching documents cannot apply the old document's results. |
| Links and navigation | Rename preserves identity. Exact message/comment anchors work. Task/wiki refs remove their inline backlinks when removed; manual/module/wiki relations survive. |
| Agent behavior | Outside-chat mentions persist/read/ack without a run or executable action. Existing bridges do not consume passive attention as work. Explicit Request uses normal chat governance; agent text cannot create wake cascades. |
| Writer parity | Native UI, supported REST mutations, personal MCP and employee/agent writers follow the same reconciliation contract and their documented publication intent. |
| Compatibility | Existing chat markers, UUID spans, task identifiers and existing related-link stores remain readable. New reference attributes pass sanitizers; forged HTML/links do not grant authority. |
| UI | Inspect at representative desktop and mobile widths, including a 390 px viewport: keyboard/touch use, screen-reader labels, grouped search, long names, IME, loading, empty/error and unavailable states. |
| Upgrade and recovery | Fresh creation and supported upgrade produce equivalent feature state. Rolling feature writes off preserves data and does not replay historical notifications. |

Use existing checks and package scripts, updated for the chosen execution baseline. Add behavioral tests where the new contract changes persistence, visibility or delivery. Representative focused entry points already present on reviewed master include `agent-mention-normalization.test.ts`, `agent-mention-detection.test.ts`, `notes-cross-reference.test.ts`, `attention-system.test.ts`, `attention-signal-policy.test.ts`, `agent-channel.test.ts`, `note-save-coordinator.test.ts` and `editor-attribute-security.test.ts`.

The API runner accepts focused test paths and requires a distinct disposable `DEFT_TEST_DATABASE_URL` outside CI. Never seed, upgrade or run database-writing tests against the active application database. Add new mention service/API test files to that runner; illustrative new names are `native-mentions.test.ts` and `native-mentions-http.test.ts`.

At completion, run one consolidated relevant pass:

```text
pnpm --filter @deft/shared test
pnpm --filter @deft/api test
pnpm typecheck
pnpm --filter @deft/web lint
pnpm build
pnpm test:upgrade
git diff --check
```

Run focused web tests with the repository's existing `tsx --test` convention, quoting paths containing `(app)` on PowerShell. Include sanitizer, codec, picker and save-coordinator behavior. Provision separate disposable databases for `pnpm db:push-full` and `pnpm db:upgrade` rehearsals, and inspect actual desktop/mobile behavior. A build does not substitute for notification, database or UI evidence. Run the required CI checks for the chosen PR and release scope.

## Rollout, rollback and completion

Use additive schema changes. Existing rows receive legacy provenance; do not backfill notification effects or re-publish historical mentions. A silent, resumable backfill of qualified legacy references is optional follow-up work after provenance and visibility can be proved.

The rollout gate controls new picker/writer integration and mention publication. Reader compatibility ships before typed writes are enabled. If rollout is disabled, stop new publications and pause pending feature delivery jobs while retaining their durable state; continue decoding already-written references. Recover by resuming eligible publications with the same identities after access/current-state checks. Do not drop schema or restore an old binary that cannot safely read new content as an emergency rollback shortcut.

Completion means the complete native acceptance matrix has fresh evidence, affected access/save dependencies are resolved on the integrated candidate, and implementation limitations are documented. Planning completion only means this scope, architecture choice, sequence and acceptance evidence are recorded.

Product priority remains a provisional **high win / medium-to-high effort** judgment for small teams using agents. The first chat journey is the earliest demonstrable milestone. Authorization, durable publication, writer parity and passive agent delivery account for most of the full rollout effort; a picker prototype alone is not the shipped feature.

## Source references

- [Merged resource v1 contracts](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/packages/shared/src/resources.ts), [candidate additive native contracts](<C:/tmp/deft-gate-g-integration-20260924/packages/shared/src/resources-v2.ts>).
- [Merged chat mention parser](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/lib/mentions.ts), [message routes](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/routes/messages.ts), [task routes](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/routes/tasks.ts).
- [Transactional persisted queue](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/lib/queues.ts), [attention helpers](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/lib/attention.ts), [employee MCP message reads](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/apps/api/src/lib/mcp-tools/messages.ts).
- [Existing Hermes channel bridge](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/scripts/hermes-agent-channel-bridge.mjs), [cross-reference schema](https://github.com/Maneek21/Deft/blob/94626051299decb231b48bead1144a716cd7873d/packages/db/src/schema.ts).
- [repository contribution rules](../../../CONTRIBUTING.md), [frontend rules](../../../apps/web/AGENTS.md).

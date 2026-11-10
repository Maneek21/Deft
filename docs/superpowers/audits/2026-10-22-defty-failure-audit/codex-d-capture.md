Found **13 actionable defects: 4 P1 and 9 P2**. No P0 established.

This remained read-only: no files changed, server started, or database accessed. Focused tests could not start because `pnpm` is unavailable on PATH. The requested capture/storm tests also create database fixtures, so I did not run them. **CONFIRMED below means traced through the current code, not runtime-reproduced.**

**D01 — P1 — Daily standups disclose restricted tasks**

- **Evidence:** [standup-automation.ts:67](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/standup-automation.ts:67>), `:88`, and `:109` filter tasks by organization, deletion, and activity/status, without a visibility predicate. `apps/api/src/lib/task-visibility.ts:5` defines the missing guard: `coalesce(${tasks.metadata}->>'visibility', 'org') != 'restricted'`. Standup evidence includes `${row.title}` and assignee names at `standup-automation.ts:139–156`; it reaches the default channel at `:260–265` and organization dashboards through `apps/api/src/routes/dashboard.ts:309–325`.
- **Failure scenario:** Alice’s restricted task is the only recently updated active task. The standup includes its title and owner, even using the provider-free fallback. Other members receive confidential task information.
- **Confidence:** **CONFIRMED**, including the deterministic fallback.
- **Fix sketch:** Apply `unrestrictedTaskCondition()` to all three shared standup task queries. Test restricted and unrestricted completed, active, and overdue tasks; assert restricted identifiers, titles, and owners never enter evidence or delivered summaries.

**D02 — P1 — Batch capture ignores explicit “do not save” instructions**

- **Evidence:** [chat-observation.ts:16](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/chat-observation.ts:16>) recognizes `do not save` and `keep ... in chat`; `:30–34` marks such messages ignored. Independently, `apps/api/src/workers/handlers/chat-knowledge-batch.ts:527–544` selects messages without consulting observation status or that directive helper. It uses deterministic fallback at `:409–410` and passes `autoApprove: true` at `:605`. `apps/api/src/lib/defty-capture.ts:870–887` validates the source but performs no consent check.
- **Failure scenario:** In a public space, post: `Decision: customer delivery process now requires signoff. Do not save this; keep this in chat.` The observer ignores it, but the batch recognizes durable/domain signals and automatically saves organization-wide knowledge. This works without an AI provider.
- **Confidence:** **CONFIRMED**, traced through fallback, capture, and execution.
- **Fix sketch:** Exclude opted-out evidence before episode classification, then defensively check original source content at capture time. Test every supported opt-out phrase with and without a provider; expect no capture intent, approval, or wiki page.

**D03 — P1 — Automatic refinements replace existing knowledge with partial content**

- **Evidence:** [chat-knowledge-batch.ts:488](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/workers/handlers/chat-knowledge-batch.ts:488>) supplies only the current episode’s `classification.content || classification.summary`; `:605–606` sets `autoApprove: true, preferUpdate: true`. `apps/api/src/lib/defty-capture.ts:628–636` accepts loose related-page matches, including title containment and `bodyOverlap >= 0.48`. At `:693` and `:706–708`, the update becomes `patch: { content: updatedBody, summary }`. `apps/api/src/lib/mcp-tools/wiki-create.ts:512–518` assigns `update.content = content`.
- **Failure scenario:** An established delivery decision contains the delivery day, cutoff, backup carrier, and escalation procedure. A later discussion reiterates the day and adds an owner. Matching selects the established page; automatic replacement removes the cutoff, carrier, and escalation clauses from its current body.
- **Confidence:** **CONFIRMED**. Revision history preserves a recovery copy.
- **Fix sketch:** Stop automatically replacing merely related pages. Append an attributed refinement or require review until merging receives the existing body. Test a partial refinement against a multi-clause page and assert all unaffected clauses survive.

**D04 — P1 — Standup socket delivery bypasses channel membership**

- **Evidence:** [standup-automation.ts:269](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/standup-automation.ts:269>) broadcasts the complete message using `getIO()?.to(\`org:${input.orgId}\`).emit('message:new', ...)`. `apps/api/src/socket.ts:307–313` puts authenticated organization users in that room. Space joins require authorization at `:357–363`; membership revocation removes only the space room at `:143–147`.
- **Failure scenario:** A guest outside the default channel—or a member removed from it—keeps an organization socket connection. They receive the default channel’s standup message despite lacking permission to read that channel.
- **Confidence:** **CONFIRMED**, producer and recipient-room paths traced.
- **Fix sketch:** Deliver through the authorized space delivery path. Test connected current members, nonmember guests, and removed members; only current members should receive the message. This remains necessary after D01.

**D05 — P2 — The “quiet” cutoff hides recent corrections before capturing decisions**

- **Evidence:** [chat-knowledge-batch.ts:509](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/workers/handlers/chat-knowledge-batch.ts:509>) computes `before = now - quietMs`; `:543` filters with `lt(messages.created_at, before)`. Episodes are constructed afterward from the truncated context at `:559–568`. Capture claims the discussion settled at `:581` and automatically approves at `:605`.
- **Failure scenario:** At 10:00, the channel contains a 09:50 customer-launch approval and a 09:55 correction withdrawing it. The eight-minute cutoff includes the approval and excludes the correction. Defty can publish the withdrawn decision as settled knowledge.
- **Confidence:** **CONFIRMED**, including provider-free execution.
- **Fix sketch:** Fetch recent context first, then defer episodes whose latest activity falls inside the quiet period. Conservatively deferring recently active spaces is a smaller initial fix. Test an old decision followed by a recent reversal; capture must wait and eventually see both.

**D06 — P2 — Private-space captures fail even after Defty is explicitly invited**

- **Evidence:** [ensure-defty-membership.ts:87](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/ensure-defty-membership.ts:87>) sets the internal employee’s `is_deleted: true`; new employees receive the same at `:119`. `apps/api/src/lib/agent-approval-resolver.ts:790–792` explicitly permits hidden `defty_system` employees. Conversely, `apps/api/src/lib/mcp-tools/employee-space-access.ts:29–41` requires `eq(agentEmployees.is_deleted, false)` before checking private membership. Wiki creation rejects this access failure at `apps/api/src/lib/mcp-tools/wiki-create.ts:193–197`. Capture does not propagate automatic execution failure; the batch counts `result.queued` at `chat-knowledge-batch.ts:608`.
- **Failure scenario:** Invite Defty into a private channel and post a capturable decision. An intent/action is queued, execution rejects Defty’s hidden identity, and no page appears. Reinviting Defty cannot resolve the contradictory predicates.
- **Confidence:** **CONFIRMED**, authorization and failure-reporting paths traced.
- **Fix sketch:** Permit the narrowly defined operational system identity while retaining actual private-space membership checks. Return execution failure to capture callers. Test invited success, uninvited denial, and accurate failure reporting. Land consent safeguards before enabling additional private writes.

**D07 — P2 — The batch schedule permanently misses messages**

- **Evidence:** [chat-knowledge-batch.ts:15](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/workers/handlers/chat-knowledge-batch.ts:15>) sets a 35-minute lookback and eight-minute quiet period. Predicates at `:542–543` therefore cover only **27 minutes**. `apps/api/src/workers/index.ts:41` schedules `'chat-knowledge-batch': 30 * 60_000`.
- **Failure scenario:** Runs occur at 10:00 and 10:30. A 09:53 decision is too recent at the first run and too old at the second. It is never considered. Execution delays enlarge this gap.
- **Confidence:** **CONFIRMED**, interval arithmetic and scheduled caller traced.
- **Fix sketch:** Immediately extend lookback beyond interval plus quiet period and scheduling margin. Use a durable watermark for reliable downtime recovery. Test consecutive and delayed scans, asserting eventual capture without duplicate writes.

**D08 — P2 — A mandatory domain vocabulary rejects ordinary workplace decisions**

- **Evidence:** [chat-knowledge-batch.ts:103](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/workers/handlers/chat-knowledge-batch.ts:103>) defines `hasDomainWorkSignal()` using a fixed vocabulary containing `buyer|route|truck|...|harvest|...|greenhouse|irrigation|pest|...|farm`. At `:313`, `if (!hasDurable || !hasDomain)` rejects the episode. The post-model guard at `:392–396` also rejects durable results lacking those transcript keywords.
- **Failure scenario:** `Decision: use PostgreSQL 16 for all persistence.` contains an explicit durable decision but no accepted domain word. It becomes noise without a provider and remains rejected even if a model correctly classifies it.
- **Confidence:** **CONFIRMED**, deterministic and post-model paths traced.
- **Fix sketch:** Remove the mandatory domain vocabulary from acceptance. Retain generic durable-decision and social/task rejection checks. Test engineering, security, and HR decisions alongside existing social negatives.

**D09 — P2 — Recovery retries duplicate standup posts and meeting notifications**

- **Evidence:** [standup-automation.ts:239](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/standup-automation.ts:239>) inserts a standup, then separately inserts its message at `:260`; only `:277–283` marks the run delivered. `apps/api/src/lib/automation-runs.ts:57–76` reclaims failed or stale runs. `apps/api/src/lib/meeting-prep-automation.ts:279–287` similarly inserts a notification before delivery completion at `:296–302`, without a delivery dedupe key.
- **Failure scenario:** A delivery commits, then the process crashes before updating the run. Recovery reclaims that run and repeats the inserts. Standup rows/messages duplicate; meeting briefs upsert correctly, but their notifications duplicate.
- **Confidence:** **CONFIRMED**, crash-window and recovery transitions traced.
- **Fix sketch:** Atomically persist run-owned output, delivery records, and completion, with uniqueness tied to the run; emit sockets after commit. Fault-inject failure after each delivery write, retry, and assert exactly one persisted delivery.

**D10 — P2 — Today’s standup disappears when the server date changes**

- **Evidence:** [standup-automation.ts:216](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/standup-automation.ts:216>) uses the organization-local date for its run key; `:241–245` stores `date: now` and `date_key: local.dateKey`. `apps/api/src/routes/dashboard.ts:17–18` instead computes server-local midnight and filters standups by those bounds at `:314–315`.
- **Failure scenario:** With a UTC server and a UTC+14 organization, the October 23 09:00 standup is stored at October 22 19:00Z. At October 23 14:00 local, server midnight changes the dashboard query and removes that same-day standup. Regeneration finds the existing organization-local run.
- **Confidence:** **CONFIRMED**, generation and retrieval date calculations traced.
- **Fix sketch:** Retrieve by the stored organization-local date key, or calculate organization-day UTC bounds. Test positive and negative timezone offsets across server midnight.

**D11 — P2 — Knowledge deduplication misses existing pages beyond an arbitrary 250-row subset**

- **Evidence:** [defty-capture.ts:578](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/defty-capture.ts:578>) ends duplicate lookup with `.limit(250)`; related-page lookup repeats it at `:618`, and explicit-update lookup at `:277`. These scans have no complete matching fallback. The create path follows at `:972`, with dedupe identity tied to fresh source messages.
- **Failure scenario:** More than 250 pages share a type/scope. An existing matching page is outside the returned subset. A later discussion repeats that knowledge with new message IDs, and Defty creates another page rather than finding the existing one.
- **Confidence:** **CONFIRMED**, bounded lookup and create fallback traced.
- **Fix sketch:** Retrieve exact matches before bounded similarity search, or paginate the complete relevant set. Test matching and correction targets excluded from the old 250-row subset.

**D12 — P2 — Passive classification has no spend bound and charges for ordinary chatter**

- **Evidence:** [observe-chat-message.ts:443](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/workers/handlers/observe-chat-message.ts:443>) calls `classifyMessage()` for every human message surviving the short deterministic ignore rules. `apps/api/src/lib/classifier.ts:225–243` makes a model request whenever a provider exists; `maxTokens: 512` limits output only. `apps/api/src/lib/llm.ts:143–145` explicitly applies no per-organization spend gating. Episode classification adds further calls at `chat-knowledge-batch.ts:413–415`.
- **Failure scenario:** A busy channel sends 1,000 substantive but nonactionable chat messages. That creates 1,000 classification requests before downstream social rejection, plus eligible episode calls. There is no passive-classification spending ceiling.
- **Confidence:** **CONFIRMED** for request behavior; actual monetary impact needs measurement.
- **Fix sketch:** Add an explicit passive-classification quota/token budget and fall back locally when exhausted; avoid model calls for confidently rejected content. Test ten messages against a configured two-call budget and assert only two provider calls.

**D13 — P2 — “Grounded” automation output accepts claims with no sources**

- **Evidence:** [automation-synthesis.ts:5](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/automation-synthesis.ts:5>) permits `source_ids: z.array(...).max(8).default([])`. Validation at `:35–43` checks only supplied IDs. This contradicts the “cite at least one supplied source per item” prompts in `standup-automation.ts:192` and `meeting-prep-automation.ts:216`.
- **Failure scenario:** Model output containing `{"text":"Alice shipped the launch.","source_ids":[]}` passes validation and is rendered, even when no supplied evidence supports it. Omitting `source_ids` also passes.
- **Confidence:** **CONFIRMED**, validator-to-render path traced. Provider frequency is unmeasured.
- **Fix sketch:** Require `.min(1)` and remove the empty default. Test omitted, empty, unknown, and valid source references. This enforces citation presence; semantic support still requires separate checking.

**Ranked top five**

1. **D01:** Restricted task information disclosed through shared standups.
2. **D02:** Explicit knowledge opt-out bypassed by the batch worker.
3. **D03:** Existing knowledge automatically replaced with incomplete content.
4. **D04:** Channel membership bypassed by organization-wide socket delivery.
5. **D05:** Recent corrections omitted before automatic decision capture.

**Proposed independent work packages**

| Package | Findings / files touched | Dependencies and verification |
|---|---|---|
| Shared standup authorization | D01, D04: `standup-automation.ts`; authorization/socket tests | Start immediately. Verify restricted-task exclusion and current-member-only delivery independently. |
| Capture consent and private authorization | D02, D06: `chat-knowledge-batch.ts`, `defty-capture.ts`, `employee-space-access.ts`; capture tests | Implement consent filtering before relaxing the hidden-system predicate. Verify opted-out messages never capture, invited private capture succeeds, and uninvited capture fails. |
| Safe refinement and complete dedupe | D03, D11: `defty-capture.ts`, `defty-capture-dedupe-update.test.ts` | Logically independent. Verify preservation of old clauses, ambiguous matches, and matching beyond 250 pages. |
| Complete, settled, generic episodes | D05, D07, D08: `chat-knowledge-batch.ts`, worker schedule if needed, batch tests | Coordinate edits with consent package. Use fixed clocks and mocked dependencies for recent corrections, scan gaps, delayed runs, and generic decisions. |
| Idempotent automation delivery | D09: both automation files, `automation-runs.ts`; schema/migration if uniqueness is added | Independent. Fault-inject around every delivery boundary and verify single persisted delivery after retries. |
| Organization-day lookup | D10: `dashboard.ts`, shared date helpers/tests | Independent. Verify the same organization day across server-midnight boundaries. |
| Passive model-cost controls | D12: observer, classifier, batch classification, configuration/tests | Independent of delivery fixes. Verify explicit quotas and local fallback with mocked provider calls. |
| Enforced citation contract | D13: `automation-synthesis.ts`, synthesis tests | Independent and small. Reject missing/empty/unknown references; accept valid references. |

Run focused package checks during implementation, then one consolidated API validation pass. Database integration and socket tests should use an explicitly disposable test environment.

**Open questions needing runtime verification**

- Confirm the disclosure paths with real guest/removed-member sockets and restricted tasks; neither was exercised here.
- Measure passive classifier request volume, latency, and spend under representative traffic and provider outages.
- Verify recovery behavior by terminating a worker immediately after delivery commits.
- Establish the intended opt-in contract. Persisted `orgs.agent_enabled` and `spaces.agent_enabled` exist, but the reviewed passive paths do not enforce them; no exposed setting was found.
- Decide whether a later “keep this discussion in chat” instruction suppresses the entire episode or only that message.
- Confirm intended no-provider behavior: standups, meeting preparation, and deterministic knowledge capture currently continue through fallbacks.
- Passive task extraction currently returns `false` unconditionally in `observe-chat-message.ts:277–290`; immediate memory capture is also disabled at `:500`. I therefore excluded dropped task due dates and other unreachable task-extraction defects from the ranked findings.
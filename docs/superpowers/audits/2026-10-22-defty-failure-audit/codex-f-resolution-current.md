**The rehearsal exposed real discovery gaps. Current master fixes several of them, but Defty still lacks a shared entity-resolution layer, and the SSE path can still turn an incomplete search into an unsupported “nothing exists” answer.**

Audited HEAD and `origin/master`: `388f0a0bb9d002a4e753d9b4c6f7adab90c40a1e`. Read `AGENTS.md`. Modified nothing, started no server, accessed no database, and ran no tests.

Historical comparison matters: commit `d071db30`, dated **18 October 2026, 19:43:10 +05:30**, added ordinary member/space discovery and improved task/message search. The rehearsal’s deployed hash and timing relative to that commit are unknown. Historical findings below are explicitly revision-qualified; conclusions about the exact rehearsal query arguments are labelled **inference**.

**The two rehearsal failures, assessed against today’s code**

| Rehearsal | Supported explanation | Would it still happen today? |
|---|---|---|
| “summarize the REL261018 Northstar Launch project and the launch-room conversation” → no records, citing its own DM | The earlier task SQL fallback searched **task titles**, not project names. Message search searched the supplied phrase **inside message content**, including the requesting DM. Wiki search did not cover tasks/chat. SSE accepted the model’s final answer without checking whether its evidence covered the requested project and room. | The discovery capabilities are improved: project-name task search, `list_projects`, `list_spaces`, and latest-room message reads now exist. Nevertheless, poor query selection and the unsupported absence conclusion remain possible, particularly through SSE. |
| Could not resolve “assign to Noah Chen” or requester “Maya Rao [REL261018]”; native mentions returned `{enabled:false}` | The available discovery tool was disabled, and the SSE prompt supplied no authoritative requester identity. Existing assignment helpers were hidden behind write execution; they were not a general discovery mechanism available to the model. | The specific flag dependency is fixed: ordinary `search_members` works independently of native mentions. Unique full names should now resolve if that tool is used. Requester binding, nicknames, pronouns, and inconsistent task-key handling remain gaps. |

### Current message-to-entity flow

**Queued chat uses model-selected tools, followed by stronger proposal resolution.**

`routes/messages.ts` detects Defty mentions and automatically invokes it in eligible Defty DMs/conversations, then queues `agent-reply` with the actor, space, message, parent and content. It does **not** enqueue a resolved entity set. [messages.ts:701](C:/tmp/deft-defty-current-20261022/apps/api/src/routes/messages.ts:701), [messages.ts:755](C:/tmp/deft-defty-current-20261022/apps/api/src/routes/messages.ts:755)

The worker:

1. Loads conversation history and limited surface information.
2. Removes the Defty invocation.
3. Calls `runAgentQuery`.
4. Preserves grounded runner proposals; invokes the action compiler/fallback recovery when appropriate.
5. Validates proposals and resolves selected targets before creating approval cards.

Despite the nearby “compiler first” comment, ordinary execution is **runner first, compiler recovery**. Attachment import compilers are an earlier special case. [agent-reply.ts:1516](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:1516), [agent-reply.ts:1598](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:1598), [agent-reply.ts:1666](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:1666), [agent-reply.ts:1903](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:1903)

`runAgentQuery` advertises tools, supplies history, automatically retrieves wiki context, then lets the model choose searches and their arguments. There is no preceding universal pass that resolves people, tasks, projects and spaces into canonical IDs. [agent-runner.ts:295](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-runner.ts:295), [agent-runner.ts:380](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-runner.ts:380), [agent-runner.ts:485](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-runner.ts:485)

**The observation classifier is a separate pipeline, not that missing resolution pass.**

It extracts textual `entities.assignee`, `entities.project`, dates and task references, and stores them in classifications. The reply job is independently dispatched; those classifications are not passed into `runAgentQuery` as resolved identities. Background task extraction is currently disabled by `shouldQueueTaskExtraction()` returning `false`. [classifier.ts:6](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/classifier.ts:6), [observe-chat-message.ts:443](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/observe-chat-message.ts:443), [observe-chat-message.ts:277](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/observe-chat-message.ts:277)

**SSE/legacy remains live and uses a different loop.**

`/api/agent/conversations/:id/messages` calls `buildStreamContext()` and `runAgentStreamingLoop()`; `/continue` rebuilds the same context. It shares `executeToolCall()` with queued chat, so current search improvements apply to SSE too. It does **not** pass through the queued worker’s proposal-resolution pipeline. [agent.ts:1156](C:/tmp/deft-defty-current-20261022/apps/api/src/routes/agent.ts:1156), [agent.ts:1189](C:/tmp/deft-defty-current-20261022/apps/api/src/routes/agent.ts:1189), [agent.ts:1236](C:/tmp/deft-defty-current-20261022/apps/api/src/routes/agent.ts:1236), [agent-stream-loop.ts:357](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-stream-loop.ts:357)

### What context actually reaches the model

| Context | Queued chat | SSE |
|---|---|---|
| Ordinary DM history | Last **10 top-level messages**, excluding current request, chronological after reversal; human messages carry display-name prefixes. | All message rows in the conversation, ascending; **no history count limit**. |
| Threads | Last **10 replies**, plus thread root where applicable. A new channel invocation ordinarily has no earlier channel discussion in that history. | No thread-specific selection; loads the whole conversation space. |
| Current channel’s surrounding discussion | Special discussion-to-task commands fetch up to **80** earlier top-level human messages, then retain up to **40** after boundary filtering. This is conditional, not normal question context. | No separately assembled surrounding-channel context. |
| Current surface | Type/name; optional other DM member name. Channel name appears in the prompt. | No authoritative current-room name/ID prompt block. |
| Requester | Internal `userId`; sometimes visible through DM hint/history. Compiler recovery receives caller **name**. | Internal actor ID reaches tools, but no authoritative requester-name/ID prompt block. |
| Space membership roster | Not supplied. One “other member” is fetched for DM context. | Not supplied. |
| Recently touched tasks | No automatic native-task context pack. Narrow prior-Defty-reference recovery exists for writes. | No automatic native-task context pack. |
| Automatic retrieval | Wiki significant-word prefetch, maximum **2**, plus shared wiki retrieval, maximum **3**. | Wiki retrieval, maximum **5**, plus memories. |

Sources: [agent-reply.ts:1377](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:1377), [agent-reply.ts:1502](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:1502), [agent-reply.ts:1527](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:1527), [agent-runner.ts:363](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-runner.ts:363), [agent-runner.ts:396](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-runner.ts:396), [agent.ts:613](C:/tmp/deft-defty-current-20261022/apps/api/src/routes/agent.ts:613), [agent.ts:754](C:/tmp/deft-defty-current-20261022/apps/api/src/routes/agent.ts:754), [agent.ts:866](C:/tmp/deft-defty-current-20261022/apps/api/src/routes/agent.ts:866)

Consequently, **being asked in a space does not automatically give Defty that space’s recent conversation, members and active tasks**. In queued channels it knows the name, but still must turn “this channel” into appropriate tool arguments. In SSE even that name is absent from the explicit surface contract.

### People: full names, suffixes, nicknames, “me” and ambiguity

Today’s ordinary `search_members` explicitly works without native mentions and invokes `resolveAssigneeWithMatches()`. It returns one member or structured `MEMBER_NOT_FOUND` / `MEMBER_AMBIGUOUS` results with candidates. [agent-tools.ts:70](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-tools.ts:70), [agent-context.ts:283](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:283)

The resolver searches active org members or active, nondeleted, healthy employee users, in this order:

1. Exact **user ID**.
2. Exact normalized display name.
3. Unique substring of normalized display name.
4. Otherwise ambiguity or no match.

Normalization only removes diacritics and lowercases. It does not implement nickname aliases, bracket removal, name-token reordering, internal-space normalization, email lookup or requester-relative words. [resolve-assignee.ts:111](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/resolve-assignee.ts:111), [resolve-assignee.ts:129](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/resolve-assignee.ts:129), [resolve-assignee.ts:167](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/resolve-assignee.ts:167)

| Reference | Current canonical behavior |
|---|---|
| `Noah Chen` | Exact normalized name wins; otherwise unique substring can resolve. |
| `Noah` | Resolves only if unique; multiple Noahs produce ambiguity. |
| `Maya Rao [REL261018]`, stored identically | Resolves exactly. Brackets are not inherently a failure. |
| `Maya Rao`, stored as `Maya Rao [REL261018]` | Resolves if unique substring. |
| Suffixed query, stored name only `Maya Rao` | Fails: substring comparison is one-directional. |
| Nickname unrelated to display-name substring | No nickname resolution. |
| `me` / `myself` passed to this helper | Treated literally, not as the actor. |

There are partial exceptions for “me”:

- `list_my_tasks` binds directly to the authenticated actor, including secondary task assignments.
- Compiler normalization replaces `me`/`myself` with `callerName` for task creation and subtasks.
- Generic assignment/bulk compiler calls pass through; they rely on the model following the caller-name instruction. There is no universal actor-ID binding.

[agent-context.ts:498](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:498), [agent-action-proposals.ts:652](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-action-proposals.ts:652), [agent-action-proposals.ts:767](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-action-proposals.ts:767), [agent-action-proposals.ts:1072](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-action-proposals.ts:1072)

Native mentions are separate. The flag requires the literal environment value `'true'`; direct native search while disabled returns `{enabled:false,items:[]}`. Current queued and SSE tool lists hide `native_mentions_search` when disabled, while retaining ordinary `search_members`. [native-mentions.ts:20](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/native-mentions.ts:20), [native-mention-runtime-tools.ts:24](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/native-mention-runtime-tools.ts:24), [agent-runner.ts:297](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-runner.ts:297), [agent.ts:628](C:/tmp/deft-defty-current-20261022/apps/api/src/routes/agent.ts:628)

Some older people reads remain inconsistent: `get_user_activity` and one-on-one preparation still choose the first substring `ILIKE` match rather than using canonical ambiguity handling. [agent-context.ts:1277](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:1277), [agent-context.ts:1985](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:1985)

### Search queries and why existing records disappear

**`search_messages` is literal content search.**

Its content predicate is effectively:

```sql
messages.content ILIKE '%<entire escaped query>%'
```

It does not tokenize the query or search semantic meaning. Supplying a project/room phrase does not automatically search the room name. Current room selection is separate: exact ID or name substring, exact-name preference, then an ambiguity check. Omitting `query` with a resolved room reads latest messages. Default limit is **10**, maximum **50**, newest first. [agent-context.ts:306](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:306)

The accessible universe includes public rooms and rooms the caller belongs to—including their Defty DM. There is no exclusion for the triggering question, requester-authored messages or agent messages. Every returned message receives a citation, even if it is merely the question being answered. Results do not include thread-parent metadata or automatically expand neighboring/thread messages. [agent-context.ts:313](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:313), [agent-context.ts:344](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:344), [agent-context.ts:385](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:385)

**Inference about rehearsal (a):** a searched release/project phrase could occur in Maya’s own DM request while not occurring verbatim in the five launch-room messages. That explains the observed one-result/self-request citation without requiring the room to be missing. The exact tool arguments are unavailable, so this is a supported mechanism, not a recovered execution trace.

Historically, `d071db30^:apps/api/src/lib/agent-context.ts:288` always applied the whole-query content predicate; room lookup at `:300` used the supplied name without adding wildcards. Its tool schema required `query` at `d071db30^:apps/api/src/lib/agent-tools.ts:81`. There was no ordinary `list_spaces`/latest-room discovery sequence.

**`search_tasks` now searches more fields, but still relies heavily on literal/lexical matching.**

Current execution:

- Requests task retrieval, maximum **10** candidate IDs.
- Builds a SQL union of those IDs with whole-query substring matches against **title OR description OR project name**.
- Applies status, priority, overdue, person and project filters.
- Requires unambiguous person/project structural filters.
- Returns at most **20** tasks ordered by `updated_at`, with no pagination/completeness indicator.

[agent-context.ts:396](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:396), [agent-context.ts:428](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:428), [agent-context.ts:452](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:452), [agent-context.ts:468](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:468)

The predecessor’s literal branch searched **only task titles**: `d071db30^:apps/api/src/lib/agent-context.ts:410` and `:415`. Thus a project-name query could legitimately return zero while its six tasks existed.

Today the tool description explicitly recommends:

```text
list_projects
→ search_tasks(project_name: canonicalName)   // omit query
```

That can retrieve the rehearsal project’s six tasks without UUID coaching. It remains a model-selected workflow. Passing the entire summary request as `query` can still overconstrain search. [agent-tools.ts:111](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-tools.ts:111)

**The “semantic” task branch does not provide independent semantic recall.**

`retrieveContext` supports wiki, memories, notes, decisions, tasks and modules—**not people, projects, spaces or chat messages**. For tasks, its mandatory predicate remains:

```sql
search_vector @@ plainto_tsquery('english', query)
```

Vectors change ranking using `0.4 × FTS + 0.6 × cosine`; they do not admit candidates that fail the lexical predicate. A genuine title paraphrase without the required matching lexemes can therefore disappear before vector ranking. [retrieve-context.ts:46](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/retrieve-context.ts:46), [retrieve-context.ts:901](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/retrieve-context.ts:901), [retrieve-context.ts:933](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/retrieve-context.ts:933)

Wiki retrieval has broader literal fallback, but `wiki_search` requests wiki/decision sources, not native tasks or chat. An empty wiki search cannot establish that a project’s tasks or conversation are absent. [native-wiki-owner.ts:145](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/native-wiki-owner.ts:145)

### Projects, spaces and contextual references

Project and space resolution differ between reads and writes.

| Path | Behavior |
|---|---|
| Queued task-create project resolver | Normalizes punctuation/case; recognizes exact/compact names, full canonical names embedded in prose, prefixes and all-name-word matches. Rejects close competing matches. |
| Missing create-project name | May use exactly **one** project linked to the source space. Multiple linked projects trigger clarification. An explicit nonexistent name does not silently fall back. |
| `search_tasks(project_name)` | Exact-name preference over substring candidates; ambiguity/missing errors. |
| `get_project_progress` | Name substring plus `LIMIT 1`; no equivalent ambiguity check. |
| Bare `create_task` executor | Uses pinned project ID if supplied; otherwise first substring match. |
| Write-space resolver | Strips `#`, normalizes punctuation, prefers exact name, accepts a unique substring alias, rejects ambiguity. |
| Read-space resolver | Literal substring/exact-name preference; does not share write resolver’s normalization. |

Sources: [resolve-project-target.ts:24](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/resolve-project-target.ts:24), [resolve-project-target.ts:129](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/resolve-project-target.ts:129), [resolve-project-target.ts:169](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/resolve-project-target.ts:169), [agent-context.ts:457](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:457), [agent-context.ts:912](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:912), [agent-actions.ts:1783](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-actions.ts:1783), [resolve-space-target.ts:12](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/resolve-space-target.ts:12)

Neither space resolver has an explicit `this channel`/`here` binding. Queued prompt/compiler context supplies the name, allowing model substitution; SSE lacks that surface identity block. The richer write-space helper itself accepts only ID/name, not actor/conversation-relative references.

### Drafting and updating tasks

The compiler receives the request, prior reply, successful read facts, project hint, prior task references, up to **50** active project names/prefixes, current-space name and caller name. It receives neither an ordinary member roster nor a general task-candidate set. Its instructions ask the model to select canonical project names and clarify unsafe targets. [agent-action-proposals.ts:607](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-action-proposals.ts:607), [agent-action-proposals.ts:642](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-action-proposals.ts:642), [agent-action-proposals.ts:660](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-action-proposals.ts:660)

Its structured read-fact collector currently retains module reads and `wiki_read`, rather than a common typed projection of task/member/space reads. [agent-compiler-read-facts.ts:4](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-compiler-read-facts.ts:4)

Queued creation then validates the project and parent assignee. Unknown/ambiguous assignees drop the proposal and produce a warning. It pins the project UUID but leaves the person represented by the original name for later resolution. [agent-reply.ts:266](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:266)

Execution is inconsistent:

- `assign_task` rejects missing/ambiguous people, listing ambiguity candidates.
- Bare `create_task` rejects ambiguous people, but a nonambiguous name miss silently leaves the task **unassigned**.
- SSE can reach that bare executor without queued proposal checks.

[agent-actions.ts:1798](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-actions.ts:1798), [agent-actions.ts:2135](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-actions.ts:2135)

**Task keys work differently by action.**

| Input/path | Current behavior |
|---|---|
| `get_task_detail("R2618-4")` | Supports uppercase alphanumeric prefix. |
| `search_tasks(query:"R2618-4")` | Does not explicitly search rendered task keys; use detail lookup instead. |
| Canonical `resolveTaskIdentifier` | Supports `R2618-4` or exact stored ID; never resolves titles/pronouns. |
| Status proposal validation / status executor / assignment executor | Still use independent **letters-only** prefix regexes; `R2618-4` falls through as though it were a raw ID and fails. |
| Due date, priority, comments, bulk and several relationship actions | Use the canonical resolver, so key behavior differs from status/assignment. |
| Lowercase `r2618-4` in detail lookup | Not normalized; treated as raw ID. |

[agent-context.ts:550](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-context.ts:550), [agent-actions.ts:1168](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-actions.ts:1168), [agent-reply.ts:325](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:325), [agent-actions.ts:1924](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-actions.ts:1924), [agent-actions.ts:2109](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-actions.ts:2109), [agent-actions.ts:2557](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-actions.ts:2557)

There is another **code-derived defect, not runtime-tested here**: compiler status normalization uppercases the entire task identifier, including UUIDs. IDs are text with `crypto.randomUUID()` defaults, while worker lookup compares exact text. A typical lowercase UUID can therefore be transformed into a nonmatching identifier. [agent-action-proposals.ts:944](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-action-proposals.ts:944), [schema.ts:25](C:/tmp/deft-defty-current-20261022/packages/db/src/schema.ts:25), [agent-reply.ts:348](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:348)

**Recent-conversation support is narrow, rather than general coreference.**

The worker reads up to **five earlier Defty replies**, within the same space and thread-parent scope, extracts task keys/citations, and supports plural status selectors such as “both,” “first two,” “those,” and “them.” Reference extraction itself still assumes letters-only prefixes. Singular “that task”/“it” has no deterministic binder; it depends on model inference from available history. [agent-reply.ts:690](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:690), [agent-reply.ts:750](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:750), [agent-reply.ts:838](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:838), [agent-reply.ts:886](C:/tmp/deft-defty-current-20261022/apps/api/src/workers/handlers/agent-reply.ts:886)

Also, this agent vocabulary has no general native `update_task` action for editing title/description. It exposes status, assignment, due date, priority, comments, labels/dependencies and a limited bulk-update contract. MCP’s `task_update` is a separate surface. [agent-tools.ts:195](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-tools.ts:195)

### Failures, empty results and unsupported absence claims

**Failures often reach the model, but recovery is not guaranteed.**

Thrown tool errors become safe `VALIDATION_ERROR` or `TOOL_FAILED` results. The latter explicitly says to report failure rather than interpret it as missing records. Queued reads mark returned `{error:…}` objects unsuccessful and set `is_error`; SSE flags thrown exceptions, but ordinary returned error objects pass through its successful-result branch. [agent-tool-result.ts:91](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-tool-result.ts:91), [agent-runner.ts:782](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-runner.ts:782), [agent-stream-loop.ts:354](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-stream-loop.ts:354)

Some retrieval failures are swallowed earlier: task retrieval logs errors and returns `[]`; wiki retrieval has similar behavior. The caller cannot distinguish those failures from a successful empty branch. The detailed gateway currently supplies Module diagnostics, not equivalent task/wiki branch status. [retrieve-context.ts:971](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/retrieve-context.ts:971), [retrieve-context.ts:483](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/retrieve-context.ts:483), [retrieve-context.ts:1160](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/retrieve-context.ts:1160)

Queued chat has a source-grounding retry/fallback, but its tests are coarse:

- Failed lookup only triggers that condition when **no citations** exist.
- Missing lookup allows a successful ordinary read, even if it returned no relevant records.
- A citation to the requester’s DM can therefore satisfy the presence-of-evidence check without supporting the project-summary claim.

[agent-runner.ts:623](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-runner.ts:623)

SSE is weaker: once the model returns no tools or `end_turn`, it accepts the answer immediately. Citations accumulate, but their relevance to the final claim is not verified. This leaves rehearsal (a)’s unsupported conclusion possible today. [agent-stream-loop.ts:185](C:/tmp/deft-defty-current-20261022/apps/api/src/lib/agent-stream-loop.ts:185)

### Existing tests and their limits

These were inspected, not executed.

| Coverage | Existing evidence |
|---|---|
| Ordinary discovery with mentions disabled; exact Noah; first-name and duplicate-full-name ambiguity; inactive/cross-org rejection | [defty-discovery.test.ts:49](C:/tmp/deft-defty-current-20261022/apps/api/test/defty-discovery.test.ts:49) |
| Room visibility, latest messages without query, exact-before-partial room matching, ambiguity | [defty-discovery.test.ts:60](C:/tmp/deft-defty-current-20261022/apps/api/test/defty-discovery.test.ts:60) |
| Task search by project name/description; structural filters fail closed | [defty-discovery.test.ts:77](C:/tmp/deft-defty-current-20261022/apps/api/test/defty-discovery.test.ts:77) |
| Assignee exact/partial/accent matching, employee shadow users, misses and ambiguity | [resolve-assignee.test.ts:109](C:/tmp/deft-defty-current-20261022/apps/api/test/resolve-assignee.test.ts:109) |
| Project prose recovery, sibling ambiguity, linked-space inference, nonexistent/archived/deleted targets | [resolve-project-target.test.ts:21](C:/tmp/deft-defty-current-20261022/apps/api/test/resolve-project-target.test.ts:21) |
| Space exact/alias/missing/ambiguous resolution | [resolve-space-target.test.ts:9](C:/tmp/deft-defty-current-20261022/apps/api/test/resolve-space-target.test.ts:9) |
| Compiler creation/subtasks/defaults/caller assignment, validation and grounding | [agent-action-proposals.test.ts:60](C:/tmp/deft-defty-current-20261022/apps/api/test/agent-action-proposals.test.ts:60), [agent-compiler-read-facts.test.ts:6](C:/tmp/deft-defty-current-20261022/apps/api/test/agent-compiler-read-facts.test.ts:6) |
| Referential plural status updates and discussion continuation | [agent-reply-discussion-command.test.ts:309](C:/tmp/deft-defty-current-20261022/apps/api/test/agent-reply-discussion-command.test.ts:309) |
| Task retrieval shape/type filtering using FTS | [retrieve-context-tasks.test.ts:83](C:/tmp/deft-defty-current-20261022/apps/api/test/retrieve-context-tasks.test.ts:83) |
| Native mention keys, resolve, rollout/privacy; scripted runner | [native-mention-agents-db.test.ts:126](C:/tmp/deft-defty-current-20261022/apps/api/test/native-mention-agents-db.test.ts:126), [native-mention-agents-db.test.ts:246](C:/tmp/deft-defty-current-20261022/apps/api/test/native-mention-agents-db.test.ts:246) |
| Safe tool failures and canonical source formatting | [agent-tool-result.test.ts:17](C:/tmp/deft-defty-current-20261022/apps/api/test/agent-tool-result.test.ts:17) |

The discovery fixture directly calls tools and contains one task, rather than reproducing the complete six-task/five-message summary through gpt-4o/SSE. I found no focused end-to-end coverage for both rehearsal cases, bracketed-name asymmetry, nicknames, SSE requester identity, generic assignment to “me,” singular pronouns, cross-window conversational focus, numeric-prefix keys across actions, UUID preservation, genuine semantic paraphrases, self-request-only evidence, or degraded retrieval versus empty results.

**(a) Ranked root causes**

1. **Missing ordinary discovery in the rehearsed capability set.** People discovery depended on disabled rich mentions; room discovery/latest-room reading was missing; task literal search excluded project names. Current `d071db30` changes substantially address this.
2. **No shared actor/surface/reference contract.** “Me,” “this channel,” the current project and recent task focus are reconstructed inconsistently from prose and history.
3. **Search behaves like phrase/lexical matching while the interaction promises workspace understanding.** Natural-language references need candidate discovery, relationship traversal and query broadening that are currently model choices.
4. **Resolution is duplicated across tools and executors.** Exact-first ambiguity handling coexists with first-match `ILIKE`; canonical task-key parsing coexists with incompatible regexes.
5. **Evidence presence is confused with evidence coverage.** A DM-question citation does not substantiate the absence of project tasks. SSE has no final grounding gate; queued grounding does not verify target coverage.
6. **Tests prove individual tool capabilities more than conversational behavior.** They do not establish that the model selects the necessary discovery sequence or handles incomplete evidence honestly.

**(b) An ideal workspace-understanding/resolution layer**

Use one shared, authorization-aware service from queued chat, SSE, compiler preparation and action execution.

| Part | Proposed contract |
|---|---|
| Inputs | Authenticated org/user/employee; current space/thread/message; explicit native references/URLs; utterance; bounded recent messages; prior resolved referents; current task/project when supplied by the surface. |
| Output | Typed references: entity kind, canonical ID, current label, resolution reason, evidence/provenance and candidates. Explicit states: `resolved`, `ambiguous`, `not_found_in_searched_scope`, `unavailable/degraded`. |
| Deterministic identity | Bind “me” to actor ID and “here/this channel” to the actual space ID. Use one task-key/UUID parser everywhere. Preserve opaque IDs exactly. |
| Candidate discovery | Exact IDs/keys → normalized names and explicit aliases → lexical/substring candidates → genuine semantic candidates. Semantic candidates must not require all FTS terms first. |
| Context | Fetch relevant space members, project-space links, current task states and conversation referents on demand. Bound context and expose truncation/pagination rather than imply completeness. |
| Ambiguity | Return readable alternatives with distinguishing context. Ask one targeted question: “Noah Chen or Noah Chan?” or “The import review or launch checklist task?” |
| Nicknames/suffixes | Prefer explicit aliases. Treat suffix-stripped names as candidates, preserving collision checks; never silently merge identities. |
| Model responsibility | Extract intended entity types, relationships and action intent; rank/explain candidates and formulate clarification. The model must choose from authorized canonical candidates rather than invent IDs. |
| Writes | Prepare approvals only after required references resolve. Store canonical IDs with labels/provenance, then revalidate access and current state at execution. |
| Answer verification | Track coverage of each requested target. A project-and-room summary needs project/task evidence and room evidence. A self-request is not substantive summary evidence. |
| Failure handling | Preserve failed/degraded branch status through retrieval and tool results. Broaden safely before declaring no matches; distinguish “could not search” from “searched successfully.” |

This can build on the existing project/space/assignee helpers and live authorization checks. The key change is making their results a common typed contract, rather than adding more prompt instructions.

**(c) Twenty eval utterances with expected resolutions/behavior**

Use a frozen fixture containing the six rehearsal tasks and five launch-room messages, Maya’s suffixed display name, Noah Chen, optional conflicting people/projects, and stable task IDs. Run each applicable case through **both queued and SSE paths**, with native mentions disabled. These are expected behaviors, not claims that current code passes.

| # | Utterance | Expected resolution / behavior |
|---:|---|---|
| 1 | **“summarize the REL261018 Northstar Launch project and the launch-room conversation”** | Resolve project and room separately; retrieve all six tasks and five messages; summarize both with relevant sources. Own DM question cannot substitute for evidence. |
| 2 | **“assign to Noah Chen”** | With one task in focus, resolve Noah independently of native mentions and propose assignment to that task. Without task focus, ask which task. |
| 3 | **“Maya Rao [REL261018]”** | As an answer to “Who should own it?”, resolve the exact suffixed member and retain the pending task/action context. |
| 4 | “Assign R2618-4 to me.” | Bind requester UUID directly; resolve the numeric-prefix task key; propose exact assignment. |
| 5 | “Assign R2618-4 to Noah.” | Resolve a unique Noah; if multiple candidates exist, ask which person. |
| 6 | “Assign R2618-4 to Noah Chen.” | With two members named Noah Chen, show distinguishing candidates; do not choose the first row. |
| 7 | “Give R2618-4 to Nono.” | Resolve an explicit nickname alias if configured; otherwise clarify rather than guessing Noah. |
| 8 | “Mark r2618-4 done.” | Normalize human-readable key case, resolve the same task and propose status change. |
| 9 | “Move task `<lowercase-task-uuid>` to in review.” | Preserve UUID bytes/case; resolve it within org/access scope. |
| 10 | “Find the task about checking a customer’s uploaded sample.” | Retrieve the semantically equivalent “Review import sample” candidate even without an exact phrase; confirm if several fit. |
| 11 | “Assign that task to Maya.” | After one grounded task result, bind that task and resolve Maya. |
| 12 | “Make it high priority.” | With two equally salient prior tasks, ask which task; do not use arbitrary recency alone. |
| 13 | “Mark both in review.” | After exactly two grounded task results, bind those two IDs, preserve order/context and propose two updates. |
| 14 | “Create a task to verify the launch checklist and assign it to me.” | In a space linked to exactly one project, use that project and actor ID; draft the concrete requested task. |
| 15 | “Create the launch follow-up task in this project.” | If the current surface provides no project or has multiple linked projects, ask which project. |
| 16 | “Summarize this channel.” | Bind actual current space ID; fetch recent messages and relevant thread context; disclose any retrieval window. |
| 17 | “Post ‘Technical review is Friday’ here.” | Bind current space deterministically and prepare a governed post with exact destination/content. |
| 18 | “Show the Northstar project’s open tasks.” | With multiple Northstar sibling projects, clarify using canonical project names; do not select first substring match. |
| 19 | “Summarize the finance-private conversation.” | Respect access; report inability to read the requested conversation without leaking inaccessible contents or asserting nonexistence. |
| 20 | “What remains for Northstar Launch?” | Under an injected task-search timeout or self-request-only message hit, report incomplete evidence, retry/broaden appropriately, and never conclude that no work exists. |
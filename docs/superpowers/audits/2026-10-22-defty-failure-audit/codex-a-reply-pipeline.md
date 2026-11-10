Audited the current worktree at `2d478aee`. No files were modified, no server was started, and no database was accessed. Existing changes were preserved.

Focused tests did not start because `pnpm` was unavailable on the shell’s PATH. **CONFIRMED** below means an end-to-end code trace, not a live reproduction.

The current web chat uses the queued reply pipeline. The streaming conversation API remains mounted at `apps/api/src/index.ts:187`, although I found no current web consumer. Its defects therefore affect an exposed API, with lower routine UI prevalence.

**A01 — P1 — Streaming messages bypass conversation authorization and expose private history**

- **Evidence:** [apps/api/src/routes/agent.ts:926](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/routes/agent.ts:926>) inserts immediately: `space_id: convoId, user_id: user.id`. Context loading at `apps/api/src/routes/agent.ts:423–427` uses only `.where(eq(messages.space_id, convoId))`. Lines `637–650` send that history to the model. Assistant identity at `618–625` is simply `otherMembers[0]?.user_id`. The foreign key at `packages/db/src/schema.ts:260` references `spaces.id` without a composite organization constraint.
- **Failure scenario:** An authenticated user supplies another person’s private human DM ID to `POST /api/agent/conversations/:id/messages`. The request inserts into that space and sends its history to the caller’s configured provider, returning the generated stream to the caller. A human-human DM avoids employee-policy checks. The generated message can also be attributed to one of its human members.
- **Confidence:** **CONFIRMED** — authorization, history loading, identity selection, and runtime invocation are traced.
- **Fix sketch and test:** Authorize organization, membership, active space, supported conversation type, and explicit agent identity **before any insertion or context loading**. Scope subsequent queries too. Test nonmember, foreign-organization, and human-human DM targets: no message insertion, context retrieval, or model invocation should occur.

**A02 — P1 — Conversation deletion lets ordinary members erase protected channels**

- **Evidence:** [apps/api/src/routes/agent.ts:802](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/routes/agent.ts:802>) checks only membership. Lines `812–817` then execute `.set({ is_archived: true })` on the space and `.set({ is_deleted: true })` on its messages. By comparison, `apps/api/src/routes/spaces.ts:614–620` blocks default-space deletion and requires the creator.
- **Failure scenario:** An ordinary member calls `DELETE /api/agent/conversations/<general-channel-id>`. The endpoint archives default `#general` and soft-deletes its messages, bypassing the normal deletion restrictions.
- **Confidence:** **CONFIRMED** — direct comparison of both authorization paths.
- **Fix sketch and test:** Restrict conversation mutations to their supported agent-conversation resource type. Test default channels, another user’s channel, and ordinary DMs: all must remain untouched. Verify legitimate conversation deletion still works.

**A03 — P1 — The background runner bypasses private wiki visibility**

- **Evidence:** [apps/api/src/lib/agent-runner.ts:279](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/agent-runner.ts:279>) filters exact wiki matches by `org_id`, `is_deleted`, and text matches only. Lines `303–309` add their summaries—or the first 500 content characters—to retrieved context; `375–378` attach it to the model request. The missing permission condition is defined at `apps/api/src/lib/wiki-visibility.ts:4–13`: organization scope, ownership, or space membership.
- **Failure scenario:** A private board-space wiki page contains a distinctive acquisition name. A nonmember asks Defty about that name in their own DM. If the page is among the two recent matches, its title and confidential summary enter their model context despite the permission-aware retrieval gateway excluding it.
- **Confidence:** **CONFIRMED** — the unrestricted lookup feeds the normal queued reply path.
- **Fix sketch and test:** Add `visibleWikiPageCondition(userId)` to the exact-match query, or move this freshness behavior into the shared retrieval gateway. Capture model input for an outsider and an authorized member; only the member should receive a private-page canary.

**A04 — P1 — Bad provider configurations fail silently after retries**

- **Evidence:** [apps/api/src/routes/messages.ts:726](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/routes/messages.ts:726>) considers any nonempty key ready: `Boolean(deftyProviderReason.apiKey)`. Provider failures throw at `apps/api/src/lib/agent-llm.ts:141–143`. The handler only logs and rethrows at `apps/api/src/workers/handlers/agent-reply.ts:1891–1893`; worker handling at `apps/api/src/workers/index.ts:405–413` updates queue failure state and logs. Default attempts are three at `apps/api/src/lib/queues.ts:92`.
- **Failure scenario:** An administrator saves a nonempty invalid key or nonexistent model. A human’s Defty message saves successfully, but repeated provider failures eventually leave a failed queue row without an assistant error reply or visible terminal status. Persistent rate limits have the same outcome.
- **Confidence:** **CONFIRMED** — traced through dispatch, inference failure, retries, and settlement.
- **Fix sketch and test:** Publish one safe terminal failure response tied to the triggering message. Classify authentication/configuration failures separately from retryable failures. Test 401, missing model, persistent 429, and timeout outcomes; assert appropriate retries and exactly one visible failure.

**A05 — P1 — Retrying a committed reply inserts another answer**

- **Evidence:** [apps/api/src/lib/agent-action-proposals.ts:276](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/agent-action-proposals.ts:276>) unconditionally calls `.insert(messages)`. After persistence, `apps/api/src/workers/handlers/agent-reply.ts:1851–1854` reads agent data; after broadcasting at `1868`, lines `1872–1880` query thread statistics. Errors rethrow at `1893`. Queue completion occurs later at `apps/api/src/workers/index.ts:399`; expired claims are recovered at `apps/api/src/lib/queues.ts:290–309`.
- **Failure scenario:** A channel answer commits and broadcasts. The subsequent thread-statistics query fails during a database interruption. Retrying the job inserts and broadcasts a second answer. A crash between reply commit and queue completion produces the same replay.
- **Confidence:** **CONFIRMED** — postcommit failure and replay are traced. This finding establishes duplicate replies; duplicate mutations depend on existing action idempotency.
- **Fix sketch and test:** Persist a logical reply identity derived from organization and trigger message, and atomically reuse the existing reply/action set on replay. Separate delivery/statistics failures from reasoning. Inject a postcommit failure and concurrent replay; assert one reply and one logical approval set.

**A06 — P1 — User memories cross organization boundaries**

- **Evidence:** [apps/api/src/routes/agent.ts:524](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/routes/agent.ts:524>) loads memories using only `user_id` and `scope: 'user'`. `apps/api/src/lib/agent-context.ts:937–945` similarly starts recall with `[eq(agentMemory.user_id, _userId)]`, without organization scope. Memory writes include `org_id` at `918–923`; the shared retrieval implementation correctly includes it at `apps/api/src/lib/retrieve-context.ts:735–737`.
- **Failure scenario:** A human belongs to organizations A and B. A user-scoped memory saved in A is recalled while answering in B, or automatically sent to B’s configured provider through streaming context.
- **Confidence:** **CONFIRMED** — tenant-tagged persistence and unscoped retrieval are traced. This requires multiple organizations sharing a user.
- **Fix sketch and test:** Add current-organization predicates to user/conversation memory retrieval and recall branches. Test one user with distinct confidential memories in two organizations; context and recall must contain only the active organization’s records.

**A07 — P2 — A failed enqueue permanently loses the Defty reply**

- **Evidence:** [apps/api/src/routes/messages.ts:735](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/routes/messages.ts:735>) enqueues after the human message has been saved. Lines `744–746` catch failure and only log: `console.error('Failed to enqueue agent reply:', err)`. The route subsequently returns the saved message.
- **Failure scenario:** The message commits, then the queue insertion fails during a brief connection failure. The user sees their message delivered, but no job exists to retry and no failure reply is posted.
- **Confidence:** **CONFIRMED** — the persistence/dispatch gap has no recovery in this path.
- **Fix sketch and test:** Persist the Defty job in the message transaction, using the queue’s existing transaction-executor support, or a durable outbox. Inject enqueue failure: the system must either reject the whole write or retain recoverable dispatch work.

**A08 — P2 — Human MCP messages to Defty never wake it**

- **Evidence:** [apps/api/src/lib/mcp-tools/human.ts:2307](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/mcp-tools/human.ts:2307>) saves `humanMessagePost`, then calls only `dispatchAgentEmployeeMessage` at `2314–2320`. `humanSendMessage` does likewise at `2397–2411`. That dispatcher excludes Defty at `apps/api/src/lib/dispatch-agent-message.ts:41–45`: `ne(agentEmployees.runtime_kind, 'defty_system')`. Its only queued job is `agent-employee-message`; Defty’s separate enqueue exists at `apps/api/src/routes/messages.ts:735`.
- **Failure scenario:** A personal MCP client posts a question into its user’s Defty DM or posts a Defty mention. The tool reports success and saves the message, but Defty receives no wake and produces no reply.
- **Confidence:** **CONFIRMED** — both human MCP publication paths are traced.
- **Fix sketch and test:** Put Defty detection, provider handling, and deduplicated dispatch into the shared human-message publication path. Test UI posting and both MCP tools against identical DM/mention fixtures; each should create exactly one intended wake.

**A09 — P2 — Cancelled workers can publish after timeout or lease loss**

- **Evidence:** [apps/api/src/workers/index.ts:128](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/workers/index.ts:128>) starts work with `controller.signal`; lines `145–172` abort on lost ownership/deadline and race against the running handler. The signal reaches the handler at `388–395`. However, `apps/api/src/workers/handlers/agent-reply.ts:1239–1256` reads only job data, and line `1520` creates an independent `new AbortController()`. Persistence at `1810` has no worker-cancellation guard.
- **Failure scenario:** With supported `DEFT_JOB_TIMEOUT_MS=1000`, inference takes 1.5 seconds. The queue occurrence fails at one second, but the handler continues and publishes afterward. Losing a lease allows the same stale-owner publication.
- **Confidence:** **CONFIRMED** — signal propagation failure and late-write path are traced.
- **Fix sketch and test:** Compose the job signal with local deadlines, propagate it through compilation/inference, and fence persistence to current run ownership. Abort a fake slow operation, then resolve it; assert no persistence or broadcast after cancellation.

**A10 — P2 — Streaming callers disable provider request deadlines**

- **Evidence:** [apps/api/src/lib/agent-llm.ts:138](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/agent-llm.ts:138>) uses `signal: p.abortSignal ?? AbortSignal.timeout(60_000)`. The same pattern appears at `186` and `224`. Streaming routes always supply a signal whose only cancellation source is disconnect: `apps/api/src/routes/agent.ts:952–953,975`. Heartbeats continue at `957–959`.
- **Failure scenario:** An OpenAI, OpenRouter, or Ollama endpoint accepts the request but never finishes its response. A connected SSE caller has no application-enforced provider deadline and can keep receiving heartbeats indefinitely.
- **Confidence:** **CONFIRMED** — the caller signal replaces rather than supplements the timeout.
- **Fix sketch and test:** Combine caller cancellation and deadline using `AbortSignal.any`. Test a stalled response with a connected caller, and caller cancellation independently; both must terminate inference and clean up heartbeats.

**A11 — P2 — Tool-loop exhaustion can silently discard the reply and approvals**

- **Evidence:** [apps/api/src/lib/agent-runner.ts:395](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/agent-runner.ts:395>) limits ordinary runs to eight iterations. The loop ends at the bound without an exhaustion result; line `605` returns `finalText || intermediateText`. `apps/api/src/workers/handlers/agent-reply.ts:1595–1598` then logs `"Agent returned empty text, skipping reply"` and returns before approval persistence at `1810–1819`. The streaming loop similarly exits its budget loop at `apps/api/src/lib/agent-stream-loop.ts:76`, and its route sends `done`.
- **Failure scenario:** Every permitted response contains tool calls without prose, consistent with the instruction to use tools silently. At exhaustion, the worker completes successfully without a reply. Any pending approvals accumulated in that run also remain unpersisted.
- **Confidence:** **CONFIRMED** — empty output, early return, and successful settlement are traced.
- **Fix sketch and test:** Return an explicit exhaustion outcome with a deterministic visible explanation. Persist pending actions independently of model prose. Test one permitted iteration containing only tool calls; assert a terminal reply and durable approvals.

**A12 — P2 — Rejecting a streamed action leaves an unmatched tool call in history**

- **Evidence:** [apps/api/src/lib/agent-stream-loop.ts:139](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/lib/agent-stream-loop.ts:139>) persists assistant tool calls before approval. Pending calls halt the loop at `330–332,376–402` without a corresponding result. Approval inserts a matching `tool_result` at `apps/api/src/routes/agent.ts:1680–1714`; rejection updates status at `1805–1821` and returns at `1868` without doing so. History reconstruction at `637–645` replays the stored blocks.
- **Failure scenario:** Defty proposes a native action through the streaming API. The user rejects it, then sends another message or continues. The next provider request contains the old tool call without its result, potentially making the conversation unusable under strict tool-message validation.
- **Confidence:** **PLAUSIBLE** — the unmatched transcript is confirmed; provider rejection was not exercised.
- **Fix sketch and test:** Persist a matching rejection result atomically with rejection, and repair interrupted tool groups during reconstruction. Test propose → reject → continue with a provider-contract validator, including multiple pending calls.

**A13 — P2 — Long streaming conversations have no context-window recovery**

- **Evidence:** [apps/api/src/routes/agent.ts:423](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/routes/agent.ts:423>) loads all conversation messages without a limit; lines `637–650` forward every retained block. `apps/api/src/lib/agent-stream-loop.ts:76,94` checks cumulative provider-reported usage only after requests have already been accepted.
- **Failure scenario:** History and tool results exceed the selected model’s context window. Every later request resends the oversized history plus the newly persisted user message. A short follow-up cannot recover the conversation.
- **Confidence:** **PLAUSIBLE** — unbounded request construction is confirmed; the failing threshold depends on the configured model.
- **Fix sketch and test:** Budget history before inference, reserving space for system instructions, tools, and output. Trim complete tool-call/result groups. Test oversized synthetic history: retain the newest request and valid tool groups within a configured input budget.

**A14 — P2 — Materializing Defty’s system employee changes or breaks streaming identity**

- **Evidence:** [apps/api/src/routes/agent.ts:415](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/routes/agent.ts:415>) resolves an employee with only `.where(eq(agentEmployees.user_id, agentMemberUserId)).limit(1)`. The organization-scoped policy check can then return 403 at `442–445`. `apps/api/src/lib/ensure-defty-membership.ts:104–121` creates organization-specific `defty_system` employees sharing the global Defty user. Superintendent tools are included only under `if (!agentEmployeeId)` at `apps/api/src/routes/agent.ts:507–510`.
- **Failure scenario:** Only organization A has materialized its internal Defty employee. Organization B’s streaming conversation selects A’s employee and fails policy validation. Within A, materializing the row makes `agentEmployeeId` truthy and removes Defty’s superintendent tools.
- **Confidence:** **CONFIRMED** — deterministic for the stated single-existing-row state; selection becomes unordered with several rows.
- **Fix sketch and test:** Identify built-in Defty explicitly, scope employee lookup to the organization, and distinguish its execution identity from ordinary employees. Test streaming before/after materialization and with two organizations sharing Defty.

**A15 — P2 — Deferred turns place future messages before their trigger**

- **Evidence:** [apps/api/src/workers/handlers/agent-reply.ts:1303](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/workers/handlers/agent-reply.ts:1303>) excludes only `ne(messages.id, messageId)` from recent DM history; there is no trigger-time upper bound. Thread history at `1327–1333` has the same omission. `apps/api/src/lib/agent-runner.ts:365–366` then appends the trigger as the latest user message. Ordinary jobs execute concurrently at `apps/api/src/workers/index.ts:520–523`.
- **Failure scenario:** M1 is queued, then M2 is saved before M1 starts. M1’s prompt becomes M2 → M1, reversing the real conversation. Concurrent processing also lets dependent replies complete out of order.
- **Confidence:** **CONFIRMED** for incorrect prompt chronology; resulting answer wording is model-dependent.
- **Fix sketch and test:** Bound history to the trigger’s stable message boundary. Serialize dependent turns per conversation. Save M1 and M2 before processing M1; capture prompts and prove M1 excludes M2 while M2 receives preceding turns in order.

**(a) Ranked top five**

1. **A01:** Unauthorized private-history access, cross-organization references, and possible human attribution through streaming POST.
2. **A02:** Ordinary members can archive protected channels and delete their message history.
3. **A03:** The normal queued runner passes private wiki content across visibility boundaries.
4. **A04:** Configured-provider failures leave users without replies or explanations.
5. **A05:** Normal crash/retry recovery can publish duplicate answers.

**(b) Proposed independent work packages**

| Package | Findings | Files touched | Dependencies and verification |
|---|---|---|---|
| Conversation authorization and identity | A01, A02, A14 | `routes/agent.ts`; focused route tests; optional shared conversation resolver | Start immediately. Verify nonmember/cross-org denial before writes or model calls, protected-channel preservation, and explicit Defty identity. |
| Knowledge and memory isolation | A03, A06 | `lib/agent-runner.ts`, `lib/agent-context.ts`, `routes/agent.ts`; visibility/context tests | Independent of delivery work. Capture model inputs with private canaries and two-organization fixtures. Coordinate the shared `agent.ts` edits with the first package. |
| Durable human-message dispatch | A07, A08 | `lib/dispatch-agent-message.ts`, `routes/messages.ts`, `lib/mcp-tools/human.ts`; dispatch tests | Centralize dispatch first, then make message/job persistence atomic. Verify UI/MCP parity, enqueue failure recovery, and exactly one wake. |
| Reply identity and failure reporting | A04, A05 | `workers/handlers/agent-reply.ts`, `lib/agent-action-proposals.ts`, `lib/queues.ts`, `workers/index.ts`; lifecycle tests | Establish durable reply identity before adding terminal failure replies. An existing advisory lock plus persisted source marker can avoid a schema change; a unique run record would require a reviewed migration. Verify postcommit failure, crash recovery, and concurrent replay. |
| Cancellation and conversation ordering | A09, A15 | Reply handler, compiler/inference interfaces, worker scheduling; cancellation/ordering tests | Can develop independently; integrate ownership fencing with the reply-identity package. Verify timeout/lease loss prevents late publication and captured prompts preserve chronology. |
| Provider deadlines and bounded reasoning | A10, A11, A13 | `lib/agent-llm.ts`, `lib/agent-runner.ts`, `lib/agent-stream-loop.ts`, context construction in `routes/agent.ts`; mocked-provider tests | Independent core work. Verify stalled fetch cancellation, visible exhaustion, preserved approvals, and bounded history. Use reply identity when persisting terminal outcomes. |
| Transcript recovery | A12 | `lib/agent-stream-loop.ts`, approval/rejection paths in `routes/agent.ts`, history reconstruction; transcript tests | Coordinate with history trimming. Verify approve/reject/expiry, mixed tool batches, and disconnect recovery against strict tool-pair validation. |

**(c) Open questions needing runtime verification**

- Are the mounted streaming endpoints reachable in deployed installations, or restricted by deployment-specific proxy rules?
- What exact errors do supported providers return for rejected, interrupted, or partially approved tool-call groups?
- Does prepending retrieved context before a tool-result-only user turn violate Anthropic ordering requirements? OpenAI translation also drops accompanying text when tool results exist.
- Do reasoning-only incomplete responses or refusal blocks become empty successful replies? The Responses adapter ignores `status`/`incomplete_details` at `agent-llm.ts:194–198` and retains only `output_text` at `413–432`.
- Which configured models hit context limits with realistic conversation and attachment sizes?
- Can provider error bodies contain sensitive diagnostics that the SSE error path forwards verbatim? Exercise this with canary errors.
- Is user-scoped memory explicitly intended to remain organization-scoped? Persistence and the newer retrieval implementation indicate that it is.
- In a disposable test environment, confirm postcommit duplicate delivery, lease-loss fencing, MCP dispatch parity, and the final user-visible state for 401, 429, missing-model, and timeout failures.
Found **15 substantive issues: 7 P1 and 8 P2**. No P0 established.

This was read-only: no files changed, server started, or database accessed. “CONFIRMED” below means traced through the relevant source paths, not browser-reproduced. A focused unit-test attempt could not execute because `pnpm` was unavailable in the shell PATH.

**E01 — P1 — Dashboard discloses private Defty action payloads to unrelated members**

- **Evidence:** [apps/api/src/routes/dashboard.ts:894](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/routes/dashboard.ts:894>) selects `params: agentActions.params` and `result: agentActions.result`. Its predicates at lines 906–908 check organization and module visibility. `apps/api/src/lib/module-action-visibility.ts:81–84` admits non-module actions through `notInArray(...) OR requesterOrReviewer`. Every dashboard fetches this feed at `apps/web/src/app/(app)/dashboard/lib/data-provider.tsx:69`.
- **Failure scenario:** Alice asks Defty to draft a confidential message for a private leadership space. Bob, who cannot access that space, opens his dashboard. Its activity response includes the draft’s complete content and target. This is an intra-workspace privacy breach.
- **Confidence:** **CONFIRMED** — action parameters are persisted unchanged and returned through the unconditional dashboard fetch.
- **Fix/test:** Apply requester/reviewer and source/target visibility checks before projecting actions. Test pending and approved private-space actions with two same-organization users; the unauthorized user must receive neither payload nor private target metadata.

**E02 — P1 — Ordinary members can change workspace-wide trust policy**

- **Evidence:** [apps/api/src/routes/agent.ts:2122](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/api/src/routes/agent.ts:2122>) updates `orgs` with `.set({ trust_level })` without an owner/admin check. Authentication at `apps/api/src/index.ts:169` and route mounting at line 187 add no such restriction. The web exposes the mutation at `apps/web/src/app/(app)/settings/agent/page.tsx:339–343`.
- **Failure scenario:** An ordinary member selects Autonomous in Agent governance. The organization’s policy changes, affecting the streaming/background paths that enforce organization trust.
- **Confidence:** **CONFIRMED** — traced authentication, UI, mutation, and enforcing readers.
- **Fix/test:** Require current owner/admin membership on PATCH; make other users’ controls read-only. Test member denial without mutation and successful admin updates.

**E03 — P1 — Editing a reasoning model silently removes its private endpoint**

- **Evidence:** [apps/web/src/app/(app)/settings/ai/page.tsx:470](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/app/(app)/settings/ai/page.tsx:470>) saves only `{ provider, model: model.trim() }`. `apps/api/src/lib/org-ai-config.ts:412` replaces the entire route: `ai_models[task] = route`. At lines 306–307, a missing OpenAI `baseUrl` becomes the public OpenAI endpoint.
- **Failure scenario:** An operator configured an OpenAI-compatible local reasoning endpoint through the supported API. Changing only its model in web settings deletes `baseUrl`. Subsequent Defty requests target hosted OpenAI, potentially transmitting workspace context outside the intended local boundary.
- **Confidence:** **CONFIRMED** configuration and endpoint-resolution trace; network delivery was not exercised.
- **Fix/test:** Preserve existing endpoint fields when editing the same provider, and expose endpoint changes explicitly. Test that editing only the model retains the stored and resolved local URL.

**E04 — P1 — Failed execution later appears as “Task updated”**

- **Evidence:** `apps/api/src/lib/agent-approval-resolver.ts:959–975` retains approved status while recording `result: null` and an execution `error`. Inbox hydration passes those fields unchanged at `apps/api/src/routes/attention.ts:86–88` and `apps/web/src/app/(app)/inbox/page.tsx:174–176`. [apps/web/src/components/agent-action-card.tsx:519](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/components/agent-action-card.tsx:519>) chooses `action.status ?? action.approval_status`; its approved branch at lines 603–612 renders the green completion label.
- **Failure scenario:** A task becomes invalid or is deleted before approval. Execution fails. After Inbox refresh, its card says “Task updated” despite the stored error. Reapproving also returns “already approved” without checking the error (`agent-approval-resolver.ts:674–680`).
- **Confidence:** **CONFIRMED** — executor → persisted failure → hydration → rendering.
- **Fix/test:** Separate approval decision from execution outcome. Failed execution must remain failed after refresh and repeated requests. Also test HTTP 202 `{status:"executing"}`: the card currently defaults that response to approved at lines 1160–1168.

**E05 — P1 — Failed trust changes falsely show a successful downgrade**

- **Evidence:** [apps/web/src/app/(app)/settings/agent/page.tsx:339](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/app/(app)/settings/agent/page.tsx:339>) immediately calls `setTrustLevel(t.value)`, ignores the PATCH response, and uses `catch {}`. Failed initial loading also leaves the default Conservative selection (`page.tsx:90,185–189`).
- **Failure scenario:** Persisted trust is Autonomous. An operator selects Conservative during an API outage. The selection changes and “Saving…” disappears, while the server remains Autonomous. Overlapping clicks can also leave displayed and persisted values different.
- **Confidence:** **CONFIRMED**.
- **Fix/test:** Represent unknown/loading policy explicitly; check HTTP status; commit the displayed value after successful persistence; serialize saves and show errors. Test failed GET, rejected downgrade, HTTP 500, and overlapping clicks.

**E06 — P1 — Approval surfaces omit parts of the actual write**

- **Evidence:**
  - [apps/web/src/components/agent-action-card.tsx:440](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/components/agent-action-card.tsx:440>) renders `task_update` details from top-level description/content, never `params.patch`. `apps/web/src/lib/agent-action-presentation.ts:215–232` summarizes only selected mutations and skips assignment IDs and null removals.
  - The real capture producer stores `patch` at `apps/api/src/lib/defty-capture.ts:1276`; the executor applies assignment/date removal at `apps/api/src/lib/mcp-tools/writes.ts:569–603`.
  - Reminder timestamps become only month/day through `toLocaleDateString(...)` at `agent-action-presentation.ts:152–157`.
  - Dashboard message approvals show only `Posted in #${p.space_name}` (`apps/web/src/app/(app)/dashboard/lib/shared.tsx:46`) before offering Approve (`widgets/agent.tsx:61–68`).
- **Failure scenario:** A task patch sets status to done **and** clears assignee/date, but the card summarizes the status change without displaying the executable removals. Two reminder times on the same date look alike. Two different proposed messages to one channel have identical dashboard summaries.
- **Confidence:** **CONFIRMED**.
- **Fix/test:** Make every approval surface expose the complete proposed mutation, including removals, resolved identities, message bodies, and reminder time/timezone. Test combined patches, distinct same-day reminder times, and long message bodies.

**E07 — P1 — Defty reasoning failures leave users waiting without an outcome**

- **Evidence:** The web handles ordinary typing events at [apps/web/src/components/space-chat.tsx:999](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/components/space-chat.tsx:999>), but receives no chat-run lifecycle from this path. `apps/api/src/workers/handlers/agent-reply.ts:1565` can reject after 60 seconds; its outer catch at lines 1891–1893 only logs and rethrows. Queue processing records/logs failures at `apps/api/src/workers/index.ts:405–413`.
- **Failure scenario:** Ask a normal question while the reasoning provider hangs. The message sends successfully; Defty supplies neither a working state nor a timeout/error reply. Exhausted retries leave the conversation unanswered.
- **Confidence:** **CONFIRMED** failure path.
- **Fix/test:** Persist and render a run state keyed to the triggering message, with an explicit terminal error and retry action. Test delayed reasoning, queue-enqueue failure, timeout, and exhausted retries without duplicate error messages.

**E08 — P2 — Trust settings do not govern normal Defty chat as advertised**

- **Evidence:** [apps/web/src/app/(app)/settings/agent/page.tsx:65](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/app/(app)/settings/agent/page.tsx:65>) promises “All actions auto-execute except external writes.” Normal chat calls `runAgentQuery` without a mode override (`apps/api/src/workers/handlers/agent-reply.ts:1545–1563`). The runner defaults to `mode = 'chat_mention'` at `apps/api/src/lib/agent-runner.ts:171`; trust loading and auto-execution require background mode at lines 217–223 and 495. Chat writes become proposals at lines 541–564.
- **Failure scenario:** Select Autonomous, then ask Defty in its DM to create a task. It still requires approval.
- **Confidence:** **CONFIRMED**, including the worker’s compiled-action path.
- **Fix/test:** If chat is intentionally proposal-only, state that scope explicitly and correct the trust descriptions. Otherwise enforce the chosen policy through existing governed execution. Test equivalent requests in DM, mentions, and background execution.

**E09 — P2 — An unrelated pending approval rewrites human chat messages**

- **Evidence:** [apps/web/src/components/space-chat.tsx:696](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/components/space-chat.tsx:696>) enables normalization when **any** message in the space has an approval. `apps/web/src/lib/agent-approval-copy.ts:22–24` replaces content containing `approve or reject` with “I drafted the task/update. Review the approval card below.” It is applied without checking agent authorship. Thread rendering repeats this at `thread-panel.tsx:486–489`.
- **Failure scenario:** While any approval is pending, a human writes “Please approve or reject this task by Friday.” Readers instead see “I drafted the task. Review the approval card below.”
- **Confidence:** **CONFIRMED**.
- **Fix/test:** Limit normalization to the associated agent message and narrowly identified legacy boilerplate. Test that human messages and unrelated historical replies remain unchanged when another approval appears.

**E10 — P2 — Cards offer receipts that were never generated**

- **Evidence:** [apps/web/src/components/agent-action-card.tsx:522](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/components/agent-action-card.tsx:522>) infers receipt existence from approved/rejected status. Legacy receipt generation at `apps/api/src/routes/agent.ts:1542–1572` covers only selected action families. Standard native reminder execution does not create one; receipt lookup returns 404 at lines 2072–2073.
- **Failure scenario:** A successful native reminder card offers “View receipt”; opening it reports that no receipt exists.
- **Confidence:** **CONFIRMED**.
- **Fix/test:** Generate receipts consistently, or expose the button only when receipt existence is confirmed. Require receipt GET 200 whenever the rendered card offers that affordance.

**E11 — P2 — Dismissing mention suggestions leaves Enter unable to send**

- **Evidence:** [apps/web/src/components/rich-composer.tsx:248](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/components/rich-composer.tsx:248>) intercepts Enter whenever text ends in an `@`/`#` query, regardless of popup state. Escape only sets `showMentions` false at line 486. `apps/web/src/components/mention-autocomplete.tsx:92–97` also consumes Enter/Tab with no selected option, while line 117 renders nothing for zero results.
- **Failure scenario:** Type `Hello @defty`, press Escape, then Enter. The popup closes, but the message does not send. An unmatched query can invisibly consume Enter and Tab.
- **Confidence:** **CONFIRMED** keyboard-handler trace.
- **Fix/test:** Intercept keys only for an active autocomplete with a selectable result. Test Escape → Enter sends once, and empty results do not trap Enter/Tab.

**E12 — P2 — “Ask Defty” can silently do nothing and discard onboarding**

- **Evidence:** [apps/web/src/lib/quick-actions.ts:136](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/lib/quick-actions.ts:136>) returns false for lookup failures. `apps/web/src/app/(app)/layout.tsx:433–446` silently returns when cached members are missing or DM creation fails. Callers ignore the result; `dashboard/starter-cards.tsx:140–145` dismisses the card **before** opening the DM.
- **Failure scenario:** Initial member loading fails. A later quick action successfully finds Defty, but DM opening consults the still-empty layout cache and returns. The palette closes or onboarding disappears without navigation or an explanation.
- **Confidence:** **CONFIRMED**.
- **Fix/test:** Return a genuine success/error result, use the freshly fetched member, await every caller, and dismiss onboarding only after success. Test startup lookup failure followed by successful retry, plus failed DM creation.

**E13 — P2 — Failed chat reads masquerade as empty conversations or absent approvals**

- **Evidence:** [apps/web/src/components/space-chat.tsx:900](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/components/space-chat.tsx:900>) clears messages before loading; line 930 swallows rejection. Lines 1458–1462 then show “This is the start…” Approval polling similarly returns `{}` on HTTP failure at line 684. Thread polling repeats that behavior at `thread-panel.tsx:247`.
- **Failure scenario:** Opening an existing Defty DM during an API failure looks like a new conversation. An approval-poll failure removes cards while the reply still tells the user to review them.
- **Confidence:** **CONFIRMED**.
- **Fix/test:** Distinguish loading, empty, stale, and failed states; preserve successful data during refresh failures and expose retry. Test initial history failure and a failed approval refresh after a successful one.

**E14 — P2 — AI setup can remain on a permanent spinner**

- **Evidence:** [apps/web/src/app/(app)/settings/ai/page.tsx:59](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/app/(app)/settings/ai/page.tsx:59>) awaits the request and JSON without catch/finally. Loading starts true at line 54; rejection bypasses `setLoading(false)`. Lines 99–104 render only the spinner.
- **Failure scenario:** A first-time operator opens AI settings while the API is unreachable, or receives invalid JSON. The page needed to enable Defty never leaves its spinner.
- **Confidence:** **CONFIRMED**.
- **Fix/test:** Handle errors, clear loading in `finally`, and offer retry. Test rejected fetch, invalid JSON, and successful recovery.

**E15 — P2 — Replies completed during disconnection may remain invisible after reconnect**

- **Evidence:** [apps/web/src/lib/space-socket.ts:10](<C:/Users/Osheen Pradhan/Documents/Deft Main Repo/apps/web/src/lib/space-socket.ts:10>) reconnects by emitting only `space:join`. Chat history loads on space/highlight changes (`space-chat.tsx:900–932`), not reconnection. Thread history likewise loads on thread changes (`thread-panel.tsx:285–317`). Server socket configuration at `apps/api/src/socket.ts:268–275` enables no connection-state recovery.
- **Failure scenario:** Defty finishes while a laptop sleeps or the connection drops. After reconnect, the room rejoins but the missed reply is not fetched; the user waits until reopening or reloading.
- **Confidence:** **PLAUSIBLE** — no replay/refetch path found; requires a controlled disconnect test.
- **Fix/test:** Refetch and deduplicate active conversation/thread history after reconnection. Disconnect during a pending reply, finish it server-side, reconnect, and require exactly one visible reply without navigation.

The missing-provider case itself has a useful fallback: `apps/api/src/routes/messages.ts:748–780` posts a reply directing users to Settings → AI. The silent failure in E07 concerns dispatched work that subsequently fails.

The legacy approval route also uses an atomic claim (`apps/api/src/routes/agent.ts:1458–1470`), so rapid clicks alone do **not** establish duplicate side effects. `use-inbox.ts` exposes read errors and currently has no callers; I found no reachable Defty defect to report from that hook.

**Settings enforcement coverage**

API paths below are relative to `apps/api/src/`.

| Setting | Persistence → enforcement |
|---|---|
| Global trust | `routes/agent.ts:2122–2135` → streaming readers at `435,655,972`; background runner at `lib/agent-runner.ts:217–223,495`. Normal DM/mention writes ignore it: E08. |
| Provider keys | `routes/org.ts:138–145` → `lib/org-ai-config.ts:394–402` → reasoning resolution at `262–311`, consumed by `lib/agent-runner.ts:175`. |
| Ollama URL | `routes/org.ts:157–159` → `lib/org-ai-config.ts:420–427` → reasoning endpoint at `309` and general LLM routing at `lib/llm.ts:74–78`. |
| Reason provider/model | `routes/org.ts:149–154` → `lib/org-ai-config.ts:409–414` → reasoning resolver. Web edits lose custom endpoint fields: E03. |
| Classify/summarize/extract routes | Same routing persistence → `lib/llm.ts:70–89` reads each task override. |
| Embeddings | `routes/org.ts:163–164` → `lib/embed.ts:167–181` → provider selection/use at `61–73,84–108`. |
| Transcription | `routes/org.ts:167–181` → `lib/transcription.ts:157–182`. The UI correctly identifies environment-level OpenAI/Deepgram credentials. |

**Ranked top 5**

1. **E01:** Private action payloads disclosed through dashboard activity.
2. **E02:** Members can change organization-wide trust policy.
3. **E03:** Model edits silently replace a private reasoning endpoint.
4. **E04:** Failed writes later appear successfully completed.
5. **E05:** Failed trust downgrades appear successfully saved.

**Proposed fix plan**

| Package | Findings and files | Ordering and verification |
|---|---|---|
| **A — Action visibility** | E01. API `routes/dashboard.ts`, shared action-visibility helper, authorization tests. | Independent; start first. Test member/guest access, private source/target spaces, and cross-organization denial. |
| **B — Governance controls** | E02, E05, E08. API `routes/agent.ts`; web `settings/agent/page.tsx`; policy/UI tests. | Authorization and save handling can proceed immediately. Resolve chat policy scope before changing execution behavior. Verify role denial, failed saves, races, and the advertised tier matrix. |
| **C — Provider setup** | E03, E14. Web `settings/ai/page.tsx`; configuration regression tests. | Independent. Verify endpoint preservation and recoverable loading failures against a mock provider. |
| **D — Truthful approvals** | E04, E06, E10. `agent-action-card.tsx`, `agent-action-presentation.ts`, dashboard approval widget/formatter, API approval resolver/routes and hydration. | Functionally independent; integrate after B’s shared `agent.ts` edits. Verify failure refresh, 202 execution, complete payloads, and receipt availability. |
| **E — Chat lifecycle and recovery** | E07, E09, E13, E15. `space-chat.tsx`, `thread-panel.tsx`, `agent-approval-copy.ts`, `space-socket.ts`, API message route and reply/queue workers. | Independent of provider changes. Verify terminal failures, unchanged authored content, failed reads, reconnect recovery, and deduplication. |
| **F — Entry points and keyboard flow** | E11, E12. `rich-composer.tsx`, `mention-autocomplete.tsx`, `quick-actions.ts`, app layout, command palette, dashboard entry points. | Independent behavior; coordinate shared chat-file edits with E. Verify keyboard sending, visible errors, and onboarding retained until successful navigation. |

**Open questions needing runtime verification**

- Does a reply completed during sleep/disconnection recover under the actual deployment’s socket configuration?
- Are complete approval payloads readable and operable at desktop and mobile widths, including long messages and combined task changes?
- Does receipt-modal focus enter, remain within, close with Escape, and return correctly for keyboard and screen-reader users?
- Do loading, execution failures, and approval-state changes receive appropriate assistive-technology announcements?
- Does a model-only edit preserve the actual outbound endpoint when exercised against a controlled local provider?
- Is ordinary Defty chat intentionally proposal-only? That policy decision is needed before making trust behavior consistent.
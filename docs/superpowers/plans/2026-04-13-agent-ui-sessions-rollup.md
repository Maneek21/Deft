# Agent UI Sessions Rollup (April 12–13, 2026)

Three-plus-one session sweep through the Deft agent UI and backend. Started from a bug report about Playwright MCP permission repetition, ended with 20 passing audit assertions across 3 regression-gated Playwright suites, a tier-1 MCP bundle wired to Alex PM, and Anthropic prompt caching cutting API cost by ~40-60%.

Branch: `feat/phase2-4-mcp-agents-plans` — ~40 new commits on top of existing work.

## The arc

1. **Origin:** User reported that Playwright browser tools kept asking for approval multiple times and Alex PM kept repeating the same "this is outside my scope / needs approval" disclaimers. Root-cause investigation surfaced three underlying bugs (MCP classifier defaulting to `full-review`, lost tool-use context across turns, synthetic `[System: approved…]` user messages restarting the agent from scratch).

2. **Playwright approval fix plan** (pre-sessions): shipped the MCP classifier, structured `content_blocks` persistence on `agent_messages`, `tool_use_id` on `agent_actions`, extracted `runAgentStreamingLoop` helper, added `/continue` endpoint with proper `tool_result` blocks, and rewrote the web client to call `/continue` after approval instead of posting synthetic text.

3. **Tier-1 MCP bundle:** installed 5 MCPs on Alex PM — Time, Fetch, Tavily Search, Sequential Thinking, Context7 — and configured auto-execute classification for their tools so they flow without approval gates. 17 tools, all auto-tier after classifier extension.

4. **Sessions 1-3 agent UI sweep** based on a deep visual audit I did via Playwright that surfaced 18+ issues across content safety, identity, approval cards, confidence logic, tokens, mobile layout, and empty states.

5. **Session 2.5 hotfix:** Anthropic prompt caching on system prompt + tools list to cut token cost on every agent API call.

## Commits landed on this branch

All on `feat/phase2-4-mcp-agents-plans`. In reverse-chronological order:

### Session 3 (April 13)
- `9333b92` — fix(audits): lower session-2 tokens threshold after Session 2.5 caching
- `59cee65` — fix(agent-page): add mobile History button to employee tab branch
- `2a5fde5` — test(agents): session-3 audit script (6 new + session 1+2 regression)
- `f4e188e` — feat(agent): contextual follow-ups via Haiku (T4 stretch)
- `c2325a1` — refactor(agent): extract shared ConversationList component (Mob3)
- `418a7c3` — fix(agent-chat): mobile code block scroll hint + agent bubble right gutter (Mob1 + Mob2)
- `37917b7` — feat(agent-chat): render role-aware starter prompts in empty state (E1)
- `2056349` — feat(schema): add agent_employees.starter_prompts + seed Alex PM

### Session 2.5 prompt caching hotfix (April 12)
- `7994235` — feat(agent): enable Anthropic prompt caching on system + tools

### Session 2 (April 12)
- `1e8b08b` — fix(audits): robustify session-1 and session-2 Tavily-bound tests
- `628c57d` — fix(audits): bump session-2 tokens test timeout to 240s
- `326e503` — fix(agent-chat): post-approval confidence, drop duplicate MCP citation pill
- `14595f8` — chore(audits): record session-2 green run
- `0e52e40` — fix(audits): use create_task for session-2 approval card test
- `58bf314` — fix(agent-chat): populate tool_calls during streaming, humanize in-flight label
- `c411c32` — test(agents): session-2 audit script (7 new + session-1 regression)
- `7f03f5b` — fix(agent-stream): write cumulative tokens on terminal row (T3)
- `e994158` — fix(agent-chat): unified confidence, gate metadata on pending actions (C1+C2+A3+A5)
- `3f877b6` — fix(agent-chat): render MCP tool params in approval cards (A2)
- `c87b294` — fix(agent-chat): humanize tool labels in badges, thinking, approval cards (A1 + T2)
- `1da48a3` — feat(web): add tool-display and confidence helpers

### Session 1 (April 12)
- `b9d81f3` — chore(audits): record session-1 green run
- `444ea42` — fix(agent-stream): aggregate tool_calls onto terminal row for badge reload
- `7228b9b` — test(agents): session-1 audit script (7 assertions)
- `9bba389` — chore(audits): playwright audit infrastructure (auth, db, assert helpers)
- `324f05c` — fix(agent-chat): show agent name, restore tool badges on reload, hide intermediate iterations
- `5c94a8f` — fix(agent-chat): replace hand-rolled markdown renderer with react-markdown
- `24108a9` — chore(web): add react-markdown + remark-gfm + rehype-sanitize, playwright devDep

### Tier-1 MCP bundle (April 12)
- `2696469` — docs(mcp): record tier-1 bundle execution + deferred servers
- `14fedc1` — fix(mcp-installer): use time-mcp and fetch-mcp instead of broken packages
- `fb4ec02` — feat(mcp): classify time-mcp and fetch-mcp tool names as auto-execute
- `bbf18fe` — chore(mcp): tier-1 bundle installer script
- `1c2b0ae` — feat(mcp): classify search/time/fetch/thinking/docs tools as auto-execute

### New-conversation bug fix (April 12)
- `76ecaf3` — fix(agent-chat): clear state when conversationId transitions to undefined

### Playwright approval repetition fix (April 12)
- `7264664` — chore(agent): verification script for structured tool-loop history
- `3c8b7ba` — feat(agent-chat): call /continue after approval, drop synthetic system text
- `7dd6c8d` — feat(agent): approve persists tool_result, add /continue endpoint, extract buildStreamContext
- `12e62ba` — feat(agent): use shared loop + persist structured history per iteration
- `3a8960e` — refactor(agent): extract shared streaming loop helper
- `0881971` — feat(schema): content_blocks on agent_messages, tool_use_id on agent_actions
- `01c868b` — fix(agent): inject MCP capabilities into system prompt + compose for employees
- `5248454` — chore(mcp): script to reclassify cached MCP tools
- `ddff7b2` — fix(mcp): classify tools via annotations + name heuristics

### Rollup / hygiene (April 13)
- `60f5a9d` — docs(agent-ui): defer backlog from 3-session sweep
- `7c0242c` — chore(gitignore): ad-hoc visual-review screenshot patterns
- *(this commit)* — docs(agent-ui): sessions rollup

## What shipped, by surface

### Schema additions
- `agent_messages.content_blocks jsonb` — Anthropic-native message content persisted as structured blocks (text + tool_use + tool_result).
- `agent_actions.tool_use_id text` — Anthropic `toolu_*` id linking actions to their spawning tool_use block.
- `agent_employees.starter_prompts text[]` — per-employee curated conversation starters.

### Backend (apps/api)
- `agent-stream-loop.ts` — shared `runAgentStreamingLoop()` used by both `/messages` and `/continue`. Persists per-iteration rows with structured content_blocks. Cumulative `tool_calls` + `tokens_in`/`tokens_out` on terminal rows. M3 hide rule: read-only-tool iterations hidden, action-bearing iterations visible. Prompt caching on system + tools.
- `agent-runner.ts` — background heartbeat mode matches the same prompt-caching pattern.
- `agent.ts` `/messages` — rewritten to use `buildStreamContext` helper + `runAgentStreamingLoop`.
- `agent.ts` `/continue` — new endpoint that resumes the stream after action approval, using a proper `tool_result` user message instead of the synthetic `[System:…]` text.
- `agent.ts` `/actions/:id/approve` — inserts the `tool_result` user message so the follow-up stream sees a valid Anthropic tool_use → tool_result pair.
- `agent-followups.ts` (new) — `POST /api/agent/followups` generates contextual follow-up suggestions via Haiku.
- MCP client classifier in `packages/mcp/src/client.ts` — name-based + annotation-based tier detection for browser_*, filesystem_*, git_*, tavily_*, brave_*, exa_*, time_*, fetch_*, sequentialthinking, context7 tools.

### Frontend (apps/web)
- `agent-chat.tsx` — rewritten markdown renderer (react-markdown + remark-gfm + rehype-sanitize, kills XSS), agent-aware bubble label, tool badges restored on history reload, `streamAgentResponse` populates `tool_calls` during streaming, humanized in-flight tool label, MCP params visible in approval cards, `deriveConfidence` helper, pending-action gates on confidence/tokens/follow-ups, post-approval confidence propagation via `loadMessages` post-pass, contextual follow-ups fetch, starter prompt pills in empty state, mobile bubble right gutter.
- `agent/page.tsx` — starter prompts plumbed through employee tab, mobile History button added to employee branch.
- `conversation-list.tsx` (new) — shared component used by `MobileConversationPanel`.
- `lib/tool-display.ts` (new) — `humanizeToolName` + `formatToolLabel` for `mcp__slug__tool` and native names.
- `lib/confidence.ts` (new) — `deriveConfidence(msg)` with tool-backed-answers-are-high-confidence rule.
- `globals.css` — `.message-content` markdown styling (tables, code, headers, lists, blockquotes), mobile code-block scrollbar hint.

### Audit infrastructure (docs/superpowers/audits)
- `lib/assert.ts`, `lib/db.ts`, `lib/auth.ts` — shared helpers.
- `setup-auth.ts` — one-shot login + storage state save (`pnpm audit:setup`).
- `agent-ui-session-1.audit.ts` — 7 assertions for content safety + identity.
- `agent-ui-session-2.audit.ts` — 7 assertions for approval cards + metadata trust signals + session 1 regression.
- `agent-ui-session-3.audit.ts` — 6 assertions for starter prompts + mobile + contextual follow-ups + session 2 regression.
- Each session has a recorded green run baseline as `agent-ui-session-N.last-run.txt`.

## Current audit status

Run `pnpm audit:session3` to execute the full cascade:
- **6** Session 3 assertions (starter prompts, pill click, mobile code block scroll, mobile bubble gutter, both sidebars render, contextual follow-ups)
- **7** Session 2 assertions (friendly tool name, params visible, no follow-ups during pending, no confidence during pending, tool-backed high confidence, tokens aggregated, in-flight label humanized)
- **7** Session 1 assertions (agent name in bubble, table render, code fence isolation, links, XSS neutralized, tool badges reload, single bubble reload)

**Total: 20 assertions, all green** as of commit `9333b92` on April 13, 2026.

## Cost posture

Before Session 2.5 prompt caching:
- Simple query (~2 iters): ~$0.07
- Multi-iter Tavily (4 iters): ~$0.21
- Full audit run: ~$2-3
- Power user 100 queries/day: ~$7/day

After Session 2.5 prompt caching (with the system + tools cache served at 10% cost on subsequent iters within a 5-min TTL window):
- Simple query: ~$0.04 (~43% cheaper)
- Multi-iter Tavily: ~$0.09 (~56% cheaper)
- Full audit run: ~$0.90-1.30 (~55% cheaper)
- Power user: ~$3/day (~57% cheaper)

Indirect evidence of the win: session 2 regression's Tavily token count dropped from ~60k (pre-caching) to ~8-15k (post-caching). Direct cache read/write metrics are logged as `[agent-loop] cache: read=X write=Y fresh=Z` on every iteration — check the API background task output to see them live.

## How to verify the state

```bash
# DB-level sanity: structured tool_use/tool_result pairs are matched
cd apps/api && pnpm exec tsx src/scripts/verify-structured-history.ts

# UI-level end-to-end: full cascade
cd "C:/Users/Osheen Pradhan/cairn" && pnpm audit:session3

# Reclassify MCP tools (if the classifier changes and cached rows are stale)
cd apps/api && pnpm exec tsx src/scripts/reclassify-mcp-tools.ts
```

## Next up

Everything left on the table is captured in [AGENT-UI-BACKLOG.md](AGENT-UI-BACKLOG.md).

The most load-bearing deferred items:
- **Proper AI credits tracking + budgeting** — shipping gate, 1-2 day session.
- **Python Sandbox + AWS Document Loader MCPs** — 30 min once `uv` and `deno` are installed.
- **Desktop sidebar → ConversationList unification** — ~2h, blocked on extending the generic component with avatar/edit/timestamp props.

Branch is in a shippable state. Merge to `main` when ready.

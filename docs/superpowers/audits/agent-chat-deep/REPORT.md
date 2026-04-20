# Agent Chat Deep Audit

**Date:** 2026-04-20T21:29:41.711Z
**Branch:** feat/phase2-4-mcp-agents-plans
**Duration:** 84s
**Viewport:** 1440×900 (headless: false, slowMo: 100ms)
**Passes:** 19  |  **P0:** 0  |  **P1:** 0  |  **P2:** 3  |  **Nits:** 2
**Reply latency:** 35282ms
**Console errors:** 3  |  **Page errors:** 0  |  **Net 4xx/5xx:** 3

## Surfaces Observed

- `/agent` — native Defty chat page with empty state, suggestion chips, and bottom composer
- Desktop sidebar (`<aside>`) — `AgentSidebarContent` with conversation list, rename on double-click, delete on hover
- Mobile history panel — `MobileConversationPanel` behind "History" toggle button
- `AgentChat` component — SSE streaming, `AgentThinking` spinner, `ReasoningTrace` expander, `ActionCard` / `PlanCard` for approvals
- Tool-call badge pills (💬) + collapsible `ReasoningTrace`
- Confidence indicator dot + model/token footer per assistant message
- Contextual follow-up chips (Haiku-generated)
- "Export trace" JSON download button above composer
- Tab bar for Defty + BYOA agent employees (only shown when ≥1 employee is active)
- `ActionCard` (single action) and `PlanCard` (multi-step plan) approval flows
- Undo button (5-minute window after approval)

## P0 — Blocks Release

_None._

## P1 — Must Fix

_None._

## P2 — Should Fix

### Agent response slow (>10s) with no explicit thinking indicator observed in test
Took 35282ms — check if AgentThinking spinner was visible

### Write-action outcome inconclusive
Text excerpt: "h conversations... ⌘K
92
Defty
D
Dogfood PM
A
AuditAgent 9448
A
AuditAgent 4221
A
AuditAgent 4549
A
Alex PM

Create a task titled "agent-chat-audit-1776720546008"

M
◇

Defty

Thinking...
Export trace"

### No agent config drawer / settings panel in agent chat
There is no way to change model, trust level, or enabled tools from the chat surface. These require going to /settings/agent.


## Nits

### No trust level indicator visible in agent chat
Trust level is set in /settings/agent but not surfaced in the chat UI

### No heartbeat turns view in agent chat surface
Heartbeat history is only accessible via /settings/agent-employees/[id]/heartbeats, not from chat


## Coverage Gaps

- **Signed-receipt viewer**: No dedicated receipt modal in current agent-chat.tsx. The "receipt" concept exists in the DB (`agent_actions` table) but is not surfaced in the UI — only raw trace JSON export exists.
- **Agent config drawer**: No in-chat drawer to change model, trust level, or enabled tools. Users must navigate to `/settings/agent` separately.
- **Trust level indicator in chat**: Not visible on the chat surface — requires settings page.
- **Heartbeat turns view in chat**: Not accessible from /agent — only available at `/settings/agent-employees/[id]/heartbeats`.
- **Context selector**: No scope/project/space selector in the chat composer — agent uses workspace-wide context by default.
- **Slash commands**: Not implemented in the native Defty chat surface (no "/" autocomplete).
- **AgentThinking spinner during streaming**: Cannot be captured in a post-hoc screenshot — was not asserted during stream.
- **PlanCard (multi-step)**: Not exercised — would require a prompt that generates ≥2 pending actions.

## Raw Logs

### Console Errors
- `Failed to load resource: the server responded with a status of 401 (Unauthorized)`
- `Failed to load resource: the server responded with a status of 401 (Unauthorized)`
- `Failed to load resource: the server responded with a status of 401 (Unauthorized)`

### Page Errors
_None_

### Network 4xx/5xx
- `401` http://localhost:3001/api/auth/me
- `401` http://localhost:3001/api/auth/me
- `401` http://localhost:3001/api/auth/me

### Passes
- ✓ Landing page renders without no-API-key banner
- ✓ Composer textarea visible
- ✓ Starter chips visible (found 3): What tasks are in progress?, Summarize #engineering this week, What's overdue?
- ✓ Desktop sidebar shows 10 past conversation(s)
- ✓ "New conversation" button present in sidebar
- ✓ Conversation created — id=cd95b530-523d-4886-aa98-103c5ca7b4e2
- ✓ Agent replied in 35282ms
- ✓ Markdown rendered (found block/inline elements in assistant reply)
- ✓ Tool badges visible: 💬 List My Tasks
- ✓ "Show trace" toggle visible
- ✓ ReasoningTrace expanded — shows ordered list of events
- ✓ Confidence indicator dot rendered
- ✓ Model/token footer: "sonnet-4 · 839 tokens"
- ✓ "Export trace" button visible above composer
- ✓ Trace download triggered — filename: agent-trace-cd95b530.json
- ✓ Conversation history persisted — 10 link(s) in sidebar
- ✓ Conversation reloaded — original user message present
- ✓ Defty tab visible in tab bar
- ✓ Multiple agent tabs visible: Defty, DDogfood PM, AAuditAgent 9448, AAuditAgent 4221, AAuditAgent 4549, AAlex PM

## Screenshots Index

- `screenshots/01-landing.png`
- `screenshots/02-before-send.png`
- `screenshots/03-reply-received.png`
- `screenshots/04-tool-call-trace-expanded.png`
- `screenshots/05-write-action.png`
- `screenshots/07-trace-export-area.png`
- `screenshots/08-history-sidebar.png`
- `screenshots/09-history-reload.png`
- `screenshots/10-agent-selection.png`
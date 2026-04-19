# Agent UI — Session 2: Approval Cards + Metadata Trust Signals

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the approval card's tool labels and missing params display, unify confidence logic into one helper that recognizes tool-backed answers as high confidence, gate follow-up suggestions and metadata chrome behind the no-pending-actions state, humanize the in-flight tool label, and aggregate cumulative tokens onto the terminal assistant row so reload shows the full conversation cost. Ship a Session 2 audit script with 7 new assertions plus a Session 1 regression gate.

**Architecture:** Two new shared helpers in `apps/web/src/lib/`: `tool-display.ts` (parses `mcp__{slug}__{tool}` into human labels) and `confidence.ts` (one `deriveConfidence(msg)` function replacing the inline ternary at `agent-chat.tsx:668-678`). `ActionCard` gets a generic params block that handles MCP tools, plus uses `formatToolLabel`. `AgentThinking` and the tool badge pill also use `formatToolLabel`. Follow-up, confidence, and token-metadata render spots gain a `!msg.pending_actions?.length` guard. The server's `agent-stream-loop.ts` starts writing cumulative `tokens_in`/`tokens_out` onto the terminal row (same pattern as the Session 1 cumulative `tool_calls` fix).

**Tech Stack:** Same as Session 1 — TypeScript, React 19, Drizzle, Anthropic SDK, `playwright` Node package for the audit.

**Prerequisites:**
- Session 1 is merged and `pnpm audit:session1` passes (green gate confirmed in `docs/superpowers/audits/agent-ui-session-1.last-run.txt`).
- API on `localhost:3001` with the current stream loop.
- Web on `localhost:3000`.
- `playwright-auth.json` still valid (tokens don't expire for ~24h in dev mode). If the audit fails with auth errors, re-run `pnpm audit:setup`.
- Anthropic API has credit.

---

## What's IN scope

| Bug | Description | File(s) |
|---|---|---|
| **A1** | Approval card shows `mcp__playwright-browser__browser_navigate` — humanize to "Playwright Browser · Browser Navigate" | `ActionCard` in agent-chat.tsx |
| **A2** | Approval card doesn't show params for MCP tools (only native action fields like title/priority) | `ActionCard` in agent-chat.tsx |
| **A3** | Follow-up suggestions render even when a pending approval exists | `agent-chat.tsx:688-700` |
| **A5** | Confidence + token readout render on pre-action intermediate turns | `agent-chat.tsx:668-686` |
| **C1** | Confidence logic duplicated + inconsistent ("Based on limited data" vs "Low confidence") | `lib/confidence.ts` + agent-chat.tsx |
| **C2** | Tool-backed responses show "Low confidence" because citations are empty | `lib/confidence.ts` |
| **T2** | In-flight tool label is raw `mcp__playwright-browser__browser_navigate...` | `AgentThinking` component + tool-display helper |
| **T3** | Reloaded tokens are per-iteration, not cumulative | `agent-stream-loop.ts` (server) |

## What's OUT of scope

- **A4** (resolved action cards collapse) — already renders as a compact "✓ done Undo" chip per `ActionCard` line 846-856. Sequential approvals stacking is cosmetic-only. Re-evaluate in Session 3 if the audit surfaces a concrete user-visible problem.
- Mobile layout (Session 3)
- Starter prompts (Session 3)
- Contextual follow-ups via Haiku (Session 3, stretch)

---

## File Structure

### New files
- `apps/web/src/lib/tool-display.ts` — `humanizeToolName(raw)`, `formatToolLabel(raw)`.
- `apps/web/src/lib/confidence.ts` — `deriveConfidence(msg)` returning `{level, label}`.
- `docs/superpowers/audits/agent-ui-session-2.audit.ts` — 7 new assertions + Session 1 regression block.

### Modified files
- `apps/web/src/components/agent-chat.tsx` — imports both helpers, updates `ActionCard`, `AgentThinking`, the confidence/tokens/follow-ups gates, the tool badge render site.
- `apps/api/src/lib/agent-stream-loop.ts` — accumulate tokens across iterations; write cumulative total to terminal row.

### Not touched
- `apps/web/src/app/globals.css`
- Any DB schema
- Any backend route

---

## Task Breakdown

### Task 1: Create the two helper libraries

**Files:**
- Create: `apps/web/src/lib/tool-display.ts`
- Create: `apps/web/src/lib/confidence.ts`

- [ ] **Step 1.1: Create `tool-display.ts`**

Create `apps/web/src/lib/tool-display.ts`:

```ts
/**
 * Tool name display helpers for agent chat UI.
 *
 * The agent uses internal routing names like `mcp__playwright-browser__browser_navigate`.
 * Users see raw underscores and double-colons, which is developer-facing.
 * This module humanizes them into readable labels.
 */

export type ToolDisplay = {
  /** Humanized connection name, or null for native tools. */
  connection: string | null;
  /** Humanized tool name (without the connection prefix). */
  tool: string;
  /** Combined label suitable for a pill or card header. */
  full: string;
};

/**
 * Parse an MCP or native tool name into display parts.
 *
 * Examples:
 *   mcp__playwright-browser__browser_navigate
 *     → { connection: 'Playwright Browser', tool: 'Browser Navigate', full: 'Playwright Browser · Browser Navigate' }
 *   mcp__tavily-search__tavily_search
 *     → { connection: 'Tavily Search', tool: 'Tavily Search', full: 'Tavily Search · Tavily Search' }
 *   create_task
 *     → { connection: null, tool: 'Create Task', full: 'Create Task' }
 *   sequentialthinking
 *     → { connection: null, tool: 'Sequential Thinking', full: 'Sequential Thinking' }
 */
export function humanizeToolName(raw: string): ToolDisplay {
  if (raw.startsWith('mcp__')) {
    const parts = raw.split('__');
    if (parts.length >= 3) {
      const slug = parts[1]!;
      const toolName = parts.slice(2).join('__');
      const connection = titleCase(slug.replace(/[-_]/g, ' '));
      const tool = titleCase(toolName.replace(/[-_]/g, ' '));
      return { connection, tool, full: `${connection} · ${tool}` };
    }
  }

  // Native tool like create_task, post_message, sequentialthinking
  const spaced = raw
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → spaces
    .replace(/[-_]/g, ' ');
  const tool = titleCase(spaced);
  return { connection: null, tool, full: tool };
}

/**
 * Shorthand — returns the combined `full` label string.
 */
export function formatToolLabel(raw: string): string {
  return humanizeToolName(raw).full;
}

function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ');
}
```

- [ ] **Step 1.2: Create `confidence.ts`**

Create `apps/web/src/lib/confidence.ts`:

```ts
/**
 * Unified confidence indicator logic for agent messages.
 *
 * Replaces the divergent live-streaming vs reload-render code paths that
 * produced different strings for the same state. The rule:
 *   - Tool-backed answers (tool_calls > 0) → high confidence regardless of citations
 *   - ≥3 distinct citations → high
 *   - 1-2 citations → limited
 *   - 0 citations, no tools → low (training data only)
 */

export type ConfidenceLevel = 'high' | 'limited' | 'low';

export type ConfidenceDisplay = {
  level: ConfidenceLevel;
  label: string;
  /** CSS var name for the dot color (without the `var(--` wrapper). */
  colorVar: string;
};

type Message = {
  citations?: { id: string }[] | null;
  tool_calls?: { tool: string }[] | null;
  content?: string;
};

export function deriveConfidence(msg: Message): ConfidenceDisplay {
  const citationCount = msg.citations?.length ?? 0;
  const toolCount = msg.tool_calls?.length ?? 0;

  if (toolCount > 0) {
    return { level: 'high', label: 'High confidence', colorVar: 'success' };
  }
  if (citationCount >= 3) {
    return { level: 'high', label: 'High confidence', colorVar: 'success' };
  }
  if (citationCount >= 1) {
    return { level: 'limited', label: 'Based on limited data', colorVar: 'accent' };
  }
  return { level: 'low', label: 'Low confidence — no direct sources', colorVar: 'danger' };
}
```

- [ ] **Step 1.3: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm --filter @deft/web typecheck
```

Expected: zero errors.

- [ ] **Step 1.4: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add apps/web/src/lib/tool-display.ts apps/web/src/lib/confidence.ts
git commit -m "$(cat <<'EOF'
feat(web): add tool-display and confidence helpers

tool-display: humanizeToolName() / formatToolLabel() parse internal
routing names (mcp__slug__tool, camelCase natives) into readable
labels for pills, approval cards, and in-flight thinking text.

confidence: deriveConfidence(msg) is the single source of truth for
the dot-colored indicator, with a rule that tool-backed answers count
as high confidence even when citation arrays are empty — the previous
divergent inline logic produced "Based on limited data" vs "Low
confidence — no direct sources" for the same state.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire `tool-display` into ActionCard, AgentThinking, and tool badges (A1 + T2)

**Files:**
- Modify: `apps/web/src/components/agent-chat.tsx`

- [ ] **Step 2.1: Import the helper at the top of `agent-chat.tsx`**

Add to the import block (near the other `@/lib` imports if any, otherwise near the top):

```tsx
import { formatToolLabel, humanizeToolName } from '@/lib/tool-display';
```

- [ ] **Step 2.2: Update the tool badge pill render to use `formatToolLabel`**

Find the tool badge render block that Task 3 of Session 1 added (search for `💬` in the JSX). It currently renders:

```tsx
                {msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2.5">
                    {msg.tool_calls.map((tc, ti) => (
                      <button
                        key={ti}
                        className="px-2 py-1 rounded-full text-[11px] font-medium inline-flex items-center gap-1"
                        style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
                      >
                        💬 {tc.tool}
                      </button>
                    ))}
                  </div>
                )}
```

Replace the `💬 {tc.tool}` expression with `💬 {formatToolLabel(tc.tool)}`:

```tsx
                        💬 {formatToolLabel(tc.tool)}
```

- [ ] **Step 2.3: Update the `AgentThinking` component to humanize tool status**

Find the `AgentThinking` component at the top of `agent-chat.tsx` (around line 14-26). Current:

```tsx
function AgentThinking({ toolStatus }: { toolStatus?: string }) {
  return (
    <div className="flex items-center gap-2.5 py-0.5">
      <div className="relative w-4 h-4 flex-shrink-0">
        <div className="absolute inset-0 rounded-full border-[1.5px] border-t-transparent animate-spin"
          style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
      </div>
      <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
        {toolStatus || 'Thinking...'}
      </span>
    </div>
  );
}
```

Replace the `toolStatus` rendering so it's humanized:

```tsx
function AgentThinking({ toolStatus }: { toolStatus?: string }) {
  // toolStatus may arrive as a raw SSE tool name ("mcp__tavily-search__tavily_search")
  // or as a human string ("Searching messages..."). If it looks like an mcp name or a
  // snake_case tool, humanize it via formatToolLabel. Otherwise pass through.
  const display = toolStatus
    ? (/^(mcp__|[a-z_]+$)/.test(toolStatus) ? formatToolLabel(toolStatus) : toolStatus)
    : 'Thinking...';
  return (
    <div className="flex items-center gap-2.5 py-0.5">
      <div className="relative w-4 h-4 flex-shrink-0">
        <div className="absolute inset-0 rounded-full border-[1.5px] border-t-transparent animate-spin"
          style={{ borderColor: 'var(--accent)', borderTopColor: 'transparent' }} />
      </div>
      <span className="text-[12px]" style={{ color: 'var(--muted)' }}>
        {display}
      </span>
    </div>
  );
}
```

- [ ] **Step 2.4: Update `ActionCard` to humanize the tool label**

Find the `ActionCard` component (around line 819). It currently has:

```tsx
  const labels: Record<string, string> = {
    create_task: 'Create task',
    update_task_status: 'Update status',
    assign_task: 'Assign task',
    post_message: 'Post message',
  };
```

This hardcoded map only covers 4 native actions and falls through to `action.action` for MCP tools. Replace the `labels[action.action] || action.action` pattern throughout ActionCard with `humanizedLabel`:

1. At the very top of the function body (right after the destructured `action` parameter), add:

```tsx
  const humanized = humanizeToolName(action.action);
  // Use the legacy label map for native actions to preserve existing copy,
  // otherwise fall through to the humanized label from the helper.
  const labels: Record<string, string> = {
    create_task: 'Create task',
    update_task_status: 'Update status',
    assign_task: 'Assign task',
    post_message: 'Post message',
  };
  const displayLabel = labels[action.action] ?? humanized.full;
```

2. Replace every `labels[action.action] || action.action` and `labels[action.action]` usage in ActionCard with `displayLabel`. This includes:
   - The executing state: `Executing {displayLabel.toLowerCase()}...`
   - The approved-done chip: `{'\u2713'} {displayLabel} — done`
   - The undone chip: `{'\u21A9'} {displayLabel} — undone`
   - The rejected chip: `✗ {displayLabel} — rejected`
   - The pending card title: `{displayLabel}`

- [ ] **Step 2.5: Do the same for `PlanCard`**

`PlanCard` has its own `labels` map (around line 907). Apply the same pattern. For plans there are multiple actions, so compute `displayLabel` inside the per-action render loop:

```tsx
{actions.map((a) => {
  const humanized = humanizeToolName(a.action);
  const displayLabel = labels[a.action] ?? humanized.full;
  // ... existing JSX with `labels[a.action] || a.action` replaced by displayLabel
})}
```

Read the existing `PlanCard` body carefully and apply the substitution consistently. If the existing labels map is different from ActionCard's, keep it as-is — only swap the fallback.

- [ ] **Step 2.6: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm --filter @deft/web typecheck
```

Expected: zero errors.

- [ ] **Step 2.7: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add apps/web/src/components/agent-chat.tsx
git commit -m "$(cat <<'EOF'
fix(agent-chat): humanize tool labels in badges, thinking, approval cards (A1 + T2)

Tool badges, AgentThinking progress text, ActionCard titles, and
PlanCard entries now route through formatToolLabel()/humanizeToolName()
from the new tool-display helper. Users stop seeing raw
mcp__playwright-browser__browser_navigate and get "Playwright Browser ·
Browser Navigate" instead. Native action labels (create_task etc) are
preserved via a small override map inside ActionCard/PlanCard.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: ActionCard params fallback for MCP tools (A2)

**Files:**
- Modify: `apps/web/src/components/agent-chat.tsx` (the `ActionCard` function body)

- [ ] **Step 3.1: Add a generic params render for unrecognized actions**

Still in `ActionCard`, find the params block (around line 881-889) that currently shows:

```tsx
      <div className="text-[12px] mt-1 space-y-0.5" style={{ color: 'var(--foreground-secondary)' }}>
        {action.params.title && <p>"{action.params.title}"</p>}
        {action.params.project_name && <p>{action.params.project_name}</p>}
        {(action.params.priority || action.params.assignee_name) && (
          <p>{[action.params.priority?.toUpperCase(), action.params.assignee_name].filter(Boolean).join(' · ')}</p>
        )}
        {action.params.content && <p>"{action.params.content.slice(0, 80)}..."</p>}
        {action.params.space_name && <p>in #{action.params.space_name}</p>}
      </div>
```

Wrap this with a native-vs-generic branch. Native actions keep the pretty copy; MCP tools get a key-value fallback:

```tsx
      <div className="text-[12px] mt-1 space-y-0.5" style={{ color: 'var(--foreground-secondary)' }}>
        {action.action in labels ? (
          <>
            {action.params.title && <p>"{action.params.title}"</p>}
            {action.params.project_name && <p>{action.params.project_name}</p>}
            {(action.params.priority || action.params.assignee_name) && (
              <p>{[action.params.priority?.toUpperCase(), action.params.assignee_name].filter(Boolean).join(' · ')}</p>
            )}
            {action.params.content && <p>"{action.params.content.slice(0, 80)}..."</p>}
            {action.params.space_name && <p>in #{action.params.space_name}</p>}
          </>
        ) : (
          <GenericParams params={action.params} />
        )}
      </div>
```

- [ ] **Step 3.2: Define `GenericParams`**

Add this helper component just above `ActionCard` in the same file:

```tsx
function GenericParams({ params }: { params: Record<string, any> }) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) {
    return <p style={{ opacity: 0.6 }}>(no parameters)</p>;
  }
  return (
    <div className="space-y-0.5">
      {entries.map(([k, v]) => {
        const isUrl = typeof v === 'string' && /^https?:\/\//.test(v);
        const display =
          typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 120);
        return (
          <p key={k}>
            <span style={{ color: 'var(--muted)' }}>{k}:</span>{' '}
            {isUrl ? (
              <a href={v} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
                {display}
              </a>
            ) : (
              <span>{display}</span>
            )}
          </p>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3.3: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm --filter @deft/web typecheck
```

- [ ] **Step 3.4: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add apps/web/src/components/agent-chat.tsx
git commit -m "$(cat <<'EOF'
fix(agent-chat): render MCP tool params in approval cards (A2)

ActionCard previously only showed params for the 4 native actions it
knew about (create_task / update_task_status / assign_task /
post_message). MCP tools like browser_navigate showed the card header
but no URL, so users were asked to approve a navigation without
knowing where it was going.

Adds GenericParams: a small component that renders any
params-object as key:value pairs, auto-linkifies http(s) URLs, and
truncates long values to 120 chars.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire confidence helper and gate metadata on pending actions (C1 + C2 + A3 + A5)

**Files:**
- Modify: `apps/web/src/components/agent-chat.tsx`

- [ ] **Step 4.1: Import the confidence helper**

Add to the imports at the top of `agent-chat.tsx`:

```tsx
import { deriveConfidence } from '@/lib/confidence';
```

- [ ] **Step 4.2: Replace the inline confidence ternary**

Find the confidence indicator block around lines 667-678:

```tsx
                {/* Confidence indicator */}
                {!msg.streaming && msg.role === 'assistant' && msg.content && (
                  <div className="flex items-center gap-1.5 mt-2 text-[10px]" style={{ color: 'var(--muted)' }}>
                    {(msg.citations?.length || 0) >= 3 ? (
                      <><span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--success)' }} /> High confidence</>
                    ) : (msg.citations?.length || 0) >= 1 ? (
                      <><span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} /> Based on limited data</>
                    ) : (
                      <><span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--danger)' }} /> Low confidence — no direct sources</>
                    )}
                  </div>
                )}
```

Replace with the helper-driven version AND add the pending-action gate (A5):

```tsx
                {/* Confidence indicator — hidden while any tool calls are awaiting approval */}
                {!msg.streaming && msg.role === 'assistant' && msg.content && !msg.pending_actions?.length && (() => {
                  const c = deriveConfidence(msg);
                  return (
                    <div className="flex items-center gap-1.5 mt-2 text-[10px]" style={{ color: 'var(--muted)' }}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: `var(--${c.colorVar})` }} />
                      {c.label}
                    </div>
                  );
                })()}
```

- [ ] **Step 4.3: Gate the token/model metadata on pending_actions**

Find the token metadata render block around lines 680-686:

```tsx
                {/* Token/model metadata */}
                {!msg.streaming && msg.role === 'assistant' && msg.model && (
                  <div className="mt-1 text-[10px]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
                    {msg.model.replace('claude-', '').replace(/-\d+$/, '')}
                    {msg.tokens_in && msg.tokens_out ? ` · ${msg.tokens_in + msg.tokens_out} tokens` : ''}
                  </div>
                )}
```

Add the `!msg.pending_actions?.length` guard:

```tsx
                {/* Token/model metadata — hidden while a tool call awaits approval */}
                {!msg.streaming && msg.role === 'assistant' && msg.model && !msg.pending_actions?.length && (
                  <div className="mt-1 text-[10px]" style={{ color: 'var(--outline)', fontFamily: 'var(--font-mono)' }}>
                    {msg.model.replace('claude-', '').replace(/-\d+$/, '')}
                    {msg.tokens_in && msg.tokens_out ? ` · ${msg.tokens_in + msg.tokens_out} tokens` : ''}
                  </div>
                )}
```

- [ ] **Step 4.4: Gate the follow-up suggestions on pending_actions (A3)**

Find the follow-up render block around lines 688-700:

```tsx
                {/* Follow-up suggestion chips */}
                {!msg.streaming && !streaming && msg.follow_ups && msg.follow_ups.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
```

Add the guard:

```tsx
                {/* Follow-up suggestion chips — hidden while a tool call awaits approval */}
                {!msg.streaming && !streaming && msg.follow_ups && msg.follow_ups.length > 0 && !msg.pending_actions?.length && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
```

- [ ] **Step 4.5: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm --filter @deft/web typecheck
```

- [ ] **Step 4.6: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add apps/web/src/components/agent-chat.tsx
git commit -m "$(cat <<'EOF'
fix(agent-chat): unified confidence, gate metadata on pending actions (C1+C2+A3+A5)

- C1: Confidence indicator now uses deriveConfidence(msg) from the
  shared helper instead of an inline ternary; produces a single
  consistent label regardless of live vs reload code path.
- C2: Tool-backed answers (tool_calls > 0) show "High confidence"
  even when citations are empty — the helper recognizes the tool
  result as a trustworthy source.
- A5: Confidence and token/model metadata are hidden while any
  pending_actions exist — they were rendering on pre-action
  intermediate bubbles where the answer wasn't final yet.
- A3: Follow-up suggestion chips hidden during pending_actions for
  the same reason.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Server cumulative token aggregation (T3)

**Files:**
- Modify: `apps/api/src/lib/agent-stream-loop.ts`

- [ ] **Step 5.1: Accumulate token totals across iterations**

Find the accumulator declarations near the top of `runAgentStreamingLoop` (around line 50-60). The file already has `cumulativeToolCalls` from Session 1. Add two more accumulators right next to it:

Find:
```ts
  // Accumulated across iterations; written to the terminal assistant row's
  // tool_calls column so history reload can render badges on the one visible
  // bubble (all intermediate tool-calling iterations are hidden).
  const cumulativeToolCalls: { tool: string; params: any }[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let iterations = 0;
```

Change to:

```ts
  // Accumulated across iterations; written to the terminal assistant row's
  // tool_calls / tokens_in / tokens_out columns so history reload can render
  // badges + cumulative cost on the one visible bubble (all intermediate
  // tool-calling iterations are hidden).
  const cumulativeToolCalls: { tool: string; params: any }[] = [];
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let iterations = 0;
```

(Only the comment changed — `totalTokensIn` and `totalTokensOut` already exist.)

- [ ] **Step 5.2: Write cumulative totals to the terminal row**

Find the assistant-row insert (around line 89-110). Currently it writes this iteration's own token counts:

```ts
    const isTerminalIteration = toolUseBlocks.length === 0;
    const [assistantRow] = await db.insert(agentMessages).values({
      conversation_id: p.convoId,
      role: 'assistant',
      content: iterText,
      content_blocks: response.content as any,
      hidden: toolUseBlocks.length > 0,
      tool_calls: (isTerminalIteration && cumulativeToolCalls.length > 0)
        ? (cumulativeToolCalls as any)
        : null,
      model: p.model,
      tokens_in: response.usage?.input_tokens ?? null,
      tokens_out: response.usage?.output_tokens ?? null,
    }).returning();
```

On the terminal iteration, write the **cumulative** tokens (sum over all iterations) instead of just this iteration's:

```ts
    const isTerminalIteration = toolUseBlocks.length === 0;
    // totalTokensIn / totalTokensOut already include this iteration's usage
    // (accumulated at the top of the loop after response.usage is read).
    const [assistantRow] = await db.insert(agentMessages).values({
      conversation_id: p.convoId,
      role: 'assistant',
      content: iterText,
      content_blocks: response.content as any,
      hidden: toolUseBlocks.length > 0,
      tool_calls: (isTerminalIteration && cumulativeToolCalls.length > 0)
        ? (cumulativeToolCalls as any)
        : null,
      model: p.model,
      tokens_in: isTerminalIteration ? totalTokensIn : (response.usage?.input_tokens ?? null),
      tokens_out: isTerminalIteration ? totalTokensOut : (response.usage?.output_tokens ?? null),
    }).returning();
```

Verify: above this insert there should be a block that already increments `totalTokensIn` and `totalTokensOut` from `response.usage` BEFORE this insert runs. If the order is wrong and the increment happens AFTER, the terminal row will be missing its own iteration's tokens. Check the current code at ~line 70-74:

```ts
    if (response.usage) {
      totalTokensIn += response.usage.input_tokens || 0;
      totalTokensOut += response.usage.output_tokens || 0;
    }
```

This should be BEFORE the insert (around line 70-74, before line 89). If it's already there, you're fine. If it's missing or in the wrong place, fix it.

- [ ] **Step 5.3: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm --filter @deft/api typecheck
```

- [ ] **Step 5.4: Restart API**

```bash
powershell.exe -Command "Get-NetTCPConnection -State Listen | Where-Object { \$_.LocalPort -eq 3001 } | Select-Object OwningProcess | Format-List"
```

Kill the PID:
```bash
powershell.exe -Command "Stop-Process -Id <PID> -Force"
```

Restart in background:
```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm dev:api
```

Read the background task output file until you see `Deft API running on http://localhost:3001`.

- [ ] **Step 5.5: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add apps/api/src/lib/agent-stream-loop.ts
git commit -m "$(cat <<'EOF'
fix(agent-stream): write cumulative tokens on terminal row (T3)

Reloaded multi-iteration responses were showing tokens from the
final API call only (~18k for a Tavily test that actually used
~60k across 3 iterations). Same pattern as the Session 1 cumulative
tool_calls fix: terminal visible row gets the totalTokensIn /
totalTokensOut running sum; hidden intermediate rows keep their
per-call counts for audit.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Write the Session 2 audit script

**Files:**
- Create: `docs/superpowers/audits/agent-ui-session-2.audit.ts`

- [ ] **Step 6.1: Create the audit script with 7 new assertions + a Session 1 regression block**

Create `docs/superpowers/audits/agent-ui-session-2.audit.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Session 2 audit — approval cards + metadata trust signals.
 *
 * New assertions (7):
 *   1. friendly tool name       — approval card shows humanized label
 *   2. params visible           — approval card shows tool params (URL for browser_navigate)
 *   3. no follow-ups pending    — follow-up chips hidden while action pending
 *   4. no confidence pending    — confidence indicator hidden while action pending
 *   5. tool-backed = high       — final bubble for a tool-backed answer shows "High confidence"
 *   6. tokens aggregated        — multi-iter response shows cumulative tokens on terminal row
 *   7. in-flight label humanized — AgentThinking text during streaming is humanized
 *
 * Regression:
 *   Re-runs all 7 Session 1 assertions (imported from the session-1 script).
 *
 * Prereqs:
 *   - pnpm audit:setup has been run
 *   - API on :3001, web on :3000
 *   - Session 1 green (regression must still pass)
 *
 * Run:  pnpm audit:session2
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { eq, desc } from 'drizzle-orm';
import { assert } from './lib/assert.js';
import { db, schema } from './lib/db.js';
import { getStatePath } from './lib/auth.js';

const { agentConversations } = schema;

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const ALEX_PM_ID = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633';
const AGENT_URL = `${WEB_URL}/agent?employee=${ALEX_PM_ID}`;

// ── helpers (shared shape with session-1 audit) ──────────────────────

async function newConversation(page: Page): Promise<void> {
  await page.goto(AGENT_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('textarea[placeholder*="Ask Alex"]', { state: 'visible', timeout: 10_000 });
}

async function sendAndWaitForResponse(page: Page, prompt: string, timeoutMs = 90_000): Promise<void> {
  const ta = page.locator('textarea[placeholder*="Ask Alex"]');
  await ta.fill(prompt);
  await ta.press('Enter');
  await page.waitForFunction(
    () => {
      const main = document.querySelector('main');
      const text = main?.innerText || '';
      return /tokens\b/.test(text.slice(-500)) || /Approve/.test(text.slice(-500));
    },
    null,
    { timeout: timeoutMs },
  );
}

async function sendAndWaitForApprovalCard(page: Page, prompt: string, timeoutMs = 60_000): Promise<void> {
  const ta = page.locator('textarea[placeholder*="Ask Alex"]');
  await ta.fill(prompt);
  await ta.press('Enter');
  // Wait until an "Approve" button appears in the main area.
  await page.waitForFunction(
    () => {
      const btns = Array.from(document.querySelectorAll('main button'));
      return btns.some((b) => (b.textContent || '').trim() === 'Approve');
    },
    null,
    { timeout: timeoutMs },
  );
}

async function getLatestConversationId(): Promise<string> {
  const [conv] = await db
    .select({ id: agentConversations.id })
    .from(agentConversations)
    .where(eq(agentConversations.agent_employee_id, ALEX_PM_ID))
    .orderBy(desc(agentConversations.updated_at))
    .limit(1);
  assert(conv, 'No conversation found for Alex PM');
  return conv.id;
}

async function screenshotOnFail(page: Page, name: string): Promise<void> {
  try {
    await page.screenshot({ path: `audit-failure-${name}.png`, fullPage: true });
    console.error(`  📸 audit-failure-${name}.png`);
  } catch { /* ignore */ }
}

// ── Session 2 new tests ──────────────────────────────────────────────

async function testFriendlyToolName(page: Page): Promise<void> {
  console.log('  Test 1/7: friendly tool name in approval card...');
  await newConversation(page);
  await sendAndWaitForApprovalCard(
    page,
    'please navigate my browser to https://example.com to verify the page is reachable',
  );
  const mainText = await page.evaluate(() => document.querySelector('main')?.innerText || '');
  // The raw name must NOT appear as a visible string anywhere in the card.
  assert(
    !mainText.includes('mcp__playwright-browser__browser_navigate'),
    `Found raw tool name "mcp__playwright-browser__browser_navigate" in main DOM — humanization failed.\nMain innerText tail: ${mainText.slice(-600)}`,
  );
  // A humanized version should be present. Accept any of these strings.
  const humanizedFound =
    mainText.includes('Playwright Browser') ||
    mainText.includes('Browser Navigate');
  assert(
    humanizedFound,
    `Expected humanized label (Playwright Browser / Browser Navigate) in card, got: ${mainText.slice(-400)}`,
  );
  console.log('    ✓ humanized label shown, raw name hidden');
}

async function testParamsVisible(page: Page): Promise<void> {
  console.log('  Test 2/7: params visible in approval card...');
  // Reuse the conversation from test 1 — the approval card is still present.
  const mainText = await page.evaluate(() => document.querySelector('main')?.innerText || '');
  assert(
    mainText.includes('example.com'),
    `Expected the URL "example.com" to be visible in the approval card, got: ${mainText.slice(-400)}`,
  );
  console.log('    ✓ URL param visible in card');
}

async function testNoFollowUpsPending(page: Page): Promise<void> {
  console.log('  Test 3/7: no follow-ups rendered while pending action exists...');
  // Still on the same conversation with pending card.
  const buttonsText = await page.$$eval('main button', (btns) =>
    btns.map((b) => (b.textContent || '').trim()),
  );
  const hasTellMeMore = buttonsText.some((t) => t === 'Tell me more');
  const hasWhatShould = buttonsText.some((t) => t === 'What should I focus on next?');
  assert(
    !hasTellMeMore && !hasWhatShould,
    `Follow-up chips should NOT render while action is pending. Found: ${JSON.stringify(buttonsText.filter((t) => t === 'Tell me more' || t === 'What should I focus on next?'))}`,
  );
  console.log('    ✓ no follow-up chips during pending action');
}

async function testNoConfidencePending(page: Page): Promise<void> {
  console.log('  Test 4/7: no confidence label while pending action exists...');
  const mainText = await page.evaluate(() => document.querySelector('main')?.innerText || '');
  const forbidden = ['Low confidence', 'High confidence', 'Based on limited data'];
  for (const f of forbidden) {
    assert(
      !mainText.includes(f),
      `Confidence label "${f}" should not render during pending action. Found in: ${mainText.slice(-400)}`,
    );
  }
  console.log('    ✓ no confidence label during pending action');
}

async function testToolBackedIsHighConfidence(page: Page): Promise<void> {
  console.log('  Test 5/7: tool-backed answer shows High confidence...');
  await newConversation(page);
  await sendAndWaitForResponse(
    page,
    'what time is it in Tokyo right now — use a time tool',
    90_000,
  );
  const mainText = await page.evaluate(() => document.querySelector('main')?.innerText || '');
  assert(
    mainText.includes('High confidence'),
    `Expected "High confidence" on a tool-backed response, got tail: ${mainText.slice(-500)}`,
  );
  assert(
    !mainText.includes('Low confidence'),
    `A tool-backed response should NOT show "Low confidence". Got tail: ${mainText.slice(-500)}`,
  );
  console.log('    ✓ tool-backed answer shows High confidence');
}

async function testTokensAggregated(page: Page): Promise<void> {
  console.log('  Test 6/7: cumulative tokens shown on terminal row...');
  await newConversation(page);
  await sendAndWaitForResponse(
    page,
    'use tavily search to find 2 articles about React Server Components and summarize',
    180_000,
  );
  const convId = await getLatestConversationId();
  await page.goto(`${WEB_URL}/agent?id=${convId}&employee=${ALEX_PM_ID}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForTimeout(2000);

  const mainText = await page.evaluate(() => document.querySelector('main')?.innerText || '');
  // Extract the " · NNNN tokens" number from the token metadata line.
  const m = mainText.match(/·\s+(\d+)\s+tokens/);
  assert(m, `Expected a "· N tokens" token readout, got tail: ${mainText.slice(-400)}`);
  const tokens = parseInt(m![1]!, 10);
  // A single Tavily-enabled iteration costs ~12-18k; two iterations ~30k+.
  // Pre-fix the reloaded value was ~15k (one iter only). Post-fix it should
  // be the cumulative sum — typically well above 20k.
  assert(
    tokens >= 20_000,
    `Expected cumulative tokens >= 20000 on a multi-iter Tavily response, got ${tokens}`,
  );
  console.log(`    ✓ cumulative tokens = ${tokens}`);
}

async function testInFlightLabelHumanized(page: Page): Promise<void> {
  console.log('  Test 7/7: in-flight tool label humanized...');
  await newConversation(page);
  const ta = page.locator('textarea[placeholder*="Ask Alex"]');
  await ta.fill('use tavily to search for recent react news, keep it brief');
  await ta.press('Enter');
  // Poll the main innerText until we see either a humanized label or the raw tool name.
  const captured = await page.waitForFunction(
    () => {
      const text = document.querySelector('main')?.innerText || '';
      const hasRaw = /mcp__tavily[-_]search__tavily_search/.test(text);
      const hasHuman = /Tavily Search/.test(text);
      // Return once we've seen either signal (the assertion below decides if it's good).
      if (hasRaw || hasHuman) return { hasRaw, hasHuman };
      return null;
    },
    null,
    { timeout: 60_000 },
  );
  const { hasRaw, hasHuman } = (await captured.jsonValue()) as { hasRaw: boolean; hasHuman: boolean };
  assert(
    !hasRaw,
    'Raw tool name "mcp__tavily-search__tavily_search" observed in live UI — humanization of in-flight label failed',
  );
  assert(hasHuman, 'Did not observe a humanized "Tavily Search" label during streaming');
  // Wait for completion before returning so subsequent tests start from a clean state.
  await page.waitForFunction(
    () => /tokens\b/.test((document.querySelector('main')?.innerText || '').slice(-500)),
    null,
    { timeout: 120_000 },
  );
  console.log('    ✓ in-flight label humanized (no raw mcp__ string observed)');
}

// ── Session 1 regression suite ───────────────────────────────────────

// Import the Session 1 tests by re-executing them. Easiest approach: shell
// out to `pnpm audit:session1` and treat a non-zero exit as a regression
// failure. This keeps the two scripts independent — if session 1's logic
// changes, the regression automatically picks up the new rules.
async function runSession1Regression(): Promise<void> {
  console.log('\n── Session 1 regression ──');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('pnpm', ['audit:session1'], {
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    throw new Error(`Session 1 regression audit failed (exit ${result.status})`);
  }
  console.log('── Session 1 regression passed ──\n');
}

// ── runner ───────────────────────────────────────────────────────────

async function main() {
  console.log('Session 2 audit — approval cards + metadata trust signals\n');

  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: getStatePath() });
  const page = await ctx.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error(`  [page.console.error] ${msg.text()}`);
    }
  });

  const tests = [
    testFriendlyToolName,
    testParamsVisible,
    testNoFollowUpsPending,
    testNoConfidencePending,
    testToolBackedIsHighConfidence,
    testTokensAggregated,
    testInFlightLabelHumanized,
  ];

  let failed = 0;
  for (const t of tests) {
    try {
      await t(page);
    } catch (err) {
      failed++;
      console.error(`  ❌ ${t.name}: ${err instanceof Error ? err.message : err}`);
      await screenshotOnFail(page, t.name);
    }
  }

  await browser.close();

  if (failed > 0) {
    console.error(`\n❌ Session 2 audit: ${failed} failure(s)`);
    process.exit(1);
  }

  // Only run regression if session 2 itself is green.
  try {
    await runSession1Regression();
  } catch (err) {
    console.error(`\n❌ Session 2 audit passed but regression failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  console.log(`\n✅ Session 2 audit: all ${tests.length} assertions passed + Session 1 regression clean`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Audit runner crashed:', e);
  process.exit(1);
});
```

- [ ] **Step 6.2: Add `audit:session2` to root `package.json` scripts**

Open `package.json` at the repo root. Add under `"scripts"`:

```json
    "audit:session2": "tsx docs/superpowers/audits/agent-ui-session-2.audit.ts"
```

Place it alphabetically after `audit:session1`.

- [ ] **Step 6.3: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add docs/superpowers/audits/agent-ui-session-2.audit.ts package.json
git commit -m "$(cat <<'EOF'
test(agents): session-2 audit script (7 new + session-1 regression)

Asserts approval card humanization, params visibility, follow-up /
confidence / tokens gating on pending actions, tool-backed high
confidence, cumulative token aggregation on reload, and humanized
in-flight tool label during streaming. Re-runs pnpm audit:session1 as
a regression gate after the new assertions pass.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Run the audit + fix to green

- [ ] **Step 7.1: Run the audit**

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm audit:session2
```

Expected tail (exit 0):

```
Session 2 audit — approval cards + metadata trust signals

  Test 1/7: friendly tool name in approval card...
    ✓ humanized label shown, raw name hidden
  Test 2/7: params visible in approval card...
    ✓ URL param visible in card
  Test 3/7: no follow-ups rendered while pending action exists...
    ✓ no follow-up chips during pending action
  Test 4/7: no confidence label while pending action exists...
    ✓ no confidence label during pending action
  Test 5/7: tool-backed answer shows High confidence...
    ✓ tool-backed answer shows High confidence
  Test 6/7: cumulative tokens shown on terminal row...
    ✓ cumulative tokens = NNNNN
  Test 7/7: in-flight tool label humanized...
    ✓ in-flight label humanized (no raw mcp__ string observed)

── Session 1 regression ──
[... session 1 audit output ...]
── Session 1 regression passed ──

✅ Session 2 audit: all 7 assertions passed + Session 1 regression clean
```

- [ ] **Step 7.2: Debug any failing assertions**

Debug table:

| Failing test | Most likely cause | Where to look |
|---|---|---|
| testFriendlyToolName | `humanizeToolName` not wired into ActionCard title | agent-chat.tsx ActionCard displayLabel |
| testParamsVisible | GenericParams not reached (labels map still has a match?) OR URL rendered as title not body | agent-chat.tsx ActionCard params branch |
| testNoFollowUpsPending | missing `!msg.pending_actions?.length` guard on follow-ups block | agent-chat.tsx around line 689 |
| testNoConfidencePending | same guard missing on confidence block | agent-chat.tsx around line 668 |
| testToolBackedIsHighConfidence | `deriveConfidence` not checking `tool_calls` OR loadMessages not populating tool_calls (Session 1 fallback) | lib/confidence.ts + agent-chat.tsx loadMessages |
| testTokensAggregated | Server-side aggregation missing or wrong order (increment after insert) | agent-stream-loop.ts |
| testInFlightLabelHumanized | AgentThinking not using formatToolLabel OR toolStatus never set to the raw mcp name | agent-chat.tsx AgentThinking + streamAgentResponse tool_start handler |
| Regression fail on testToolBadgesReload | cumulativeToolCalls still writing to terminal row, OK; check tool badge render uses formatToolLabel not raw | agent-chat.tsx tool badge block |

Fix one thing at a time. Re-run the audit after each fix.

- [ ] **Step 7.3: Record the green run**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
pnpm audit:session2 > docs/superpowers/audits/agent-ui-session-2.last-run.txt 2>&1
git add docs/superpowers/audits/agent-ui-session-2.last-run.txt
git commit -m "$(cat <<'EOF'
chore(audits): record session-2 green run

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- A1 humanize approval card label → Task 2 (ActionCard displayLabel) ✓
- A2 params visible → Task 3 (GenericParams) ✓
- A3 follow-ups gated → Task 4 Step 4.4 ✓
- A4 resolved card collapse → out of scope, documented ✓
- A5 confidence/tokens gated on pending → Task 4 Steps 4.2-4.3 ✓
- C1 single confidence helper → Task 1 (confidence.ts) + Task 4 Step 4.2 ✓
- C2 tool-backed high confidence → Task 1 (confidence.ts rule) ✓
- T2 humanize in-flight label → Task 2 Step 2.3 (AgentThinking) ✓
- T3 cumulative tokens on terminal → Task 5 ✓
- Audit script → Task 6 ✓
- Regression gate → Task 6 Step 6.1 (spawnSync pnpm audit:session1) ✓

**Placeholder scan:** all steps have complete code or exact commands. No TBD/TODO. Debug table has specific next-steps per failure.

**Type consistency:**
- `humanizeToolName` return shape `{ connection, tool, full }` consistent across Task 1 and Task 2 call sites.
- `deriveConfidence` return shape `{ level, label, colorVar }` — used once in Task 4 Step 4.2.
- `ActionCard`'s `displayLabel` is a local const, consistent within the function.
- Cumulative token fields match the existing `totalTokensIn`/`totalTokensOut` locals and the `tokens_in`/`tokens_out` column names.

**Known risks:**
- The `testTokensAggregated` threshold (20,000 tokens) assumes Tavily's multi-iter cost. If Alex answers in one iteration with a cached result, the threshold may not be met. Adjust down if needed.
- The `testFriendlyToolName` test asks Alex to "please navigate my browser to example.com" — if the classifier ever auto-executes `browser_navigate` (currently `quick-approve` tier), the approval card won't appear. If that happens, use a definitely-full-review tool like `browser_run_code` or a native write action.
- `testInFlightLabelHumanized` relies on Playwright catching the in-flight state before the stream completes. Fast responses may bypass the capture window. The function uses `waitForFunction` with a 60s timeout — should be adequate.
- `runSession1Regression` uses `spawnSync` to invoke `pnpm`; on Windows, `pnpm` is a shim and spawnSync with `shell: true` is required. The script has `shell: true` set — verify it works on the first run.

---

## Execution Handoff

Per the user's memory (`feedback_subagent_driven.md`), proceeding with subagent-driven execution via `superpowers:subagent-driven-development`.

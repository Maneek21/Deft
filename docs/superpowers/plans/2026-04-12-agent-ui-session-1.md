# Agent UI — Session 1: Content Safety + Identity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled regex markdown renderer in `agent-chat.tsx` with a proper library (killing the XSS vulnerability and multiple rendering bugs), use `agentName` in the bubble header, restore tool badges on history reload, hide intermediate tool-call iterations from reload rendering, and ship a reusable Playwright audit script that gates all of this behavior.

**Architecture:** The message render pipeline is replaced end-to-end: `react-markdown` for parsing (GFM tables, code, lists, links), `remark-gfm` for the GitHub flavor, `rehype-sanitize` for XSS safety. `dangerouslySetInnerHTML` is eliminated. Three smaller fixes cluster in `agent-chat.tsx` (bubble label, tool badges reload) and `agent-stream-loop.ts` (hide intermediate iterations). A standalone Playwright audit script at `docs/superpowers/audits/agent-ui-session-1.audit.ts` creates fresh conversations, runs 7 targeted assertions, and exits non-zero on any failure — this script is the regression gate for Session 2 and Session 3.

**Tech Stack:** TypeScript, React 19, Next.js 16, `react-markdown` 9.x, `remark-gfm` 4.x, `rehype-sanitize` 6.x, `playwright` (Node package, not the MCP plugin), Drizzle ORM, pnpm workspaces.

**Prerequisites:**
- API running on `localhost:3001` (background task already live).
- Web dev server running on `localhost:3000` (background task already live).
- Node + pnpm installed (already).
- Alex PM employee `7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633` (already exists).
- An active user in Alex's org with known credentials OR an access token. If no known credentials, the implementer will create a test user via a seed helper in Task 4.

---

## File Structure

### Modified files
- `apps/web/package.json` — add 3 deps.
- `apps/web/src/components/agent-chat.tsx` — replace markdown renderer, fix bubble label, restore tool badges.
- `apps/web/src/app/globals.css` — add styling for the new markdown output (tables, headers, code blocks, lists).
- `apps/api/src/lib/agent-stream-loop.ts` — flip the `hidden` rule for intermediate iterations.

### New files
- `package.json` at workspace root — add `playwright` as devDep and an `audit:*` script entry.
- `.gitignore` — ignore `playwright-auth.json` and `audit-failure.png`.
- `docs/superpowers/audits/lib/auth.ts` — login helper that POSTs to `/api/auth/login`, injects token into a playwright browser context, saves `playwright-auth.json` storage state.
- `docs/superpowers/audits/lib/db.ts` — tiny drizzle client for tests that need DB-level injection (XSS test).
- `docs/superpowers/audits/lib/assert.ts` — hard assert helper with screenshot-on-fail.
- `docs/superpowers/audits/setup-auth.ts` — one-shot: runs `lib/auth.ts`, saves storage state, prints success.
- `docs/superpowers/audits/agent-ui-session-1.audit.ts` — the 7-assertion audit script.

### Files deliberately NOT touched
- `packages/db/src/schema.ts` — no schema changes this session.
- `apps/api/src/routes/agent.ts` — no route changes; only `agent-stream-loop.ts` touched.
- Any other UI component — scope discipline.

---

## Task Breakdown

### Task 1: Install dependencies

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package.json` (workspace root)

- [ ] **Step 1.1: Install markdown libraries in the web app**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
pnpm --filter @deft/web add react-markdown@9 remark-gfm@4 rehype-sanitize@6
```

Expected: pnpm installs 3 packages + their deps. No errors.

- [ ] **Step 1.2: Install playwright as a workspace-root dev dep**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
pnpm add -Dw playwright@1
```

Expected: playwright and its sub-deps land in root `node_modules`. pnpm prints warning if versions conflict — ignore unless it refuses.

- [ ] **Step 1.3: Install chromium binary (one-time)**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
pnpm exec playwright install chromium
```

Expected: downloads ~150MB chromium into `%USERPROFILE%\AppData\Local\ms-playwright\`. If already installed from a previous run, it's a no-op.

- [ ] **Step 1.4: Add audit script entries to root `package.json`**

Open `package.json` at the repo root. Add two entries under `"scripts"`:

```json
    "audit:setup": "tsx docs/superpowers/audits/setup-auth.ts",
    "audit:session1": "tsx docs/superpowers/audits/agent-ui-session-1.audit.ts"
```

Place them alphabetically sorted with the existing entries. If the root package.json has no `tsx` available, also add `tsx@4` via `pnpm add -Dw tsx@4` (check with `pnpm exec tsx --version` first — it's likely already hoisted from the api package).

- [ ] **Step 1.5: Update `.gitignore`**

Open `.gitignore` at the repo root and append:

```
# Audit script state (contains access tokens)
playwright-auth.json
audit-failure-*.png
```

- [ ] **Step 1.6: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add apps/web/package.json package.json pnpm-lock.yaml .gitignore
git commit -m "$(cat <<'EOF'
chore(web): add react-markdown + remark-gfm + rehype-sanitize, playwright devDep

Preparation for Session 1 of the agent UI audit plan: replacing the
hand-rolled markdown renderer and standing up a Playwright audit
script. playwright and tsx go at the workspace root so audit scripts
can live in docs/ without cross-package import pain.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Replace markdown renderer (M1)

**Files:**
- Modify: `apps/web/src/components/agent-chat.tsx` (remove `renderAgentMarkdown` function at lines 62-93, replace `dangerouslySetInnerHTML` usage at line 607)
- Modify: `apps/web/src/app/globals.css` (add `.message-content` style block)

- [ ] **Step 2.1: Remove the hand-rolled renderer function**

Delete lines 62-93 of `apps/web/src/components/agent-chat.tsx` (the entire `renderAgentMarkdown` function).

- [ ] **Step 2.2: Add react-markdown imports at the top of `agent-chat.tsx`**

Near the other imports at the top of the file (around line 3-7), add:

```tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
```

- [ ] **Step 2.3: Replace the assistant message content render**

Find line 605-607 in `agent-chat.tsx`, which currently reads:

```tsx
                      <div className="message-content text-[13px] leading-relaxed"
                        dangerouslySetInnerHTML={{ __html: renderAgentMarkdown(msg.content || (msg.streaming ? '' : '...')) }} />
```

Replace with:

```tsx
                      <div className="message-content text-[13px] leading-relaxed">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          rehypePlugins={[[rehypeSanitize, defaultSchema]]}
                        >
                          {msg.content || (msg.streaming ? '' : '...')}
                        </ReactMarkdown>
                      </div>
```

- [ ] **Step 2.4: Add markdown styles to globals.css**

Open `apps/web/src/app/globals.css` and append this block at the very bottom:

```css
/* Agent chat markdown — replaces the hand-rolled renderer's inline styles */
.message-content p {
  margin: 0.25rem 0;
}
.message-content p:first-child {
  margin-top: 0;
}
.message-content p:last-child {
  margin-bottom: 0;
}
.message-content h1,
.message-content h2,
.message-content h3 {
  font-weight: 600;
  margin: 0.75rem 0 0.25rem;
  line-height: 1.3;
}
.message-content h1 { font-size: 1.1rem; }
.message-content h2 { font-size: 1.05rem; }
.message-content h3 { font-size: 1rem; }
.message-content ul,
.message-content ol {
  padding-left: 1.25rem;
  margin: 0.25rem 0;
}
.message-content ul { list-style: disc; }
.message-content ol { list-style: decimal; }
.message-content li {
  margin: 0.125rem 0;
}
.message-content li > p {
  display: inline;
}
.message-content pre {
  background: var(--surface-container-low, #1a1a1f);
  border: 1px solid var(--border, #2a2a35);
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin: 0.5rem 0;
  overflow-x: auto;
  font-size: 0.8125rem;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.message-content pre code {
  background: none;
  padding: 0;
  border-radius: 0;
  color: inherit;
}
.message-content code {
  background: var(--surface-container, #26262e);
  padding: 0.125rem 0.35rem;
  border-radius: 4px;
  font-size: 0.85em;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.message-content table {
  border-collapse: collapse;
  margin: 0.5rem 0;
  font-size: 0.8125rem;
  width: auto;
  max-width: 100%;
  display: block;
  overflow-x: auto;
}
.message-content th,
.message-content td {
  border: 1px solid var(--border, #2a2a35);
  padding: 0.375rem 0.75rem;
  text-align: left;
  vertical-align: top;
}
.message-content th {
  background: var(--surface-container-low, #1a1a1f);
  font-weight: 600;
}
.message-content tr:nth-child(2n) td {
  background: rgba(255, 255, 255, 0.02);
}
.message-content blockquote {
  border-left: 3px solid var(--accent);
  padding-left: 0.75rem;
  margin: 0.5rem 0;
  color: var(--foreground-secondary, #a0a0b0);
}
.message-content a {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.message-content a:hover {
  opacity: 0.8;
}
.message-content strong { font-weight: 600; }
.message-content em { font-style: italic; }
.message-content hr {
  border: none;
  border-top: 1px solid var(--border, #2a2a35);
  margin: 0.75rem 0;
}
```

- [ ] **Step 2.5: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm --filter @deft/web typecheck
```

Expected: zero errors.

- [ ] **Step 2.6: Visual smoke check (quick)**

The web dev server auto-reloads. Open `http://localhost:3000/agent?employee=7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633` and start a fresh conversation. Ask Alex:

```
give me a table comparing useState, useEffect, useMemo, useCallback with columns: hook, purpose, when to use. Also include a short code example for each with code fences.
```

Expected: a real HTML `<table>` renders (not raw pipes), code blocks render with monospace font and no stray bullets, inline code renders with a subtle background.

If the render looks broken, check the browser devtools for CSS collisions with `.message-content`. Do NOT proceed to commit until the smoke check passes visually.

- [ ] **Step 2.7: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add apps/web/src/components/agent-chat.tsx apps/web/src/app/globals.css
git commit -m "$(cat <<'EOF'
fix(agent-chat): replace hand-rolled markdown renderer with react-markdown

Kills the dangerouslySetInnerHTML XSS path, adds proper GFM support
(tables, task lists, autolinks), and fixes the code-fence content
leaking into list/bold rules. New .message-content CSS block provides
styling for headers, tables, code, lists, and blockquotes.

Bugs fixed: M1a (no tables), M1b (fence isolation), M1c (XSS), M1d
(paragraph collapse), M1e (no link rendering).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Small fixes (I1 + T1 + M3)

**Files:**
- Modify: `apps/web/src/components/agent-chat.tsx`
- Modify: `apps/api/src/lib/agent-stream-loop.ts`

This task bundles three small, tightly-related fixes. All three can be committed separately or as one — implementer's choice. Commit separately if a reviewer is involved; combined if solo.

- [ ] **Step 3.1: I1 — Use `agentName` in bubble label**

In `apps/web/src/components/agent-chat.tsx`, find the hardcoded `<p>Deft</p>` label for assistant messages. It's around line 591-592:

```tsx
                {msg.role === 'assistant' && (
                  <p className="text-[12px] font-semibold mb-1"
                    style={{ color: 'var(--accent)' }}>Deft</p>
                )}
```

Replace with:

```tsx
                {msg.role === 'assistant' && (
                  <p className="text-[12px] font-semibold mb-1"
                    style={{ color: 'var(--accent)' }}>{agentName || 'Defty'}</p>
                )}
```

Note: the fallback is "Defty" not "Deft" — the superintendent agent is Defty. "Deft" was an accidental abbreviation.

- [ ] **Step 3.2: T1 — Restore tool badges on history reload**

Still in `agent-chat.tsx`. Find `loadMessages` in the `useEffect` around line 148-195. Currently:

```tsx
        setMessages(data.map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          citations: m.citations || [],
          pending_actions: (m.pending_actions || []).map((a: any) => ({
            id: a.id,
            action: a.action,
            params: a.params,
            approval_tier: a.approval_tier,
            status: a.status,
            result: a.result,
            executed_at: a.executed_at,
            error: a.error,
          })),
          auto_executed: [],
          model: m.model,
          tokens_in: m.tokens_in,
          tokens_out: m.tokens_out,
        })));
```

Change the object literal to also extract tool calls from `content_blocks`:

```tsx
        setMessages(data.map((m: any) => {
          // Extract tool_use blocks from content_blocks (new structured format).
          // Fallback to legacy m.tool_calls for old rows.
          let toolCalls: { tool: string; params: any; result?: any }[] = [];
          if (Array.isArray(m.content_blocks)) {
            toolCalls = m.content_blocks
              .filter((b: any) => b && b.type === 'tool_use')
              .map((b: any) => ({ tool: b.name, params: b.input }));
          } else if (Array.isArray(m.tool_calls)) {
            toolCalls = m.tool_calls;
          }
          return {
            id: m.id,
            role: m.role,
            content: m.content,
            citations: m.citations || [],
            pending_actions: (m.pending_actions || []).map((a: any) => ({
              id: a.id,
              action: a.action,
              params: a.params,
              approval_tier: a.approval_tier,
              status: a.status,
              result: a.result,
              executed_at: a.executed_at,
              error: a.error,
            })),
            auto_executed: [],
            tool_calls: toolCalls,
            model: m.model,
            tokens_in: m.tokens_in,
            tokens_out: m.tokens_out,
          };
        }));
```

- [ ] **Step 3.3: Verify the existing AgentMessage type allows `tool_calls`**

Search `agent-chat.tsx` for `type AgentMessage` (around line 37). Confirm it has `tool_calls?: any[]` or similar. If not, add it:

```tsx
type AgentMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  pending_actions?: (PendingAction & { status?: string; executed_at?: string })[];
  auto_executed?: AutoExecutedAction[];
  tool_calls?: { tool: string; params: any; result?: any }[];
  streaming?: boolean;
  thinking?: boolean;
  tool_status?: string;
  model?: string;
  tokens_in?: number;
  tokens_out?: number;
  follow_ups?: string[];
};
```

The existing tool badge render (search for `tool_calls` later in the file) should pick up the populated array automatically. If the render site has drifted or is missing, the implementer must find it and verify. If there is no existing tool-calls render block yet (i.e. the badges are only rendered via SSE events), the implementer must add one: the render block goes inside the assistant message body, after the main content div, rendering one pill per `msg.tool_calls` entry:

```tsx
                {msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2.5">
                    {msg.tool_calls.map((tc, ti) => (
                      <button
                        key={ti}
                        className="px-2 py-1 rounded-full text-[11px] font-medium"
                        style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}
                      >
                        💬 {tc.tool}
                      </button>
                    ))}
                  </div>
                )}
```

Check whether this render already exists before adding. Grep for `tool_calls` in the JSX section of the file.

- [ ] **Step 3.4: M3 — Hide intermediate iterations with tool calls**

Open `apps/api/src/lib/agent-stream-loop.ts`. Find the assistant-row insert inside the loop — it's around line 80-95, with this current code:

```ts
    // Persist this assistant iteration with structured content_blocks.
    const [assistantRow] = await db.insert(agentMessages).values({
      conversation_id: p.convoId,
      role: 'assistant',
      content: iterText,
      content_blocks: response.content as any,
      hidden: toolUseBlocks.length > 0 && !iterText, // intermediate "I'll search" turns with no text stay hidden
      model: p.model,
      tokens_in: response.usage?.input_tokens ?? null,
      tokens_out: response.usage?.output_tokens ?? null,
    }).returning();
```

Change the `hidden` line to:

```ts
      hidden: toolUseBlocks.length > 0, // any iteration that made tool calls is hidden from reload UI — only the terminal iteration (no tool_use) stays visible
```

Also update the comment above the insert (or add one) to explain why: intermediate narration is streamed live but not persisted-as-visible, so history reload shows exactly one bubble per user question.

- [ ] **Step 3.5: Typecheck**

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm --filter @deft/api typecheck && pnpm --filter @deft/web typecheck
```

Expected: zero errors.

- [ ] **Step 3.6: Restart API**

The in-memory stream loop in the API process is still running the old hide rule. Kill and restart:

```bash
powershell.exe -Command "Get-NetTCPConnection -State Listen | Where-Object { \$_.LocalPort -eq 3001 } | Select-Object OwningProcess | Format-List"
```

Kill the PID, then start via Bash with `run_in_background: true`:

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm dev:api
```

Read the background task output file to confirm "Deft API running on http://localhost:3001" appears.

- [ ] **Step 3.7: Commit**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add apps/web/src/components/agent-chat.tsx apps/api/src/lib/agent-stream-loop.ts
git commit -m "$(cat <<'EOF'
fix(agent-chat): show agent name, restore tool badges on reload, hide intermediate iterations

Three related UI bugs:
- I1: bubble header hardcoded 'Deft' regardless of which agent; now
  reads the agentName prop (fallback 'Defty').
- T1: history reload never populated tool_calls so the 💬 pills
  disappeared on navigate-back; now extracted from content_blocks.
- M3: agent-stream-loop persisted every iteration with narration as
  visible, causing multi-iter responses to render as N separate Deft
  bubbles on reload instead of the one bubble shown during streaming.
  Flipped the hide rule so any iteration with tool_use blocks is
  hidden — only the terminal (text-only, end_turn) iteration stays.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Audit infrastructure (auth helper + lib)

**Files:**
- Create: `docs/superpowers/audits/lib/auth.ts`
- Create: `docs/superpowers/audits/lib/db.ts`
- Create: `docs/superpowers/audits/lib/assert.ts`
- Create: `docs/superpowers/audits/setup-auth.ts`

- [ ] **Step 4.1: Create `lib/assert.ts`**

Create `docs/superpowers/audits/lib/assert.ts`:

```ts
/**
 * Hard assertion helper for audit scripts. Throws with a descriptive
 * message when the condition is false. The caller catches + screenshots
 * + exits non-zero.
 */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    );
  }
}

export function assertIncludes(haystack: string, needle: string, message: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(
      `Assertion failed: ${message}\n  expected substring: ${JSON.stringify(needle)}\n  not found in: ${JSON.stringify(haystack.slice(0, 500))}`,
    );
  }
}
```

- [ ] **Step 4.2: Create `lib/db.ts`**

Create `docs/superpowers/audits/lib/db.ts`:

```ts
/**
 * Minimal drizzle client for audit scripts. Reuses the schema from
 * @deft/db but opens its own pg connection (audits may run while the
 * API is also running).
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@deft/db/schema';
import 'dotenv/config';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL not set — check root .env');
}

const pool = new pg.Pool({ connectionString });

export const db = drizzle(pool, { schema });
export { schema };
```

- [ ] **Step 4.3: Create `lib/auth.ts`**

Create `docs/superpowers/audits/lib/auth.ts`:

```ts
/**
 * Login helper that POSTs to /api/auth/login, retrieves an access
 * token, then saves a Playwright storageState file so audit scripts
 * can reuse the session.
 *
 * Env vars:
 *   DEFT_TEST_EMAIL       — seed user email (required)
 *   DEFT_TEST_PASSWORD    — seed user password (required)
 *   DEFT_API_URL          — default http://localhost:3001
 *   DEFT_WEB_URL          — default http://localhost:3000
 *   DEFT_AUTH_STATE_PATH  — default playwright-auth.json at repo root
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const API_URL = process.env.DEFT_API_URL || 'http://localhost:3001';
const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const STATE_PATH = process.env.DEFT_AUTH_STATE_PATH || 'playwright-auth.json';

export async function loginAndSaveState(): Promise<void> {
  const email = process.env.DEFT_TEST_EMAIL;
  const password = process.env.DEFT_TEST_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'DEFT_TEST_EMAIL and DEFT_TEST_PASSWORD must be set. Create a test user first or pass env vars from your shell.',
    );
  }

  // 1. Login via API to get tokens.
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; refresh_token?: string };
  if (!data.access_token) {
    throw new Error(`Login response missing access_token: ${JSON.stringify(data)}`);
  }

  // 2. Spin up a browser, inject the token into localStorage, navigate
  //    to /dashboard so the session is fully established, save state.
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Inject the token BEFORE navigation so Deft's auth context picks it
  // up on first render.
  await page.addInitScript(
    ({ at, rt }) => {
      window.localStorage.setItem('deft-access-token', at);
      if (rt) window.localStorage.setItem('deft-refresh-token', rt);
    },
    { at: data.access_token, rt: data.refresh_token ?? null },
  );
  await page.goto(`${WEB_URL}/dashboard`, { waitUntil: 'networkidle' });

  const state = await ctx.storageState();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(`Saved storage state to ${STATE_PATH}`);

  await browser.close();
}

export function getStatePath(): string {
  return STATE_PATH;
}
```

- [ ] **Step 4.4: Create `setup-auth.ts`**

Create `docs/superpowers/audits/setup-auth.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Usage:
 *   DEFT_TEST_EMAIL=you@example.com DEFT_TEST_PASSWORD=yourpass \
 *     pnpm audit:setup
 */
import 'dotenv/config';
import { loginAndSaveState } from './lib/auth.js';

async function main() {
  try {
    await loginAndSaveState();
    console.log('✅ Auth state saved. Ready to run audit scripts.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Auth setup failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
```

- [ ] **Step 4.5: Obtain test credentials**

The audit scripts need a login. Pick one of these paths:

**Path A (preferred if a known user exists):** set env vars from your shell:

```bash
export DEFT_TEST_EMAIL="<existing-user-email>"
export DEFT_TEST_PASSWORD="<existing-user-password>"
```

Find an existing user via:

```bash
cd "C:/Users/Osheen Pradhan/cairn/apps/api" && pnpm exec tsx -e "
import { db } from './src/lib/db.js';
import { users, orgMembers } from '@deft/db/schema';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
async function main() {
  const r = await db.execute(sql\`
    SELECT u.email, u.name, u.password_hash IS NOT NULL AS has_password
    FROM users u
    JOIN org_members m ON m.user_id = u.id
    WHERE m.org_id = (SELECT org_id FROM agent_employees WHERE id = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633')
    LIMIT 5
  \`);
  for (const row of r.rows) console.log(row);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
"
```

Ask the HUMAN for the password of the returned user (they'll provide it interactively). Do NOT store the password in git.

**Path B (if no test user with a known password):** create one. The implementer must pause and ask the human for a desired test email + password, then either:
- Use the `/api/auth/signup` endpoint via curl to create it, or
- Insert directly via a tsx script that imports `bcrypt` (already in db package).

Stop and report to the controller if Path A doesn't work. Do NOT guess passwords.

- [ ] **Step 4.6: Run `audit:setup` and verify the state file**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
DEFT_TEST_EMAIL="$DEFT_TEST_EMAIL" DEFT_TEST_PASSWORD="$DEFT_TEST_PASSWORD" pnpm audit:setup
```

Expected: prints `Saved storage state to playwright-auth.json` then `✅ Auth state saved`. A new `playwright-auth.json` file appears at the repo root (gitignored).

If login fails with 401, the credentials are wrong. Report to controller.

- [ ] **Step 4.7: Commit the audit infrastructure (but NOT the auth state file — it's gitignored)**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add docs/superpowers/audits/lib/assert.ts docs/superpowers/audits/lib/db.ts docs/superpowers/audits/lib/auth.ts docs/superpowers/audits/setup-auth.ts
git status --short docs/superpowers/audits/
git commit -m "$(cat <<'EOF'
chore(audits): playwright audit infrastructure (auth, db, assert helpers)

Standalone test infra for the 3-session agent UI audit plan. setup-auth
logs in to the dev API with seed credentials (env vars), saves a
playwright storageState file the audit scripts reuse. lib/db gives
audits DB-level access for tests that need to inject specific state
(e.g. XSS neutralization checks).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

Confirm `playwright-auth.json` is NOT in the staged files. It should be gitignored per Task 1 step 1.5.

---

### Task 5: Write the Session 1 audit script

**Files:**
- Create: `docs/superpowers/audits/agent-ui-session-1.audit.ts`

- [ ] **Step 5.1: Create the audit script with all 7 assertions**

Create `docs/superpowers/audits/agent-ui-session-1.audit.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Session 1 audit — content safety + identity.
 *
 * Asserts:
 *   1. agentName in bubble   — bubble header shows "Alex PM" not "Deft"
 *   2. table renders         — GFM table renders as <table>, not raw pipes
 *   3. code fence isolated   — content inside ```...``` has no stray <li>
 *   4. links clickable       — markdown links become <a href>
 *   5. XSS neutralized       — img/onerror in injected content does not execute
 *   6. tool badges on reload — 💬 pill present after history reload
 *   7. single bubble reload  — multi-iteration response shows as 1 bubble, not N
 *
 * Prereqs:
 *   - pnpm audit:setup has been run and playwright-auth.json exists
 *   - API on :3001, web on :3000
 *
 * Run:  pnpm audit:session1
 */
import 'dotenv/config';
import { chromium, type Browser, type Page } from 'playwright';
import { writeFileSync } from 'node:fs';
import { eq, desc, and } from 'drizzle-orm';
import { assert, assertIncludes } from './lib/assert.js';
import { db, schema } from './lib/db.js';
import { getStatePath } from './lib/auth.js';

const { agentMessages, agentConversations } = schema;

const WEB_URL = process.env.DEFT_WEB_URL || 'http://localhost:3000';
const ALEX_PM_ID = '7e79b0a9-f88c-49f4-b79d-ab8a7c7f1633';
const AGENT_URL = `${WEB_URL}/agent?employee=${ALEX_PM_ID}`;

// ── helpers ──────────────────────────────────────────────────────────

async function newConversation(page: Page): Promise<void> {
  await page.goto(AGENT_URL, { waitUntil: 'networkidle' });
  // Wait for the composer to be ready.
  await page.waitForSelector('textarea[placeholder*="Ask Alex"]', { state: 'visible', timeout: 10_000 });
}

async function sendAndWaitForResponse(page: Page, prompt: string, timeoutMs = 90_000): Promise<void> {
  const ta = page.locator('textarea[placeholder*="Ask Alex"]');
  await ta.fill(prompt);
  await ta.press('Enter');
  // Wait for the streaming placeholder and its completion (tokens line appears).
  await page.waitForFunction(
    () => {
      const main = document.querySelector('main');
      const text = main?.innerText || '';
      return /tokens\b/.test(text.slice(-500));
    },
    null,
    { timeout: timeoutMs },
  );
}

async function getLatestAssistantText(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const main = document.querySelector('main');
    return main?.innerText || '';
  });
}

async function countDeftBubbles(page: Page, label: string): Promise<number> {
  return await page.$$eval('main p', (els, lbl) => {
    return els.filter((e) => (e.textContent?.trim() || '') === lbl).length;
  }, label);
}

async function screenshotOnFail(page: Page, name: string): Promise<void> {
  try {
    const file = `audit-failure-${name}.png`;
    await page.screenshot({ path: file, fullPage: true });
    console.error(`  📸 ${file}`);
  } catch {
    // ignore
  }
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

// ── tests ────────────────────────────────────────────────────────────

async function testBubbleLabel(page: Page): Promise<void> {
  console.log('  Test 1/7: agent name in bubble...');
  await newConversation(page);
  await sendAndWaitForResponse(page, 'hi alex, say hello back in one short sentence');
  const alexCount = await countDeftBubbles(page, 'Alex PM');
  const deftCount = await countDeftBubbles(page, 'Deft');
  assert(
    alexCount >= 1,
    `Expected bubble header to say "Alex PM" at least once; saw ${alexCount}. Deft-labeled bubbles: ${deftCount}`,
  );
  console.log(`    ✓ bubble label = Alex PM (${alexCount} found)`);
}

async function testTableRendering(page: Page): Promise<void> {
  console.log('  Test 2/7: markdown table renders as <table>...');
  await newConversation(page);
  await sendAndWaitForResponse(
    page,
    'respond ONLY with a markdown table that has 3 rows comparing useState, useEffect, useMemo with columns hook, purpose. no other text.',
  );
  const tableCount = await page.locator('main table').count();
  assert(tableCount >= 1, `Expected at least one <table> in response, got ${tableCount}`);
  const rowCount = await page.locator('main table tr').count();
  assert(rowCount >= 3, `Expected at least 3 <tr> rows (header + 2 data), got ${rowCount}`);
  console.log(`    ✓ table rendered with ${rowCount} rows`);
}

async function testCodeFenceIsolation(page: Page): Promise<void> {
  console.log('  Test 3/7: code fence content is isolated...');
  await newConversation(page);
  await sendAndWaitForResponse(
    page,
    'write a react component in a typescript code fence that uses useState with items: string[] and maps over them with items.map(item => (- {item}))',
  );
  // Find <pre><code> block content and assert it has no rogue <li> tags inside.
  const preInnerHTML = await page.$$eval('main pre code', (els) => els.map((e) => e.innerHTML).join('\n'));
  assert(preInnerHTML.length > 0, 'Expected at least one <pre><code> block');
  assert(
    !/<li\b/.test(preInnerHTML),
    `Code fence content contains <li> tags (markdown parser leaked into the code block): ${preInnerHTML.slice(0, 300)}`,
  );
  console.log(`    ✓ code fence isolated (${preInnerHTML.length} chars, 0 <li>)`);
}

async function testLinksClickable(page: Page): Promise<void> {
  console.log('  Test 4/7: markdown links render as <a href>...');
  await newConversation(page);
  await sendAndWaitForResponse(
    page,
    'respond with a bulleted list of 3 React docs links in markdown format: [title](https://react.dev/...)',
  );
  const linkCount = await page.locator('main a[href^="https://react.dev"]').count();
  assert(linkCount >= 1, `Expected at least one <a href="https://react.dev..."> link, got ${linkCount}`);
  console.log(`    ✓ ${linkCount} clickable react.dev links rendered`);
}

async function testXssNeutralized(page: Page): Promise<void> {
  console.log('  Test 5/7: XSS payload is neutralized...');
  // Insert a synthetic assistant row with an XSS payload directly into the DB.
  const [conv] = await db
    .insert(agentConversations)
    .values({
      user_id: 'audit-user-placeholder', // overwritten below
      org_id: 'audit-org-placeholder',
      agent_employee_id: ALEX_PM_ID,
      title: 'XSS audit test',
    })
    .returning()
    .catch(() => [null]);
  // The DB may reject due to FK constraints. Fallback: use the latest existing convo.
  let convId: string;
  if (conv) {
    convId = conv.id;
  } else {
    convId = await getLatestConversationId();
  }

  const xssContent = `<img src=x onerror="window.__deft_xss_triggered=true">`;
  await db.insert(agentMessages).values({
    conversation_id: convId,
    role: 'assistant',
    content: xssContent,
    hidden: false,
  });

  // Navigate to that conversation and check the flag.
  await page.goto(`${WEB_URL}/agent?id=${convId}&employee=${ALEX_PM_ID}`, { waitUntil: 'networkidle' });
  // Give the message list a moment to render.
  await page.waitForTimeout(1500);
  const xssTriggered = await page.evaluate(() => (window as any).__deft_xss_triggered === true);
  assert(xssTriggered === false, 'XSS payload executed — renderAgentMarkdown or ReactMarkdown did not sanitize');

  // Also verify the raw HTML was not injected as an executable <img onerror>.
  const imgWithOnerror = await page.locator('main img[onerror]').count();
  assert(imgWithOnerror === 0, `Found ${imgWithOnerror} <img onerror> elements in the DOM — sanitizer failed`);

  console.log('    ✓ XSS neutralized (no execution, no <img onerror>)');
}

async function testToolBadgesReload(page: Page): Promise<void> {
  console.log('  Test 6/7: tool badges visible after reload...');
  await newConversation(page);
  await sendAndWaitForResponse(
    page,
    'what is the current time in Tokyo? use the time tool',
    120_000,
  );
  const convId = await getLatestConversationId();

  // Reload the conversation from URL (fresh history load path).
  await page.goto(`${WEB_URL}/agent?id=${convId}&employee=${ALEX_PM_ID}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // Look for a button containing "💬" — the tool badge pill.
  const badges = await page.$$eval('main button', (btns) =>
    btns.map((b) => b.textContent?.trim() || '').filter((t) => t.includes('💬')),
  );
  assert(
    badges.length >= 1,
    `Expected at least one 💬 tool badge after reload, got ${badges.length}. Buttons: ${JSON.stringify(badges)}`,
  );
  console.log(`    ✓ ${badges.length} tool badge(s) visible on reload: ${badges.join(', ')}`);
}

async function testSingleBubbleReload(page: Page): Promise<void> {
  console.log('  Test 7/7: multi-iteration response = 1 bubble on reload...');
  await newConversation(page);
  // Tavily search forces the agent into multiple iterations.
  await sendAndWaitForResponse(
    page,
    'use tavily search to find 2 recent articles about react 19 and summarize them in 3 bullet points',
    180_000,
  );
  const convId = await getLatestConversationId();

  // Reload and count assistant bubbles.
  await page.goto(`${WEB_URL}/agent?id=${convId}&employee=${ALEX_PM_ID}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  const bubbleCount = await countDeftBubbles(page, 'Alex PM');
  assert(
    bubbleCount === 1,
    `Expected exactly 1 Alex PM bubble on reload of a multi-iter response, got ${bubbleCount}`,
  );
  console.log(`    ✓ exactly 1 Alex PM bubble on reload`);
}

// ── runner ───────────────────────────────────────────────────────────

async function main() {
  console.log('Session 1 audit — content safety + identity\n');

  const browser: Browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: getStatePath() });
  const page = await ctx.newPage();

  // Capture console errors so failures are easier to diagnose.
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error(`  [console.error] ${msg.text()}`);
    }
  });

  const tests = [
    testBubbleLabel,
    testTableRendering,
    testCodeFenceIsolation,
    testLinksClickable,
    testXssNeutralized,
    testToolBadgesReload,
    testSingleBubbleReload,
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
    console.error(`\n❌ Session 1 audit: ${failed} failure(s)`);
    process.exit(1);
  }
  console.log(`\n✅ Session 1 audit: all ${tests.length} assertions passed`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Audit runner crashed:', e);
  process.exit(1);
});
```

- [ ] **Step 5.2: Commit the audit script**

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add docs/superpowers/audits/agent-ui-session-1.audit.ts
git commit -m "$(cat <<'EOF'
test(agents): session-1 audit script (7 assertions)

Regression gate for Session 2: asserts agent-name bubble label,
markdown table rendering, code fence isolation, clickable links,
XSS neutralization, tool badges on history reload, single bubble per
multi-iter response on reload.

Run: pnpm audit:session1 (requires pnpm audit:setup first)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Run the audit + fix to green

**Files:**
- No new files; fixes go in `apps/web/src/components/agent-chat.tsx` or `apps/api/src/lib/agent-stream-loop.ts` if any assertion fails.

- [ ] **Step 6.1: Run the audit**

```bash
cd "C:/Users/Osheen Pradhan/cairn" && pnpm audit:session1
```

Expected output on success:

```
Session 1 audit — content safety + identity

  Test 1/7: agent name in bubble...
    ✓ bubble label = Alex PM (1 found)
  Test 2/7: markdown table renders as <table>...
    ✓ table rendered with 4 rows
  Test 3/7: code fence content is isolated...
    ✓ code fence isolated (NNN chars, 0 <li>)
  Test 4/7: markdown links render as <a href>...
    ✓ 3 clickable react.dev links rendered
  Test 5/7: XSS payload is neutralized...
    ✓ XSS neutralized (no execution, no <img onerror>)
  Test 6/7: tool badges visible after reload...
    ✓ 1 tool badge(s) visible on reload: 💬 Time: current_time
  Test 7/7: multi-iteration response = 1 bubble on reload...
    ✓ exactly 1 Alex PM bubble on reload

✅ Session 1 audit: all 7 assertions passed
```

Exit code 0.

- [ ] **Step 6.2: Debug any failing assertions**

If a test fails:

1. The audit saves a screenshot as `audit-failure-<testName>.png` at the repo root. Open it.
2. Re-read the failing test's assertion and compare to the screenshot.
3. Likely culprits per test:

| Failing test | Most likely cause | Where to look |
|---|---|---|
| testBubbleLabel | `agentName` not plumbed | agent-chat.tsx:591-592 |
| testTableRendering | `remarkGfm` not enabled | agent-chat.tsx `ReactMarkdown` props |
| testCodeFenceIsolation | `rehypeSanitize` stripped fences OR old regex renderer still present | agent-chat.tsx:62-93 (should be deleted) |
| testLinksClickable | `defaultSchema` blocks `a[href]` | agent-chat.tsx `rehypeSanitize` config — widen schema |
| testXssNeutralized | `rehypeSanitize` not wired | agent-chat.tsx imports & plugin chain |
| testToolBadgesReload | Task 3 Step 3.2 extraction broken | check `loadMessages` output; also verify a tool-call render site exists in JSX |
| testSingleBubbleReload | Task 3 Step 3.4 hide rule broken OR API not restarted | check `agent-stream-loop.ts:80` + API log |

4. Fix ONE thing at a time. Re-run the audit. Repeat until green.

- [ ] **Step 6.3: Commit any fixes**

If fixes were needed:

```bash
cd "C:/Users/Osheen Pradhan/cairn"
git add <specific files>
git commit -m "fix(agent-chat): address session-1 audit failures — <brief>"
```

- [ ] **Step 6.4: Final green run — save output to docs**

After green, capture the successful run:

```bash
cd "C:/Users/Osheen Pradhan/cairn"
pnpm audit:session1 2>&1 | tee docs/superpowers/audits/agent-ui-session-1.last-run.txt
git add docs/superpowers/audits/agent-ui-session-1.last-run.txt
git commit -m "chore(audits): record session-1 green run"
```

This file is checked in so future sessions can compare baseline timings / assertion output.

---

## Self-Review

**Spec coverage:**
- M1 (markdown renderer replacement) → Task 2 ✓
- I1 (agent name in bubble) → Task 3 Step 3.1 ✓
- T1 (tool badges on reload) → Task 3 Steps 3.2-3.3 ✓
- M3 (hide intermediate iterations) → Task 3 Step 3.4 ✓
- M2 (intermediate narration concat) → falls out of M3 (no intermediates rendered at all) ✓
- Audit infrastructure → Task 4 ✓
- 7 session-1 assertions → Task 5 ✓
- Green gate → Task 6 ✓

**Placeholder scan:**
- Every step shows complete code or exact command.
- Expected outputs shown for every run step.
- Failure-mode debugging table in Task 6 gives concrete next steps.
- No TBD/TODO/"handle errors appropriately".

**Type consistency:**
- `AgentMessage.tool_calls` type matches the shape written in Step 3.2 (`{ tool; params; result? }[]`).
- `loadMessages` reads `m.content_blocks` (array of blocks with `type: 'tool_use'`) — matches what `agent-stream-loop.ts` writes (Anthropic `response.content` passed through as-is).
- `getStatePath()` used in both `setup-auth.ts` and the audit script, defined once in `lib/auth.ts`.
- Audit-script DB imports use `@deft/db/schema` — same path as `apps/api/src/lib/db.ts`.

**Known risks:**
- `rehypeSanitize` `defaultSchema` may be too strict (e.g., blocks `<a>` without protocol allowlist). Task 6 Step 6.2 calls this out as the debug path for testLinksClickable / testXssNeutralized.
- The DB XSS injection in Test 5 may fail FK checks if `audit-user-placeholder` / `audit-org-placeholder` aren't valid. The fallback uses `getLatestConversationId` which works against an existing convo — good.
- `pnpm audit:setup` depends on the user having login credentials. Task 4 Step 4.5 is blocking; implementer must escalate if no test user is available.

**Secrets handling:**
- `playwright-auth.json` contains the access token. Gitignored in Task 1 Step 1.5.
- `DEFT_TEST_PASSWORD` is only passed via env var, never written to source.
- `audit-failure-*.png` may include PII (conversation content); gitignored.

---

## Execution Handoff

Per the user's memory (`feedback_subagent_driven.md`), proceeding with subagent-driven execution via `superpowers:subagent-driven-development`.

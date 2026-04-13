# Agent UI — Deferred Backlog

Pulled from the 3-session agent UI sweep (April 12-13, 2026). Items here were surfaced but intentionally not shipped. Each has enough context to pick up cold in a future session.

## 🟡 Near-term (ship when convenient)

### 1. Desktop sidebar → ConversationList unification
- **Why deferred:** sidebar has avatars, inline title editing, time-ago timestamps that the generic component doesn't support.
- **Fix path:** extend `apps/web/src/components/conversation-list.tsx` with optional `leadingAvatar`, `allowInlineEdit`, `showTimestamp` props; then swap sidebar.tsx's inline map.
- **Effort:** ~2h
- **Files:** `apps/web/src/components/conversation-list.tsx`, `apps/web/src/components/sidebar.tsx`

### 2. Starter prompts editor UI
- **Why deferred:** shipped seed-only in Session 3. No settings page for per-employee customization.
- **Fix path:** settings/employees/[id] route with a tag-style editor that PATCHes `agent_employees.starter_prompts`.
- **Effort:** ~3-4h
- **Files:** new settings route, `apps/api/src/routes/agent-employees.ts` PATCH handler.

### 3. Auto-execute action audit logging
- **Why deferred:** Session 1's `agent-stream-loop.ts` uses `executeToolCall` in the auto-execute branch instead of `executeActionDirect`, skipping the `agent_actions` audit row for auto-executed writes. Unexercised under conservative trust (Alex PM's org).
- **Fix path:** branch on `isAction && shouldAutoExecute` and call `executeActionDirect` so the audit row is created with `approval_status='approved'` + `approved_at=now()`.
- **Effort:** ~30 min
- **Files:** `apps/api/src/lib/agent-stream-loop.ts`
- **Blocking trigger:** adding a second org with `standard` or `autonomous` trust level.

### 4. Python Sandbox + AWS Document Loader MCPs
- **Why deferred:** both require `uv` (astral) and/or `deno` installed on the host. Windows dev box doesn't have them yet.
- **Fix path:**
  ```powershell
  winget install astral-sh.uv
  winget install DenoLand.Deno
  ```
  Then add two BUNDLE entries in `apps/api/src/scripts/install-tier1-mcp-bundle.ts`:
  ```ts
  { slug: 'python-sandbox', name: 'Python Sandbox', transport: 'stdio',
    stdio_command: 'uvx', stdio_args: ['mcp-run-python', 'stdio'], required: false },
  { slug: 'document-loader', name: 'Document Loader', transport: 'stdio',
    stdio_command: 'uvx', stdio_args: ['awslabs.document-loader-mcp-server'], required: false },
  ```
  Extend `classifyTool` in `packages/mcp/src/client.ts` with:
  - `run_python_code`, `python_repl`, `run_javascript_code` → auto-execute
  - `read_pdf`, `read_docx`, `read_xlsx`, `read_pptx`, `load_document`, `extract_text` → auto-execute
- **Effort:** ~30 min after tools installed.
- **Files:** `install-tier1-mcp-bundle.ts`, `packages/mcp/src/client.ts`

### 5. Starter prompts a11y
- **Why deferred:** scope call for Session 3.
- **Fix path:** keyboard nav (arrow keys between pills), ARIA labels (`role="button"`, `aria-label`), visible focus ring on tab.
- **Effort:** ~1h
- **Files:** `apps/web/src/components/agent-chat.tsx` (empty-state pills render block).

---

## 🟢 Polish (nice to have)

### 6. Contextual follow-ups cache
- **Why deferred:** the Haiku call is ~$0.0005 each, not worth cache overhead right now.
- **Fix path:** if/when analytics show the same prompts repeating across users, add a small in-memory LRU or Redis cache keyed on `hash(userPrompt + firstNChars(response))` in `apps/api/src/routes/agent-followups.ts`.
- **Effort:** ~1h when/if needed.

### 7. Real-phone mobile verification
- **Why deferred:** all mobile testing was Playwright headless at viewport 390×844. Touch-scroll physics on the new code-block scrollbar weren't tested on iOS Safari / Android Chrome.
- **Fix path:** manual pass on an actual phone — scroll a long code block, click a starter pill, open the mobile History panel.
- **Effort:** 15 min.

### 8. 401 `/api/auth/me` console noise
- **Why deferred:** pre-existing auth refresh race, cosmetic only. Pollutes devtools but doesn't affect functionality.
- **Fix path:** guard the `/me` call behind a `hasToken` check, or intercept the fetch in `auth-context.tsx` to swallow the 401 if no token is present.
- **Effort:** ~30 min.
- **Files:** `apps/web/src/lib/auth-context.tsx` or similar.

### 9. Legacy conversation cleanup
- **Why deferred:** conversation `86eba2cf-6df3-4d23-b3fc-ce5dc0295202` (the original Alex PM / Verge repetition conversation) has pre-fix broken state. History loader graceful-degrades but it looks ugly in the sidebar.
- **Fix path:** either delete the conversation outright (safe, it's test data), or write a one-shot migration to backfill the broken synthesis messages.
- **Effort:** 2 min delete; 1h migration.

### 10. Session 2.5 prompt caching live verification
- **Why deferred:** credits ran out before a clean verification run could be logged. Indirect evidence (token counts dropping ~60k → ~9k on identical multi-iter tests) confirms it's working, but the `[agent-loop] cache: read=X write=Y fresh=Z` log line has never been captured directly.
- **Fix path:** on next agent query, check the background API log for a line containing `cache:`. Expected: first call in a 5-min window has `write=~10000 read=0`, subsequent calls have `read=~10000 write=0`.
- **Effort:** 2 min observation, no code change.

---

## 🔵 Shipping-gate (before public launch)

### 11. Proper AI credits tracking + budgeting
- **Why deferred:** user explicitly punted to ship-time. Two credit-exhaustion incidents during this sweep prove the lack of visibility is a real operational risk.
- **Scope:**
  - Per-user + per-org token and $-spend counters in DB (new table or extend agent_messages).
  - Visible UI meter in the agent page header (running total for the day).
  - Hard caps per-user and per-org with graceful error messages.
  - Overage alerts (email or in-app notification).
  - Per-model cost table (Sonnet, Haiku, Opus) for accurate attribution.
  - Prompt-cache attribution (cached tokens billed at 0.1×).
- **Effort:** 1-2 day session of its own.

### 12. Audit script auth refresh automation
- **Why deferred:** `playwright-auth.json` stored tokens expire with the test user's session. Re-running audits weeks later requires manual `pnpm audit:setup`.
- **Fix path:** have `pnpm audit:session*` auto-run setup if the state file is missing or the first navigation returns a 401.
- **Effort:** ~30 min.
- **Files:** `docs/superpowers/audits/lib/auth.ts`, each session audit script.

---

## 📋 Not on this list (done-done)

Everything else from Sessions 1, 2, 2.5, and 3 is shipped and green. The `feat/phase2-4-mcp-agents-plans` branch contains ~40 commits and 20 passing audit assertions across 3 suites. See the sessions rollup doc for the full commit list.

## Related docs

- [Session 1 plan](2026-04-12-agent-ui-session-1.md)
- [Session 2 plan](2026-04-12-agent-ui-session-2.md)
- [Session 3 plan](2026-04-13-agent-ui-session-3.md)
- [Tier-1 MCP bundle plan](2026-04-12-tier1-mcp-bundle.md)
- [Playwright approval repetition fix plan](2026-04-12-playwright-approval-repetition-fixes.md)
- Sessions rollup: `2026-04-13-agent-ui-sessions-rollup.md` *(landed in Phase 2)*

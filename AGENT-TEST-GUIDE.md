# Deft — Agent & Platform Behaviour Test Guide

Focused human testing checklist for the **agent employee runtime** and the **platform surfaces that support it**. Everything shipped in Phases 7 through 12 (plus task 61 enum work) is covered here. Walk top to bottom. Check `[x]` as you go.

Assume the automated regression suites (`pnpm --filter @deft/api test`, `pnpm audit:*`) are green before you start. This guide is the **behavioural sanity check** — the thing you only catch by driving the browser and watching the database in real time.

---

## 0. Prerequisites

- [ ] `pnpm dev` running — web on `3000`, API on `3001`
- [ ] PG on 5432, Redis on 6379 (ok even if Redis is down — jobs use the Postgres queue)
- [ ] `.env` has **all** of:
  - `NEXT_PUBLIC_FEATURE_OPENCLAW_EMPLOYEES=true`
  - `NEXT_PUBLIC_DEFT_SELF_HOSTED=true`
  - `METRICS_SCRAPE_TOKEN=` some non-empty value
  - `ANTHROPIC_API_KEY=` real key
- [ ] Logged in as `maneek@test.com / test1234` in the org seeded by `seed-templates.ts`
- [ ] One psql shell open against `cairn` for spot checks (`PGPASSWORD=postgres "C:\Program Files\PostgreSQL\16\bin\psql.exe" -h localhost -U postgres -d cairn`)
- [ ] One terminal tailing the API process so you can watch cron + MCP logs

---

## 1. Defty (native agent, in-process)

### 1.1 Chat query with tool use
- [ ] Open `/agent`, tab = **Defty**
- [ ] New conversation — ask: **"What's the P0 in review right now?"**
- [ ] Response should include:
  - [ ] A tool chip (`Search Tasks` or similar) showing the MCP/tool call it used
  - [ ] An actual list (or "none") that **matches the board state** (cross-check against `/tasks`)
  - [ ] "High confidence" / confidence pill
  - [ ] Model name + token count in the metadata row (`sonnet-4 · NNN tokens`)
  - [ ] **2 contextual follow-up buttons** (the Haiku T4 stretch)
- [ ] Conversation appears in the sidebar with fresh timestamp
- [ ] Click the new conversation in sidebar — should restore the full turn on top

### 1.2 Multi-turn reasoning
- [ ] In the same conversation: ask **"Who should I assign to it?"** (implied reference)
- [ ] Defty should pull in prior context, not start fresh
- [ ] Should mention members by name and probably check workload

### 1.3 Defty write action (approval flow)
- [ ] Trust level at `conservative`: ask Defty **"Create a task called `human-test-smoke` in Deft v1"**
- [ ] Defty should NOT auto-create — should return a **pseudo-result** explaining the action is queued for approval
- [ ] Go to Settings → Agent → **Pending Approvals**. Row should appear.
- [ ] Click **Approve**. Row should disappear from pending, appear in **Action Log** with `approved` status
- [ ] Open `/tasks` — the `human-test-smoke` task should exist in Deft v1 Backlog
- [ ] **Database check (psql):**
  ```sql
  SELECT id, action, approval_status, executed_at FROM agent_actions
    WHERE action = 'create_task' ORDER BY created_at DESC LIMIT 1;
  ```
  expect `approval_status='approved'`, `executed_at IS NOT NULL`

### 1.4 Defty rejection path
- [ ] Ask Defty **"Post a message to #general saying HELLO WORLD"**
- [ ] Queued in Pending Approvals
- [ ] Click **Reject**. Row moves to Action Log with `rejected` status
- [ ] Open `/chat` → `#general` — the message should NOT be there
- [ ] **Database check:** the corresponding `messages` row must not exist

### 1.5 Race-condition spot check (optional but catches the Phase 12 atomic-claim fix)
- [ ] Create two pending agent_actions (easiest: ask Defty to create two tasks in conservative mode)
- [ ] Open Settings → Agent in two browser tabs
- [ ] Click Approve on the same action in both tabs **as fast as you can**
- [ ] The task should be created **exactly once**. Second click should return a friendly "already approved" message, not a duplicate task.
- [ ] `SELECT COUNT(*) FROM tasks WHERE title = 'dup-test'` — must be 1

---

## 2. Agent Employees page

### 2.1 Settings → Agent landing
- [ ] Navigate to `/settings/agent`
- [ ] Verify sections render in this order, each visible:
  - [ ] `Trust Level` with 3 cards, current org level highlighted
  - [ ] `Gateway health` (shows empty state if no openclaw employees)
  - [ ] `Employees` with `Deploy new employee` button on the right
  - [ ] Existing `Alex PM` card with `Native` badge + `N turns / 24h heartbeat`
  - [ ] `Pending Approvals`
  - [ ] `Action Log` — newest first, each row has `View receipt` button

### 2.2 Trust-level switching
- [ ] Click **Standard** — card highlights, no error flash
- [ ] Refresh the page — Standard is still selected (persisted)
- [ ] Back to **Conservative** for the rest of the tests

### 2.3 Trust upgrade → ConfirmDangerous
- [ ] Click Alex PM card → drawer opens
- [ ] Click **Upgrade to autonomous**
- [ ] Modal appears titled something like "Confirm trust upgrade"
- [ ] Type a wrong word (e.g. lowercase `autonomous`) → confirm button **stays disabled**
- [ ] Clear, type exactly `AUTONOMOUS` → confirm button **enables**
- [ ] Press **Esc** — modal closes, trust level unchanged
- [ ] Reopen, type `AUTONOMOUS` again, click confirm → trust level flips
- [ ] **Database check:**
  ```sql
  SELECT trust_level FROM agent_employees WHERE slug = 'alex-pm';
  ```
  should read `autonomous`
- [ ] Flip it back to `conservative` via the same flow so later tests start clean

### 2.4 Employee delete (ConfirmDangerous variant)
- [ ] Deploy a throwaway employee first (see §5)
- [ ] Open its drawer → click **Delete**
- [ ] Modal asks you to type the employee slug exactly
- [ ] Wrong slug → disabled
- [ ] Right slug → enabled → confirm
- [ ] Row disappears from Employees list
- [ ] **Database check:**
  ```sql
  SELECT connection_status, is_active FROM agent_employees WHERE slug = 'your-test-slug';
  ```
  Expect `is_active=false`. If deploy_provider was railway: `provider_instances.status = 'destroyed'` for that row.

---

## 3. Session inspector (Phase 10)

Run these with Alex PM because it has real turn history from the cron dispatcher.

### 3.1 Drawer turn list
- [ ] Click Alex PM card → drawer
- [ ] Verify `Recent turns` section shows at least one turn
- [ ] Each row shows: result pill (`success` / `error` / `timeout` / `rejected`), trigger kind chip (`cron:standup`, `chat_mention`, `webhook:...`), latency in ms, relative time, expand arrow

### 3.2 Turn expand + tabs
- [ ] Click the newest turn row → expands
- [ ] Four tabs visible: **Input (N)**, **Tools (M)**, **Reply**, **Metrics**
- [ ] Input tab shows the actual turn payload (for cron: the trigger kind + goal + context JSON)
- [ ] Tools tab shows 0 or N tool calls (each with name + collapsed args/result)
- [ ] Reply tab shows the final assistant text (markdown rendered)
- [ ] Metrics tab shows model / latency_ms / tokens_in / tokens_out / est. cost
- [ ] `View receipt` link at bottom of expanded panel opens the receipt modal (see §4)

### 3.3 Filters + Load more
- [ ] `all triggers` dropdown → pick `cron` → only cron turns remain
- [ ] Back to `all triggers`
- [ ] `all results` dropdown → pick `error` → only error turns (possibly empty)
- [ ] Back to `all results`
- [ ] If ≥20 turns exist, a **Load more** button should appear and pull up to 100 total
- [ ] **Sanity check:** tabs and expand state survive scrolling

### 3.4 Turn cost display
- [ ] Pick a turn whose model you know (e.g. sonnet-4-6)
- [ ] Metrics tab should show an `est. cost` like `$0.0023`
- [ ] Rough-check: `tokens_in * 3/1e6 + tokens_out * 15/1e6` should match (sonnet pricing is hardcoded in `page.tsx` MODEL_PRICING)

---

## 4. HMAC audit receipts (Phase 7 + 12 envelope fix)

### 4.1 Fresh receipt on auto-exec
- [ ] Set trust level to **Standard** so Alex PM quick-tier writes auto-execute
- [ ] Use Defty to create a task in Deft v1 named `receipt-smoke`
- [ ] Go to Settings → Agent → Action Log, find the row at the top
- [ ] Click **View receipt**
- [ ] Modal shows:
  - [ ] Action name badge (`create_task` / `message_post` / etc.)
  - [ ] Status badge `Auto-executed`
  - [ ] **`Verified` pill in GREEN** (not red/tampered)
  - [ ] Proposer: the agent name + source (employee / cron / user)
  - [ ] Approver: `—` (auto-exec) or user name
  - [ ] Signed at timestamp
  - [ ] Action ID truncated
  - [ ] Params JSON (expand/collapse)
  - [ ] Result JSON (expand/collapse)
  - [ ] `Signature (HMAC-SHA256)` row with 64 hex chars
  - [ ] `Copy as JSON` + `Close` buttons
- [ ] Press **Esc** — modal closes
- [ ] Click **Copy as JSON** on a reopen — should not throw

### 4.2 Tamper detection
- [ ] With a fresh verified receipt visible, go to psql and run:
  ```sql
  UPDATE action_receipts
     SET action_params_json = jsonb_set(action_params_json, '{title}', '"TAMPERED"')
   WHERE id = '<id from modal header>';
  ```
- [ ] Reload the page → reopen the same receipt
- [ ] Pill must now read **`Tampered`** in red
- [ ] Params JSON shows the tampered value
- [ ] **Roll back:** restore the original title or just accept the row is dirty

### 4.3 Receipts on rejected actions
- [ ] In conservative mode, reject a Defty write
- [ ] Action Log entry has `rejected` status
- [ ] Click View receipt — still shows a signed envelope but the decision is `rejected`, not `auto_executed`. Should still verify green.

### 4.4 Known caveat — envelope schema drift
- [ ] Receipts generated between commits `d6b0b69` and `678679d` will show **Tampered** even though nothing was actually tampered. This is expected: the HMAC envelope shape changed in that window. Only receipts signed by the current code verify.
- [ ] Before flagging a tampered receipt as a bug, check the row's `created_at` timestamp against the deploy history.

---

## 5. Deploy wizard (Phase 8 + feature flag from Phase 12)

### 5.1 Gate verification
- [ ] Unset `NEXT_PUBLIC_FEATURE_OPENCLAW_EMPLOYEES` in `.env`, restart the web dev server
- [ ] Navigate to `/settings/agent` — **"Deploy new employee" button should NOT appear**
- [ ] Navigate directly to `/settings/agent/deploy` — should render a "Deploy Employee is not enabled" message instead of the wizard
- [ ] Restore `NEXT_PUBLIC_FEATURE_OPENCLAW_EMPLOYEES=true`, restart web
- [ ] Button is back, wizard works

### 5.2 Role catalog (task 61 validation)
- [ ] Click Deploy new employee → Step 1
- [ ] All 8 template cards render with their semantic role badges:
  - [ ] Alex — Project Manager → `project_manager`
  - [ ] Dara — Product Designer → **`product_designer`** (not `custom`)
  - [ ] Quinn — QA Engineer → **`qa_engineer`**
  - [ ] Sam — Customer Success → **`customer_success`**
  - [ ] Riley — Community Manager → **`community_manager`**
  - [ ] Nova — On-call Responder → `engineering_lead`
  - [ ] Morgan — CFO → **`cfo`**
  - [ ] Devin — DevOps Engineer → `engineering_lead`
- [ ] Display name + slug fields pre-fill when you click a card
- [ ] Change slug to lowercase-kebab and proceed

### 5.3 Capability packs (Phase 8 three-layer model)
- [ ] Step 2: capability packs grouped L1/L2/L3
- [ ] Defaults for the picked template are pre-checked
- [ ] Any pack with `Credential required` badge needs a secret field or it can't be used
- [ ] Uncheck `deft-workspace` → Next button does NOT become disabled (it's a warning, not a blocker) but the summary should note the missing pack

### 5.4 Provider step
- [ ] Step 3: provider cards (Railway / BYO / Deft Cloud)
- [ ] **BYO:** fill `http://host.docker.internal:18789` + `gw-token-raw`
- [ ] Next enables

### 5.5 Triggers + required Anthropic key (Phase 12 critical fix)
- [ ] Step 4: trigger picker + **Anthropic API key input**
- [ ] Leave the Anthropic key **empty** → Deploy button stays disabled
- [ ] Paste any string → Deploy button enables (in prod, backend also validates format)
- [ ] **Important:** the input is `type=password`, should mask characters
- [ ] Select `cron:standup` trigger → should fail with 409 `TRIGGER_CONFLICT` when you click Deploy because Alex PM already owns it. Good — means the uniqueness guard works. Pick a different trigger or none.

### 5.6 Happy path
- [ ] Deploy button fires → wizard advances to Step 5 (Provision Progress)
- [ ] **Database check:**
  ```sql
  SELECT id, slug, kind, deployment_provider, connection_status, anthropic_api_key IS NOT NULL
    FROM agent_employees ORDER BY created_at DESC LIMIT 1;
  ```
  - `kind='openclaw'`, `deployment_provider='byo'` (or whatever you picked), `connection_status='pending'`, anthropic NOT NULL
- [ ] Provision completes (BYO is instant) → Step 6 Handshake
- [ ] Handshake will fail if there's no OpenClaw docker running at that URL — that's fine, check the error message is user-readable
- [ ] Click Back or Finish. Row should remain in DB so you can clean up later.

### 5.7 Cross-tenant smoke (Phase 12 review fix)
- [ ] Note the deployed employee's `id` and `org_id`
- [ ] In a different org (create a second user/org if needed), try to call `POST /api/mcp/v1/tools/call` with `task_create` and that employee's bearer token, targeting a project in the **first** org
- [ ] Expected: `403` or `project not found in caller's org`
- [ ] If the task is actually created → **CRITICAL BUG** — the Phase 12 scope check regressed

---

## 6. Gateway health card (Phase 11)

### 6.1 Rendering with 0 openclaw employees
- [ ] If you have no openclaw employees: Gateway health section reads `No OpenClaw gateways deployed yet.`

### 6.2 With ≥1 openclaw employees
- [ ] Deploy at least 2 openclaw employees against the SAME `connection_url` (do §5 twice with different slugs but same URL)
- [ ] Gateway health now shows one **card** per URL with:
  - [ ] Hostname extracted from the URL
  - [ ] Aggregate status pill (`Connected` / `Degraded` / `Error` / `Pending`)
  - [ ] `Last ping: N minutes ago` (initially `Never`, updates within 60s)
  - [ ] Member rows: one per employee, each with a status dot + slug + role
- [ ] Wait up to 60 seconds — ping cron should fire and the card should update to `Connected` or `Error`

### 6.3 Simulating failures (optional, requires killing the Gateway process)
- [ ] Kill the OpenClaw docker container
- [ ] Wait ~3 minutes (3 × 60s cron ticks) — status should flip from `Connected` → `Error` after 3 consecutive fails
- [ ] Card should show a short `connection_error` string on hover
- [ ] Restart the Gateway → next cron tick flips back to `Connected`, fail counter resets to 0

### 6.4 Database sanity
- [ ] `SELECT slug, connection_status, gateway_ping_fail_count, last_gateway_ping_at FROM agent_employees WHERE kind='openclaw' ORDER BY slug;`
- [ ] Values match what the UI shows

---

## 7. OpenClaw chat integration (Phase 5 + 6)

Only if you have a real OpenClaw Gateway running at `host.docker.internal:18789`.

### 7.1 Chat @mention
- [ ] Open `/chat` → `#general`
- [ ] Type `@` — mention menu should include your deployed employee by name
- [ ] Pick the employee, add `hi, introduce yourself`, send
- [ ] Message should render with a mention pill (not raw `<@uuid|name>` text)
- [ ] Wait ≤60s for the employee's reply to appear in thread
- [ ] Reply should render as a normal message under the employee's user row with the `BOT` badge
- [ ] **Database check:**
  ```sql
  SELECT id, user_id, metadata->>'agent_employee_id', metadata->>'is_agent_reply'
    FROM messages WHERE space_id = '<general id>' ORDER BY created_at DESC LIMIT 2;
  ```
  Top row is the employee's shadow user with `is_agent_reply=true`

### 7.2 Worker queue sanity (if a reply never comes)
- [ ] `SELECT name, status, attempts, last_error FROM job_queue WHERE name = 'agent-employee-message' ORDER BY created_at DESC LIMIT 5;`
- [ ] Common failure: OpenClaw container not up, or Anthropic key on the Gateway side is missing/invalid
- [ ] Worker logs with `[agent-employee-message]` prefix should give a specific reason

### 7.3 Trigger dispatcher (Phase 6)
- [ ] If Alex PM has `cron:standup` in its `trigger_subscriptions`, wait for 9am (or manually run the cron) and verify a new turn appears in its drawer
- [ ] The generated message should appear in `#general` (or the target space)
- [ ] **Database check:**
  ```sql
  SELECT trigger_kind, result, latency_ms, created_at FROM agent_session_turns
    ORDER BY created_at DESC LIMIT 5;
  ```

---

## 8. Metrics scrape (Phase 10)

### 8.1 Unauthorized
- [ ] `curl -i http://localhost:3001/api/metrics`
- [ ] → 401
- [ ] `curl -i -H "Authorization: Bearer wrong-token" http://localhost:3001/api/metrics`
- [ ] → 401

### 8.2 Authorized
- [ ] `curl -H "Authorization: Bearer <your METRICS_SCRAPE_TOKEN>" http://localhost:3001/api/metrics`
- [ ] → 200, `Content-Type: text/plain; version=0.0.4`
- [ ] Body includes lines starting with:
  - [ ] `# TYPE deft_employee_chat_turn_total counter`
  - [ ] `deft_employee_chat_turn_total{...}` with org_id / trigger_kind / result labels
  - [ ] `deft_employee_chat_latency_ms_bucket{le="..."}` histogram
  - [ ] `deft_approval_queue_size` gauge
  - [ ] `deft_mcp_tool_calls_total` counter
- [ ] Values should be > 0 after you've driven some turns through §1 and §7

### 8.3 Disabled mode
- [ ] Unset `METRICS_SCRAPE_TOKEN` in `.env`, restart API
- [ ] `curl -i http://localhost:3001/api/metrics` → **503** `METRICS_DISABLED`
- [ ] Restore the token, restart

---

## 9. Scope enforcement (Phase 12 CRITICAL review fixes)

These are the security patches — if any of these regress you have a real cross-tenant hole.

### 9.1 task_create org scope
- [ ] Two orgs: A (your normal test org) and B (create a second user, second org)
- [ ] Get Org B's project id from psql
- [ ] As Alex PM in Org A, call MCP `task_create` with `project_id = <Org B project>` via Defty chat ("Create a task in project xxx")
- [ ] Should return an error like `"project X not found in caller's org"`
- [ ] **Database check:** no new task rows in Org B's project
- [ ] If a task lands → **CRITICAL**, ping me

### 9.2 message_post space scope
- [ ] Same setup. Ask Defty to post to a space in the other org
- [ ] Expected error: `"space X not found in caller's org"`

### 9.3 thread_fetch private space
- [ ] Create a **private** space in Org A that Alex PM's shadow user is NOT a member of
- [ ] Send a message there as your user
- [ ] Ask Defty/Alex PM to summarize the thread by id
- [ ] Expected: `"employee not a member of space X"`

### 9.4 PUT /:id trust bypass
- [ ] As a **non-admin** org_member, try:
  ```
  curl -X PUT http://localhost:3001/api/agent-employees/<id> \
    -H "Authorization: Bearer <user-token>" \
    -H "Content-Type: application/json" \
    -d '{"trust_level":"autonomous"}'
  ```
- [ ] Response should either **ignore** `trust_level` entirely (return the row with unchanged trust) or **reject** it with 403
- [ ] PATCH to the same endpoint as a non-admin → 403 "Only owners or admins can change trust level"

### 9.5 Anthropic key fallback
- [ ] POST `/api/agents/deploy/start` **without** `anthropic_api_key` in the body
- [ ] Expected: 400 Zod error `"Required"` on `anthropic_api_key`
- [ ] If it succeeds and uses the server key → **CRITICAL**

---

## 10. Dashboard / activity surfaces

### 10.1 Agent Activity card
- [ ] Open `/dashboard`
- [ ] "Agent Activity" card should list recent actions from all agents (Defty + Alex PM + any openclaw)
- [ ] Each row has agent name, action type, and a relative timestamp
- [ ] Click `All Agents` dropdown → filter by a specific agent → list updates
- [ ] Rows link to the action log entry or open a receipt?

### 10.2 Quick Stats
- [ ] Overdue / Due Today / In Progress / Completed numbers match `/tasks` filters
- [ ] Today card lists tasks due today (including any `human-test-smoke` from §1)

### 10.3 Activity feed
- [ ] Shows `<user> created <ticket>` for every agent_action that resulted in a task
- [ ] Timestamps use real local time (Phase 12 tz fix)

---

## 11. Cleanup

Before closing the session, reset state so the next tester has a clean slate:

- [ ] Delete any test tasks you created (`human-test-smoke`, `dup-test`, receipt-smoke, etc.)
- [ ] Delete any throwaway employees via Settings → Agent → drawer → Delete (tests the ConfirmDangerous flow one more time)
- [ ] Set trust level back to **Conservative**
- [ ] **If you tampered a receipt in §4.2**, either restore the original value from memory or delete the row — don't leave poisoned audit data lying around
- [ ] Empty the `job_queue` of any stuck `deploy-provision` rows if you ran §5:
  ```sql
  DELETE FROM job_queue WHERE name = 'deploy-provision' AND status != 'completed';
  ```

---

## 12. What a passing run looks like

- Every `[ ]` above checked off
- No red `Tampered` pills on receipts signed by current code
- psql spot checks match the UI everywhere
- Gateway health status reflects reality within 60s of a state change
- Prometheus metrics endpoint returns 200 with non-zero counters
- No console errors in the browser during the walk (warnings are fine)
- Cross-tenant scope tests (§9) all return refusals, not silent success

If anything in §9 succeeds when it shouldn't, stop testing and file a critical issue — that's a security regression.

---

## 13. Skills primitive (Phases 0-6)

The skill system unifies agent capability packs and project workflow templates into a single `skills` table with three source tiers. These tests cover the install, conflict, and version-update flows that are easy to regress.

### 13.1 Skills library + marketplace browser
- [ ] Navigate to `/skills`
- [ ] Library tab shows installed skills — initially just the 9 bundled rows (`engineering`, `marketing-campaign`, `sales-pipeline` + 6 capability-pack skills)
- [ ] Marketplace tab renders installable rows. Each row shows name, version, description, and an Install button
- [ ] Search filter works (type `engineer` → only `engineering`)
- [ ] Bundled skills show "Bundled" badge and have NO edit or delete button
- [ ] Org skills show "Org" badge and have edit + delete buttons

### 13.2 Install prompt UX
- [ ] Click Install on any marketplace skill
- [ ] Modal summarizes what gets granted: capability packs, triggers, tools, prompt additions (from `agent_config`) + statuses, vocab, custom fields (from `project_config`)
- [ ] If the skill declares a trigger that already belongs to another employee/project in the org, the modal shows the **trigger conflict prompt** (see §13.3)
- [ ] If `project_config` is non-empty and the user is installing from the Agent wizard (agent-only context), the modal warns: `this skill also ships project-wide config that will only apply when attached to a project`
- [ ] Confirming installs the row; cancelling leaves state untouched
- [ ] Installed row moves to Library tab

### 13.3 Trigger conflict resolution
- [ ] Install a skill whose `agent_config.triggers` includes `cron:standup` on Employee A
- [ ] Try to install the same (or another skill with the same trigger) on Employee B
- [ ] Server responds `409 TRIGGER_CONFLICT` with a payload naming the conflicting owner
- [ ] UI surfaces the conflict inline with two actions: **Reassign** (moves the trigger off Employee A, onto B) or **Cancel**
- [ ] Reassign → install completes, Employee A's `trigger_subscriptions` array drops `cron:standup`
- [ ] **Database check:**
  ```sql
  SELECT slug, trigger_subscriptions FROM agent_employees
    WHERE 'cron:standup' = ANY(trigger_subscriptions);
  ```
  Should return exactly one row — the reassigned employee

### 13.4 Context-bloat warning
- [ ] Install 5+ agent-config skills on a single employee (each one appends to the resolved prompt)
- [ ] The employee's drawer → Skills tab should show an amber **"Context budget: N%"** indicator once the aggregate prompt additions exceed the soft-cap threshold
- [ ] Hover → tooltip lists which skills contribute the most bytes + suggests uninstalling
- [ ] Add one more to push over the hard cap → red warning, and a toast fires on the next chat turn: `"Agent context is large — responses may be slower"`
- [ ] Uninstall two skills → warning clears on next load

### 13.5 Version update notification
- [ ] In psql, bump a bundled skill: `UPDATE skills SET version = '1.1.0' WHERE slug = 'engineering' AND source = 'bundled';`
- [ ] Run the `skill-update-check` worker manually: `pnpm tsx apps/api/src/scripts/check-queue.ts run skill-update-check`
- [ ] Affected orgs (any with this skill attached) receive an in-app notification: `"engineering 1.1.0 available"`
- [ ] Click notification → opt-in adoption modal showing the version diff
- [ ] Adopt → project's resolved config reflects new version
- [ ] Roll back the version bump when done

### 13.6 Multi-skill-per-project (first-attached-wins)
- [ ] Attach `engineering` then `marketing-campaign` to a test project (order matters)
- [ ] Board renders with engineering's statuses and `p0/p1/p2/p3` priorities
- [ ] Swap order in Project Settings → Skills — now renders with marketing's `High/Medium/Low` and Calendar view
- [ ] Attach a third skill with empty `project_config` → no visible change (resolver falls through)

### 13.7 Retry-provision
- [ ] Force an install failure (kill the OpenClaw gateway before clicking Install)
- [ ] Skill row appears in Library with status `provision_failed`
- [ ] Restart the gateway
- [ ] Click **Retry provision** on the row → status flips to `ready`
- [ ] **Database check:** `SELECT status, last_error FROM agent_employee_skills WHERE ...` reflects the transitions

### 13.8 Dead primitives are gone
- [ ] `SELECT column_name FROM information_schema.columns WHERE table_name = 'agent_employees' AND column_name = 'native_tools';` → 0 rows (migration 0038 dropped it)
- [ ] `grep -r TEMPLATE_DEFAULT_PACKS apps packages` → no hits (constant deleted)

---

## 14. OpenClaw autonomous heartbeat — see Phase 8 docs

The autonomous heartbeat lifecycle (long-running OpenClaw employees that self-wake on a schedule), the skill-defined trigger dispatcher (beyond `cron:standup`), and heartbeat cost guardrails (per-turn + per-day caps with circuit-breakers) are **Phase 8 work and have not shipped yet**.

The current `agent-employee-heartbeat` worker is a scaffold that does not execute autonomous turns. Any test involving autonomous self-wake should reference the Phase 8 plan once it lands rather than this guide.

Until Phase 8 ships:
- Do NOT file bugs about heartbeat cost overruns — no cost guard exists yet
- Do NOT expect arbitrary skill-defined triggers to fire — only `cron:standup` is wired through
- OpenClaw employees only respond to explicit invocations (chat @mention, approval execution, cron:standup)

---

## Appendix: handy psql queries

```sql
-- See every pending approval across the org
SELECT id, action, source, created_at FROM agent_actions
 WHERE approval_status = 'pending' ORDER BY created_at DESC;

-- See every receipt that fails HMAC (you need to verify manually or via the API)
SELECT id, action_name, decision, signed_at FROM action_receipts
 ORDER BY signed_at DESC LIMIT 20;

-- Who owns which cron trigger?
SELECT slug, trigger_subscriptions FROM agent_employees
 WHERE array_length(trigger_subscriptions, 1) > 0;

-- Last ping time for every openclaw employee
SELECT slug, connection_status, gateway_ping_fail_count, last_gateway_ping_at
  FROM agent_employees WHERE kind = 'openclaw' ORDER BY slug;

-- Turn history for one employee, newest first
SELECT trigger_kind, result, latency_ms, model, tokens_in, tokens_out, created_at
  FROM agent_session_turns
 WHERE employee_id = '<id>' ORDER BY created_at DESC LIMIT 20;
```

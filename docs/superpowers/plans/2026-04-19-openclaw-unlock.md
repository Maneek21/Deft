# OpenClaw Unlock — Claude Code Execution Plan

**Status:** Drafted. Awaits user answers to Open Questions (bottom) before decomposition.
**Authored:** 2026-04-19 (v2, restructured for Claude Code execution)
**Source spec:** this file is the intent. Each block will be decomposed into a TDD-shaped implementation plan via `superpowers:writing-plans` when execution starts.
**Execution model:** Claude Code orchestrates; subagents do the heavy lifting; one block at a time; each block gated by an exit check before the next begins.

---

## North stars (unchanged)

1. **Open ecosystem.** Customers get the full Agent Skills ecosystem (ClawHub + agentskills.io partner directory) on day one, not connector-by-connector.
2. **Functional agent employees.** Trust enforces, approvals surface, edits work, reminders persist, activity is observable live.
3. **Frictionless platform.** One coherent journey signup → first agent → productive work, with a power-user drop-down to CLI / Gateway / Docker / live markdown editing.

## Non-goals (unchanged)

- No native Slack/Gmail/Linear connectors — OpenClaw's channel adapters + ClawHub cover this.
- No replacing Deft's memory pipeline, MCP server, Defty Node-native tools, or classifier.
- No merging Deft skills + ClawHub skills into one format.
- No autonomous (approval-free) skill install until ClawHub ships signed publishers.
- No voice agents, A2A protocol, or Anthropic Managed Agents tier in this plan.
- No forced migration of per-agent OpenClaw deployments — new deploys go per-org, existing ones stay until re-deploy.

---

## Execution model — Claude Code specifics

**Unit of work:** one *task* = one subagent dispatch = one atomic git commit. Every task has:
- Exact file paths
- Pre-flight (what to check before starting)
- TDD shape where test-shaped (failing test → implement → verify → commit)
- Acceptance command (what I run to prove it works)
- Parallelism marker (🔀 if it touches disjoint files from siblings; 🔒 if it blocks siblings)

**Subagent dispatch pattern:** implementer subagent → spec-reviewer subagent → code-quality reviewer subagent → mark complete. Follow `superpowers:subagent-driven-development`.

**Block gates:** each block ends with an **exit check** — a manual step where the orchestrator (Claude Code in session) runs a set of smoke tests and confirms the block is done. Only then does the next block start.

**Branching:** one long-lived branch per block, PR'd to `main` at block exit. No cross-block branches.

**Parallelism strategy:** within a block, tasks marked 🔀 can run as parallel subagents if they touch disjoint files. Tasks marked 🔒 are blockers — must ship before siblings. See per-block parallelism notes.

**Testing policy:** every task that changes behavior ships with tests. Tasks that are pure wiring + UI glue ship with a manual Playwright smoke (audit script). Pre-existing red tests (e.g. `phase8-heartbeat-prompt.test.ts` author_user_id bug) stay red; new reds block the task.

---

## Block 0 — Foundation (target 15–18 tasks)

**Purpose:** fix quietly-broken things + add invisible-today capabilities that every later block depends on. Zero new user-visible features beyond the approval badge.

### Entry gate

Before starting Block 0:
- [ ] Pre-existing test baseline captured (document which tests are red going in; only `phase8-heartbeat-prompt.test.ts` author_user_id expected).
- [ ] Dev DB seed verified (maneek@test.com login works; bundled skills + templates present).
- [ ] `dev` servers boot clean from worktree (`.env` copied, web + api 200 OK).
- [ ] CLAUDE.md reflects simplify-skills-templates branch state (it does; commit `68db462`).

### Tasks

| # | Task | Type | Parallel | Effort | Notes |
|---|---|---|---|---|---|
| 0.1 | **Enforce trust levels in routing.** Update `agent-approval.ts::shouldAutoExecute()` with 3×3 matrix: Conservative (auto only), Standard (auto+quick), Autonomous (auto+quick+full except destructive). Add destructive-tool allow-list. Ship with a 9-case matrix test. | TDD | 🔒 | M | Highest blast radius; every other task depends on this being correct. |
| 0.2 | **Approval badge in main nav.** SWR-poll `/api/agent/actions/pending`, red dot + count on Agent nav link and notification bell. New `usePendingApprovals` hook. | UI | 🔀 | S | Visible from every screen. Poll interval 15s. |
| 0.3 | **Edit agent config (Deft-side).** New drawer panel with editable: name, role, avatar, starter_prompts, trust_level, max_daily_actions, heartbeat_enabled, heartbeat_interval_min. Skills attach/detach via existing junction. System prompt editing DEFERRED to Block 1 (requires `agents.files.set`). | UI | 🔀 | M | Save via `PATCH /api/agent-employees/:id`. Skill changes take effect on next provision (live install is Block 1.3). |
| 0.4 | **Reminders → BullMQ.** Replace `setTimeout` in `reminders.ts` with a BullMQ delayed job. Add handler `workers/handlers/reminder-fire.ts`. Migration: on server start, re-schedule any pending reminders from DB. | Logic | 🔀 | M | Durable across restart. |
| 0.5 | **`create_reminder` agent tool.** Add to native `agent-tools.ts` and MCP `mcp-tools/`. Signature: `create_reminder(user_id, text, fire_at)`. Approval tier: `quick`. | Tool | 🔀 | S | Single natural request unlocked. |
| 0.6 | **Semantic wiki search.** Pre-flight: verify `embed-content` worker indexes wiki_pages. If not, wire it first. Update `wiki_search` tool to hybrid FTS + pgvector cosine, score-weighted blend (FTS 0.4 + cosine 0.6). | Logic | 🔀 | S–M | Effort depends on pre-flight outcome. |
| 0.7 | **Unify agent-create wizards.** Delete the older 7-step deploy wizard at `apps/web/src/app/(app)/settings/agent/deploy/`. Redirect old route to `/settings/agent-employees/create`. Remove `NEXT_PUBLIC_FEATURE_OPENCLAW_EMPLOYEES` feature flag. | Refactor | 🔀 | S | One canonical flow. |
| 0.8 | **Retire standup native fallback.** Delete the direct `llm()` path in `standup-generate.ts`. If no employee subscribes to `cron:standup`, emit an in-notification CTA: "Configure standup agent" → links to Library. | Refactor | 🔀 | S | Removes misleading "agent participation." |
| 0.9 | **Per-org LLM spend cap.** New `org_spend_caps` table (org_id, daily_cents, monthly_cents, current_daily_cents, current_monthly_cents, reset_at). Check before every Anthropic call in `llm.ts` AND every OpenClaw dispatch. Circuit-break with clear error. Admin UI under `/settings/general` to view/set caps. Default: $100/mo new orgs. | Logic + UI | 🔀 | M | Protects against cost runaway from skills or buggy loops. |
| 0.10 | **SKILL.md body sanitizer.** New `lib/skill-sanitizer.ts`. Regex-strip or neutralize instruction blocks matching: network exfil patterns (`curl -X POST.*evil`), credential mentions (`email.*token`), role-override (`ignore previous instructions`, `you are now`, `jailbreak`), imperative data-access (`read /etc/passwd`). Test fixtures: 20 known-malicious bodies from Snyk ToxicSkills samples. | Logic | 🔀 | M | Pure library; no wiring yet (Block 1 consumes it). |
| 0.11 | **VoltAgent allowlist fetcher.** New `lib/clawhub-allowlist.ts`. Daily worker job pulls `https://github.com/VoltAgent/awesome-openclaw-skills` markdown, parses skill slugs, stores in new `clawhub_allowlist` table (slug, last_seen_at). Fallback: bundled static list in case of network failure. | Logic | 🔀 | S | Pure data; Block 1 UI consumes. |
| 0.12 | **Baseline test hygiene.** Full `pnpm --filter @deft/api test` run; document any new reds introduced by 0.1–0.11 and fix before exit gate. | QA | 🔒 | S | Gate check. |

### Parallelism within Block 0

- **Serial:** 0.1 (trust) must ship first. 0.12 is the final gate.
- **Parallel wave 1** (after 0.1 lands): 0.2, 0.3, 0.4, 0.7, 0.8. All disjoint files.
- **Parallel wave 2**: 0.5 (depends on 0.4), 0.6, 0.9, 0.10, 0.11. Disjoint.

### Exit gate

Block 0 is done when:
- [ ] All 12 tasks committed with passing tests.
- [ ] `pnpm --filter @deft/api test` has no new reds vs pre-block baseline.
- [ ] Playwright smoke: Conservative agent requires approval for `create_task`; Standard agent auto-executes; Autonomous agent auto-executes except `delete_task`.
- [ ] Approval badge visible from dashboard, tasks page, agent page, settings.
- [ ] Restart the dev server; any previously-scheduled reminder still fires at its original time.
- [ ] Semantic wiki search returns a wiki page matching "payments" when queried with "billing" (or equivalent).
- [ ] Org spend cap circuit-breaks agent calls at set threshold in smoke test.
- [ ] The old `/settings/agent/deploy` route returns 404 or redirects.
- [ ] A malicious `SKILL.md` fixture is sanitized (no jailbreak pattern survives).
- [ ] `clawhub_allowlist` table populated after first worker run.
- [ ] CLAUDE.md updated: note trust-level enforcement is live, spend caps exist, allowlist available.

---

## Block 1 — OpenClaw control plane (target 10–13 tasks)

**Purpose:** wire up Gateway RPC. Once this block ships, Deft is a true OpenClaw control plane rather than a chat-over-SSE wrapper.

### Entry gate

- [ ] Block 0 exit gate fully checked.
- [ ] A real OpenClaw instance reachable for dev (see Open Question #7).
- [ ] OpenClaw version pinned in Railway template and .env documented.

### Tasks

| # | Task | Type | Parallel | Effort | Notes |
|---|---|---|---|---|---|
| 1.1 | **Gateway RPC client foundation.** `apps/api/src/lib/openclaw-gateway.ts`. WebSocket per deployment_id, JSON-RPC multiplex by id, lazy connect, exponential backoff reconnect, 30s per-call timeout, metrics emission. Class with typed methods wrapping the RPC surface we use (skills, agents.files, sessions, exec.approval, cron, config). | TDD | 🔒 | M | Foundation for everything below. Test with `skills.status` against a real gateway. |
| 1.2 | **`agents.files.*` UI wiring.** New drawer tab "Personality" for agent-employees. Markdown editor per file (SOUL.md, AGENTS.md, USER.md, TOOLS.md, IDENTITY.md, HEARTBEAT.md, BOOT.md). Read via `gateway.agents.files.get`; save via `agents.files.set`. Takes effect on next session (document in UI). Also enables full system-prompt editing deferred from 0.3. | UI | 🔀 | M | Depends on 1.1. |
| 1.3 | **Live skill install on attach.** In the agent edit drawer (from 0.3), attaching a new skill to an OpenClaw-kind employee fires `gateway.skills.install(slug, version)`. Detach fires `skills.remove`. | Integration | 🔀 | S | Makes 0.3 take effect immediately for OpenClaw agents. |
| 1.4 | **`skill_secrets` table.** New table (id, org_id, skill_id, key_name, value_encrypted, created_by, ...). Encrypted at rest with `ENCRYPTION_KEY`. Helper `getSecretForSkill(skillId, keyName)` + `setSecretForSkill`. Least-privilege push: only secrets declared in the skill's `requires.env` get pushed to the container. | Logic | 🔀 | S | Block 1.6 consumes. |
| 1.5 | **ClawHub browse in Library UI.** Add "Browse Agent Skills" section. Pulls from 0.11 allowlist by default; "Advanced" toggle (org-admin only) exposes full ClawHub. Render each skill: name, description, `requires.env` chips, install count. Attach button writes `external_ref` + `source_origin` (from simplify-skills-templates refactor) + triggers skill import. | UI | 🔀 | M | Depends on 1.1, 0.10, 0.11. |
| 1.6 | **A — pre-deploy install flow.** When attaching a ClawHub skill: if `requires.env` declares a secret, match against `connected_accounts` (OAuth) → decrypt + push via `gateway.config.set` → `gateway.skills.install`. If no OAuth match, prompt for raw token, store in `skill_secrets`, then push. | Flow | 🔀 | M | Depends on 1.1, 1.4, 1.5, 0.10 (sanitizer runs on SKILL.md body before install). |
| 1.7 | **B — runtime install flow.** New native tool `request_skill_install(slug, rationale)`. Stream loop intercepts; pauses turn; posts `ActionCard` with approval. On approve: run same flow as 1.6 → `gateway.sessions.steer` resume. Trust matrix: Conservative = all installs need approval; Standard = allowlist auto; Autonomous = allowlist auto + full-ClawHub needs approval. | Flow | 🔀 | L | Depends on 1.6. |
| 1.8 | **Skill reconciliation loop.** On each heartbeat tick for OpenClaw employees, call `gateway.skills.list()`, diff vs `agent_employee_skills`, auto-reinstall missing. Alert via notification if drift persists > 2 ticks. | Logic | 🔀 | S | Handles Railway volume loss / container rebuild. |
| 1.9 | **Exec/plugin approval forwarding.** Subscribe to `exec.approval.request` + `plugin.approval.request` events on the WebSocket. On event: insert `agent_actions` row with `action_type='openclaw_exec_approval'` + raw payload. On Deft approve/reject: call `gateway.exec.approval.resolve`. Trust matrix applies. | Integration | 🔀 | M | Depends on 1.1. |
| 1.10 | **Reasoning trace UI.** `gateway.sessions.messages.subscribe` for the active session. Push `session.tool` and `session.message` events to the chat UI via Socket.io. Each agent message gets an expandable "Show trace" → tree of tool → input → result → next tool. | UI | 🔀 | M | Closes the #3 UX gap from Sweep 3. |
| 1.11 | **Per-org gateway — new deploys only.** Update Railway provider: on first agent-employee provision for an org, create ONE container; subsequent agents reuse. `agent_employees.provider_instance_id` points at the org-level instance. Health check: fail provisioning loudly if `/data` volume not mounted. Migration of existing per-agent deploys: documented but NOT executed (see Open Question #4). | Infra | 🔒 | L | Changes provisioning contract. Test extensively. |
| 1.12 | **Update CLAUDE.md.** Document: Gateway RPC client live; approval forwarding live; skills install via RPC; per-org gateway for new deploys; reasoning trace available. | Docs | 🔀 | S | Keep memory fresh. |

### Parallelism within Block 1

- **Serial:** 1.1 must ship first (foundation). 1.11 should ship last (per-org gateway migration — coordinate with dev deploys).
- **Parallel wave 1** (after 1.1): 1.2, 1.3, 1.4, 1.8, 1.9, 1.10. Disjoint.
- **Parallel wave 2**: 1.5, 1.6, 1.7 (sequential internally — 1.5 → 1.6 → 1.7 as each depends on prior).

### Exit gate

Block 1 is done when:
- [ ] All 12 tasks committed with passing tests.
- [ ] Smoke: attach `slack` skill in Library → provision agent → Slack tool usable in first turn.
- [ ] Smoke: agent mid-turn requests install → approval card → approve → next turn slack works.
- [ ] Smoke: force-delete a skill from the gateway; heartbeat re-installs it.
- [ ] Smoke: agent runs `exec_command` requiring approval → Deft UI shows approval card → approve → command executes.
- [ ] Smoke: chat with OpenClaw agent; expand "Show trace" on a response; tool-call tree renders.
- [ ] Smoke: new org provisions three agents → one OpenClaw container in Railway (not three).
- [ ] Edit SOUL.md in drawer → save → next agent turn reflects change.

---

## Block 2 — Agent reach + visibility (target 9–11 tasks)

**Purpose:** close the dead zones where agents currently can't act, plus surface agent activity on the product's primary surfaces.

### Entry gate

- [ ] Block 1 exit gate checked.
- [ ] Gateway RPC client stable (metrics show < 1% error rate over a week).

### Tasks

| # | Task | Parallel | Effort | Notes |
|---|---|---|---|---|
| 2.1 | Note agent tools: `search_notes`, `create_note`, `read_note`, `note_to_wiki`. Native + MCP. | 🔀 | S | Largest untouched product surface. |
| 2.2 | `post_thread_reply(parent_message_id, content)` tool. | 🔀 | S | Unblocks thread-heavy channels. |
| 2.3 | Canvas agent tools: `read_canvas`, `write_canvas`. | 🔀 | M | Per-space shared docs. |
| 2.4 | Blocked-message → task-create trigger. Classifier `blocked: true` fires employee-trigger → quick-approve task-create card. | 🔀 | S | Observation-to-action loop. |
| 2.5 | Downstream dependency unblock on task done. New workflow action type `unblock_dependents`. | 🔀 | S | |
| 2.6 | Decision-to-task link tools: `link_decision_to_tasks`, `mark_decision_implemented`. UI surface in decision wiki page. | 🔀 | S–M | |
| 2.7 | New-member onboarding trigger: `member.joined` event → HR agent playbook (task list + space joins + 1:1 schedule + welcome post). | 🔀 | M | Opt-in per org; HR agent skill install. |
| 2.8 | Dashboard Agent Activity widget: last 5 agent actions across all employees (name, action, time, inline approve/reject if pending). | 🔀 | M | Uses existing `agent_actions`. |
| 2.9 | Structured heartbeat config builder: replace textarea with check-item list (add/remove rows, interval + instruction). Serializes to same markdown. | 🔀 | M | Fix UX gap #4. |

### Parallelism within Block 2

All tasks independent; can run in parallel waves of 3–4 subagents.

### Exit gate

- [ ] Smoke: agent creates a note, promotes it to wiki, searches it back.
- [ ] Smoke: agent posts a thread reply.
- [ ] Smoke: classifier flags a test message as blocked → task-create card appears.
- [ ] Smoke: task moves to done → dependent task assignee gets notification.
- [ ] Smoke: link a decision to 2 tasks; mark implemented; decision wiki page shows linkage.
- [ ] Smoke: add a new org member → HR agent (if installed) creates onboarding task list.
- [ ] Dashboard shows agent activity widget with real actions.
- [ ] Heartbeat config is a structured list UI, not a textarea.

---

## Block 3 — Power users + ecosystem polish (10 tasks, ongoing)

**Purpose:** polish + open-ecosystem features. Parallel with Block 2; ship as time allows.

| # | Task | Effort | Notes |
|---|---|---|---|
| 3.1 | Clone agent button + "Save as template" → org-scoped templates visible in wizard step 1. | S | |
| 3.2 | Developer tab in drawer: `connection_url`, `gateway_token`, wscat one-liner, CLI download, copy-paste examples. | S | |
| 3.3 | Webhook-callable agents: per-agent webhook URL; external POST triggers `gateway.sessions.send`. New trigger kind `webhook`. | M | |
| 3.4 | Publish `deft-mcp-client` skill to ClawHub + agentskills.io. Auto-configures any OpenClaw to call back to a Deft workspace via MCP. | S | Community + BYOA on-ramp. |
| 3.5 | Version update UX: per-skill update notifications from `skill-update-check`; one-click upgrade; per-org policy (pin vs auto-patch). | M | |
| 3.6 | Deft Verified review workflow: admin curation queue for ClawHub skills; approved skills get a badge in Library. | M | |
| 3.7 | Pre-bake top 20 allowlisted skills into Railway template image. | M | Cold-start perf. |
| 3.8 | Agent trace export: download a turn's full tool-call tree as JSON. | S | |
| 3.9 | Terminal-in-browser (xterm.js) for BYOA — gated by feature flag, proxies via Deft API WebSocket into Railway container. | M | |
| 3.10 | `send` RPC channel delivery pilot: WhatsApp-Business-API-first. Requires new "channel accounts" settings surface (org admin pastes token). Output-only for this pass; no inbound. | L | |

### Parallelism

All tasks independent. Dispatch 3+ at a time as scope allows.

### Exit gate (loose; this is "ongoing")

- [ ] At least 5 of the 10 tasks shipped before declaring Block 3 complete.
- [ ] `deft-mcp-client` live on ClawHub (the others are internal polish).

---

## Block 4 — Out of scope (for this plan)

Documented for awareness. Surface each individually when ready:

- Session branching for plan simulation / full-review preview.
- Cross-agent memory via fleet-config `extraCollections`.
- Deft as an in-process OpenClaw plugin (eliminates MCP hop for tool calls).
- Voice agents (Twilio + ElevenLabs).
- Managed Agents tier (Anthropic-hosted) alongside OpenClaw.
- Agent-to-agent protocol (A2A).
- Autonomous (C-path) skill install (awaits ClawHub signed publishers).

---

## Success metrics (12 weeks post-kickoff)

- Trust-level enforcement: < 1% of Standard/Autonomous agent actions sit in pending > 5 min.
- Approvals visible: ≥ 80% of approvals resolved in the session they fire.
- Agent editability: ≥ 50% of agents get edited at least once post-create.
- ClawHub reach: ≥ 30% of deployed agents have at least one ClawHub-sourced skill.
- Reasoning trace usage: expanded on ≥ 15% of agent responses.
- Per-org spend cap triggers observed; no runaway cost incidents.

(Dropped the "<10 min signup→first action" metric; no onboarding task in plan. Re-add if Block 3 grows an onboarding flow — see Open Question #5.)

---

## Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 0.1 trust-level change breaks existing agent flows | Medium | High | 9-case matrix test; staged rollout via `DEFT_TRUST_ENFORCEMENT` feature flag; ability to roll back. |
| Block 1 Gateway RPC flakiness from OpenClaw upstream | Medium | Medium | Pin OpenClaw version in Railway template; `skills.status` canary; integration tests; circuit-break in RPC client after N failures. |
| ClawHub supply-chain attack during Block 1 rollout | Medium | High | 0.10 sanitizer + 0.11 allowlist default; hide full ClawHub behind Advanced toggle for org admins only. |
| Per-org gateway migration (1.11) breaks existing customer | Low | High | New deploys only; existing per-agent untouched; documented. |
| Subagent drift — tasks ship with inconsistent patterns | Medium | Low | Spec-reviewer + code-quality-reviewer subagents between tasks; CLAUDE.md kept current. |
| Scope creep within a block (one task growing to consume the block) | High | Medium | Hard commit: any task > 1.5x effort estimate triggers mid-block review and potential scope cut. |

---

## Open questions (need answers before Block 0 kicks off)

These are the decisions I need from you to execute cleanly. Answer inline or in a followup.

### Q1 — Trust-level matrix: exact rules

I'm proposing:
- **Conservative** = only `auto`-tier actions auto-execute; everything else queues.
- **Standard** = `auto` + `quick` auto-execute; `full` queues.
- **Autonomous** = `auto` + `quick` + `full` auto-execute, EXCEPT a hardcoded destructive list: `delete_task`, `manage_agent_employee`, `manage_mcp_connection(mode=delete)`, `remove_member`, `delete_project`. These always queue.

Is this the right matrix? Anything to add/remove from the destructive list? Anything you want ALWAYS queued regardless of trust?

### Q2 — Per-org LLM spend cap: default + UI

Default proposal:
- New org default: **$100/mo hard cap**, soft-warning at 80%.
- UI: `/settings/general` → "Spend Limits" card. Org admin can set daily + monthly caps.
- Circuit-break behavior: return error to user, log + notification, auto-reset at month boundary.

OK with this? Different defaults? Should there be a per-employee cap too, or only org-wide?

### Q3 — SKILL.md sanitizer: regex vs LLM classifier

I'm planning regex-based pattern matching first (cheaper, deterministic, handles known attack patterns). An LLM classifier would be safer against novel attacks but costs $0.001–0.01 per skill install.

My lean: **regex first**, add an optional LLM classifier as a second-pass gate for `source_origin != 'bundled'`. Upgrade to LLM-only if regex proves inadequate in the wild.

OK? Or do you want LLM-classified from day one?

### Q4 — Per-org gateway migration: force or lazy?

Block 1.11 ships per-org gateway for *new* deploys. Existing per-agent deploys continue. Options:
- **(a) Lazy** — existing deploys stay per-agent forever unless user re-deploys. Legacy complexity forever.
- **(b) Force migrate** — one-time migration script in 1.11 moves all existing agents to a new per-org container. Risk: breaks in-flight sessions, loses state if not coordinated.
- **(c) Nudge** — existing per-agent deploys get a banner "Migrate to per-org (5x cheaper)" with one-click migration.

I lean **(c) Nudge** — safest + cheapest + eventually consistent.

### Q5 — Onboarding UX: in scope or out?

The "<10 min signup → first agent action" metric implies a new onboarding flow. Currently nothing in the plan addresses this. Options:
- **(a) Add a Block 3 task** for a guided onboarding tour (Deft welcome → "Let's create your first agent" → wizard pre-filled with opinionated defaults → first-turn prompt chip).
- **(b) Drop the metric**, let onboarding be handled by existing product team outside this plan.
- **(c) Build it in Block 2** as a "signup experience" task — higher priority than I originally gave it.

### Q6 — Branch strategy: where does this work land?

We're on `worktree-simplify-skills-templates` with 23 commits from the skills simplification refactor. Options:
- **(a) Merge simplification to main first, then cut new `openclaw-unlock` branch.** Cleanest. Requires reviewing and merging the 23-commit PR first.
- **(b) Continue on same worktree branch.** Pragmatic but branch grows huge.
- **(c) Cut new worktree from current branch, keep both alive.** I can run OpenClaw Unlock in parallel with more simplification polish.

I lean **(a)** — merge simplification first, fresh branch for OpenClaw Unlock.

### Q7 — OpenClaw dev instance: where?

For Block 1 Gateway RPC work I need a real OpenClaw to hit. Options:
- **(a) Local Docker** — I spin up an OpenClaw container on your dev machine. Zero infra cost, works offline, fastest iteration.
- **(b) Dedicated Railway test instance** — matches production. Costs ~$5/mo, requires Railway account + provisioning.
- **(c) Mock everything** — mock the WebSocket at the test boundary, only hit a real gateway in periodic manual QA.

My lean: **(a) Local Docker** for dev, **(b) Railway test** for integration smoke, **(c) mock** for unit tests. All three, each at the right layer.

### Q8 — Writing-plans cadence: upfront or per-block?

Two styles to decompose this plan into TDD tasks:
- **(a) One big `superpowers:writing-plans` run upfront** — generate implementation plans for Blocks 0, 1, 2, 3 all at once. Fixed scope, harder to adjust mid-flight.
- **(b) Per-block** — run writing-plans as we start each block. Flexible; each block's plan reflects what we learned in prior blocks.

I lean **(b) Per-block** — lets us adjust based on learnings (e.g. if Block 0 reveals the heartbeat trigger kinds aren't what I assumed, Block 1's plan can adapt).

### Q9 — User-facing messaging for trust-level change

When 0.1 ships, existing users' Conservative/Standard/Autonomous agents will start behaving differently (mostly: more autonomous than before). Options:
- **(a) Silent ship** — rollout quietly; users notice when their agent auto-executes something.
- **(b) In-product banner** — next time each user loads the app post-ship, one-time banner: "Trust levels now enforce properly. Review your agents' trust settings."
- **(c) Email** + banner.

I lean **(b) in-product banner**, opt-out-able, shown once.

### Q10 — Scope vs. time trade-off

Honest estimate: 13–14 weeks to complete Blocks 0–2 with Claude Code + subagent pattern. If constrained to a shorter timeline, which do you cut?

- **(a) Drop Block 2 entirely** — ship Blocks 0 + 1 only. No agent dead-zone fills, no dashboard widget. But the foundation is solid.
- **(b) Drop Block 1.5–1.7 (A+B skill install)** — keep only control-plane basics. Customers can't browse ClawHub in-product until a later release.
- **(c) Drop half of Block 2** — keep 2.1 (notes) + 2.8 (dashboard) + 2.9 (heartbeat UI); cut the rest.
- **(d) Accept 14 weeks.**

---

## Execution handoff

Once Open Questions are answered: invoke `superpowers:writing-plans` for Block 0 to generate the TDD-shaped implementation plan. That plan becomes the artifact that `superpowers:subagent-driven-development` executes against.

This document stays as the intent + north stars + block contracts. Implementation plans live alongside it as `2026-04-19-openclaw-unlock-block0.md`, etc.

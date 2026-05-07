# Dissonance Audit — CLAUDE.md vs. Codebase

**Date:** 2026-05-04
**Branch audited:** `feat/phase2-4-mcp-agents-plans`
**Reference doc:** `CLAUDE.md` (project instructions checked into repo root)
**Method:** Four parallel codebase audits (Block 0 + Block 1; Block 2 + Block 3 + Phase 6/7; migrations + DB schema; architecture + structural claims). Each claim verified against file:line evidence in current branch.

> **Purpose of this document.** Capture every place CLAUDE.md disagrees with the code so the team can decide, per item, which way the product should go: rewrite the doc to match code, or rewrite the code to match doc, or split into a "history / retired" appendix. The user will annotate this document and we will produce the resolution plan from it.

---

## Executive summary

CLAUDE.md is **substantially stale relative to this branch.** The biggest narrative gap is that the document was last meaningfully updated on or around **2026-04-19** (Block 3 ship date), but the codebase has since:

1. **Stripped large parts of OpenClaw Block 0 + Block 1** in a "self-hosted v1" simplification pass (migrations 0053–0058, `phase9` strip commits). CLAUDE.md still narrates these blocks as live foundation.
2. **Shipped Phase 8 autonomy** (Tasks 8.1–8.6) on the heartbeat worker. CLAUDE.md still says Phase 8 has not shipped and the heartbeat worker is a scaffold.
3. **Drifted on counts** (bundled skills, packages list, migration ceiling).

What's NOT in dispute:
- All of Block 2 (9 tasks) and Block 3 (5 shipped tasks per exit gate) are present and behave as documented.
- Phase 6/7 — recurrence, workflow executor, task reactions, GitHub PR→Done, project archive, security hardening — all check out.
- Trust matrix, durable reminders, semantic wiki search, wizards-unified, standup-retired, SKILL.md sanitizer, ungated PATCH on agent-employees — all check out.
- Top-level stack (Hono, Drizzle, Socket.io+Redis, BullMQ, Resend, Anthropic Haiku/Sonnet routing, TipTap-extensions-only, 6-status engineering vocab, p0–p3 priority, DOMPurify on all 8 `dangerouslySetInnerHTML` sites, daily-notes 409 CAS) — all check out.

The remediation question is therefore **not** "is the codebase broken" — it's "which version of OpenClaw and Phase 8 does the team actually want shipping."

---

## 🔴 Section 1 — OpenClaw Block 0 / Block 1: doc claims live, code says retired

CLAUDE.md ¶130-204 narrates Block 0 + Block 1 as the foundation of OpenClaw autonomy, "shipped 2026-04-19." On this branch, large portions have been retired by a later self-hosted-v1 cleanup that the doc never acknowledges.

### 1.1 Tables retired by migration 0053

| CLAUDE.md claim | Reality | Evidence |
|---|---|---|
| `org_spend_caps` table + `checkOrgSpendCap` / `recordOrgSpendFromUsage` helpers (Block 0) | Migration 0048 created it, migration 0053 dropped it. Schema comment "retired in self-hosted v1." | `packages/db/src/schema.ts:547` |
| `clawhub_allowlist` table + daily VoltAgent cron + 14-entry static fallback (Block 0) | Migration 0047 created it, migration 0053 dropped it. | same |
| `skill_secrets` table + `apps/api/src/lib/skill-secrets.ts` helpers (Block 1) | Migration 0049 created it, migration 0053 dropped it. | `packages/db/src/schema.ts:572-573` |

### 1.2 Block 1 features that never landed (or were stripped)

| CLAUDE.md claim | Reality |
|---|---|
| `apps/api/src/lib/openclaw-gateway.ts` — WebSocket JSON-RPC client | Exists only in `.claude/worktrees/openclaw-unlock-block0/`; absent from this branch. |
| `agents.files.*` API + Personality editor page + 7 canonical files (SOUL, AGENTS, USER, TOOLS, IDENTITY, HEARTBEAT, BOOT) | No routes, no `/settings/agent-employees/[id]/personality` page. |
| Live skill install/remove (`ensureSkillInstalled` → `gateway.skills.install`, `removeSkillFromEmployee`, `DELETE /api/skills/:id/install`) | None of these symbols exist in current code. |
| ClawHub browse + import (`GET /api/clawhub/browse`, `POST /api/clawhub/import`, Library "ClawHub" tab) | No routes, no tab. |
| Pre-deploy install flow (`resolveSecretsForInstall`, `pushSkillSecretsToGateway`, `installMarketplaceSkillWithSecrets`, `POST /api/skills/:id/install/marketplace`) | None of these symbols exist. |
| `request_skill_install` runtime native tool with allowlist gate | Not in agent-tools. |
| Skill reconciliation loop (`reconcileSkillsForEmployee`, `skill_drift` notification) | Not present. |
| Exec/plugin approval forwarding (`startApprovalSubscriberFor`, `gateway.exec.approval.resolve`, action kinds `openclaw_exec_approval` / `openclaw_plugin_approval`) | Not present. |
| Reasoning trace (`startTraceForwarderForSession`, `useReasoningTrace` hook, `<ReasoningTrace/>` component, `agent:trace` socket fan-out) | Not present in apps/api or apps/web. |
| Per-org gateway reuse in `deploy-provision` worker | Logic absent. |

The `phase9` commits (`5c7e7e4`, `319e20d`, etc.) describe themselves as "strip OpenClaw + agent-kind branching" / "drop OpenClaw columns." CLAUDE.md never mentions either the strip or migrations 0053–0058 that resulted from it.

### 1.3 Block 0 partial claim — approval badge

| Claim | Reality |
|---|---|
| `usePendingApprovals` SWR hook polling `/api/agent/actions/pending` every 15s; red count badge in **main nav** | Hook does not exist. Pending-approvals UI exists only as an in-page section on the agent settings page. |

### 1.4 What this means

The product direction question for Section 1 is binary, per feature cluster:
- **(A) Doc is right, code is wrong** → re-introduce OpenClaw gateway + Block 1 features (un-strip, restore migrations).
- **(B) Code is right, doc is wrong** → rewrite Block 0/1 sections of CLAUDE.md as "retired in self-hosted v1, see migrations 0053–0058," with a one-line rationale.

The "self-hosted v1" framing in the schema comments suggests the team made a deliberate scope cut; option (B) is the likely intent. **Confirm with user before editing.**

---

## 🟠 Section 2 — Phase 8 narrated as not shipped, actually shipped

**CLAUDE.md ¶121-124:**
> "Phase 8 has NOT shipped yet. Flagged here so future edits don't claim it… The current `agent-employee-heartbeat` worker is a scaffold; the autonomous loop ships in Phase 8."

**Reality:** `apps/api/src/workers/handlers/agent-employee-heartbeat.ts` is a production-grade implementation with Tasks 8.1–8.6 visibly present:

| Task | Implementation |
|---|---|
| 8.1 — extended heartbeat handler | Line 3 comment "Task 8.1 extended the handler" |
| 8.5 — cost guardrails + health gates | Lines 175-199 consecutive-outcome tracking |
| 8.6 — loop detection | Lines 110-173 five-consecutive-identical-action circuit breaker |
| Idempotency / dedupe | Lines 94-108 `lastTurnFor()` check |
| Per-tick logging + broadcast | Lines 45-91 `logHeartbeatTurn()` writes `agent_heartbeat_turns` and emits Socket.io |
| Kind-aware dispatch | `handleAgentEmployeeHeartbeat()` routes by `employee.kind` (native vs openclaw) |

This contradicts CLAUDE.md's "scaffold" claim and the "Next Milestone" framing.

**Resolution options:**
- **(A)** Add a "Phase 8 (shipped)" section enumerating Tasks 8.1–8.6 + drop the "NOT shipped" / "scaffold" lines.
- **(B)** If the team considers Phase 8 partially shipped (e.g., skill-defined trigger dispatcher still missing), narrow the wording to that specific gap rather than blanket-disclaiming the whole phase.

Note: CLAUDE.md ¶123-124 says Phase 8 also covers (a) skill-defined trigger dispatcher and (b) heartbeat cost guardrails. (b) is shipped. (a) needs verification — the audit didn't deep-check whether arbitrary skill-manifest triggers are wired through the dispatcher beyond `cron:standup` / `member.joined` / `webhook` / `task.status_changed`.

---

## 🟠 Section 3 — Bundled skills count drift (6 → 7)

**CLAUDE.md ¶48:** *"Six day-one bundled skills ship: one per available capability pack."*

**Reality:** `apps/api/src/lib/bundled-skills.ts` seeds **7**:
- `deft-workspace` (carries the 9 task tools — verified)
- `web-browsing`
- `tavily`
- `github`
- `google-calendar`
- `shell-exec`
- `deft-mcp-client` (added in Block 3.4, explicitly cross-referenced elsewhere in CLAUDE.md)

CLAUDE.md is **internally inconsistent** here — Block 3.4 narrates `deft-mcp-client` as "seeded into the bundled catalog," but ¶48 still says six.

**Resolution:** trivially update the count to 7 in ¶48. Decide whether `deft-mcp-client` is a "capability pack" (in which case the "one per pack" framing still holds with 7 packs) or a special-case skill (in which case rephrase to "six capability-pack skills + deft-mcp-client on-ramp").

---

## 🟡 Section 4 — Migration ceiling drift

**CLAUDE.md "Known Limitations":**
> "Drizzle `_journal.json` stale… Migrations 0025-0052 were applied manually and are not tracked in the journal."

**Reality:**
- Journal is indeed stale since 0017 (highest tracked: `0017_seed_templates`, idx=16). ✅ accurate.
- But migrations **0053–0058** also exist on disk and are also unjournaled — including the 0053 cleanup that retired Block 0/1 tables (Section 1 above). CLAUDE.md doesn't mention any of these.

**Resolution:** update the deploy note to "0025–0058" (or whatever the current ceiling is at edit time), and add 0053–0058 to the Block 0/1 narrative rewrite (Section 1).

---

## 🟡 Section 5 — Architecture diagram missing `packages/mcp`

CLAUDE.md ¶13-23 lists `packages/db` and `packages/shared` only. The repo also has `packages/mcp/`.

**Resolution:** verify whether `packages/mcp` is live (suggests it is, given the `deft-mcp-client` skill) and add it to the diagram, or remove the directory if dead.

---

## 🟡 Section 6 — Auth wording

**CLAUDE.md ¶26:** "Auth: better-auth (JWT + refresh tokens + Google OAuth)."

**Reality:** auth is implemented manually with `jsonwebtoken` + `bcryptjs`, following the better-auth pattern (self-hosted, JWT + refresh) but NOT importing the `better-auth` package.

**Impact:** misleading to future contributors who'd grep for `better-auth` and find nothing. Either (a) actually adopt the library, or (b) reword to "custom JWT + bcrypt (better-auth-style)."

---

## 🟢 What checks out (no action needed)

For completeness, here is everything verified to match. If the team trusts the audit, this section is the floor — no edits needed.

### Block 0 (partial-shipped portion)
- Trust-level enforcement per tier with destructive-admin guard list (`agent-approval.ts:150-181`); 35-case matrix test (`apps/api/test/agent-approval-matrix.test.ts`).
- Durable reminders via `scheduled-jobs` queue with boot rehydration (`workers/handlers/reminder-fire.ts:66-96`); `create_reminder` native tool (`agent-tools.ts:201-203`).
- Semantic wiki search via `retrieveContext` blending FTS + pgvector cosine at 0.4/0.6 × confidence (`retrieve-context.ts:177-187`); FTS-only fallback paths intact.
- Wizards unified — `NEXT_PUBLIC_FEATURE_OPENCLAW_EMPLOYEES` flag absent from codebase; canonical 3-step `/settings/agent-employees/create` lives.
- Standup fallback retired — `workers/handlers/standup-generate.ts` emits `standup_unconfigured` notification (7-day dedupe) with no native `llm()` path.
- SKILL.md sanitizer — `apps/api/src/lib/skill-sanitizer.ts` + 20 malicious / 5 benign fixtures (`apps/api/test/skill-sanitizer.test.ts`).
- `PATCH /api/agent-employees/:id` accepts the 6 ungated fields; trust/cadence/mark_healthy still admin-gated (`routes/agent-employees.ts:710-748`).

### Block 2 (full ship — 9/9)
- Note tools: `search_notes`, `read_note`, `create_note` (quick), `note_to_wiki` (quick) — `agent-tools.ts:622-689`.
- `post_thread_reply` (full-tier, inherits `space_id`, broadcasts `message:new`) — `agent-tools.ts:605`.
- Canvas `read_canvas` / `write_canvas` (upsert, TipTap auto-wrap) — `agent-tools.ts:575-600`.
- Blocked-message → task-create proposal (`source: 'blocked_classifier'`) — `workers/handlers/blocked-alert.ts:82-100`.
- `unblock_dependents` workflow action with `subtype: 'unblocked'` notifications — `workers/handlers/workflow-execute.ts:112-157`.
- `link_decision_to_tasks` + `mark_decision_implemented` — `agent-tools.ts:548-562`; `decisions.implemented_at` at `schema.ts:855` (migration 0050).
- `member.joined` onboarding trigger fan-out — `lib/member-joined-trigger.ts` + `routes/members.ts`.
- Dashboard inline approve/reject on Agent Activity card; `/api/agent/actions/recent` route — `routes/agent.ts:708`.
- `<HeartbeatChecklistBuilder/>` — `apps/web/src/components/heartbeat-checklist-builder.tsx`.

### Block 3 (5/10 exit-gate, all 5 verified)
- `POST /api/agent-employees/:id/clone` — `routes/agent-employees.ts` ("Block 3.1").
- `POST /api/agent-employees/:id/save-as-template` — same file; migration `0051_org_scoped_templates.sql` makes `agent_employee_templates.org_id` nullable.
- Developer credentials page (`GET /:id/developer?reveal=1`, masked-by-default, admin-gated) + `/settings/agent-employees/[id]/developer`.
- Webhook-callable agents — `agent_webhooks` table (schema.ts:555-570) + migration 0052; mgmt + public HMAC dispatch routes; scrypt-hashed secrets.
- `deft-mcp-client` bundled skill seeded; `SkillAgentConfig` extended with `requires_env` + `mcp_servers`.
- Trace export `GET /api/agent/conversations/:id/trace.json` (`deft.agent_trace.v1` format).

### Phase 6 / 7
- `tasks.recurrence` + `tasks.recurrence_source_id` enums (schema.ts:252-253).
- Workflow executor with 4 actions (`add_comment`, `assign_to`, `add_label`, `notify`) on `task.status_changed` — `workers/handlers/workflow-execute.ts:5-30`.
- `task_reactions` table + endpoints (schema.ts:318-329).
- `closeTasksForMergedPR` parses `PREFIX-N` on `pr_opened|pr_closed → pr_merged` transition only; skips `done`/`cancelled` — `workers/github-sync.ts:92-150`.
- Project archive + 7-day soft-delete recovery window — `routes/projects.ts`; `is_archived` / `is_deleted` / `deleted_at` columns.
- Retired primitives stay retired: `native_tools` column gone (migration 0038); `TEMPLATE_DEFAULT_PACKS` constant gone; `project_config` JSONB gone; `project_skills` table gone (migration 0046); the three project-workflow skills (`engineering`, `marketing-campaign`, `sales-pipeline`) absent; `packages/ai` deleted (commit `07b8030`).

### Stack and architecture
- Top-level structure matches (apps/web, apps/api, packages/db, packages/shared, docker-compose.yml, LICENSE BSL 1.1, pnpm-workspace.yaml).
- Eight agent-engine files all present in `apps/api/src/lib/`: `agent-context`, `agent-plans`, `agent-tools`, `agent-actions`, `agent-runner`, `agent-stream-loop`, `agent-approval`, `agent-approval-resolver`.
- Anthropic Haiku for `classify`/`summarize`/`extract`, Sonnet for `reason` (`llm.ts:17-20`).
- Resend, BullMQ, Socket.io+ioredis, TipTap-extensions-only — all confirmed in package.json.
- 6-status engineering enum + p0–p3 priority (schema.ts:18-19).
- DOMPurify wraps all 8 `dangerouslySetInnerHTML` sites via `sanitizeHtml()` (apps/web/src/lib/sanitize.ts).
- Daily-notes 409 CAS optimistic-lock conflict — `routes/daily-notes.ts`.
- OpenClaw gateway-null defensive throw — `lib/openclaw-dispatch.ts`.
- Task-suggestion cards in chat — `components/task-suggestion-card.tsx` + `space-chat.tsx` socket listener `agent:task_suggestion`.

---

## Resolution worksheet (for user to annotate)

For each section, pick one option. We will then produce the actual CLAUDE.md edits.

| # | Topic | Options | User decision |
|---|---|---|---|
| 1.1 | Block 0 retired tables (`org_spend_caps`, `clawhub_allowlist`, `skill_secrets`) | (A) restore code, (B) doc-rewrite as retired |  |
| 1.2 | Block 1 features (gateway, agents.files, ClawHub, install flow, runtime install tool, reconciliation, approval forwarding, reasoning trace, per-org reuse) | (A) un-strip / restore from worktree, (B) doc-rewrite as retired, (C) keep deferred to a later phase |  |
| 1.3 | Approval badge in main nav | (A) build the missing `usePendingApprovals` hook + nav badge, (B) doc-rewrite to "in-page only" |  |
| 2 | Phase 8 narration ("NOT shipped" / "scaffold") | (A) doc-rewrite as shipped (Tasks 8.1–8.6), (B) narrow to the specific remaining gap (skill-defined trigger dispatcher) |  |
| 3 | Bundled skills count (6 → 7) | (A) update to 7, (B) reframe `deft-mcp-client` separately |  |
| 4 | Migration ceiling (0052 → 0058) | (A) update deploy note |  |
| 5 | `packages/mcp` in architecture | (A) add to diagram, (B) delete the package if dead |  |
| 6 | Auth wording | (A) actually adopt better-auth library, (B) reword to "custom JWT + bcrypt" |  |
| Phase 8 deep-check | Does skill-defined trigger dispatcher cover arbitrary manifest triggers? | (verify) |  |

---

## Appendix — sources of dissonance, in one sentence

The doc was last comprehensively touched ~2026-04-19 (Block 3 ship date). Since then: a self-hosted-v1 simplification stripped much of OpenClaw Block 0/1 (migrations 0053–0058, `phase9` commits), Phase 8 actually shipped (Tasks 8.1–8.6 on the heartbeat worker), and `deft-mcp-client` was added as a 7th bundled skill — none of which made it back into CLAUDE.md.

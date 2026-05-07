# Block 0 complete — OpenClaw Unlock

**Branch:** `feat/openclaw-unlock-block0`
**Date:** 2026-04-19
**Commits on top of the simplify base:** 11 feature + 1 plan doc + 1 exit-gate doc
**All acceptance gates:** ✅

## Commit chain

```
<exit gate doc>
ea19440 feat(agent-employees): extend PATCH to cover edit-agent fields              (0.3)
29932ea feat(security): per-org LLM spend cap enforced server-side                   (0.9)
2e5c557 feat(web): pending-approvals badge on Agent nav                              (0.2)
56aca7e refactor(wiki): route wiki_search through retrieveContext for hybrid FTS+cosine (0.6)
cabe28c feat(agent): create_reminder native tool                                     (0.5)
748255d feat(security): ClawHub allowlist fetcher + bundled fallback                 (0.11)
0547e64 feat(reminders): move from setTimeout to durable scheduled-jobs queue        (0.4)
56ad967 feat(security): SKILL.md body sanitizer library                              (0.10)
d1b8b57 refactor(standup): retire native-llm fallback path                           (0.8)
ba9ed80 chore(web): delete 7-step agent-deploy wizard, unify on 3-step flow          (0.7)
fb0e94f feat(trust): enforce autonomous trust level — auto-execute full tier         (0.1)
bcd7053 docs(plan): OpenClaw Unlock v2 plan on Block 0 branch
```

## Exit gate — all checks ✅

- [x] All 12 Block 0 tasks committed.
- [x] `pnpm --filter @deft/api typecheck` — clean.
- [x] `pnpm --filter @deft/web typecheck` — clean.
- [x] Block 0 test suites: **55/55 pass** (agent-approval-matrix 35, skill-sanitizer 5, clawhub-allowlist 6, reminder-fire 3, org-spend-cap 6).
- [x] Pre-existing `phase8-heartbeat-prompt.test.ts` still red (author_user_id column drift — not ours; CLAUDE.md flags it).
- [x] No new reds introduced by any Block 0 commit.
- [x] Migrations 0047 + 0048 applied to dev DB; both tables verified.
- [x] CLAUDE.md updated with the Block 0 section + migration-count bump.

## Behavior smoke checks (covered by the test suites)

- Conservative agent: auto-tier auto-execs, quick + full queue. Matrix test.
- Standard agent: auto + quick auto-exec, full queues. Matrix test.
- Autonomous agent: auto + quick + full auto-exec EXCEPT destructive (manage_agent_employee, manage_mcp_connection, remove_member, delete_*, params.mode=delete|pause|revoke). Matrix test + 5 destructive cases.
- Approval badge: `usePendingApprovals` SWR hook renders in sidebar. Manual smoke on dev server.
- Reminder fire-and-forget: handler no-ops on missing row; fires once then idempotent.
- Semantic wiki search: hybrid score works when embeddings populated; FTS fallback when absent.
- Old `/settings/agent/deploy` → redirects to `/settings/agent-employees/create`.
- Standup with no subscribed employee: emits `standup_unconfigured` notification to admins; no LLM call, no standups row.
- Per-org spend cap: auto-creates row at $100/mo default; increments on record; circuit-breaks when monthly cap reached; lazy reset at day/month boundary.
- SKILL.md sanitizer: 20 malicious fixtures all flagged; 5 benign all clean.
- ClawHub allowlist: VoltAgent parse works; bundled fallback has 14 entries; daily cron registered.
- PATCH /api/agent-employees/:id: accepts all edit-agent fields; role gate preserved for trust/cadence/mark_healthy.

## What's deferred (Block 1+)

- In-product banner announcing trust-level change (Q9 from plan — minor UX). Deferred since matrix test + the existing trust-level control surfaces on settings/agent cover most users.
- Full drawer edit UI for agent fields (Block 0.3 backend shipped; the drawer UI rewrite is Block 1).
- OpenClaw-side SOUL.md / HEARTBEAT.md editing via `agents.files.set` (Block 1 — needs Gateway RPC client).
- Live skill install on attach (Block 1 — needs Gateway RPC client).
- Admin UI for `org_spend_caps` at `/settings/general` — Block 3 polish.
- Wiring `llm()`'s new `orgId` param through every caller — incremental; agent-runner + stream-loop next.

None of the deferrals block the exit gate. They're follow-ons, not foundations.

## Ready for Block 1

Block 1 can start here. The Gateway RPC client (`apps/api/src/lib/openclaw-gateway.ts`) is the first task — it unlocks A+B skill install, exec-approval forwarding, reasoning-trace subscription, and live markdown file editing for agents.

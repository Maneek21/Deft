# Cleanup before OpenClaw Unlock — overnight autonomous plan

**Authored:** 2026-04-19
**Owner:** me (Claude Code, executing overnight)
**User returns:** tomorrow with fresh mind to start Block 0
**Safety constraint:** no destructive operations without trivial reversal; no remote/shared-state changes

---

## Goal

Get from "worktree branch doesn't build + main workspace has untracked pile" to "simplify-skills-templates branch ready for PR + main workspace clean + handoff doc written". User arrives tomorrow and kicks off Block 0 without any cleanup bookkeeping in their way.

## What I WILL do autonomously

1. **Worktree branch** (`worktree-simplify-skills-templates`): commit build-required untracked files; verify typecheck clean; strip the 2 stray OpenClaw Unlock planning docs and save them on a separate `plans/openclaw-unlock` branch so they survive.
2. **Main workspace** (`feat/phase2-4-mcp-agents-plans`): commit ship-worthy untracked files in themed commits; bulk-delete unambiguous trash (screenshots, snap files, debug scripts); delete superseded dashboard experiments.
3. **Verification**: typecheck green on worktree branch; `git status` clean on main workspace.
4. **Handoff doc**: `docs/superpowers/handoff-2026-04-20.md` with the user's morning action list.

## What I WILL NOT do (requires user)

- Push any branch to a remote (repo has no remote configured; would need auth anyway).
- Open any PR (GitHub action; needs user).
- Merge anything to `main`.
- Delete or rename any tracked file whose purpose I'm unsure of (e.g. `DEPLOYMENT-*.md`, `ROADMAP.md` placement — leave at current location, user can organize).
- Cut the new OpenClaw Unlock worktree. User does that tomorrow off post-merge main.

## Safety rules

- Every step ends with a git commit or checkpoint so state is recoverable.
- Rebase uses a backup branch (`backup/pre-cleanup-worktree`) before any history rewrite.
- Trash deletes are limited to categories the audit explicitly flagged (screenshots, snapshot markdowns, debug scripts, superseded dashboards). Anything ambiguous stays.
- No `git reset --hard`, no `git push --force`, no `rm -rf` on tracked files outside the explicit trash list.
- If any step produces an unexpected error, I stop and document it in the handoff. I do not escalate to destructive recovery.

---

## Execution plan

### Phase 1 — Worktree branch (`worktree-simplify-skills-templates`)

**1.1** Snapshot current state.
```
git branch backup/pre-cleanup-worktree
git log --oneline -30 > /tmp/pre-cleanup-log.txt
```

**1.2** Save the 2 stray planning commits to a separate branch.
```
git branch plans/openclaw-unlock-drafts
# branch now has 0b5e52c + 373b8fa on top of the simplify story
```

**1.3** Rebase to drop the 2 stray planning commits from this branch.
```
git rebase --onto <simplify-end-sha> 373b8fa^ HEAD~2
# Practically: reset to the last real simplify commit (d78a3b3 test(audit): extensive Playwright E2E)
# and cherry-pick nothing on top.
```

Simpler approach: `git reset --soft HEAD~2` then discard the two doc files, OR `git reset --hard d78a3b3`. Use soft-reset so changes stay as uncommitted then discard.

**1.4** Commit build-required files in one atomic commit.
```
git add apps/api/src/workers/handlers/wiki-lint.ts
git add apps/web/src/app/\(app\)/knowledge/graph.tsx
git add apps/web/src/app/\(app\)/tasks/timeline.tsx
git add apps/web/src/components/confirm-dialog.tsx
git add apps/web/src/app/forgot-password/
git add apps/web/src/app/reset-password/
git commit -m "fix: commit files required for branch to build

The simplify refactor uncovered 6 files that existed only as untracked
in the main workspace: wiki-lint worker (imported by workers/index.ts),
knowledge graph lazy view, tasks timeline lazy view, confirm-dialog
component, and the forgot-password + reset-password auth routes.

Without these, API typecheck fails and web build crashes on certain
routes. Committing as part of this branch so the PR is self-contained."
```

**1.5** Verify the branch builds clean.
```
pnpm --filter @deft/api typecheck  # expect 0
pnpm --filter @deft/web typecheck  # expect 0 new errors
pnpm --filter @deft/api test       # expect same pre-existing red only
```

If any new failure: stop, document, do not proceed.

**1.6** Draft the PR body into `docs/superpowers/pr-simplify-skills-templates.md`. User copy-pastes tomorrow.

### Phase 2 — Main workspace (`feat/phase2-4-mcp-agents-plans`)

**2.1** Switch context to main workspace (exit worktree or use explicit path for all commands).

**2.2** Snapshot main workspace state.
```
git -C "C:/Users/Osheen Pradhan/cairn" status -s > /tmp/main-untracked-pre.txt
git -C "C:/Users/Osheen Pradhan/cairn" branch --show-current
# expect feat/phase2-4-mcp-agents-plans
git -C "C:/Users/Osheen Pradhan/cairn" branch backup/pre-cleanup-main
```

**2.3** Commit ship-worthy files in themed commits.

Commit A — auth + features that build-required items depend on (but exist on simplify branch already; may not need on this branch). Skip if redundant.

Commit B — knowledge/wiki infrastructure
```
git add apps/api/src/scripts/migrate-to-wiki.ts
git add packages/db/seed-wiki.ts
git commit -m "feat(knowledge): migrate-to-wiki script + seed-wiki DB seed"
```

Commit C — design + strategy docs in place (no move, no rename)
```
git add docs/AGENTIC-EMPLOYEES-PLATFORM.md
git add docs/CHAT-COMPETITIVE-ANALYSIS.md
git add docs/NOTES-COMPETITIVE-ANALYSIS.md
git add docs/TASKS-COMPETITIVE-ANALYSIS.md
git add COMPETITIVE-ANALYSIS.md
git add ROADMAP.md
git add DEPLOYMENT-PLAN.md
git add DEPLOYMENT-READINESS-REPORT.md
git commit -m "docs: add strategy + competitive analysis + deployment docs

Design and research docs from prior sessions. Root-level placement
preserved; user can reorganize later."
```

Commit D — plan archive
```
git add docs/superpowers/plans/2026-04-1*.md
git commit -m "docs(plans): archive executed plan docs from April sessions"
```

Commit E — copy the simplify spec + plan docs from the worktree's doc folder (user will see them regardless).
```
# Already in the worktree; main workspace might not have them
# If main workspace lacks them, copy from worktree:
cp <worktree>/docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md \
   docs/superpowers/specs/
cp <worktree>/docs/superpowers/plans/2026-04-18-simplify-skills-templates.md \
   docs/superpowers/plans/
git add docs/superpowers/specs/2026-04-18-simplify-skills-templates-design.md
git add docs/superpowers/plans/2026-04-18-simplify-skills-templates.md
git commit -m "docs: carry simplify-skills-templates spec + plan onto feature branch"
```

**2.4** Bulk-delete trash.

Delete trash categories one at a time, commit per category so reversal is easy.

```
rm -f dash*.png dashboard*.png dash6-*.png
git add -A && git commit -m "chore: remove dashboard iteration screenshots"

rm -f ux-audit-*.png walkthrough-*.png
git add -A && git commit -m "chore: remove UX audit + walkthrough screenshots"

rm -f snap-*.md tasks-snap.md
git add -A && git commit -m "chore: remove playwright accessibility-tree dumps"

rm -rf test-screenshots tasks-audit docs/ui-audit
git add -A && git commit -m "chore: remove test-screenshots / tasks-audit / ui-audit dirs"

rm -f apps/api/src/scripts/check-agent-jobs.ts \
      apps/api/src/scripts/check-queue.ts \
      apps/api/src/scripts/check-recent-msg.ts \
      apps/api/src/scripts/clear-stale.ts
git add -A && git commit -m "chore: remove one-off debug scripts from api/scripts"
```

**2.5** Delete superseded dashboard experiments. User named dashboard6 canonical earlier in the session.
```
rm -rf apps/web/src/app/\(app\)/dashboard2 \
       apps/web/src/app/\(app\)/dashboard3 \
       apps/web/src/app/\(app\)/dashboard4 \
       apps/web/src/app/\(app\)/dashboard5
# Check if any of these are tracked first — if so, git rm
git add -A && git commit -m "chore: remove superseded dashboard2/3/4/5 iterations

Dashboard6 is the canonical variant per the iteration sessions that
produced the current UI. The earlier experiments are committed noise."
```

**2.6** Final state check.
```
git -C "C:/Users/Osheen Pradhan/cairn" status -s
# expect: only .claude/settings.local.json modification (ignore), maybe next-env.d.ts
```

Anything else untracked: leave alone, flag in handoff.

### Phase 3 — Handoff document

Write `docs/superpowers/handoff-2026-04-20.md` in the worktree with:
- What I did (per-phase summary with commit SHAs)
- Current branch state
- User's morning action list (ordered)
- Known gotchas

### Phase 4 — Final verification

```
# From worktree
git log --oneline -10           # confirm branch state clean
pnpm --filter @deft/api typecheck  # confirm clean
pnpm --filter @deft/web typecheck  # confirm clean

# From main workspace
git -C "C:/Users/Osheen Pradhan/cairn" log --oneline -10
git -C "C:/Users/Osheen Pradhan/cairn" status -s
```

---

## User's morning action list (ends up in handoff doc)

Ordered, each ~5 min:

1. Review this cleanup's commits (worktree branch + main workspace branch) with `git log --oneline`.
2. If acceptable: push `worktree-simplify-skills-templates` (requires setting up `origin` remote first).
3. Open PR → target `main`.
4. Merge after review.
5. Push `feat/phase2-4-mcp-agents-plans` with its cleanup commits; open PR → merge.
6. Pull updated `main` into main workspace.
7. Delete the `simplify-skills-templates` worktree (`git worktree remove`).
8. Cut a new worktree from clean `main` for Block 0: `git worktree add .claude/worktrees/openclaw-unlock-block0 -b feat/openclaw-unlock-block0 main`.
9. Start Block 0 by answering my 10 Open Questions from the OpenClaw Unlock plan doc, then invoke `superpowers:writing-plans` for Block 0 implementation plan.

---

## Contingency

If anything unexpected blocks me mid-execution:
- I STOP at the last committed checkpoint.
- I write the partial state + the blocker into the handoff doc with a clear "do not execute further; this is what got done, this is what didn't, this is why."
- User arrives and decides.

I do not attempt destructive recovery or heroics while the user is away.

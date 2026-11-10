# Defty Live Conversation Simulation

October 22, 2026, `origin/master` `388f0a0b` (0.3.0-preview.138). Local API with job workers, a disposable database seeded by `seed-test-org.ts` (Admin, Priya Shah, Rahul Mehta, Arjun Rao, Sara Kim; one project "Deft v1" with DEFT-1…20), and OpenAI with Deft's default Defty model `gpt-5.6-sol`. Twelve scripted multi-person conversations were driven through the real REST chat path, as real users with `@Defty` mentions. Harness: `defty-sim.mjs` (session scratchpad). Each scenario except S9 and S12 ran in a fresh channel.

## Scorecard

| # | Scenario | Result | What happened |
|---|---|---|---|
| S1 | Returning teammate: "catch me up, what's the plan and who's doing what?" after a 5-message discussion | Pass, but too long | Correct plan, owners and dates. Then appended an unrequested task list for the whole project. Report-style headings. 38 s. |
| S2 | "make a task for what Rahul said", then a correction | **Fail** | Asked "Which project?" although only one project exists. The correction in the thread without a mention got no reply. The same correction with a mention lost the draft: "could not prepare any approval proposals. The create task draft needs project name." |
| S10 | Same request; answer Defty's question in the thread | **Fail, then pass** | The identical request now failed outright: "needs project name". A thread answer "Deft v1" without a mention was ignored. With a mention, it produced a correct proposal (Rahul, rollback script, source message). The due date became today: "by Thursday" was said on a Thursday, which is ambiguous, and Defty did not ask. |
| S3 | "move the error tracking task to in progress and give it to me" | Pass | Resolved DEFT-7 by paraphrase and bound "me" to Arjun; two approval cards. The reply text was boilerplate ("I drafted 2 related changes…") and did not say what they were. |
| S4 | "what has Rahul got on his plate?" | Pass with defect | Tasks, statuses, priorities and dates correct. **Rewrote two task titles** ("Review: feat(auth) — server-side logout" was rendered as "Final sanity check for server-side logout"). |
| S5 | Debate (slip launch vs cut import), then "@Defty what do you think?" | Pass | Engaged with the actual trade-off and proposed a middle path; concise. Cited sources as raw message UUIDs. |
| S6 | "The logout PR is the last auth thing" → "@Defty is that reviewed yet?" | Pass | Resolved "that" to DEFT-13; correct status. |
| S7 | "create a task for me and Sara … due next Monday" | Partial | Asked which project (only one exists) and who should be the primary assignee (reasonable). |
| S8 | "assign the review task to Sara" (DEFT-13 and DEFT-14 both match) | Pass, terse | Asked "DEFT-13 or DEFT-14?" without titles. |
| S9 | From a DM: "what did the team decide in sim-s1-catchup about the demo?" | Pass | Correct; raw UUID sources. |
| S11 | Detail posted 23 chatty messages earlier in a busy channel | Pass | Found it ("4 steps, invite at step 2"). |
| S12 | "catch me up on this channel" in the seeded #launch | Pass, long | Grounded; multi-section report; 48 s. |

**Engagement:**
- Replies took 17–48 s, with no working indicator.
- Follow-ups without `@Defty`, including answers to Defty's own question, were ignored in 2 of 2 cases.
- Clarifying questions were asked when there was nothing to clarify (one project), and the answers were not tied back to the pending draft.

## Background processes observed

- **Per-message classifier:** one model call per human message, with no conversation context. The labels were noisy:
  - "Schema review will be done Wednesday EOD" was flagged as `blocked`; it is a commitment.
  - "actually give it to Arjun instead" was stored as a decision ("Assign it to Arjun instead of Rahul") with no referent.
  - "builds take ~12 min" and "the staging db got reset" were stored as memorable facts.
  - "standup moved to 10:30 tomorrow" was stored as a decision.
- **Human-request attention:** correct. Priya got "Admin needs your input: tell the customer the demo moved to Friday 3pm".
- **Blocked alert:** fired for Rahul but quoted an older seeded message (a test flake), not the migration block he had just posted.
- **Knowledge capture** (manual `capture-discussion` on four channels):
  - Captured: "Onboarding Checklist Structure" (4 steps, invite at step 2). It was published as org-wide knowledge with **no review**.
  - **Missed:** "Agreed, demo moves to Friday 3pm", an explicit decision.
  - Correctly skipped: the unresolved launch debate.

## Environment defects found

- **Windows line endings:** `pnpm db:push-full` fails on Windows checkouts with `core.autocrlf=true`. `packages/db/scripts/fresh-schema-contracts.sql` and the reviewed-lineage artifacts are SHA-256 checked, `.gitattributes` does not pin them to `eol=lf`, and the check fails with `E5_FRESH_CONTRACT_ARTIFACT_MISMATCH` then `E5_REVIEWED_LINEAGE_ARTIFACT_MISMATCH`.
- **Broken seed:** `seed-test-org-rich.ts` fails on current schema with a NOT NULL violation on `task_activity.org_id`.
- **Misleading no-provider message:** with no org AI config and only empty `*_API_KEY=` lines, Defty replies "the AI provider did not return a usable response. Please retry" instead of directing the user to Settings → AI. *Suspected cause:* empty env keys are treated as configured. Not yet confirmed in code.
- **Stale local master:** the main local checkout's `master` was 670 commits behind `origin/master`. The first audit in `2026-10-22-defty-failure-audit.md` was run against that stale code. Its re-validation against current code is recorded in `2026-10-22-defty-failure-audit/codex-g-revalidate.md`: 58 still present, 11 changed, 8 fixed.

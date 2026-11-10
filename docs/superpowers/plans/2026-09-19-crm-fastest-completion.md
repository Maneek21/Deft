# CRM resumption: fastest path to completion

Prepared September 19, 2026. Planning only. No implementation, runtime changes, new test passes, deployment, or acceptance closure is claimed here.

## Recommendation

Resume the existing flagship candidate at its September 17 handoff. The remaining work is a known assistant UI defect plus lifecycle, authority, recovery, usability and integrated acceptance. Do not restart the September 9 feature plan: most of that implementation already exists.

The finish line remains the previously agreed human-review-ready candidate: all mandatory engineering requirements have applicable evidence, no material defect remains, and the reviewer can assess the product without finishing engineering validation. Human approval, PR planning, merging and public release follow that gate. The earlier blanket completion and 9/10 claims were withdrawn.

## Where the work lives

| Purpose | Location |
| --- | --- |
| Canonical implementation | `C:/tmp/deft-crm-flagship`, branch `codex/crm-flagship-foundation` |
| Curated release/review copy | `C:/tmp/deft-crm-release-20260916`, branch `codex/crm-release-20260916` |
| Latest execution handoff | `C:/Users/Osheen Pradhan/Documents/Codex/2026-09-16/look-at-the-crm-work-x20/outputs/CRM-budget-wrap-handoff-2026-09-17.md` |
| Authoritative requirement decisions | Same outputs directory: `CRM-gate-ledger.csv` |
| Detailed acceptance contract | Same directory: `CRM-actual-gate-plan-2026-09-17.md` |
| Findings and UI coverage | Same directory: `CRM-issues.md`, `CRM-ui-matrix.csv` |
| Prepared recovery/volume work | Same directory: `CRM-hosted-isolated-successor-d08-procedure.md`, `CRM-volume-protocol.md` |

Both CRM branches have base HEAD `7c2e409470a0cc98acb21fdf703361f73053865f`; the candidate changes are not committed. The curated worktree currently has 264 changed/untracked paths, including staged changes with later unstaged corrections and eight untracked candidate files. Preserve both staging and untracked files. A diff against the frozen tree can report those eight files as deleted even though the untracked files exist; inventory actual contents before interpreting that output.

Fresh September 19 SHA-256 comparison against the two source-review inventories found 264 unique reviewed paths, zero canonical mismatches, zero curated-release mismatches, and zero differences between the two copies. This establishes local reviewed-file continuity; it does not independently verify the running host.

The Documents main checkout is older and contains unrelated changes. It is not the implementation starting point. The September 9 plan and repository acceptance ledger are older than the latest execution handoff. Use the handoff and requirement ledger to resolve contradictory completion statements.

Last recorded deployment, not freshly inspected during this planning pass:

- Source tree: `b2f63d7d9a18d3735660258046337e89f2f55bc7`.
- Image: `sha256:0201d37e06eb59e6950cbe6fc39e0abf98add40a7b27dc12bec84bfc06499c19`.
- Source archive SHA-256: `1677542499bd6efdde1a3a869bdfa46bd37a82e7e4e2c0e67182707eafb5f9df`.
- Contacts Module 1.8.0; Contacts CRM App 1.9.0; App Kit 0.1.0-alpha.3.

## What is already there

Company/contact relationships, deals, activities, native follow-ups, outreach drafts, governed sandbox execution and receipts, import/merge/archive, public App packaging and significant UI polish have implementation and executed evidence. The latest handoff records substantive review of all 264 intended paths, 125 passing automated checks with zero skips, typechecks and a production build, plus backed-up deployment and preservation checks. These are retained results, not tests rerun today.

The CSV currently contains 61 requirements: 18 passed fresh, 8 passed with validated reuse, 15 in progress, 19 open and 1 failed. Thus 35 need closure. This is not an implementation percentage: many open rows already have partial evidence and prepared procedures.

The immediate known failure is CRM-14 / A01. Defty found the full fresh company graph and due task, but its threaded reply invented external record URLs and omitted canonical Sources. Current source inspection confirms `agent-message-blocks.tsx` renders normalized citations while `thread-panel.tsx` does not use that component or citation footer. The fix must reach the actual thread consumer and preserve backend authority filtering; a helper-only test is insufficient.

Other important distinctions:

- CRM-12 base-App re-enable has a source fix and guarded tests; final rendered lifecycle acceptance remains open.
- CRM-10 cross-session upload replay has regression coverage; real session replacement and late-response acceptance remain open.
- Archive focus, stale-error visibility, activity/task revalidation and some contrast defects have verified repairs. Reuse those results where the final delta permits.
- Codex has actual canonical-task and sandbox-action evidence. Defty discovery improved, but the complete ordinary assistant journey remains unclosed.
- Date keyboard entry and persistence passed. The embedded native-picker crash was reproduced outside Deft. Remaining date-boundary checks are separate.

## Execution order

| Step | Work and completion evidence | Requirement coverage | Planning allowance |
| --- | --- | --- | --- |
| 1. Establish one baseline | Preserve indexes; compare actual canonical/release files with review hashes; recheck host image and package identities; mark which prior evidence survives the delta. Confirm the isolated stack and database identities before restarting anything. | C01/C02 carry-forward, C03/C04 planning, F01 | 0.5–1 h |
| 2. Fix the actual thread surface | Reproduce CRM-14, wire authority-filtered source metadata into threaded replies, and ensure invented model URLs are not presented as authoritative record links. Cover the consumer, permission filtering and non-CRM source types. Review the small change, build a successor and prove rendered navigation. | A01, C03; changed UI coverage | 1.5–3 h |
| 3. Finish assistant acceptance | One fresh uncoached company summary with resolving links; propose/approve/create/link a dated task exactly once; continue with the same ID; prepare grounded outreach. Use a second fresh company, ambiguity and a fresh denied read after access removal. Reuse Codex evidence only where contract changes permit; rerun affected behavior. | A01–A05 | 2–3 h |
| 4. Complete install and session checks | Reuse the prepared isolated operator host on the successor image. Verify disabled base re-enable with connected upgrade staged, official upgrade preservation, rejected/accepted adoption, compatibility rejection, unrelated Module navigation and no-AI/no-mail usage. Exercise real logout/user/org replacement with late responses. Finish the uncoached operator rehearsal from the portable guide. | D05/D06, O01–O07, H16/H22 | 2–4 h |
| 5. Run prepared correctness and recovery cases | Use the existing 116-deal/102-task-link fixture and predeclared timing/request bounds. Reconcile mixed-currency totals and restricted links. Run failed/unknown sandbox outcomes and safe retry across restart in isolation. Close dropped-response/stale/revocation cases and restore applicability, including uploads/config where claimed. | H07/H09/H18, D07/D08/D10/D11 | 2–4 h |
| 6. Close remaining UI cells and freeze | Inspect only missing/invalidated cells at desktop and 390px, light/dark: dates/day boundaries, focus, long values, empty/error/denied/disabled states and native consistency. Finish shipped docs and any demonstrated repairs before the final freeze. | U01–U05, remaining H16/H22, C03/C04 | 1.5–3 h |
| 7. Final integrated proof and handoff | Run one consolidated relevant validation; inspect final diff/untracked files. Walk the same canonical company/contact/deal/activity/task/outreach through approval and receipts on the final build, with a second session and mobile checks. Reconcile all artifacts, review changed paths independently, account for temporary access/approvals, and issue the current human-review packet. | F01/F02/F04/F05/F06; applicability of all prior passes | 1.5–2 h |

Expected active engineering effort: approximately 12–20 hours, or 2–3 focused days, assuming runtime access is available and no new material defect emerges. This is a planning estimate, not a commitment. Re-estimate after steps 2 and 4, which carry the most uncertainty. Human review and any later release process are additional.

## How to make this fast without weakening completion

1. Maintain the existing 61-row ledger rather than creating another competing completion report. Attach each new observation to a row and close only the missing assertions.
2. Make the citation repair the first implementation slice. Avoid broader retrieval redesign unless a fresh uncoached case demonstrates it is still necessary.
3. Reuse the 264-path substantive review after checking hashes. Review changed paths and affected trust/data flows again; do not reread unchanged source to recreate the same review.
4. Use one successor acceptance build after the initial repair. Accumulate any subsequently demonstrated fixes before the final build. Rebuild only when source changes invalidate the candidate.
5. Use the existing isolated host, package artifacts, fixture scripts and failure procedures. The isolated App was stopped at handoff and still used an older image; bring it to the chosen candidate before crediting results. Recheck dynamic container addresses.
6. Combine compatible checks into journeys: install/upgrade/re-enable with the independent operator; no-provider behavior with missing-setup guidance; volume with pagination/totals; final human journey with second-session and mobile checks. Keep independent outcomes in the ledger.
7. Bound actual-model runs to the stated scenarios; retain failures and diagnose them rather than repeatedly prompting until one passes. Restore temporary agent access afterward.
8. Reuse security and recovery results only with explicit dependency/delta applicability. A deterministic test, a prepared harness and an actual browser/model run establish different things.

Independent review and the fresh-context operator rehearsal remain required acceptance activities. This planning pass did not dispatch agents. Any later delegation should be bounded to these concrete independent tasks, with one browser owner and no overlapping implementation files.

## Scope and stopping rule

Keep the existing scope: manual CRM, Defty and Codex collaboration, portable installation, and accurately labeled sandbox outreach. Claude, the cancelled video, real email delivery, bulk sends/sequences, a new dashboard, autonomous prospecting and a generic platform rewrite remain outside this completion effort.

Existing Northstar/demo records are protected. Fault injection, restore, load fixtures and lifecycle experiments belong in isolated fictional environments. Do not print credential files, share private backups, reset existing databases, or turn all dirty files into an undifferentiated commit.

Completion requires all mandatory rows to pass with final-candidate applicability; the known citation defect and session/lifecycle acceptance cannot be handed to a human as unfinished engineering work. After the gates pass, apply the agreed visual/workflow/integration rubric independently. Any score below the agreed target needs a concrete finding and follow-up, not score inflation. Produce one reproducible review packet and stop before PR planning, as the previous scope requires.

## Evidence limits of this resumption review

This pass inspected Git state, the latest task handoff/ledger/review inventories, relevant implementation and retained acceptance reports. It did not restart services, test the live host, run product tests or make new product-quality claims. Implementation and runtime actions above are planned work.

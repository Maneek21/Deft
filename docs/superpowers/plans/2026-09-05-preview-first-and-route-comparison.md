# Deft: ship the current preview, then complete the platform

Date: 2026-09-05. Status: **Selected by the owner; preview scope and release gates frozen.** This is the controlling plan for the next public preview. Implementation and release have not started under this plan.

Detailed aggressive execution variant: [coordinated build, broad test, iterative repair and final certification loops](2026-09-05-aggressive-preview-build-test-loops.md). That variant targets 5–7 days with extra staffing and ready infrastructure; it preserves this plan's scope and gates. The normal 8–12-day estimate remains the fallback.

## Accepted release decision

Freeze new features, fix the known launch defects, certify the current supported surface, and ship a named self-hosted public preview. Then continue Tracks B/C/D and Gate G through separately proven releases. Keep the release and development work isolated so supporting preview users does not continuously reopen the development scope.

**Target the first preview in 8–12 working days, approximately 1.5–2.5 weeks.** Plan toward day 10, conditional on the gates below. A 5–7-day result is an aggressive scenario requiring an additional dedicated security/operations owner, a ready test host and few surprises. A single serial implementer/agent loop should allow roughly 3–5 weeks for this stabilization scope.

The alternative [full-platform-first plan](2026-09-05-app-platform-preview-completion-plan.md) estimates 6–8 weeks before the first release with two experienced implementers using coding agents plus a test/release reviewer. Use the same staffing assumption when comparing the normal ranges here. These are engineering estimates, not measured future agent execution times or promised dates.

This plan relies on the [launch audit](../audits/2026-09-05-launch-readiness-roadmap.md) and [Apps follow-up](../audits/2026-09-05-app-platform-track-a-status.md). At execution start, refresh the audited GitHub/PR state; the source baseline assessed was master `7355c90a`. Preserve the stale root checkout's original modifications and unrelated worktree work.

## Frozen preview scope

Owner decision recorded on 2026-09-05: “lets freeze the preview first path.”

1. **Ship the existing product after stabilization:** current workspace, documented agent/MCP workflows, declarative Apps, and the connected-App/Track A opt-in profiles that pass their required proof.
2. **Close L01–L12 and the critical Apps gaps:** all supported persistence, authorization, duplicate-effect, installation and recovery defects remain release work.
3. **No new platform planes before preview:** Tracks B/C/D and remaining broad Gate G work continue after this release. Any existing-surface authorization or compatibility fix needed for safe preview use remains in scope.
4. **Keep the complete release gate:** real-backend and scheduled-effect tests, browser/accessibility checks, security review, clean installation/upgrade/restore, exact artifact verification, and the 24–48-hour stable-candidate soak.
5. **Provide a usable public path:** version-matched App Kit artifacts, tested authoring/install instructions, accurate limits and release notes. A new in-product builder and wider feature polish are not prerequisites.
6. **Treat 8–12 working days as an estimate:** it assumes the stated staffing and infrastructure. The release date follows passing gates; it does not override them.
7. **Record scope changes explicitly:** do not silently remove Apps, weaken tests, or add later-track features to meet a date. If the accepted scope cannot pass, report the failed gate and revise the schedule or obtain an explicit scope decision.

This freezes the product scope and acceptance criteria, not the audited source SHA. Select the final immutable release revision and image after the fixes and validation. The full-platform plan is retained as the post-preview continuation reference; its original pre-launch schedule is not the active release schedule.

## What the first preview contains

| Surface | Preview treatment | Required proof |
|---|---|---|
| Chat, tasks, Notes, knowledge, calendar context and settings | Supported current workspace behavior | Persistence, negative paths, permissions, responsive layouts and recoverability |
| Existing agent/MCP/approval/receipt workflows | Supported documented configurations | Real supported client, scoped read/write, approval, result/receipt, revoke and provider outage |
| Declarative Modules and Apps | Supported current contracts | Packaged install, records, relationships, native views, upgrade and disable |
| Connected Apps | Explicit developer-preview opt-in | Exact provider/grant/binding contracts, public packed artifacts, lifecycle and offline behavior |
| Track A automation | Opt-in only after its critical correctness/management gaps and real scheduled-effect proof pass | Actual due fire, worker, sandbox effect, result and receipt; duplicate/restart/revocation/restore proof |
| Custom executable App UI | Not in this release | Track B later |
| App runtimes and specialized synchronization | Not in this release | Track C later |
| App public pages, booking endpoints and webhook ingress | Not in this release | Track D later |
| Broad full-surface platform claim | Not made | Applicable Gate G requirements and compound proofs later |

Advertise a **self-hosted workspace preview with declarative Apps and a bounded connected-App developer preview**. Connected capability support remains the frozen sandbox-email interface; do not imply arbitrary MCP action declarations, production email delivery or unrestricted workflows.

The supported deployment is the documented single-instance linux/amd64 self-hosted profile. Core usage without AI keys must work. Experimental features default off and have a tested opt-in configuration; changing a runtime variable does not substitute for enabling the Apps web build flag.

Aim to include the current Apps plane, not silently remove it to meet a date. If its gates fail, explicitly decide between delaying the preview and shipping a clearly narrower workspace-only preview. A hidden setting or “experimental” label does not make a reachable unsafe feature acceptable. No fall-through claim of Track A completion is allowed.

## Feature freeze and defect rules

The release branch accepts defect fixes, compatible security updates, minimal operator controls needed for safe use, tests, packaging and accurate documentation. It does not accept B/C/D contracts, generalized capabilities, a new runtime, an App marketplace, a new scheduler or unrelated refactors.

Every finding receives a status: reproduced and fixed, disproved with evidence, removed from the offered surface with verification, or explicitly deferred because it does not affect supported correctness/security/recovery. Track evidence separately from priority. No data-loss, duplicate-effect, tenant-isolation, authentication, unsafe-upgrade or broken-install issue is deferred behind a preview label.

## Pre-release work: the minimum adequate scope

### 1. Establish the release candidate and test environment

- [ ] Refresh master, PR317/318 and relevant CI evidence; create an isolated `codex/` release worktree from the reviewed base.
- [ ] Preserve local modifications; inspect any existing fixes before writing replacements. Do not merge the unimplemented Email Lite planning branch into the release.
- [ ] Maintain a small defect-and-evidence ledger covering L01–L12 and current Apps findings. Each item has an owner and concrete acceptance scenario.
- [ ] Provision real disposable Linux Docker/pgvector fixtures, two organizations, varied roles, representative records/files, keyrings and a synthetic provider. Use no existing customer/workspace DB for resets.
- [ ] Freeze the offered default and Apps opt-in configurations, release-image build flags and supported upgrade predecessors.

Estimate: half to one working day. The database/test-host readiness is a prerequisite, not work to discover missing on release day.

### 2. Fix all current launch defects

| Audit item | Required outcome before launch |
|---|---|
| L01 Notes persistence | Body edits survive title/icon changes; failed saves remain visibly unsaved; reload recovers the acknowledged content |
| L02 unsafe client retries | A committed write with a lost response cannot create duplicates; idempotency/reconciliation is explicit |
| L03 release assets | Download-only installation works from an empty directory without a source-checkout SQL dependency |
| L04 upgrade failure | Failed schema/application upgrades cannot blindly restart incompatible old code; supported recovery is rehearsed |
| L05 process supervision | API or web process failure produces a correct container lifecycle and safe job recovery |
| L06 dependency graph | Repair the complete TipTap graph; current security checks and editor behavior pass |
| L07 session/OAuth boundaries | Refresh rotation/revocation and public endpoint validation/abuse controls work without breaking legitimate auth/MCP flows |
| L08 native GitHub linking | Keep the unsupported native integration unavailable in this preview, or fully repair and certify state binding before offering it |
| L09 login recovery | Wrong credentials followed by correct credentials succeeds; unsafe return destinations are rejected |
| L10 protected images | Authorized users can see Notes media; unauthorized users cannot; saved content contains no reusable bearer token |
| L11 recovery documentation | Published instructions restore DB, files, config and keys on a clean host, with the expected image and verifiable receipts |
| L12 Apps layout | Integrate reviewed PR317 and verify nested as well as document overflow on mobile |

Two implementation owners divide product/persistence and backend/auth/operations work. The reviewer starts reproductions and prepares the release-host matrix immediately. Security-sensitive fixes receive independent review. Expected work spans days 1–7, with some tail risk to day 9; this is the critical path more often than the remaining Track A changes.

### 3. Close the critical gaps in the current Apps preview

- [ ] Make older active automation definitions discoverable and pausable beyond the current newest-50 limit. Test mixed active/historical pages.
- [ ] Display expiry/blocked status, validity and meaningful failure reasons accurately. The UI must not imply an expired or stale schedule will execute.
- [ ] Show the resulting Run/receipt and explain current dead-letter handling. Preserve the existing no-blind-replay policy.
- [ ] Prove one real scheduled provider effect with exact identity through the production scanner, queue and worker, then verify the result and receipt.
- [ ] Prove duplicate scan/delivery, worker restart, revocation before dispatch and restoration cannot cause an unintended second effect.
- [ ] Verify bounded management/scan cost and tenant fairness at the documented preview load. Fix measured regressions; avoid speculative performance refactoring.
- [ ] Certify the final Apps-enabled image and its keyring/flag combination. Update certificate candidate pins deliberately after code changes.

Existing pause/disable/grant revoke/kill controls must be sufficient and tested. A new permanent per-definition revoke UI, one-click renewal, richer history and safe same-fire manual retry may follow after preview if their absence leaves a safe, explicit current operator path. If one is needed to prevent hidden live authority, it moves into the release scope.

This is a critical Track A closeout. It does not claim every enhancement from the full-platform plan is finished.

Estimate: 2–3 working days overlapping core stabilization. The end-to-end scheduled-effect test is required if automation is offered, even though the earlier immutable certificate passed.

### 4. Publish the smallest usable authoring and operator path

- [ ] Supply the exact App Kit tarball, checksums, matching examples and host compatibility requirements through a public release channel. npm publication is optional if the documented tarball flow is reliable.
- [ ] Provide one stable public authoring link, a tested bootstrap command sequence and the current guide. A simple static guide is sufficient; a new in-product builder is not required.
- [ ] Prove an author outside the monorepo can check/build/stage a supported App from those public artifacts. The operator reviews grants and activation.
- [ ] Correct the website's outdated pre-implementation language and install version references only when matching artifacts exist.
- [ ] Publish concise release notes, platform limits, required settings, supported upgrade/backup/restore instructions and an issue-reporting path.

Estimate: 1–2 working days overlapping fixes and candidate validation. The polished copy-prompt builder, broader tutorials and additional starter repositories can follow after release.

## Rigorous preview certification

The quality bar for the features shipped is the same as the full-platform route. This route saves time by excluding unbuilt feature planes and their tests; it does not skip the current product's safety or recovery checks.

| Layer | Required scenarios |
|---|---|
| Focused regressions | Every confirmed audit bug reproduced, then passing through the corrected code path |
| Core real-backend journeys | Fresh owner signup/login, no-AI workspace, invite/member access, chat/task/note persistence, file authorization, search/context and settings |
| Agent/MCP journeys | Supported real client setup; scoped read; reviewed write; result/receipt; token revoke; offline provider; current Hermes certification |
| Tenant and auth negatives | Two organizations; owner/admin/member/guest; cross-resource denial; revoked/expired sessions; malformed input; redirect limits |
| Apps and automation | Public package staging/review/activation, upgrade/disable, dependency loss, stale pins, actual scheduled effect and receipt, pause/revoke, budgets and duplicate/restart/restore |
| Browser behavior | Production-built Chromium desktop/mobile; critical auth/editor/Apps checks in Firefox/WebKit; 320px/390px widths; keyboard/screen-reader critical journeys |
| Installation and recovery | Exact published-file install, fresh volumes, latest published preview upgrade, supported baseline, full clean-target restore, interrupted upgrade and process death |
| Capacity and soak | Declared load on fixed hardware, queue recovery after outages, no unintended effects/leaks, 24–48-hour final-candidate soak |
| Source/artifact identity | Required typecheck/lint/build/API/DB/security checks at the exact source; image digest, package checksums, provenance/SBOM and source labels match |

Use deterministic clocks and fault hooks for boundary coverage, then real processes for the complete journeys. A mock provider is appropriate when it is a separate synthetic service exercising the real transport; mocking out the production queue/dispatch path is not equivalent.

The 24–48-hour soak uses a stable candidate. A substantive correctness/authorization/runtime fix starts a fresh affected stability window; wording-only documentation edits do not require rebuilding unrelated components. Record any distinction explicitly.

Set the supported load and measured acceptance limits before the final run. Reuse the full plan's day-one capacity baseline where appropriate; do not promise multi-replica SaaS availability or hardware-independent latency. Carry existing CI tests forward, but do not treat historical green runs as certification of changed code.

## Day-by-day release schedule

| Window | Product/Apps owner | Backend/operations owner | Reviewer / release work |
|---|---|---|---|
| Day 0–1 | Release baseline; reproduce persistence/login/media defects | Disposable host, install/upgrade/auth reproductions | Freeze scope, fixtures and acceptance ledger |
| Days 1–3 | Notes, retry, login, media and mobile fixes | Packaging, process supervision, upgrade recovery and auth fixes | Focused regressions; independent security review begins |
| Days 3–6 | Apps management corrections and public authoring path | Finish auth; real scheduled-effect/restart/restore proof | Real-backend journeys; supported-client and browser checks |
| Days 6–8 | Fix discovered issues; freeze candidate | Final install/upgrade/restore and failure injection | Capacity run; 24–48-hour soak starts when candidate stabilizes |
| Days 8–10 | Release documentation and final visual review | Artifact verification and release rehearsal | Final gate review; publish if every required gate passes |
| Days 11–12 | Reserved defect correction | Reserved recovery/security correction | Affected recertification; no automatic deadline override |

Some windows overlap and owner assignments can change. The 8–12-day range assumes most fixes converge within the overlapping windows; a new session model or recovery redesign can extend it. Re-estimate at the end of day 3 from actual results.

Before announcing broadly, give the frozen candidate to 3–5 independent testers on disposable installs, ideally including at least one person who did not build it. They follow published instructions only. This can overlap the soak; feedback affecting supported safety or ordinary usability blocks release.

## Exact release gate

Ship only when:

1. All L01–L12 outcomes above are satisfied or the unsupported conditional feature is demonstrably unavailable.
2. Every offered Apps/automation profile passes its complete proof; untested opt-ins are not advertised as supported.
3. No known in-scope data-loss, duplicate-effect, tenant/auth breach or unsafe recovery defect remains.
4. The release image and download assets pass installation and restore on a clean host; DB, files, keys and receipts remain consistent.
5. Required current checks, browser/accessibility journeys, independent boundary review and final-candidate soak pass with no hidden skips.
6. An independent tester can use the public instructions; the scope and limits match the released artifact.
7. A maintainer can disable affected features, diagnose failures, publish a reviewed hotfix and execute the rehearsed recovery procedure.

If the gate fails, delay the announcement or explicitly narrow the product. Do not compensate by publishing first and planning to repair known destructive behavior afterward.

## After preview: continue toward the full platform

### First 3–5 working days after release

Assign a release-duty owner and reviewer. Triage installation failures, lost/duplicated work, auth/permission failures and broken core workflows first. Ask testers for sanitized reproducible reports; do not require external telemetry or collect private workspace data by default. Reproduce and backport fixes with focused regressions.

Other capacity can finish small Track A/operator polish and the B isolation spike. After a severe launch incident, stop new risky feature work until the cause is understood and the affected release is fixed. Support should not become an excuse to keep appending unrelated features to the preview branch.

### Continue the existing platform plan

1. Complete any documented non-blocking Track A operator enhancements and seal their evidence.
2. Track B: isolation decision, immutable Experience Host/SDK and externally packaged Email Lite shell.
3. Track C: operator runtime, consumed Gate G private capability/resource work, one-way sync and compound Email Lite proof.
4. Track D: Public Gateway, Booking and the public-automation compound proof.
5. Final Gate G: close all applicable requirements, independently review boundaries, certify performance/compatibility/recovery, and publish the full-track preview.

Reassess proof-App priorities after the first user feedback, but preserve the trust boundaries and acceptance requirements. Changing a proof App is a recorded scope decision, not a reason to avoid a failed gate.

### Prevent the early release from derailing development

- Keep the released tag immutable and maintain a small hotfix branch. Use an integration branch for B/C/D.
- Apply a fix to the appropriate source branch, backport intentionally, and verify the resulting release; avoid independently rewriting the same fix twice.
- Preserve current protocol fixtures. New planes use additive versioned contracts and default-off rollout controls until certified.
- Once real users exist, migrations must account for their actual supported predecessor release. Certify upgrade from this new preview as well as any earlier supported floor.
- Every new feature release must retain the existing workspace and App regression suite. Demonstrating only the new feature is insufficient.
- Initially reserve about 20–25% of implementation capacity for support and backports. This is a scheduling assumption, not predicted incident volume; reduce it when evidence supports doing so.
- Reuse the test host, fixtures, public authoring path and release machinery built before preview. They are part of the long-term work, not throwaway launch effort.

Do not schedule monitoring or send external messages automatically from this plan. Assign explicit owners during execution; actual automation setup and publication remain deliberate actions.

## Route comparison

| Decision factor | Route 1: complete A/B/C/D/G before launch | Route 2: stabilize and launch current preview first |
|---|---|---|
| First public release | 6–8 working weeks expected | 8–12 working days expected |
| Aggressive first-release case | Approximately 4–5 weeks | 5–7 days with extra dedicated capacity and ready fixtures |
| Initial feature breadth | Custom experiences, runtime/sync, public ingress and compound proofs | Current workspace, declarative Apps and explicitly certified bounded connected/automation features |
| Required quality | Full gate for every shipped plane | Same gate for the smaller shipped surface |
| First real-user feedback | After platform expansion | Several weeks earlier |
| New architecture risk before first launch | B/C/D isolation, runtime, privacy and sync risks all on the critical path | Current defects and deployment readiness dominate |
| Estimated time to full A–D/G preview from start | 6–8 weeks expected | Approximately 7–10 weeks expected, including support and an extra release cycle |
| Work reuse | One main launch cycle | Most core fixes/tests are reused; additional release, migration and support work remains |
| Compatibility burden | Existing predecessors only until launch | Must preserve the newly released preview and actual installed user data while evolving the platform |
| Support interruption | Mostly internal until first release | Early user support consumes some feature capacity |
| Scope learning | More feature design happens before user evidence | User evidence can improve or redirect later proof priorities |
| Main failure mode | Broad scope delays launch or encourages weak certification | Premature launch with unresolved defects, or support work starving B/C/D |
| Best fit | First adopters require custom UI, synced private mail or public booking immediately | Users can benefit from today's workspace and bounded Apps while the platform grows |

The 7–10-week full-completion estimate for Route 2 is measured from the start, not seven to ten weeks after preview. As a planning model, roughly two weeks stabilize/release current functionality and another five to eight complete the remaining tracks, feedback work and final certification. Do not add the original full six-to-eight-week estimate mechanically after the first preview: its core stabilization, Track A and authoring work will already be done.

The estimated 1–2-week overhead relative to Route 1 comes from an extra public release cycle, supporting installed users, backports and another supported upgrade boundary. Actual support demand can increase or decrease it. Preview-first accelerates feedback and first delivery; it does not inherently accelerate completion of all remaining architecture.

## Decision

**Route 2 is selected and frozen.** Spend the next release window on correctness and recovery, ship the accepted bounded preview, then continue the platform expansion under the original track gates.

The comparison above is retained as decision context. Switching to full-platform-first would be a new owner scope decision, not an automatic consequence of discovering a preview defect.

The next execution step is the verified baseline, acceptance ledger and defect reproductions. Recording this freeze changed planning documents only; it did not change product source, start B/C/D, dispatch release workflows or publish anything.

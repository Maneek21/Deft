# Public presentation audit — 2026-09-07

Scope: read-only review of the live public repository [Maneek21/Deft](https://github.com/Maneek21/Deft) and linked product site. This is a marketing and trust-front-door audit, not a code review. Findings describe public GitHub state; they do not infer status from local or unshipped worktrees.

## Strengths

The [README](https://github.com/Maneek21/Deft/blob/master/README.md) gives visitors a concrete product thesis, six real product screenshots, a Docker quick start, architecture overview, AGPL-3.0-only terms, explicit alpha limitations, and links to self-hosting, contributing, security, and support. It clearly states that Deft works without an AI provider key and names important boundaries such as one workspace per deployment and no native Google/Slack/Gmail/GitHub OAuth promise.

The linked [walkthrough](https://deft.ing/walkthrough/) presents a specific seeded workflow across chat, knowledge, tasks, calendar, and agent approval. The [pricing page](https://deft.ing/pricing/) accurately says self-hosting is available now and hosted access is future work. [SECURITY.md](https://github.com/Maneek21/Deft/blob/master/SECURITY.md) provides private reporting channels, scope, disclosure expectations, and supported-version guidance; [SUPPORT.md](https://github.com/Maneek21/Deft/blob/master/SUPPORT.md) sets best-effort expectations and gives useful diagnostic requirements.

## Ranked findings

### 1. The recommended evaluation target is unclear (high)

The latest public release is [`v0.3.0-preview.14`](https://github.com/Maneek21/Deft/releases/tag/v0.3.0-preview.14), published August 31. GitHub reports **132 commits to `master` since this release**, while the README’s versioned image example still recommends `ghcr.io/maneek21/deft:0.3.0-preview.14`. Rapid development and a week-old release are normal. The problem is that an evaluator is not given a clear mapping between the release image, current source, and the documentation being presented.

Small remedy: publish a fresh preview or designate one tested commit/release as the evaluation target. Add a short source/image/docs compatibility table and tested SHA.

### 2. A current security failure needs a public resolution (high)

The latest scheduled [Security run](https://github.com/Maneek21/Deft/actions/runs/34111562499) failed on September 7. The failed job log identifies the moderate Tiptap advisory GHSA-cp6q-959q-f8rh, with the patched `@tiptap/core` 3.30.4 candidate still unshipped. Recent Dependabot CI/Security runs for [PR #318](https://github.com/Maneek21/Deft/pull/318) also fail, although the latest `master` CI and Security runs passed on September 2. Visitors see failure without that context.

Small remedy: merge or release the verified dependency fix, restore a green current-default-branch Security run, and keep any status badges scoped to the default branch. Adding badges is optional; resolving the failure is the substance.

### 3. Onboarding requirements disagree across public docs (high)

The README lists three required secrets for Docker. The live [quick-start docs](https://deft.ing/docs/quick-start/) additionally require a production `ENCRYPTION_KEY`, and say they were verified against `v0.3.0-preview.7`. The README says Node 22.13+, while [CONTRIBUTING.md](https://github.com/Maneek21/Deft/blob/master/CONTRIBUTING.md) says Node 20+ and pnpm 9+; the public package contract requires Node `>=22.13.0` and pnpm `11.10.0`.

Small remedy: make one canonical onboarding path, synchronize variables and tool versions, and label the exact release against which the commands were tested.

### 4. Preview release notes do not explain operational impact (medium)

The latest release contains one change item and a full-changelog link. It does not quickly state migration/upgrade requirements, tested deployment shape, image architecture, or known limitations. This is especially important because the README documents supported upgrade baselines.

Small remedy: curate each release with user-visible changes, upgrade/database notes, tested SHA/image, and a clear evaluation recommendation.

### 5. Known presentation gaps remain open (medium)

Public issues include [#176](https://github.com/Maneek21/Deft/issues/176) for an external MCP walkthrough, [#177](https://github.com/Maneek21/Deft/issues/177) for curated release notes, [#175](https://github.com/Maneek21/Deft/issues/175) for screenshot freshness checks, and [#172](https://github.com/Maneek21/Deft/issues/172) for Linux ARM64 preview images. Open issues are normal and do not themselves make a project look unfinished. These are useful cross-checks when reconciling public promises with what has shipped.

Small remedy: update each with current status and shipped evidence; close only when the stated requirement is actually met.

## Vision and communication alignment follow-up

The earlier consistency review adds a second priority: public promises must match the responsibility and availability boundaries, as well as the release version. Preserve the central positioning: a useful human workspace, a shared work record for agents, and applications that reuse that foundation.

### High: name the boundary of Deft's control

The [architecture page](https://deft.ing/architecture/) describes centralized company memory and daily employee controls. The [current native integration contract](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/integrations/hermes/deft-platform/README.md) assigns private memory, reasoning, runtime skills, execution budgets, and independently used external tools to the runtime/operator. Explain the compatible responsibilities: Deft owns shared workplace state, scoped Deft access, approvals and governed-action receipts; the external runtime owns its own execution. Scope spend-control and receipt claims to the paths they actually govern. Correct wording does not require adding orchestration or centralizing runtime memory.

### High: publish one capability and availability map

Use four states: released in a named version; opt-in/experimental; implemented but unreleased; planned. Include required flags and one matching setup link. Explain Apps as packages extending the workspace, Modules as declarative records and native views, and connected/custom experiences as separately bounded capabilities. The [Apps entrance](https://deft.ing/apps/) currently presents Modules; examples should match the supported contract. Internal vendor records and a public vendor portal have different identity and access requirements.

### High: make employee guidance release-specific

Reconcile the [public Agent Channel guide](https://deft.ing/docs/agent-channel/) with the native default documented for historical Hermes-capable releases, identifying the bridge as rollback guidance. For the proposed core preview, explicitly state that Hermes certification and its integration bundle are excluded. This is documentation work, not a request to restart Hermes testing.

### Medium: retire competing sources of truth

`FEATURES.md` still calls supported upgrades deferred; `ROADMAP.md` places existing release infrastructure in the next-preview bucket. Reconcile these with current operations and release docs. Mark `docs/AGENT-VISION.md` as historical where it retains paid employee seats and the older two-agent model, and point to the current contract. Keep useful history while making its authority unambiguous.

### Medium: provide three complete entry journeys

Offer a team-workspace journey, a supported AI-client connection, and a supported internal-App authoring journey. Each should identify the version, prerequisites, exact commands and observable result. Keep a complete source/tarball App Kit path until public package distribution is verified; a historical registry E404 is not a fresh registry check or proof that the kit itself is unusable.

### Reconcile old findings with the accepted candidate

The earlier review's Notes, retry and login failures concerned public master at `7355c90a`. They are already addressed by the accepted demo and reconstructed release candidate; do not reopen them or describe the candidate using those old failures. The public branch still needs the fixes landed. Broader Apps expansion remains a roadmap decision. No new product feature, Hermes runtime run or soak follows from this presentation review.

Combined order: clarify control boundaries and feature availability; make the three entry journeys and canonical docs agree; complete release/security gates and publish useful release notes; then apply minor README layout polish. The private vision documents remain outside the repository and are not copied here.

## Lower-priority presentation polish

The README puts the first setup command below six large visuals and several overlapping feature explanations. A small top-level "Try it" link and a short recommended-release/status block would make evaluation easier; a visual redesign is unnecessary. Review universal wording such as "Every action leaves a receipt" against the exact governed-action contract, and qualify it if readers could mistake it for a promise about every UI operation. This is a wording review, not evidence of a receipt bug.

A solo maintainer, a small star count, agent instruction files, and AI-assisted development are not defects. Do not add invented scale claims, hide alpha limitations, or bury honest issues to appear mature. The useful credibility signal is a reproducible install and maintained, accurate release guidance.

## Acceptance checklist

- README, hosted quick start, package engines, and release agree on Node/pnpm, secrets, commands, and version.
- A named release/image has a tested SHA, upgrade notes, and a current compatibility statement.
- Default-branch CI and Security are green; dependency-fix PRs are resolved or clearly explained.
- Release notes identify operational impact and supported deployment paths.
- Open presentation issues have current status or are closed with links to the replacement evidence.

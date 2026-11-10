# Apps Settings, foundation evidence and browser isolation exploration

Status: exploratory findings and recommended implementation sequence, 2026-09-09. No production behavior, workspace permissions, installations or public artifacts were changed. Source baseline: master `46da535e`; live Settings inspection: `demo.deft.ing`, whose deployed revision was not independently identified in this turn.

The user requested starting the foundation/isolation work and exploring confusing Apps/Modules Settings. This pass produced an interactive UX concept, an executed hostile-browser experiment, a packed App Kit artifact, and concrete follow-up acceptance criteria. It does not claim Track B implementation or foundation certification complete.

## What the live UI revealed

The Apps listing opens every connected installation into a long technical management form. Protocol versions, package formats, hashes, requested/effective authority, dependencies, connectors and Runs compete with the App's purpose and next action. The main buttons are developer operations: Pair Codex and Inspect package. A blocked installation shows a disabled dependency deep inside the form rather than leading with a recoverable setup problem.

Modules is a separate peer in Settings and repeats App-owned collections as if they were independent installations. Live inspection showed Enable and Update local manifest controls for Resource Campaigns and Resource Contacts. Current source's `module-service.ts:1810` rejects independent lifecycle mutations of App-owned Modules, and `updateModuleInstallation` calls that guard for enable/disable. We did not click a live mutation to manufacture an error. This is a visible control/static enforcement mismatch, not a reproduced production request failure.

Important distinction: Module agent access remains legitimate host-admin policy even for App-owned Modules (`module-service.ts:2444`). Hiding duplicate lifecycle controls must not remove that control or give its authority to the App author.

## Recommended product model

**One Settings → Apps management area.** Users manage installed tools there. Each App owns its included data collections and setup journey. Connections remain a separate shared administrative resource and are selected from App setup; do not duplicate connection credentials inside each App's settings.

| Option | Benefit | Cost / failure mode | Assessment |
|---|---|---|---|
| Keep Apps and Modules, collapse technical sections | Small cosmetic change | Duplicate ownership and installation vocabulary remain | Useful emergency improvement, insufficient end state |
| Unified Apps list with dedicated details and standalone-Module compatibility | One obvious management entry; existing backend authority remains | Requires a trustworthy ownership projection and route/state handling | Recommended |
| New App hub/catalog/runtime dashboard | Supports a larger ecosystem eventually | Adds new navigation and scope before current install/setup works well | Defer |

The proposed list shows name, purpose, derived status and one contextual action. Ready Apps get Open; staged Apps get Continue setup; disabled Apps get Manage; blocked Apps explain the dependency or connection problem. Details contain Overview, Access and Activity. Automations can become an additional section only for Apps that actually have them. Raw protocol and digest information remains available under Technical details and in the exact review record.

Translate internal language carefully:

- `staged` → Setup pending; the staging state remains unchanged in storage.
- Requested authority → What this App wants to access.
- Effective authority → Current access.
- Connector binding → Connection used by this App, with exact provider identity retained in review.
- Disabled → Off · data preserved, where that matches actual lifecycle behavior.

Add app leads to Install from a file or Build with an AI coding tool. Developer pairing belongs in the build path. Inspection → staging → exact host review → explicit activation remain distinct operations underneath a coherent setup flow. Never silently grant access or imply that uploading installs an active App. Source trust/provenance and material permissions must remain visible at the decision point, even when machine identifiers are collapsed.

App-owned Modules appear as included collections in the parent App. Existing standalone Modules remain visible, labeled as such, with their current update/access controls. No automatic conversion, data movement, identity rewrite or grant migration is proposed. Preserve old URLs as compatibility entry points. When the Apps feature flag is off, standalone Modules must remain reachable through the existing path.

## UX exploration evidence

A clickable sample-data concept covers list → blocked setup → dependency detail → access review, Add app, developer guidance and standalone Module management. It is rendered inline in the task. It makes no API calls and performs no actual installation or pairing.

Inspected in Chrome at a 1,024px desktop content width in dark and light appearances, and at a 360px child viewport. The setup and access interactions were exercised. This is layout/flow exploration, not a full accessibility certification. Keyboard focus restoration between concept views, all lifecycle states, fresh install, long names, large inventories, errors and permissions still need production acceptance tests. The optional design controls offer list/card presentation and row density; the core ownership model is unchanged.

## Browser isolation: first candidate fails the stated egress requirement

The local probe uses an iframe with `sandbox="allow-scripts"`, no allow-same-origin, a response-header CSP with `default-src 'none'`, `connect-src 'none'`, `img-src 'none'`, `form-action 'none'`, `frame-src 'none'`, a nonce-authorized fixture script, restrictive Permissions Policy and a MessageChannel for reporting. Only synthetic localhost markers are used. No Deft login, records or real credentials enter the fixture.

Observed Chrome result:

| Probe | Result |
|---|---|
| Read parent DOM | Blocked |
| Read document cookie API | Blocked |
| Read local storage | Blocked |
| Create popup | Blocked |
| Fetch local sink | Blocked |
| Navigate the frame itself to a local sink | **Allowed; server received the synthetic marker** |

The test demonstrates a navigation request despite blocked fetch. The destination was local; this pass did not test arbitrary internet destinations. It is enough to reject the blanket claim that this mechanism prevents all browser egress. It does not establish a deployed Deft vulnerability: executable App UI is not shipped by the inspected contracts.

Reproduce with `node docs/superpowers/experiments/2026-09-09-app-experience-isolation.mjs`, open `http://127.0.0.1:4187`, and click Run isolated probe. The server binds localhost only. Stop it after the test. This is a disposable spike, not an SDK or production host. Restart the server between samples because its observation ledger is in memory and cumulative.

The installed Next.js CSP guide was consulted before proposing framework integration. Its nonce/dynamic-rendering guidance applies to a Next host; it does not prove a custom App's isolation. Browser references: [iframe sandbox semantics](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe), [CSP directives](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy).

| Next option | What it buys | Tradeoff / evidence needed |
|---|---|---|
| Opaque-origin iframe plus CSP | Simple deployment; observed DOM/storage isolation | Fails this no-egress candidate; cannot approve unchanged |
| Dedicated cookieless App origin plus sandbox | Separates asset/session origins and may improve packaging | Origin separation alone does not resolve self-navigation; TLS/DNS/operator cost; still requires egress proof |
| Worker execution with host-rendered structured UI | Removes the App's direct DOM/navigation surface | Different authoring model; not arbitrary HTML UI; network/worker restrictions and useful UI expressiveness must be proven |

Recommendation: preserve the declared no-egress requirement for now and investigate the worker/host-rendered boundary as a candidate, while evaluating whether an actually enforceable iframe mechanism exists on supported browsers. If arbitrary HTML UI requires a reviewed change to the egress promise, record that product/security decision explicitly before allowing workspace data into the frame. Do not silently reinterpret the current plan. Remote rendering would be another architecture with substantial operational cost and is outside this first exploration.

Still untested: per-version assets, integrity, sibling Apps, cross-browser behavior, service workers, downloads, top navigation, DOM-based hostile content, frame reload/replacement, MessageChannel replay/identity, live grant revocation and production reverse-proxy headers. This five-block/one-escape sample is an early rejection test, not certification.

## Foundation work made concrete

### Author distribution

Packed App Kit `0.1.0-alpha.2` from the audited snapshot into:

`tmp/apps-exploration-2026-09-09/artifacts/deft-app-kit-0.1.0-alpha.2.tgz`

SHA-256: `1d249b6e02dd6d21099f6856633f2fb69caf1907fb388dff7509ad84f3773465`.

The separate packed-external test passed: Contacts, connected Campaigns and scheduled Campaigns build outside the repository using the installed tarball, with deterministic outputs and no private Deft imports. The first invocation failed before exercising the kit because pnpm exec did not supply the harness's required `npm_execpath`; rerunning with the installed pnpm CLI path supplied passed. No product patch was required.

This proves offline packed consumption with cached dependencies, not an independent newcomer's internet bootstrap. Publication remains undone. Next distribution patch should attach the exact kit plus checksum/version compatibility metadata to a public release and update a short bootstrap guide. Prefer this before a registry or marketplace project. Do not overwrite an already distributed artifact with different bytes under an ambiguous version.

### Current-candidate boundary gate

The 12 skips identified in the preceding audit still come from the inspected release log. Phase4 resource-owner/relation/composition cases require a phase4 test database name; phase5 AppAction and App-origin ancestry/lifecycle cases require phase5-compatible names; flag-on Run cases need their intended profile. Simply setting the Apps UI flag is insufficient.

The smallest follow-up is a dedicated candidate job with explicit disposable DB/flag profiles, reusing the existing fixtures. Validate zero mandatory skips and the presence of each required case, rather than accepting exit code zero alone. Run against an input candidate SHA/image digest; leave historical immutable certificates intact. Add an assertion that a shared-kernel change cannot bypass this job. Do not weaken test database protections just to remove SKIP text.

### Worker restart and restore acceptance

Use the existing sandbox provider with a durable external-effect ledger. Preserve that ledger across Deft DB restore so duplicates remain observable. Interrupt at: before dispatch, after provider effect before acknowledgement, and after receipt commit. Each case needs a defined safe-retry or unknown-outcome result. Restore DB plus real test keyrings into a fresh process, inspect existing receipts, then advance a newly due definition through scanner → queue → worker → provider → receipt. Assert one expected effect per safe case, no silent retry after ambiguity, and revocation denial between Run creation and dispatch.

Docker was unavailable in the earlier local audit; this pass did not start a disposable DB or certify restart/restore. Keep these rows open until actual process-boundary evidence exists.

## Smallest implementation sequence

1. UX patch: unify inventory presentation, truthful ownership/blocked states, detail/setup routes and compatibility entry points. Preserve backend semantics. Acceptance: no App-owned lifecycle dead ends, independent agent-access controls preserved, no hidden active installations, stale-review rejection, desktop/mobile/keyboard proof.
2. Foundation patch: mandatory current-candidate conformance profiles and exact kit distribution metadata/guide. Attach executed cases, not historical phase labels.
3. Isolation spike continuation: resolve the egress failure before freezing experience artifacts or bridge contracts. No production Email Lite custom shell until this decision has adequate evidence.
4. Track B implementation: use the approved boundary and a small Email Lite shell proof. Do not bundle runtime or sync authority into this change.

The Settings improvement can deliver user value while the isolation decision remains open. That parallelism avoids making the product's basic management experience wait for the hardest new security boundary.

# App Platform first implementation loops

**Status:** complete; Loops 0–6 implemented and certified on 2026-08-29

**Parent plan:** `docs/superpowers/plans/2026-08-29-full-surface-app-platform.md`

**Scope:** the opening vertical slice only: Phase 0 decisions plus the minimal declarative App milestone

**North-star for these loops:** a clean external project can build and locally install a deterministic, non-executable Hello Workspace App without editing Deft core

## Progress

- **Loop 0:** completed on 2026-08-29. The baseline, foundation/dual-deployment boundary, App capability review policy, declarative authoring license boundary, and supersession relationships are recorded.
- **Loop 1:** completed on 2026-08-29. The declarative App v0 threat model and Module perimeter regression test are present; focused shared, CLI, API upload, and web Module tests plus the repository typecheck are green. No production or database code changed, so database-backed integration was not used as evidence; it remains mandatory if a later loop changes Module service, schema, migration, or persistence behavior.
- **Loop 2:** completed on 2026-08-29. The publishable `@deft/app-kit` owns the strict App Protocol v0 schema, canonicalization, digesting, deterministic indexed JSON package format, limits, generated JSON Schema, CLI build primitives, and hostile-package tests. A packed artifact was installed and exercised from a clean external project without private workspace imports.
- **Loop 3:** completed on 2026-08-29. Additive App installation/version/binding/developer-pairing persistence, immutable workspace-local lineage authority, transaction-composable Module installation, atomic activation, post-commit invalidation, and app-owned Module lifecycle guards are implemented. Schema/upgrade parity and focused disposable-Postgres transaction tests are green. The full `db:push-full` bootstrap could not be certified on this machine because its PostgreSQL installation does not provide the required `vector` extension; the App migration itself was applied and exercised against a disposable database.
- **Loop 4:** completed on 2026-08-29. Disabled-by-default App API routes cover inspect, stage, activate, list/get/navigation, and disable with bounded input, zero-rights staging, live owner/admin checks, structured errors, audit state, and no future-plane parsing or authority.
- **Loop 5:** completed on 2026-08-29. `deft app init`, `check`, `build`, `doctor`, and `install-local` work through the public kit. One-time developer pairing is expiring, revocable, audience-bound, single-install, disabled by default, and stores only hashes. The clean external CLI installed the reference App against a real local API; replay was rejected.
- **Loop 6:** completed on 2026-08-29. Settings -> Apps, review/stage/activate/disable controls, exact Module and provenance review, active-only host-rendered navigation, realtime invalidation, and the independent Hello Workspace reference App are present. The UI was inspected at desktop and 390x844 mobile sizes, and the focused tests, lint, repository typecheck, and production build are green.

Phase 1 intentionally emits a strict bounded indexed JSON package envelope. Archive and multipart formats remain deferred until they can reuse the same path, MIME, count, size, and integrity rules plus archive-specific traversal and decompression defenses.

## Why these loops come first

The first implementation should prove an installed **App** product unit without also introducing capabilities, secrets, custom UI, runtimes, synchronization, automation, public ingress, billing, or managed hosting.

Three sequencing choices are possible:

1. **Implement all platform abstractions first.** This delays user proof and freezes speculative interfaces. Reject.
2. **Start from an App manifest and database tables.** This is fast initially but risks encoding unresolved lifecycle, lineage, approval, and isolation decisions into migrations. Reject.
3. **Close the irreversible decisions, then build one narrow end-to-end App loop.** This is the smallest adequate option. Use this plan.

Every loop must begin from a green baseline, have one primary architectural purpose, and end with reviewable evidence. A loop may contain several commits, but it must not depend on half-finished work from a later loop.

## Fixed outcome and invariants

At the end of these loops, Deft supports only a **declarative App v0**:

- an App is the installed user-facing unit;
- a Module remains a closed declarative resource primitive;
- App v0 may include exact immutable Module manifests and declarative navigation;
- App v0 contains no executable code, provider call, capability, connector, secret, custom experience, runtime, schedule, synchronization, public route, or self-granted permission;
- inspection and staging grant zero rights and expose no navigation;
- activation is one transaction across App and included Module pointers;
- disabling the App immediately removes its navigation and access while preserving its data;
- self-hosting works without a Deft cloud account, hosted registry, entitlement check, or call home;
- the future SaaS deployment uses the same App package and workspace data-plane contract;
- a commercial Add-on remains a catalog/entitlement offer outside the App permission model.

The first slice does not prove connected or full-surface Apps. It proves that later planes have a stable installation and authoring unit to attach to.

## Baseline condition before Loop 0

Implementation must start from an explicit clean worktree or reviewed branch based on the then-current `origin/master`. At planning time, local `HEAD` is two commits behind `origin/master`, and the workspace contains unrelated modified and untracked files. Do not implement these loops by mixing changes into that state without first preserving the existing work and recording the chosen baseline commit.

Loop 0 documentation was reconciled in the existing workspace without touching unrelated changes. Loop 1 is the first code-changing loop and must begin from a clean worktree at the recorded baseline or a reviewed newer `origin/master` commit.

The current relevant seams are:

- `packages/shared/src/modules.ts`: strict Module schema, canonicalization, digesting, and JSON Schema generation;
- `scripts/modules-cli.ts`: existing local Module authoring and deterministic distribution patterns;
- `packages/db/src/schema.ts`: tenant-scoped immutable Module installation/version model;
- `apps/api/src/lib/module-service.ts`: Module install, upgrade, enable/disable, authorization, locking, and audit behavior;
- `apps/api/src/routes/modules.ts`: bounded Module lifecycle HTTP routes;
- `apps/web/src/app/(app)/settings/modules/page.tsx`: existing admin lifecycle UX;
- `apps/web/src/lib/feature-flags.ts`: currently only a small web-only flag seam, not yet a cross-process platform flag system.

## Loop 0: Rebaseline and close the foundation decisions

### Purpose

Remove ambiguity before schema or public package work begins.

### Work

- Record the exact implementation baseline commit and supported database upgrade floor.
- Reconcile the full-surface plan with current post-Hermes code and mark conflicting older Module-expansion prose as superseded; preserve useful Module details as subordinate resource-platform work.
- Record one foundation decision covering:
  - App, App package, App lineage, App installation, Module, Resource, Capability, Experience, Runtime, Connector, Add-on, and entitlement terminology;
  - self-hosted and SaaS use of the same workspace data-plane and App Protocol;
  - Add-on entitlement as commercial availability only, never authorization;
  - effective rights as actor authority intersected with App grants and live deployment/operator policy;
  - distinct human, employee, automation, runtime, developer, and public principals;
  - zero-rights staging and owner/admin activation;
  - local unsigned lineage versus later signed portable publisher lineage.
- Resolve the approval contract vocabulary now, without implementing capability execution:
  - Deft owns risk classification and minimum approval floors;
  - manifests may request behavior but cannot lower risk or self-approve;
  - retries and idempotency are capability/provider facts, not author assertions;
  - automation eligibility and review scope are explicit closed contracts.
- Publish the initial licensing policy before distributing an authoring kit:
  - Deft core remains AGPL-3.0-only;
  - decide the license for the public App kit and generated templates;
  - state that self-hosted authoring and local installation require no hosted entitlement;
  - state the policy for community Apps and official paid Add-ons;
  - obtain legal review before assuming separately hosted or bundled proprietary Add-ons are outside AGPL obligations.
- Reserve names for future plane flags in the decision, but do not add unused flag code yet.

### Exclusions

- No database migration.
- No runtime code.
- No manifest implementation.
- No marketplace, account, billing, or SaaS control-plane implementation.

### Exit evidence

- The parent plan, decisions, self-hosting contract, and terminology do not contradict one another.
- The implementation baseline and rollback floor are explicit.
- The App kit can be licensed and published without an unresolved contributor-policy question.
- Reviewers can answer who authorizes, who pays, who executes, and who owns data without consulting future implementation details.

## Loop 1: Freeze the Module perimeter and App v0 threat boundary

### Purpose

Prove that the existing Module contract stays declarative and that App v0 cannot smuggle in any later execution or authority plane.

### Work

- Add table-driven negative tests around Module schema `1` for executable or authority-bearing keys, including nested and confusable forms:
  - scripts, entrypoints, endpoints, workers, SQL, secrets, permissions, capabilities, OAuth, runtime, network destinations, webhooks, schedules, public routes, custom UI URLs, and self-granted scopes;
  - unknown keys continue to fail because manifests are strict objects;
  - existing valid manifests, canonical bytes, digests, CLI output, and runtime behavior remain unchanged.
- Record the App v0 threat model and carry its hostile package fixtures into Loop 2, where the authoritative parser exists.
- Defer the browser-isolation spike until the entry gate for the custom Experience Host. App v0 rejects custom-experience fields, so an iframe decision cannot affect this milestone's public wire contract.
- Add only the first real platform flag when the first App route is introduced in a later loop. Do not create a generic registry full of unused flags in this loop.

### Exclusions

- No custom Experience Host, browser spike, App SDK, iframe bridge, or CSP change.

### Exit evidence

- The Module contract, CLI, raw-upload, web-preview, and repository typecheck surfaces remain byte- and behavior-compatible; any production Module service/schema change additionally requires the database-backed integration battery.
- Forbidden-key tests prove Module schema `1` cannot become an executable plugin format.
- The App v0 threat model assigns every executable, authority-bearing, and future-plane field to a Loop 2 parser fixture before persistence work begins.
- No reachable production route or feature is added.

## Loop 2: Build the pure App package contract

### Purpose

Create a deterministic, host-independent App v0 format before persistence or HTTP behavior can distort it.

### Design

Use one deep, publishable package for the v0 contract and CLI-facing build primitives. A suggested boundary is `@deft/app-kit`. Split browser and runtime SDKs later only when their dependencies and trust boundaries genuinely differ.

The API and CLI must consume the same parser, canonicalizer, digest function, limits, and generated JSON Schema. Do not duplicate a browser preview parser or maintain handwritten TypeScript types beside Zod contracts.

### App v0 contents

- strict schema version and App Protocol compatibility;
- reverse-DNS App identity, semantic version, display metadata, declared license, and provenance fields;
- exact included App-owned Module artifacts with canonical path, MIME type, length, and digest;
- closed declarative navigation referencing only included Module collections/views;
- a deterministic package index and whole-package digest;
- no generalized resource grants or future-plane blocks.

The parser rejects unknown fields rather than retaining them optimistically. Paths are normalized, relative, non-confusable, case-collision-safe, and cannot traverse, use symlinks, or shadow reserved host names. Package count, per-file, total-size, path-length, MIME, and decompression limits are explicit.

### Work

- Add the publishable package, exports, package scripts, and focused tests.
- Implement strict parsing, semantic validation, canonicalization, digesting, and JSON Schema generation.
- Implement deterministic bounded package construction from in-memory/file inputs without running package scripts or installing App dependencies.
- Add hostile fixtures for traversal, symlinks, duplicate/case-colliding paths, duplicate identity, changed bytes without version change, oversized entries, malformed JSON, unknown future blocks, and digest mismatch.
- Add a minimal valid Hello Workspace source fixture, but do not persist or install it yet.

### Exit evidence

- Building the same source twice produces byte-identical package output and the same digest.
- Changing any indexed byte changes the package digest.
- API-side inspection and CLI `check` use the same public contract package.
- A clean temporary project can consume a packed artifact of the kit without importing private monorepo paths.
- No database, API route, UI route, network call, or permission is introduced.

## Loop 3: Add persistence and a transaction-composable Module lifecycle

### Purpose

Make App staging and activation durable without creating partial App/Module states.

### Minimal data model

Add only the structures needed by App v0:

- immutable App installation identity and workspace-local lineage;
- immutable App versions with manifest, protocol version, digest, provenance, and lifecycle timestamps;
- exact v0 artifact metadata/content appropriate to bounded JSON-only packages;
- exact App-version-to-Module-installation/version bindings with ownership;
- one active App version pointer and an installation authorization/lifecycle epoch;
- actor/audit metadata and explicit staged, active, disabled, and failed states.

Do not introduce capability grants, connector bindings, runtime bindings, automation, sync cursors, public endpoints, entitlements, prices, plans, marketplace records, or generic blob storage in this migration.

### Transaction boundary

Refactor Module lifecycle internals so the caller may supply the existing database transaction and receive post-commit effects separately. Preserve the current public Module service wrappers and behavior.

The App service must be able to:

1. lock App and Module identities in deterministic order;
2. validate current owner/admin membership inside the transaction;
3. prepare or install exact included Module versions;
4. switch all Module and App active pointers once;
5. write audit state;
6. commit;
7. emit cache/realtime invalidations only after commit.

No nested independently committed Module transaction is allowed inside App activation.

### Work

- Add additive schema and supported upgrade migration.
- Add fresh-schema and release-upgrade parity assertions.
- Extract transaction-aware Module lifecycle internals without changing existing callers.
- Add App repository/service persistence primitives behind no public route.
- Add deterministic identity locks and uniqueness constraints scoped by organization.
- Add failure injection after Module preparation and before App pointer activation.

### Exit evidence

- Existing Module lifecycle, hardening, sideload, relation/view upgrade, and tenant tests remain green.
- Fresh `db:push-full` and supported `db:upgrade` reach equivalent schema using disposable databases.
- Failure injection commits neither the App pointer nor the Module pointer.
- A duplicate App identity, lineage collision, cross-org binding, or active-version ambiguity fails at both service and database boundaries.
- The previous supported image can still run until the additive migration's documented rollback floor; no destructive downgrade is claimed.

## Loop 4: Expose the zero-rights App lifecycle API

### Purpose

Create a complete control-plane lifecycle while still exposing no connected authority.

### Operations

- `inspect`: validate and preview package, provenance, compatibility, included Modules, and navigation without persistence;
- `stage`: create immutable installation/version state with zero effective rights and no navigation;
- `activate`: owner/admin-confirmed atomic App and Module activation;
- `list/get`: show installations, versions, provenance, health, lifecycle state, and digest through safe projections;
- `disable`: advance the lifecycle epoch, remove navigation/access immediately, preserve records and audit history;
- `delete/uninstall`: remain out of v0 unless retention/export semantics are fully specified; disabling is sufficient for the first slice.

### Work

- Add a small `AppError` family following existing structured error shapes.
- Add bounded package upload/inspection and lifecycle routes.
- Recheck live organization membership and owner/admin role in every mutation transaction.
- Add an `Apps` platform flag disabled by default in API and web; when disabled, routes and navigation remain unavailable without parsing or staging packages.
- Add append-only audit events and post-commit cache/realtime invalidation.
- Reject capability, custom-experience, runtime, sync, automation, public, secret, connector, grant, and entitlement blocks.
- Ensure old broad OAuth/MCP tokens do not discover or operate Apps; App MCP operations are not part of this loop.

### Exit evidence

- Inspection writes nothing; staging grants nothing and creates no navigation.
- Only a live owner/admin can stage, activate, or disable.
- Cross-org IDs, stale digests, replayed activation, incompatible protocol versions, and malformed packages fail closed.
- Disabling is immediate for new requests and preserves App-owned Module records.
- With the flag absent or false, existing Deft and Module behavior is unchanged.

## Loop 5: Deliver the external authoring and local-install loop

### Purpose

Prove Codex can author outside the monorepo using only published artifacts and documented commands.

### Commands

The first kit exposes:

```text
deft app init --template declarative
deft app check
deft app build
deft app install-local
deft app doctor
```

`init` creates `APP_BRIEF.md`, App-specific `AGENTS.md`, a strict manifest, an included Module, and test fixtures. Generated guidance forbids Deft-core edits, secrets, undeclared egress, self-granting permissions, and future-plane blocks.

`install-local` uses an owner/admin-created, one-time, short-lived developer pairing exchange. The developer principal has a distinct audience and cannot authenticate as a shell user, MCP token, employee, runtime, or ordinary API session. Credentials are never written into App source, lock files, shell history by the tool, or package output. Production pairing is disabled by default.

### Work

- Implement the commands on the same contract/build functions from Loop 2.
- Add deterministic lock output and permission/trust review showing that App v0 requests no connected authority.
- Add pairing create/exchange/revoke operations, strict expiry, single use, audience binding, rate limits, and audit.
- Add a host compatibility `doctor` check that does not leak server configuration.
- Test from a clean temporary external project using packed version-matched artifacts.
- Publish version and compatibility metadata; do not rely on private workspace package imports.

### Exit evidence

- A fresh directory can initialize, check, build twice identically, pair, inspect, stage, and activate Hello Workspace.
- A captured/replayed/expired/wrong-audience pair code fails.
- Pairing cannot enumerate unrelated Apps or call existing MCP, agent, Module mutation, or shell-user endpoints.
- App source and built artifacts contain no credential.
- Self-hosted installation works with access to Deft-hosted infrastructure blocked.

## Loop 6: Ship Hello Workspace and certify the vertical slice

### Purpose

Turn the backend lifecycle into an understandable workspace experience and prove the slice under failure.

### Work

- Add Settings -> Apps, separate from Settings -> Modules.
- Show inspect/stage review, source/provenance, exact included Modules, digest, compatibility, lifecycle state, and the truthful “no connected permissions” posture.
- Add owner/admin activate and disable controls with clear data-preservation copy.
- Merge navigation only from the active App version and only through closed, host-rendered Module targets.
- Ship Hello Workspace as an independently structured reference App using only the public kit.
- Add accessibility, keyboard, loading, error, empty, responsive desktop/mobile, stale-state, and realtime invalidation behavior.
- Read the installed Next.js documentation relevant to every route/rendering decision before frontend code is written.
- Run the consolidated certification and inspect the final diff and untracked files.

### Certification matrix

| Property | Required proof |
|---|---|
| Determinism | two clean builds are byte-identical and share a digest |
| Zero-rights staging | staged App has no nav, resource access, MCP discovery, job, connector, or token authority |
| Atomic activation | injected failure leaves both App and Module active pointers unchanged |
| Tenant isolation | cross-org IDs and artifacts cannot resolve, bind, activate, or disclose metadata |
| Lineage | a different unsigned lineage cannot replace an existing installation or inherit data/bindings |
| Disable/revocation | nav and access disappear immediately; stale lifecycle epoch fails; records remain |
| Compatibility | existing Modules and ordinary Deft behavior remain unchanged with Apps disabled |
| Self-hosting | install and operation require no registry, entitlement, telemetry, or hosted control plane |
| SaaS portability | the identical package is acceptable to the workspace data plane; commercial entitlement is not embedded in it |
| UI | owner/admin flow inspected at representative desktop and mobile sizes |

### Focused validation

Run focused checks during each loop and a consolidated pass here. Use only a disposable test database for database-writing tests.

```text
pnpm --filter @deft/app-kit test
pnpm --filter @deft/app-kit typecheck
pnpm --filter @deft/shared test
pnpm module:test
pnpm --filter @deft/api test -- <focused App and Module test files>
pnpm db:assert-fresh
pnpm test:upgrade
pnpm --filter @deft/web lint
pnpm --filter @deft/web typecheck
pnpm typecheck
pnpm build
pnpm selfhost:doctor
pnpm selfhost:smoke
```

The exact App test filenames are chosen during implementation, but tests must cross the same public service/API/kit interfaces used by callers. Do not certify by testing private tables directly while bypassing the lifecycle service.

### Exit evidence

- The final user loop works from a clean external project with Apps initially disabled and explicitly enabled by the operator.
- The certification matrix passes with fresh evidence.
- Desktop and mobile rendered behavior is inspected, not inferred from a build.
- The final diff contains no capability, secret, runtime, automation, synchronization, public-ingress, billing, entitlement, marketplace, or arbitrary-code path.
- The parent plan can now advance to Capability Service extraction without revisiting App identity, package digest, installation lineage, or transactional activation.

## Loop discipline and stop conditions

Stop a loop and reopen the architecture decision if any of these occurs:

- App activation cannot compose Module changes in one transaction without changing existing Module behavior;
- the public kit needs private database/API types to validate a package;
- a future-plane field must be persisted before its host plane exists;
- staging needs a permission, connector, background worker, or executable hook;
- self-hosted installation depends on a hosted Deft service;
- entitlement or payment status is proposed as a workspace authorization input;
- browser isolation requires weakening CSP or exposing Deft cookies/tokens;
- rollback would require destructive schema downgrade or reinterpret existing Module data;
- a loop cannot be reviewed or reverted independently from unfinished later-loop work.

## What follows, but not in these loops

After this vertical slice is certified, the next implementation loop is the behavior-preserving Capability Service extraction. Governed App Runs and Secret Service follow, then Resource Service/privacy, connected grants and bindings, and the connected CRM/Marketing proof. Automation, custom experiences, runtimes, synchronization, and public ingress remain later independently revocable gates.

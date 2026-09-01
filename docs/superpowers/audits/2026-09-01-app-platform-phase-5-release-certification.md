# App Platform Phase 5 — local release certification

- Date: 2026-09-01
- Candidate branch: `codex/app-platform-phase5-cutover`
- Phase 4 immutable baseline: `ec79592e669bdf915fad8a5d2480f0625d819a4c`
- Merged candidate: `161ca65fcb79cdb76fee315b2ba9974ff145a47e` (`#280`)
- Status: **local candidate and exact-merge CI passed; immutable non-publishing release-host gate pending**

## Certified local claim

The candidate proves one Protocol v1 connected Campaigns App can consume a
live-authorized Contact, obtain one exact reviewed sandbox-email binding, and
create a governed App-origin Run through human UI, Defty, employee, and human
MCP adapters. All four adapters enter the same AppActionService, capability,
approval, Run, receipt, and result path. Surface and token authority are part of
the replay identity, so equivalent raw keys cannot collide across principals or
authorization surfaces.

This is not the final Phase 5 release certificate. That certificate requires an
immutable merged commit and exact production image on a release-capable host.

## Candidate changes covered

- The private connected-interface registry is closed, code-owned, and contains
  its provider binding, policy floor, input bindings, and permitted field types.
- App staging remains non-executable; explicit review creates exact immutable
  grant and binding ancestry.
- App-origin Runs recheck live App, version, dependency, grant, relation,
  connector, provider schema, actor, employee, membership, token, and budget
  authority at the effect boundaries.
- Developer install refuses Protocol v1 before consuming a pairing session, and
  the CLI refuses it before requesting or exchanging a pairing code.
- Uninstall refuses current dependents and otherwise requires an explicit data
  retention decision; it never silently cascades.
- Contacts v0, Campaigns v0, and connected Campaigns v1 are exact checked source
  proofs built by the public App Kit CLI.
- App-origin intake remains disabled by default. The Apps-enabled production
  candidate exists only in CI; the official release default stays off until the
  Phase 6 beta gate.
- Rollback now closes both App-origin and legacy MCP intake before stopping the
  shared Run engine.

## Local evidence

The consolidated non-API matrix passed:

- App Kit: 16/16.
- Shared contracts: 63/63.
- Supported upgrade and self-host upgrade contract: 30/30.
- Relevant web contract tests: 32/32.
- Release workflow contract: 10/10.
- Module provenance verification: 1 checked vendored Module.
- Web lint: passed.
- Repository typecheck: passed across App Kit, shared, API, and web.
- Single final Apps-enabled production build: passed; `/settings/apps` was
  included in the optimized Next.js route output.

The focused API matrix ran on PostgreSQL 16 using a clean disposable database
whose schema was cloned from the already-upgraded retained Phase 5 database.
This avoided both a new infrastructure bootstrap and any retry of unavailable
local pgvector. Its consolidated pass recorded 221 passing tests and six
intentional legacy-mode skips. Three test-isolation collisions were then closed
with direct evidence:

- The pairing fixture received its own unique email and passed 2/2.
- The rollout transition ran alone against a clean schema, as required by its
  key-inventory invariant, and passed 1/1.
- The updated requested-grant digest passed 5/5 after the registry contract was
  frozen.

Together, the focused API evidence covers connected contracts, install/review,
AppActionService and native adapters, App-origin cutover, existing App Run
safety, capability parity, Phase 4 resource compatibility, connector/trust/scope
boundaries, approval routing, exact proof packages, upgrade/rollback, and
operator rollout transitions.

All Loop 7 certification databases were removed after the pass. The previously
retained `deft_phase5_loop4_20260831` database remains online and untouched for
the existing handoff.

The exact proof package digests are:

- Contacts v0: `sha256:1471f0b94da9f6851bd978c315bc22a2dd0343b61a87477e4293b144c54248d8`
- Campaigns predecessor v0: `sha256:0f478f5a761590f1f5874c7a0d0dc3382436b5e7f44c0c6ad6591cd577476344`
- Connected Campaigns v1: `sha256:973ec7076daf7405a7a4d8b48509ef6f99b1b1cc4b787961104c73f23b7f770d`
- Connected Module v2: `sha256:5dc2a978506eb2917a3a99021831d62d94112a60615292e4b32e03e480cff208`

## Non-gating diagnostics

A broad monolithic API run against the retained Loop 4 database was rejected as
certification evidence: retained fixed IDs caused state collisions and the
database name intentionally failed older Phase 2/3-only reset guards. A second
clean diagnostic run confirmed the Phase 5 action, lifecycle, capability, and
upgrade lanes, while also reproducing pre-existing order-sensitive Hermes tests
outside this phase. It was stopped once continuing no longer added relevant
evidence. No Phase 5 requirement is being inferred from those unrelated tests.

## Local limitations

- Local PostgreSQL has no pgvector installation. `CREATE EXTENSION vector` was
  not retried; the real extension remains a release-host requirement.
- Docker Desktop is installed, but its engine is unavailable through the local
  Docker inference socket. Docker image construction was not retried.
- PR C is merged and its exact merge commit passed CI and security. That CI
  image was ephemeral, so it does not provide the durable image digest,
  matched recovery set, predecessor read, or restored-key continuity required
  by this gate.

## Immutable release-host gate

Run the manual, read-only
`.github/workflows/app-platform-phase5-certification.yml` lane. It checks out
the exact merged Phase 5 commit independently of the later certifier commit,
publishes nothing, and certifies:

1. Record the immutable commit and candidate image digest.
2. Create a fresh pgvector-backed schema and run the supported upgrade from the
   immutable Phase 4 baseline.
3. Back up and restore the database and purpose-separated App Run key material.
4. Build/run the Apps-enabled production image and perform authenticated
   desktop/mobile browser smoke through `/settings/apps` and the connected proof.
5. Read the upgraded data with the supported predecessor image, restore the
   candidate, and prove the accepted Run/receipt remains coherent.
6. Archive the exact evidence and remove release-host disposable resources.

The workflow may update this audit to PASS only after its immutable GitHub run,
safe evidence artifact, candidate archive digest, browser evidence, and cleanup
result are inspected. Adding the workflow does not itself satisfy the gate.

Known Phase 4 release assets for that pass:

- Candidate image: `deft-phase4@sha256:cc985cca14ed6f3429ce0e3d923ec095707d7aec871c0c8164cb3e3748c60771`
- Database dump SHA-256: `004ae7624267be863e5f7a27dfe8e479076404da2b33d50fabec6963754e70bd`
- Supported predecessor image: `ghcr.io/maneek21/deft@sha256:e565cc64ee22b5b9f6f99973e3762b639c27e026dc8824852145035acdacf788`

Until this gate passes, Phase 5 remains locally certified but not complete.

## Phase 6 handoff

Phase 6 should begin only from the merged Phase 5 contracts:

1. Extend the public authoring kit, types, CLI, lock format, doctor guidance,
   host simulator, and fake provider only for the proven Phase 4–5 contracts.
2. Build Contacts and Campaigns from clean external directories with packed,
   version-matched artifacts and no monorepo-private imports.
3. Exercise the entire native stage/review/bind/activate/search/relate/invoke/
   approve/receipt/upgrade/disable/re-enable workflow.
4. Re-run adversarial and four-surface parity proof from the external-author
   boundary.
5. Conduct a clean external-author trial and release certification.

The resulting claim may be **Connected App Platform beta**. It does not include
automation, custom experiences, external runtimes, sync, public ingress, or an
arbitrary full-surface App promise.

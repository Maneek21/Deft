# App Platform Phase 5 — immutable release certification

| Field | Certified value |
|---|---|
| Date | 2026-09-01 |
| Status | **PASS — Phase 5 complete** |
| Product candidate | `438a283a885f0ddc1b0aa34ef7a467d09ab163c8` (`#286`; correction over the original `#280` merge) |
| Certifier merge | `70a4b9844f0587e4a09a0041472c4f4974f16549` (`#285`) |
| Phase 4 baseline | `ec79592e669bdf915fad8a5d2480f0625d819a4c` |
| Supported predecessor | `ghcr.io/maneek21/deft@sha256:e565cc64ee22b5b9f6f99973e3762b639c27e026dc8824852145035acdacf788` (`6d39e0e0413c82d36c9481849ae582fdf805d1a6`) |
| Definitive run | [App Platform Phase 5 Certification 33469721507](https://github.com/Maneek21/Deft/actions/runs/33469721507) on exact `master` |
| Publication | None; the gate was read-only and `published: false` |

## Certified claim

Phase 5 establishes the internal connected-App kernel. One Protocol v1
Campaigns App can consume a live-authorized Contact, receive one exact reviewed
sandbox-email binding, and create governed App-origin Runs through human UI,
Defty, employee, and human MCP adapters. Equivalent authority enters the same
AppActionService, CapabilityService, approval, AppRun, result, and signed-receipt
path while actor, token, and surface identity remain distinct replay boundaries.

Staging remains non-executable. Effective authority is host-owned, immutable,
tenant-scoped, and rechecked at effect boundaries. Apps cannot select providers,
receive connector credentials, lower the policy floor, bypass approval, or call
CapabilityService directly. App-origin intake and the connected planes remain
disabled by default.

This certificate permits Phase 6 external-author work. It does not yet permit a
general full-surface App-platform claim.

## Immutable run evidence

The final workflow checked out the certifier at `70a4b984` and independently
checked out the product candidate at `438a283a`. The Apps-enabled image reports
the exact candidate revision and has local image ID
`sha256:53f48909138dadf057847e29bdd0c5cac992d4180b8025f4d67b2a7a39737b05`.

The retained GitHub artifacts are:

- `app-platform-phase5-safe-33469721507-1`: 209,304 bytes,
  `sha256:40689d1ab9c914477a2efa8efb8528d2a53a6019d400f18962a8ed119876d256`.
- `app-platform-phase5-image-33469721507-1`: 281,457,225 bytes,
  `sha256:f28bc0188de4880dbb57b162246f97aaf9f4996545737537460c39703bfb680d`.
- The uncompressed candidate image archive records
  `sha256:f8d08a41383ec4e293b91998eff240640fdc45d8d57d40c7917b91dede867e18`.
- The matched database dump records
  `sha256:e0cc79c8e4e23b1289d6fe1edceb317ce28c8b6702500be721e739375b6341d1`.
- The deterministic disposable certification keyring records
  `sha256:11130982d2d2f40e08e0aba999c3f92d38d6452f889c5d377f452d49daa8b9fe`.

The exact proof package identities remain:

- Contacts v0: `sha256:1471f0b94da9f6851bd978c315bc22a2dd0343b61a87477e4293b144c54248d8`.
- Campaigns predecessor v0: `sha256:0f478f5a761590f1f5874c7a0d0dc3382436b5e7f44c0c6ad6591cd577476344`.
- Connected Campaigns v1: `sha256:973ec7076daf7405a7a4d8b48509ef6f99b1b1cc4b787961104c73f23b7f770d`.
- Connected Module v2 artifact: `sha256:5dc2a978506eb2917a3a99021831d62d94112a60615292e4b32e03e480cff208`.
- Installed normalized Module v2 manifest:
  `sha256:70a2c14dffc15b7e8aa1e056a53b5933fa351e305d86e13ebf467bf8159287f2`.

## Upgrade, recovery, and predecessor compatibility

The run created a fresh PostgreSQL 16 database with real pgvector `0.8.6`,
started from the exact Phase 4 baseline, and used the supported upgrade path.
The migration ledger contains 23 entries through `0.3.0-preview.25`.

The source and restored snapshots matched at
`sha256:de8535e3fcb94e312a640392910e40af3ec8e191c14c650cee3e952c65343eda`:

- 20 continuity tables and 129 total rows matched.
- All referenced run-encryption, receipt-signing, and fingerprint key versions
  were present after restore.
- Eight App-origin Runs were retained; four successful Runs had decryptable
  inputs and outputs.
- All nine retained receipts verified.
- Three App package digests and one normalized Module manifest digest verified.
- The supported predecessor image read the upgraded resource successfully and
  returned revision 1 of `Ada Lovelace`.

## Browser, secrecy, and cleanup evidence

Authenticated `/settings/apps` evidence passed at 1440×900 and 390×844. Both
viewports rendered the connected Campaigns proof and two App cards with zero
horizontal overflow. The evidence reports:

- Apps surface loaded: true.
- Secret markers absent from rendered text and markup: true.
- Browser errors absent: true.
- Connected requested/effective authority, dependency provenance, exact action
  binding, health controls, and recent governed Runs visible on both surfaces.

The workflow uploaded safe evidence even during failed preflight iterations,
kept the large image archive separate, and confirmed removal of its disposable
containers, volumes, networks, and databases. The retained local
`deft_phase5_loop4_20260831` database was outside the workflow and remained
untouched.

## Supporting validation

The corrected product PR and certifier PR each passed repository CI and
security: API tests, typecheck, supported upgrade, Hermes employee release gate,
production image and browser smoke, final web build, dependency audit/review,
and CodeQL. Focused local evidence also covered App Kit/contracts, capability
parity, AppAction/AppRun lifecycle, live authorization, approval/revocation,
connector and trust boundaries, proof-package determinism, and rollback.

Local PostgreSQL did not provide pgvector and the local Docker engine was
unavailable; those checks were deliberately not retried locally. The definitive
GitHub release-host run supplied both requirements instead of substituting a
weaker proof.

## Gate hardening history

The gate failed closed while it was being completed:

1. Certifier-only fixes preserved the migration ledger, made predecessor output
   parseable, and distinguished the artifact digest from the installed semantic
   Module digest.
2. The release proof exposed provider idempotency keys whose base64url digest
   could begin with `-` or `_`. PR `#286` preserved all valid historical keys
   byte-for-byte and added an injective `d` prefix only for those invalid cases,
   with deterministic retry regression vectors.
3. The first corrected-candidate run passed desktop rendering but revealed that
   the certifier expected a desktop-only compact `h1` at mobile width. PR `#285`
   added a red-then-green responsive title contract and retained semantic `h1`
   checking on desktop.

No proof was weakened or waived. The corrected branch preflight passed in run
`33469116839`, and the exact-`master` run above passed independently.

## Phase 6 handoff and non-claims

Phase 6 may now begin from product candidate `438a283a` plus certifier/audit
history. Its bounded outcome is a **Connected App Platform beta** in which an
independent author can use packed public artifacts to build, validate, stage,
operate, upgrade, disable, recover, and inspect a Tier 2 connected App without
editing Deft core.

Phase 6 must preserve Protocol v0/v1 lock and package bytes, keep local staging
at zero authority, and reuse the existing review, grant, action, Run, receipt,
and provider seams. Automation, custom App experiences, arbitrary runtimes,
specialized sync, anonymous/public ingress, marketplace, billing, and the
general “build any feasible full-surface App” promise remain explicitly out of
scope until their later tracks and compound proofs pass.

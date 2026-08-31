# App Platform Phase 3 — Immutable release certification

| Field | Certified value |
|---|---|
| Result | PASS, with one explicitly recorded visual-tool limitation |
| Release | `v0.3.0-preview.14` |
| Commit | `6d39e0e0413c82d36c9481849ae582fdf805d1a6` |
| Image | `ghcr.io/maneek21/deft@sha256:e565cc64ee22b5b9f6f99973e3762b639c27e026dc8824852145035acdacf788` |
| Supported predecessor | `v0.3.0-preview.12` at `23694ef832bc11b6e06a704bf9af234697955d80` |
| Predecessor image | `ghcr.io/maneek21/deft@sha256:34b306e53e5c959468a973a50aaeb3b59235c56e631d67003f7780d18002d24b` |
| Release workflow | GitHub Actions run `33355373750` |
| Merged-revision CI | GitHub Actions run `33354900483` |
| Merged-revision security | GitHub Actions run `33354900548` |
| Certification host | Isolated loopback-only Docker/pgvector host; Compose project `deft_phase3_preview13_cert` |

## Decision

`v0.3.0-preview.14` is the Phase 3 operational rollback floor. The separate Run
engine/drain and legacy MCP intake contract is release-supported with these
limits:

- `DEFT_APP_RUNS_ENABLED=false` and
  `DEFT_APP_RUN_LEGACY_MCP_CUTOVER_ENABLED=false` remain the default.
- A self-host operator may opt into the legacy MCP canary only after preserving
  a matched database/keyring recovery point and following
  `docs/app-run-operations.md`.
- Engine-on/intake-off is the drain and recovery state. Intake-on/engine-off is
  invalid and fails closed.
- App-origin execution, App grants, App connector bindings, public Run APIs,
  automation origins, and default-on rollout remain unsupported.

## Merge and release provenance

PR #274 merged the guarded runtime and split controls. Its first immutable
candidate, `v0.3.0-preview.13` at `4bad79d8`, passed publishing and Run gates but
failed the Hello Workspace install gate. Artifact verification correctly bound
the package digest to exact canonical package bytes; the API then incorrectly
compared that digest with a second digest computed after Module parsing inserted
an optional default.

PR #275 removed only that redundant semantic-digest comparison and added a
regression where a valid Module omits the optional `required` property. It did
not change UI, migrations, tokens, connector ciphertext, App Run state,
provider dispatch, or rollout controls. All ten PR checks and the merged
revision's CI/security workflows passed before `v0.3.0-preview.14` was tagged.

The release workflow passed its two clean-state Hermes certification runs,
built the amd64 image, signed it keylessly, attached GitHub build provenance,
generated an SPDX SBOM, archived the exact source and Hermes bundle, and
published the release manifest. All twelve assets covered by `SHA256SUMS`
matched. `gh attestation verify` passed for the digest above. The exact source
archive checksum is
`0920f15173885ea4ea43b44c031f324c60fa47a78c9374103dcb0fa48f959235`.

## Installation and supported upgrade

The release-capable host preserved an existing, unrelated Compose project named
`app`; only the isolated certification project was operated.

The predecessor fixture contained:

- one organization and owner;
- one streamable-HTTP MCP connection with an encrypted API-key envelope;
- one assigned conservative employee;
- one previously approved action and one pending action;
- one legacy receipt; and
- one deterministic provider effect.

The supported release upgrade wrapper stopped writes, produced a backup, and
upgraded the same database from `v0.3.0-preview.12` through the current ledger.
Migrations `.17`–`.21` were present with their recorded checksums; the
`preview.14` fix-forward had zero additional migrations. Doctor and self-host
smoke passed on the exact target image.

The connector ID, employee ID, assignments, action states, receipt, and
credential envelope survived. The envelope SHA-256 stayed
`addaa126502cf85e83b055bc1e7458b18fa4bf2821757dba74a50017c7b70289`;
no connector ciphertext rewrite occurred.

The merged revision's production-image/browser job also proved a fresh
pgvector-backed schema, self-host Agent Channel/MCP smoke, production browser
smoke, and critical-image vulnerability gate against the exact release commit.

## Rollout controls and governed canary

All four flag combinations were exercised:

| Engine | Legacy intake | Result |
|---|---|---|
| Off | Off | Healthy default; legacy execution |
| On | Off | Healthy drain-only state |
| On | On | Healthy governed canary |
| Off | On | API startup refused; no healthy API was exposed |

The pending predecessor action was approved under the governed canary. It made
one provider call and produced one succeeded Run, one succeeded attempt, one
budget reservation, encrypted input and output rows, seven ordered events, and
signed terminal evidence. Replay returned the existing approval/result and did
not call the provider again.

Across the full gate the deterministic provider recorded exactly three effects:

1. the approved predecessor legacy fixture;
2. the governed post-upgrade canary; and
3. a new legacy call while the image was actually rolled back to the supported
   predecessor.

The released-image rollout-transition test independently passed engine-off
approval refusal, approval in drain-only mode, engine-off durable job deferral
with zero retry debit, engine-on completion, and registered-handler replay with
one stubbed provider dispatch.

## Declarative App compatibility

The public App Kit checked and built the unchanged Hello Workspace fixture at
package digest
`sha256:20e62afea91161e503dcecf547ad806c1419797834f6550f781d78bf3bb20884`.
A fresh single-use owner pairing installed and activated it on the released
image. `/api/apps` returned the active installation; `/api/apps/navigation`
returned its `Greetings` entry; and
`/modules/hello-workspace/greetings` returned HTTP 200. Disabling advanced the
lifecycle epoch from 1 to 2 and removed the navigation entry.

The in-app browser controller failed to initialize its local runtime assets, so
an additional interactive visual inspection of that specific route was not
obtained. This is not represented as visual evidence. The exact merged revision
did pass the normal production browser smoke, the release fix changed no web
code, and the App-specific package, API, route, activation, and disable evidence
above passed.

## Backup, restore, and key rotation

A matched recovery point was taken with app writes stopped. It contains the
PostgreSQL dump, uploads archive, App Run keyring, and deployment secrets under
restricted permissions. Representative checksums were:

- database: `c09d08c3579d46d3bc984569e5595dca3633be38cabac54b3be0202091b4aac8`;
- uploads: `de03d92de7b8138d6588d094a3ef65fdbcadab7265d8de22e4953e18c18197ba`;
- App Run keyring: `be9d9a2e598ac361f5863b49d191df1fd5b9ebb10f89fd45e0172a5803072359`.

The database and uploads were restored into a separate Compose project. That
copy booted first with the engine off, then with the matched keyring in
engine-on/intake-off mode. Stable continuity projections before and after
restore had the same canonical SHA-256. An uploads marker survived.

Encryption, receipt-signing, and fingerprint current IDs advanced to `enc-v2`,
`sig-v2`, and `fp-v2` while retaining the three `v1` entries. Before and after
rotation, retained input and output decrypted to identical digests and the
stored terminal receipt verified. Three separate non-serving boots removed one
referenced `v1` key at a time; each exited nonzero with the referenced-key
unavailable error. The healthy rotated configuration was restored after the
test. The disposable restore project and both of its volumes were then removed.

## Quiescence and immutable image rollback

Before rollback, the frozen runbook queries returned:

- zero nonterminal Runs;
- zero pending `app_run_invoke` approvals; and
- zero pending or running `app-run-attempt` jobs.

With intake and engine off, the exact predecessor digest was deployed against
the upgraded database without down-migration. Health reported
`v0.3.0-preview.12` at its recorded commit. The preserved connector executed
one new legacy approval successfully. The exact `preview.14` digest was then
restored, engine-on/intake-off passed the retained-key inventory and payload/
receipt reads, and the project returned to the default off/off state.

Final quiescence again reported zero for all three runbook queries. The only App
Run was succeeded, the deterministic provider count was three, the credential
envelope hash remained unchanged, and the final container used the certified
target digest.

## Cleanup and remaining non-claims

The temporary restore project, primary certification project, their isolated
volumes/networks, and the SSH browser tunnel were removed after the final
evidence snapshot. The on-disk evidence and matched backups were retained under
restricted operator access. The unrelated `app` project remained healthy
throughout.

This evidence does not claim App-origin authority, connected App grants,
ResourceRef, custom UI, automation, external runtimes, sync, public ingress,
hosted KMS, marketplace, billing, or SaaS operations. Those remain owned by
later phases.

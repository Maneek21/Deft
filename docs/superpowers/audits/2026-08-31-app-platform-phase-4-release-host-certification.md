# App Platform Phase 4 — Release-host candidate certification

| Field | Certified value |
|---|---|
| Result | PASS for the merged Phase 4 base and Phase 5 development handoff |
| Pull request | `#277` |
| Merged commit | `ec79592e669bdf915fad8a5d2480f0625d819a4c` |
| Candidate image | `deft-phase4@sha256:cc985cca14ed6f3429ce0e3d923ec095707d7aec871c0c8164cb3e3748c60771` |
| Candidate image revision label | `ec79592e669bdf915fad8a5d2480f0625d819a4c` |
| Supported predecessor | `v0.3.0-preview.14` at `6d39e0e0413c82d36c9481849ae582fdf805d1a6` |
| Predecessor image | `ghcr.io/maneek21/deft@sha256:e565cc64ee22b5b9f6f99973e3762b639c27e026dc8824852145035acdacf788` |
| Certification lane | Isolated pgvector containers, volumes, and network on the release-capable host |

## Decision

The exact merged Phase 4 revision is sealed as the Phase 5 development base.
Fresh pgvector installation, the independent Contacts/Campaigns proof, matched
backup and restore, live authorization after restore, predecessor-image read,
candidate restoration, and isolation cleanup passed.

This record does not claim a new public release, registry publication,
attestation, SBOM, or signed release manifest. Those remain required if this
candidate is promoted as a named public Deft release.

## Immutable source and image

PR #277 merged only after its head remained
`3f439959425dc0869c6a14f0bf801d6cb9742562`, every CI and security check was
successful, and GitHub reported the PR cleanly mergeable. The merge commit is
`ec79592e669bdf915fad8a5d2480f0625d819a4c`.

The release host built one production image from a detached worktree at that
exact commit. Docker recorded manifest-list digest
`sha256:cc985cca14ed6f3429ce0e3d923ec095707d7aec871c0c8164cb3e3748c60771`,
and the embedded OCI revision label matched the merged commit.

## Fresh pgvector and compound proof

A new `pgvector/pgvector:pg16` database named `deft_phase4_test` enabled the
`vector` extension and completed `pnpm db:push-full`. The output applied the
full fresh schema through
`0.3.0-preview.22-resource-relations.sql` and verified the existing composite
Module and dormant App Run guards.

The exact production candidate image then ran the focused Phase 4 compound
proof. It installed Contacts and Campaigns as separate Apps, created one record
in each, linked the Campaign to the Contact through the generic ResourceRef
relation, reauthorized human and employee reads/search/citations, exercised
disable/re-enable visibility, and retained zero sandbox email calls. The test
passed one of one.

The preserved fixture contained:

- two App installations;
- two Module installations;
- two Module records;
- one relation set at revision `1`;
- one active relation edge; and
- one idempotent relation receipt.

## Backup and restore

With no App writer running, PostgreSQL produced a custom-format matched backup.
It was retained under the certification directory with mode `600` and SHA-256:

`004ae7624267be863e5f7a27dfe8e479076404da2b33d50fabec6963754e70bd`.

The backup restored into a separate fresh pgvector volume. A canonical JSON
projection over App installations/versions/bindings, Module installations/
versions/records, and relation sets/edges/receipts had the same SHA-256 before
backup and after restore:

`776430d5f1b472a05d025e556e6de840d7a6b10a09b698de808b096cc25a5ac7`.

Against the restored database, the Phase 4 candidate performed a live
employee-authorized relation read. It returned revision `1`, target state
`available`, and safe label `Ada Lovelace`.

## Predecessor read and candidate restoration

The exact `v0.3.0-preview.14` image digest, with embedded commit
`6d39e0e0413c82d36c9481849ae582fdf805d1a6`, ran against the forward-upgraded
database without a down-migration. Its own Module Service performed a live
employee-authorized read of the existing schema-v1 Contact and returned
`Ada Lovelace`.

As expected, the predecessor does not understand Phase 4's Module schema v2 or
generic resource-relation service; this exercise proves the documented
compatible predecessor read boundary, not access to features that did not
exist in that image.

The Phase 4 candidate image was then restored against the same database. Its
live authorized relation read again returned the Campaign-to-Contact edge, and
the canonical continuity hash remained
`776430d5f1b472a05d025e556e6de840d7a6b10a09b698de808b096cc25a5ac7`.

## Isolation and cleanup

The certification used only these disposable resources:

- containers `deft-phase4-pg-ec79592e` and
  `deft-phase4-pg-restore-ec79592e`;
- volumes `deft_phase4_ec79592e_pgdata` and
  `deft_phase4_ec79592e_restore_pgdata`; and
- network `deft-phase4-cert-ec79592e`.

All were removed after the checks. The volumes are recoverable from the
retained restricted backup. The unrelated `app` Compose project stayed up, and
its API health endpoint returned HTTP `200` before and after cleanup. The exact
candidate image, detached source worktree, backup, and probe evidence remain on
the release host.

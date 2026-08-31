# App Platform Phase 4 — Local candidate certification

| Field | Certified value |
|---|---|
| Result | PASS for implementation and local candidate gates; release-host gate pending |
| Branch | `codex/app-platform-phase4-resource-kernel` |
| Released baseline | `v0.3.0-preview.14` at `6d39e0e0413c82d36c9481849ae582fdf805d1a6` |
| Migration | `0.3.0-preview.22-resource-relations.sql` |
| Local database | Disposable `deft_phase4_test`; pgvector unavailable on this machine |
| Contacts package | `sha256:1471f0b94da9f6851bd978c315bc22a2dd0343b61a87477e4293b144c54248d8` |
| Campaigns package | `sha256:0f478f5a761590f1f5874c7a0d0dc3382436b5e7f44c0c6ad6591cd577476344` |

## Decision

The Phase 4 implementation is ready for review as an additive candidate. It
provides a closed host-owned ResourceRef authorization seam, Module and Task
owner adapters, a tenant-bound generic relation substrate, strict Module v2
resource fields, bounded authenticated Module routes, live-authorized search
and agent citations, and the minimal generic reference picker. It grants Apps
no execution, connector, token, dependency, or dynamic provider authority.

This record does not call Phase 4 released. The release-host operations listed
below remain mandatory before an immutable Phase 4 release claim.

## Compound proof

Contacts and Campaigns build through the public App Kit and install as distinct
Apps with distinct Module installations. A Campaign references Ada Lovelace by
opaque ResourceRef through the authenticated generic route at initial relation
revision zero. The Campaign record contains no copied Contact field or payload.

Human and employee relation reads resolve the same safe label. Picker options,
Module search, agent context, and citations all reauthorize through the owner
immediately before return. Disabling the Contacts App retains the edge but
hides the target, search hit, and citation; re-enabling restores them. Cross-org
access, employee pause/project loss, membership loss, archive, compatible and
rejected upgrades, stale writes, replay conflicts, duplicate targets, ordering,
concurrent CAS, and historical edge retention are covered by focused tests.
The frozen sandbox email provider remains at zero calls.

## Fresh evidence

- Shared contracts: 62 passed.
- Public App Kit: 8 passed.
- Database upgrade/schema guards: 24 passed.
- Web Module contracts: 30 passed.
- Focused API contracts, imports, malicious-provider, and architecture guards:
  34 passed.
- Live PostgreSQL journeys: six passed for App lifecycle, Module v1, Module
  relations/views upgrade, owner-adapter parity, generic relations, and the
  compound Apps proof.
- Repository-wide typecheck: passed.
- Production build: passed once, including the Next.js production build.
- Public packaging determinism: Contacts and Campaigns each returned the exact
  digest above twice with `connected permissions: none`.
- Rendered UI: desktop 1440×1000 and mobile 390×844 passed for resolved label,
  picker search/selection, responsive controls, and return to the resolved
  link; no browser console errors.
- Final whitespace/error check: passed before checkpointing.

## Boundaries retained

ResourceRefs carry no organization. Provider kinds are a closed code-owned
union. Existing Module v1 parsing, canonical bytes, digests, and optimized
same-installation relation storage remain unchanged. No generalized
`/api/resources` route, App grant, connector binding, capability requirement,
App origin, token scope, remote effect, dynamic adapter registration, or
domain-specific Contacts/Campaigns core path was added.

## Unverified release-host requirements

This Windows host does not have pgvector installed and its Docker engine is not
running. The exact `.22` migration SQL was applied to the disposable PostgreSQL
database, but the following are deliberately not claimed:

- fresh schema boot on PostgreSQL with pgvector;
- supported upgrade from the released `preview.14` image through `.22`;
- matched backup and restore continuity;
- predecessor-image rollback read followed by candidate restoration; and
- an immutable released commit and image digest.

Run those once on the release-capable host after the review train merges. Do
not retry `CREATE EXTENSION vector` on this machine.

# Raw published release evidence

These fixtures retain each complete raw Host manifest (the original package's manifest member), without a schema parser or field projection. Connection fixtures retain the complete registry entry from the matching published corresponding-source archive's docs/setup.md. Public placeholders remain literal; private deployment registries are not published release assets. sources.json pins package/archive hashes, fixture hashes, URLs and build commits. Downloaded assets were checked against GitHub's SHA256 asset digests.

| Published tag pair | Before changed_paths | After changed_paths | Connection changed_paths |
| --- | --- | --- | --- |
| preview.17 -> .18 | [] | [] | [] |
| preview.18 -> .19 | [/manifest/experiences/0/artifact_digest] | [] | [] |
| preview.19 -> .20 | [] | [] | [] |
| preview.20 -> current main / #14 candidate | [/manifest/experiences/0/artifact_digest] | [] | [] |

These are actual downloaded assets: .17 and .18 both embed App version 1.9.0-preview.14; .19 embeds 1.9.0-preview.15; .20 embeds 1.9.1-preview.1. Published compatibility.json is a separate release document, not the raw installed Host manifest: the manifest's compatibility currently contains only app_protocol=7. No Host/Kit version-pin change was fabricated in the real-pair tests; exact pin paths are covered separately by synthetic tests.

The upcoming-release label is not yet assigned in source. Current main 84cc9a17bce40dd1721adfdd364886e36062ad5f and open #14 head 61b3019b1ca2ea7dbdbe19b775764991c4959f9b were built independently using their locked dependencies. Both produce the same App package SHA256 5edd0390addb97cd657f33f8c8d4ddda53003064a63aa4bfa0adc70750254fcc and the same connection template. #14's Runtime changes do not change the Host manifest. The candidate fixture is the #14 build, not a claimed published preview.21 asset.

## Raw JSON policy

Strict authority includes identity/schema/protocol, provider identities/origins/profiles, OAuth scopes, destinations/audiences, action/effect declarations, resources/keys/schemas/purposes/limits, permissions/consent purposes and lifetimes, plus the entire separate connection profile/protocol/authenticated transport. Additions, removals, array reordering and unknown changes require review. Object key serialization order is immaterial. Any path outside the following exact free list also requires review.

Free string leaves, relative to the manifest:

- /version, /name, /description
- /compatibility/{host,kit,runtime}/{version,minimum_version,release_manifest} (nine exact leaves)
- /compatibility/app_kit_version, /compatibility/runtime_kit_version, /compatibility/runtime_version

Free SHA256 digest leaves:

- /experiences/*/artifact_digest
- /experiences/*/worker_digest
- /runtime_requirements/*/package_digest
- /runtime_requirements/*/worker_digest

The wildcard matches a single existing array index. Arrays, object containers, artifact paths, bridge/renderer/channel protocol versions, connection transport digests and all sibling fields remain strict. Only strings (or absent leaves) qualify; digest strings must have the exact sha256:64-lowercase-hex format. A new compatibility object, a malformed object at a free leaf or a new unlisted digest field still requires review. This policy does not expand authoring/admission schemas or relax their checks.

The API walks raw JSON directly. Forward schema131 walks the same raw JSONB trees in the persistent-consent guard, preserving schema130 bytes. A live-database parity test checks the shipped predicate, real pairs, every free leaf and authority/malformed/container cases. End-to-end upgrades change the actual worker artifact on both consecutive upgrades and use ordinary live authority and Runtime delivery.

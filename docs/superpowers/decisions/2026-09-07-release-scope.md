# Explicit release scope

Official releases select their claim set with the commit-pinned
`release/release-scope.json` decision. The only supported scopes are:

- `core`: publish Deft without a Hermes compatibility claim or Hermes artifacts.
- `hermes-certified`: publish Deft only after the existing two-pass, clean-state,
  exact-tag Hermes certification succeeds, and carry its certificate and bundle.

One workflow owns both scopes so image signing, provenance verification, SPDX SBOM,
corresponding source, license assets, checksums, and tag identity cannot drift between
release paths. The scope parser rejects a missing file, unknown schema or scope, and
extra fields. A missing Hermes certificate can never downgrade a certified release to
core; changing scope requires a reviewed commit before the tag is created.

The `deft.release.v2` manifest records the selected scope. Hermes fields are present only for a
`hermes-certified` release, so a core artifact cannot imply certification it did not run.

We chose a commit-pinned decision in the shared workflow over a dispatch input,
which would not bind the claim to the tag, and over a duplicated workflow, which
would let signing and artifact controls drift. Repository consumer inspection found
no strict `deft.release.v1` runtime parser: self-hosting documentation reads
`signature_identity`, and backup tooling copies the JSON without parsing its schema.
Rollback is a workflow and manifest-generator revert; this decision has no database
migration or stored-data transition.

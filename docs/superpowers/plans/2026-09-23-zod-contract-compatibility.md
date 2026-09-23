# Zod contract compatibility

## Decision

Upgrade the workspace to Zod 4.6.5 while preserving the App v0/v1/v2 and
Module v1/v2 public validation contracts. Remove the temporary 4.4.3 override.
Keep Zod outside the routine Dependabot group so future updates receive
contract validation independently.

Zod 4.6.5 makes `unrecognized_keys` issues continuable. In 4.4.3 they aborted
refinements and affected which union diagnostics were returned. A direct
upgrade changed 241 of 1,609 comparison cases, including nested unknown keys,
duplicate identities and invalid references. Valid inputs in that corpus did
not change.

Use one shared `abortOnUnknownContractKeys` helper at the existing App,
developer-compatibility, Module and collection refinement boundaries. It
retains every issue, restores `continue: false` for unknown-key failures, and
returns before semantic refinements run. The same helper ships in the portable
App Kit through the existing authoritative-source build. This preserves union
errors as well as the refinement behavior; guarding individual semantic rules
alone would not preserve union diagnostics.

Keeping the old workspace pin would postpone the upgrade. Changing the frozen
protocol or accepting new diagnostics would impose a compatibility change on
consumers. The small adapter preserves the published behavior without changing
accepted inputs, removing errors, patching Zod internals, or changing schema
construction methods available to callers.

## Boundaries and validation

Author-supplied JSON still passes the same strict structural and semantic
schemas before packaging or host use. Parsing still grants no authority; no
tenant, approval, persistence or runtime execution boundaries change. There
is no data migration. Reverting the PR restores the previous dependency pin
and validators without transforming stored data.

The 1,609-case before/after comparison covers valid and malformed example App
and Module manifests and matches after the adapter. Committed regression tests
cover root and nested unknown keys, duplicate identities, union branch errors,
and host/portable Kit parity. Existing package, canonicalization, protocol,
negative-corpus and packed-consumer tests remain unchanged. Run the complete
App Kit suite, workspace typecheck/build, lint, dependency audit and required
CI before merging. Future Zod upgrades must pass these same gates.

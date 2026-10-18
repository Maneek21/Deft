# Reviewed CodeQL false positives

CodeQL still analyzes the complete configured JavaScript/TypeScript source. The security job preserves its original SARIF and fails any new, changed, duplicated, or unreviewed finding. It does not exclude queries or source paths.

The reviewed catalog records 27 false positives from the original analysis of commit `3f30966b1bfc9851c770c9ce0b2f55ed1b026321`: 13 fixture assertions, nine hashes of non-password data, two exact scope-array comparisons, and three transfers to a guarded opaque iframe. Each entry explains its actual source context. These are false-positive classifications, not accepted vulnerabilities or a claim that the repository has no vulnerabilities.

The important production distinctions are:

- Deterministic request and document IDs hash scoped identity/idempotency data; OAuth lookup hashes cover server-generated 256-bit random tokens. Neither is a password verifier. Receipt hashes are keyed integrity checks.
- The scope checks compare complete array elements, rather than URL substrings. The catalog also pins their normalization and validation dependencies.
- The installed experience transfers to the exact sandboxed frame after the null-origin/current-authority handshake. Its `allow-scripts` sandbox omits `allow-same-origin`; the wildcard target origin is required for that opaque origin. The bridge, lease, connection and bootstrap guards are also pinned.

`scripts/codeql-reviewed-findings.mjs` matches the rule, location, message, partial fingerprints and code flows, plus exact SHA-256 hashes of the reviewed source and relevant guard dependencies. A changed or missing source cannot inherit an accepted disposition. Incoming suppressions are ignored. Duplicate results and unused catalog entries fail closed, so a disappearing or moved finding requires another review as well.

The raw SARIF remains byte-identical. A separate `reviewed/` SARIF copy contains standard `external` suppressions with `accepted` status and per-finding justifications. `findings.json` retains every finding and its explicit disposition; `disposition.json` reports raw, reviewed and unresolved counts with input hashes. See the [SARIF 2.1.0 suppression specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html).

To reproduce the gate, copy the original `.sarif` into a separate output directory, then run from the repository root:

```sh
node --test scripts/codeql-reviewed-findings.test.mjs
node scripts/codeql-reviewed-findings.mjs /path/to/sarif-directory
```

The catalog is deliberately conservative: edits anywhere in a pinned file require a new source review. Reviewers must inspect changed source semantics and the fresh raw finding before updating a catalog entry. A real vulnerability must be repaired; it cannot be classified merely to make CI pass.

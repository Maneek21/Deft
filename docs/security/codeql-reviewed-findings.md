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

## FX-A review, 2026-10-22

Fresh [Security run 39689516157](https://github.com/Maneek21/Deft/actions/runs/39689516157) analyzed PR #410 commit `f4c17114708faeef49600158c0a269df45aa1786`. Its untouched raw SARIF has SHA-256 `afebaad11408dc67df2be0d2b327c7bd381f119e08f63c5aabbfdb5cb3ed0f11` and 26 findings: 23 still matched existing reviews, and only the three existing opaque-frame findings required renewed location/source pins.

| Review | Previous line | Fresh line | Fresh exact fingerprint |
| --- | --- | --- | --- |
| FP-012 | 1047 | 1050 | `9c4c2dca93762555508d94c6b51cdad9a32e02416aa3dba293157ad95678083b` |
| FP-013 | 1062 | 1065 | `f7783c0a30ec6761f888c8ae879b7622dd8817c8eb63fd484502413addc42e74` |
| FP-014 | 1142 | 1145 | `e45188d1045fa7671fafa4524057a5ecce0297d8f40c5ac811782068f432b03d` |

Review of the fresh source-to-sink flows confirms that they still carry the existing scoped session ID in the stop/start messages to the exact Host-created opaque iframe. Subtracting the three-line offset from every fresh result/flow location reproduces each previous exact fingerprint; the query, message, columns, partial fingerprints and inner path steps did not change. The sandbox omits allow-same-origin, readiness requires the exact contentWindow and null origin, startup requires current identity/lease/visibility and one transfer, and teardown stops the lifetime, revokes the bridge, closes the port and removes the frame. The FX-A access-summary state and feature-local read-error handling do not alter those boundaries or extend consent.

Only `apps/web/src/components/apps/installed-app-experience.tsx` changed among all pinned source files. Its reviewed SHA-256 is now `9a096d791fd9d1f305f4fc2412e19863a918e09b26a8917d5e45deb1c000c691`; every supporting guard pin and every unrelated finding remains unchanged. No query, path, finding, or GitHub alert disposition is excluded or automatically dismissed. The exact disposition gate must continue rejecting any other changed or new finding.

Validation: all 10 disposition unit tests passed, and the unchanged fresh raw SARIF passed the updated exact gate with 26 reviewed findings, zero unresolved findings and zero unused reviews. The raw SHA-256 remained unchanged after the gate.

## Combined Host136 presentation review, 2026-10-22

PR #409 is rebased on the merged FX-A implementation from #410. Its combined
installed experience changes only the notice import, owner-readable notice JSX,
and duplicate action presentation. The scoped-access calculation, current-screen
store filtering, read-only recovery and seed-form behavior remain from FX-A.
The three guarded opaque-frame finding lines and exact flows retain the FX-A
locations and fingerprints above. Every supporting authority-source pin remains
unchanged. The combined source SHA-256 is
`1ab480e5edd639df89c160a142d10a4f2f9349d53e96a30d5439431a1b0f81b7`.

The unchanged FX-A raw SARIF passes against canonical combined source with all
26 findings reviewed, zero unresolved and zero unused entries; raw bytes retain
SHA-256 `afebaad11408dc67df2be0d2b327c7bd381f119e08f63c5aabbfdb5cb3ed0f11`.
Fresh combined-head CodeQL analysis remains a required CI gate.

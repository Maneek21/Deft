# Reviewed CodeQL false positives

CodeQL still analyzes the complete configured JavaScript/TypeScript source. The security job preserves its original SARIF and fails any new, changed, duplicated, or unreviewed finding. It does not exclude queries or source paths.

The reviewed catalog now records 26 false positives (FP-001 through FP-027, excluding retired FP-016). It originated with 27 findings from commit `3f30966b1bfc9851c770c9ce0b2f55ed1b026321`. Each entry explains its actual source context. These are false-positive classifications, not accepted vulnerabilities or a claim that the repository has no vulnerabilities.

The important production distinctions are:

- Deterministic request and document IDs hash scoped identity/idempotency data; OAuth lookup hashes cover server-generated 256-bit random tokens. Neither is a password verifier. Receipt hashes are keyed integrity checks.
- The scope checks compare complete array elements, rather than URL substrings.
- The installed experience transfers to the exact sandboxed frame after the null-origin/current-authority handshake. Its `allow-scripts` sandbox omits `allow-same-origin`; the wildcard target origin is required for that opaque origin.

`scripts/codeql-reviewed-findings.mjs` accepts only `deft.codeql_false_positives.v2`. It matches `rule`, primary `path` and `fingerprint_v2`; `line` is informational. The fingerprint is SHA-256 of canonical JSON containing the rule, level (default `warning`), message text, primary URI, optional CodeQL `primaryLocationLineHash`, and `{uri, message?, code}` for the primary location and every flow step. Each code string contains the complete inclusive source-line range, with trailing whitespace trimmed per line and line endings normalized to LF. No line or column coordinates are hashed. Independent outer code flows are sorted; threads, inner steps and duplicates retain their order and multiplicity.

Blank lines or unrelated edits outside these regions can move a finding without renewing it. Changing code in a primary/flow region invalidates its fingerprint, subject to the whitespace normalization above. Missing files, symlinks (including directory ancestors), paths outside the root, unsafe URIs, invalid ranges and invalid UTF-8 cannot inherit a disposition. Incoming suppressions are ignored. Duplicate results, malformed manifests and unused entries fail closed; disappearing findings still require review.

The raw SARIF remains byte-identical. A separate `reviewed/` SARIF copy contains standard `external` suppressions with `accepted` status and per-finding justifications. `findings.json` retains every finding and its explicit disposition; `disposition.json` reports raw, reviewed and unresolved counts with input hashes. See the [SARIF 2.1.0 suppression specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html).

To reproduce the gate, copy the original `.sarif` into a separate output directory, then run from the repository root:

```sh
node --test scripts/codeql-reviewed-findings.test.mjs
node scripts/codeql-reviewed-findings.mjs /path/to/sarif-directory
```

To print candidate fingerprints against the same checked-out source used for analysis:

```sh
node scripts/codeql-reviewed-findings-fingerprint.mjs /path/to/javascript.sarif /path/to/repository-root
```

The helper never changes or approves the manifest. Reviewers must inspect changed source semantics and the fresh raw finding before adding or renewing an entry. Keep the existing ID, disposition and justification when migrating a review; update the review commit and original SARIF digest when renewing the reviewed baseline. A real vulnerability must be repaired; it cannot be classified merely to make CI pass.

V2 pins the code reported on the primary/data-flow path, rather than whole files or extra guard dependencies. Changes to guards, callers or control flow outside reported regions can therefore preserve a pin even if they alter security semantics; ordinary security review and fresh full CodeQL analysis remain necessary. Trailing whitespace (including whitespace inside multiline literals), line-ending-only changes, movement to identical code and SARIF metadata outside the fingerprint are intentionally not distinguished. The optional CodeQL line hash adds context but is not a substitute for reviewing off-path code. Historical justifications mentioning whole-file/supporting-source pins describe the v1 review, not a v2 guarantee.

The three master-artifact regression tests use `CODEQL_MASTER_SARIF` (locally defaulting to `C:/tmp/codex-pins/sarif-master/javascript.sarif`). They skip with an explicit reason if that external artifact is absent; setting the environment variable to a missing file fails. All synthetic security tests run without the artifact. Tests copy sources into temporary directories and never edit real source files.

## V1 review history

The following historical renewals used exact locations and whole-file hashes. Their hashes and counts are historical evidence, not the current v2 pin format.

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

## V2 migration proof, 2026-11-12

Baseline commit: `058994265d3bd0d76bde71867acd2b3e19d7d0c2`. Original master SARIF SHA-256: `c433240720c7dfffa8971c4d23d04c0ba0a1604b3c81caf4c9aaf2a209fc37cd`.

All 26 legacy entries matched exactly one master result by rule, primary path, exact start line and the original v1 implementation's fingerprint. All 26 results were consumed once, and all 26 new fingerprints are distinct. Every ID, disposition and justification is byte-for-byte equal as a parsed string. The Windows checkout's CRLF bytes differ from the legacy whole-file hashes; all legacy source hashes match after CRLF-to-LF normalization. The v2 CLI passed with 26 reviewed, zero unresolved and zero unused reviews; both raw SARIF copies were byte-identical.

| Old ID | V2 ID | V1 fingerprint | V2 fingerprint |
| --- | --- | --- | --- |
| FP-001 | FP-001 | `a9fc009601c0f1514e8085e220128a242f27ff12e7e93d963df3fa2aaf029eb4` | `42473a47c671df6628286205ba7e4f3bf6aa734a32d2a7f766ee4789d887d211` |
| FP-002 | FP-002 | `673bfa3fb0828edce7a52a9f44d58cd63da776fb34792476d7499ec1c2585830` | `32a17e0c37eaf79bc724b0d9b34a62031fa1aeac989da82f3bf22eb7adcab714` |
| FP-003 | FP-003 | `971312b76e0d84ca58a1a5ee5d155becf0149f6125d5837559cd7eff12d29748` | `9ae0895299ad1a322b36c1ef16f119e0295fe2f3bbf54b96a809de3d5bfd8451` |
| FP-004 | FP-004 | `d966dd0a6d7b32634c4052d999eafef501fc6b4487e9f3b128b66a2cd6b06d9a` | `77f3349304bf7e6512a55b30c5b54edb2be2af6d9ddb8a970b78c8974a90d78e` |
| FP-005 | FP-005 | `044e7882a96b8dbb2c95b9abce15eab00f1a3d4dec5bc07d558fd39ba55719fb` | `7cbbeccf357346f1909e0abf059351278a7061d74ed57293af354d11f1937b8c` |
| FP-006 | FP-006 | `0020ad5b60028976129607f95571e5ca7ecba7e5bdbdc76e2583b2261e6bfe44` | `ed410a2cf721cf7eb0fc856db4aef0d4d53f9adbc67c182a2d637ebe7beff2c3` |
| FP-007 | FP-007 | `86b71b87270b411f8c05dde0f5f9b15c08c7593603864ca821d2a4da9e7249c4` | `cc2d27a05860de859dc166a7101c2ff2a2e247777d6c15e12db7d72b15c954ef` |
| FP-008 | FP-008 | `c7ab3986568074987b77c781f8b5ff8283e3f522b808854c103821f2a2e678c4` | `5c3b4dfe069b3bb6c693ebc15af583b4a06940f9ef79802b629c511a16c1f93c` |
| FP-009 | FP-009 | `109a5828962941367e167c4dc5fc62ca04e3d042b8a85f1d2c4ef9087a8e1015` | `ffefd377868d02e461a6ae91ca4579112f71562214515a62c4824603da1a61db` |
| FP-010 | FP-010 | `8b897cf607ccca5d86c6ac21a820156fdc2c2728eb7d593fed89c55564d202d0` | `962a26bc615538378b2e314d0dc750665232803cbb15d2c28f8ae96a55c95d4e` |
| FP-011 | FP-011 | `9f1c0f96e8fe66d2e5067a4a7aae7eaf5a1a6f16cf7f19ca7aa0798a1e873c4b` | `f6a6704f0528109af6af72caff057a0e084f923de62a418c1384bdd53e9d6263` |
| FP-012 | FP-012 | `4ddeb6b5170ed8fb0a8c7db661ba287e212f38f8837675bfef085d9afd16f3c7` | `211eeb2126bf86e1d797128e000c4c0c8bb524d004d90d63917521daada9f6c6` |
| FP-013 | FP-013 | `1376eef6017d2ce498679c703001619d8119e46d9870c46f6db99ad9baa8879a` | `10dfc0c7a16e032d3146414311812d3d242fee87d18267fb5219687d6fa16ebf` |
| FP-014 | FP-014 | `50f51faa496be25ffb091c888fde2d44687cddfad1046c34210898253f08adce` | `bf2b5194a20cdf88abcd7231c8716a32412c4aac69cfd8a70b68f21be00f5b47` |
| FP-015 | FP-015 | `adbd20f4473221df718cfe28a8052f169d58426f070e7de6a3ae6f6d68fbc708` | `d5e2a8686aca4dff24200c37a67930675926bad480a4af45fd88910865bc2939` |
| FP-017 | FP-017 | `49020d832afc0f2f6be5ae1524a3505837af5a96e3769d0c1860e2d4fc5f169b` | `53bf1aa714e6f57263a6974f4a320b2c75c8c61cb91a17e6174c57d56ab0e36f` |
| FP-018 | FP-018 | `7205b867524522448e8baf5f1c8080415a0872649cf8741f17dadf9be0ffec72` | `4be25f44e75f75da05e163358ae4c940652c788f1a0cab57bf1f724ce13462d3` |
| FP-019 | FP-019 | `fbce4dbb6cace1946200d6097beaea21cea0ad75d16300790bfdb0f7b1649756` | `c0e522377c46d859ccd02b8d363d678eedc6e766e387187f9725e8b2b24f791a` |
| FP-020 | FP-020 | `32cbb4630a1708e20bd0644f6148e6c3606d2c6338af46ad60b127dac4f5089a` | `53850c594f41f9b1e14008c77b898d13baf725b969177dc4dd492862f5c231a1` |
| FP-021 | FP-021 | `d60e4d2bc50db6817fc35eed2a66e53c8fa48f89624a887c0ea6f8ecd13e6769` | `da9935247d48f26e7136fe883a06cd245404736b50682a141f21b89cc10292b3` |
| FP-022 | FP-022 | `01613450c0995b76f54bb422194813724bbd9ec487108c0194d64af0127193dd` | `a6cb5f82b8aebd462c2e17f951c6727d9f722e17fefe19f99a6c6ba8a2ba56f1` |
| FP-023 | FP-023 | `f028e2af24686e5e1d6cb86b91ee24007f91afb90115389d18e5bdfca9c8ee95` | `81e378a14465572aba133375b38a6c8a100cb9bb467ee95507666e19f7f26324` |
| FP-024 | FP-024 | `1d83e4440d830f7d318491ac48e64df5e09879e62a0d2118ee54ab649c41162b` | `f5f509fadce44dff89df1bb85fc0f132d1ecd599ad9b488e555d4d8f0bfdd32b` |
| FP-025 | FP-025 | `6bfccb4cc4991facc615a6a0fa7ee8255dbed81d9c31599fb6bcf67b377af1e6` | `2c1a7a51a70c013df09cdd6714e874d20b0cdcbb11db3230593c741e684aca68` |
| FP-026 | FP-026 | `bf395e118877f36ce7783a750ded59b7e280cb1ac2d4b15ee532e8f08b1e5de2` | `504be96c79bfce2526894093396352f669f7410f8585f6a22e3e5f06e7d41122` |
| FP-027 | FP-027 | `8201a70907661974699acd44b129c8999d53729fa6baaf736b1faeaa5ec02e6e` | `55eb7ed8d1ce21cfe432cca5906022d2d1b521cb28deb61f40d55fe06bb2e6b7` |

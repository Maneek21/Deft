# App Platform Phase 6 — release certification

| Field | Value |
| --- | --- |
| Date | 2026-09-01 |
| Status | **PASS** — connected App Platform beta only |
| Product candidate | `16875df2f6c9dc2bc3d850de6758b7dd56767a05` |
| Certifier PR | [#292](https://github.com/Maneek21/Deft/pull/292), merged as `780e398e27e5ff58b4fb385293fb1c8f55403d16` |
| Definitive certifier/head | `780e398e27e5ff58b4fb385293fb1c8f55403d16` on `master` |
| Supporting certifier head | `f3de121ba617a0df058b9b3ca24f57bc0c1696a7` |
| Phase 4 baseline | `ec79592e669bdf915fad8a5d2480f0625d819a4c` |
| Supported predecessor | `ghcr.io/maneek21/deft@sha256:e565cc64ee22b5b9f6f99973e3762b639c27e026dc8824852145035acdacf788` (`6d39e0e0413c82d36c9481849ae582fdf805d1a6`) |
| Verified supporting run | [33501966960](https://github.com/Maneek21/Deft/actions/runs/33501966960) — success |
| Definitive master run | [33502872942](https://github.com/Maneek21/Deft/actions/runs/33502872942) — success |
| Publication | None; definitive evidence records `published: false` |

This audit follows the [Phase 6 plan](../plans/2026-09-01-app-platform-phase-6-and-track-a-loops.md) and carries forward the recovery baseline sealed by the [Phase 5 certificate](./2026-09-01-app-platform-phase-5-release-certification.md). It separates the successful pre-merge supporting run from the definitive successful run on the exact merged `master` commit.

## Claim under certification

The bounded Phase 6 claim is that an independent author can use the published App Kit and public contracts to build a Tier 2 connected App, stage it without authority, complete host-owned review and activation, invoke its separately packed sandbox provider through governed App Action, App Run, and Capability seams, then upgrade, disable, recover, inspect, and re-enable it on a real self-host.

Run `33502872942` certifies that claim for the exact product candidate from merged certifier commit `780e398e27e5ff58b4fb385293fb1c8f55403d16` on `master`. Run `33501966960` is retained as independent pre-merge supporting evidence only.

## Verified exact-head supporting evidence

- Workflow run `33501966960` was dispatched from certifier head `f3de121ba617a0df058b9b3ca24f57bc0c1696a7`, completed successfully, and checked out product candidate `16875df2f6c9dc2bc3d850de6758b7dd56767a05` exactly.
- The gate typechecked the exact candidate, built it once, and reused the resulting image for host, browser, offline, backup, and restore proof.
- The candidate image records OCI revision `16875df2f6c9dc2bc3d850de6758b7dd56767a05`, config ID `sha256:04a273960f532c801f805810bbbfc11f8ffbae23d7064b4ccd94f723cfd16ed3`, manifest digest `sha256:732084893a531b5d6c55cdb2acfee67e30aa8dd23e111f64e8a53b98b9446b11`, and archive SHA-256 `13c2b701fcb0ace1d0414acf7782df39f35bedd05c7c34230a357ddc6cfbdb00`.
- GitHub retained two artifacts from the successful run:
  - `app-platform-phase6-safe-33501966960-1`, 665,816 bytes, artifact digest `sha256:b88129416e249fb61ee6d563c50efb9236e7e9ad68b7765c11c688206579106a`.
  - `app-platform-phase6-image-33501966960-1`, 281,750,295 bytes, artifact digest `sha256:9a510d1a4832eba422b0f9f1c2701192cb959d3edd78144b707a299f5fecf0db`.
- The safe certification summary reports schema `deft.app_platform.phase6.release_host.v1`, `result: passed`, the exact candidate/baseline/certifier identities above, the digest-pinned predecessor, and `published: false`.
- PR #292 contains the exact successful certifier head, merged as `780e398e27e5ff58b4fb385293fb1c8f55403d16`; all required PR checks shown on the merged PR passed.

These artifact digests identify the supporting branch-head evidence only. The definitive master artifacts below have their own run-specific digests.

## Definitive master evidence

- Workflow run `33502872942` was dispatched from `master` at merge commit `780e398e27e5ff58b4fb385293fb1c8f55403d16`, completed successfully in 8 minutes 3 seconds, and checked out product candidate `16875df2f6c9dc2bc3d850de6758b7dd56767a05` exactly.
- The gate independently repeated exact-candidate typecheck, one production build, packed external App Kit authoring, the complete host certification, bounded evidence upload, exact candidate image upload, and isolated resource cleanup.
- The candidate image records OCI revision `16875df2f6c9dc2bc3d850de6758b7dd56767a05`, config ID `sha256:173e059a2aba5ece471f6033fc1cdd536d7ba7706c847ff93d8f25d3ff47ecd9`, manifest digest `sha256:af26ab1a7846a137f551c32f81620eaecd13f148d42da5d43a85ffef38190276`, and archive SHA-256 `ef5e68c9bb705052422a901a903416c5278354f51114bc25a2a308de806a8804`.
- GitHub retained two definitive artifacts:
  - `app-platform-phase6-safe-33502872942-1`, 667,452 bytes, artifact digest `sha256:d514a8a0747089d7643eb0b7c0e38156589dc21e51d15c7a2100a2d8a889bf9a`.
  - `app-platform-phase6-image-33502872942-1`, 281,340,051 bytes, artifact digest `sha256:2aa0875088218ae974e9d8df85d7f146e3e94ba81dbe1c12fc5c80029e906e06`.
- Every retained JSON file parsed, every retained SHA-256 file was a valid 64-character lowercase digest, and all six bounded screenshots were visually inspected against their claimed desktop, mobile, lifecycle, receipt, and offline-denial states.
- The definitive summary reports schema `deft.app_platform.phase6.release_host.v1`, `result: passed`, certifier SHA `780e398e27e5ff58b4fb385293fb1c8f55403d16`, the exact candidate and baseline identities, the digest-pinned predecessor, and `published: false`.

## Public authoring and package contract

- The gate packed `@deft/app-kit` `0.1.0-alpha.1` from the exact candidate and passed the clean external-install proof: one test built both the declarative Contacts App and connected Campaigns App without private-repository imports or credentials.
- The focused contract matrix passed for App Protocol v0 and v1, deterministic package verification, public schemas, compatibility, connected requested-authority projection, and provider-independent sandbox-email conformance.
- The connected package identifies App Protocol `1` and package format `deft.app.package.v1`. Its operator-facing compatibility surface showed the exact App Kit package/version, protocol, format, stage-only install mode, and unsigned local provenance warning.
- v0 remains the declarative `stage_and_activate` compatibility path. The v1 connected path is `stage_only`: staging grants zero authority, and review plus activation are explicit host operations.
- Compatibility preflight rejected an unsupported protocol and a host that did not advertise the exact App Kit version. That is compatibility evidence only, not registry, signature, or provenance trust.
- The generated requested-authority report is an informational projection, not an effective grant. It contains no host identity or effective authority. Its supporting-run file SHA-256 is `234144c26827fdcd5214ce9b50b64fab798fd277457e2e35f7a552ed34f9213e`.
- The exact connected upgrade was built from version `3.0.0` to `3.0.1`. The package file SHA-256 is `c765db371f790fd3d1c7ddaefe363028e9b422c67160e7898a31b4d4902f2bfc`; the CLI reported canonical package digest `sha256:cbd08eed98fc775766a417df090322ab5a9450b08f9996d855cfa23199727ab6`.
- The sandbox email provider was packed separately, unpacked outside the repository, and mounted read-only at `/deft-provider`; its tarball SHA-256 is `feb0afb9f7c9903b27fcdd521fe3c9edecab0b9ec11abb44d807ba4675f29fa2`.

## Real self-host lifecycle and browser proof

The browser evidence schema `deft.app_platform.phase6.browser_smoke.v1` reports `result: passed` and records all of the following as true:

- authenticated access to the real self-host and visible compatible, unsigned App Kit/protocol/package contract;
- a safe verified-receipt dialog on desktop;
- file-UI staging of the exact `3.0.1` upgrade, exact-authority review, policy acceptance, and activation;
- disable followed by a fresh review and re-enable rather than reuse of stale authority;
- invocation of the separately packed provider through the unique `Connected campaign` resource, `Send campaign email`, `Review action`, `Confirm and run`, Inbox approval, and the resulting newest successful Run/verified receipt;
- the final active upgraded state and safe receipt on mobile;
- no horizontal overflow, no secret or signature markers, and zero desktop or mobile console, page, or API failures.

Five bounded browser screenshots and one offline screenshot accompany the structured evidence. The evidence records booleans and safe UI output only; it does not retain auth tokens, raw API payloads, secrets, signatures, or internal record/Run identifiers.

## Upgrade, recovery, and retention proof

- The digest-pinned supported predecessor reported revision `6d39e0e0413c82d36c9481849ae582fdf805d1a6`; the pre-upgrade resource read passed.
- The exact candidate carried the Phase 4 database through 23 migrations ending at `0.3.0-preview.25`, with pgvector `0.8.6`.
- Backup and restore matched definitive continuity hash `sha256:d1b1c12ccdc7e318331b1528e194797fefc12247c468f7eabc89f4a48778c3ec` across 20 covered tables and 349 rows.
- The restored key inventory verified one Run-encryption version, one receipt-signing version, and two fingerprint versions. The safe keyring-file SHA-256 is `40011b3a04906072675605ad318d3457da5dfb109fe3b645efebcddcc32ddd7e`.
- Restored App-origin history contained 15 Runs, 8 succeeded, and all 8 successful results remained purged. No purged Run input or output decrypted.
- Four retained secret payloads were present and all four inputs decrypted; no retained output decrypted.
- All 24 receipts verified. Three App package digests and one module manifest digest verified.
- The definitive database dump SHA-256 is `19adfeed60018ab334859c9fbbe8848a7c27d7e37efc54f975357184aefdfc67`.

## Provider-unavailable and cleanup proof

- The exact candidate booted again without the provider mount.
- The local connected resource remained readable, provider discovery reported the connector unhealthy, and invocation failed safely without creating a Run or changing succeeded/failed Run counts.
- The successful job completed its isolated cleanup step. Run-scoped containers, volumes, network, database, candidate image tag, and temporary certification paths were the cleanup scope.

## Failure and correction history

Earlier executions are retained as negative evidence, not release evidence. Before run `33501966960`, the workflow history contains two failed master attempts, thirteen failed certifier-branch attempts, and one cancelled certifier-branch attempt. None of their artifacts or partial results are used for the supporting claim above.

The certifier correction sequence in PR #292 hardened:

- candidate-image package-manager setup, prebuilt App Kit packing, and portable pnpm invocation;
- separation of packed-external and image conformance plus serialization of shared-database certification;
- activation of the Phase 4 continuity fixture and removal of duplicate lifecycle mutation;
- restored retention/key coverage, post-setup inventory freezing, and keyring refresh ordering;
- bounded browser failure reporting, exact approval correlation, and binding approval proof to the resource identity;
- safe binding of the offline probe input.

The final correction commit `f3de121ba617a0df058b9b3ca24f57bc0c1696a7` produced the first successful exact-head run and was then merged through PR #292. The definitive master rerun closes the branch-only gap: the merged certifier state owns the final certificate.

## Definitive master certification

| Required final field | Definitive value |
| --- | --- |
| Workflow conclusion | **SUCCESS**, run [33502872942](https://github.com/Maneek21/Deft/actions/runs/33502872942) |
| Certifier/head identity | `780e398e27e5ff58b4fb385293fb1c8f55403d16` on `master` |
| Candidate checkout and image revision | `16875df2f6c9dc2bc3d850de6758b7dd56767a05` |
| Certification summary | `result: passed`; `published: false` |
| Safe artifact | `app-platform-phase6-safe-33502872942-1`; 667,452 bytes; `sha256:d514a8a0747089d7643eb0b7c0e38156589dc21e51d15c7a2100a2d8a889bf9a` |
| Candidate-image artifact | `app-platform-phase6-image-33502872942-1`; 281,340,051 bytes; `sha256:2aa0875088218ae974e9d8df85d7f146e3e94ba81dbe1c12fc5c80029e906e06` |
| Internal image identity | config `sha256:173e059a2aba5ece471f6033fc1cdd536d7ba7706c847ff93d8f25d3ff47ecd9`; manifest `sha256:af26ab1a7846a137f551c32f81620eaecd13f148d42da5d43a85ffef38190276`; archive `ef5e68c9bb705052422a901a903416c5278354f51114bc25a2a308de806a8804` |
| Authoring and lifecycle | Packed external authoring passed; upgrade, disable, fresh review, re-enable, provider invocation, approval, Run, and receipt proof passed |
| Recovery and retention | 20 tables / 349 rows matched; pgvector `0.8.6`; 23 migrations; 15 App-origin Runs; 8/8 successful results purged; 4/4 retained inputs decrypted; 24/24 receipts verified |
| Browser and offline | Desktop/mobile proof passed with zero tracked failures; provider-unavailable invocation failed closed without creating a Run |
| Isolated cleanup | Passed |

## Connected-beta boundary and explicit non-claims

This certificate is limited to the connected App Platform beta proved above. It does not claim:

- that an App or its requested-authority report can self-grant authority; effective authority remains host-owned, tenant-scoped, explicitly reviewed, and revocable;
- registry attestation, signature trust, or production provenance for unsigned local packages;
- a production email service or production suitability of the proof-only sandbox provider;
- custom App UI, arbitrary executable App planes, arbitrary external runtimes, specialized sync engines, or anonymous/public ingress;
- generalized automation or any Track A governed-automation delivery;
- marketplace distribution, billing, or a final full-surface “any feasible App” promise.

The certified surface is the exact public authoring, connected staging/activation, governed App-origin execution, provider, lifecycle, receipt, recovery, and fail-closed path exercised by this gate—nothing broader.

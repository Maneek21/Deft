# Deft launch security review — 2026-09-05

Scope: defensive source review of GitHub master `7355c90a0ab5630b839440e8e25133b63853835c` for a public self-hosted preview. The original local checkout is older. This document contains remediation and test requirements, not attack instructions. No real provider account or application database was modified.

## Decision

Close the dependency advisory and the public authentication/registration hardening gaps before promotion. Disable the unsupported native GitHub connector unless its callback is repaired and tested. These are specific findings; they do not establish that the rest of the application is vulnerable or that every path has been audited.

## SEC-1 — Known vulnerable TipTap dependency; the open update is incomplete

The fresh audit of the unchanged candidate lockfile returned **one moderate advisory**, zero high/critical advisories: `@tiptap/core 3.30.1`, [GHSA-cp6q-959q-f8rh](https://github.com/advisories/GHSA-cp6q-959q-f8rh), present through 46 dependency paths. The patched range is >=3.30.4. The advisory concerns unsafe attribute merging; application exploitability depends on whether untrusted attributes reach that helper. This audit has not established an end-to-end Deft XSS exploit.

[PR #318](https://github.com/Maneek21/Deft/pull/318) upgrades the direct core dependency but its actual CI logs still report 17 vulnerable transitive paths and mixed 3.30.1/3.30.4 TypeScript incompatibilities. Repair the entire compatible TipTap dependency graph and lockfile; do not bypass type checks or merge this PR as-is.

Acceptance: one compatible patched graph, no advisory in a fresh audit, web typecheck/build, editor formatting/paste/import/attachment tests, and no regression in stored document rendering. Fresh evidence: `tmp/launch-audit-2026-09-05/dependency-audit.json`; [PR audit failure](https://github.com/Maneek21/Deft/actions/runs/33686938377/job/100436531925); [PR type-check failure](https://github.com/Maneek21/Deft/actions/runs/33686938390/job/100436531832).

## SEC-2 — Conditional P1: Native GitHub account linking trusts unbound callback state

[connections.ts:71](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/routes/connections.ts#L71) encodes user/org identifiers as the OAuth state. The [callback:86](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/routes/connections.ts#L86) decodes them and uses them for account persistence without a stored single-use nonce, integrity check, expiry, or initiating-session binding. [auth.ts:22](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/middleware/auth.ts#L22) exempts callback paths from authentication. The existing-account lookup at connections.ts:143 also omits organization scope.

The route is mounted in normal code, but successful provider exchange practically requires configured GitHub OAuth credentials and a valid provider authorization code. Native GitHub OAuth is explicitly outside the public self-hosted-v1 contract, so this is a **conditional enabled-feature blocker**, not a claim that default deployments already link arbitrary accounts.

Remediation: disable the unsupported route in the public configuration, or use a cryptographically random, short-lived, single-use state record bound to the initiating actor, organization, provider, redirect URI, and authenticated session. Recheck active membership and organization at persistence. Replace the broad callback-path auth exemption with narrowly enumerated public routes.

Acceptance: mismatched/expired/replayed state fails before credential persistence; normal callback succeeds once; organization and membership changes invalidate the flow. Real-provider callback certification remains unperformed.

## SEC-3 — P1 session hardening: Web refresh tokens are not consumed on refresh

[auth.ts:225–250](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/routes/auth.ts#L225) checks whether the presented token is revoked, verifies it, and returns newly generated tokens. It never consumes/revokes the presented token. [Logout:253](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/routes/auth.ts#L253) revokes only the supplied token. Older refresh tokens can therefore remain usable until expiry after later refresh/logout activity. This is a replay/revocation weakness conditional on possession of an old token; it is not a login bypass.

Use atomic one-time refresh rotation and a revocable session/token family. Define the intended behavior for concurrent tabs, retry after a lost refresh response, logout, password changes, and member removal. Do not simply add a non-atomic read-then-insert that lets concurrent refreshes both succeed.

Acceptance: refresh A produces B; A cannot be used again according to the chosen race policy; logout of the session invalidates its token family; two concurrent refreshes have a deterministic supported outcome. Keep web JWT-session tests separate from the existing MCP OAuth refresh/replay suite, which exercises a different implementation.

The refresh request also reads and hashes `refreshToken` before schema validation and before the try/catch. Add Zod validation and stable JSON errors for malformed JSON, null, objects, arrays, wrong token type, oversized input, and invalid signatures. Do not expose raw exceptions.

## SEC-4 — P1 public deployment hardening: Dynamic OAuth registration lacks resource limits

[oauth-mcp.ts:98](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/routes/oauth-mcp.ts#L98) exposes dynamic client registration and persists both a client and an audit event. The route is mounted at `/oauth` before the later `/api/*` and authentication rate limiters in [index.ts](https://github.com/Maneek21/Deft/blob/7355c90a0ab5630b839440e8e25133b63853835c/apps/api/src/index.ts). It saves `metadata: body`, including properties beyond the parsed schema. No route-level request budget or body-size limit was found for this path.

Public registration may be required for supported MCP clients; requiring login indiscriminately would break that contract. Add explicit registration and token-endpoint rate/resource limits, bounded metadata, validated-only persistence, expiration/cleanup of unused registrations, and operator observability. Apply the controls to the actual public routes, not only `/api/*`.

Acceptance: ordinary supported client discovery/registration/PKCE flow works; bounded bursts receive structured 429; oversized bodies fail before persistence; unknown metadata is discarded or deliberately bounded; accumulated unused clients are reclaimed. A denial-of-service/load test was not run against a real deployment.

## Strengths and limits

Current source includes active membership checks, scoped MCP identities, separate OAuth replay coverage, guarded App Run execution, purpose-separated encryption/signing/fingerprint keys, action receipts, and numerous permission/regression tests. Fresh focused API tests passed 40 cases, including tenant-bound capability snapshots, connector races, ambiguous outcomes, rollout validation, schedule semantics, and encryption/receipt behavior. The unchanged dependency graph had no reported high/critical advisory at the time queried.

The root checkout's older upload implementation had issues that are already repaired in current master; those were excluded from current findings. The audit does not claim a complete independent security review, proof of all tenant paths, a full secret-history scan, real-provider security testing, or browser exploitability of the dependency advisory. One automated security sub-review was interrupted by its tooling; the primary audit independently inspected the source paths above and treats them as source-confirmed findings, not a completed penetration test.


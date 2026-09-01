# Deft App Platform sandbox email provider

This package is the dependency-free, proof-only MCP provider used by Deft's
connected App conformance path. It exposes exactly one stdio tool,
`send_email`, and performs no network egress. Accepted messages exist only in
the provider process memory and disappear when that process exits.

The provider implements the frozen private sandbox-email schema independently
from `@deft/app-kit`. Repeating the same `idempotency_key` and input returns the
same deterministic result; reusing a key with different input is rejected.

Pack it as a standalone artifact:

```sh
pnpm pack --pack-destination ./dist
```

For a self-hosted proof, install the tarball in an isolated directory, launch
its `server.mjs` with a pinned Node.js executable, and add only that exact
executable path to `MCP_STDIO_ALLOWED_COMMANDS`. Stdio is an explicitly unsafe
self-host operator surface and still requires `DEFT_SELF_HOSTED=true` plus
`DEFT_MCP_ENABLE_UNSAFE_STDIO=true`. Do not add a shell, package runner, or a
broad executable directory to the allowlist.

This is not an SMTP client, newsletter service, production email adapter,
hosted runtime, credential store, or authorization boundary. Deft remains
responsible for grants, review, execution policy, receipts, and tenant-scoped
authorization.

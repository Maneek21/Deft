# Connected App author guide

This guide covers the Phase 6 connected-App journey through its native
lifecycle: an independent author can create, check, build, verify host
compatibility, and locally stage one App Protocol v1 connected App using packed
public artifacts; an authorized workspace operator can then review, bind,
activate, inspect, upgrade, disable, and freshly re-enable it in Deft.

The current authoring artifact is `@deft/app-kit@0.1.0-alpha.1`. Use a packed
tarball of that exact version; do not substitute a monorepo workspace link or
import private Deft packages.

## 1. Use the pinned proof artifacts

The
[machine-readable connected proof bundle](../examples/app-platform-connected-proof-bundle.json)
is the source of truth for the proof inputs. It records the pinned Contacts App
package digest and the separately packed sandbox-email provider's canonical
payload digest and retrieval path. The provider pin hashes the exact packed file
paths, lengths, and contents; raw `.tgz` wrapper bytes are not the identity
because tar metadata differs across operating systems. Verify the installed
payload against the recorded values rather than copying a digest from prose.
The connected template depends on the exact Contacts App and does not bundle or
copy its records.

To create the App Kit tarball from a matching Deft checkout:

```sh
pnpm --dir packages/app-kit pack --pack-destination /absolute/path/to/artifacts
```

Then install it in a clean directory outside the repository:

```sh
mkdir connected-campaigns
cd connected-campaigns
pnpm init
pnpm add --save-dev /absolute/path/to/artifacts/deft-app-kit-0.1.0-alpha.1.tgz
```

When a release or proof bundle already supplies the tarball, install that exact
artifact instead of repacking it.

## 2. Choose the template deliberately

The declarative compatibility default is unchanged:

```sh
pnpm exec deft app init
# Byte-identical alternative:
pnpm exec deft app init --template declarative
```

It creates an App Protocol v0 manifest, one Module v1 manifest, `APP_BRIEF.md`,
scoped `AGENTS.md` guidance, and `.gitignore`. Protocol v0 has no dependency,
capability, connector, action, runtime, or connected permission vocabulary.

Create the connected scaffold in a different empty directory:

```sh
pnpm exec deft app init --template connected
```

That command creates:

- an App Protocol v1 manifest;
- a Module v2 `campaigns` resource with a relation to Contacts;
- the exact `org.deft.reference.resource-contacts-app` version `1.0.0`
  dependency and its required `contacts.email` field;
- the lineage-private `sandbox_email_send` version `1` capability request;
- an existing-provider `mcp` connector requirement; and
- one host-rendered, single-recipient `send_campaign_email` action binding.

Malformed template arguments are rejected. `init` also refuses to replace an
existing `deft.app.json`.

### Safe changes to the connected scaffold

Stay inside the published manifest and Module contracts. Dependencies and
resource requirements use exact versions and fields. Resource relations refer
to the dependency's records; they do not copy those records into the App. The
only connected capability in v1 is the frozen sandbox-email interface, and its
connector requirement selects only a provider kind, never an endpoint or
credential.

Action inputs may come only from a declared resource field, one selected
declared relation target, or explicit typed user input. Do not add templates,
JSONPath, arbitrary transforms, scripts, URLs, environment reads, secrets,
provider configuration, automation, custom UI, sync, or public routes. An App
id or publisher label cannot choose the private interface namespace; the host
resolves it from immutable workspace App lineage.

## 3. Check and build

Run the deterministic author loop from the App directory:

```sh
pnpm exec deft app check
pnpm exec deft app build
```

`check` reads `deft.app.json` and every referenced Module, rejects symlinked or
non-regular artifacts, recomputes their digests, and validates/builds in memory.
It does not write build output.

`build` performs the same checks and writes:

| Path | Meaning |
|---|---|
| `.deft/app.deftapp.json` | Integrity-checked package sent to the host |
| `deft.app.lock.json` | Package, manifest, and artifact digests; `permissions` remains empty |
| `.deft/requested-authority.json` | Deterministic author review of requested authority only |

Rebuilding unchanged input produces byte-identical output.

### Requested authority is not effective authority

For v0, `.deft/requested-authority.json` contains empty requirement and resource
right lists. For v1, it projects the declared dependencies, resources,
capability, connector, and action; read-only requested resource fields; and the
Deft-owned sandbox policy floor. Its classification is
`authority_state: "requested_only"`, `executable: false`, and
`provider_access: false`.

The report deliberately omits organization, installation, version, grant,
binding, connector, provider, token, secret, and private-lineage identities. It
is not part of the installable package and is not accepted by the host as a
grant. Editing or deleting it cannot widen the App; the next build regenerates
it. The host inspects the package, reprojects the request, and owns every
effective grant and binding.

## 4. Check the host before pairing

The host API must have both exact opt-ins enabled:

```text
DEFT_APPS_ENABLED=true
DEFT_APP_DEVELOPER_PAIRING_ENABLED=true
```

Point the CLI at the API, not the web port:

```sh
pnpm exec deft app doctor --url http://localhost:3001
```

`DEFT_URL` supplies the same value when `--url` is omitted; the final default is
`http://localhost:3001`.

`doctor` validates the local source and then checks the developer-status
contract. A compatible current host retains the legacy fields
`app_protocol: "0"`, `audience: "app-developer"`, and
`single_use_install: true`, and adds this exact flow information:

| Local protocol | Package format | Advertised install mode |
|---:|---|---|
| v0 | `deft.app.package.v0` | `stage_and_activate` |
| v1 | `deft.app.package.v1` | `stage_only` |

The additive compatibility object must include `@deft/app-kit` version
`0.1.0-alpha.1`. The legacy `app_protocol: "0"` scalar remains `"0"` even when
the additive object advertises v1; do not use that scalar alone to infer v1
support.

A legacy host that omits the compatibility object is accepted for v0 only. A v1
project fails with `Host supports only App Protocol v0 developer installs`.
Wrong App Kit versions, missing protocol flows, and package-format mismatches
also fail. `install-local` performs this same compatibility preflight before it
reads or exchanges a pairing code.

On success, `doctor` reports the exact App Kit package and version, App Protocol
version, package format, install mode, and host URL. This is compatibility
evidence only; it does not verify a registry, publisher identity, or package
signature and does not establish trust.

`doctor` checks App Kit/protocol/package compatibility only. It does not check
connector health, simulate grants, activate an App, resolve relations, invoke a
provider, or prove App Run readiness.

## 5. Stage with a one-time pairing

An active workspace owner or admin must create an expiring, revocable,
single-use developer pairing and give its code to the author. The CLI cannot
create a pairing or grant itself manager authority.

```sh
pnpm exec deft app install-local --url http://localhost:3001
```

At the prompt, enter the code once. The CLI rebuilds the package, completes the
compatibility preflight, exchanges the code for an audience-bound temporary
session, and submits the package. The host inspects the package before consuming
that session and rechecks that the pairing owner is still an active owner or
admin.

The result depends on the protocol:

| Protocol | Result of `install-local` | Authority result |
|---:|---|---|
| v0 | Stage and activate the declarative App | No connected authority exists in v0 |
| v1 | Leave the installation/version in `staged` | Zero effective grant, dependency lock, action binding, connector change, provider call, approval, or App Run |

For v1, the author stops at the staged result. Hand the installable package,
lockfile, requested-authority report, exact App Kit artifact identity, and
proof-bundle identity to the owner/admin. Review, dependency validation,
provider binding, effective-grant creation, and activation are host-owned
operations; none can be encoded in the App package or requested-authority
report.

## 6. Complete the native operator lifecycle

In **Settings → Apps**, an active owner or admin can inspect the exact staged
version and package digest, requested resource reads, dependency status,
lineage-private capability requirement, eligible connector candidates, and
missing bindings. The screen labels local packages as unsigned and treats any
declared source repository and commit as an unverified author claim.

The operator selects exact connectors and runs review. Deft refreshes provider
schemas at review time, computes the deterministic authority diff, and requires
explicit acceptance of the host-owned approval, retention, egress, and retry
policy before activation. Reloading the page does not lose the staged target;
the host derives it from persisted installation and version state.

An active or disabled connected App can stage a higher-version package through
the same screen. The current version and effective authority remain unchanged
until the upgrade receives its own exact review and atomic activation. When
more than one higher version is staged, Deft selects the highest version as the
only reviewable target; a client cannot activate an older staged package around
that selection. Disable preserves data but clears active authority. The generic
legacy enable path is intentionally unavailable for Protocol v1; **Re-enable**
performs a new review
against live membership, dependencies, connector authorization, provider
schema, grant epochs, and bindings before restoring authority.

Recent App Runs expose bounded safe status, policy, retention, and
server-verified receipt metadata only to a caller already authorized to inspect
that exact Run. The response omits raw provider envelopes, signatures,
ciphertext, output payloads, and cross-actor metadata. A manager may therefore
see a safe recent-Run summary but be denied its receipt detail when they were
not an authorized Run actor.

## 7. Run the proof-only sandbox provider

The standalone
[sandbox email provider](../examples/app-platform-sandbox-email-provider/README.md)
implements the frozen interface independently from App Kit. It has no
dependencies and no network egress. Pack and install it separately from the App
and App Kit:

```sh
pnpm --dir examples/app-platform-sandbox-email-provider pack --pack-destination /absolute/path/to/artifacts

mkdir sandbox-email-proof
cd sandbox-email-proof
pnpm init
pnpm add /absolute/path/to/artifacts/deft-app-platform-sandbox-email-provider-0.1.0-alpha.1.tgz
node node_modules/@deft/app-platform-sandbox-email-provider/server.mjs
```

The process reads one JSON-RPC message per line from stdin. Paste these lines to
perform a direct discovery and call proof:

```jsonl
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual-proof","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_email","arguments":{"to":"ada@example.test","subject":"Analytical Engines","body_text":"Hello Ada","idempotency_key":"campaign:one/contact:ada"}}}
```

The final response contains this deterministic structured result:

```json
{"message_id":"sandbox_a90928f63948386da7c8a7a4","status":"accepted"}
```

Repeating the exact call in the same process returns the same result. Reusing
the key with different input is rejected. State exists only in process memory
and disappears at exit. `accepted` means accepted by this in-memory proof; it
does not mean an email was delivered.

For a self-host proof only, install or mount the packed provider read-only, use
an absolute pinned Node.js executable as the stdio command, and pass the
read-only absolute `server.mjs` path as its sole argument. Stdio is host-code
execution and requires all three exact controls:

```text
DEFT_SELF_HOSTED=true
DEFT_MCP_ENABLE_UNSAFE_STDIO=true
MCP_STDIO_ALLOWED_COMMANDS=/absolute/path/to/node
```

`MCP_STDIO_ALLOWED_COMMANDS` is a comma-separated exact-command allowlist. Do
not allowlist a shell, PowerShell, `cmd`, `pnpm`, `npm`, `npx`, a package runner,
or a broad directory. Configuring this proof provider does not bind it to an
App, grant provider access, or make a staged App executable.

## Current boundaries

- No self-grant: packages and reports request authority; only the host can
  create effective grants, bindings, and activation state.
- No author self-activation: author tooling ends at zero-authority staging;
  reviewed App-origin execution remains host-owned and feature-gated.
- No production email: the sandbox provider retains in-memory proof results and
  performs no network egress.
- No automation: the v1 sandbox action is human-initiated, single-recipient,
  always reviewed by host policy, and forbidden in automation.
- No external runtime promise: App Kit contains no MCP loader or hosted runtime,
  and the standalone provider is not a general runtime, SMTP adapter, sync
  engine, credential store, or public ingress service.

Staging needs no App Run keyring because it creates no Run. An operator who
enables reviewed App-origin execution must follow
[Governed App Run operations](app-run-operations.md), including matching
database/keyring backup and restore.

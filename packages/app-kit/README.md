# `@deft/app-kit`

Portable, deterministic authoring and packaging contracts for declarative Deft
Apps. The package includes the `deft` CLI, strict App Protocol v0, v1, and v2
validators, requested-authority projection helpers, developer-host
compatibility helpers, frozen sandbox-email conformance vectors, and a
non-executable bounded-automation simulator.

Parsing or building an App proves package structure and artifact integrity only.
Installation, authorization, effective grants, tenant isolation, dependency and
connector selection, activation, execution, and full Module validation remain
host responsibilities.

## Install the packed kit

From a Deft checkout, create the exact package artifact:

```sh
pnpm --dir packages/app-kit pack --pack-destination /absolute/path/to/artifacts
```

Install that tarball in a clean App directory rather than using a workspace
link:

```sh
mkdir connected-campaigns
cd connected-campaigns
pnpm init
pnpm add --save-dev /absolute/path/to/artifacts/deft-app-kit-0.1.0-alpha.2.tgz
```

The installed binary is available as `pnpm exec deft`.

## Authoring loop

```sh
# Protocol v0; omitting --template remains the byte-identical default.
pnpm exec deft app init --template declarative

# Or, in a different empty directory, Protocol v1 connected scaffolding.
pnpm exec deft app init --template connected

# Or add one requested-only bounded daily action declaration.
pnpm exec deft app init --template connected-automation

pnpm exec deft app check
pnpm exec deft app build
pnpm exec deft app permissions diff
pnpm exec deft app simulate-automation --fixture fixtures/ordinary-ready.json
pnpm exec deft app doctor --url http://localhost:3001
pnpm exec deft app install-local --url http://localhost:3001
```

`init` accepts only `declarative`, `connected`, or `connected-automation`.
`check` validates and builds in memory without writing generated artifacts.
`build` writes the deterministic
package, lockfile, and requested-authority report:

- `.deft/app.deftapp.json`
- `deft.app.lock.json`
- `.deft/requested-authority.json`

The requested-authority report is non-authoritative review material. It contains
only App-authored requirements, projected read requests, and Deft-owned policy
classification. It contains no effective grant, host identity, connector or
provider selection, token, secret, or private lineage identity. Editing it
cannot affect installation or authority; a build overwrites it and the host
derives its own validated view from the package.

## Protocol and local-install behavior

| Template | Protocol | `install-local` flow | Connected authority |
|---|---:|---|---|
| `declarative` | v0 | Stage and activate | None; v0 cannot request capabilities or connectors |
| `connected` | v1 | Stage only | None until separate host review, binding, grant, and activation |
| `connected-automation` | v2 | Stage only | None until separate host definition review, exact pins, approval, and activation |

Both `doctor` and `install-local` build the local source and compare its protocol
and package format with the host's advertised compatibility contract. The host
must advertise this exact App Kit version. A legacy status response without the
additive compatibility object remains usable for v0 only; it rejects v1 with
`Host supports only App Protocol v0 developer installs` before a pairing code is
read or exchanged.

App Protocol v1 is a closed connected contract. It adds exact App dependencies,
Module resource and field requirements, one private sandbox-email capability,
an existing MCP-connector requirement, and closed host-rendered action bindings.
Staging grants zero authority and cannot create a connector, discover or invoke
a provider, create an App Run, or activate the App.

Private interface keys are relative to the immutable workspace App lineage
selected by the host. An App id, repository, publisher label, or other
package-authored text cannot choose that authority namespace.

The v1 action source language is intentionally closed: declared resource fields,
one selected declared relation target, or explicit typed user input. Templates,
JSONPath, arbitrary transforms, scripts, URLs, environment values, secrets,
automation, runtimes, sync, custom UI, and public ingress are not part of this
protocol.

Protocol v2 adds only a requested daily trigger over an existing action with no
user input. Apps cannot choose time, timezone, resources, provider, policy,
budget, or validity. `diffDeftAppRequestedAuthority` compares portable requested
declarations only. `simulateDeftAppAutomation` and
`nextEligibleAppAutomationOccurrence` reuse the exact pure timezone, DST, and
misfire rules used by the host, validate frozen provider inputs, and report pin
drift; neither helper grants authority, resolves live workspace data, or runs a
provider.

See the [connected App author guide](../../docs/connected-app-author-guide.md)
for the packed-artifact workflow, native operator lifecycle,
sandbox-provider proof, and current boundaries.

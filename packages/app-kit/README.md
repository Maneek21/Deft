# `@deft/app-kit`

Portable, deterministic authoring and packaging contracts for declarative Deft
Apps. The package includes the `deft` CLI, strict App Protocol v0, v1, and v2
validators, requested-authority projection helpers, developer-host
compatibility helpers, frozen sandbox-email conformance vectors, and a
non-executable bounded-automation simulator.

Parsing or building an App proves package structure, artifact integrity, and
static Module validity using the same pure semantic validator as the host.
Installation compatibility, required setup, authorization, effective grants,
tenant isolation, dependency and connector selection, activation, and execution
remain host responsibilities.

## Module validation

`validateDeftModuleManifest` returns every static validation issue with the
artifact path, field path, reason, and an actionable correction. The throwing
`assertValidDeftModuleManifest` variant is also exported. `prepareModuleArtifact`,
App builds, and package verification run this validation automatically.

```ts
import { validateDeftModuleManifest } from '@deft/app-kit';

const result = validateDeftModuleManifest(moduleManifest, {
  artifactPath: 'modules/equipment/deft.module.json',
});
if (!result.success) console.error(result.issues);
```

The published package contains a build-time copy of the authoritative pure
contract from `@deft/shared`; it has no runtime workspace link or private host
import. Static validity does not imply that a particular host supports the App,
that required dependencies are installed, or that a caller has permission to
install or operate it.

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
pnpm add --save-dev /absolute/path/to/artifacts/deft-app-kit-0.1.0-alpha.3.tgz
```

The installed binary is available as `pnpm exec deft`.

This checkout contains the unreleased `0.1.0-alpha.3` contract. Use its exact
packed artifact with a host advertising that version; published preview.15
uses `0.1.0-alpha.2`. A version identifies a released contract: do not distribute
changed contracts under an existing version. Preserve the supplied artifact and
the consumer lockfile for reproducible installs instead of repacking a different
checkout under the same package version.

## Host presentation and access

App navigation may select a declared collection and a `view_key` belonging to
that collection. Deft owns the renderer and adds a **Linked tasks** workspace
for native tasks linked to Module records. This host-provided navigation is
available alongside authored navigation; it adds no CRM collection, task
permission or automatic task creation. The older `workspace=follow-ups` URL
remains a compatible link to this workspace.

Module icons are bounded tokens, not URLs or markup. This host recognizes
`book`, `briefcase`, `calendar`, `contact`, `contacts`, `database`, `folder`,
`package`, `table`, `users`, and `boxes`. Other valid tokens intentionally use
the generic boxes icon, allowing packages to remain compatible with hosts that
do not recognize a token. Authors should use a listed token for predictable
presentation on this host.

Module records currently use workspace-level access. A member field named
`owner` is ordinary business data and does not create record or field ACLs.
Personal MCP connections act with their user's access and explicit scopes;
the Module's `agent_access` policy controls Defty and agent employees. Linked
native tasks retain their own visibility rules.

Connected Apps currently request the closed `sandbox_email_send` interface.
Operators select a compatible provider and grant authority in Deft. An author
cannot introduce a new executable interface merely by naming an MCP tool.
Supporting another capability requires a host contract implementation and
conformance checks. Sandbox acceptance does not establish message delivery.

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

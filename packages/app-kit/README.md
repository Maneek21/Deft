# `@deft/app-kit`

The alpha.33 candidate adds provider-independent principal identifiers, declared resource source types/search fields, `record_form.v3`, and one sealed supplemental effect per action. Email grammar and provider outcomes belong to the external Email Runtime. The current App1.9.0-preview.1 / Runtime0.4.0-preview.1 candidate uses alpha.33 and is reviewed in [Email PR1](https://github.com/Maneek21/deft-email/pull/1). Existing sealed alpha.30/alpha.32 packages and their exact proofs remain historical inputs.

Record form v3 declares scalar fields, optional mailbox-list pill controls, verified identities, trusted rich text/files, labels and review captions. Field names do not select product behavior. Existing record revision, content digest, source reference, unsaved seed and action fences still apply. A Runtime independently validates domain data before preparing an effect.

A record store may declare `supplemental_effects` with a closed bounded `RuntimeObjectSchema`. `parseAppPreparedEffectDetails` checks declared detail fields; the Host also verifies the canonical plan digest, account, action binding, custody generation and exact prepared input. `deft.app_run_inspection_result.v2` carries generic primary/effect outcomes and immutable receipt pins, with automatic retry forbidden. Old sent-copy contracts remain for historical metadata, not the new execution path.

Authors build against the packed package without a Deft checkout. Existing programmatic protocol 7 packaging APIs and public sideload review remain the install path; this change adds no CLI or implicit activation. The candidate requires a compatible Host implementation and fresh installation evidence before independence acceptance.

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

The packed package contains a build-time copy of the authoritative pure
contract from `@deft/shared`; it has no runtime workspace link or private host
import. Static validity does not imply that a particular host supports the App,
that required dependencies are installed, or that a caller has permission to
install or operate it.

## Install the packed kit

Authors install the reviewed packed artifact; no Deft checkout is required. SDK maintainers can optionally rebuild it from the complete corresponding source:

```sh
pnpm --dir packages/app-kit pack --pack-destination /absolute/path/to/artifacts
```

Install that tarball in a clean App directory rather than using a workspace
link:

```sh
mkdir connected-campaigns
cd connected-campaigns
pnpm init
pnpm add --save-dev /absolute/path/to/artifacts/deft-app-kit-0.1.0-alpha.33.tgz
```

The installed binary is available as `pnpm exec deft`.

This review candidate is `0.1.0-alpha.33`. Package metadata,
`DEFT_APP_KIT_VERSION`, and CLI compatibility output use that identity. Alpha.33
retains connection v2 sessions and independent action consents, reviewed
same-account upgrade/reattachment, consent continuation and credential repair,
resource data/content contracts, attachments, safe compose HTML, and generic
source/Task integration. These are contracts; a compatible Host must advertise
and authorize the corresponding operations.

### Historical recovery artifacts

The matching historical external Email review is
[deft-email PR #1](https://github.com/Maneek21/deft-email/pull/1). Its
[historical setup instructions](https://github.com/Maneek21/deft-email/blob/4c33dca127f799ff43a318625319808266799366/docs/setup.md)
retain the exact frozen consumer proof.
The frozen Email browser package `1.8.0-preview.1` uses **alpha.30**, while its
independent Runtime `0.3.1-e5.9` uses **alpha.32**. Do not replace the browser
Kit or regenerate its accepted App package merely to make both versions equal.

[Historical recovery Email setup](https://github.com/Maneek21/deft-email/blob/015e60ae0fd500ab3bf5f8df4140a93572d65671/docs/setup.md)
is pinned to the reviewed recovery source: App `1.8.0-preview.2` still uses
**alpha.30**; Runtime `0.3.1-e5.11`, including the Refresh UUID fix, still uses
**alpha.32**. This updates the consumer pointer, not the SDK matrix or frozen
artifacts; Host/fresh-install acceptance remains a separate gate.

The recorded alpha.32 tarball SHA256 is
`44a4419d6f40320650f20f89d6a99ee3ee0631e613843439fc349849f5a35ddb`;
retain its hash and the external consumer lockfile. Those recovery documentation
updates did not change the SDK executable; rebuilding today's package does not reproduce the old
README bytes and must not overwrite that frozen archive.

The matching Host review follows this Author Kit PR in the Deft review stack.
The tested Host image metadata is `0.3.0-preview.16`, while database schema and
runtime readiness report `0.3.0-preview.117`; those versions are distinct.
Public `master` and a Kit install alone do not provide the required Host gates,
owner admission/resource/action reviews, operator registry, keyring, or OAuth
connection authority. Check the host's public developer compatibility before
staging. New accounts use ordinary public connection begin/callback; existing
account continuity uses the separately reviewed current-authority flow.

Packing includes repository `LICENSE` and `NOTICE`; the package remains
`AGPL-3.0-only`. No npm publication, tag, release, merge or automatic merge is
part of this review. Historical package archives remain unchanged. Alpha.8 and
alpha.9 are not advertised because their recorded compatibility identity was
not reconciled; use the exported compatibility list rather than assuming
all lower numbers are supported.

## Browser Experience SDK

Import the browser-only SDK into the Worker from its public leaf entry:

```ts
import { createDeftExperienceSdk } from '@deft/app-kit/experience';

const sdk = createDeftExperienceSdk(port, sessionId);
```

Keep package construction, validation and `prepareDeftExperienceArtifact` in a
Node build script importing `@deft/app-kit`. The root export remains supported,
but bundling it into a Worker can retain the authoring validators and exceed the
64 KiB artifact limit. The browser entry has no runtime imports, host credentials
or direct workspace API access. Normal bundling needs no side-effect overrides
or private `dist` imports. Install the bundler in the author project itself;
building a Worker must not depend on a Deft checkout's `node_modules`.

SDK availability does not grant resource or action authority. The host must
support the declared protocols and separately authorize each operation.

### App sidebar navigation

Hosts with Experience sidebar support accept `sdk.render({ root, navigation })`.
The optional `navigation` array contains up to 16 existing `button` nodes, using
`label`, `selected` and `disabled` for the sidebar presentation. IDs must be
unique across navigation and content. Do not repeat these buttons in `root`.
Clicks arrive through the usual `sdk.onEvent` handler as `click` events with the
same node IDs; they do not navigate away or restart the Worker. No URLs, HTML or
additional authority are accepted. Navigation is cleared when the app is hidden
or its session ends. Older hosts reject the field, so deploy supporting hosts
before upgrading an author that emits it.

### Private state and source panels (Protocol 7)

Hosts that enable private App state accept an optional `private_state` array in
a Protocol 7 manifest. Each entry declares a key, label, bounded scalar object
schema, per-record and total byte limits, record limit, and retention. Declare
the keys used by a Worker in an Experience bundle with
`schema_version: 'deft.experience_bundle.v3'` and `state_keys`. This bundle also
supports the existing optional `search_resource_keys`; it does not change older
bundle bytes or grant search implicitly.

State requires an explicit owner review for the exact installed artifact. It is
encrypted and scoped to organization, owner, installation and declaration, and
is excluded from workspace search and AI context. The host ceilings are 16 KiB
per record, 32 live records, 128 KiB per key and 30 days from creation. Updating
a record does not extend its expiry. Records use opaque UUIDs and revision
compare-and-swap; callers must handle conflicts without overwriting another
edit. Deleted identifiers remain tombstoned until their original expiry.

The browser SDK exposes `listPrivateState`, `readPrivateState`,
`putPrivateState`, and `deletePrivateState`. An App upgrade does not silently
give new code access to records sealed for an older artifact. The host offers
the owner a separate recovery review for compatible declarations, preserving
the original expiry. Author code cannot approve this recovery itself.

For an attachment-backed declared resource, `sdk.openResource(key, recordId)`
asks the host to open the selected source's files and follow-ups panel. It
returns only `{ opened: true }`. The host verifies the current owner, accepted
Experience exposure, binding and live record; it does not accept an authored
URL. Downloads and normal Task creation remain host interactions. A Task starts
with a fixed-label source link, without copying private record fields. A source
link does not grant another user permission to read it. Unsupported hosts deny
this optional operation.

Workers run in an isolated browser context. Do not assume APIs restricted to
secure contexts, such as `crypto.randomUUID`, are present. When allocating
UUIDs, feature-detect it or construct a valid UUID with `crypto.getRandomValues`;
never replace cryptographic randomness with `Math.random`. Verify the actual
sandboxed browser journey as well as a bundled Worker simulation.

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

The protocol 1/2 connected templates and `sandbox_email_send` examples below retain frozen compatibility for existing CRM/Campaign Apps. They are not the current independent Email onboarding path and do not restore the built-in mailbox product. Current independent Email uses protocol 7 declarations, external Runtime custody and public stage/review/activation. Provider behavior belongs to the App Runtime; naming a capability or MCP tool grants no authority. Historical sandbox acceptance never established message delivery.

## Historical CLI authoring loop

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

### Trusted human actions and durable private access

A supporting host can retain a revocable, exact-scope private-access grant separately
from its short-lived Experience session. The host renews technical leases while the
same authenticated user remains authorized. App code cannot renew or expand consent;
revocation, changed permissions and changed verified app authority require review.
Existing session-only grants are not automatically converted to persistent grants.

For a human-authored external action, request the host-owned composer using the
existing dialog operation with key `compose_action` and this bounded payload:

```ts
{ action_key: 'declared_action', input: { /* proposed scalar values */ },
  draft_state_key: 'declared_private_state', draft_id: 'existing-record-uuid' }
```

The draft must already exist in the declared encrypted private state. The host
reads the current action schema and draft, owns the editable form, and binds its
final Send interaction to every exact input field. Same-name draft fields are
saved with revision CAS. The dialog returns `{ run: { id, state, submitted_input? } }`,
`{ cancelled: true }`, or an uncertain outcome. An interrupted dialog is not
proof that no effect occurred. Keep the original draft identity and reconcile its
Run; never automatically create a new send identity after an uncertain outcome.
The host uses that identity for duplicate prevention across technical sessions.

The author never receives an authorization ticket or a privileged Send operation.
Ordinary `action` requests retain their governed approval path. Human private
access does not grant agent execution permission. Agent requests use a separately
configured owner policy, defaulting to denial; permitted requests still require
human approval. Provider credentials remain outside the Worker and host form.
This composer supports the existing closed scalar action contract. Undeclared
fields, including unsupported attachment inputs, are rejected rather than ignored.


Scalar string contracts may declare `minLength`, `format: 'email'`, `title`, and
`readOnly`. The host enforces declared validation before admitting an action;
`readOnly` is a presentation hint, not an authorization grant. Source references
remain inspectable in the trusted form. A fresh successful confirmation includes
`submitted_input`, the exact authorized scalar values, for accurate app history.
Recovered Run lookups may omit it; a mutable draft is not evidence of the submitted
content. These additions require a host supporting the alpha.7-era contract or
a host advertising the matching packed contract.

# Author Kit domain ownership, alpha.40

The Host must validate untrusted app output without executing an app parser.
Production address, compose, signature-body, CID and raster behavior belongs to
deft-email. Sandbox send contracts are optional educational tooling, not Host
capability registrations. This implements plan D without changing wire versions.

## Decision

Use separate implementations with explicit ownership: deft-email maintains its
author/runtime TypeScript sources and generated JavaScript under `runtime/domain`.
Kit maintains `safe-rich-text`, `safe-uri`, `safe-raster`, and the bounded
`structured-address` safety grammar required by existing Contacts, Calendar and
trusted field controls. The latter preserves existing field wire spellings and
limits; it does not call the app's production parser or construct provider payloads.
The rich-text URI gate independently validates a single `mailto:` URI target; it
does not call a mailbox-list parser. Existing CID/node spellings remain serialized
compatibility data and still require exact scoped file context.

Named-principal lists also support opaque values such as `warehouse:west/42`.
The retained URI field profile delegates target admission to `safe-uri`; the list
module has no production address/domain parser. Tests preserve the existing URI
field's formatting and rejection behavior while proving opaque principals do not
inherit Email semantics.

Keeping all production mail code under an optional Kit subpath would reduce the
initial copy, but retain the wrong maintenance owner. Removing the public names
immediately would break alpha.38/39 source consumers. Instead, explicit deprecated
re-exports keep the old root and `/experience` names available until **next breaking
Kit alpha**. Replacement guidance appears in emitted declarations. Production
authors migrate to deft-email's library; educational sandbox users explicitly
select `@deft/app-kit/examples/email`.

`@deft/app-kit/core` and `@deft/app-kit/experience/core` contain no compatibility
imports. All Host imports use those entry points. The compatibility root loads the
optional historical profile for old author tools; importing the clean core alone
registers no private operations. Trusted tooling profiles are write-once and are
never loaded from manifest data. Host therefore fails closed for unregistered
historical sandbox operations. No app gains an executable operation by declaring
its key, and this does not change installed Runtime v3–v7 contracts.

The generic core validates v1/v2 bindings through a registered trusted descriptor,
without recipient/subject/body branches. The sandbox schema, policy, templates,
binding specialization and vectors live together in the optional example. Its
CLI is `deft-example-email`; default `deft` and its conformance output carry no
sandbox-specific data. Existing source fixture examples use that explicit CLI.

## Inventory and evidence

The [machine-readable baseline inventory](../reports/2026-10-20-kit-domain-consumer-inventory.json)
records both repositories' immutable starting commits, all public exports in both
alpha.38/39 entry points, all deprecated names, and the entrypoint references in
357 consumer files. Its focused list also covers every source reference to the
35 extracted symbols, including namespace users, direct internal imports,
Host API/web, the historical in-repo app, external app build and Runtime tests.
Generated `.d.ts` ownership follows the same facades and optional subpath.

`packed-transition.test.ts` packs and installs the real tarball externally, compiles
an unmigrated alpha.38/39 root and `/experience` fixture, builds a non-mail Runtime
example, and bundles a non-mail Worker with a metafile assertion excluding all
mailbox/sandbox/compose modules. It also verifies default conformance output and
deprecation declarations. `safe-rich-text.security.test.ts` checks independent
Host rejection and frozen URL/CID/projection parity. Existing Host rich-text tests
now cross that independent interface. deft-email owns the copied security and
budget corpus and runs it in its CI alongside app/Runtime tests.

Rollback restores previous app and Kit tarballs, without relaxing Host validation
or migrating retained data. alpha.40 is packed for certification only; publishing
it and releasing Host 129 belong to the coordinated Host release job. The Email
PR remains unmerged until instructed and must receive the release-flow tarball
before approval to merge; a local certification candidate is not a publication.

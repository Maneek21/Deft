# Contacts CRM author project

This project is generated from the canonical Contacts Module with the public `@deft/app-kit` package.

The exporter uses the system `tar` command to inspect a supplied package archive.
When this project was exported with a packed Kit argument, the exporter copied
the exact matching artifact to `vendor/deft-app-kit.tgz` and configured the
local dependency. Run:

```sh
pnpm install
pnpm run build
```

`pnpm run build` writes the connector-free base package to
`contacts-crm.deftapp.json`. To produce the connected upgrade later, run
`pnpm run buildConnected`; it writes the upgrade to that same path, so keep a
copy of the base package if you need both files at once.

Use `pnpm install --offline` only when the complete dependency graph is already
in the local pnpm store; the Kit tarball alone does not provide transitive
dependencies.

For an export without a tarball argument, place the matching artifact at that
path and run `pnpm add --save-exact ./vendor/deft-app-kit.tgz` before the install
commands above. If using the public registry instead, run `pnpm install` and
verify the installed version matches the host contract; offline installation
also requires cached transitive dependencies.

The default outputs are base App `1.8.0` and connected App `1.9.0`. To author an
intentional custom connected release, use
`node build.mjs --connected --app-version 2.0.0`.

The base package is connector-free and uses App Protocol 0. Install its built
artifact through the supported package upload flow:

1. Sign in as a workspace owner or admin and open **Settings -> Apps**.
2. Expand **Add or build an App**, choose **Inspect package**, and select
   `contacts-crm.deftapp.json`.
3. Review the identity, version, digest, included Module, and provenance, then
   choose **Stage with no rights**.
4. Open the staged App and choose **Activate**.

Artifact upload does not require developer pairing. For an active base v0
installation the upgrade control is **Stage connected upgrade**; for an
already connected installation it is **Stage upgrade**. Review the requested
authority before activation; staging alone grants no rights.

This exported project uses a CRM-specific builder and does not contain the
generic CLI source file `deft.app.json`. Do not run `deft app install-local`
from this directory: that command is for projects initialized around
`deft.app.json`. Upload the built `contacts-crm.deftapp.json` artifact instead.

The connected package keeps the same App ID and Module lineage, advances the
App version, and requests the reviewed sandbox email capability and connector.
To upgrade an active base installation, open it in **Settings -> Apps**, choose
**Stage connected upgrade**, select the connected `contacts-crm.deftapp.json`, and
complete the exact connector and authority review before activation. Staging
alone grants no connected authority.

Authors can extend `modules/contacts/deft.module.json` with declarative collections, fields, relations, views, and navigation, then rebuild. Host and Kit source changes are not required for domain-specific declarations.

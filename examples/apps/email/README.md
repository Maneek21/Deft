# Email WIP example 1.5.4

This AGPL-3.0-only source example consumes the packed `@deft/app-kit` 0.1.0-alpha.6 candidate. It requires the matching Deft host candidate (0.3.0-preview.16); neither release is published by this change. The example is a work in progress, not an everyday mail client.

From the repository root, pack the Kit without publishing. Copy this example source and that tarball into a fresh directory outside the monorepo before installing:

```sh
pnpm --dir packages/app-kit pack --pack-destination examples/apps/email
# In the independent directory containing source and tarball:
pnpm install --frozen-lockfile
pnpm test
pnpm run build
pnpm run smoke:mailbox
pnpm run smoke:activity
```

The lockfile pins the local `deft-app-kit-0.1.0-alpha.6.tgz` dependency and its integrity. For an independent consumer, copy this source directory and that exact packed artifact into a fresh directory outside the repository, then run the same install, checks, and build there. The tarball, installed dependencies, bundles, package JSON output, and local reports are intentionally excluded from source control. `app.deft.json` is the resulting installable package; the build also writes its artifact and digest evidence locally.

Install through the normal authenticated App host interface. The operator must enable the relevant default-off App flags, consent to requested capabilities, bind the current mail and sync providers, and configure host-owned action policy. The package requests authority; installation alone grants no mailbox access or external writes. See [host and release boundaries](../../../docs/app-release-boundaries.md).

The provider CLI accepts `node provider-cli.mjs sync|runtime|sync-daemon /absolute/path/private-config.json`. Its configuration and referenced account file belong outside the public source tree. It requires a current scoped host session credential, explicit `account_file`, and, for sync, private inventory, stage journal, and recovery paths. The daemon additionally requires the owner's admission credential. Keep credentials, mailbox data, journals, and generated evidence private. Do not use the loopback fixture option for real providers. Runtime calls accept only the three declared mail actions; host admission and human approval govern execution.

The source supports one account, one recipient per invocation, and plain text outgoing messages with no outgoing attachments. Private draft quota is 32 records, including submitted drafts, with 30-day retention. Archive follows legacy human approval. Real-provider behavior and recipient delivery remain unproven. Development supervision and recovery require manual operation. Historical unknown sync outcomes can block upgrades; there is no complete normal owner reconciliation flow for those outcomes. Observation recovery preserves prior receipts and checkpoints and does not establish that an unknown operation failed.

Version 1.5.4 is a built candidate suitable for fresh-install validation. The existing preview remains on 1.5.3 because its historical unknown sync outcome blocks upgrade. The synthetic campaign proof exercised standard MCP and the native executor seam; a new complete Defty model turn was not verified. Portable tests exercise author logic and simulated views, without sending mail. Host-specific compose/bridge checks remain separate from this portable source.

The export derives from the independently built Email 1.5.4 author source; presentation changes preserve the previous manifest contracts except version and Experience artifact. Its frozen package digest was `sha256:f7307b42ce5eead5daf2b6bab1917f9ee9652ab94198b57768c067011ee7492b`. A later source or dependency change requires a new build and digest comparison.

# Email WIP example 1.5.5

This AGPL-3.0-only source example consumes the packed `@deft/app-kit` 0.1.0-alpha.7 candidate. It requires the matching Deft host candidate (0.3.0-preview.16); neither release is published by this change. The example is a work in progress, not an everyday mail client.

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

The lockfile pins the local `deft-app-kit-0.1.0-alpha.7.tgz` dependency and its integrity. For an independent consumer, copy this source directory and that exact packed artifact into a fresh directory outside the repository, then run the same install, checks, and build there. The tarball, installed dependencies, bundles, package JSON output, and local reports are intentionally excluded from source control. `app.deft.json` is the resulting installable package; the build also writes its artifact and digest evidence locally.

Install through the normal authenticated App host interface. The operator must enable the relevant default-off App flags, consent to requested capabilities, bind the current mail and sync providers, and configure host-owned action policy. The package requests authority; installation alone grants no mailbox access or external writes. See [host and release boundaries](../../../docs/app-release-boundaries.md).

The provider CLI accepts `node provider-cli.mjs sync|runtime|sync-daemon /absolute/path/private-config.json`. Its configuration and referenced account file belong outside the public source tree. It requires a current scoped host session credential, explicit `account_file`, and, for sync, private inventory, stage journal, and recovery paths. The daemon additionally requires the owner's admission credential. Keep credentials, mailbox data, journals, and generated evidence private. Do not use the loopback fixture option for real providers. Runtime calls accept only the three declared mail actions; host admission and human approval govern execution.

The source supports one account, one recipient per invocation, and plain text outgoing messages with no outgoing attachments. Private draft quota is 32 records, including submitted drafts, with 30-day retention. Archive follows legacy human approval. Real-provider behavior and recipient delivery remain unproven. Development supervision and recovery require manual operation. Historical unknown sync outcomes can block upgrades; there is no complete normal owner reconciliation flow for those outcomes. Observation recovery preserves prior receipts and checkpoints and does not establish that an unknown operation failed.

Version 1.5.5 adds declared recipient validation, honest bounded mailbox ordering/counts,
subject-based draft labels, refreshed Activity outcomes, and deterministic pre-effect
provider failure settlement. The trusted host returns exact submitted fields for history;
a later edited draft is not treated as evidence of what was sent. The mailbox index is
bounded to 100 records and labels partial results. Submitted drafts are hidden while
corresponding request metadata is retained; older submitted drafts can reappear after
history eviction. Archive still uses the governed approval flow.

The frozen package digest is `sha256:9491a7a69d97f89d4da706cdf1e4199df85f31827ab4314ff782a1bcb92e79e5`.
A later source or dependency change requires a new build and digest comparison.

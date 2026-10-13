# Email WIP example 1.5.9

This AGPL-3.0-only source example consumes the packed `@deft/app-kit` 0.1.0-alpha.9 candidate. It requires the matching unpublished Deft host source, including schema upgrades preview.57 through preview.60. Neither release is published by this change. The example remains a work in progress.

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

The lockfile pins the local `deft-app-kit-0.1.0-alpha.9.tgz` dependency and its integrity. For an independent consumer, copy this source directory and that exact packed artifact into a fresh directory outside the repository, then run the same install, checks, and build there. The tarball, installed dependencies, bundles, package JSON output, and local reports are intentionally excluded from source control. `app.deft.json` is the resulting installable package; the build also writes its artifact and digest evidence locally.

Install through the normal authenticated App host interface. The operator must enable the relevant default-off App flags, consent to requested capabilities, bind the current mail and sync providers, and configure host-owned action policy. The package requests authority; installation alone grants no mailbox access or external writes. See [host and release boundaries](../../../docs/app-release-boundaries.md).

The provider CLI accepts `node provider-cli.mjs sync|runtime|sync-daemon /absolute/path/private-config.json`. Its configuration and referenced account file belong outside the public source tree. It requires a current scoped host session credential, explicit `account_file`, and, for sync, private inventory, stage journal, and recovery paths. The daemon additionally requires the owner's admission credential. Keep credentials, mailbox data, journals, and generated evidence private. Do not use the loopback fixture option for real providers. Runtime calls accept only the three declared mail actions; host admission and human approval govern execution.

The legacy provider CLI supports one account per private configuration, one recipient per invocation and plain-text outgoing messages without outgoing files. Use the new [trusted Send executor](providers/send-integration.md) for payload-backed Send. The host pins independently reviewed private account targets to sessions and actions, separates encrypted drafts by target and retains one installation-wide owner/state quota. Native Email Settings has authenticated connect/callback/status/disconnect through an operator-configured module and encrypted OAuth custody. Version 1.5.9 declares optional personal-account setup: a deployment admin admits the operator and limits, then an eligible human member reviews only their own resource and selected actions. The host feature is off by default. Automatic provider configuration for new targets, teardown after expired consent, supervised operation and live provider certification remain incomplete. See [connection integration](providers/connection-integration.md). A mailbox connected to another application's Gmail connector is not connected to Deft.

Private draft quota is 32 records, including submitted drafts, with 30-day retention. Submitted drafts remain hidden independently of Activity eviction; interrupted autosave/reopen preserves the latest saved revision. A failed message fetch is isolated from healthy page entries. Send subjects are nonempty, at most 200 characters and reject line breaks/NUL, while unfinished drafts can retain blank subjects. The compact Deft list/reader keeps Activity separate from folders and uses one mobile pane with Back.

PDF is an explicitly reviewed incoming media type, retained as an encrypted owner download with current consent/parent/content checks. Existing selected media policies do not gain PDF automatically. Classification is not sanitization, malware certification or an inline preview. The [provider modules](providers/README.md) implement bounded Gmail/Graph and IMAP metadata adapters, a logical account-scoped index and a separate `mail_index` resource. The build emits an experimental `app-indexed.deft.json` variant at `1.5.7-indexed.1`, with one read-only Mail index experience and no actions or drafts. It uses the same App identity and requires separate explicit package/source review; it does not add a second surface or silently upgrade the main candidate's grants. Body/files are unavailable in that variant. New-message Send now retains exact MIME and one outgoing PDF through encrypted host custody, human confirmation and authenticated Runtime release. Reply attachments and the integrated main lazy reader remain unfinished.

Archive follows legacy human approval. Real-provider outcomes and controlled recipient delivery remain unproven. Development supervision/recovery require manual operation. Unknown sync/transport outcomes are retained and cannot be treated as permission to resend or bypass an upgrade fence. SMTP/provider acceptance does not establish delivery. The current build's exact package, artifact and worker digests are in generated `build-result.json`; a source/dependency change requires a fresh build. Historical 1.5.5 baseline evidence is retained in the [Stage 0 handoff](../../../docs/superpowers/plans/2026-09-30-email-launch-stage0.md).

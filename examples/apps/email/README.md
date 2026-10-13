# Email legacy provider workspace consumer

This AGPL-3.0-only work-in-progress example is used by current Host provider
integration tests. All of its parent and provider modules resolve the real built
`@deft/app-kit` alpha32 workspace dependency. It is not an independent packed
consumer or the separately sideloaded Email preview release.

From the repository root, install the frozen workspace graph and build the SDK,
then install this example's frozen pnpm10 graph for its mail dependencies:

```sh
pnpm install --frozen-lockfile
pnpm --filter @deft/app-kit build
npm exec --yes --package=pnpm@10.33.1 -- pnpm --dir examples/apps/email install --ignore-workspace --frozen-lockfile
# Run focused Host/legacy tests normally, without a resolver override.
```

The active lock links the built workspace SDK and retains the existing mail,
IMAP and MIME dependency pins. The original alpha9 manifest, lock and exact
packed artifact are sealed byte-for-byte in [the historical consumer receipt](fixtures/sdk9-consumer/SEALED-HISTORICAL-CONSUMER.json), with original paths and
SHA256 values. Its [SDK corresponding source and provenance](fixtures/SDK9-PROVENANCE.json)
remain preserved. Those historical dependency bytes are evidence, not a supported
current application consumer: alpha9 lacks the current raster and compose exports.
Current packed SDK compatibility is tested separately by the App Kit package.
Generated bundles, installed dependencies and private configuration stay outside
source control; any App package built from this example requires its own exact
artifact/source review and gives no authority merely by being built.

Install through the normal authenticated App host interface. The operator must enable the relevant default-off App flags, consent to requested capabilities, bind the current mail and sync providers, and configure host-owned action policy. The package requests authority; installation alone grants no mailbox access or external writes. See [host and release boundaries](../../../docs/app-release-boundaries.md).

The provider CLI accepts `node provider-cli.mjs sync|runtime|sync-daemon /absolute/path/private-config.json`. Its configuration and referenced account file belong outside the public source tree. It requires a current scoped host session credential, explicit `account_file`, and, for sync, private inventory, stage journal, and recovery paths. The daemon additionally requires the owner's admission credential. Keep credentials, mailbox data, journals, and generated evidence private. Do not use the loopback fixture option for real providers. Runtime calls accept only the three declared mail actions; host admission and human approval govern execution.

The legacy provider CLI supports one account per private configuration, one recipient per invocation and plain-text outgoing messages without outgoing files. Use the new [trusted Send executor](providers/send-integration.md) for payload-backed Send. The host pins independently reviewed private account targets to sessions and actions, separates encrypted drafts by target and retains one installation-wide owner/state quota. Native Email Settings has authenticated connect/callback/status/disconnect through an operator-configured module and encrypted OAuth custody. Version 1.5.9 declares optional personal-account setup: a deployment admin admits the operator and limits, then an eligible human member reviews only their own resource and selected actions. The host feature is off by default. Automatic provider configuration for new targets, teardown after expired consent, supervised operation and live provider certification remain incomplete. See [connection integration](providers/connection-integration.md). A mailbox connected to another application's Gmail connector is not connected to Deft.

Private draft quota is 32 records, including submitted drafts, with 30-day retention. Submitted drafts remain hidden independently of Activity eviction; interrupted autosave/reopen preserves the latest saved revision. A failed message fetch is isolated from healthy page entries. Send subjects are nonempty, at most 200 characters and reject line breaks/NUL, while unfinished drafts can retain blank subjects. The compact Deft list/reader keeps Activity separate from folders and uses one mobile pane with Back.

PDF is an explicitly reviewed incoming media type, retained as an encrypted owner download with current consent/parent/content checks. Existing selected media policies do not gain PDF automatically. Classification is not sanitization, malware certification or an inline preview. The [provider modules](providers/README.md) implement bounded Gmail/Graph and IMAP metadata adapters, a logical account-scoped index and a separate `mail_index` resource. The build emits an experimental `app-indexed.deft.json` variant at `1.5.7-indexed.1`, with one read-only Mail index experience and no actions or drafts. It uses the same App identity and requires separate explicit package/source review; it does not add a second surface or silently upgrade the main candidate's grants. Body/files are unavailable in that variant. New-message Send now retains exact MIME and one outgoing PDF through encrypted host custody, human confirmation and authenticated Runtime release. Reply attachments and the integrated main lazy reader remain unfinished.

Archive follows legacy human approval. Real-provider outcomes and controlled recipient delivery remain unproven. Development supervision/recovery require manual operation. Unknown sync/transport outcomes are retained and cannot be treated as permission to resend or bypass an upgrade fence. SMTP/provider acceptance does not establish delivery. The current build's exact package, artifact and worker digests are in generated `build-result.json`; a source/dependency change requires a fresh build. Historical 1.5.5 baseline evidence is retained in the [Stage 0 handoff](../../../docs/superpowers/plans/2026-09-30-email-launch-stage0.md).

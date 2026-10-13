# Indexed Email integration seam

The metadata path is opt-in. Preserve `build.mjs`'s existing `inbox` descriptor,
worker, bundle, private drafts and action contracts. `providers/service.mjs`
accepts only the exact `EMAIL_METADATA_DESCRIPTOR` from `metadata-resource.mjs`
and denies other descriptors before contacting a mail provider.

The root build emits a separately reviewed experimental variant because the
current host/Kit contract permits one Experience per package. The main 1.5.7
package preserves the legacy Inbox, draft and action path. The same App identity
at `1.5.7-indexed.1` is an explicit alternative with one read-only Mail index
Experience; it is not an automatic upgrade or a second surface in the main App.
The two variants require their own exact package/grant/source reviews.

1. Import `EMAIL_METADATA_DESCRIPTOR` from `./metadata-resource.mjs` into the
   indexed variant's `sync_descriptors`; retain the existing `sync_provider` Runtime
   requirement and omit Runtime mail actions/private state. The new key is `mail_index`, resource type
   `mail_message_metadata`, visibility `user_private`, label field `label`.
2. Bundle the separate `metadata-worker.mjs` into `metadata-worker.bundle.js`.
   Prepare a second artifact `experiences/indexed.json` with bundle version v2,
   `entry_view: 'main'`, `resource_keys: ['mail_index']`,
   `search_resource_keys: ['mail_index']`, `action_keys: []`, and no `state_keys`
   property. Bundle v3 requires private state; the indexed reader needs none.
   Add experience key `indexed`, label `Mail index`, and build that variant with
   only this artifact into `app-indexed.deft.json`. Main `app.deft.json` keeps
   only its original main artifact. Existing worker bundle input-count checks
   remain scoped to the existing bundle; inspect the new bundle independently.
3. Review a new `mail_index` resource binding for each owner-private target.
   Opening its experience uses the existing host target/session/exposure flow;
   this adds no connection authority. Do not reuse an old `inbox` descriptor
   digest or custody grant for the new record contract.

`metadata-ui.mjs` is browser-safe and exports `createEmailMetadataReader`,
`emailMetadataInFolder`, `emailMetadataRelated` and
`EMAIL_METADATA_SEARCH_FIELDS`. The reader calls
`sdk.readResourceRecord('mail_index', host_record_uuid)` and checks the exact
`item.record_id` echo. Host record UUIDs remain distinct from the DTO's stable
`logical_message_id`. Folder membership uses explicit booleans; related messages
match both `account_id` and `conversation_id`. Counts describe only the bounded
saved index. No subject or Message-ID grouping is used. Legacy Reply/Archive
locators are blank, and this experience has no action keys.

The UI must show `body_notice` and `files_notice`. It must not translate empty
lazy body text into “No message text”, treat unknown files as zero files, or
claim complete conversations when the saved index ends. The body/file adapter
methods are deliberately outside this SDK reader. Adding a lazy reader later
requires reviewed host body/file handles, exact account/record binding, current
authority on every disclosure, and untrusted-content rendering protections.

`metadata-fixtures.mjs` maps existing deterministic Stage 0 MIME headers to the
same normalized/indexed/page DTO path. Fixture MIME parsing happens offline and
does not prove live authorization or production metadata-only I/O.

Focused proof commands, from an independent packed-Kit example consumer:

```text
node --test metadata-resource.test.mjs providers/imap-metadata.test.mjs providers/account-runtime.test.mjs providers/providers.test.mjs
node --test metadata-worker.test.mjs
```

Production connection/onboarding limitations and the private supervised config
template are in [providers/SUPERVISED-CONFIG.md](providers/SUPERVISED-CONFIG.md).

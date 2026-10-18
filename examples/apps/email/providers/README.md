# Stage 1 provider foundations

These adapters are private Email-side modules. They do not register a host
capability, create a service grant, or turn account IDs into authority. The separate
[OAuth/custody module](oauth-custody.md) now supplies verification, supervised refresh and encrypted durable storage through mandatory trusted authority ports. Real-provider wiring and live-provider certification remain
unproved. Constructors require trusted descriptors from `EmailAccountRegistry`.

The [connection integration](connection-integration.md) exposes the Email-owned
OAuth factory through authenticated, exact host projection. Native Settings
shows connected identity, reconnect/disconnect or a truthful deployment setup
state. Operator configuration and current owner/admin review remain required.
The Send bridge and exact recipient probe are fixture-tested together; production
host outgoing-file/snapshot persistence and live delivery remain unverified.

`createGmailAdapter` and `createMicrosoftAdapter` accept an account descriptor,
injected `fetch`, `getAccessToken`, `assertAuthority`, and optional `reserveSend`.
Authority callbacks receive `{account_id, operation, authority_epoch}` and must
rederive current organization, owner, installation and binding authority. They
must return exactly `true`; failures deny access. The token supplier returns a
purpose-scoped access token string and owns refresh outside these modules.

Both adapters expose `listMessages({limit, cursor})`, `searchMessages({query,
limit, cursor})`, `readMessage(locator)`, `readConversation(...)`, and `send(...)`.
Gmail accepts label IDs, spam/trash selection and a native thread ID; Graph
accepts folder IDs and a native conversation ID. Pages return account-scoped
normalized summaries, safe per-message failures, a bound opaque cursor, actual
coverage and count metadata. They never treat a provider estimate as an exact
mailbox count. Page limits, cumulative Gmail metadata bytes and request deadlines
are bounded. Invalidated cursors require a new scan; the logical index retains
existing identities during that scan. Graph search advertises its 1,000-result
provider cap and never claims full query completeness.

`createEmailAccountRuntime` combines the registry, adapter and logical index. Its
read/send methods select an exact account ID and recheck the current descriptor
before token use, network dispatch and read disclosure. Outgoing snapshot packets
may include `account_id` and `transport_kind` (`gmail_raw`/`graph_raw`); supplied
values must match the selected adapter. API adapters preserve all exact MIME bytes.

`node providers/service.mjs sync /absolute/private/config.json` is a real Sync v3
entry point using the packed Kit's AppRuntimeSession transport. Config version is
`deft.email_account_service.v1`; fields are `channel_url`, `credential`, `mappings`,
`custody_module`, `index_path`, `recovery_path`, optional `inventory_path` and
`expected_run_id`. Each trusted deployment mapping contains `scope`, `account`,
`session_id`, `runtime_registration_id` and `resource_binding_id`. The claim must
match all those exact reviewed references and the host-started resource binding.
Host heartbeat renewals authorize reads; no owner Web JWT is accepted.

The private custody module exports `createEmailCustody()` and supplies the token
or IMAP connection callback for that reviewed target. It must supervise refresh
without broadening authority. OAuth/custody primitives and a POSIX durable store are supplied;
the authenticated host connection/callback and exact current-custody projection are still integration gaps. Current Sync v3 does not attest owner, account target or account authority epoch, so its lease alone cannot supply those ports. Use separate private state/recovery files per account.
The service stages the exact page/index before host acknowledgement. A lost
acknowledgement retains recovery evidence and blocks automatic replay.

The service uses the exact new `mail_index` descriptor exported from
`../metadata-resource.mjs`; it preserves the existing `inbox` path. The current
scalar Kit accepts 25 bounded metadata fields and zero attachment links. Native
locators remain in private index state. Descriptor mismatch fails before token
or provider access. Labels have an explicit shortened-preview flag. The separate
browser reader uses existing scoped host resources, with body/file access
unavailable. See [the additive build/worker seam](../metadata-integration.md) and
[the supervised config/onboarding gap](SUPERVISED-CONFIG.md). Raw IMAP tombstones
do not erase logical links without alias-aware absence evidence.

Details return explicitly untrusted Gmail MIME payloads or Graph HTML/text.
Host rendering/sanitization and private file handles are separate required
boundaries. There is no attachment download/upload endpoint in this slice.

Send accepts `{mime_bytes, mime_digest, operation_id, from_address, thread_id?}`.
The host must resolve an immutable approved snapshot into these exact bytes,
including all recipients, content and finalized files. The adapter copies bytes,
checks their SHA-256 digest and verified single From identity, and requires
`reserveSend` to atomically reserve the operation against the account and digest.
The host owns durable settlement/reconciliation of that reservation. Adapters
never retry Send. Network/lost-result failures after dispatch report `uncertain`;
acceptance is distinct from pending Sent-copy observation and unknown delivery.

`createImapAdapter` accepts a trusted scoped connection factory, and reuses the
existing bounded locator and lifecycle helpers. It supports bounded sync-window
listing with explicit commit/close and locator-based reply-header reads. Existing
IMAP locator reads return headers only. Its separate `listMetadataMessages` path
fetches bounded envelope/flag/UID metadata without source/body/files, with an
account-bound resumed cursor and no inferred deletions. IMAP server search, complete threading,
new rich SMTP send, and authoritative move execution are unsupported here.
`LogicalMailIndex.recordMove` consumes a trusted worker's authoritative move
result; a subject or Message-ID match alone never merges records. Persist its
private exported state through the host's governed account-owned resources.

API semantics were checked against official documentation:

- [Gmail list messages](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Gmail thread read](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/get)
- [Gmail MIME send](https://developers.google.com/workspace/gmail/api/guides/sending)
- [Graph message pagination](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)
- [Graph immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)
- [Graph search limits](https://learn.microsoft.com/en-us/graph/search-query-parameter)
- [Graph MIME send and 202 semantics](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)

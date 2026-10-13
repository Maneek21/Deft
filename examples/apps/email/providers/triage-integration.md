# Reviewed Email triage seam

X07 uses a separate reviewed triage ceiling. Existing `read`, `search`, `thread`, and `send` account/OAuth contracts are unchanged and do not grant mutation authority. The alternative of authorizing writes through read/Send was rejected; a new generic host permission platform is unnecessary for this module slice. No database migration is required. Removing these new modules rolls back the feature; retain encrypted journal records after any attempted operation.

`createEmailTriageService` in `../triage-service.mjs` accepts trusted server ports `resolveAuthority`, `resolveMessage`, `adapterFor`, and a durable journal. Caller IDs nominate only. The authority port must rederive the current exact owner/org/install/account, resource and triage action binding, epoch, admitted operation ceiling, human owner actor and deadline from the reviewed Run. It returns `{binding:{scope,account,action_binding_id,operations},actor:{kind:'human',user_id},expires_at}`; execution of permanent deletion also requires host-issued `{destructive_confirmation:{accepted:true,review_digest}}`. Browser booleans and provider labels cannot supply that confirmation. Do not implement these ports as permissive stubs in production.

The service exposes:

- `prepare({scope,account_id,operation_id,operation,logical_ids})`: immutable encrypted retained plan, UUID idempotency ID and bare64hex digest. Maximum 25 items and 24KiB plan.
- `execute({scope,operation_id,expected_digest})`: current authority, per-item durable reservation, provider comparison and bounded mutation; exact repeated identity never resends started/terminal items.
- `prepareUndo({scope,operation_id,expected_digest,undo_operation_id})`: a new immutable plan for successful reversible items. Original uncertain, failed and permanently deleted items are excluded. Execute it through fresh exact authority. Provider state changes cause conflict.
- `status({scope,operation_id,expected_digest})`: authorized per-item succeeded/failed/unknown/prepared status, resulting locator and undo availability. A durable started marker is unknown after restart.
- `destinations({scope,account_id,operation:'move'|'labels'})`: current declared special folders and provider destinations, with honest completeness.

Operations are `mark_read`, `mark_unread`, `flag`, `unflag`, `archive`, `trash`, `restore`, `spam`, `not_spam`, `labels`, `move`, `permanent_delete`. Labels specify `add_labels`/`remove_labels`; move requires `destination`. Restore/not_spam may select a declared destination where supported. IDs stay within the nominated account. Gmail treats folders as labels; move adds the selected label and removes Inbox while preserving unrelated user labels. Gmail Archive removes Inbox without inventing an Archive label. Graph categories are labels, with separate folder moves and immutable IDs.

`createGmailTriageAdapter`/`createMicrosoftTriageAdapter` require `{binding,fetch,getAccessToken,assertAuthority}`. The token port returns `{token,granted_scopes}` from actual encrypted provider custody on each call, not configuration-requested scopes. Reviewed operations and actual scopes must both permit the mutation. The transport cannot request scopes or perform OAuth escalation. Gmail requires `gmail.modify` for reversible mutations; permanent deletion additionally requires existing full-mail `https://mail.google.com/` scope. Missing scope is an explicit unsupported/access requirement. [Gmail Modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify), [Gmail Delete](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/delete), [label semantics](https://developers.google.com/workspace/gmail/api/guides/labels).

Graph requires delegated `Mail.ReadWrite`; `Mail.Send` and `Mail.Read` alone are insufficient. It uses `/me`, `Prefer: IdType="ImmutableId"`, returned ETag/If-Match, explicit destination IDs, and the permanentDelete endpoint. The service rechecks current state; this fixture slice does not certify the live provider's atomic concurrency behavior. [Update](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0), [Move](https://learn.microsoft.com/en-us/graph/api/message-move?view=graph-rest-1.0), [Permanent Delete](https://learn.microsoft.com/en-us/graph/api/message-permanentdelete?view=graph-rest-1.0).

`createImapTriageAdapter` requires the exact binding, verified-TLS connector, current authority, and explicit `{flags,keywords,move,uid_expunge,folders}` declaration. Folder paths must be configured/listed. Flag changes require actual CONDSTORE and MODSEQ; keyword permission is intersected with selected mailbox permanent flags. Moves require actual MOVE+UIDPLUS and exact returned UID mapping. Permanent deletion requires UIDPLUS and explicit confirmation through the service. No COPY/global-EXPUNGE fallback is allowed. Absent extensions or missing mappings fail honestly; the adapter does not guess locators or folder names. [ImapFlow methods](https://imapflow.com/docs/api/imapflow-client/).

`createEmailTriageJournal({store,encryption_key,key_id})` uses the existing fenced POSIX custody store, AES-GCM with a separate triage AAD/key namespace and 64KiB encrypted-record ceiling. CAS acknowledgements must be durable before provider I/O. The store's new `email.triage.operation.<digest>` namespace does not change existing OAuth/Send bytes. A journal key change, deleted journal, lost reservation or uncertain result must never be used to authorize resend. Original before/after metadata is retained encrypted for undo; host deployment must govern retention/quotas without dropping at-most-once tombstones.

Gmail has no atomic message-label CAS in this seam; a concurrent third-party provider write between comparison and mutation is possible. Undo checks the full captured current state immediately before a targeted inverse, preserving unrelated labels/flags. Provider response loss remains unknown rather than a claim of no effect. Core Runtime binding, supervised dispatch, UI and live provider validation remain lead-owned integration work. Focused module tests use mocked providers; POSIX journal reopen is tested on native Linux Node 24.14.0. No live mailbox write is claimed.

## Authenticated Runtime bridge

`runEmailTriage({config,indexStore,oauthCustody,journal,fetch,now})` in
`../triage-runtime-service.mjs` constructs the actual AppKit Runtime client with
`action_resources_version: 'deft.app_action_resources.v1'`. Machine-only config
schema `deft.email_triage_runtime.v1` contains `channel_url`, issued `credential`,
`expected_run_id`, exact triage `binding`, full host `runtime_pin`, existing
`oauth_binding`/`clients`, fixed `resource_key`, and issued `expires_at`.
`validateTriageRuntimeConfig` defines its exact fields. It never mints sessions.

The released scalar input is exactly `{record_ids,operation,destination,add_labels,remove_labels}`.
Record IDs are distinct comma-separated host UUIDs, at most25; labels are bounded
comma-separated IDs and unused fields are empty strings. Run ID is the durable
operation identity. Before Start the bridge requires the exact expected Run, human
owner, installation/version/grant/epochs, runtime action/registration and issued
session pins. Older hosts missing these pins fail closed.

The authenticated `readActionResources(claim,{input_key:'record_ids'})` response
must match the nominated UUID set, configured scope/resource key/binding and the
governed `deft.email_message_metadata.v1` account/provider projection. The encrypted
`LogicalMailIndex` resolves each projected logical identity to a private provider
locator. A host UUID is never assumed to equal a logical/provider ID. Legacy inbox
rows lacking that projection are unavailable; packaging a reviewed primary
metadata source remains an integration gate, distinct from the experimental index.

Every authority/custody/provider phase uses current Runtime heartbeat checks.
Encrypted OAuth custody supplies its actual granted scopes, matching original
binding, primary identity and client fingerprint. The bridge does not request new
scopes or refresh through an unreviewed ceiling; missing grants or tokens expiring
within60seconds require separately governed access/refresh. Gmail/Graph execution
is available; IMAP Runtime resolution/credential wiring and fresh-Run undo dispatch
remain unimplemented here, although their pure adapters/planning are tested.

Permanent deletion requires released operation `permanent_delete_message`, exact
human owner and scalar `permanent_delete`; ordinary `triage_message` cannot carry
it. This trusted host release binds confirmation to the retained internal plan,
not a browser boolean. The host must show and require its destructive confirmation
before releasing that distinct action. Missing actual full-mail scope still denies.

Returned output is `{operation_id,succeeded_count,failed_count,unknown_count,undo_available,automatic_retry:false,items}`.
`items` has at most4096characters of host UUID/outcome/code lines and no private
provider locators. Any unknown item produces host `indeterminate`, with fuller
partial evidence retained in the encrypted journal. Known partial failure returns
`provider_succeeded:false`. Settlement requires acknowledgement for the exact Run
and expected terminal state; response loss never permits repeated provider writes.
The native fixture uses actual SDK HTTP codec, encrypted state/OAuth/journal files
and controlled provider replies. Real host/provider dispatch remains unverified.

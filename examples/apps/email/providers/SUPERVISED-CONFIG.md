# Supervised metadata sync and current onboarding gap

Deft currently has no Gmail OAuth connection UI or production refresh-token
custody module for this example. Choosing a source in an experience selects
existing reviewed host custody; it does not authorize Gmail or obtain a token.
These modules support a supervised integration with injected credentials. They
have fixture/mock proof, not a completed live Gmail connection journey.

The new resource is `mail_index`, exported as `EMAIL_METADATA_DESCRIPTOR` from
`../metadata-resource.mjs`. It is independent of the existing `inbox` descriptor
and legacy IMAP worker. Install a package declaring this descriptor, review an
owner-private resource binding for the exact target, and issue its existing
purpose-scoped AppRuntimeSession credential using the host's normal review and
activation flow. A private deployment map binds the exact session,
registration, resource binding, organization, owner and installation to the
Email account descriptor. Neither the account name nor token contents select
authority. The service compares the claim/start references and exact descriptor
digest, then uses current host heartbeats before and after provider reads.

The operator must supply a private module exporting `createEmailCustody()`.
For Gmail/Graph it returns `getAccessToken({scope,account,account_id,operation,
authority_epoch})`. That function must use the reviewed connection target and
supervised token custody; it must not pick a token by email/provider label,
return an owner Web JWT, or log credentials. The module owns provider account
verification, refresh, reauthorization and shutdown. No implementation of that
production custody boundary is supplied here. Revoking either the selected
host binding or the provider authorization must stop subsequent token use.

An operator-provided Gmail OAuth registration and user consent are prerequisites.
For metadata sync only, Google's `gmail.metadata` scope permits headers/labels;
provider query search cannot use that scope. Body reads/provider search require
the separately reviewed `gmail.readonly` scope, and Send requires its own
authorization. The indexed experience does not expose body, file or Send
operations. See Google's [scope definitions](https://developers.google.com/workspace/gmail/api/auth/scopes)
and [message-list scope/search restriction](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).

Keep the config, custody module and state files outside the repository and any
public web root. Use one state/recovery file pair per account. The CLI rejects
paths in its application/repository tree and prints only safe outcome codes.
Protect these files with deployment filesystem permissions; the CLI does not
replace an operating-system secret store or supervisor.

This is a template for a supervised deployment, not ready-to-use credentials:

```json
{
  "schema_version": "deft.email_account_service.v1",
  "channel_url": "https://deft.example.test/api/app-resource-sync/channel",
  "credential": {
    "session_id": "00000000-0000-4000-8000-000000000130",
    "session_token": "REPLACE_WITH_CURRENT_PURPOSE_SCOPED_SESSION_TOKEN"
  },
  "mappings": [{
    "scope": {
      "org_id": "00000000-0000-4000-8000-000000000101",
      "owner_id": "00000000-0000-4000-8000-000000000102",
      "installation_id": "00000000-0000-4000-8000-000000000103"
    },
    "account": {
      "account_id": "gmail-personal",
      "provider": "gmail",
      "display_label": "Personal Gmail",
      "primary_address": "owner@example.test",
      "verified_sender_identities": ["owner@example.test"],
      "capabilities": ["read"],
      "connection_target": "reviewed-private-gmail-personal",
      "resource_binding_id": "00000000-0000-4000-8000-000000000120",
      "action_binding_id": null,
      "authority_epoch": 1,
      "health": "connected"
    },
    "session_id": "00000000-0000-4000-8000-000000000130",
    "runtime_registration_id": "00000000-0000-4000-8000-000000000110",
    "resource_binding_id": "00000000-0000-4000-8000-000000000120"
  }],
  "custody_module": "custody.mjs",
  "index_path": "personal-index.json",
  "recovery_path": "personal-recovery.json"
}
```

Run one queued sync page with `node providers/service.mjs sync /absolute/private/config.json`.
Schedule/supervise subsequent runs outside this module. A staged result with a
lost host acknowledgement is retained and blocks automatic replay; manual
host reconciliation remains required. Changing a reviewed binding/session
requires updating the trusted map and reissuing the purpose-scoped credential.

For IMAP, custody instead supplies `connectImap(...)` returning an authenticated
verified-TLS ImapFlow client, plus optional `configuredFolders(account)` returning
`{sent,archive}`. The metadata path fetches only envelope, flags, size, UID and
date within 64-UID windows. It never asks for source, body structure or files;
it does not infer deletions. The legacy full-IMAP path remains separate.

Gmail folder presentation uses its native system labels. Graph's parent folder
IDs are opaque; a mapping may add `folder_map: {inbox: ["EXACT_ID"], sent: [],
archive: []}` from the selected connection's trusted configuration. Unknown
folders stay visible in All mail with incomplete membership. Graph's
`hasAttachments=false` excludes inline files, so the full file inventory remains
unknown. See Microsoft's [message property definition](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0).

Metadata pages publish account-scoped logical IDs and conversation IDs, bounded
header/flag fields and explicit lazy status. Native provider IDs, IMAP locators,
MIME, body text and file bytes stay out of host records. `attachments` is always
empty. `headers_complete=false` acknowledges bounded header summaries. Ending
a saved metadata scan does not establish complete provider conversations or
freshness. Browser readers use only the existing scoped Experience SDK resource
route. Body/file access is unavailable until separate reviewed host handles and
permission checks are implemented; API adapter detail methods are not exposed
by this experience.

> Privacy redaction: controlled provider addresses below are reserved synthetic replacements, not original observed provider values. Original source/evidence is preserved privately. Original SHA256: `f09941e5f7f9324b97c071ca46190e671af5ef3fb8dfaf20dd95d0c87763de25`.

# Trusted outgoing Send

Email 1.5.9 uses the matching unpublished host and schema preview.60 for a saved
draft plus one PDF up to 2 MiB. This implementation covers new plain-text messages
to one recipient. Reply attachments, multiple recipients, rich text and automatic
worker supervision remain on the replacement plan. The legacy provider CLI must
not execute this payload-backed action.

## Data and authority

The native composer saves the scalar draft, then uploads or removes a file through
an authenticated compare-and-swap request. The host stores encrypted file bytes
in PostgreSQL. A private, digest-pinned Email module builds MIME from the current
verified account, saved draft and committed files. The host retains that immutable
payload; the human confirmation binds its reference to the Run. Removing or
editing the draft afterward cannot change what the confirmed Run sends.

The Runtime client must opt into `deft.app_action_payload.v1` before Start. An old
worker is refused before its provider-start marker. Each metadata, MIME and file
read rechecks the exact Run, attempt, current owner/target authority, claim and
deadlines. Credentials stay in separate encrypted Email custody. The executor
never rebuilds MIME from the scalar action input.

`outgoing-runtime-service.mjs` connects the actual Runtime SDK to the OAuth and
Send adapters. `outgoing-operation-store.mjs` stores an encrypted durable operation
journal under `mail-${run_id}`. Its reservation and provider-start fences survive
process restart. Lost acceptance or outcome acknowledgement is uncertain and
cannot authorize another provider call. Provider acceptance, Sent evidence and
recipient receipt are separate observations.

## Operator execution

Use a reviewed POSIX deployment. Install the packed Kit and Email dependencies
outside the monorepo, configure the connection adapter as described in
[connection integration](connection-integration.md), and connect the sender through
Deft. Use the same account binding, OAuth client and encrypted custody for the
connection module and executor. Never copy a connector token from another app.

The operator creates a private JSON file outside any source checkout, owned by
the service user with mode 0600. Its exact fields are:

| Field | Value |
| --- | --- |
| `schema_version` | `deft.email_outgoing_service.v1` |
| `channel_url` | The deployment's `/api/app-runtime/channel` URL |
| `credential` | Current host-issued `{session_id,session_token}` for the reviewed action binding |
| `account_binding` | Exact `EmailOAuthBinding` from the connection configuration |
| `clients` | Private OAuth web-client configuration |
| `custody_root`, `encryption_key_hex`, `key_id` | Existing encrypted OAuth custody and its 32-byte key |
| `journal_root`, `journal_encryption_key_hex`, `journal_key_id` | Private durable Send journal and a separate 32-byte key |
| `expected_run_id` | The single controlled human-confirmed Run UUID |

Run once with:

```sh
node outgoing-service.mjs send /absolute/private/send-config.json
```

The command claims one Run and refuses a different Run before Start. It does not
retry. Keep the action queue controlled while using this milestone CLI; a
mismatching claim remains leased until host recovery. Printed output contains
only a Run identifier and coarse status. Preserve both ciphertext stores and
keys in backups. Do not delete journal records to recover an uncertain send.

No real configuration file or provider credential is included. Three POSIX
process tests pass with actual child processes, Runtime SDK transport, encrypted
OAuth custody and the durable journal against fixture endpoints. They cover exact
MIME/PDF Send, accepted and uncertain restarts without resend, wrong Run refusal
and malformed/insecure configuration before claim. These tests do not certify
a deployed host or real Gmail delivery. The HTTP/PostgreSQL tests separately
verify the host custody and authorization path.

## Demo rollout prerequisites

The observed demo still serves the older host at schema preview.56. Prepare a
database backup, run the supported upgrade dry-run, and deploy the matching host,
schema preview.60, Email 1.5.9, private module and executor together. Re-review the
changed file/payload policies and configure current target/action pins; historical
consent is not an approval for new policies. Do not replace the running demo until
the candidate and private configuration are ready. Disabling new admission stops
the opt-in path while retaining additive schema, ciphertext and uncertain-outcome
evidence. Rolling back the whole deployment requires restoring its stopped
database/uploads/configuration recovery point with the exact previous image;
do not restart the old image against the newer schema.

Google setup needs a confidential Web OAuth client with the exact authorized
redirect `https://demo.deft.ing/apps/connections/callback`, Gmail API enabled and
the controlled sender admitted by the consent configuration. The current adapter
requests verified identity, Gmail read-only and Gmail Send scopes. It does not
request settings-write or permanent-delete authority. Google requires an exact
redirect match; consult its [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server)
and [Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes).

Connect `controlled.recipient@invalid.example` in Deft, confirm one unique draft/PDF addressed
only to `source.sender@invalid.example`, execute that exact Run, then use the recipient
connector read-only to verify Message-ID, body and attachment digest. Record
provider acceptance and recipient evidence separately. No live Send is certified
by the current fixture results.

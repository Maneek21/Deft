# Connect once: account access, updates and recovery

This guide describes the connected-App behavior shipped October 20–22, 2026
(Host previews 125–136 and Email releases 18–28). Use the exact supported
artifacts in the [Email compatibility guide](https://github.com/Maneek21/deft-email/blob/main/docs/compatibility.md).
The latest set covered here is Host `0.3.0-preview.136`, schema 131, Email
release `v1.9.0-preview.28`, App `1.9.1-preview.9` and Runtime
`0.4.0-preview.26`. Release, App, Runtime and schema numbers are separate.

## Choose how long access lasts

When the admitted policy supports it, new account setup selects **Until revoked**
for ordinary reads, declared private records such as drafts, and background
metadata refresh. One lifetime choice is applied after the account connection
is acknowledged. You can choose an end date instead. Opening settings does not
convert an existing account's dated permissions or silently approve new access.

An until-revoked permission has no scheduled Deft expiry. Current membership,
roles, account identity and revocation checks still apply, and the provider can
withdraw its own authorization. Sending, organizing messages, mirroring provider
drafts and assistant access retain their separate permissions and reviews.
Sending still requires review of the exact saved message.

Background access uses short technical sessions even when its permission is
until revoked. Those sessions renew automatically. **Dated background permissions
do not auto-renew**; their original deadlines remain in force. A ten-minute OAuth
callback or a short review deadline is a setup window, not the lifetime of a
connected account.

## Keep approvals through compatible updates

An owner or administrator can open **Settings → Apps → Compatible update trust**
for an installation and choose **Trust compatible upgrades**. This setting is
off by default and applies only to that installation. When enabled, it reads
**On: compatible updates keep your approvals**.

An eligible update keeps the already reviewed account, read and action consents,
background observation permission, and exact private-record/Experience access.
It preserves finite expiry dates and revocations. Deft and the Runtime create
fresh version-bound account bindings and short sessions; the old tokens and
grants do not become current authority. Provider credentials stay in Runtime
custody, so a compatible update needs no new provider login or manual background
enrollment. The account, owner, installation, provider, operator and reviewed
connection transport must remain the same, and uncertain effects must be resolved.

The compatibility check permits release identity, description and approved
artifact changes. Changes to permissions, providers, destinations, actions,
schemas, connection profiles or transport still need review. Unknown changes
also need review. Trust does not approve a new account, restore revoked access,
extend an end date, or resend a message. Apps and Runtimes must support the
continuity contracts; older combinations can still require reviewed recovery.

Choose **Turn off upgrade trust** in the same section to stop automatic approval
carry-forward for subsequent updates and invalidate pending trust proofs. This
does not disconnect an already connected account or revoke its current consent;
use the account and permission controls for that. Operators can also read
`GET /api/apps/:installationId/upgrade-trust` and update it with
`PUT /api/apps/:installationId/upgrade-trust`, supplying
`{ "trusted": false, "expected_revision": <current revision> }`.

## Recover after a restart or outage

With current until-revoked permission for the configured operator's own account
(account owner and operator must be the same person), background access can resume
after either the Host or supported Runtime restarts. If the old technical
sessions expired during the outage, the Runtime obtains fresh scoped sessions
through its authenticated service identity. It does not need an open browser or
another owner approval. Recovery checks the same installation, registration,
operator, membership, account and active permission. It cannot create consent,
switch accounts or bypass a disconnect, revocation or expired dated permission.
Accounts owned by someone other than the configured operator need their supported
owner-authorized recovery path.

The October 21 acceptance run recovered automatically after a Runtime outage of
about 21 minutes, with all four old sessions expired. The October 22 Email28
upgrade preserved read, draft, private-record and background permissions with no
owner review, reconnect, recovery click or manual sync. These are bounded
acceptance results, not an uptime or recovery-time guarantee.

## Catch up without waiting for the idle interval

After a successful committed sync page reports more data, the Host schedules a
durable continuation after one second. It rechecks current authority before each
page. Queue scanning and provider/Runtime work add latency; this is not a promise
of one completed page per second. Once caught up, the configured idle refresh
interval applies again. Partial coverage stays partial until catch-up completes.

Failed or uncertain operations do not use that successful-page continuation.
In the Email28 acceptance run, the first read timed out at a Host checkpoint lock
and stayed unknown. A later independent scheduled read recovered at the configured
15-minute interval and completed all 112 retained records. The old read was not
replayed or manually closed. Never replay an uncertain Send to make sync look healthy.

## Read health and use Troubleshooting

Email settings leads with the verified account connection and background refresh
state. A connected account does not offer a fresh Reconnect as its normal next
step. Background refresh shows its actual lifetime, such as **Enabled · until
revoked**. The current health API does not expose last-sync time or message count,
so the health line does not show them. Connected and enabled do not mean every
message has already been published or captured into Knowledge.

Expand **Troubleshooting** to reload account connections or background status,
check connection status, review an account update, or re-establish background
access when recovery is actually needed. Use status to reconcile a lost response
before repeating an operation. Reconnect is for an account that needs connection
or genuine provider reauthorization. Compatible updates normally need none of
these maintenance controls. Turning off background refresh or revoking access
still stops future work under that permission.

Errors lead with plain language and one useful action; **Details** contains the
diagnostic codes. Read-only lists can retry once after checking identical current
authority. This is bounded recovery, not a retry policy for writes. A screen's
read failure should not be read as proof that the entire Runtime is down.
See the [structured error notes](app-connection-sessions.md#structured-runtime-errors)
for operator diagnosis.

## Remaining limits

- The Knowledge worker can race a mailbox generation change during a read.
  The investigated `EMAIL_DATA_SOURCE_CHANGED` cases recovered automatically
  in 10–61 seconds. That observation concerns background Knowledge work; it does
  not establish a universal foreground retry or require reconnecting the account.
- “Need attention” counts do not yet link to each individual item.
- Authority checks are sequential. Very large mailboxes can still hit operation
  time budgets; consolidating those checks is planned. Fast catch-up does not
  remove that limit.
- Contracts/Wiki neutral-owner work and the full Knowledge/Calendar migration
  from the [#378 plans](https://github.com/Maneek21/Deft/pull/378) are deferred.
  The current Task/Knowledge source integrations do not mean that migration is complete.
- See [Email limitations](https://github.com/Maneek21/deft-email/blob/main/docs/limitations.md)
  for the current Reply and mailbox feature limits.

## Shipped change references

The implementation and review records are [fast catch-up #399](https://github.com/Maneek21/Deft/pull/399)
([trust](https://github.com/Maneek21/Deft/pull/400),
[service recovery](https://github.com/Maneek21/Deft/pull/401),
[initial lifetime](https://github.com/Maneek21/Deft/pull/402)),
[retained-account recovery #405](https://github.com/Maneek21/Deft/pull/405),
[transport deadlines #406](https://github.com/Maneek21/Deft/pull/406),
[structured errors #408](https://github.com/Maneek21/Deft/pull/408),
[settings clarity #409](https://github.com/Maneek21/Deft/pull/409), and
[read-only recovery #410](https://github.com/Maneek21/Deft/pull/410).

# Runtime session renewal and outage recovery

For the owner-facing setup, upgrade trust and recovery controls, see
[Connect once](app-connect-once.md). Host preview 136 and the matching
Runtime support until-revoked permission, automatic renewal and scoped service
reacquisition after an outage. A technical session still lasts at most fifteen
minutes; the account permission can last until revoked.

## Until-revoked channels

New account setup defaults to **Until revoked** when the admitted policy allows
it, applying the chosen lifetime to ordinary reads, declared private records
and background metadata permission after connection acknowledgement. Existing
dated grants are unchanged. Sending, provider actions and assistant access keep
their own review requirements.

With current until-revoked consent, the supported Runtime renews still-live
action and resource-sync sessions. Service reacquisition requires the configured
operator's own account grant: the account owner must be that operator. If an outage lasts beyond those leases, its
authenticated service identity can obtain fresh scoped sessions for the same
installation, registration, operator and account. This does not revive an expired
token. It issues a new short session after checking current membership, roles,
grant, custody and revocation. No browser login or new owner review is needed
while those permissions remain valid. It cannot issue a new grant, extend a
dated consent, change the owner or bypass revoked access. Compatible upgrades
use fresh version-bound sessions under the separately enabled per-installation
trust setting.

**Finite background permissions do not auto-renew.** Choosing an end date keeps
that deadline and does not enroll the renewable until-revoked background path.
An operator should inspect current consent and Runtime setup before asking an
owner to reconnect. Provider revocation or an actual account/permission change
can still require human action. Unknown effects remain unknown and must not be
replayed during recovery.

## Explicit finite technical renewal

The older finite opt-in contract below remains supported. Its browser-family
ceiling and expired-session restriction describe that finite path; they do not
prevent the until-revoked service reacquisition described above.

Introduced in schema109/Kit alpha.25: support for technical renewal of a newly issued runtime credential. Existing credentials are unchanged and cannot opt in later. This does not grant an action, create a Run, renew a consent, or retry an effect.

Use an explicitly reviewed future finite deadline; the example is not a default or a promise that the Host will admit that ceiling. The authenticated human issuer accepts either the existing `{}` body or
`{"technical_renewal":{"requested_until":"2026-10-14T03:00:00.000Z"}}`.
The response adds `renewable_until` only for an opted-in session. The Host fixes that ceiling at the earliest of the requested finite deadline, the issuing browser session family's deadline, and the original private target's consent deadline when a private target exists. Missing target authority or an unknown target deadline denies issuance. The access bearer must remain valid through issuance; its short JWT lifetime is not the renewal ceiling.

Store the normal two-field credential with optional enrollment metadata:
`technical_renewal: { expires_at, renewable_until }`. Do not put a browser bearer or refresh credential in the runtime.

`client.renew({expected_expires_at}, signal)` uses the same scoped credential and returns the closed object `{session_id, expires_at, renewable_until}`. The Host checks current membership, original role, original SID, App/version/grant, registration, binding, and original private target before renewal and every dispatch. The session ID, token, epochs and ceiling remain immutable. The technical expiry extends by at most the existing fifteen-minute lifetime and never beyond the original ceiling. Expired or revoked sessions cannot be resurrected. A reduced current authority deadline that precedes the existing expiry denies renewal and dispatch.

An older expected expiry is a lost-acknowledgment or restart reconciliation: after current authority checks, the Host returns its still-live expiry without another extension. A runtime restarting with stale enrollment metadata must block claims until one bounded reconciliation succeeds with the exact session and original ceiling. A denied or uncertain reconciliation leaves that channel dormant; unrelated reads can continue. No renewal can recover an authoritatively expired session. This finite path needs new human issuance after expiry or after its immutable ceiling ends; eligible until-revoked channels use service reacquisition instead.

Renew ahead of expiry while preserving the same client for active attempts. Stop new claims when there is insufficient lease time, abort renewal on shutdown, and never treat transport failure as permission to retry an effect. Renewal does not change a Run's retained authority, sequence, attempt deadline or idempotency key.
